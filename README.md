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
| Money at risk | None. Devnet, with a test mint we control. |
| Upgrade authority | **Present.** The program is deployed under the upgradeable loader and its authority is a single devnet key. See [Upgrade authority](#upgrade-authority). |
| External audit | **None.** The program has not been reviewed by a third party security firm. |
| Test coverage | 23 tests, all passing locally. Behaviour driven, no fuzzing and no formal verification. |
| CI | The workflow exists and is currently **failing**, at the tool install step, before it reaches the program. See [Continuous integration](#continuous-integration). |
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
| `sha256` of the deployed bytes | `dc0ba21a5a620ef5dd1546c2c9e86eb6d00f9ca438e97bb4e2a5fa09819a8960` |

Verify it yourself, no keypair needed:

```bash
solana program show DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x --url devnet

# and to compare the deployed bytes against a local build of this repo:
anchor build
solana program dump DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x /tmp/onchain.so --url devnet
sha256sum /tmp/onchain.so target/deploy/escrow.so
```

On our machine, a rebuild with the pinned toolchain produces exactly the bytes that are
deployed. We have not tested whether that reproduces on a different machine, so treat the
hash as something to compare, not as a reproducible build guarantee.

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

## Flow

```
deposit ──> Deposited ──┬── release ──> Released  ──┐
                        │                           ├── close ──> accounts gone, rent returned
                        └── refund  ──> Refunded ───┘
                            (only after deadline)
```

1. **`deposit(remittance_id, beneficiary, authority, amount, deadline)`**
   The sender locks `amount` into a vault. The beneficiary, the releasing authority, the mint,
   the amount and the deadline are written to the state account and never change afterwards.

2. Exactly one terminal exit, and they are mutually exclusive:
   - **`release(remittance_id)`** the recorded authority pays the recorded beneficiary. The
     destination is validated by constraint, it is not a caller supplied account.
   - **`refund(remittance_id)`** after the deadline the sender alone recovers the funds. The
     authority is not part of this instruction at all.

3. **`close(remittance_id)`** once terminal, rent for the state account and the vault goes back
   to the sender.

### Recovering an escrow whose id was lost

The state account is derived from `["escrow", sender, remittance_id]` and those 16 bytes are not
stored on chain. Losing them used to make the funds unreachable even for the sender, who had the
right to refund but no way to name the account. Two instructions add a per sender index so the id
can be read back from the chain:

4. **`register_escrow(remittance_id)`** records the id in an `EscrowIndex` account derived from
   `["escrow-index", sender]`, that is, derivable knowing only the sender's own address. It
   requires the escrow to exist, to belong to the signing sender, and to still be open, so the
   index only ever lists live escrows. It moves zero tokens. Re-registering the same id neither
   duplicates nor reverts.

5. **`deregister_escrow(remittance_id)`** removes one id from the caller's own index. It is a
   no op if the id is absent, it moves no tokens, and it deliberately does not require a terminal
   state: requiring one would make entries of already closed escrows impossible to clean up.

Recovery path: derive `["escrow-index", sender]`, one `getAccountInfo`, read `entries`, then
derive `["escrow", sender, entries[i]]` and call the normal `refund`. The authority is not a
party to either instruction and gains no power over the funds.

## Instructions

| Instruction | Signer | Effect | Guards |
|-------------|--------|--------|--------|
| `deposit` | sender | creates state + vault, pulls `amount` in | `amount > 0`, `deadline` in the future |
| `release` | recorded authority | pays the recorded beneficiary | `has_one` on authority, beneficiary, sender, mint; status must be `Deposited` |
| `refund` | sender | pays the sender back | `has_one` on sender and mint; status `Deposited`; `now >= deadline` |
| `close` | sender | closes state + vault, rent to sender | status must not be `Deposited` |
| `register_escrow` | sender | adds an id to the sender's index | escrow belongs to signer and is `Deposited`; index not full |
| `deregister_escrow` | sender | removes an id from the sender's index | index PDA is seeded by the signer |

Errors:

| Code | Name | When |
|------|------|------|
| 6000 | `ZeroAmount` | deposit of 0 |
| 6001 | `InvalidDeadline` | deadline not in the future |
| 6002 | `EscrowNotDeposited` | escrow is not open |
| 6003 | `DeadlineNotReached` | refund attempted too early |
| 6004 | `EscrowNotTerminal` | close attempted while open |
| 6005 | `EscrowIndexFull` | 33rd open escrow for one sender |

The numbering is positional in Anchor. Inserting a variant in the middle would renumber the
others and break any client mapping codes, which is why `EscrowIndexFull` was appended at the end.

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
([`lib.rs:337-370`](programs/escrow/src/lib.rs#L337-L370)). The sender signs alone, after the
deadline ([`lib.rs:94-97`](programs/escrow/src/lib.rs#L94-L97)). Covered by `escrow.ts` test 4, where
the authority keypair never signs, and `escrow.ts` test 3 for the too-early case.

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
`constraint = status != Deposited` ([`lib.rs:386`](programs/escrow/src/lib.rs#L386)). You cannot
reclaim rent out from under a live escrow. Covered by `escrow.ts` test 7.

**9. The index is writable only by its owner.**
In both instructions the index PDA is seeded by the signing sender
([`lib.rs:424`](programs/escrow/src/lib.rs#L424), [`439`](programs/escrow/src/lib.rs#L439)), so
the seeds themselves are the ownership guard: you cannot name someone else's index without their
signature. `register_escrow` additionally carries `has_one = sender` on the escrow account
([`lib.rs:412`](programs/escrow/src/lib.rs#L412)) as defence in depth. Covered by
`escrow-index.ts` tests 4b and 4c, where an attacker fails both to register into a victim's index
and to deregister from it.

**10. The index gives the authority no power and moves no tokens.**
Neither new instruction takes an `authority` account and neither performs an SPL transfer. `escrow-index.ts`
test 4a asserts this against the built IDL rather than against the source: exactly 6 instructions,
and neither of the two new ones has an `authority` account. `escrow-index.ts` test 7 asserts no
token balance changes.

**11. The index is bounded and idempotent.**
32 entries maximum ([`lib.rs:193`](programs/escrow/src/lib.rs#L193)); the 33rd reverts with
`EscrowIndexFull`; re-registering an id neither duplicates it nor reverts. Covered by
`escrow-index.ts` tests 5 and 6. `EscrowIndex` is the only account created with `init_if_needed`, which is safe here
because it custodies no funds, its seeds bind it to the signing sender, and every header write in
the handler is idempotent, so nothing ever resets `entries`.

**12. Arithmetic overflow aborts.**
`overflow-checks = true` in both the release and test profiles
([`Cargo.toml:12`](Cargo.toml#L12), [`Cargo.toml:21`](Cargo.toml#L21)). There is no arithmetic on
`amount` in the program today, so this is a guard against future changes rather than a live
concern.

## Known limitations

We would rather you read these here than find them yourself.

**Rent can be griefed by sending dust to the vault.**
`release` and `refund` move the recorded amount, so the beneficiary and the sender always get
what they are owed. But the vault is an associated token account at a derivable address, so
anyone can transfer tokens into it. If they do, the leftover balance makes `close` fail with the
SPL error `NonNativeHasBalance`, because it calls `CloseAccount` on a non empty account. The
consequence is that the state account and the vault stay alive and their rent, about 0.004 SOL,
is never returned to the sender. That `[sender, remittance_id]` pair also stays occupied forever.
Custody is not affected. We reproduced this in a local bank before writing it down. The natural
fix is for `close` to sweep any residual balance to the sender before closing the vault, and it
is not applied yet because changing the deployed program is a deliberate step, see below.

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

Last measured run: **23 passing**, in about 2 seconds.

| Suite | Tests | What it covers |
|-------|-------|----------------|
| `tests/escrow.ts` | 10 | deposit, release, refund, close, the state machine, the 154 byte canary |
| `tests/escrow-index.ts` | 13 | the index, attacker paths, legacy account compatibility, IDL shape, the entry cap, rent and compute cost |

The suites import the built IDL directly rather than guarding it behind a file existence check.
That is on purpose: if the build artifact is missing, the suite must fail loudly instead of
quietly reporting zero tests.

If you mutate the program to check that a test really fails, remember that `anchor deploy` ships
whatever is in `target/deploy/`, it does not compile. Rebuild before deploying anything.

## Toolchain

| Tool | Version |
|------|---------|
| rustc | 1.89.0, pinned by `rust-toolchain.toml` |
| solana-cli (Agave) | 3.1.10 |
| anchor-cli | 1.1.2 |

## Continuous integration

`.github/workflows/ci.yml` builds the program and runs the whole suite on every push and pull
request. It never deploys.

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

## Deploying

```bash
./scripts/deploy-devnet.sh
```

Devnet only. The script pins the cluster explicitly so an ambient CLI config cannot redirect it.

## Licence

MIT. See [LICENSE](LICENSE).
