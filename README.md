# escrow

A non-custodial USDC escrow program for Solana, written in Anchor.

## Why it exists

A remittance flow has a moment where money is in flight: the sender has paid, and the
beneficiary has not been paid yet. The usual way to bridge that moment is for the operator to
hold the funds. We did not want to build that.

This program holds them instead. Funds sit in a token account whose authority is a program
derived address, so the operator can never move them anywhere the sender did not choose, and
if the operator disappears the sender can still get the money back without anyone's help.

The program is the on-chain half of a larger system. This repository contains only the program,
its tests and its deploy script.

## Status, honestly

This is a project under implementation, not a finished product.

| | |
|---|---|
| Deployed | Solana **devnet** only. No mainnet deployment exists. |
| Source vs deployed | **They differ right now.** The custody window described below (release deadline, `begin_payout`, `abort_payout`, the dust sweep) is in this source and **has not been deployed**. The deployed devnet binary is still the previous one, and the hashes in [Deployment](#deployment) describe that older binary, not a build of this tree. |
| Money at risk | None. Devnet, with a test mint we control. |
| Upgrade authority | **Present.** The program is deployed under the upgradeable loader and its authority is a single devnet key. See [Upgrade authority](#upgrade-authority). |
| External audit | **None.** The program has not been reviewed by a third party security firm. |
| Test coverage | 49 tests, all passing locally. Behaviour driven, no fuzzing and no formal verification. |
| CI | The workflow exists and is currently **failing**, at the tool install step, before it reaches the program. See [Continuous integration](#continuous-integration). |
| Reproducible build | The mechanism is in place and **has never run on a clean machine**. The hashes below are published so you can try it yourself and tell us if it does not. See [Reproducing the deployed binary](#reproducing-the-deployed-binary). |
| Known issues | Written down below, none of them about custody. See [Known limitations](#known-limitations). |

What we do claim: the custody properties below are enforced by account constraints, and each one
has a test that tries to break it. What we do not claim: that an audit would find nothing.

## Deployment

**Program id:** `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x` (devnet)

[View on Solana Explorer](https://explorer.solana.com/address/DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x?cluster=devnet)

Read on devnet at the time of writing:

| Field | Value |
|-------|-------|
| Owner | `BPFLoaderUpgradeab1e11111111111111111111111` |
| Executable | yes |
| ProgramData account | `UKjCxFASvoGPp95tdPDH2F3vyyGnQLHAcKiUGpVDpaR` |
| Upgrade authority | `4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH` |
| Last deployed in slot | `479522576` |
| Deployed bytes | 262568 |
| `sha256` of the deployed bytes (`artifact-sha256`) | `dc0ba21a5a620ef5dd1546c2c9e86eb6d00f9ca438e97bb4e2a5fa09819a8960` |
| `sha256` of the same bytes without trailing padding (`verify-hash`) | `2c012e78a567584978e48fe1b20cd641d03389ae2e5944402d31eaa548e29779` |

Two hashes, one binary, and they do not agree. That is expected, not a discrepancy:
`sha256sum` on the `.so` hashes every byte, while `solana-verify` strips trailing zero bytes
first. The escrow binary ends in 15 zero bytes, so the two conventions land on different
values. Whichever tool you use, compare against the row that matches it.

Verify it yourself, no keypair, no toolchain, no Docker, nothing to install:

```bash
python3 scripts/onchain-hash.py --program-id DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x --url devnet
```

It reads the program account, follows it to the ProgramData account, and prints both hashes
along with the deployed slot and the upgrade authority. Standard library only, no packages.
Give it `--expect-artifact-sha256` and `--expect-verify-hash` and it exits non-zero when the
chain stops matching what this file claims.

The equivalent with the Solana CLI, if you already have it:

```bash
solana program show DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x --url devnet
solana program dump DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x /tmp/onchain.so --url devnet
sha256sum /tmp/onchain.so
```

That tells you what is deployed. It does not tell you the deployed bytes came from this
source. For that, see [Reproducing the deployed binary](#reproducing-the-deployed-binary).

The program id has a single source of truth, `declare_id!` in
[`programs/escrow/src/lib.rs:5`](programs/escrow/src/lib.rs#L5), mirrored in `Anchor.toml` and in
the generated IDL. If you need it in client code, read `idl.address` rather than copying the
literal.

### Live traffic on devnet

The full lifecycle has been exercised against the deployed program with a real SPL mint:

| Instruction | Transaction | What moved |
|-------------|-------------|------------|
| `deposit` | [`3y6qK6uU…bAMs`](https://explorer.solana.com/tx/3y6qK6uUpYBRxGbZqbUnav4fVhMbYyyaTD8AGL3KgrvdzkeGBBqRxgE7S9LPac7HVAeBVbZkqgdcUByBtVN3bAMs?cluster=devnet) | 10 tokens, sender to a fresh vault |
| `release` | [`e9sPYcaD…8fwu`](https://explorer.solana.com/tx/e9sPYcaDivBXdsv4yNAZ9YsYg3efNXx8HqafYyM1nPUuxWqNDt8bqR7vuy4gGsv1cLXHHrzGfJ1xpmsbhFP8fwu?cluster=devnet) | vault 10 to 0, beneficiary 0 to 10 |
| `refund` | [`4GDwrHgs…yikk`](https://explorer.solana.com/tx/4GDwrHgsu2kcJub8A2r8Nh5oRU5uA6DYqXgGoFKG1H9Nw9oYyPC5ooYWR9AAusLjhG1u4tCp5fSWo5DSgkkhyikk?cluster=devnet) | vault 1 to 0, back to the sender |

The two index instructions are deployed but have not been called on chain yet, so there are no
`EscrowIndex` accounts on devnet. Their behaviour is covered by the test suite only.

## Reproducing the deployed binary

Everything above tells you what is on chain. This section is about the harder claim: that those
bytes were produced by the source in this repository, and that you can produce them too.

### What you can check right now

> **These hashes describe the binary deployed on devnet, which predates the custody window.** A
> build of this tree will not match them, on purpose: the source is ahead of the chain and the
> upgrade has not been performed. To reproduce the deployed bytes, check out the commit before the
> custody window landed.

```bash
git clone https://github.com/ferrosasfp/solana-programs
cd solana-programs
cargo install solana-verify --locked          # or grab the release binary
solana-verify build --library-name escrow     # needs Docker, takes a while
solana-verify get-executable-hash target/deploy/escrow.so
solana-verify -u https://api.devnet.solana.com get-program-hash DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x
```

The last two commands must both print:

```
2c012e78a567584978e48fe1b20cd641d03389ae2e5944402d31eaa548e29779
```

and `sha256sum target/deploy/escrow.so` must print
`dc0ba21a5a620ef5dd1546c2c9e86eb6d00f9ca438e97bb4e2a5fa09819a8960`.

`-u` has to come before the subcommand. It is a global argument read from the top level, and
placed after `get-program-hash` the tool quietly falls back to mainnet, where this program does
not exist.

### What we have and have not confirmed

| | |
|---|---|
| The deployed bytes equal our local `target/deploy/escrow.so` | **Confirmed**, byte for byte, on the machine that built and deployed it. |
| The binary carries no path from that machine | **Confirmed.** The only absolute path embedded is inside the precompiled platform-tools, identical for everyone using the same Agave version. |
| A container rebuild reproduces those bytes | **Not confirmed.** The workflow that would prove it has never completed a run. |
| An independent third party reproduced it | **Not confirmed.** Nobody outside this project has tried yet. |

So: we are not claiming a reproducible build. We are claiming that the mechanism to check one is
wired up and public, and that if it does not reproduce on your machine, that is a finding we want
to hear about rather than one we have quietly avoided testing.

### Why the build image had to be declared

`solana-verify` picks the Docker image from `[workspace.metadata.cli] solana` in the root
`Cargo.toml`, and only falls back to `Cargo.lock` when that key is absent. The fallback is wrong
for this repository: Anchor 1.x does not depend on `solana-program`, so the lock resolves through
`solana-program-error 3.0.1` and the tool would build with the 3.0.1 image. The deployed bytes
came out of Agave 3.1.10, a different platform-tools, so the comparison would fail for a reason
that has nothing to do with the source. The key is set to `3.1.10`
([`Cargo.toml:20`](Cargo.toml#L20)) and has to move together with `rust-toolchain.toml`, the
workflows, and the Toolchain table below.

## Flow

The deadline splits time into two windows that do not overlap:

```
   deposit                      deadline                     deadline + extension
      |------------------------------|----------------------------------|
      |        release ONLY          |           refund ONLY            |
      |        (now <  deadline)     |           (now >= deadline)      |
```

```
deposit ──> Deposited ──┬── begin_payout ──> PayoutPending ──┬── release ──> Released ──┐
                        │        (once, +1 h)     │          │                          ├── close
                        │                         └─ abort_payout ─> Deposited          │
                        ├── release ──> Released  ─────────────────────────────────────>┤
                        └── refund  ──> Refunded  ─────────────────────────────────────>┘
                            (only from the deadline on)
```

1. **`deposit(remittance_id, beneficiary, authority, amount, deadline)`**
   The sender locks `amount` into a vault. The beneficiary, the releasing authority, the mint,
   the amount and the deadline are written to the state account. The deadline has to fall inside
   the custody window, between one hour and twenty four hours from now.

2. Exactly one terminal exit, and they are mutually exclusive **at every instant**, because they
   read the same clock and the same field with complementary comparisons:
   - **`release(remittance_id)`** the recorded authority pays the recorded beneficiary, and only
     before the deadline. The destination is validated by constraint, it is not a caller supplied
     account.
   - **`refund(remittance_id)`** from the deadline on, the sender alone recovers the funds. The
     authority is not part of this instruction at all.

3. **`begin_payout(remittance_id, fiat_ref)`** the authority moves the deadline forward by one
   hour, once, and only if it arrives before the deadline. It moves no tokens and it cannot revoke
   a refund that already vested. **`abort_payout(remittance_id)`** undoes it by parking the
   deadline at `now`, which enables the sender's refund immediately.

4. **`close(remittance_id)`** once terminal, rent for the state account and the vault goes back
   to the sender, and any residual token balance in the vault is swept to the sender first.

### Recovering an escrow whose id was lost

The state account is derived from `["escrow", sender, remittance_id]` and those 16 bytes are not
stored on chain. Losing them used to make the funds unreachable even for the sender, who had the
right to refund but no way to name the account. Two instructions add a per sender index so the id
can be read back from the chain:

5. **`register_escrow(remittance_id)`** records the id in an `EscrowIndex` account derived from
   `["escrow-index", sender]`, that is, derivable knowing only the sender's own address. It
   requires the escrow to exist, to belong to the signing sender, and to still be open, so the
   index only ever lists live escrows. It moves zero tokens. Re-registering the same id neither
   duplicates nor reverts.

6. **`deregister_escrow(remittance_id)`** removes one id from the caller's own index. It is a
   no op if the id is absent, it moves no tokens, and it deliberately does not require a terminal
   state: requiring one would make entries of already closed escrows impossible to clean up.

Recovery path: derive `["escrow-index", sender]`, one `getAccountInfo`, read `entries`, then
derive `["escrow", sender, entries[i]]` and call the normal `refund`. The authority is not a
party to either instruction and gains no power over the funds.

## Instructions

| Instruction | Signer | Effect | Guards |
|-------------|--------|--------|--------|
| `deposit` | sender | creates state + vault, pulls `amount` in | `amount > 0`; `now + 1 h <= deadline <= now + 24 h` |
| `release` | recorded authority | pays the recorded beneficiary | `has_one` on authority, beneficiary, sender, mint; status open (`Deposited` or `PayoutPending`); **`now < deadline`** |
| `refund` | sender | pays the sender back | `has_one` on sender and mint; status open; `now >= deadline` |
| `begin_payout` | recorded authority | moves the deadline forward by 1 h, once | `has_one` on authority and sender; status `Deposited`; `now < deadline`. Moves no tokens |
| `abort_payout` | recorded authority | parks the deadline at `now` | `has_one` on authority and sender; status `PayoutPending`. Moves no tokens |
| `close` | sender | sweeps the vault to the sender, closes state + vault, rent to sender | status in `{Released, Refunded}` |
| `register_escrow` | sender | adds an id to the sender's index | escrow belongs to signer and is `Deposited`; index not full |
| `deregister_escrow` | sender | removes an id from the sender's index | index PDA is seeded by the signer |

States: `Deposited` (0), `Released` (1, terminal), `Refunded` (2, terminal), `PayoutPending` (3,
**not** terminal: the funds are there and the sender can still recover them). The new variant is
appended at the end because 0, 1 and 2 are already written in live accounts, and it is a unit
variant, so `EscrowState` stays at 154 bytes.

Errors:

| Code | Name | When |
|------|------|------|
| 6000 | `ZeroAmount` | deposit of 0 |
| 6001 | `InvalidDeadline` | unused since the custody window landed; `DeadlineTooSoon` is strictly stronger. The variant stays so the numbering does not move |
| 6002 | `EscrowNotDeposited` | escrow is not open |
| 6003 | `DeadlineNotReached` | refund attempted too early |
| 6004 | `EscrowNotTerminal` | close attempted from a non terminal state |
| 6005 | `EscrowIndexFull` | 33rd open escrow for one sender |
| 6006 | `DeadlineTooSoon` | deadline below the one hour floor |
| 6007 | `DeadlineTooFar` | deadline above the twenty four hour ceiling |
| 6008 | `ReleaseWindowClosed` | release or `begin_payout` attempted at or after the deadline |
| 6009 | `EscrowNotPayoutPending` | `abort_payout` on an escrow that was never frozen |

The numbering is positional in Anchor. Inserting a variant in the middle would renumber the
others and break any client mapping codes, which is why every new code is appended at the end.

### The three numbers

| Constant | Value | What it bounds |
|----------|-------|----------------|
| `MIN_CUSTODY_SECS` | 1 hour | Floor of the deadline a deposit may set |
| `MAX_CUSTODY_SECS` | 24 hours | Ceiling, so the sender's worst case exposure is bounded |
| `PAYOUT_EXTENSION_SECS` | 1 hour, once | How far `begin_payout` can move the deadline |

Worst case wait for a sender, computable by anyone reading the account: 25 hours.

**These three are provisional**, and the source says so where they are defined. The one thing that
would change them is a measurement of how long the fiat leg actually takes end to end, which does
not exist yet. And if that measurement ever exceeds 24 hours, raising the ceiling is the wrong
answer: that is a product finding, not a constant.

## On-chain state

| Account | Seeds | Size | Holds funds |
|---------|-------|------|-------------|
| `EscrowState` | `["escrow", sender, remittance_id]` | 154 bytes | no, it is the record |
| vault | associated token account of `EscrowState` for the mint | standard SPL | **yes, this is where the money is** |
| `EscrowIndex` | `["escrow-index", sender]` | 558 bytes | no, never |

`EscrowState` fields: `sender`, `beneficiary`, `authority`, `mint` (32 bytes each), `amount`
(u64), `deadline` (i64), `status`, `bump`.
See [`programs/escrow/src/lib.rs:213`](programs/escrow/src/lib.rs#L213).

`EscrowIndex` fields: `sender`, `version`, `bump`, `entries` (up to 32 ids of 16 bytes).
See [`programs/escrow/src/lib.rs:199`](programs/escrow/src/lib.rs#L199).

Rent exemption, measured by the test suite against the in-process bank:

- `EscrowState` 154 bytes, 1,962,720 lamports (0.00196 SOL)
- `EscrowIndex` 558 bytes, 4,774,560 lamports (0.00477 SOL)

A `deposit` plus a `register_escrow` in one atomic transaction consumed 57,326 compute units.

### The layout is deliberately frozen

Adding a field to `EscrowState` would keep the account discriminator identical, because Anchor
hashes only the struct name, but it would break borsh deserialization of every account already on
chain. `release`, `refund` and `close` would start failing with `AccountDidNotDeserialize`, which
means a change intended as an improvement would turn reachable funds into unreachable funds.

`escrow.ts` test `1a` asserts the 154 byte size as a canary, and `escrow-index.ts` test `1b`
builds a 154 byte legacy account by hand and proves the current program can still refund it.

## Invariants

This is the part a reviewer usually wants first. Each row is enforced by an account constraint
rather than by an imperative check, and each has a test that attempts to violate it.

**1. The operator never holds the money.**
The vault is an associated token account whose authority is the `EscrowState` PDA
([`lib.rs:279`](programs/escrow/src/lib.rs#L279), [`322`](programs/escrow/src/lib.rs#L322),
[`357`](programs/escrow/src/lib.rs#L357), [`394`](programs/escrow/src/lib.rs#L394)). Tokens leave
it only through a CPI signed by the program with the PDA seeds, and there is no instruction that
takes an arbitrary destination account.

**2. The destination of a release is fixed at deposit time.**
`release` credits the associated token account of the recorded beneficiary and nothing else, by
`has_one = beneficiary` plus `associated_token::authority = beneficiary`
([`lib.rs:313`](programs/escrow/src/lib.rs#L313),
[`326-330`](programs/escrow/src/lib.rs#L326-L330)). A caller cannot substitute a receiving
account. Covered by `escrow.ts` test 1.

**3. Only the recorded authority can release.**
`has_one = authority` ([`lib.rs:312`](programs/escrow/src/lib.rs#L312)). Anyone else gets
`ConstraintHasOne`. Covered by `escrow.ts` test 2, which also asserts the vault was not touched.

**4. Refund does not depend on the authority existing, cooperating, or being online.**
The `Refund` context has no `authority` account at all
([`lib.rs:597`](programs/escrow/src/lib.rs#L597)). The sender signs alone, from the
deadline on ([`lib.rs:165`](programs/escrow/src/lib.rs#L165)). Covered by `escrow.ts` test 4, where
the authority keypair never signs, and `escrow.ts` test 3 for the too-early case.

**4b. Release and refund can never both be legal, at any instant.**
`release` requires `now < deadline` ([`lib.rs:122`](programs/escrow/src/lib.rs#L122)) and `refund`
requires `now >= deadline` ([`lib.rs:165`](programs/escrow/src/lib.rs#L165)). Same clock, same
field, complementary over the integers. This is the property to attack: to refute it you have to
exhibit an instant and a state where both get in. `escrow-window.ts` tests B1, B2 and B3 try, at
`deadline - 1`, at `deadline` exactly, and swept across the whole edge asserting that exactly one
of the two succeeds at every offset.

Before this guard existed, `release` was legal forever: an escrow whose deadline expired six days
ago could still be released today, so a sender recovering funds was not exercising a right, it was
entering a race decided by who sent the transaction first.

**4c. The freeze can postpone a refund, once, and can never revoke one.**
`begin_payout` requires `now < deadline` ([`lib.rs:232`](programs/escrow/src/lib.rs#L232)) and
status `Deposited`, so it cannot touch a refund that already vested and cannot be renewed: the
status is its own used flag. `abort_payout` can only move the deadline backwards, to `now`. Neither
context contains a single token account ([`lib.rs:635`](programs/escrow/src/lib.rs#L635),
[`654`](programs/escrow/src/lib.rs#L654)), so no transfer CPI is reachable from either.

It also adds no privilege: `begin_payout` is signed by the same authority already recorded in the
account, the one that can already call `release`, and `release` sends the whole principal out of
the sender's reach permanently. And if you delete `begin_payout` entirely, no attack opens up: the
refund guarantee never depended on it. Covered by `escrow-window.ts` tests C2 to C9.

**4d. `fiat_ref` is attribution, not proof.**
`begin_payout` takes an opaque `[u8; 32]` that the program never interprets, emits in an event and
never reads. It does not prove the fiat leg happened, and `PayoutPending` does not mean "the
provider paid". No on-chain program can verify a bank. What it records is who said it would happen,
when, and against which reference.

**5. One terminal transition, and the state changes before the transfer.**
Status is set to `Released` or `Refunded` before the CPI, not after
([`lib.rs:62`](programs/escrow/src/lib.rs#L62) then
[`84`](programs/escrow/src/lib.rs#L84); [`100`](programs/escrow/src/lib.rs#L100) then
[`122`](programs/escrow/src/lib.rs#L122)). A second terminal transition hits
`EscrowNotDeposited`. Covered by `escrow.ts` test 5, after a release and after a refund.

**6. A release or refund moves exactly the recorded amount.**
Both read `escrow_state.amount` ([`lib.rs:67`](programs/escrow/src/lib.rs#L67),
[`105`](programs/escrow/src/lib.rs#L105)), not the vault balance, so a third party cannot change
what the beneficiary receives by sending tokens to the vault.

**7. Live seeds cannot be reused, and closed ones cannot be revived.**
`EscrowState` and the vault are created with plain `init`, never `init_if_needed`
([`lib.rs:267`](programs/escrow/src/lib.rs#L267),
[`276`](programs/escrow/src/lib.rs#L276)), so a second deposit on the same
`[sender, remittance_id]` fails at account creation. After a `close` the same seeds work again
only through a fresh deposit that reinitializes every field. Covered by `escrow.ts` tests 6 and 8.

**8. Close is only reachable from a terminal state.**
`constraint = status.is_terminal()` ([`lib.rs:688`](programs/escrow/src/lib.rs#L688)), a whitelist
of `{Released, Refunded}` rather than a negation. With a second non terminal state in the enum, the
old `!= Deposited` would have let a frozen escrow be closed with a full vault. You cannot reclaim
rent out from under a live escrow. Covered by `escrow.ts` test 7 and `escrow-window.ts` D2, which
forces the vault to zero first so that the guard being tested is ours and not SPL's.

**9. The index is writable only by its owner.**
In both instructions the index PDA is seeded by the signing sender
([`lib.rs:424`](programs/escrow/src/lib.rs#L424), [`439`](programs/escrow/src/lib.rs#L439)), so
the seeds themselves are the ownership guard: you cannot name someone else's index without their
signature. `register_escrow` additionally carries `has_one = sender` on the escrow account
([`lib.rs:412`](programs/escrow/src/lib.rs#L412)) as defence in depth. Covered by
`escrow-index.ts` tests 4b and 4c, where an attacker fails both to register into a victim's index
and to deregister from it.

**10. The index gives the authority no power and moves no tokens.**
Neither recovery instruction takes an `authority` account and neither performs an SPL transfer.
`escrow-index.ts` test 4a asserts this against the built IDL rather than against the source:
exactly 8 instructions, and neither `register_escrow` nor `deregister_escrow` has an `authority`
account. `escrow-index.ts` test 7 asserts no token balance changes. The count is pinned so that an
instruction nobody reviewed shows up as a red diff.

**11. The index is bounded and idempotent.**
32 entries maximum ([`lib.rs:193`](programs/escrow/src/lib.rs#L193)); the 33rd reverts with
`EscrowIndexFull`; re-registering an id neither duplicates it nor reverts. Covered by
`escrow-index.ts` tests 5 and 6. `EscrowIndex` is the only account created with `init_if_needed`, which is safe here
because it custodies no funds, its seeds bind it to the signing sender, and every header write in
the handler is idempotent, so nothing ever resets `entries`.

**12. Arithmetic overflow aborts.**
`overflow-checks = true` in both the release and test profiles
([`Cargo.toml:23`](Cargo.toml#L23), [`Cargo.toml:32`](Cargo.toml#L32)). There is no arithmetic on
`amount` in the program today, so this is a guard against future changes rather than a live
concern.

## Known limitations

We would rather you read these here than find them yourself.

**Rent could be griefed by sending dust to the vault. Fixed in this source, not yet deployed.**
`release` and `refund` move the recorded amount, so the beneficiary and the sender always get
what they are owed. But the vault is an associated token account at a derivable address, so
anyone can transfer tokens into it. If they did, the leftover balance made `close` fail with the
SPL error `NonNativeHasBalance`, because it calls `CloseAccount` on a non empty account, and the
rent of two accounts stayed dead. `close` now sweeps any residual balance to the sender before
closing the vault ([`lib.rs:312`](programs/escrow/src/lib.rs#L312)), covered by `escrow-window.ts`
D1 and D1b. **The devnet program still has the old behaviour until this source is deployed.**

That sweep added a `sender_ata` account to `close`. Any client building the instruction with the
old account list has to add it.

**The custody window is enforced on chain, and only on chain.**
The floor and the ceiling stop a one second deadline and an `i64::MAX` deadline from being
recorded, but a deposit that never goes through our infrastructure can still be built by anyone
willing to pay its own fee, with any mint. The mint is deliberately not pinned in the program, see
[The mint](#the-mint).

**The clock is the validator's clock.**
Every deadline is measured against `Clock::unix_timestamp`, which can drift from wall time. The
nominal window and the effective one are not exactly the same. We have not measured that drift and
the margins were not chosen against it.

**The window bounds time, not amount.**
It caps how long a sender is exposed. It says nothing about how much. A cap on the amount that can
be committed automatically is a separate control and it does not exist yet.

**`EscrowIndex` rent is not recoverable.**
There is no instruction that closes the index account. Once a sender creates one, its rent stays
locked. It is a one time cost per sender, not per escrow, and `deregister_escrow` keeps the
account reusable rather than growing without bound.

**`release` requires the beneficiary's token account to already exist.**
The instruction validates it, it does not create it. Whoever drives the flow has to ensure the
beneficiary has an associated token account for the mint before calling `release`.

**No fuzzing, no formal verification, no external audit.**
The suite is behaviour driven and deliberately adversarial, but that is not the same thing.

## Upgrade authority

The program is deployed under the upgradeable BPF loader, and the upgrade authority is
`4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH`, a single devnet key that is also the fee payer
for our devnet deploys. Anyone can read this in thirty seconds with `solana program show`, so we
would rather state it plainly: **today one key can replace this program's code on devnet.**

That is deliberate for this stage. The program is on devnet with a test mint and no real value,
and it is still changing, as the two recovery instructions show. An immutable program is a bad
place to discover that a design needs one more instruction.

It is also not acceptable for mainnet. Before any mainnet deployment the authority has to move to
a multisig with a timelock, or the program has to be deployed final after an external audit. We
are not there yet, and this README will say so until we are.

## The mint

The mint is not hardcoded. It enters every instruction as an account and is recorded in
`EscrowState.mint`, then enforced by `has_one = mint` on every later instruction, so an escrow
can only ever be settled in the mint it was opened with.

That is a decision, not an omission, and it has a condition that would reverse it. The program is
generic escrow infrastructure, while "which token counts as a dollar" is product policy: pinning it
in the binary would mean two builds for devnet and mainnet, two IDLs, two pinned hashes, and a
redeploy to rotate it. So the allow list belongs in the component that sits on the critical path of
every deposit, which today is the off-chain co-signer that refuses to sign a deposit carrying an
unexpected mint. **What would change this:** the day anything sweeps the chain for deposits and
takes them as good without that co-signature, the mint has to be pinned on chain, because at that
point a self funded deposit with an attacker's mint would enter a product path. The enumerators
that exist today only feed the refund, which is harmless.

Two devnet mints show up around this program and they are easy to confuse:

| Mint | What it is |
|------|-----------|
| `8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q` | **The one the devnet escrow actually runs on.** Our own 6 decimal test mint, mint authority `4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH`, so we can mint test balances at will. |
| `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Circle's USDC devnet mint, 6 decimals, mint authority `GrNg1XM2ctzeE2mXxXCfhcTUbejM8Z4z4wNVTy2FjMEz`, which is not ours. Reference value only. Do not assume the escrow holds this mint. |

Both were read on chain when this table was written, and the escrow state accounts on devnet
record the first one.

The test suite creates its own synthetic 6 decimal mint per run, since no external mint is
reachable in the in-process bank.

## Build and test

```bash
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
npm ci
anchor build
anchor test --skip-build --skip-deploy --skip-local-validator
```

Tests run on [`anchor-bankrun`](https://github.com/kevinheavey/anchor-bankrun), in process, with
no local validator, which is what makes deterministic control of the clock possible for the
deadline cases.

Last measured run: **49 passing**, in about 4 seconds.

| Suite | Tests | What it covers |
|-------|-------|----------------|
| `tests/escrow.ts` | 10 | deposit, release, refund, close, the state machine, the 154 byte canary |
| `tests/escrow-index.ts` | 13 | the index, attacker paths, legacy account compatibility, IDL shape, the entry cap, rent and compute cost |
| `tests/escrow-window.ts` | 26 | the custody window floor and ceiling, both edges of the release/refund invariant, the freeze and its abort, the dust sweep |

`escrow-window.ts` re-declares the three constants as its own literals instead of importing them
from the program. That is deliberate: a test that asked the program for its own number, or that
re-derived `deadline + extension` the same way the program does, would keep passing after someone
multiplied the extension by ten. It would be a guard comparing itself against itself.

The suites import the built IDL directly rather than guarding it behind a file existence check.
That is on purpose: if the build artifact is missing, the suite must fail loudly instead of
quietly reporting zero tests.

If you mutate the program to check that a test really fails, remember that `anchor deploy` ships
whatever is in `target/deploy/`, it does not compile. Rebuild before deploying anything.

## Toolchain

| Tool | Version |
|------|---------|
| rustc | 1.89.0, pinned by `rust-toolchain.toml` |
| solana-cli (Agave) | 3.1.10, declared in `[workspace.metadata.cli]` so `solana-verify` picks the matching build image |
| anchor-cli | 1.1.2 |

These versions appear in `rust-toolchain.toml`, `Cargo.toml`, both workflows and this table. They
have to be changed together. A mismatch does not break the build, it breaks the reproduction,
which is a quieter failure.

## Continuous integration

Two workflows, neither of which deploys anything.

| Workflow | What it does | State |
|----------|--------------|-------|
| `.github/workflows/ci.yml` | clippy with `-D warnings`, `anchor build`, the whole test suite | **red**, see below |
| `.github/workflows/verified-build.yml` | rebuilds in the pinned container and compares the result against the program on devnet | **never run** |

### `verified-build.yml`

Two independent jobs:

`onchain-hash` runs `scripts/onchain-hash.py` against devnet and fails if the deployed bytes
stop matching the two hashes published in this file. No Docker, no toolchain, seconds to run.
It also fires on a weekly schedule, so an unannounced upgrade of the deployed program turns the
workflow red even if nobody pushes.

`reproducible-build` downloads `solana-verify` (checksum pinned), rebuilds inside the container
selected by `[workspace.metadata.cli] solana = "3.1.10"`, and then makes three comparisons, any
of which fails the job:

1. the rebuilt `.so` against the `artifact-sha256` published above
2. the rebuilt `.so` against the program deployed on devnet
3. the deployed program against the `verify-hash` published above

The third one exists because the first two, on their own, would still pass after a silent
redeploy accompanied by a matching source change. It also refuses to run a comparison on a value
that is not a 64 character hex string, because two empty strings compare equal and a control that
cannot fail is worse than no control.

**This workflow has never completed a run.** The comparison logic was exercised locally against
stubs, covering the matching case, a rebuild that differs from the chain, a chain that differs
from this file, an empty tool output, a missing artifact, and a rebuilt binary that is not the
published one. All six behaved correctly. The container build itself could not be tested here,
there is no usable Docker in the environment where this was written, so whether the rebuild
actually reproduces the deployed bytes is still an open question. Until a run comes back green,
read the table in [Reproducing the deployed binary](#reproducing-the-deployed-binary) as the
statement of record.

### `ci.yml`

Builds the program and runs the whole suite on every push and pull request.

**It is currently red, and not because of the program.** The workflow builds the Anchor CLI from
source, and one of the CLI's own transitive dependencies has raised its minimum supported rustc
above the 1.89.0 this repository pins for the program. The job fails while installing the tool,
before it ever reaches `anchor build`.

The workflow now installs the CLI from crates.io at the exact pinned version, with `--locked`, and
uses a separate modern host toolchain for that binary only. The program is still compiled with
1.89.0. That path was reproduced locally end to end, with a standalone CLI and no version manager
present, but it has not been confirmed on a GitHub runner yet. Until a run comes back green, the
honest statement is the one at the top of this file: the build and the tests pass locally with
the pinned toolchain, and the commands above let you check that for yourself.

**Lints.** `cargo clippy --all-targets -- -D warnings` now runs before anything else, and the
tree passes it. `cargo fmt` does **not** run and is not enforced: the program does not currently
pass `cargo fmt --all -- --check`, mostly comment alignment and two multi line reformats in
`programs/escrow/src/lib.rs`. Reformatting the program to make a build infrastructure change go
green would have meant touching the source this repository exists to keep verifiable, so the
check was left out and written down here instead. Adding it means one formatting commit first.

## Deploying

```bash
./scripts/deploy-devnet.sh
```

Devnet only. The script pins the cluster explicitly so an ambient CLI config cannot redirect it.

## Licence

MIT. See [LICENSE](LICENSE).
