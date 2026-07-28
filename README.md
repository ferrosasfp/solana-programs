# escrow — WasiAI trustless USDC escrow (Solana / Anchor)

Greenfield Anchor program that implements a trustless USDC escrow on Solana. It mirrors the
security properties of the EVM `WasiAIEscrow.sol` (terminal state machine, fixed destination,
checks-effects-interactions) using native Solana primitives (PDA state account, vault ATA owned
by the PDA, PDA-signed CPI transfers).

- **WKH-215 / HU-SOL-12** — Sprint 1 critical path (HU-SOL-13 and HU-SOL-14 depend on this
  program deployed to devnet).
- **Program id (devnet, DEPLOYED)**: `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`
  - Single source of truth: `declare_id!` in `programs/escrow/src/lib.rs:5`, `[programs.devnet]`
    in `Anchor.toml`, and `address` in `target/idl/escrow.json`. All three agree. If you need the
    program id in code, read `idl.address`, never a copy-pasted literal.
  - Verified on devnet: the account exists and is `executable`, owner
    `BPFLoaderUpgradeab1e11111111111111111111111`, programData
    `UKjCxFASvoGPp95tdPDH2F3vyyGnQLHAcKiUGpVDpaR`, upgrade authority
    `4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH` (the devnet fee-payer EOA, see CD-7 below).
  - ⚠️ **`BBQ9TcriBT7tqe5czR72CkUyxYg6z8pH7nk161yh79WA` is NOT this program.** It was the
    ephemeral placeholder id from the HU-SOL-12 spec phase, it **was never deployed** (a
    `getAccountInfo` on devnet returns `null`) and **its keypair was lost**, so it can never be
    deployed. It appears in the frozen `doc/sdd/001-escrow-anchor/*` artifacts as a historical
    record only. Any live config, runbook or env that still points at `BBQ9…79WA` is a bug:
    replace it with `DR5G…SE4x`.

## Flow

1. `deposit(remittance_id, beneficiary, authority, amount, deadline)` — the `sender` locks
   `amount` USDC into a vault ATA whose authority is the `escrow_state` PDA. `beneficiary`,
   `authority`, `mint`, `amount` and `deadline` are recorded and immutable.
2. Terminal, mutually-exclusive exits:
   - `release(remittance_id)` — the recorded `authority` (facilitator) pays the vault balance
     **always** to the ATA of the recorded `beneficiary` (destination is constraint-validated,
     never a caller-supplied account).
   - `refund(remittance_id)` — after `deadline`, the `sender` alone recovers the funds. No
     dependency on the `authority` signing or being available.
3. `close(remittance_id)` — once in a terminal state, rent for `escrow_state` and the vault is
   returned to `sender`. `escrow_state` and the vault are created with plain `init` (**never**
   `init_if_needed`), so those seeds are only reusable via a fresh, clean deposit (no revival of
   stale state).

### Recovering an escrow whose `remittanceId` was lost (HU-SOL-20)

`escrow_state` is derived from `["escrow", sender, remittance_id16]` and those 16 bytes are **not
stored in the account**. Losing them used to make the funds unreachable even for the `sender`.
Two instructions add an enumerable per-sender index so the id can be read back from the chain:

4. `register_escrow(remittance_id)` — records `remittance_id` in `EscrowIndex`, a PDA derived from
   `["escrow-index", sender]`, i.e. derivable knowing **only the sender's own address**. Requires
   the escrow to exist, to belong to the signing `sender` (seeds) and to still be `Deposited`, so
   the index only ever lists **open** escrows. Moves **zero** tokens. Idempotent: re-registering the
   same id neither duplicates nor reverts. Capped at `MAX_ENTRIES = 32`; the 33rd reverts with
   `EscrowIndexFull` (6005).
5. `deregister_escrow(remittance_id)` — removes one id from the caller's own index. Idempotent
   no-op if absent, moves no tokens, and deliberately does **not** require a terminal state (that
   would make entries of already-closed escrows impossible to clean up).

Recovery path: derive `["escrow-index", sender]`, one `getAccountInfo`, read `entries`, then derive
`["escrow", sender, entries[i]]` and call the existing `refund`. The `authority`/arbiter is **not**
a party to either new instruction and gains no power over the funds.

`EscrowIndex` is the **only** account created with `init_if_needed`. It is safe against
re-initialization because it custodies no funds, its seeds bind it to the signing `sender`, and
every header write in the handler is idempotent — nothing ever resets `entries`.

> **`EscrowState` is deliberately never modified.** Live accounts are exactly **154 bytes**; adding
> a field would keep the discriminator (it hashes only the struct *name*) but break borsh
> deserialization of every existing account, bricking `release`/`refund`/`close` with
> `AccountDidNotDeserialize` (3003) — i.e. it would make reachable funds unreachable. Test `1a` in
> `tests/escrow.ts` is a permanent canary on that 154-byte size: **do not delete or relax it.**

## Toolchain

- rustc pinned by `rust-toolchain.toml`
- solana-cli (Agave) `3.1.10`
- anchor-cli `1.1.2`

## Build & test

```bash
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
anchor build
# Tests use anchor-bankrun (deterministic Clock control, in-process, no validator):
anchor test --skip-deploy --skip-local-validator
```

## Deploy (devnet only)

```bash
./scripts/deploy-devnet.sh
```

## Operational notes

### Mint (USDC) — env-driven, never hardcoded

The USDC mint is **not** hardcoded in `lib.rs`; it enters each instruction as the `mint` account
and is recorded in `escrow_state.mint`. It is supplied via config/env at deploy/integration time.

Three different mints show up around this program, do not mix them up:

| Mint | What it is | Where it is used |
|------|-----------|------------------|
| `8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q` | **The mint the devnet escrow actually runs on.** Own 6-decimal test mint, mint authority `4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH` (the devnet fee-payer), so we can mint test balances at will. | Every devnet exercise of this program (deposit / release / refund). It is the value of `SOLANA_USDC_MINT` (facilitator) and `NEXT_PUBLIC_SOLANA_USDC_MINT` (chaski) in the devnet setup. |
| `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Circle's USDC devnet mint (6 decimals, mint authority `GrNg1XM2ctzeE2mXxXCfhcTUbejM8Z4z4wNVTy2FjMEz`, i.e. **not ours, we cannot mint it**). Documented **reference** value only. | Nothing on-chain here. It is the `canonicalUsdcMint` reference constant in chaski and the `.env.example` comment. Do **not** assume the escrow holds this mint. |
| synthetic local mint | Created per test run inside `anchor-bankrun` (no external mint is reachable in-process). | Unit tests only. |

Both devnet mints above were read on-chain when this table was written (`getAccountInfo` with
`jsonParsed`); the escrow state accounts on devnet record `8yRX3f…wz3Q` in `escrow_state.mint`.

### CD-6 — front-run mitigation (documented; enforced in HU-SOL-13)

The TransFi cashout order must be created **only after** the `release` transaction is
**finalized** on-chain. That flow guard is implemented by the business layer in HU-SOL-13; this
program only provides the terminal `release` state transition.

### CD-7 — upgrade authority (documented; handled in HU-SOL-19)

The devnet deploy leaves the upgrade authority in the deployer EOA. Before any mainnet deploy the
authority must migrate to a multisig/timelock, or the program must be deployed with
`solana program deploy --final` post-audit (HU-SOL-19). This is out of scope here (devnet only,
CD-5).
