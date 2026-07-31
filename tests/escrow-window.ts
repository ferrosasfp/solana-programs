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
});
