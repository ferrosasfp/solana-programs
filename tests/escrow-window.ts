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
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import { Escrow } from "../target/types/escrow";
// The IDL is imported DIRECTLY, never guarded by existsSync + it.skip: if the build artifact is
// missing this suite must EXPLODE, not silently vanish.
import idl from "../target/idl/escrow.json";

const DECIMALS = 6;
const ONE_TOKEN = 1_000_000n;
const DEPOSIT_AMOUNT = ONE_TOKEN;

// ---------------------------------------------------------------------------
// The three numbers, RE-DECLARED here on purpose
// ---------------------------------------------------------------------------
//
// These are independent literals, NOT imported from the program and NOT recomputed from its
// formula. That is deliberate and it is the whole value of this file: a test that asked the program
// for its own constant, or that re-derived `deadline + PAYOUT_EXTENSION_SECS` the same way the
// program does, would keep passing after someone multiplied the extension by ten. It would be a
// guard comparing itself against itself.
//
// So: if these drift from programs/escrow/src/lib.rs, this suite goes RED. That is the intended
// behaviour, not a maintenance annoyance. Changing the program's numbers means coming here and
// typing the new ones by hand, which is exactly the moment where somebody has to look at them.
const MIN_CUSTODY_SECS = 3_600n; // 1 h, provisional (see lib.rs)
const MAX_CUSTODY_SECS = 86_400n; // 24 h, provisional (see lib.rs)
const PAYOUT_EXTENSION_SECS = 3_600n; // 1 h once, provisional (see lib.rs)

// Fixture deadline well inside the window and far from both edges.
const FIXTURE_TTL = 7_200n;

