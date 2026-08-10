import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { startAnchor, Clock, ProgramTestContext } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  AccountLayout,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import { Escrow } from "../target/types/escrow";
// CD-15 / §6.1: the IDL is imported DIRECTLY, never guarded by existsSync + it.skip. If the build
// artifact is missing this suite must EXPLODE, not silently vanish.
import idl from "../target/idl/escrow.json";

// Synthetic 6-decimal SPL mint (NOT Circle USDC devnet — cannot mint that in bankrun; SDD §10.3).
const DECIMALS = 6;
const ONE_TOKEN = 1_000_000n;
const DEPOSIT_AMOUNT = ONE_TOKEN;

// Fixture deadline: 2 hours, inside the enforced custody window (floor 1 h, ceiling 24 h).
// Deliberately NOT used by test 1b: that account is hand-built with the pre-upgrade bytes and must
// stay exactly as it was written, since it is the evidence that live accounts still deserialize.
const FIXTURE_TTL = 7_200n;

// Layout constants asserted by this suite (HU-SOL-20 §5.1 / §4).
const ESCROW_STATE_SIZE = 154; // 8 disc + 146 INIT_SPACE — the canary value (CD-7)
const ESCROW_INDEX_SIZE = 558; // 8 disc + 550 INIT_SPACE (32 + 1 + 1 + (4 + 16*32))
const MAX_ENTRIES = 32; // mirrors `pub const MAX_ENTRIES` in the program

// Story-specified regression guard for T11. This is NOT a decision about the operational value of
// SOLANA_SPONSOR_MAX_COMPUTE_UNITS in the facilitator — the exact measured CU is reported to the
// orchestrator and the env decision belongs to them.
const CU_REGRESSION_GUARD = 300_000;

// EscrowState discriminator read from the BUILT artifact, never a doc literal (CD-15).
const ESCROW_STATE_DISCRIMINATOR: number[] = (idl as any).accounts.find(
  (a: any) => a.name === "EscrowState"
).discriminator;

