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
| Source vs deployed | **They differ right now.** The custody window described below (the release deadline, the deposit floor and ceiling, the vault sweep on `close`) is in this source and **has not been deployed**. The deployed devnet binary is still the previous one, and the hashes in [Deployment](#deployment) describe that older binary, not a build of this tree. Deploying it changes the fate of escrows that are already live: see [Before upgrading the deployed program](#before-upgrading-the-deployed-program). |
| Money at risk | None. Devnet, with a test mint we control. |
| Upgrade authority | **Present.** The program is deployed under the upgradeable loader and its authority is a single devnet key. See [Upgrade authority](#upgrade-authority). |
| External audit | **None.** The program has not been reviewed by a third party security firm. |
| Test coverage | 43 tests, all passing locally. Behaviour driven, no fuzzing and no formal verification. |
| CI | **Green.** clippy, `anchor build` and the 43 tests run on every push. See [Continuous integration](#continuous-integration). |
| Reproducible build | **Confirmed once, on a machine that is not ours.** A GitHub runner rebuilt the program in the pinned container and reproduced the deployed devnet bytes exactly. Nobody outside this project has repeated it. See [Reproducing the deployed binary](#reproducing-the-deployed-binary). |
| On-chain IDL | **Not published.** The explorer shows raw bytes rather than named instructions. The command is written down and needs the upgrade authority to run: see [Publishing the IDL on chain](doc/publish-idl-onchain.md). |
| Known issues | Written down below, **and two of them are about custody**: a mint with a freeze authority can freeze the vault, and the vault's associated token account can be pre-created by a stranger to block a deposit. See [Known limitations](#known-limitations). |

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
> custody window landed. The new binary is also **bigger than the space reserved on chain**, so the
> upgrade needs a `solana program extend` first; `scripts/deploy-devnet.sh` checks that before
> touching anything and prints the exact command.

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
| A container rebuild reproduces those bytes | **Confirmed**, on a GitHub runner, at commit [`36444ef`](https://github.com/ferrosasfp/solana-programs/commit/36444ef0684bfd3da2b91eb9482ea88d8169da22) ([run 30664488714](https://github.com/ferrosasfp/solana-programs/actions/runs/30664488714)). All three comparisons passed: the rebuild matched the published `artifact-sha256`, it matched the program on devnet, and devnet matched the published `verify-hash`. |
| An independent third party reproduced it | **Not confirmed.** Nobody outside this project has tried yet. A GitHub runner is not our laptop, but it is still our workflow. |

So: the mechanism is wired up, public, and has come back green once on hardware we do not own.
What is still missing is somebody with no stake in this repository running it and saying so. If it
does not reproduce on your machine, that is a finding we want to hear about.

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
   deposit                      deadline
      |------------------------------|---------------------------------->
      |        release ONLY          |           refund ONLY
      |        (now <  deadline)     |           (now >= deadline)
```

```
deposit ──> Deposited ──┬── release ──> Released ──┐
                        │                          ├── close
                        └── refund  ──> Refunded  ─┘
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

3. **`close(remittance_id)`** once terminal, rent for the state account and the vault goes back
   to the sender, and whatever token balance is sitting in the vault is transferred to the sender
   first, with no upper bound. See [the sweep](#known-limitations).

### Recovering an escrow whose id was lost

The state account is derived from `["escrow", sender, remittance_id]` and those 16 bytes are not
stored on chain. Losing them used to make the funds unreachable even for the sender, who had the
right to refund but no way to name the account. Two instructions add a per sender index so the id
can be read back from the chain:

4. **`register_escrow(remittance_id)`** records the id in an `EscrowIndex` account derived from
   `["escrow-index", sender]`, that is, derivable knowing only the sender's own address. It
   requires the escrow to exist, to belong to the signing sender, and to still be `Deposited`, so
   the index only ever lists live escrows. It moves zero tokens. Re-registering the same id neither
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
| `deposit` | sender | creates state + vault, pulls `amount` in | `amount > 0`; `now + 1 h <= deadline <= now + 24 h` |
| `release` | recorded authority | pays the recorded beneficiary | `has_one` on authority, beneficiary, sender, mint; status `Deposited`; **`now < deadline`** |
| `refund` | sender | pays the sender back | `has_one` on sender and mint; status `Deposited`; `now >= deadline` |
| `close` | sender | transfers the whole vault balance to the sender, closes state + vault, rent to sender | status in `{Released, Refunded}` |
| `register_escrow` | sender | adds an id to the sender's index | escrow belongs to signer and is `Deposited`; index not full |
| `deregister_escrow` | sender | removes an id from the sender's index | index PDA is seeded by the signer |

States: `Deposited` (0), `Released` (1, terminal), `Refunded` (2, terminal). **Exactly three**, and
the count is part of the contract with the off-chain consumers: the IDL they pin declares these
three, so an account carrying a fourth status byte makes their account decoder throw instead of
returning a state. Any new variant has to be appended at the end (0, 1 and 2 are already written in
live accounts) and must not be deployed before both consumers publish the new IDL and handle the new
state. `escrow-window.ts` E1b is the tripwire for that.

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
| 6008 | `ReleaseWindowClosed` | release attempted at or after the deadline |

The numbering is positional in Anchor. Inserting a variant in the middle would renumber the
others and break any client mapping codes, which is why every new code is appended at the end.

### The two numbers

| Constant | Value | What it bounds |
|----------|-------|----------------|
| `MIN_CUSTODY_SECS` | 1 hour | Floor of the deadline a deposit may set |
| `MAX_CUSTODY_SECS` | 24 hours | Ceiling, so the sender's worst case exposure is bounded |

Worst case wait for a sender, computable by anyone reading the account: 24 hours.

The floor has two halves and only one of them is a benefit. It stops a deadline so short that the
release is structurally out of reach, and it is also **the minimum time the sender cannot recover
their own money**: `refund` needs `now >= deadline`, so a mistaken deposit is immobilised for at
least an hour. Raising the floor improves the operator's margin and worsens that, in the same
proportion.

**Both are provisional**, and the source says so where they are defined. The one thing that would
change them is a measurement of how long the fiat leg actually takes end to end, which does not
exist yet. And if that measurement ever exceeds 24 hours, raising the ceiling is the wrong answer:
that is a product finding, not a constant.

The floor also does not fit the client that exists today, which derives the deadline from a quote
that expires in 10 minutes: every deposit it builds would revert with `DeadlineTooSoon`. That is a
product decision with two possible answers and a cost on both sides, written up in
[`doc/decisions/deadline-vs-quote-ttl.md`](doc/decisions/deadline-vs-quote-ttl.md). It has to be
decided before this program is deployed and the client is pointed at it.

## On-chain state

| Account | Seeds | Size | Holds funds |
|---------|-------|------|-------------|
| `EscrowState` | `["escrow", sender, remittance_id]` | 154 bytes | no, it is the record |
| vault | associated token account of `EscrowState` for the mint | standard SPL | **yes, this is where the money is** |
| `EscrowIndex` | `["escrow-index", sender]` | 558 bytes | no, never |

`EscrowState` fields: `sender`, `beneficiary`, `authority`, `mint` (32 bytes each), `amount`
(u64), `deadline` (i64), `status`, `bump`.
See the `EscrowState` struct in [`programs/escrow/src/lib.rs`](programs/escrow/src/lib.rs).

`EscrowIndex` fields: `sender`, `version`, `bump`, `entries` (up to 32 ids of 16 bytes).
See the `EscrowIndex` struct in [`programs/escrow/src/lib.rs`](programs/escrow/src/lib.rs).

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
The vault carries `associated_token::authority = escrow_state` in every context that touches it
(`Deposit`, `Release`, `Refund`, `Close`), so its authority is the `EscrowState` PDA. Tokens leave
it only through a CPI signed by the program with the PDA seeds, and there is no instruction that
takes an arbitrary destination account.

**2. The destination of a release is fixed at deposit time.**
`release` credits the associated token account of the recorded beneficiary and nothing else, by
`has_one = beneficiary` plus `associated_token::authority = beneficiary`, both in the `Release`
context. A caller cannot substitute a receiving
account. Covered by `escrow.ts` test 1.

**3. Only the recorded authority can release.**
`has_one = authority` in the `Release` context. Anyone else gets
`ConstraintHasOne`. Covered by `escrow.ts` test 2, which also asserts the vault was not touched.

**4. Refund does not depend on the authority existing, cooperating, or being online.**
The `Refund` context has no `authority` account at all. The sender signs alone, from the
deadline on (`require!(now >= deadline)` in `refund`). Covered by `escrow.ts` test 4, where
the authority keypair never signs, and `escrow.ts` test 3 for the too-early case.

**4b. Release and refund can never both be legal, at any instant.**
`release` requires `now < deadline` and `refund` requires `now >= deadline`. Same clock, same
field, complementary over the integers. This is the property to attack: to refute it you have to
exhibit an instant and a state where both get in. `escrow-window.ts` tests B1, B2 and B3 try, at
`deadline - 1`, at `deadline` exactly, and swept across the whole edge asserting that exactly one
of the two succeeds at every offset.

Before this guard existed, `release` was legal forever: an escrow whose deadline expired six days
ago could still be released today, so a sender recovering funds was not exercising a right, it was
entering a race decided by who sent the transaction first.

**4c. From a terminal state neither exit can move a token, and that is proven with the vault full.**
Both `release` and `refund` require `status == Deposited`. Retrying them on an empty vault proves
nothing, because SPL rejects a transfer out of an empty account and our guard is never reached: the
vault is an associated token account at a derivable address, so anybody can put tokens back into it,
and the off-chain facilitator accepts `vaultAmount >= amount`. `escrow-window.ts` C1 to C4 refill
the vault on purpose, satisfy the clock guard as well, and assert that no balance moves. C4 plants a
`Refunded` account with an open window by hand, because the program's own transitions cannot produce
that combination.

**5. One terminal transition, and the state changes before the transfer.**
Status is set to `Released` or `Refunded` in the EFFECTS block of `release` and `refund`, before
the transfer CPI in their INTERACTIONS block, not after. A second terminal transition hits
`EscrowNotDeposited`. Covered by `escrow.ts` test 5, after a release and after a refund.

**6. A release or refund moves exactly the recorded amount.**
Both transfer `escrow_state.amount`, not the vault balance, so a third party cannot change
what the beneficiary receives by sending tokens to the vault.

**7. Live seeds cannot be reused, and closed ones cannot be revived.**
`EscrowState` and the vault are created with plain `init`, never `init_if_needed`, in the `Deposit`
context, so a second deposit on the same
`[sender, remittance_id]` fails at account creation. After a `close` the same seeds work again
only through a fresh deposit that reinitializes every field. Covered by `escrow.ts` tests 6 and 8.

**8. Close is only reachable from a terminal state, and the sweep made that guard load bearing.**
`constraint = status.is_terminal()`, a whitelist of `{Released, Refunded}` rather than a negation.
Today the two expressions coincide; they stop coinciding the day a second non terminal state exists,
where the negation would let that account be closed with a full vault. The sweep also changed what
this guard is holding: `close` used to be rejected by SPL on a live escrow, because `CloseAccount`
refuses a non-empty account, and now the sweep empties the vault into the sender's own account
first. So with the whitelist gone, a sender could pull the whole principal back before the deadline.
Covered by `escrow.ts` test 7 and by `escrow-window.ts` D2, which leaves the vault **full** and
asserts that not one token moved.

**9. The index is writable only by its owner.**
In both instructions the index PDA is seeded `["escrow-index", sender.key()]` with `sender` as the
signer, so the seeds themselves are the ownership guard: you cannot name someone else's index
without their signature. `register_escrow` additionally carries `has_one = sender` on the escrow
account as defence in depth. Covered by
`escrow-index.ts` tests 4b and 4c, where an attacker fails both to register into a victim's index
and to deregister from it.

**10. The index gives the authority no power and moves no tokens.**
Neither recovery instruction takes an `authority` account and neither performs an SPL transfer.
`escrow-index.ts` test 4a asserts this against the built IDL rather than against the source:
exactly 6 instructions, and neither `register_escrow` nor `deregister_escrow` has an `authority`
account. `escrow-index.ts` test 7 asserts no token balance changes. The count is pinned so that an
instruction nobody reviewed shows up as a red diff.

**11. The index is bounded and idempotent.**
32 entries maximum (`MAX_ENTRIES`); the 33rd reverts with
`EscrowIndexFull`; re-registering an id neither duplicates it nor reverts. Covered by
`escrow-index.ts` tests 5 and 6. `EscrowIndex` is the only account created with `init_if_needed`, which is safe here
because it custodies no funds, its seeds bind it to the signing sender, and every header write in
the handler is idempotent, so nothing ever resets `entries`.

**12. Arithmetic overflow aborts.**
`overflow-checks = true` in both the release and test profiles
([`Cargo.toml:23`](Cargo.toml#L23), [`Cargo.toml:32`](Cargo.toml#L32)). There is no arithmetic on
`amount` in the program today, so this is a guard against future changes rather than a live
concern.

## Not in this version: the payout freeze

An earlier draft of this change also added `begin_payout` and `abort_payout`, letting the recorded
authority postpone the deadline once, by one hour, while the fiat leg is in flight, with the escrow
sitting in a fourth status, `PayoutPending`. It was taken out before review closed. The code is kept
on the branch `feat/ventana-de-custodia-fase2`.

**Why it was taken out.** The two off-chain consumers pin an IDL whose `EscrowStatus` has exactly
three variants (`chaski-v3/src/infrastructure/solana/escrow-idl.ts:497` and its twin in
`wasiai-facilitator/src/chains/escrow-idl.ts`), and a status byte of 3 makes their
`BorshAccountsCoder` throw. In `chaski-v3` that `coder.decode` sits on the refund path
(`src/infrastructure/solana-wallet.ts:352`) and is **not** inside a `try`, so the person who sent
the remittance would be unable to recover their money from the product. The facilitator does catch
it (`readEscrowState` never throws) and returns `{ ok: false }`, which means it refuses to sign the
release. The two together are the problem: not releasable and not refundable at the same time. A
feature meant to protect the payout would have created the one state where nobody can get the funds
out through the normal paths.

**What has to be true before it can ship**, in this order:

1. Both consumers publish an IDL with the four variants and pin it.
2. Both handle the new state explicitly: `verifyVault` in the facilitator must decide what
   `PayoutPending` means for a release it is asked to sign, and `refundEscrow` in `chaski-v3` must
   decode it without throwing and tell the user what is happening.
3. Only then does the program add the variant, appended at the end, and only then is it deployed.

`escrow-window.ts` E1b is the tripwire: it asserts that a status byte of 3 does not decode. It goes
red the day a fourth variant lands, on purpose, as the reminder that steps 1 and 2 come first.

## Known limitations

We would rather you read these here than find them yourself.

**A mint with a freeze authority can freeze the vault, and then nothing moves.**
The vault is an ordinary SPL token account of whatever mint the deposit carried. If that mint has a
freeze authority, and real USDC does, that authority can freeze the vault account. A frozen token
account rejects every transfer, so **neither `release` nor `refund` can move a token**, and no
deadline, guard or signature in this program changes that. This is the only path to permanent
entrapment we know of, and it comes from outside the program: the program cannot detect it, prevent
it or route around it. It sits next to the decision not to pin the mint (see [The mint](#the-mint)):
choosing the mint is choosing whose freeze authority you are exposed to.

**The vault's associated token account can be pre-created by a stranger, blocking the deposit.**
`deposit` creates the vault with `init`, not `init_if_needed`. The address is an associated token
account of a PDA derived from `["escrow", sender, remittance_id]`, so anyone who can guess or
observe those 16 bytes can create that account first, for about 0.002 SOL, and then the deposit
fails at account creation for that `(sender, remittance_id)` pair, forever. The workaround is
trivial, use another `remittance_id`, and no funds are ever at risk. It is **pre-existing**, this
branch does not introduce it, and it is one of the first things an external reviewer finds, so it is
written here rather than left to be discovered.

**Rent could be griefed by sending dust to the vault. Fixed in this source, not yet deployed.**
`release` and `refund` move the recorded amount, so the beneficiary and the sender always get
what they are owed. But the vault is an associated token account at a derivable address, so
anyone can transfer tokens into it. If they did, the leftover balance made `close` fail with the
SPL error `NonNativeHasBalance`, because it calls `CloseAccount` on a non empty account, and the
rent of two accounts stayed dead. `close` now moves the vault balance to the sender before closing
it, covered by `escrow-window.ts` D1 and D1b. **The devnet program still has the old behaviour
until this source is deployed.**

Say what that sweep does, precisely: it transfers **the whole of `vault.amount`, with no upper
bound**, not "the dust". If a third party sends a thousand tokens into the vault of an escrow that
is already terminal, the sender gets the thousand tokens. It is harmless, the principal was already
paid to whoever it was owed to and sending tokens to somebody else's account is giving them away,
but "residual balance" would make you picture a cap that does not exist in the code.

That sweep added a `sender_ata` account to `close`. Any client building the instruction with the
old account list has to add it, and there is no safe order in which to deploy the two: see
[the account list of `close`](#the-account-list-of-close-has-no-safe-deployment-order).

**The custody window is enforced on chain, and only on chain.**
The floor and the ceiling stop a one second deadline and an `i64::MAX` deadline from being
recorded, but a deposit that never goes through our infrastructure can still be built by anyone
willing to pay its own fee, with any mint. The mint is deliberately not pinned in the program, see
[The mint](#the-mint).

**The clock is the validator's clock.**
Every deadline is measured against `Clock::unix_timestamp`, which can drift from wall time. The
nominal window and the effective one are not exactly the same. We have not measured that drift and
the margins were not chosen against it.

**The floor does not fit the client that exists today.**
The client derives the escrow deadline from a quote that expires in 10 minutes, which is below the
one hour floor, so every deposit it builds would revert with `DeadlineTooSoon`. That is a product
decision with two possible answers and a real cost on both sides, written up in
[`doc/decisions/deadline-vs-quote-ttl.md`](doc/decisions/deadline-vs-quote-ttl.md). It has to be
decided before this program is deployed and the client is pointed at it.

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

## Reporting a vulnerability

Email **fernando@wasiai.io**. Please do not open a public issue for an unpatched vulnerability.
First reply within 48 hours; coordinated disclosure with a 90 day default embargo; **there is no
bug bounty and we are not going to imply there is one.** Scope, what is explicitly out of scope,
and what this program is today are in [SECURITY.md](SECURITY.md).

A build of this source also carries the same contact inside the binary, so a finder holding only
the program id can reach us:

```bash
solana program dump DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x /tmp/escrow.so --url devnet
strings -n 4 /tmp/escrow.so | grep -A 16 'BEGIN SECURITY.TXT'
```

That returns nothing against the currently deployed binary, which predates the
[`security_txt!`](programs/escrow/src/lib.rs) block. It starts working when this source is
deployed.

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

Last measured run: **43 passing**, in about 3 seconds.

| Suite | Tests | What it covers |
|-------|-------|----------------|
| `tests/escrow.ts` | 10 | deposit, release, refund, close, the state machine, the 154 byte canary |
| `tests/escrow-index.ts` | 13 | the index, attacker paths, legacy account compatibility, IDL shape, the entry cap, rent and compute cost |
| `tests/escrow-window.ts` | 20 | the custody window floor and ceiling, both edges of the release/refund invariant, the status guard attacked with a refilled vault, the vault sweep, the status byte of accounts already live |

`escrow-window.ts` re-declares the two constants as its own literals instead of importing them
from the program. That is deliberate: a test that asked the program for its own number would keep
passing after someone divided the floor by ten. It would be a guard comparing itself against itself.

The suites import the built IDL directly rather than guarding it behind a file existence check.
That is on purpose: if the build artifact is missing, the suite must fail loudly instead of
quietly reporting zero tests.

Every guard the custody window added or touched was mutated one at a time and the suite was re-run
against the rebuilt artifact. The mutants and what killed them are listed in
[`doc/mutation-run.md`](doc/mutation-run.md): the release window and its exact edge, the floor and
the ceiling of the deposit, the status check of `release` and the status check of `refund`, the
refund's deadline check, the close whitelist, and the skipped vault sweep.

One mutant survived at first and it was worth the run. Moving a status variant into the middle of
the enum, which re-points the discriminant of every `Released` and `Refunded` account already on
chain, left the whole suite green: the legacy account test plants status byte 0, and byte 0 stays
byte 0 wherever you insert a variant. Tests E1 to E3 in `escrow-window.ts` close that gap by pinning
each byte to its name and by closing hand-built accounts whose status byte is 1 and 2.

If you mutate the program to check that a test really fails, remember that `anchor deploy` ships
whatever is in `target/deploy/`, it does not compile. Rebuild before deploying anything. We were
bitten by this again during the mutation run: the harness restored the source but not the artifact,
and the next suite run reported failures that had nothing to do with the code on disk.

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
| `.github/workflows/ci.yml` | clippy with `-D warnings`, `anchor build`, the whole test suite | **green** |
| `.github/workflows/verified-build.yml` | rebuilds in the pinned container and compares the result against the program on devnet | **green**, and see the caveat below about what it is claiming right now |

### `verified-build.yml`

Two independent jobs:

`onchain-hash` runs `scripts/onchain-hash.py` against devnet and fails if the deployed bytes
stop matching the two hashes published in this file. No Docker, no toolchain, seconds to run.
It also fires on a weekly schedule, so an unannounced upgrade of the deployed program turns the
workflow red even if nobody pushes.

`reproducible-build` downloads `solana-verify` (checksum pinned), rebuilds inside the container
selected by `[workspace.metadata.cli] solana = "3.1.10"`, and compares the result. It refuses to
compare a value that is not a 64 character hex string, because two empty strings compare equal
and a control that cannot fail is worse than no control.

**What it asserts depends on a declared state**, `SOURCE_REPRODUCES_CHAIN` in the workflow:

| | `true` | `false` (today) |
|---|---|---|
| deployed program == `verify-hash` published above | checked | checked |
| rebuilt `.so` == `artifact-sha256` published above | checked | not checked |
| rebuilt `.so` == program on devnet | checked | **must differ** |

It is set to `false` because the custody window is merged here and not deployed, so a rebuild
cannot match the chain. That is the honest state, and it is worth being precise about what the
flag does and does not do:

- It is **not** a mute switch. With `false` the job *requires* the rebuild to differ from devnet.
  Deploy the program and forget to flip the flag, and the run goes red instead of quietly passing.
- The first row is checked in **both** states and does not depend on the source at all, so an
  upgrade nobody announced still turns the workflow red. That is also what the weekly schedule is
  for.

The assertion block was exercised against injected hashes in all eight combinations: the two
that must pass, and the six that must fail (deployed without flipping the flag, chain moved
unannounced, empty tool output, non-hex garbage, rebuild differing from the chain, rebuild
differing from this file). All eight behaved as expected.

The honest gap: **the byte-for-byte claim is not being re-checked on every run right now.** It was
checked, and passed, at [`36444ef`](https://github.com/ferrosasfp/solana-programs/commit/36444ef0684bfd3da2b91eb9482ea88d8169da22),
the last commit whose source matched the chain. It starts being checked again on every run the
moment the custody window is deployed and the flag flips back to `true`.

### `ci.yml`

Builds the program and runs the whole suite on every push and pull request. **It is green**, in
about nine minutes.

It was red for a while, and not because of the program: the workflow used to build the Anchor CLI
from its repository HEAD, and one of the CLI's own transitive dependencies raised its minimum
supported rustc above the 1.89.0 this repository pins. The job died installing the tool, before it
ever reached `anchor build`. The fix was to install the CLI from crates.io at the exact pinned
version with `--locked`, and to give that one binary a separate modern host toolchain. The program
is still compiled with 1.89.0, because `rust-toolchain.toml` applies inside the checkout.

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

### Before upgrading the deployed program

This version makes `release` illegal from the deadline on. That is the point of the change, and it
is also **a one way door for escrows that are already on chain**. An account sitting in `Deposited`
with its deadline already past can be released by its authority today; at the instant of the upgrade
it cannot be released at all, and the only exit left is the refund, which only the sender can sign.

The funds are never lost. What changes, with no way back, is who holds the exit. That should be a
decision somebody took, not a side effect somebody discovered afterwards.

So, before running the deploy:

```bash
python3 scripts/list-live-escrows.py --url devnet
```

Read only: it signs nothing and sends no transaction. It lists every `EscrowState` account of the
program, decodes it, and flags the ones that are `Deposited` with an expired deadline. Pass
`--exit-nonzero-if-blocking` to use it as a gate in a script.

For each account it flags, do one of two things, and write down which:

1. **Drain it.** Either the authority releases it (still possible until the upgrade lands) or the
   sender refunds it. Both are already reachable with the deployed program. Re-run the script and
   confirm the list is empty.
2. **Decide the refund is the right outcome**, and record the decision, including who was told.

Read at the time of writing, on devnet: four `EscrowState` accounts exist, three are terminal and
one is blocking, `BmHDdjKLCJXcdzd8CqbHaeRWY9utbviZduXhbnH5Jm9F`, holding 10.000000 units of the test
mint with a deadline nine days past. Do not trust that sentence, run the script.

### The size preflight

`anchor deploy` on an upgradeable program writes into the ProgramData account that already exists.
That account was sized when the program was first deployed and **does not grow by itself**. The
binary in this tree no longer fits in it:

| | |
|---|---|
| ProgramData account | `UKjCxFASvoGPp95tdPDH2F3vyyGnQLHAcKiUGpVDpaR` |
| Bytes allocated | 262,613 |
| Loader header | 45 |
| Usable for the binary | 262,568 |
| This tree's `escrow.so` | 270,712 |
| Missing | **8,144** |

Without the extend, the deploy fails inside the loader with a message that never mentions the size,
after uploading the whole binary, and leaves a buffer account holding your SOL. So the deploy script
now runs a read only check first and refuses to continue:

```bash
python3 scripts/programdata-capacity.py \
  --program-id DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x \
  --artifact target/deploy/escrow.so --url devnet
```

It signs nothing and sends no transaction. When the binary does not fit it prints the command,
already filled in:

```bash
solana program extend DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x 8144 --url devnet
```

That number is the exact deficit, which leaves zero headroom: the next build that grows by a byte
needs another extend. Passing a larger number is fine, it costs rent for the added bytes and cannot
be undone.

The numbers above were read from devnet. Re-run the script rather than trusting the table: the
artifact changes with every build.

### The account list of `close` has no safe deployment order

The vault sweep added a `sender_ata` account to `close`. There is **no ordering of the program and
client deploys that avoids a break**: a new client against the old program sends an account the old
program does not expect, and an old client against the new program omits an account the new program
requires. Both directions fail.

What makes it tolerable today, and it is a fact worth checking rather than a promise: **no consumer
builds `close` at all right now.** It is a forward constraint on whoever writes the first one, not a
live cut. If that changes, the client and the program have to be released together, with the escrow
lifecycle drained in between.

## Licence

MIT. See [LICENSE](LICENSE).