describe("escrow-window — the custody window and the payout freeze", () => {
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

  function pdas(rid: Uint8Array) {
    const [escrowState] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), sender.publicKey.toBuffer(), Buffer.from(rid)],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mint, escrowState, true);
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

  async function deposit(
    remittanceId: Uint8Array,
    amount: bigint,
    deadline: bigint
  ) {
    const { escrowState, vault } = pdas(remittanceId);
    await program.methods
      .deposit(
        Array.from(remittanceId),
        beneficiary.publicKey,
        authority.publicKey,
        new anchor.BN(amount.toString()),
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
      .signers([sender])
      .rpc();
    return { escrowState, vault };
  }

  function release(
    remittanceId: Uint8Array,
    escrowState: PublicKey,
    vault: PublicKey,
    signer: Keypair = authority
  ) {
    return program.methods
      .release(Array.from(remittanceId))
      .accountsPartial({
        authority: signer.publicKey,
        sender: sender.publicKey,
        beneficiary: beneficiary.publicKey,
        mint,
        escrowState,
        vault,
        beneficiaryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([signer])
      .rpc();
  }

  function refund(
    remittanceId: Uint8Array,
    escrowState: PublicKey,
    vault: PublicKey
  ) {
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

  function beginPayout(
    remittanceId: Uint8Array,
    escrowState: PublicKey,
    fiatRef: number[],
    signer: Keypair = authority
  ) {
    return program.methods
      .beginPayout(Array.from(remittanceId), fiatRef)
      .accountsPartial({
        authority: signer.publicKey,
        sender: sender.publicKey,
        escrowState,
      })
      .signers([signer])
      .rpc();
  }

  function abortPayout(
    remittanceId: Uint8Array,
    escrowState: PublicKey,
    signer: Keypair = authority
  ) {
    return program.methods
      .abortPayout(Array.from(remittanceId))
      .accountsPartial({
        authority: signer.publicKey,
        sender: sender.publicKey,
        escrowState,
      })
      .signers([signer])
      .rpc();
  }

  function close(
    remittanceId: Uint8Array,
    escrowState: PublicKey,
    vault: PublicKey
  ) {
    return program.methods
      .close(Array.from(remittanceId))
      .accountsPartial({
        sender: sender.publicKey,
        mint,
        escrowState,
        vault,
        senderAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sender])
      .rpc();
  }

  function fiatRef(seed: number): number[] {
    const b = new Array(32).fill(0);
    b[0] = seed;
    b[31] = 0xab;
    return b;
  }

  // bankrun dedups txs by signature: any retry of an identical-shape tx must advance the slot
  // (fresh blockhash) or it "passes" without ever executing.
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

  // Asserting "it throws" is not enough: every revert test pins the exact Anchor code.
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

  async function deadlineOf(escrowState: PublicKey): Promise<bigint> {
    const s = await program.account.escrowState.fetch(escrowState);
    return BigInt(s.deadline.toString());
  }

  async function statusOf(escrowState: PublicKey): Promise<string> {
    const s = await program.account.escrowState.fetch(escrowState);
    return statusKey(s.status);
  }

  // begin_payout through raw ixs so the tx meta (and therefore the emitted event) is observable.
  async function beginPayoutWithMeta(
    remittanceId: Uint8Array,
    escrowState: PublicKey,
    fiatRefBytes: number[],
    signer: Keypair = authority
  ) {
    const ix = await program.methods
      .beginPayout(Array.from(remittanceId), fiatRefBytes)
      .accountsPartial({
        authority: signer.publicKey,
        sender: sender.publicKey,
        escrowState,
      })
      .instruction();
    return processIxs([ix], [signer]);
  }

  function decodeEvents(meta: any): any[] {
    const out: any[] = [];
    for (const line of meta.logMessages ?? []) {
      const m = /^Program data: (.+)$/.exec(line);
      if (!m) continue;
      const ev = program.coder.events.decode(m[1]);
      if (ev) out.push(ev);
    }
    return out;
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

    await fundSol(sender.publicKey, 100);
    await fundSol(attacker.publicKey, 10); // the attacker must be able to PAY, so a failure is a guard
    await fundSol(authority.publicKey, 10);

    mint = await createMint6(payer.publicKey);
    senderAta = await createAta(sender.publicKey);
    beneficiaryAta = await createAta(beneficiary.publicKey);
    await mintTo(senderAta, 1_000n * ONE_TOKEN);

    nowTs = (await context.banksClient.getClock()).unixTimestamp;
  });

  // =========================================================================
  // A. The deposit window has a floor and a ceiling (attacks A1 and A2)
  // =========================================================================

  it("A1. a deposit with a one-second deadline reverts (DeadlineTooSoon) and nothing is custodied", async () => {
    const id = rid(1);
    const { vault } = pdas(id);
    await expectRevert(deposit(id, DEPOSIT_AMOUNT, nowTs + 1n), "DeadlineTooSoon");
    // no vault, no escrow_state: the revert is total, not partial
    expect(await tokenBalance(vault)).to.equal(-1n);
  });

  it("A1b. a deposit one second BELOW the floor reverts, and exactly AT the floor is accepted", async () => {
    // The two sides of the same edge, so a `>` written where a `>=` belongs cannot survive.
    const below = rid(2);
    await expectRevert(
      deposit(below, DEPOSIT_AMOUNT, nowTs + MIN_CUSTODY_SECS - 1n),
      "DeadlineTooSoon"
    );

    const at = rid(3);
    const { escrowState } = await deposit(
      at,
      DEPOSIT_AMOUNT,
      nowTs + MIN_CUSTODY_SECS
    );
    expect(await deadlineOf(escrowState)).to.equal(nowTs + MIN_CUSTODY_SECS);
  });

  it("A2. a deposit with deadline = i64::MAX reverts (DeadlineTooFar) — the funds-with-no-exit case", async () => {
    const id = rid(4);
    const I64_MAX = (1n << 63n) - 1n;
    await expectRevert(deposit(id, DEPOSIT_AMOUNT, I64_MAX), "DeadlineTooFar");
  });

  it("A2b. a deposit one second ABOVE the ceiling reverts, and exactly AT the ceiling is accepted", async () => {
    const above = rid(5);
    await expectRevert(
      deposit(above, DEPOSIT_AMOUNT, nowTs + MAX_CUSTODY_SECS + 1n),
      "DeadlineTooFar"
    );

    const at = rid(6);
    const { escrowState } = await deposit(
      at,
      DEPOSIT_AMOUNT,
      nowTs + MAX_CUSTODY_SECS
    );
    expect(await deadlineOf(escrowState)).to.equal(nowTs + MAX_CUSTODY_SECS);
  });

  it("A2c. the ceiling is measured against the CLOCK, not against the deposit slot", async () => {
    // Lado A: the arg. Lado B: the validator clock. Moving the clock forward must move the ceiling
    // with it, which is what proves the guard reads the clock and not a compile-time origin.
    const id = rid(7);
    const stale = nowTs + MAX_CUSTODY_SECS; // legal right now
    await warpTo(nowTs + 10n); // ...and still legal ten seconds later
    await deposit(id, DEPOSIT_AMOUNT, stale);

    const id2 = rid(8);
    await warpTo(nowTs + 20n);
    await expectRevert(
      deposit(id2, DEPOSIT_AMOUNT, nowTs + 20n + MAX_CUSTODY_SECS + 1n),
      "DeadlineTooFar"
    );
  });

  // =========================================================================
  // B. THE INVARIANT, attacked at both edges
  //
  //   For every escrow account and every instant t, AT MOST ONE of `release`
  //   and `refund` can succeed.
  //
  // How to refute it: exhibit an instant and a state where both get in. These
  // tests try exactly that at t = deadline - 1 and t = deadline, which is where
  // a `<` written as a `<=` would show up.
  // =========================================================================

  it("B1. at t = deadline - 1 only release is legal: the refund reverts (DeadlineNotReached)", async () => {
    const deadline = nowTs + FIXTURE_TTL;
    const a = await deposit(rid(10), DEPOSIT_AMOUNT, deadline);
    const b = await deposit(rid(11), DEPOSIT_AMOUNT, deadline);

    await warpTo(deadline - 1n);

    // the refund is rejected...
    await expectRevert(refund(rid(11), b.escrowState, b.vault), "DeadlineNotReached");
    expect(await tokenBalance(b.vault)).to.equal(DEPOSIT_AMOUNT);

    // ...and the release, on an identical escrow at the same instant, goes through
    await release(rid(10), a.escrowState, a.vault);
    expect(await tokenBalance(beneficiaryAta)).to.equal(DEPOSIT_AMOUNT);
  });

  it("B2. at t = deadline EXACTLY only refund is legal: the release reverts (ReleaseWindowClosed)", async () => {
    const deadline = nowTs + FIXTURE_TTL;
    const a = await deposit(rid(12), DEPOSIT_AMOUNT, deadline);
    const b = await deposit(rid(13), DEPOSIT_AMOUNT, deadline);

    await warpTo(deadline); // the exact edge: `now < deadline` is false, `now >= deadline` is true

    await expectRevert(
      release(rid(12), a.escrowState, a.vault),
      "ReleaseWindowClosed"
    );
    expect(await tokenBalance(a.vault)).to.equal(DEPOSIT_AMOUNT);
    expect(await tokenBalance(beneficiaryAta)).to.equal(0n);

    const before = await tokenBalance(senderAta);
    await refund(rid(13), b.escrowState, b.vault);
    expect(await tokenBalance(senderAta)).to.equal(before + DEPOSIT_AMOUNT);
  });

  it("B3. across the whole edge, EXACTLY ONE of release and refund succeeds at every instant", async () => {
    // The invariant swept, not asserted at a single point. Two twin escrows per instant so that
    // neither attempt can be rejected merely because the other one already terminated the account.
    const deadline = nowTs + FIXTURE_TTL;
    const offsets = [-2n, -1n, 0n, 1n, 2n];

    const twins = offsets.map((_, i) => ({
      relId: rid(20 + i * 2),
      refId: rid(21 + i * 2),
    }));
    const built: { rel: any; ref: any }[] = [];
    for (const t of twins) {
      built.push({
        rel: await deposit(t.relId, DEPOSIT_AMOUNT, deadline),
        ref: await deposit(t.refId, DEPOSIT_AMOUNT, deadline),
      });
    }

    for (let i = 0; i < offsets.length; i++) {
      const t = deadline + offsets[i];
      await warpTo(t);
      await bumpSlot();

      let releaseOk = false;
      let refundOk = false;
      try {
        await release(twins[i].relId, built[i].rel.escrowState, built[i].rel.vault);
        releaseOk = true;
      } catch (_) {
        /* rejected, which is half the invariant */
      }
      try {
        await refund(twins[i].refId, built[i].ref.escrowState, built[i].ref.vault);
        refundOk = true;
      } catch (_) {
        /* idem */
      }

      const legal = Number(releaseOk) + Number(refundOk);
      expect(
        legal,
        `at t = deadline ${offsets[i] >= 0n ? "+" : ""}${offsets[i]} exactly one of release/refund must be legal (release=${releaseOk}, refund=${refundOk})`
      ).to.equal(1);
      // and which one it is, is decided by the clock, not by who arrives first
      expect(releaseOk, `release legality at offset ${offsets[i]}`).to.equal(
        offsets[i] < 0n
      );
      expect(refundOk, `refund legality at offset ${offsets[i]}`).to.equal(
        offsets[i] >= 0n
      );
    }
  });

  it("B4. a release six days after the deadline reverts (ReleaseWindowClosed) and the sender can still refund", async () => {
    // The defect with no precondition: an escrow deposited a week ago, expired six days ago, was
    // still releasable today.
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = await deposit(rid(40), DEPOSIT_AMOUNT, deadline);

    await warpTo(deadline + 6n * 86_400n);
    await expectRevert(release(rid(40), escrowState, vault), "ReleaseWindowClosed");

    const before = await tokenBalance(senderAta);
    await refund(rid(40), escrowState, vault);
    expect(await tokenBalance(senderAta)).to.equal(before + DEPOSIT_AMOUNT);
    const state = await program.account.escrowState.fetch(escrowState);
    expect(statusKey(state.status)).to.equal("refunded");
  });

  // =========================================================================
  // C. The freeze: it postpones ONCE and it can never revoke
  // =========================================================================

  it("C1. begin_payout moves the deadline by EXACTLY one hour, once, and moves zero tokens", async () => {
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = await deposit(rid(50), DEPOSIT_AMOUNT, deadline);
    const senderBefore = await tokenBalance(senderAta);
    const beneficiaryBefore = await tokenBalance(beneficiaryAta);

    await beginPayout(rid(50), escrowState, fiatRef(7));

    // The literal, computed here from this file's own numbers. NOT the program's constant and NOT
    // the program's formula: multiplying the extension by ten in lib.rs has to turn this red.
    expect(await deadlineOf(escrowState)).to.equal(
      nowTs + FIXTURE_TTL + PAYOUT_EXTENSION_SECS
    );
    expect(await statusOf(escrowState)).to.equal("payoutPending");

    // not a single token moved: the freeze is a clock operation, not a transfer
    expect(await tokenBalance(vault)).to.equal(DEPOSIT_AMOUNT);
    expect(await tokenBalance(senderAta)).to.equal(senderBefore);
    expect(await tokenBalance(beneficiaryAta)).to.equal(beneficiaryBefore);
  });

  it("C1b. the frozen escrow_state is STILL exactly 154 bytes (the new variant did not grow the layout)", async () => {
    const { escrowState } = await deposit(rid(51), DEPOSIT_AMOUNT, nowTs + FIXTURE_TTL);
    await beginPayout(rid(51), escrowState, fiatRef(1));

    const acc = await context.banksClient.getAccount(escrowState);
    assert.isNotNull(acc, "escrow_state must exist while PayoutPending");
    expect(acc!.data.length).to.equal(154);
  });

  it("C2. a SECOND begin_payout reverts (EscrowNotDeposited) and the deadline stays at its literal value", async () => {
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState } = await deposit(rid(52), DEPOSIT_AMOUNT, deadline);

    await beginPayout(rid(52), escrowState, fiatRef(1));
    await bumpSlot(); // fresh blockhash, or bankrun dedups the retry and it "passes" unexecuted
    await expectRevert(
      beginPayout(rid(52), escrowState, fiatRef(1)),
      "EscrowNotDeposited"
    );

    // pinned against a literal, not against "it did not change much": a renewable freeze is an
    // eternal freeze with another name, and the way it would show up is here.
    expect(await deadlineOf(escrowState)).to.equal(
      nowTs + FIXTURE_TTL + PAYOUT_EXTENSION_SECS
    );
  });

  it("C3. begin_payout on an already expired escrow reverts (ReleaseWindowClosed): postponing yes, revoking no", async () => {
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState } = await deposit(rid(53), DEPOSIT_AMOUNT, deadline);

    await warpTo(deadline); // the sender's right has already vested
    await expectRevert(
      beginPayout(rid(53), escrowState, fiatRef(1)),
      "ReleaseWindowClosed"
    );
    expect(await deadlineOf(escrowState)).to.equal(deadline);
    expect(await statusOf(escrowState)).to.equal("deposited");
  });

  it("C4. begin_payout signed by a third party reverts (ConstraintHasOne)", async () => {
    const { escrowState } = await deposit(rid(54), DEPOSIT_AMOUNT, nowTs + FIXTURE_TTL);
    // the attacker is funded, so the failure is the guard and not a missing fee payer
    await expectRevert(
      beginPayout(rid(54), escrowState, fiatRef(1), attacker),
      "ConstraintHasOne"
    );
    expect(await statusOf(escrowState)).to.equal("deposited");
  });

  it("C5. begin -> abort -> begin: the third one reverts (ReleaseWindowClosed), so the cycle is not a loophole", async () => {
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState } = await deposit(rid(55), DEPOSIT_AMOUNT, deadline);

    await beginPayout(rid(55), escrowState, fiatRef(1));
    await abortPayout(rid(55), escrowState);
    // abort left the deadline at `now`, so there is no window left to freeze
    await bumpSlot();
    await expectRevert(
      beginPayout(rid(55), escrowState, fiatRef(1)),
      "ReleaseWindowClosed"
    );
  });

  it("C6. abort_payout puts the deadline at NOW: the refund gets in immediately, for the exact amount", async () => {
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = await deposit(rid(56), DEPOSIT_AMOUNT, deadline);
    await beginPayout(rid(56), escrowState, fiatRef(1));

    const clockNow = (await context.banksClient.getClock()).unixTimestamp;
    await abortPayout(rid(56), escrowState);
    expect(await deadlineOf(escrowState)).to.equal(clockNow);
    expect(await statusOf(escrowState)).to.equal("deposited");

    const before = await tokenBalance(senderAta);
    await refund(rid(56), escrowState, vault);
    expect(await tokenBalance(senderAta)).to.equal(before + DEPOSIT_AMOUNT);
    expect(await tokenBalance(vault)).to.equal(0n);
    expect(await statusOf(escrowState)).to.equal("refunded");
  });

  it("C6b. after abort_payout the release is closed too: the authority cannot undo its own abort", async () => {
    const { escrowState, vault } = await deposit(rid(57), DEPOSIT_AMOUNT, nowTs + FIXTURE_TTL);
    await beginPayout(rid(57), escrowState, fiatRef(1));
    await abortPayout(rid(57), escrowState);

    await expectRevert(release(rid(57), escrowState, vault), "ReleaseWindowClosed");
    expect(await tokenBalance(vault)).to.equal(DEPOSIT_AMOUNT);
  });

  it("C7. abort_payout signed by the sender reverts (ConstraintHasOne)", async () => {
    const { escrowState } = await deposit(rid(58), DEPOSIT_AMOUNT, nowTs + FIXTURE_TTL);
    await beginPayout(rid(58), escrowState, fiatRef(1));

    await expectRevert(
      abortPayout(rid(58), escrowState, sender),
      "ConstraintHasOne"
    );
    expect(await statusOf(escrowState)).to.equal("payoutPending");
  });

  it("C8. abort_payout on a plain Deposited escrow reverts (EscrowNotPayoutPending)", async () => {
    // Aborting something that never began has no meaning, and allowing it would hand the authority
    // a way to unilaterally void any fresh remittance by parking its deadline at `now`.
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState } = await deposit(rid(59), DEPOSIT_AMOUNT, deadline);

    await expectRevert(
      abortPayout(rid(59), escrowState),
      "EscrowNotPayoutPending"
    );
    expect(await deadlineOf(escrowState)).to.equal(deadline);
  });

  it("C9. a frozen escrow is still refundable once the extended deadline passes (the funds are never trapped)", async () => {
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = await deposit(rid(60), DEPOSIT_AMOUNT, deadline);
    await beginPayout(rid(60), escrowState, fiatRef(1));

    // one second before the extended deadline the freeze is still holding...
    await warpTo(deadline + PAYOUT_EXTENSION_SECS - 1n);
    await expectRevert(
      refund(rid(60), escrowState, vault),
      "DeadlineNotReached"
    );

    // ...and at the extended deadline the sender recovers, without the authority ever showing up
    await warpTo(deadline + PAYOUT_EXTENSION_SECS);
    const before = await tokenBalance(senderAta);
    await refund(rid(60), escrowState, vault);
    expect(await tokenBalance(senderAta)).to.equal(before + DEPOSIT_AMOUNT);
    expect(await statusOf(escrowState)).to.equal("refunded");
  });

  it("C10. a frozen escrow can still be released inside its window (PayoutPending is an OPEN state)", async () => {
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = await deposit(rid(61), DEPOSIT_AMOUNT, deadline);
    await beginPayout(rid(61), escrowState, fiatRef(1));

    await warpTo(deadline + PAYOUT_EXTENSION_SECS - 1n);
    await release(rid(61), escrowState, vault);
    expect(await tokenBalance(beneficiaryAta)).to.equal(DEPOSIT_AMOUNT);
    expect(await statusOf(escrowState)).to.equal("released");
  });

  it("C11. the event carries the opaque fiat_ref and BOTH deadlines (attribution, not proof)", async () => {
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState } = await deposit(rid(62), DEPOSIT_AMOUNT, deadline);
    const ref = fiatRef(0x5c);

    const meta = await beginPayoutWithMeta(rid(62), escrowState, ref);
    const events = decodeEvents(meta);
    const begun = events.find((e) => e.name === "payoutBegun" || e.name === "PayoutBegun");
    assert.isDefined(begun, "begin_payout must emit its event");

    expect(Array.from(begun.data.fiatRef as number[])).to.deep.equal(ref);
    expect(BigInt(begun.data.oldDeadline.toString())).to.equal(deadline);
    expect(BigInt(begun.data.newDeadline.toString())).to.equal(
      deadline + PAYOUT_EXTENSION_SECS
    );
    expect(begun.data.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(begun.data.escrow.toBase58()).to.equal(escrowState.toBase58());
  });

  it("C12. front-running the freeze with a refund changes nothing: whoever arrives first, only one gets in", async () => {
    const deadline = nowTs + FIXTURE_TTL;
    const a = await deposit(rid(63), DEPOSIT_AMOUNT, deadline);
    const b = await deposit(rid(64), DEPOSIT_AMOUNT, deadline);

    // before the deadline: the sender's refund is the one that bounces
    await warpTo(deadline - 1n);
    await expectRevert(refund(rid(63), a.escrowState, a.vault), "DeadlineNotReached");
    await beginPayout(rid(63), a.escrowState, fiatRef(1));

    // at or after the deadline: the freeze is the one that bounces
    await warpTo(deadline);
    await expectRevert(
      beginPayout(rid(64), b.escrowState, fiatRef(1)),
      "ReleaseWindowClosed"
    );
    await refund(rid(64), b.escrowState, b.vault);
    expect(await statusOf(b.escrowState)).to.equal("refunded");
  });

  // =========================================================================
  // D. close: whitelist of terminal states, and the vault dust
  // =========================================================================

  it("D1. dust donated to the vault after the release no longer bricks the close: it is swept to the sender", async () => {
    const DUST = 1n; // one atomic unit, the cheapest possible denial of service
    const { escrowState, vault } = await deposit(rid(70), DEPOSIT_AMOUNT, nowTs + FIXTURE_TTL);
    await release(rid(70), escrowState, vault);
    expect(await tokenBalance(vault)).to.equal(0n);

    // anybody can do this: the vault is an ATA with a derivable address
    await processIxs(
      [
        createTransferInstruction(
          senderAta,
          vault,
          sender.publicKey,
          DUST,
          [],
          TOKEN_PROGRAM_ID
        ),
      ],
      [sender]
    );
    expect(await tokenBalance(vault)).to.equal(DUST);

    const before = await tokenBalance(senderAta);
    await close(rid(70), escrowState, vault);

    // the dust came back, and both accounts are gone (their rent is not dead)
    expect(await tokenBalance(senderAta)).to.equal(before + DUST);
    expect(await tokenBalance(vault)).to.equal(-1n);
    expect(await context.banksClient.getAccount(escrowState)).to.equal(null);
  });

  it("D1b. the same holds after a refund: dust does not turn the close into a dead end", async () => {
    const DUST = 3n;
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = await deposit(rid(71), DEPOSIT_AMOUNT, deadline);
    await warpTo(deadline);
    await refund(rid(71), escrowState, vault);

    await processIxs(
      [
        createTransferInstruction(
          senderAta,
          vault,
          sender.publicKey,
          DUST,
          [],
          TOKEN_PROGRAM_ID
        ),
      ],
      [sender]
    );

    const before = await tokenBalance(senderAta);
    await close(rid(71), escrowState, vault);
    expect(await tokenBalance(senderAta)).to.equal(before + DUST);
    expect(await context.banksClient.getAccount(escrowState)).to.equal(null);
  });

  it("D2. a FROZEN escrow cannot be closed, and the guard that says so is ours (EscrowNotTerminal)", async () => {
    // MASKED GUARD WARNING. With the vault full, the one rejecting this close would be SPL
    // (CloseAccount demands a zero balance) and our own whitelist would never be evaluated: the
    // test would pass while the guard was gone. So the vault is forced to zero first, which is the
    // only arrangement where a `!= Deposited` written instead of the whitelist shows up.
    const { escrowState, vault } = await deposit(rid(72), DEPOSIT_AMOUNT, nowTs + FIXTURE_TTL);
    await beginPayout(rid(72), escrowState, fiatRef(1));

    const raw = await context.banksClient.getAccount(vault);
    assert.isNotNull(raw, "the vault must exist");
    const data = Buffer.from(raw!.data);
    data.writeBigUInt64LE(0n, 64); // SPL token account layout: mint(32) + owner(32) + amount(8)
    context.setAccount(vault, {
      lamports: raw!.lamports,
      data: new Uint8Array(data),
      owner: raw!.owner,
      executable: raw!.executable,
      rentEpoch: raw!.rentEpoch,
    });
    expect(await tokenBalance(vault)).to.equal(0n);

    await expectRevert(close(rid(72), escrowState, vault), "EscrowNotTerminal");
    // still there, still frozen, still refundable when its extended deadline lands
    expect(await statusOf(escrowState)).to.equal("payoutPending");
  });
});