describe("escrow-index — enumerable per-sender escrow index (HU-SOL-20)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: Program<Escrow>;
  let payer: Keypair;

  let sender: Keypair;
  let authority: Keypair;
  let beneficiary: Keypair;
  let attacker: Keypair;

  let mint: PublicKey;
  let senderAta: PublicKey;
  let beneficiaryAta: PublicKey;
  let nowTs: bigint;

  // ---- low-level helpers (no RPC Connection in bankrun) --------------------

  async function processIxs(ixs: TransactionInstruction[], signers: Keypair[]) {
    const tx = new Transaction();
    const [bh] = await context.banksClient.getLatestBlockhash();
    tx.recentBlockhash = bh;
    tx.feePayer = signers[0].publicKey;
    tx.add(...ixs);
    tx.sign(...signers);
    return context.banksClient.processTransaction(tx);
  }

  async function fundSol(to: PublicKey, sol: number) {
    await processIxs(
      [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: to,
          lamports: sol * LAMPORTS_PER_SOL,
        }),
      ],
      [payer]
    );
  }

  async function createMint6(mintAuthority: PublicKey): Promise<PublicKey> {
    const mintKp = Keypair.generate();
    const rent = await provider.connection.getMinimumBalanceForRentExemption(
      MINT_SIZE
    );
    await processIxs(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mintKp.publicKey,
          lamports: rent,
          space: MINT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(
          mintKp.publicKey,
          DECIMALS,
          mintAuthority,
          null,
          TOKEN_PROGRAM_ID
        ),
      ],
      [payer, mintKp]
    );
    return mintKp.publicKey;
  }

  async function createAta(owner: PublicKey): Promise<PublicKey> {
    const ata = getAssociatedTokenAddressSync(mint, owner, true);
    await processIxs(
      [
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          ata,
          owner,
          mint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        ),
      ],
      [payer]
    );
    return ata;
  }

  async function mintTo(dest: PublicKey, amount: bigint) {
    await processIxs(
      [
        createMintToInstruction(
          mint,
          dest,
          payer.publicKey,
          amount,
          [],
          TOKEN_PROGRAM_ID
        ),
      ],
      [payer]
    );
  }

  async function tokenBalance(ata: PublicKey): Promise<bigint> {
    const acc = await context.banksClient.getAccount(ata);
    if (!acc) return -1n; // account absent (e.g. closed)
    return AccountLayout.decode(Buffer.from(acc.data)).amount;
  }

  function escrowPda(rid: Uint8Array, owner: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), owner.toBuffer(), Buffer.from(rid)],
      program.programId
    );
  }

  function pdas(rid: Uint8Array) {
    const [escrowState] = escrowPda(rid, sender.publicKey);
    const vault = getAssociatedTokenAddressSync(mint, escrowState, true);
    return { escrowState, vault };
  }

  // AC-3: the index PDA is derivable knowing ONLY the sender's own address — no remittanceId.
  function indexPda(owner: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow-index"), owner.toBuffer()],
      program.programId
    );
    return pda;
  }

  function rid(seed: number): Uint8Array {
    const b = new Uint8Array(16);
    b[0] = seed;
    return b;
  }

  function statusKey(status: any): string {
    return Object.keys(status)[0];
  }

  // `signer` defaults to `sender`, so every pre-existing call site keeps the exact same accounts:
  // ataOf(sender) is the same address createAta() built for senderAta. Test 15 needs an escrow
  // owned by the ATTACKER (an attacker closing someone else's escrow is stopped by the escrow
  // seeds, which is a different guard from the one AC-4 is about).
  function ataOf(owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(mint, owner, true);
  }

  async function deposit(
    remittanceId: Uint8Array,
    amount: bigint,
    deadline: bigint,
    signer: Keypair = sender
  ) {
    const [escrowState] = escrowPda(remittanceId, signer.publicKey);
    const vault = ataOf(escrowState);
    await program.methods
      .deposit(
        Array.from(remittanceId),
        beneficiary.publicKey,
        authority.publicKey,
        new anchor.BN(amount.toString()),
        new anchor.BN(deadline.toString())
      )
      .accountsPartial({
        sender: signer.publicKey,
        mint,
        escrowState,
        vault,
        senderAta: ataOf(signer.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([signer])
      .rpc();
    return { escrowState, vault };
  }

  function registerIx(
    remittanceId: Uint8Array,
    escrowState: PublicKey,
    signer: Keypair,
    escrowIndexOverride?: PublicKey
  ): Promise<TransactionInstruction> {
    return program.methods
      .registerEscrow(Array.from(remittanceId))
      .accountsPartial({
        sender: signer.publicKey,
        escrowState,
        escrowIndex: escrowIndexOverride ?? indexPda(signer.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  function register(
    remittanceId: Uint8Array,
    escrowState: PublicKey,
    signer: Keypair = sender,
    escrowIndexOverride?: PublicKey
  ) {
    return program.methods
      .registerEscrow(Array.from(remittanceId))
      .accountsPartial({
        sender: signer.publicKey,
        escrowState,
        escrowIndex: escrowIndexOverride ?? indexPda(signer.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([signer])
      .rpc();
  }

  function deregister(
    remittanceId: Uint8Array,
    signer: Keypair = sender,
    escrowIndexOverride?: PublicKey
  ) {
    return program.methods
      .deregisterEscrow(Array.from(remittanceId))
      .accountsPartial({
        sender: signer.publicKey,
        escrowIndex: escrowIndexOverride ?? indexPda(signer.publicKey),
      })
      .signers([signer])
      .rpc();
  }

  function refund(remittanceId: Uint8Array, escrowState: PublicKey, vault: PublicKey) {
    return program.methods
      .refund(Array.from(remittanceId))
      .accountsPartial({
        sender: sender.publicKey,
        mint,
        escrowState,
        vault,
        senderAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([sender])
      .rpc();
  }

  function release(
    remittanceId: Uint8Array,
    escrowState: PublicKey,
    vault: PublicKey,
    escrowOwner: Keypair = sender
  ) {
    return program.methods
      .release(Array.from(remittanceId))
      .accountsPartial({
        authority: authority.publicKey,
        sender: escrowOwner.publicKey,
        beneficiary: beneficiary.publicKey,
        mint,
        escrowState,
        vault,
        beneficiaryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();
  }

  // CD-14: the key `escrowIndex` is ALWAYS present in the accounts object. Leaving it out does NOT
  // omit the account — the client derives ["escrow-index", sender] from the IDL seeds and sends it
  // anyway, and a `close` for a sender with no index then reverts with AccountNotInitialized
  // (3012). Test 13b keeps that footgun executable instead of only written down.
  function close(
    remittanceId: Uint8Array,
    escrowState: PublicKey,
    vault: PublicKey,
    escrowIndex: PublicKey | null = null,
    signer: Keypair = sender
  ) {
    return program.methods
      .close(Array.from(remittanceId))
      .accountsPartial({
        sender: signer.publicKey,
        mint,
        escrowState,
        vault,
        senderAta: ataOf(signer.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        escrowIndex,
      })
      .signers([signer])
      .rpc();
  }

  // CD-12: bankrun dedups txs by signature. Any retry of an identical-shape tx must advance the
  // slot (fresh blockhash) or it "passes" without ever executing.
  async function bumpSlot() {
    const c = await context.banksClient.getClock();
    context.warpToSlot(c.slot + 1n);
  }

  function warpTo(unixTs: bigint) {
    return context.banksClient.getClock().then((c) => {
      context.setClock(
        new Clock(
          c.slot,
          c.epochStartTimestamp,
          c.epoch,
          c.leaderScheduleEpoch,
          unixTs
        )
      );
    });
  }

  // §6.1: asserting "it throws" is not enough — every revert test pins the exact Anchor code.
  async function expectRevert(p: Promise<any>, code: string) {
    let threw = false;
    try {
      await p;
    } catch (e: any) {
      threw = true;
      if (e instanceof anchor.AnchorError) {
        expect(e.error.errorCode.code).to.equal(code);
      } else {
        const blob =
          (e.logs ? e.logs.join("\n") : "") +
          " " +
          (e.transactionMessage || "") +
          " " +
          (e.message || "");
        expect(blob, `error did not contain "${code}": ${blob}`).to.include(
          code
        );
      }
    }
    expect(threw, `expected tx to revert with ${code}`).to.equal(true);
  }

  function idsOf(entries: any[]): string[] {
    return entries.map((e: any) => Buffer.from(e).toString("hex"));
  }

  function hex(rid: Uint8Array): string {
    return Buffer.from(rid).toString("hex");
  }

  // ---- setup ---------------------------------------------------------------

  beforeEach(async () => {
    context = await startAnchor(".", [], []);
    provider = new BankrunProvider(context);
    program = new Program<Escrow>(idl as Escrow, provider);
    payer = context.payer;

    sender = Keypair.generate();
    authority = Keypair.generate();
    beneficiary = Keypair.generate();
    attacker = Keypair.generate();

    await fundSol(sender.publicKey, 100); // rent for escrow_state + vault + escrow_index
    await fundSol(attacker.publicKey, 10); // attacker must be able to PAY, so failures are guards

    mint = await createMint6(payer.publicKey);
    senderAta = await createAta(sender.publicKey);
    beneficiaryAta = await createAta(beneficiary.publicKey);
    await mintTo(senderAta, 1_000n * ONE_TOKEN);

    nowTs = (await context.banksClient.getClock()).unixTimestamp;
  });

  // ---- T1b: synthetic LEGACY account stays fully operable (AC-6, empirical) --

  it("1b. a hand-built 154-byte legacy escrow_state is still refundable by the new program (AC-6)", async () => {
    const id = rid(60);
    const deadline = nowTs + 1000n;
    const [escrowState, bump] = escrowPda(id, sender.publicKey);

    // Bytes assembled BY HAND in the pre-upgrade layout — not written by the current program.
    // This is what proves the new program can still read accounts already live on devnet.
    const buf = Buffer.alloc(ESCROW_STATE_SIZE);
    let o = 0;
    Buffer.from(ESCROW_STATE_DISCRIMINATOR).copy(buf, o);
    o += 8;
    sender.publicKey.toBuffer().copy(buf, o);
    o += 32;
    beneficiary.publicKey.toBuffer().copy(buf, o);
    o += 32;
    authority.publicKey.toBuffer().copy(buf, o);
    o += 32;
    mint.toBuffer().copy(buf, o);
    o += 32;
    buf.writeBigUInt64LE(DEPOSIT_AMOUNT, o);
    o += 8;
    buf.writeBigInt64LE(deadline, o);
    o += 8;
    buf.writeUInt8(0, o); // status = Deposited
    o += 1;
    buf.writeUInt8(bump, o);
    o += 1;
    assert.equal(o, ESCROW_STATE_SIZE, "legacy layout must fill exactly 154 bytes");

    context.setAccount(escrowState, {
      lamports: await provider.connection.getMinimumBalanceForRentExemption(
        ESCROW_STATE_SIZE
      ),
      data: new Uint8Array(buf),
      owner: program.programId,
      executable: false,
      rentEpoch: 0,
    });

    // Fund its vault so there is something real to refund.
    const vault = await createAta(escrowState);
    await mintTo(vault, DEPOSIT_AMOUNT);

    const before = await tokenBalance(senderAta);
    await warpTo(deadline + 1n);
    await refund(id, escrowState, vault);

    expect(await tokenBalance(senderAta)).to.equal(before + DEPOSIT_AMOUNT);
    expect(await tokenBalance(vault)).to.equal(0n);
    const state = await program.account.escrowState.fetch(escrowState);
    expect(statusKey(state.status)).to.equal("refunded");
  });

  // ---- T2: register writes an index derivable from the sender alone (AC-3) ---

  it("2. deposit + register_escrow creates the index PDA with the right header and entries (AC-3)", async () => {
    const idA = rid(20);
    const deadline = nowTs + FIXTURE_TTL;
    const a = await deposit(idA, DEPOSIT_AMOUNT, deadline);
    await register(idA, a.escrowState);

    const pda = indexPda(sender.publicKey);
    const raw = await context.banksClient.getAccount(pda);
    assert.isNotNull(raw, "escrow_index PDA must exist after register_escrow");
    expect(raw!.data.length).to.equal(ESCROW_INDEX_SIZE);

    let idx = await program.account.escrowIndex.fetch(pda);
    expect(idx.sender.toBase58()).to.equal(sender.publicKey.toBase58());
    expect(idx.version).to.equal(1);
    expect(idx.entries.length).to.equal(1);
    expect(idsOf(idx.entries)).to.deep.equal([hex(idA)]);

    // bump stored must be the canonical bump of ["escrow-index", sender]
    const [, canonicalBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow-index"), sender.publicKey.toBuffer()],
      program.programId
    );
    expect(idx.bump).to.equal(canonicalBump);

    // a second escrow appends without touching the first (init_if_needed takes the "needed" branch)
    const idB = rid(21);
    const b = await deposit(idB, DEPOSIT_AMOUNT, deadline);
    await register(idB, b.escrowState);

    idx = await program.account.escrowIndex.fetch(pda);
    expect(idx.entries.length).to.equal(2);
    expect(idsOf(idx.entries)).to.deep.equal([hex(idA), hex(idB)]);
    expect(idx.version).to.equal(1);
    expect(idx.sender.toBase58()).to.equal(sender.publicKey.toBase58());
  });

  // ---- T3: end-to-end recovery with the remittanceId genuinely LOST (AC-4) --

  it("3. the sender recovers a forgotten escrow from the index alone and refunds it (AC-4)", async () => {
    const deadline = nowTs + FIXTURE_TTL;

    // The id16 lives ONLY inside this block. After it closes the identifier is unreachable from
    // the rest of the test — that is the whole point (§6.1): nothing below may use it.
    let expectedEscrowState: PublicKey;
    let expectedVault: PublicKey;
    {
      const secretId = rid(30);
      const r = await deposit(secretId, DEPOSIT_AMOUNT, deadline);
      await register(secretId, r.escrowState);
      expectedEscrowState = r.escrowState;
      expectedVault = r.vault;
    }

    // ---- from here on, the ONLY thing known is the sender's own address ----
    const pda = indexPda(sender.publicKey);
    const idx = await program.account.escrowIndex.fetch(pda);
    expect(idx.entries.length).to.equal(1);

    const recovered = Uint8Array.from(idx.entries[0] as number[]);
    const [recoveredState] = escrowPda(recovered, sender.publicKey);
    const recoveredVault = getAssociatedTokenAddressSync(mint, recoveredState, true);

    // the address rebuilt from the chain is the real escrow
    expect(recoveredState.toBase58()).to.equal(expectedEscrowState.toBase58());
    expect(recoveredVault.toBase58()).to.equal(expectedVault.toBase58());

    const before = await tokenBalance(senderAta);
    expect(await tokenBalance(recoveredVault)).to.equal(DEPOSIT_AMOUNT);

    await warpTo(deadline + 1n);
    await refund(recovered, recoveredState, recoveredVault);

    expect(await tokenBalance(senderAta)).to.equal(before + DEPOSIT_AMOUNT);
    expect(await tokenBalance(recoveredVault)).to.equal(0n);
    const state = await program.account.escrowState.fetch(recoveredState);
    expect(statusKey(state.status)).to.equal("refunded");
  });

  // ---- T4a: no recovery path grants the authority any power (AC-5 / CD-1) ---

  it("4a. IDL: exactly 6 instructions, and neither new instruction takes an `authority` account (AC-5/CD-1)", () => {
    // This list is the whole point of the test: an instruction that nobody reviewed shows up here
    // as a red diff. The custody window added guards, not instructions, so the count did not move.
    const names = (idl as any).instructions
      .map((i: any) => i.name)
      .sort();
    expect(names).to.deep.equal([
      "close",
      "deposit",
      "deregister_escrow",
      "refund",
      "register_escrow",
      "release",
    ]);

    for (const name of ["register_escrow", "deregister_escrow"]) {
      const ix = (idl as any).instructions.find((i: any) => i.name === name);
      assert.isDefined(ix, `${name} must exist in the built IDL`);
      const accounts = ix.accounts.map((a: any) => a.name);
      expect(
        accounts,
        `${name} must not reference an authority account (AC-5)`
      ).to.not.include("authority");
    }
  });

  it("4b. an attacker cannot register the victim's escrow into any index (AC-5)", async () => {
    const id = rid(40);
    const victim = await deposit(id, DEPOSIT_AMOUNT, nowTs + FIXTURE_TTL);

    // attacker signs as `sender` but passes the victim's escrow_state: the seeds are derived from
    // the SIGNER, so they cannot possibly match the victim's PDA.
    await expectRevert(
      register(id, victim.escrowState, attacker),
      "ConstraintSeeds"
    );
  });

  it("4c. an attacker cannot deregister entries from the victim's index (AC-5)", async () => {
    const id = rid(41);
    const v = await deposit(id, DEPOSIT_AMOUNT, nowTs + FIXTURE_TTL);
    await register(id, v.escrowState);

    const victimIndex = indexPda(sender.publicKey);
    await expectRevert(
      deregister(id, attacker, victimIndex),
      "ConstraintSeeds"
    );

    // victim's index is untouched
    const idx = await program.account.escrowIndex.fetch(victimIndex);
    expect(idsOf(idx.entries)).to.deep.equal([hex(id)]);
  });

  // ---- T5: the cap is a clean dead-end, not a serialization crash (DT-5) ----

  it("5. registering MAX_ENTRIES escrows works and the next one reverts with EscrowIndexFull", async () => {
    const deadline = nowTs + FIXTURE_TTL;
    const pda = indexPda(sender.publicKey);

    for (let i = 0; i < MAX_ENTRIES; i++) {
      const id = rid(100 + i);
      const r = await deposit(id, DEPOSIT_AMOUNT, deadline);
      await register(id, r.escrowState);
    }

    let idx = await program.account.escrowIndex.fetch(pda);
    expect(idx.entries.length).to.equal(MAX_ENTRIES);

    // the 33rd deposit succeeds (deposit is untouched) but the register must be rejected by the
    // explicit guard — NOT by a borsh overflow (that would surface as AccountDidNotSerialize).
    const overflowId = rid(100 + MAX_ENTRIES);
    const extra = await deposit(overflowId, DEPOSIT_AMOUNT, deadline);
    await expectRevert(
      register(overflowId, extra.escrowState),
      "EscrowIndexFull"
    );

    idx = await program.account.escrowIndex.fetch(pda);
    expect(idx.entries.length).to.equal(MAX_ENTRIES);
    expect(idsOf(idx.entries)).to.not.include(hex(overflowId));
  });

  // ---- T6: idempotence — a retry neither duplicates nor reverts (CD-9) -----

  it("6. registering the same id twice does not duplicate and does not revert (idempotent)", async () => {
    const id = rid(50);
    const r = await deposit(id, DEPOSIT_AMOUNT, nowTs + FIXTURE_TTL);
    await register(id, r.escrowState);

    // CD-12: without a fresh blockhash bankrun would dedup this identical tx by signature and the
    // test would "pass" without the program ever running the second time.
    await bumpSlot();
    await register(id, r.escrowState);

    const idx = await program.account.escrowIndex.fetch(indexPda(sender.publicKey));
    expect(idx.entries.length).to.equal(1);
    expect(idsOf(idx.entries)).to.deep.equal([hex(id)]);
    expect(idx.version).to.equal(1);
    expect(idx.sender.toBase58()).to.equal(sender.publicKey.toBase58());
  });

  // ---- T7: deregister removes the right entry and moves zero tokens (DT-7) --

  it("7. deregister_escrow removes only the target entry, moves no tokens, and is a no-op if absent", async () => {
    const idA = rid(70);
    const idB = rid(71);
    const deadline = nowTs + FIXTURE_TTL;
    const a = await deposit(idA, DEPOSIT_AMOUNT, deadline);
    const b = await deposit(idB, DEPOSIT_AMOUNT, deadline);
    await register(idA, a.escrowState);
    await register(idB, b.escrowState);

    const pda = indexPda(sender.publicKey);
    expect(idsOf((await program.account.escrowIndex.fetch(pda)).entries)).to.deep.equal([
      hex(idA),
      hex(idB),
    ]);

    const vaultABefore = await tokenBalance(a.vault);
    const vaultBBefore = await tokenBalance(b.vault);
    const senderBefore = await tokenBalance(senderAta);
    const beneficiaryBefore = await tokenBalance(beneficiaryAta);

    await deregister(idA);

    let idx = await program.account.escrowIndex.fetch(pda);
    expect(idsOf(idx.entries)).to.deep.equal([hex(idB)]);

    // not a single token moved
    expect(await tokenBalance(a.vault)).to.equal(vaultABefore);
    expect(await tokenBalance(b.vault)).to.equal(vaultBBefore);
    expect(await tokenBalance(senderAta)).to.equal(senderBefore);
    expect(await tokenBalance(beneficiaryAta)).to.equal(beneficiaryBefore);

    // deregistering an id that is not in the index is a silent no-op, not a revert
    await deregister(rid(79));
    idx = await program.account.escrowIndex.fetch(pda);
    expect(idsOf(idx.entries)).to.deep.equal([hex(idB)]);

    // and the escrow itself is still perfectly refundable (the breadcrumb is not the escrow)
    await warpTo(deadline + 1n);
    await refund(idA, a.escrowState, a.vault);
    expect(await tokenBalance(a.vault)).to.equal(0n);
  });

  // ---- T8: error flows -----------------------------------------------------

  it("8a. register_escrow on a never-deposited escrow reverts (AccountNotInitialized)", async () => {
    const ghost = rid(80);
    const [ghostState] = escrowPda(ghost, sender.publicKey);
    // correctly derived PDA, but no deposit ever created it
    expect(await context.banksClient.getAccount(ghostState)).to.equal(null);

    await expectRevert(register(ghost, ghostState), "AccountNotInitialized");
  });

  it("8b. register_escrow on an already Released escrow reverts (EscrowNotDeposited)", async () => {
    const id = rid(81);
    const r = await deposit(id, DEPOSIT_AMOUNT, nowTs + FIXTURE_TTL);
    await release(id, r.escrowState, r.vault);

    await expectRevert(register(id, r.escrowState), "EscrowNotDeposited");

    // no index was created as a side effect
    expect(await context.banksClient.getAccount(indexPda(sender.publicKey))).to.equal(
      null
    );
  });

  // ---- T10: rent measured, not assumed ------------------------------------

  it("10. rent-exemption cost of the index is measured against the SDD estimate", async () => {
    const rentIndex = await provider.connection.getMinimumBalanceForRentExemption(
      ESCROW_INDEX_SIZE
    );
    const rentState = await provider.connection.getMinimumBalanceForRentExemption(
      ESCROW_STATE_SIZE
    );
    console.log(
      `[T10] rent(${ESCROW_INDEX_SIZE} bytes EscrowIndex) = ${rentIndex} lamports (${
        rentIndex / LAMPORTS_PER_SOL
      } SOL)`
    );
    console.log(
      `[T10] rent(${ESCROW_STATE_SIZE} bytes EscrowState)  = ${rentState} lamports (${
        rentState / LAMPORTS_PER_SOL
      } SOL)`
    );

    // SDD §: (128 + 558) * 6960 = 4_775_760 lamports
    expect(rentIndex).to.equal((128 + ESCROW_INDEX_SIZE) * 6960);
    expect(rentState).to.equal((128 + ESCROW_STATE_SIZE) * 6960);

    // and the account actually allocated on chain is exactly that size
    const id = rid(90);
    const r = await deposit(id, DEPOSIT_AMOUNT, nowTs + FIXTURE_TTL);
    await register(id, r.escrowState);
    const raw = await context.banksClient.getAccount(indexPda(sender.publicKey));
    expect(raw!.data.length).to.equal(ESCROW_INDEX_SIZE);
    expect(raw!.lamports).to.equal(rentIndex);
  });

  // ---- T11: compute units of the atomic deposit+register tx (input to R3) ---
  //
  // NOTE: this number is NOT a constant. Measured over 28 runs it ranged 52_826..79_826 CU, always
  // in steps of 1_500. Cause: `beforeEach` generates random keypairs, so the canonical bump of
  // escrow_state / vault / escrow_index changes on every run, and the on-chain bump search
  // (find_program_address) burns ~1_500 CU per extra sha256 iteration. Any compute budget for the
  // atomic deposit+register tx must therefore be sized against the WORST case plus headroom, never
  // against a single observed sample.
  it("11. deposit + register_escrow in ONE atomic tx: report computeUnitsConsumed", async () => {
    const id = rid(91);
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = pdas(id);

    const depositIx = await program.methods
      .deposit(
        Array.from(id),
        beneficiary.publicKey,
        authority.publicKey,
        new anchor.BN(DEPOSIT_AMOUNT.toString()),
        new anchor.BN(deadline.toString())
      )
      .accountsPartial({
        sender: sender.publicKey,
        mint,
        escrowState,
        vault,
        senderAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const regIx = await registerIx(id, escrowState, sender);

    const meta = await processIxs([depositIx, regIx], [sender]);
    const cu = Number(meta.computeUnitsConsumed);
    console.log(
      `[T11] computeUnitsConsumed(deposit + register_escrow, 1 tx) = ${cu}`
    );

    // the atomic tx really did both things
    expect(await tokenBalance(vault)).to.equal(DEPOSIT_AMOUNT);
    const idx = await program.account.escrowIndex.fetch(indexPda(sender.publicKey));
    expect(idsOf(idx.entries)).to.deep.equal([hex(id)]);

    expect(cu).to.be.greaterThan(0);
    expect(cu).to.be.lessThan(CU_REGRESSION_GUARD);
  });

  // ---- T12: close removes exactly its own entry (WKH-326 / AC-1) -----------

  it("12. close removes exactly the entry of the escrow it closes and leaves the rest in order (AC-1)", async () => {
    const idA = rid(120);
    const idB = rid(121);
    const deadline = nowTs + FIXTURE_TTL;
    const a = await deposit(idA, DEPOSIT_AMOUNT, deadline);
    const b = await deposit(idB, DEPOSIT_AMOUNT, deadline);
    await register(idA, a.escrowState);
    await register(idB, b.escrowState);

    const pda = indexPda(sender.publicKey);
    expect(
      idsOf((await program.account.escrowIndex.fetch(pda)).entries)
    ).to.deep.equal([hex(idA), hex(idB)]);

    await release(idA, a.escrowState, a.vault);
    await close(idA, a.escrowState, a.vault, pda);

    // Exactly [B]: [A,B] means the retain never ran, [] means it wiped the index, [B,A] means it
    // reordered. Each of the three is a distinct bug and each shows up as a different diff here.
    const idx = await program.account.escrowIndex.fetch(pda);
    expect(idsOf(idx.entries)).to.deep.equal([hex(idB)]);
  });

  // ---- T13: the sender who never registered anything (WKH-326 / AC-2) ------
  //
  // This is the path that runs in production today: the only consumer that builds transactions for
  // this program builds `deposit`, never `register_escrow`. If this test goes red, the change broke
  // what already works.

  it("13. close with escrowIndex=null confirms and does NOT create the index account (AC-2)", async () => {
    const id = rid(130);
    const r = await deposit(id, DEPOSIT_AMOUNT, nowTs + FIXTURE_TTL);
    await release(id, r.escrowState, r.vault);

    const pda = indexPda(sender.publicKey);
    expect(
      await context.banksClient.getAccount(pda),
      "precondition: register_escrow was never called"
    ).to.equal(null);

    await close(id, r.escrowState, r.vault, null);

    // Two assertions, and the second is not decoration: an `init_if_needed` on this account would
    // make the tx confirm all the same while charging the sender 4_774_560 lamports of rent for an
    // empty index whose rent no instruction gives back.
    expect(await context.banksClient.getAccount(r.escrowState)).to.equal(null);
    expect(
      await context.banksClient.getAccount(pda),
      "close must not create the index PDA"
    ).to.equal(null);
  });

  it("13b. leaving the escrowIndex key out does NOT omit the account: the client sends the PDA (CD-14)", async () => {
    const id = rid(131);
    const r = await deposit(id, DEPOSIT_AMOUNT, nowTs + FIXTURE_TTL);
    await release(id, r.escrowState, r.vault);

    // Same accounts object as the helper, minus the `escrowIndex` key.
    const builder = () =>
      program.methods
        .close(Array.from(id))
        .accountsPartial({
          sender: sender.publicKey,
          mint,
          escrowState: r.escrowState,
          vault: r.vault,
          senderAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sender]);

    const ix = await builder().instruction();
    // keys[6] is the position of escrow_index (CD-15 puts it last). If this ever equals the
    // programId, the client DID omit the account and CD-14 would be unnecessary — that is a finding,
    // not a green test.
    expect(ix.keys.length).to.equal(7);
    expect(ix.keys[6].pubkey.toBase58()).to.equal(
      indexPda(sender.publicKey).toBase58()
    );
    expect(ix.keys[6].pubkey.toBase58()).to.not.equal(
      program.programId.toBase58()
    );

    // and the account it silently sent does not exist, so the tx dies with an error that never
    // says the word "optional"
    await expectRevert(builder().rpc(), "AccountNotInitialized");
  });

  // The SECOND footgun of the optional account, the one lib.rs:714-717 describes: passing
  // `escrowIndex: null` when the index DOES exist and DOES hold the id is not an error, it just
  // leaves the entry dangling. 13 and 13b only cover senders that never registered anything, so
  // without this test that warning would be written down and never executed — the same gap the
  // comment above `close()` says 13b exists to avoid.
  it("13c. close with escrowIndex=null when the index HOLDS the id confirms and leaves the entry dangling", async () => {
    const id = rid(132);
    const r = await deposit(id, DEPOSIT_AMOUNT, nowTs + FIXTURE_TTL);
    await register(id, r.escrowState);

    const pda = indexPda(sender.publicKey);
    expect(
      idsOf((await program.account.escrowIndex.fetch(pda)).entries),
      "precondition: the index exists and holds this id"
    ).to.deep.equal([hex(id)]);

    await release(id, r.escrowState, r.vault);
    await close(id, r.escrowState, r.vault, null); // omitted ON PURPOSE

    // The tx confirms and the escrow is gone, but its entry outlives it: it keeps occupying one of
    // the 32 slots until somebody calls deregister_escrow with this id. For this id the monotonic
    // cap is back. This is the documented behaviour, not a bug being asserted into place — the fix
    // is client side (getAccountInfo on the PDA before building the tx), and it is why the rule in
    // lib.rs exists.
    expect(await context.banksClient.getAccount(r.escrowState)).to.equal(null);
    expect(
      idsOf((await program.account.escrowIndex.fetch(pda)).entries),
      "the entry survives the escrow it pointed at"
    ).to.deep.equal([hex(id)]);
  });

  // ---- T14: the cap stops being a lifetime cap (WKH-326 / AC-3) ------------

  it("14. 33 deposit→register→release→close cycles with the SAME sender all succeed (AC-3)", async () => {
    const pda = indexPda(sender.publicKey);
    const deadline = nowTs + FIXTURE_TTL;
    const CYCLES = MAX_ENTRIES + 1; // 33: one past the cap
    // Entry count measured at the END OF EACH cycle. It is recorded and asserted AFTER the loop on
    // purpose: asserting inside would abort at cycle 2 against the un-fixed binary (cycle 1 leaves
    // [A] and passes any `<= 1`; cycle 2 leaves [A,B] and fails) and hide the EscrowIndexFull of the
    // 33rd register_escrow, which is the failure W0 exists to record (CD-10).
    const perCycleLen: number[] = [];
    let registersConfirmed = 0;

    for (let i = 0; i < CYCLES; i++) {
      const id = rid(150 + i); // 150..182 — rid() only writes b[0], so the seed must be unique
      const { escrowState, vault } = await deposit(id, DEPOSIT_AMOUNT, deadline);
      await register(id, escrowState); // i = 32 is the one that reverts before this HU
      registersConfirmed++;
      await release(id, escrowState, vault);
      await close(id, escrowState, vault, pda); // the index exists: register ran in this same cycle
      perCycleLen.push(
        (await program.account.escrowIndex.fetch(pda)).entries.length
      );
    }

    expect(registersConfirmed, "the 33rd register_escrow must confirm").to.equal(
      CYCLES
    );
    // `equal(0)`, not `at.most(1)`. Against the fixed binary every cycle ends with an EMPTY index:
    // the close of cycle i removes the entry that the register of cycle i added. The one unit of
    // slack that `<= 1` allows is not free — under M16 (the `retain` flipped to `==`, which keeps
    // the id just closed and drops the open ones) the series is stable at 1, so `at.most(1)` lets
    // that mutant through and `equal(0)` kills it. Both revisers measured this.
    expect(
      Math.max(...perCycleLen),
      `entries per cycle: ${perCycleLen.join(",")}`
    ).to.equal(0);
  });

  // ---- T15: the index of somebody else (WKH-326 / AC-4) --------------------

  it("15. close with the VICTIM's index reverts ConstraintSeeds and leaves that index untouched (AC-4)", async () => {
    const deadline = nowTs + FIXTURE_TTL;

    // victim: registers an entry it expects to keep
    const victimId = rid(140);
    const v = await deposit(victimId, DEPOSIT_AMOUNT, deadline);
    await register(victimId, v.escrowState);
    const victimIndex = indexPda(sender.publicKey);
    expect(
      idsOf((await program.account.escrowIndex.fetch(victimIndex)).entries)
    ).to.deep.equal([hex(victimId)]);

    // attacker: an escrow of its OWN, terminal, so the only thing left to reject is the index
    const attackerAta = await createAta(attacker.publicKey);
    await mintTo(attackerAta, 10n * ONE_TOKEN);
    const attackerId = rid(141);
    const a = await deposit(attackerId, DEPOSIT_AMOUNT, deadline, attacker);
    await release(attackerId, a.escrowState, a.vault, attacker);

    // the attacker is funded in beforeEach on purpose: a failure here is a guard, not missing rent
    await expectRevert(
      close(attackerId, a.escrowState, a.vault, victimIndex, attacker),
      "ConstraintSeeds"
    );

    // entry by entry, the victim's index is exactly what it was
    expect(
      idsOf((await program.account.escrowIndex.fetch(victimIndex)).entries)
    ).to.deep.equal([hex(victimId)]);
  });

  // ---- T16: the index write moves no tokens (WKH-326 / AC-5 bis) -----------

  it("16. close with the index moves exactly the same tokens as before the change (AC-5)", async () => {
    const idA = rid(142);
    const idB = rid(143);
    const deadline = nowTs + FIXTURE_TTL;
    const a = await deposit(idA, DEPOSIT_AMOUNT, deadline);
    const b = await deposit(idB, DEPOSIT_AMOUNT, deadline);
    await register(idA, a.escrowState);
    await register(idB, b.escrowState);
    await release(idA, a.escrowState, a.vault);

    // measured right before the close, so the deltas below belong to the close and to nothing else
    const vaultABefore = await tokenBalance(a.vault);
    const vaultBBefore = await tokenBalance(b.vault);
    const senderBefore = await tokenBalance(senderAta);
    const beneficiaryBefore = await tokenBalance(beneficiaryAta);
    expect(vaultABefore, "release already emptied vault A").to.equal(0n);

    await close(idA, a.escrowState, a.vault, indexPda(sender.publicKey));

    expect(await tokenBalance(a.vault)).to.equal(-1n); // vault closed, not merely emptied
    expect(await tokenBalance(b.vault)).to.equal(vaultBBefore);
    expect(await tokenBalance(senderAta)).to.equal(senderBefore); // nothing to sweep here
    expect(await tokenBalance(beneficiaryAta)).to.equal(beneficiaryBefore);
    // The case with a NON-empty vault at close time (the sweep) is covered by D1 and D1b in
    // tests/escrow-window.ts, which run the same instruction with dust donated to the vault.
  });

  // ---- T17: order of the constraints (WKH-326 / AC-6) ---------------------

  it("17. close on a Deposited escrow reverts EscrowNotTerminal and removes no entry (AC-6)", async () => {
    const id = rid(144);
    const r = await deposit(id, DEPOSIT_AMOUNT, nowTs + FIXTURE_TTL);
    await register(id, r.escrowState);
    const pda = indexPda(sender.publicKey);

    await expectRevert(
      close(id, r.escrowState, r.vault, pda),
      "EscrowNotTerminal"
    );

    // A reverted tx writes nothing, so this second assertion is not about atomicity: it is what
    // goes red if somebody ever moves the retain to a place that runs before the constraint.
    expect(
      idsOf((await program.account.escrowIndex.fetch(pda)).entries)
    ).to.deep.equal([hex(id)]);
  });

  // ---- T18: an id that is not in the index (WKH-326 / AC-7) ---------------

  it("18. close with an index that does not contain the id confirms and leaves entries alone (AC-7)", async () => {
    const idA = rid(145);
    const idB = rid(146);
    const deadline = nowTs + FIXTURE_TTL;
    const a = await deposit(idA, DEPOSIT_AMOUNT, deadline);
    const b = await deposit(idB, DEPOSIT_AMOUNT, deadline);
    await register(idB, b.escrowState); // only B is in the index
    await release(idA, a.escrowState, a.vault);

    const pda = indexPda(sender.publicKey);
    await close(idA, a.escrowState, a.vault, pda); // must NOT revert

    expect(
      idsOf((await program.account.escrowIndex.fetch(pda)).entries)
    ).to.deep.equal([hex(idB)]);
    expect(await context.banksClient.getAccount(a.escrowState)).to.equal(null);
  });

  // ---- T19/T20: the interface, pinned against the BUILT artifact ----------
  //
  // The five instructions below are pinned to the values read on 2026-08-05 from the IDL VENDORED
  // in chaski-v3 (src/infrastructure/solana/escrow-idl.ts), i.e. the pre-WKH-326 artifact, not from
  // the build this branch produces. Copying them out of our own new build would only prove the file
  // equals itself.

  it("19. the built IDL declares 6 instructions, the 6 usual discriminators, and escrow_index last in close (AC-8)", () => {
    const ixs = (idl as any).instructions;
    expect(ixs.map((i: any) => i.name).sort()).to.deep.equal([
      "close",
      "deposit",
      "deregister_escrow",
      "refund",
      "register_escrow",
      "release",
    ]);

    const disc: Record<string, number[]> = {
      close: [98, 165, 201, 177, 108, 65, 206, 96],
      deposit: [242, 35, 198, 137, 82, 225, 242, 182],
      deregister_escrow: [226, 232, 192, 96, 102, 196, 211, 162],
      refund: [2, 96, 183, 251, 63, 208, 46, 46],
      register_escrow: [200, 17, 194, 170, 224, 144, 127, 166],
      release: [253, 249, 15, 206, 28, 127, 193, 241],
    };
    for (const [name, d] of Object.entries(disc)) {
      const ix = ixs.find((i: any) => i.name === name);
      assert.isDefined(ix, `${name} must exist in the built IDL`);
      expect(ix.discriminator, `${name} discriminator moved`).to.deep.equal(d);
    }

    // CD-15: the new account goes LAST, so every position a client already builds keeps its index.
    const close = ixs.find((i: any) => i.name === "close");
    expect(close.accounts.map((a: any) => a.name)).to.deep.equal([
      "sender",
      "mint",
      "escrow_state",
      "vault",
      "sender_ata",
      "token_program",
      "escrow_index",
    ]);
    expect(close.accounts[6].optional, "escrow_index must be optional").to.equal(
      true
    );
    expect(close.args.map((a: any) => a.name)).to.deep.equal(["remittance_id"]);
  });

  it("20. the other five instructions keep their accounts, args and discriminator (AC-9)", () => {
    const expected: Record<string, string[]> = {
      // WKH-343 — `beneficiary_ata` entra AL FINAL, después de `system_program`. La posición no es
      // cosmética: cada índice que un cliente ya construye conserva su número, así que un binario
      // viejo que reciba esta cuenta la deja en `remaining_accounts` y la ignora. Es la misma regla
      // que aplicó CD-15 para `escrow_index` en `close` (test 19, arriba).
      //
      // Esta lista sigue siendo un `deep.equal`, o sea que pinnea ORDEN y CANTIDAD, no pertenencia.
      // Lo que la vuelve roja, y es a propósito: mover `beneficiary_ata` de la última posición,
      // agregar una cuenta, o sacarla. Es el alambre que hace que un reordenamiento no pase
      // desapercibido, porque del otro lado hay consumidores que pinnean `deposit` POR POSICIÓN
      // (chaski-v3 contracts/idl/escrow-idl.hash.test.ts) y una tx mal armada se rechaza en
      // producción sin que el depósito se broadcastee.
      deposit: [
        "sender",
        "mint",
        "escrow_state",
        "vault",
        "sender_ata",
        "token_program",
        "associated_token_program",
        "system_program",
        "beneficiary_ata",
      ],
      release: [
        "authority",
        "sender",
        "beneficiary",
        "mint",
        "escrow_state",
        "vault",
        "beneficiary_ata",
        "token_program",
        "associated_token_program",
      ],
      refund: [
        "sender",
        "mint",
        "escrow_state",
        "vault",
        "sender_ata",
        "token_program",
        "associated_token_program",
      ],
      register_escrow: [
        "sender",
        "escrow_state",
        "escrow_index",
        "system_program",
      ],
      deregister_escrow: ["sender", "escrow_index"],
    };
    const expectedArgs: Record<string, string[]> = {
      deposit: [
        "remittance_id",
        "beneficiary",
        "authority",
        "amount",
        "deadline",
      ],
      release: ["remittance_id"],
      refund: ["remittance_id"],
      register_escrow: ["remittance_id"],
      deregister_escrow: ["remittance_id"],
    };

    for (const [name, accounts] of Object.entries(expected)) {
      const ix = (idl as any).instructions.find((i: any) => i.name === name);
      assert.isDefined(ix, `${name} must exist in the built IDL`);
      expect(
        ix.accounts.map((a: any) => a.name),
        `${name} account list changed`
      ).to.deep.equal(accounts);
      expect(
        ix.accounts.filter((a: any) => a.optional).map((a: any) => a.name),
        `${name} must have no optional account`
      ).to.deep.equal([]);
      expect(
        ix.args.map((a: any) => a.name),
        `${name} args changed`
      ).to.deep.equal(expectedArgs[name]);
    }
  });

  // ---- T21: compute units of close, both shapes ---------------------------
  //
  // NOTE: same warning as T11 — these numbers are NOT constants. `beforeEach` generates random
  // keypairs, so the canonical bump of escrow_state / vault / escrow_index changes every run, and
  // each extra sha256 iteration of the bump search costs ~1_500 CU. Size any compute budget against
  // a worst case with headroom, never against one sample printed here.
  it("21. close with and without the index: report computeUnitsConsumed", async () => {
    const deadline = nowTs + FIXTURE_TTL;
    const pda = indexPda(sender.publicKey);

    // A: registered, so the index exists and the close has an entry to remove
    const idA = rid(147);
    const a = await deposit(idA, DEPOSIT_AMOUNT, deadline);
    await register(idA, a.escrowState);
    await release(idA, a.escrowState, a.vault);

    // B: never registered; its close passes escrowIndex = null
    const idB = rid(148);
    const b = await deposit(idB, DEPOSIT_AMOUNT, deadline);
    await release(idB, b.escrowState, b.vault);

    function closeIx(
      id: Uint8Array,
      escrowState: PublicKey,
      vault: PublicKey,
      escrowIndex: PublicKey | null
    ) {
      return program.methods
        .close(Array.from(id))
        .accountsPartial({
          sender: sender.publicKey,
          mint,
          escrowState,
          vault,
          senderAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          escrowIndex,
        })
        .instruction();
    }

    const withIndex = await processIxs(
      [await closeIx(idA, a.escrowState, a.vault, pda)],
      [sender]
    );
    const withoutIndex = await processIxs(
      [await closeIx(idB, b.escrowState, b.vault, null)],
      [sender]
    );

    const cuWith = Number(withIndex.computeUnitsConsumed);
    const cuWithout = Number(withoutIndex.computeUnitsConsumed);
    console.log(`[T21] computeUnitsConsumed(close, with index)    = ${cuWith}`);
    console.log(`[T21] computeUnitsConsumed(close, escrowIndex=null) = ${cuWithout}`);
    // The third number is DOMINATED BY NOISE and CAN COME OUT NEGATIVE. It is not the cost of the
    // index. The two closes above are two DIFFERENT escrows, so the difference carries the delta
    // between their canonical bump searches, ~1_500 CU per extra sha256 iteration (same mechanism
    // as T11). Four samples against the same binary: -2047, +2453, +3953, +18953. In the first one
    // the close WITH the index came out CHEAPER than the one without, which is impossible as a cost
    // of writing. The four are all congruent to 953 modulo 1_500, which is what a marginal cost of
    // ~953 CU plus a whole number of bump iterations looks like — but no single sample shows that,
    // which is the whole point. Printed labelled rather than bare so nobody re-derives it from the
    // two numbers above and believes it.
    console.log(
      `[T21] difference (same run, DIFFERENT escrows — NOISE, samples -2047..+18953, all ≡ 953 ` +
        `mod 1_500, can be negative, NOT the cost of the index) = ${cuWith - cuWithout}`
    );

    // both closes really happened, and the one with the index really removed the entry
    expect(await context.banksClient.getAccount(a.escrowState)).to.equal(null);
    expect(await context.banksClient.getAccount(b.escrowState)).to.equal(null);
    expect(
      idsOf((await program.account.escrowIndex.fetch(pda)).entries)
    ).to.deep.equal([]);

    expect(cuWith).to.be.greaterThan(0);
    expect(cuWithout).to.be.greaterThan(0);
    expect(cuWith).to.be.lessThan(CU_REGRESSION_GUARD);
    expect(cuWithout).to.be.lessThan(CU_REGRESSION_GUARD);
  });
});
