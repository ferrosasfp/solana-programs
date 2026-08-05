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
// The two numbers, RE-DECLARED here on purpose
// ---------------------------------------------------------------------------
//
// These are independent literals, NOT imported from the program and NOT recomputed from its
// formula. That is deliberate and it is the whole value of this file: a test that asked the program
// for its own constant would keep passing after someone divided the floor by ten. It would be a
// guard comparing itself against itself.
//
// So: if these drift from programs/escrow/src/lib.rs, this suite goes RED. That is the intended
// behaviour, not a maintenance annoyance. Changing the program's numbers means coming here and
// typing the new ones by hand, which is exactly the moment where somebody has to look at them.
const MIN_CUSTODY_SECS = 3_600n; // 1 h, provisional (see lib.rs)
const MAX_CUSTODY_SECS = 86_400n; // 24 h, provisional (see lib.rs)

// Fixture deadline well inside the window and far from both edges.
const FIXTURE_TTL = 7_200n;

describe("escrow-window — the custody window and the status guard", () => {
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

  // Anybody can do this: the vault is an ATA at a derivable address and nothing stops a transfer
  // into it. It is what makes the "refilled vault" tests below possible, and it is also what the
  // off-chain facilitator tolerates by design (it accepts `vaultAmount >= amount`).
  async function donateToVault(vault: PublicKey, amount: bigint) {
    await processIxs(
      [
        createTransferInstruction(
          senderAta,
          vault,
          sender.publicKey,
          amount,
          [],
          TOKEN_PROGRAM_ID
        ),
      ],
      [sender]
    );
  }

  function close(
    remittanceId: Uint8Array,
    escrowState: PublicKey,
    vault: PublicKey,
    // Default null = the production path: this suite's sender never calls register_escrow, so its
    // index PDA does not exist. The key is ALWAYS present in the accounts object (CD-14): omitting
    // it would make the client derive the PDA from the IDL seeds and send it, reverting with 3012.
    escrowIndex: PublicKey | null = null
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
        escrowIndex,
      })
      .signers([sender])
      .rpc();
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
  // C. The status guard, attacked with the vault REFILLED
  //
  //   From a terminal state, neither `release` nor `refund` may move a token.
  //
  // Why the vault has to be refilled for these to mean anything: after a
  // terminal transition the vault is empty, so a test that just retries the
  // instruction is proven by SPL (a transfer out of an empty account fails),
  // not by our guard. The vault is an associated token account at a derivable
  // address, so ANYBODY can put tokens back into it, and the off-chain
  // facilitator tolerates exactly that: it accepts `vaultAmount >= amount`
  // (wasiai-facilitator/src/chains/solana-escrow.ts:202-212). So the refilled
  // vault is not a contrived arrangement, it is the reachable one, and it is
  // the only arrangement where deleting the status check shows up as money
  // moving twice instead of as a different error string.
  // =========================================================================

  it("C1. a second release, with the vault REFILLED, reverts (EscrowNotDeposited): the beneficiary is not paid twice", async () => {
    // MASKED GUARD WARNING. With the vault left empty the rejection comes from SPL, so this test
    // deliberately puts the full amount back before retrying. The clock is inside the window, so
    // `ReleaseWindowClosed` cannot be the one answering either: the status check is alone.
    const id = rid(50);
    const { escrowState, vault } = await deposit(id, DEPOSIT_AMOUNT, nowTs + FIXTURE_TTL);
    await release(id, escrowState, vault);
    expect(await tokenBalance(vault)).to.equal(0n);
    expect(await tokenBalance(beneficiaryAta)).to.equal(DEPOSIT_AMOUNT);

    await donateToVault(vault, DEPOSIT_AMOUNT);
    expect(await tokenBalance(vault)).to.equal(DEPOSIT_AMOUNT);

    await bumpSlot(); // identical tx shape: without a fresh blockhash bankrun dedups it by signature
    await expectRevert(release(id, escrowState, vault), "EscrowNotDeposited");

    // the money did not move: this is the assertion that a missing guard would break
    expect(await tokenBalance(beneficiaryAta)).to.equal(DEPOSIT_AMOUNT);
    expect(await tokenBalance(vault)).to.equal(DEPOSIT_AMOUNT);
    expect(await statusOf(escrowState)).to.equal("released");
  });

  it("C2. a refund on a RELEASED escrow, with the vault refilled and the deadline passed, reverts (EscrowNotDeposited)", async () => {
    // The gap this closes: the refund's status check was the only guard in the whole custody
    // window change that became MORE permissive, and no suite ever tried a refund from a terminal
    // state. Here both of the guards that could mask it are satisfied on purpose — the deadline
    // has passed, so `DeadlineNotReached` cannot answer, and the vault is full, so SPL would pay.
    const id = rid(51);
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = await deposit(id, DEPOSIT_AMOUNT, deadline);
    await release(id, escrowState, vault);
    await donateToVault(vault, DEPOSIT_AMOUNT);
    await warpTo(deadline);

    const before = await tokenBalance(senderAta);
    await expectRevert(refund(id, escrowState, vault), "EscrowNotDeposited");
    expect(await tokenBalance(senderAta)).to.equal(before);
    expect(await tokenBalance(vault)).to.equal(DEPOSIT_AMOUNT);
    expect(await statusOf(escrowState)).to.equal("released");
  });

  it("C3. a second refund, with the vault refilled, reverts (EscrowNotDeposited): the sender cannot be paid twice either", async () => {
    const id = rid(52);
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = await deposit(id, DEPOSIT_AMOUNT, deadline);
    await warpTo(deadline);
    await refund(id, escrowState, vault);
    expect(await statusOf(escrowState)).to.equal("refunded");

    await donateToVault(vault, DEPOSIT_AMOUNT);
    const before = await tokenBalance(senderAta);

    await bumpSlot();
    await expectRevert(refund(id, escrowState, vault), "EscrowNotDeposited");
    expect(await tokenBalance(senderAta)).to.equal(before);
    expect(await tokenBalance(vault)).to.equal(DEPOSIT_AMOUNT);
  });

  it("C4. a release on a REFUNDED escrow whose window is still open reverts (EscrowNotDeposited)", async () => {
    // The one combination the program's own transitions cannot reach: `Refunded` needs
    // `now >= deadline` and `release` needs `now < deadline`. So the account is planted by hand in
    // the on-chain layout, which is the only arrangement that leaves the status check alone —
    // the clock guard passes, and the vault is funded, so SPL would pay the beneficiary.
    const id = rid(53);
    const escrowState = await plantLegacyEscrow(id, 2, nowTs + FIXTURE_TTL);
    const vault = await createAta(escrowState);
    await mintTo(vault, DEPOSIT_AMOUNT);
    expect(await tokenBalance(vault)).to.equal(DEPOSIT_AMOUNT);

    await expectRevert(release(id, escrowState, vault), "EscrowNotDeposited");
    expect(await tokenBalance(vault)).to.equal(DEPOSIT_AMOUNT);
    expect(await tokenBalance(beneficiaryAta)).to.equal(0n);
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

  it("D2. a LIVE escrow cannot be closed, and with the sweep in place that whitelist is the only thing stopping an early exit", async () => {
    // MASKED GUARD WARNING, read backwards. Before the sweep existed, a close on a live escrow was
    // rejected by SPL, because `CloseAccount` refuses a non-empty account, and the whitelist was
    // never reached. The sweep changed that: it empties the vault into the sender's OWN ata before
    // closing, so SPL no longer objects to anything. With the whitelist deleted, this very call
    // would hand the sender the whole principal back BEFORE the deadline, which is the release
    // window collapsing. So the vault is deliberately left FULL, and the balances are asserted.
    const deadline = nowTs + FIXTURE_TTL;
    const { escrowState, vault } = await deposit(rid(72), DEPOSIT_AMOUNT, deadline);
    const before = await tokenBalance(senderAta);

    await expectRevert(close(rid(72), escrowState, vault), "EscrowNotTerminal");

    expect(await tokenBalance(vault)).to.equal(DEPOSIT_AMOUNT);
    expect(await tokenBalance(senderAta)).to.equal(before);
    expect(await statusOf(escrowState)).to.equal("deposited");
    assert.isNotNull(
      await context.banksClient.getAccount(escrowState),
      "the live escrow must still be there"
    );
  });

  // =========================================================================
  // E. The status byte of accounts that are ALREADY LIVE
  //
  // Why this exists: the legacy test in escrow-index.ts hand-builds an account with status byte 0
  // and refunds it, which proves the SIZE and the offsets survived. It does not prove the
  // DISCRIMINANTS survived, because byte 0 stays byte 0 no matter where a new variant is inserted.
  // Inserting a variant in the middle of the enum keeps that test green while silently turning
  // every live `Released` account into something else. Found by mutating it.
  //
  // E1b adds the other half: the enum has EXACTLY three variants, and that count is a contract
  // with the off-chain consumers, not an internal detail.
  // =========================================================================

  const ESCROW_STATE_SIZE = 154;
  const ESCROW_STATE_DISCRIMINATOR: number[] = (idl as any).accounts.find(
    (a: any) => a.name === "EscrowState"
  ).discriminator;

  // Bytes assembled BY HAND in the on-chain layout, not written by this program.
  async function plantLegacyEscrow(
    id: Uint8Array,
    statusByte: number,
    deadline: bigint
  ): Promise<PublicKey> {
    const [escrowState, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), sender.publicKey.toBuffer(), Buffer.from(id)],
      program.programId
    );
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
    buf.writeUInt8(statusByte, o);
    o += 1;
    buf.writeUInt8(bump, o);
    o += 1;
    assert.equal(o, ESCROW_STATE_SIZE, "the layout must fill exactly 154 bytes");

    context.setAccount(escrowState, {
      lamports: await provider.connection.getMinimumBalanceForRentExemption(
        ESCROW_STATE_SIZE
      ),
      data: new Uint8Array(buf),
      owner: program.programId,
      executable: false,
      rentEpoch: 0,
    });
    return escrowState;
  }

  it("E1. the status byte means the same thing it always meant: 0, 1 and 2 keep their names", async () => {
    const expected: [number, string][] = [
      [0, "deposited"],
      [1, "released"],
      [2, "refunded"],
    ];
    for (const [byte, name] of expected) {
      const state = await plantLegacyEscrow(rid(80 + byte), byte, nowTs + FIXTURE_TTL);
      expect(await statusOf(state), `status byte ${byte}`).to.equal(name);
    }
  });

  it("E1b. a status byte of 3 does NOT decode: the enum has exactly three variants and that is a contract with the consumers", async () => {
    // THIS TEST IS A TRIPWIRE, and it is supposed to go red the day a fourth variant lands.
    // chaski-v3 (src/infrastructure/solana/escrow-idl.ts:497) and the facilitator pin an IDL whose
    // EscrowStatus has exactly Deposited/Released/Refunded. A byte of 3 on chain makes their
    // BorshAccountsCoder throw a TypeError, and in chaski-v3 the `coder.decode` of `refundEscrow`
    // (src/infrastructure/solana-wallet.ts:352) is not inside a try, so the sender would be left
    // unable to recover the funds from the product. Shipping a fourth variant therefore requires
    // both consumers to publish the 4-variant IDL and handle the new state FIRST. When that day
    // comes, update this test in the same change, do not delete it.
    const state = await plantLegacyEscrow(rid(95), 3, nowTs + FIXTURE_TTL);

    let threw = false;
    try {
      await statusOf(state);
    } catch (_) {
      threw = true;
    }
    expect(
      threw,
      "a status byte outside the enum must fail to decode, not decode as something else"
    ).to.equal(true);

    // and the program itself refuses to load it, so such an account is inert rather than ambiguous
    const vault = await createAta(state);
    await mintTo(vault, DEPOSIT_AMOUNT);
    await expectRevert(release(rid(95), state, vault), "AccountDidNotDeserialize");
  });

  it("E2. an account already sitting on chain as Released is still closable (its byte was not re-pointed)", async () => {
    // The behavioural half of E1: a live `Released` account must still be TERMINAL for this
    // program. If the new variant had been inserted in the middle, byte 1 would now decode as a
    // non terminal state and this close would revert instead of returning the rent.
    const id = rid(90);
    const escrowState = await plantLegacyEscrow(id, 1, nowTs + FIXTURE_TTL);
    const vault = await createAta(escrowState); // empty vault, as a released escrow's vault is

    await close(id, escrowState, vault);
    expect(await context.banksClient.getAccount(escrowState)).to.equal(null);
    expect(await tokenBalance(vault)).to.equal(-1n);
  });

  it("E3. an account already sitting on chain as Refunded is still closable too", async () => {
    const id = rid(91);
    const escrowState = await plantLegacyEscrow(id, 2, nowTs + FIXTURE_TTL);
    const vault = await createAta(escrowState);

    await close(id, escrowState, vault);
    expect(await context.banksClient.getAccount(escrowState)).to.equal(null);
  });
});
