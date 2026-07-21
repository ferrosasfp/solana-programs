# escrow — WasiAI trustless USDC escrow (Solana / Anchor)

Greenfield Anchor program that implements a trustless USDC escrow on Solana. It mirrors the
security properties of the EVM `WasiAIEscrow.sol` (terminal state machine, fixed destination,
checks-effects-interactions) using native Solana primitives (PDA state account, vault ATA owned
by the PDA, PDA-signed CPI transfers).

- **WKH-215 / HU-SOL-12** — Sprint 1 critical path (HU-SOL-13 and HU-SOL-14 depend on this
  program deployed to devnet).
- Program id (devnet): `BBQ9TcriBT7tqe5czR72CkUyxYg6z8pH7nk161yh79WA`

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
   returned to `sender`. `init` (never `init_if_needed`) means the seeds are only reusable via a
   fresh, clean deposit (no revival of stale state).

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
and is recorded in `escrow_state.mint`. The canonical devnet reference is Circle USDC devnet
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, supplied via config/env at deploy/integration
time. Unit tests use a synthetic local 6-decimal SPL mint (Circle USDC cannot be minted inside
bankrun).

### CD-6 — front-run mitigation (documented; enforced in HU-SOL-13)

The TransFi cashout order must be created **only after** the `release` transaction is
**finalized** on-chain. That flow guard is implemented by the business layer in HU-SOL-13; this
program only provides the terminal `release` state transition.

### CD-7 — upgrade authority (documented; handled in HU-SOL-19)

The devnet deploy leaves the upgrade authority in the deployer EOA. Before any mainnet deploy the
authority must migrate to a multisig/timelock, or the program must be deployed with
`solana program deploy --final` post-audit (HU-SOL-19). This is out of scope here (devnet only,
CD-5).
