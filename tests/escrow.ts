import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { startAnchor, Clock, ProgramTestContext } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
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
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import { Escrow } from "../target/types/escrow";
import idl from "../target/idl/escrow.json";

// Synthetic 6-decimal SPL mint (NOT Circle USDC devnet — cannot mint that in bankrun; SDD §10.3).
const DECIMALS = 6;
const ONE_TOKEN = 1_000_000n; // 1.0 token @ 6 decimals
const DEPOSIT_AMOUNT = ONE_TOKEN; // amount custodied per test

// Fixture deadline: 2 hours. A literal owned by this test file, picked INSIDE the custody window
// the program enforces (floor 1 h, ceiling 24 h) and far from both edges, so that no happy-path
// test here depends on edge arithmetic. The edges are proven separately, in escrow-window.ts.
// It replaced a 1000 second literal (16 min), which is now below the floor: the fixture moved, not
// one assertion. The canary below still asserts the same 154 bytes it always did.
const FIXTURE_TTL = 7_200n;

describe("escrow — WasiAI trustless USDC escrow (anchor-bankrun)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: Program<Escrow>;
  let payer: Keypair; // funded genesis payer / SPL mint authority / tx fee payer

  let sender: Keypair;
  let authority: Keypair;
  let beneficiary: Keypair;
  let attacker: Keypair;

  let mint: PublicKey;
  let senderAta: PublicKey;
  let beneficiaryAta: PublicKey;
  let nowTs: bigint;

  // ---- low-level helpers (no RPC Connection in bankrun) --------------------

  async function processIxs(ixs, signers: Keypair[]) {
    const tx = new Transaction();
    const [bh] = await context.banksClient.getLatestBlockhash();
    tx.recentBlockhash = bh;
    tx.feePayer = signers[0].publicKey;
    tx.add(...ixs);
    tx.sign(...signers);
    await context.banksClient.processTransaction(tx);
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

  // `mintOverride` is an OPTIONAL TRAILING parameter on purpose: every call site that existed
  // before WKH-343 keeps working byte for byte, and the second mint the WKH-343 tests need is
  // reachable without touching any of them (CD-14).
  async function createAta(
    owner: PublicKey,
    mintOverride: PublicKey = mint
  ): Promise<PublicKey> {
    const ata = getAssociatedTokenAddressSync(mintOverride, owner, true);
    await processIxs(
      [
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          ata,
          owner,
          mintOverride,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        ),
      ],
      [payer]
    );
    return ata;
  }

  // Closes an SPL token account. Only the account's OWNER can sign this, which is exactly the
  // point in test 15: the beneficiary can walk away from a mint after the deposit already landed.
  async function closeAta(ata: PublicKey, owner: Keypair) {
    await processIxs(
      [
        createCloseAccountInstruction(
          ata,
          payer.publicKey, // rent destination
          owner.publicKey,
          [],
          TOKEN_PROGRAM_ID
        ),
      ],
      [payer, owner]
    );
  }

  async function mintTo(
    dest: PublicKey,
    amount: bigint,
    mintOverride: PublicKey = mint
  ) {
    await processIxs(
      [
        createMintToInstruction(
          mintOverride,
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

  function pdas(rid: Uint8Array, mintOverride: PublicKey = mint) {
    const [escrowState] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), sender.publicKey.toBuffer(), Buffer.from(rid)],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mintOverride, escrowState, true);
    return { escrowState, vault };
  }

  function rid(seed: number): Uint8Array {
    const b = new Uint8Array(16);
    b[0] = seed;
    return b;
  }

  function statusKey(status: any): string {
    return Object.keys(status)[0];
  }

  // `opts` is an OPTIONAL TRAILING parameter: the 10 call sites that existed before WKH-343 are
  // byte for byte unchanged (CD-14).
  //
  // NOTE, and it is the whole point of W2.3: this builder deliberately does NOT name
  // `beneficiaryAta` in `accountsPartial`. Anchor's client-side account resolution
  // (`[features] resolution = true`, Anchor.toml:7) is left to derive it from the IDL `pda` block,
  // whose first seed is the `beneficiary` INSTRUCTION ARG. Whether that is enough is a MEASUREMENT,
  // not an assumption, and it is the same measurement that tells chaski-v3 whether it needs a code
  // change or only a re-pinned IDL. A test that needs a DELIBERATELY WRONG account passes
  // `beneficiaryAtaOverride` and thereby opts out of the derivation.
  async function deposit(
    remittanceId: Uint8Array,
    amount: bigint,
    deadline: bigint,
    opts: {
      mintOverride?: PublicKey;
      senderAtaOverride?: PublicKey;
      beneficiaryAtaOverride?: PublicKey;
      extraTrailingAccount?: PublicKey;
    } = {}
  ) {
    const mintUsed = opts.mintOverride ?? mint;
    const { escrowState, vault } = pdas(remittanceId, mintUsed);
    const accounts: Record<string, PublicKey> = {
      sender: sender.publicKey,
      mint: mintUsed,
      escrowState,
      vault,
      senderAta: opts.senderAtaOverride ?? senderAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
    if (opts.beneficiaryAtaOverride) {
      accounts.beneficiaryAta = opts.beneficiaryAtaOverride;
    }
    let builder = program.methods
      .deposit(
        Array.from(remittanceId),
        beneficiary.publicKey,
        authority.publicKey,
        new anchor.BN(amount.toString()),
        new anchor.BN(deadline.toString())
      )
      .accountsPartial(accounts);
    // Mirrors what the real client does today: chaski-v3 appends a Solana-Pay style `reference`
    // pubkey the program never reads (solana-wallet.ts, remainingAccounts). Test 14 proves an
    // account past the end of the declared list does not break the instruction.
    if (opts.extraTrailingAccount) {
      builder = builder.remainingAccounts([
        {
          pubkey: opts.extraTrailingAccount,
          isSigner: false,
          isWritable: false,
        },
      ]);
    }
    await builder.signers([sender]).rpc();
    return { escrowState, vault };
  }

  // Advance to a fresh slot so a subsequent same-shape tx gets a new blockhash
  // (otherwise bankrun dedups it by signature as "already processed" instead of
  // executing it and hitting the intended program error).
  async function bumpSlot() {
    const c = await context.banksClient.getClock();
    context.warpToSlot(c.slot + 1n);
  }

  function warpTo(unixTs: bigint) {
    // preserve slot/epoch, override unix_timestamp (deterministic time control)
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

  // Assert a tx reverts with a given Anchor error code (or a log substring fallback).
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

  // Same as expectRevert, PLUS: the failure must be attributed to a specific ACCOUNT.
  //
  // Why this exists instead of just reusing expectRevert: `AccountNotInitialized` is error 3012 for
  // EVERY account in the instruction, so pinning the code alone does not distinguish "the
  // beneficiary's ATA is missing" from "the sender's ATA is missing". What separates them is the
  // account NAME, which Anchor attaches via `.with_account_name(...)` in the generated
  // try_accounts (anchor-syn 1.1.2 codegen/accounts/try_accounts.rs) and the TS client exposes as
  // `error.origin`.
  //
  // `error.origin` is a STRING, not an object: the client assigns `const origin = accountName`
  // (@coral-xyz/anchor dist/cjs/error.js). `e.error.origin.accountName` would be undefined.
  //
  // The log fallback is not defensive padding: in bankrun not every failure arrives as a typed
  // AnchorError, which is exactly why `expectRevert` above already has two paths.
  async function expectRevertOnAccount(
    p: Promise<any>,
    code: string,
    accountName: string
  ) {
    let threw = false;
    try {
      await p;
    } catch (e: any) {
      threw = true;
      const blob =
        (e.logs ? e.logs.join("\n") : "") +
        " " +
        (e.transactionMessage || "") +
        " " +
        (e.message || "");
      if (e instanceof anchor.AnchorError) {
        expect(e.error.errorCode.code).to.equal(code);
        expect(
          e.error.origin,
          `expected the error to be attributed to account "${accountName}"`
        ).to.equal(accountName);
      } else {
        expect(blob, `error did not contain "${code}": ${blob}`).to.include(
          code
        );
        expect(
          blob,
          `error was not attributed to account "${accountName}": ${blob}`
        ).to.include(`AnchorError caused by account: ${accountName}`);
      }
    }
    expect(
      threw,
      `expected tx to revert with ${code} on account ${accountName}`
    ).to.equal(true);
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

    await fundSol(sender.publicKey, 100); // sender pays rent for init (escrow_state + vault)

    mint = await createMint6(payer.publicKey);
    senderAta = await createAta(sender.publicKey);
    beneficiaryAta = await createAta(beneficiary.publicKey);
    await mintTo(senderAta, 1_000n * ONE_TOKEN);

    nowTs = (await context.banksClient.getClock()).unixTimestamp;
  });

  // ---- T1a: CANARY — escrow_state is EXACTLY 154 bytes (AC-6 / CD-7) -------
  //
  // 8 (discriminator) + EscrowState::INIT_SPACE (32*4 + 8 + 8 + 1 + 1 = 146) = 154, no padding.
  // Adding ANY field to EscrowState keeps the discriminator identical (it hashes only the struct
  // NAME) but makes borsh deserialization of every already-live 154-byte account fail with
  // UnexpectedEof => AccountDidNotDeserialize (3003) on release/refund/close. That would brick
  // exactly the escrows that hold funds today — a fix for "unreachable funds" that makes funds
  // unreachable. DO NOT delete this test, do not relax it, do not turn it into a range assertion.
  //
  // ⚠️ IF YOU MUTATE EscrowState TO PROVE THIS CANARY FAILS (good practice — please do), READ THIS:
  // the mutation contaminates target/ (.so + IDL + types), and target/ is gitignored, so restoring
  // lib.rs leaves `git status` clean while the MUTANT .so stays on disk. `anchor deploy` does not
  // compile: it ships whatever is in target/deploy/. It happened on 2026-07-27 and it almost
  // deployed the mutant to devnet. After reverting the source you MUST rebuild and re-verify the
  // ARTIFACT, not the source:
  //   touch programs/escrow/src/lib.rs && anchor build
  //   anchor test --skip-build --skip-deploy --skip-local-validator     # this test loads that .so
  // Full procedure (with the IDL/.so checks): doc/sdd/002-escrow-remittance-id-recovery/
  // runbook-R1-deploy-devnet.md, step 0.
  it("1a. CANARY: a deposit produces an escrow_state of EXACTLY 154 bytes (AC-6/CD-7)", async () => {
    const id = rid(11);
    const { escrowState } = await deposit(id, DEPOSIT_AMOUNT, nowTs + FIXTURE_TTL);

    const acc = await context.banksClient.getAccount(escrowState);
    assert.isNotNull(acc, "escrow_state must exist after deposit");
    expect(acc!.data.length).to.equal(154);
  });

  // ---- Test 1: happy path deposit -> release (AC-1, AC-2, AC-9) ------------

  it("1. deposit then release pays exactly the recorded beneficiary; vault drained; status Released", async () => {
    const id = rid(1);
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = await deposit(id, DEPOSIT_AMOUNT, deadline);

    expect(await tokenBalance(vault)).to.equal(DEPOSIT_AMOUNT);
    expect(await tokenBalance(beneficiaryAta)).to.equal(0n);

    await program.methods
      .release(Array.from(id))
      .accountsPartial({
        authority: authority.publicKey,
        sender: sender.publicKey,
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

    expect(await tokenBalance(beneficiaryAta)).to.equal(DEPOSIT_AMOUNT);
    expect(await tokenBalance(vault)).to.equal(0n);
    const state = await program.account.escrowState.fetch(escrowState);
    expect(statusKey(state.status)).to.equal("released");
  });

  // ---- Test 2: release by signer != authority reverts (AC-6) ---------------

  it("2. release signed by a non-authority reverts (ConstraintHasOne); vault untouched", async () => {
    const id = rid(2);
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = await deposit(id, DEPOSIT_AMOUNT, deadline);

    await expectRevert(
      program.methods
        .release(Array.from(id))
        .accountsPartial({
          authority: attacker.publicKey,
          sender: sender.publicKey,
          beneficiary: beneficiary.publicKey,
          mint,
          escrowState,
          vault,
          beneficiaryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([attacker])
        .rpc(),
      "ConstraintHasOne"
    );

    expect(await tokenBalance(vault)).to.equal(DEPOSIT_AMOUNT);
  });

  // ---- Test 3: refund before deadline reverts (AC-5) -----------------------

  it("3. refund before the deadline reverts (DeadlineNotReached); vault untouched", async () => {
    const id = rid(3);
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = await deposit(id, DEPOSIT_AMOUNT, deadline);

    await expectRevert(
      program.methods
        .refund(Array.from(id))
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
        .rpc(),
      "DeadlineNotReached"
    );

    expect(await tokenBalance(vault)).to.equal(DEPOSIT_AMOUNT);
  });

  // ---- Test 4: refund after deadline works without authority (AC-4) --------

  it("4. refund after the deadline succeeds for the sender alone (authority never signs); status Refunded", async () => {
    const id = rid(4);
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = await deposit(id, DEPOSIT_AMOUNT, deadline);

    const before = await tokenBalance(senderAta);
    await warpTo(deadline + 1n);

    await program.methods
      .refund(Array.from(id))
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

    expect(await tokenBalance(senderAta)).to.equal(before + DEPOSIT_AMOUNT);
    expect(await tokenBalance(vault)).to.equal(0n);
    const state = await program.account.escrowState.fetch(escrowState);
    expect(statusKey(state.status)).to.equal("refunded");
  });

  // ---- Test 5: double terminal transition reverts (AC-3, AC-2) -------------

  it("5. a second terminal transition reverts (EscrowNotDeposited) after release and after refund", async () => {
    // 5a. deposit -> release OK, then a second release reverts
    const idA = rid(50);
    const dlA = nowTs + FIXTURE_TTL;
    const a = await deposit(idA, DEPOSIT_AMOUNT, dlA);
    const releaseAccounts = {
      authority: authority.publicKey,
      sender: sender.publicKey,
      beneficiary: beneficiary.publicKey,
      mint,
      escrowState: a.escrowState,
      vault: a.vault,
      beneficiaryAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    };
    await program.methods
      .release(Array.from(idA))
      .accountsPartial(releaseAccounts)
      .signers([authority])
      .rpc();
    await bumpSlot(); // fresh blockhash so the retry is a distinct tx
    await expectRevert(
      program.methods
        .release(Array.from(idA))
        .accountsPartial(releaseAccounts)
        .signers([authority])
        .rpc(),
      "EscrowNotDeposited"
    );

    // 5b. deposit -> refund OK, then release reverts
    const idB = rid(51);
    const dlB = nowTs + FIXTURE_TTL;
    const b = await deposit(idB, DEPOSIT_AMOUNT, dlB);
    await warpTo(dlB + 1n);
    await program.methods
      .refund(Array.from(idB))
      .accountsPartial({
        sender: sender.publicKey,
        mint,
        escrowState: b.escrowState,
        vault: b.vault,
        senderAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([sender])
      .rpc();
    await expectRevert(
      program.methods
        .release(Array.from(idB))
        .accountsPartial({
          authority: authority.publicKey,
          sender: sender.publicKey,
          beneficiary: beneficiary.publicKey,
          mint,
          escrowState: b.escrowState,
          vault: b.vault,
          beneficiaryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([authority])
        .rpc(),
      "EscrowNotDeposited"
    );
  });

  // ---- Test 6: re-deposit on same seeds reverts (AC-7) ---------------------

  it("6. a second deposit on the same [sender, remittance_id] seeds reverts (account already in use)", async () => {
    const id = rid(6);
    const deadline = nowTs + FIXTURE_TTL;
    await deposit(id, DEPOSIT_AMOUNT, deadline);

    // Second deposit reuses the same [sender, remittance_id] seeds but is a
    // distinct transaction (different `deadline` arg) so bankrun does not dedup
    // it by signature; `init` must then collide on the existing PDA.
    await expectRevert(
      deposit(id, DEPOSIT_AMOUNT, deadline + 1n),
      "already in use"
    );
  });

  // ---- Extra coverage (not AC-12, adds audit value) ------------------------

  it("7. close while Deposited reverts (EscrowNotTerminal) — AC-8", async () => {
    const id = rid(7);
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = await deposit(id, DEPOSIT_AMOUNT, deadline);

    await expectRevert(
      program.methods
        .close(Array.from(id))
        .accountsPartial({
          sender: sender.publicKey,
          mint,
          escrowState,
          vault,
          senderAta, // sweep destination, new account in this instruction
          tokenProgram: TOKEN_PROGRAM_ID,
          // Explicit null, never an absent key: leaving the key out makes the client derive
          // ["escrow-index", sender] from the IDL seeds and send it anyway (CD-14).
          escrowIndex: null,
        })
        .signers([sender])
        .rpc(),
      "EscrowNotTerminal"
    );
  });

  it("8. close after release returns rent + vault to sender, and the same seeds are reusable via a fresh deposit (anti-revival)", async () => {
    const id = rid(8);
    const deadline = nowTs + FIXTURE_TTL;
    const first = await deposit(id, DEPOSIT_AMOUNT, deadline);

    await program.methods
      .release(Array.from(id))
      .accountsPartial({
        authority: authority.publicKey,
        sender: sender.publicKey,
        beneficiary: beneficiary.publicKey,
        mint,
        escrowState: first.escrowState,
        vault: first.vault,
        beneficiaryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    await program.methods
      .close(Array.from(id))
      .accountsPartial({
        sender: sender.publicKey,
        mint,
        escrowState: first.escrowState,
        vault: first.vault,
        senderAta, // sweep destination, new account in this instruction
        tokenProgram: TOKEN_PROGRAM_ID,
        // Explicit null: this sender never called register_escrow, so the index PDA does not
        // exist. Omitting the key would send it anyway and revert with 3012 (CD-14).
        escrowIndex: null,
      })
      .signers([sender])
      .rpc();

    // escrow_state and vault are gone
    expect(await context.banksClient.getAccount(first.escrowState)).to.equal(
      null
    );
    expect(await tokenBalance(first.vault)).to.equal(-1n);

    // seeds reusable via a clean init (not a revival)
    const second = await deposit(id, DEPOSIT_AMOUNT, deadline);
    const state = await program.account.escrowState.fetch(second.escrowState);
    expect(statusKey(state.status)).to.equal("deposited");
    expect(await tokenBalance(second.vault)).to.equal(DEPOSIT_AMOUNT);
  });

  it("9. deposit with amount == 0 reverts (ZeroAmount)", async () => {
    const id = rid(9);
    const deadline = nowTs + FIXTURE_TTL;
    await expectRevert(deposit(id, 0n, deadline), "ZeroAmount");
  });

  // ==========================================================================
  // WKH-343 — deposit must demand the SAME account release will demand
  // ==========================================================================
  //
  // The shape of the incident these tests reproduce, measured on devnet at slot 482579152:
  // four escrows had EXACTLY ONE transaction each, the Deposit, and no release could ever be
  // built for them because the recorded beneficiary had no token account for the escrow's mint
  // (0 token accounts for that mint at slot 482578601).
  //
  // ⚠️ These tests reproduce the SHAPE, not the addresses. The mints here are synthetic 6-decimal
  // mints: Circle's devnet USDC cannot be minted inside bankrun. Two mints, an ATA on only one of
  // them — that is the shape.
  //
  // ⚠️ What these tests do NOT establish, and it must not be compressed away: on devnet the mint
  // and the sender CO-VARY perfectly (the 6 rows on our mint came from one sender, the 4 rows on
  // Circle's mint from another), so with n=10 the field data does NOT separate "it is the mint"
  // from "it is which client build made the deposit". What IS measured is that the BENEFICIARY
  // cannot explain it: it is byte for byte the same in all 10 rows, including the 3 that got paid.

  // A second synthetic mint, funded for the sender, on which the beneficiary has NO token account.
  async function secondMintFixture(): Promise<{
    mintB: PublicKey;
    senderAtaB: PublicKey;
  }> {
    const mintB = await createMint6(payer.publicKey);
    const senderAtaB = await createAta(sender.publicKey, mintB);
    await mintTo(senderAtaB, 1_000n * ONE_TOKEN, mintB);
    return { mintB, senderAtaB };
  }

  it("10. deposit reverts when the beneficiary has NO token account for the mint; nothing is created and nothing moves (AC-1)", async () => {
    const { mintB, senderAtaB } = await secondMintFixture();
    const id = rid(10);
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = pdas(id, mintB);
    const senderBefore = await tokenBalance(senderAtaB);

    await expectRevertOnAccount(
      deposit(id, DEPOSIT_AMOUNT, deadline, {
        mintOverride: mintB,
        senderAtaOverride: senderAtaB,
      }),
      "AccountNotInitialized",
      "beneficiary_ata"
    );

    // The deposit is rejected BEFORE a single token moves: no escrow_state, no vault, and the
    // sender's balance is untouched. This is the difference between the guard and `init_if_needed`.
    expect(await context.banksClient.getAccount(escrowState)).to.equal(null);
    expect(await context.banksClient.getAccount(vault)).to.equal(null);
    expect(await tokenBalance(senderAtaB)).to.equal(senderBefore);
  });

  it("11. deposit reverts when the account passed is the beneficiary's ATA for a DIFFERENT mint (ConstraintAssociated)", async () => {
    const { mintB, senderAtaB } = await secondMintFixture();
    const id = rid(21);
    const deadline = nowTs + FIXTURE_TTL;

    // `beneficiaryAta` is the beneficiary's ATA for the module `mint`, NOT for mintB. The owner
    // check passes (it really is the beneficiary's) and the ADDRESS check is what rejects it.
    await expectRevertOnAccount(
      deposit(id, DEPOSIT_AMOUNT, deadline, {
        mintOverride: mintB,
        senderAtaOverride: senderAtaB,
        beneficiaryAtaOverride: beneficiaryAta,
      }),
      "ConstraintAssociated",
      "beneficiary_ata"
    );

    expect(await context.banksClient.getAccount(pdas(id, mintB).escrowState)).to.equal(null);
  });

  it("12. deposit reverts when the account passed holds the right mint but belongs to SOMEBODY ELSE (ConstraintTokenOwner)", async () => {
    const { mintB, senderAtaB } = await secondMintFixture();
    const attackerAtaB = await createAta(attacker.publicKey, mintB);
    const id = rid(22);
    const deadline = nowTs + FIXTURE_TTL;

    // Right mint, wrong owner. This is what stops the guard from being satisfied by ANY token
    // account: it has to belong to the beneficiary that gets written into EscrowState.
    await expectRevertOnAccount(
      deposit(id, DEPOSIT_AMOUNT, deadline, {
        mintOverride: mintB,
        senderAtaOverride: senderAtaB,
        beneficiaryAtaOverride: attackerAtaB,
      }),
      "ConstraintTokenOwner",
      "beneficiary_ata"
    );

    expect(await tokenBalance(attackerAtaB)).to.equal(0n);
    expect(await context.banksClient.getAccount(pdas(id, mintB).escrowState)).to.equal(null);
  });

  it("13. regression of the incident, end to end: the rejected deposit becomes payable after ONE transaction", async () => {
    const { mintB, senderAtaB } = await secondMintFixture();
    const id = rid(23);
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = pdas(id, mintB);

    // ---- half 1: the incident. The beneficiary has an ATA for `mint` and none for mintB. ----
    await expectRevertOnAccount(
      deposit(id, DEPOSIT_AMOUNT, deadline, {
        mintOverride: mintB,
        senderAtaOverride: senderAtaB,
      }),
      "AccountNotInitialized",
      "beneficiary_ata"
    );
    expect(await context.banksClient.getAccount(escrowState)).to.equal(null);

    // ---- the remedy, and the point of this test: it is ONE transaction, by anyone who pays ----
    const beneficiaryAtaB = await createAta(beneficiary.publicKey, mintB);

    // ---- half 2: the SAME deposit now enters. bumpSlot first, because bankrun dedups an
    // identical tx by signature and the retry would "pass" without ever executing.
    await bumpSlot();
    await deposit(id, DEPOSIT_AMOUNT, deadline, {
      mintOverride: mintB,
      senderAtaOverride: senderAtaB,
    });
    expect(await tokenBalance(vault)).to.equal(DEPOSIT_AMOUNT);

    // ---- and a release inside the deadline pays the exact amount to the beneficiary ----
    await program.methods
      .release(Array.from(id))
      .accountsPartial({
        authority: authority.publicKey,
        sender: sender.publicKey,
        beneficiary: beneficiary.publicKey,
        mint: mintB,
        escrowState,
        vault,
        beneficiaryAta: beneficiaryAtaB,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    expect(await tokenBalance(beneficiaryAtaB)).to.equal(DEPOSIT_AMOUNT);
    expect(await tokenBalance(vault)).to.equal(0n);
    const state = await program.account.escrowState.fetch(escrowState);
    expect(statusKey(state.status)).to.equal("released");
  });

  it("14. a deposit carrying one EXTRA account past the end of the declared list still succeeds", async () => {
    const id = rid(24);
    const deadline = nowTs + FIXTURE_TTL;

    // This is the mechanism the whole DEPLOY ORDER rests on (and it is why `beneficiary_ata` is
    // declared LAST, after system_program, breaking the "programs go last" convention on purpose):
    // Anchor only ever fails for accounts it is MISSING, and surplus accounts land in
    // `remaining_accounts`, which `Deposit` never reads. So a CLIENT can be updated BEFORE the
    // program without a window in which deposits fail.
    //
    // It is also why the real client's Solana-Pay style `reference` pubkey does not get in the way.
    const reference = Keypair.generate().publicKey;
    const { escrowState, vault } = await deposit(id, DEPOSIT_AMOUNT, deadline, {
      extraTrailingAccount: reference,
    });

    expect(await tokenBalance(vault)).to.equal(DEPOSIT_AMOUNT);
    const state = await program.account.escrowState.fetch(escrowState);
    expect(statusKey(state.status)).to.equal("deposited");
    expect(state.beneficiary.toBase58()).to.equal(
      beneficiary.publicKey.toBase58()
    );
  });

  it("15. the beneficiary can CLOSE its ATA after a valid deposit, and then release reverts — the LIMIT of this guard", async () => {
    const id = rid(25);
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = await deposit(id, DEPOSIT_AMOUNT, deadline);
    expect(await tokenBalance(vault)).to.equal(DEPOSIT_AMOUNT);

    // The beneficiary walks away from this mint AFTER the deposit landed. Nobody can stop this:
    // an SPL CloseAccount on one's own token account is signed by its owner.
    await closeAta(beneficiaryAta, beneficiary);
    expect(await context.banksClient.getAccount(beneficiaryAta)).to.equal(null);

    // THIS TEST IS THE HONESTY TEST OF WKH-343. Do not delete it, do not weaken it.
    // The guard added to `deposit` checks the ATA exists AT DEPOSIT TIME. It therefore BOUNDS the
    // case "the ATA never existed" and leaves OPEN the case "it existed and was closed". Without
    // this test, the prose of this HU ("a deposit that cannot be settled is rejected") stops being
    // falsifiable and starts reading as "this can no longer happen", which is false.
    //
    // It also turns a DERIVED claim into a MEASURED one: that `release` fails with
    // AccountNotInitialized on `beneficiary_ata`. That was never observed on chain — the four
    // stuck escrows had exactly one transaction each, the Deposit, so no release ever landed.
    // This test is where that stops being a derivation.
    await expectRevertOnAccount(
      program.methods
        .release(Array.from(id))
        .accountsPartial({
          authority: authority.publicKey,
          sender: sender.publicKey,
          beneficiary: beneficiary.publicKey,
          mint,
          escrowState,
          vault,
          beneficiaryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([authority])
        .rpc(),
      "AccountNotInitialized",
      "beneficiary_ata"
    );

    // The money did not move, and the only remaining exit is the refund path after the deadline.
    expect(await tokenBalance(vault)).to.equal(DEPOSIT_AMOUNT);
    const state = await program.account.escrowState.fetch(escrowState);
    expect(statusKey(state.status)).to.equal("deposited");
  });
});
