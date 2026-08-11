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
| Source vs deployed | **The WKH-343 deploy has been run: devnet, 2026-08-10, slot `482775110`.** This tree carries WKH-343 — `deposit` requires the beneficiary's associated token account for the escrow's mint, one extra account at the end of `Deposit` — and that is now the deployed binary. Measured by hand the same day: the local build's `.so` is 276800 bytes, 276785 once trailing zeros are stripped, and its sha256 `2bd31779382f0bfc35f8470bc0ca1185c985d4c164fa05ec291658e05eb41bb6` equals the verify-hash read back from the chain, byte for byte. Both things that gated the deploy are resolved: the client sends the new account (`chaski-v3` `f643a64`, checked in the bundle actually served, not only in the source) and the beneficiary in use has its token account (`Cq9AinM9WCry8Pyk5EsFJ2hdQomKAUES7Cq7YLunRGMC`, created in signature `1VfVuqy2…`). The gate itself is written up in `doc/sdd/004-wkh-343-deposito-destinatario-sin-cuenta-token/runbook-deploy.md`. ⚠️ **The hashes in [Deployment](#deployment) still describe the 2026-08-05 build and were not re-read after this deploy** — the one value that was re-read is the verify-hash quoted above. Previous deploys, for the record: WKH-326 (`close` releases the escrow's slot in the index), to devnet on 2026-08-05, in slot `481495859`; and before it the custody window (the release deadline, the deposit floor and ceiling, the vault sweep on `close`), on 2026-08-01 in slot `480496830`; ahead of that one the single live escrow that would have lost its release exit was drained and the ProgramData account was extended because the binary no longer fitted, both written up in [Before upgrading the deployed program](#before-upgrading-the-deployed-program). |
| Money at risk | None in value: devnet, faucet money. **And read on 2026-08-10 at slot `482832547`, nothing is custodied either — which is a reading of a moment, not a property of the program.** That day's sequence, all on chain: four deposits that had been stuck for want of the beneficiary's token account, 40,000,000 raw, were refunded in slots `482579398`..`482580179`; a fifth, `5G4Zaa4RkMysquGpm61ENinp8kzo7Uu3kvpBAxFFwy4` with 5,000,000 raw of Circle's devnet USDC, was refunded in slot `482823756`; and six escrows were then closed with `close`, returning 0.024012 SOL of rent. **That fifth deposit landed in slot `482621992`, which is before the WKH-343 deploy in slot `482775110`**, so it is not the guard failing — it is the guard not being there yet. What is left: **6** `EscrowState` accounts, every vault at 0. **Re-read on 2026-08-11: of the eleven accounts the table under [The mint](#the-mint) lists, six no longer exist at all** — `5G4Zaa4RkMysq…` among them, so that fifth deposit was refunded *and* closed. An account that is gone is not a broken link, it is the expected end state of `close`, and the table below is therefore a dated photograph and not a live list. This row goes stale on its own, without anyone editing it, which is why it carries a slot. See [The mint](#the-mint). Re-measure with `python3 scripts/list-live-escrows.py --url devnet --markdown`; it prints the table under [The mint](#the-mint), not this sentence, so the counts here are read off that table by hand — which is how this row came to say 6/4 while the table said 7/3. |
| Upgrade authority | **Present.** The program is deployed under the upgradeable loader and its authority is a single devnet key. See [Upgrade authority](#upgrade-authority). |
| External audit | **None.** The program has not been reviewed by a third party security firm. |
| Test coverage | 61 tests, all passing locally. Behaviour driven, no fuzzing and no formal verification. On top of those, the custody window was exercised against the deployed program with seven real transactions, including the one that needs a genuinely expired deadline: see [The custody window, exercised against the deployed program](#the-custody-window-exercised-against-the-deployed-program). |
| CI | clippy, `anchor build` and the 61 tests run on every push. See [Continuous integration](#continuous-integration). The standing instruction to **expect `SOURCE_REPRODUCES_CHAIN` to be red** held while this tree carried WKH-343 undeployed; it was deployed on 2026-08-10 (slot `482775110`), so that expectation no longer applies. What was measured by hand that day is the equality itself — the stripped sha256 of the local build equals the chain's verify-hash. What is **not** claimed here is the colour of the job: that needs a run of its own, and none is being reported. |
| Reproducible build | **Confirmed for the binary deployed on 2026-08-05.** A GitHub runner rebuilt this tree in the pinned container on the push that carries these hashes ([run 31058371492](https://github.com/ferrosasfp/solana-programs/actions/runs/31058371492), commit `a0f9c27`) and both jobs passed: `reproducible-build` and `onchain-hash`. What that run establishes is that a machine which is not the developer's produced the same bytes that devnet serves. **What it does not establish: nobody outside this project has repeated any of it.** A GitHub runner is not this laptop, but it is still this project's workflow. See [Reproducing the deployed binary](#reproducing-the-deployed-binary). |
| On-chain IDL | **Published, and as of 2026-08-11 the tree, the chain and both consumers all carry the same text.** Canonical metadata account `7tbJDv1gwseQamg816gEgwTSpsPpgec5yxhYpbTrcdbC`. Measured that day, all four independently: this tree, `anchor idl fetch` off devnet, the facilitator's pin (`src/chains/escrow-idl.hash.test.ts:53`) and `chaski-v3`'s vendored copy (`src/infrastructure/solana/escrow-idl.ts`) each canonicalise to `cc2761266dcf8335a17562129de040805f37f69cfe654f5be472045ba7bfcd51` over 16,020 bytes. `deposit` carries its nine accounts with `beneficiary_ata` last. The value published between 2026-08-10 and 2026-08-11 was `d295b7c74ff9a2ac758e24cc9e7d32d3c09d5943e1b137ef67f4f2692993c70e`, and before the 2026-08-05 deploy `bfbdfe5aedd55d68e6dda4663b5d26daada815c99db03df34a1601fe4a4d3922`; both are kept here so the movement can be audited, and **neither is pinned by anything today**. ⚠️ **Getting to that agreement cost an outage of several hours on 2026-08-11, caused by a script in this repository, and the mechanism is worth more than the fix.** `scripts/publish-idl.sh` opened with an unconditional `close idl`, justified by a sentence written in the script itself claiming the tool "does not overwrite". That sentence was a conjecture, never measured, and it is false: `write` is create-or-update and `update` exists. A guess written in the present tense inside code reads later as a measurement, and this one authorised a destructive step against the only published copy. The script now closes nothing until a verified replacement exists, is a no-op when the on-chain content already matches, and surfaces the tool's errors instead of discarding them. The republication itself needs the upgrade authority's keypair, which is not in this repo. The **binary did not move** across any of this: `target/deploy/escrow.so` hashes to `257083a98deec45816b97e63508e258d9660c7275a31ce8b5326692bb897003e` and is 276800 bytes, so **no program deploy is owed**. `deposit`'s discriminator and its five args did **not** move, and the new account goes last, so no existing account index shifted; how the value is derived is written up in `doc/sdd/004-wkh-343-deposito-destinatario-sin-cuenta-token/idl-hash.md`. The explorer may still not render Anchor IDLs; fetching works regardless. See [Publishing the IDL on chain](doc/publish-idl-onchain.md), including why the documented command fails and what worked instead. **Three doc comments in `lib.rs` are wrong, and the window to fix them is shut again.** Anchor copies doc comments into the IDL, so editing a `///` or `//!` moves the canonical sha256, which now costs a republish on chain plus a re-pin in both consumers — that is why these corrections get parked in adjacent `//` comments instead. WKH-343 opened that window and it was spent on exactly one of them: the mint paragraph, which cited an off-chain co-signer check that does not exist and which that change also contradicts, since `deposit` now enforces a *relational* constraint between the mint and the beneficiary. Still wrong **on chain**, each waiting for a change of its own: "clamped" (the deadline is rejected, not clamped), which belongs to another HU and already has its `//` next to it; and the `MAX_ENTRIES` comment, which sits on a `const` and, measured, never reaches this IDL at all because it has no `constants` section. The third, the `sender_ata` note on `Close`, **is fixed in this tree and not yet on chain**: it used to say *"Hoy ningún consumidor construye `close`"*, false twice over since `chaski-v3` builds `close` (`src/infrastructure/solana-wallet.ts:911`) and six `close` transactions confirmed on devnet on 2026-08-10. It was not corrected in place but **rewritten to stop making that kind of claim at all**: the program now documents its own contract (this account is mandatory, and `close` sweeps the whole vault balance into it) and says that who builds the instruction is a fact of the consumer repos, documented there. A sentence about other repositories, living in this one, goes false without anybody editing this file — which is exactly what happened. The edit is line neutral, 5 lines for 5, so no citation into `lib.rs` moved. |
| Known issues | Written down below, **and three of them are about custody**: a mint with a freeze authority can freeze the vault (and the mint holding every custodied unit today has one), the vault's associated token account can be pre-created by a stranger to block a deposit, and past the deadline an escrow whose sender lost their key has no exit at all. See [Known limitations](#known-limitations). |

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
| Last deployed in slot | `482775110` (2026-08-10, WKH-343) |
| ProgramData bytes reserved | 412613 (extended by 150000 on 2026-08-01; see [The size preflight](#the-size-preflight)) |
| Deployed bytes, without trailing padding | 276785 |
| `sha256` of the same bytes without trailing padding (`verify-hash`) | `2bd31779382f0bfc35f8470bc0ca1185c985d4c164fa05ec291658e05eb41bb6` |
| `sha256` of the deployed bytes (`artifact-sha256`) | `940096242ef430386f9e045aec5ddbe398c683883b2e42fa7d8c8da5d8045032` |

Both hashes above were read back from the chain and reproduced from source, by **two independent
builders**: by hand on 2026-08-10 (`target/deploy/escrow.so` is 276800 bytes, 276785 once trailing zeros
are stripped, and hashing those stripped bytes gives the `verify-hash` in the table), and on 2026-08-11
by the `reproducible-build` job, which rebuilt in the pinned container on a GitHub runner and printed
`built verify hash` == `on-chain verify hash`. Re-derive both with `python3 scripts/onchain-hash.py`.

⚠️ That CI job was **red from 2026-08-10 until 2026-08-11**, and the reason is worth keeping: the
rebuild already matched the chain, but `verified-build.yml` still pinned the hashes of the 2026-08-05
binary. The failure message said the deployed bytes did not match, which points at the chain; what had
actually gone stale was the pin. `verified-build.yml` now carries a step that fails if a pinned hash is
not also published in this file, so the two places cannot drift apart in silence again.

The deploy transaction of the **previous** deploy (2026-08-05, WKH-326, slot `481495859`) was
[`UjFgwnmU…jK7F`](https://explorer.solana.com/tx/UjFgwnmUviG9kRVfCNB1kcKeGQAYxsJkZpKQHycM8o6KFFJhDETfzAQyjccQbXd8TgcasN7gyHazjfWhQudjK7F?cluster=devnet).
The signature of the 2026-08-10 deploy is not recorded here; the slot and the hash above are what was
verified.

The previous deploy, for comparison: slot `480496830`, `verify-hash`
`9d9c0679c3496d09e0d2e067b0e7a63002bf435ddff6256837b9114949f464f1`. That binary had the custody
window but not the index slot release, so its `close` left the escrow's entry in `EscrowIndex`
behind. The one before it, slot `479522576`, 262568 bytes, `verify-hash`
`2c012e78a567584978e48fe1b20cd641d03389ae2e5944402d31eaa548e29779`, had no custody window at all,
so its `release` was legal forever.

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

### The custody window, exercised against the deployed program

The transactions above predate the custody window. After the 2026-08-01 deploy the window itself was
attacked on chain rather than only in the suite, because a test suite runs against a clock it
controls and this one does not. Seven checks, all with real transactions on devnet:

| | What was attempted | Result |
|---|---|---|
| A | deposit with a 2 h window, which is what the client now sends | accepted |
| B | deposit with a 10 minute deadline | rejected, `DeadlineTooSoon` (6006) |
| C | deposit with a 48 hour deadline | rejected, `DeadlineTooFar` (6007) |
| D | `refund` before the deadline | rejected, `DeadlineNotReached` (6003) |
| E | `release` inside the window | accepted, 0.5 to the beneficiary, vault to 0 |
| F | `release` **after** the deadline | rejected, `ReleaseWindowClosed` (6008) |
| G | `refund` after the deadline | accepted, 0.5 back to the sender, vault to 0 |

**F is the whole point of this version** and it is the one that cannot be rushed: the deadline has to
be real, the floor is one hour, and the clock belongs to the validator. The escrow for F and G was
`2eWYonV4PjznByNkLu7u8YLvbZcSh37d4QzreqeTVG14`, deposited with the minimum window and left to expire.
Its refund landed in
[`5BVVG5ST…HcYv`](https://explorer.solana.com/tx/5BVVG5STrNMeRwQQf8f1Mc8st3y5UvWUiEdd1xdjfu3Ciz3DzeK76PCFgkpi36mYj5MQJekW5gWX9pb5BGmsHcYv?cluster=devnet).

B is worth reading twice: it is the exact value the client sent before the same day's fix, so it
doubles as evidence that the incompatibility described further down was real and not hypothetical.

E and G are there because A through D and F only prove the program **refuses** things. A program that
refused everything would pass all five. E and G prove it also pays out, to the right party, in both
directions of the window.

Nothing was left stranded by that upgrade: `list-live-escrows.py --exit-nonzero-if-blocking` exited
0 right after it. Measured again on 2026-08-10 at slot `482593777` it exits **0**, because no escrow
is in `Deposited` at all any more: the four that were past their deadline were refunded by their
sender that day. Do not read a fixed value into this line — the flag reports the state of devnet at
the instant it runs, and that state changes without anybody editing this file (measured: four rows
changed status inside a single session, between slots `482578481` and `482583139`). Run the script;
do not trust the number written here. An escrow whose deadline has passed having only the sender's
refund left is the ordinary end state of this design, written up in
[Known limitations](#known-limitations).

## Reproducing the deployed binary

Everything above tells you what is on chain. This section is about the harder claim: that those
bytes were produced by the source in this repository, and that you can produce them too.

### What you can check right now

> **These hashes describe the binary deployed on 2026-08-05, the WKH-326 one.**
> They were read back from devnet after the upgrade, not predicted from the build. The container
> rebuild that reproduced an *earlier* binary has not been re-run against this one yet, so read
> the confirmation table below carefully: what is proven for this binary is that the deployed bytes
> equal the ones built on the machine that deployed them, and nothing more.

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
455e4e36fa7c63be568d470a89f7eded9aff5806b198340936a578810be09291
```

**`artifact-sha256` stopped being a comparison you can reproduce, and that changed on 2026-08-01.**
Until then the ProgramData account was sized to fit the binary exactly, so the payload on chain was
the binary and its hash equalled `sha256sum target/deploy/escrow.so`. The extend added 150000 bytes
of reserved space, and the loader zero-fills the remainder, so `artifact-sha256` now hashes 412568
bytes of which 137768 are padding. No local build will ever produce it. It is published as a
description of the account, not as a check.

`verify-hash` is the number that still means something, because it is taken after trailing zeros are
trimmed. On the machine that deployed it, `sha256` of `target/deploy/escrow.so` with trailing zeros
removed is exactly `455e4e36...`, which is what devnet reports. That is the comparison to run.

`-u` has to come before the subcommand. It is a global argument read from the top level, and
placed after `get-program-hash` the tool quietly falls back to mainnet, where this program does
not exist.

### What we have and have not confirmed

| | |
|---|---|
| The deployed bytes equal our local `target/deploy/escrow.so` | **Confirmed** for the 2026-08-05 binary, on the machine that built and deployed it: devnet reports `verify-hash` `455e4e36...` and the local artifact (274800 bytes, `sha256` `10d6dd04...`) with trailing zeros trimmed hashes to the same value. The on-chain payload is that file plus 137768 zero bytes of reserved space. |
| The binary carries no path from that machine | **Confirmed.** The only absolute path embedded is inside the precompiled platform-tools, identical for everyone using the same Agave version. |
| A container rebuild reproduces those bytes | **Confirmed for the binary deployed on 2026-08-05.** [Run 31058371492](https://github.com/ferrosasfp/solana-programs/actions/runs/31058371492) on commit `a0f9c27`, the push that carries the current hashes, passed both jobs: `reproducible-build` (the pinned container rebuilt this tree) and `onchain-hash` (the rebuilt bytes compared against devnet). The previous binary was confirmed the same way ([run 30713836991](https://github.com/ferrosasfp/solana-programs/actions/runs/30713836991), `9d9c0679...`). What this does **not** establish: nobody outside this project has repeated it. A GitHub runner is not the developer's machine, but it is still this project's workflow, so the independence it buys is partial. |
| An independent third party reproduced it | **Not confirmed.** Nobody outside this project has tried yet. A GitHub runner is not our laptop, but it is still our workflow. |

So: the mechanism is wired up and public, it was green against the previous binary, and it is
pending against the one on chain right now. What is still missing beyond that is somebody with no
stake in this repository running it and saying so. If it does not reproduce on your machine, that is
a finding we want to hear about.

### Why the build image had to be declared

`solana-verify` picks the Docker image from `[workspace.metadata.cli] solana` in the root
`Cargo.toml`, and only falls back to `Cargo.lock` when that key is absent. The fallback is wrong
for this repository: Anchor 1.x does not depend on `solana-program`, so the lock resolves through
`solana-program-error 3.0.1` and the tool would build with the 3.0.1 image. The deployed bytes
came out of Agave 3.1.10, a different platform-tools, so the comparison would fail for a reason
that has nothing to do with the source. The key is set to `3.1.10`
([`Cargo.toml:20`](Cargo.toml#L20)). It is the one version in this repository that a rebuild
cannot survive being wrong about, so moving it means redeploying and republishing the hashes. The
workflows and the Toolchain table below have to follow it, and `rust-toolchain.toml` does not:
that file pins the host compiler, which was measured not to change the artifact. See the
Toolchain table for the measurement.

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
   requires the escrow to exist, to belong to the signing sender, and to still be `Deposited`. It
   moves zero tokens. Re-registering the same id neither duplicates nor reverts.

   That `Deposited` requirement holds **at the instant of registration and never again**. Two
   instructions remove an entry, and only two: an explicit `deregister_escrow`, and a `close` that
   is given the index account (it is optional there, see below). `release` and `refund` still do
   not touch the index and their account lists do not even name it, so an id stays listed after its
   escrow reaches a terminal state until somebody calls one of those two. An earlier version of this
   line claimed the index "only ever lists live escrows"; it does not, and the cap is still
   dimensioned as if it did. See
   [the index fills up with finished escrows](#known-limitations).

5. **`deregister_escrow(remittance_id)`** removes one id from the caller's own index. It is a
   no op if the id is absent, it moves no tokens, and it deliberately does not require a terminal
   state: requiring one would make entries of already closed escrows impossible to clean up.

Recovery path: derive `["escrow-index", sender]`, one `getAccountInfo`, read `entries`, then
derive `["escrow", sender, entries[i]]` and call the normal `refund`. The authority is not a
party to either instruction and gains no power over the funds.

Entries are not removed when an escrow ends, only when somebody calls `deregister_escrow` or a
`close` carrying the index, so whoever walks that list still has to expect ids whose `EscrowState`
is already terminal or already closed: a `getAccountInfo` on the derived address can come back
`null`, and a `refund` on a terminal one reverts with `EscrowNotDeposited` (6002). Both are normal
results of reading this index, not signs of a corrupted one.

## Instructions

| Instruction | Signer | Effect | Guards |
|-------------|--------|--------|--------|
| `deposit` | sender | creates state + vault, pulls `amount` in | `amount > 0`; `now + 1 h <= deadline <= now + 24 h` |
| `release` | recorded authority | pays the recorded beneficiary | `has_one` on authority, beneficiary, sender, mint; status `Deposited`; **`now < deadline`** |
| `refund` | sender | pays the sender back | `has_one` on sender and mint; status `Deposited`; `now >= deadline` |
| `close` | sender | transfers the whole vault balance to the sender, closes state + vault, rent to sender; removes the id from the sender's index when the optional `escrow_index` account is passed | status in `{Released, Refunded}`; the optional index PDA is seeded by the signer |
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
| 6005 | `EscrowIndexFull` | 33rd `register_escrow` for one sender, counting every id never deregistered, terminal or not |
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

The floor did not fit the client that existed until 2026-08-01, which derived the deadline from a
quote that expires in 10 minutes: every deposit it built would have reverted with
`DeadlineTooSoon`. **That was decided and closed before the deploy, taking option A**: the client
now computes the deadline itself, as `now + 2h`, and no longer reads the quote's expiry for this.
The reasoning and the cost of the alternative are in
[`doc/decisions/deadline-vs-quote-ttl.md`](doc/decisions/deadline-vs-quote-ttl.md).

Two hours rather than the floor exactly, and the reason generalises to any client: the `now` in
`deposit`'s comparison is the **validator's** clock when the instruction executes, not the client's
when it builds the transaction. A client that asks for exactly `now + MIN_CUSTODY_SECS` loses any
transaction that takes more than zero seconds to land. Leave margin.

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

**Who pays what:** The sender (`payer = sender` in the Deposit context) pays the rent to create and
rent-exempt both accounts. The transaction network fee (approximately 0.005 SOL per transaction) is
paid by the key signing the transaction; for deposits initiated by users, that is the sender; for
releases and refunds initiated by the facilitator, that is the facilitator key.

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
Three instructions write it now: `register_escrow`, `deregister_escrow` and `close`. In all three
the index PDA is seeded `["escrow-index", sender.key()]` with `sender` as the signer, so the seeds
themselves are the ownership guard: you cannot name someone else's index without their signature.
`register_escrow` additionally carries `has_one = sender` on the escrow account as defence in
depth. Covered by `escrow-index.ts` tests 4b and 4c, where an attacker fails both to register into
a victim's index and to deregister from it, and by test 15, where the attacker closes an escrow of
its **own** and passing the victim's index still reverts with `ConstraintSeeds`.

**10. The index gives the authority no power and moves no tokens.**
Neither recovery instruction takes an `authority` account and neither performs an SPL transfer.
`escrow-index.ts` test 4a asserts this against the built IDL rather than against the source:
exactly 6 instructions, and neither `register_escrow` nor `deregister_escrow` has an `authority`
account. `escrow-index.ts` test 7 asserts no token balance changes. The count is pinned so that an
instruction nobody reviewed shows up as a red diff.

**11. The index is bounded and idempotent.**
32 entries maximum (`MAX_ENTRIES`); the 33rd **simultaneous** entry reverts with
`EscrowIndexFull`; re-registering an id neither duplicates it nor reverts. Covered by
`escrow-index.ts` tests 5 and 6. The bound is no longer monotonic over the sender's lifetime:
`escrow-index.ts` test 14 runs 33 full `deposit → register_escrow → release → close` cycles with
the same sender, passing the index to each `close`, and the 33rd `register_escrow` confirms. It
reverted with `EscrowIndexFull` before WKH-326. That only holds for senders who do call `close`
with the index; see [known limitations](#known-limitations) for what still fills up.
`EscrowIndex` is the only account created with `init_if_needed`, which is safe here
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

This one is not hypothetical, and it is stated in the past tense on purpose, because the balance it
described is gone. **When this program last custodied anything, the limitation covered 100% of it.**
Measured 2026-08-05 at that time: the escrows then holding funds on devnet were denominated in
Circle's devnet USDC, whose freeze authority is `CJtyoKSLrktozQzjERTiK3btQtiTK3nN4QrqGHLidyCT` and
is not ours. Those vaults were never frozen (`state: initialized`, read the same day) and the
economic exposure was zero: faucet money. Measured again 2026-08-10 at slot `482593777`, **nothing
is custodied**: all 10 `EscrowState` accounts are terminal and none is `Deposited`, so right now the
limitation covers no balance at all. That is a fact about today's devnet, not a property of the
design: the exposure returns with the next deposit on a mint whose freeze authority is not ours. The
measurement and the commands to repeat it are in [The mint](#the-mint).

**The vault's associated token account can be pre-created by a stranger, blocking the deposit.**
`deposit` creates the vault with `init`, not `init_if_needed`. The address is an associated token
account of a PDA derived from `["escrow", sender, remittance_id]`, so anyone who can guess or
observe those 16 bytes can create that account first, for about 0.002 SOL, and then the deposit
fails at account creation for that `(sender, remittance_id)` pair, forever. The workaround is
trivial, use another `remittance_id`, and no funds are ever at risk. It is **pre-existing**, this
branch does not introduce it, and it is one of the first things an external reviewer finds, so it is
written here rather than left to be discovered.

**Rent could be griefed by sending dust to the vault. Fixed, and the fix is live on devnet.**
`release` and `refund` move the recorded amount, so the beneficiary and the sender always get
what they are owed. But the vault is an associated token account at a derivable address, so
anyone can transfer tokens into it. If they did, the leftover balance made `close` fail with the
SPL error `NonNativeHasBalance`, because it calls `CloseAccount` on a non empty account, and the
rent of two accounts stayed dead. `close` now moves the vault balance to the sender before closing
it, covered by `escrow-window.ts` D1 and D1b. The sweep landed before the 2026-08-01 deploy and
shipped with it in slot `480496830`, so the program running on devnet has this behaviour.

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

**Past the deadline, an escrow whose sender lost their key has no exit at all.**
From the deadline on, `release` reverts with `ReleaseWindowClosed` and there is no instruction that
reopens it. The only instruction left that can move the vault is `refund`, and `refund` requires the
sender's signature; `close` requires it too, and only runs from a terminal state. So an escrow that
is still `Deposited` past its deadline and whose sender key is lost or unusable cannot be moved by
anybody: not the beneficiary, not the recorded authority, not us. The funds sit there permanently.
This is **a consequence of the custody window and it is the intended trade**, not a defect: before
the window, the authority could push the payment forward indefinitely, which meant a rescue existed
and also meant the sender's exposure had no end. Bounding the exposure is what closes the rescue,
and for a non custodial escrow that is the right side to land on, since the alternative is an
operator who can move a sender's money at an arbitrary future date. It is written here because the
trade has a cost and the cost lands on whoever holds the sender key. One caveat that cuts the other
way, stated so nobody reads more finality into this than there is: the program is upgradeable, so
its upgrade authority could deploy a version that adds an exit. That is not a property of this
design, it is the operational risk in [Upgrade authority](#upgrade-authority); on a deployment where
that authority has been removed, the dead end is absolute.

One escrow on devnet was in the on-chain half of that state, and it is worth keeping as a **historical**
example because it is the cheapest way to see the shape: `4VopXGzBLyy1LtCm8ms881Vpo45ByApjFoUiZATquLiE`,
`Deposited` with its deadline passed on 2026-08-04, 10 units of Circle's devnet USDC, whose only exit
was a `refund` signed by `4AvAjtPg1aPwJQRvjnY1U9BHbC46rwVc5BY6FuhqUA7P`. That is exactly what
happened, and the account no longer exists: measured 2026-08-10 at slot `482578944` it is **absent**,
and its full history is Deposit (slot `481178461`) → Refund (slot `481455632`) → Close (slot
`482045751`). So it was never stranded — the key was held and the refund was signed. It is what the
stranded state looks like from the outside, and the only difference between the two is off chain:
whether somebody still holds that key. For the live picture, run `list-live-escrows.py`, which flags
this condition and stamps its output with the slot it read.

**The index still fills up for a sender who does not call `close` with it.**
`register_escrow` requires the escrow to be `Deposited`, but it checks that once, when the id is
registered. Since WKH-326 `close` declares an **optional** `escrow_index` account and, when it is
passed, removes the id it is closing; `release` and `refund` still do not touch the index and do not
even list the account. So the cap is no longer a lifetime counter: `escrow-index.ts` test 14 runs 33
`deposit → register_escrow → release → close` cycles with one sender and the 33rd register confirms,
where before it died with `EscrowIndexFull` (6005).

Three ways it still fills up, each refutable with a concrete call:

1. **`close` is not called for every escrow.** It is opt-in, and until 2026-08-10 nobody called it at
   all: grepping both consumers for a `close` builder returned only their vendored copies of the IDL
   (re-run 2026-08-05). That changed — `chaski-v3` builds it and six `close` transactions confirmed on
   devnet on 2026-08-10 — but nothing calls it *automatically*: it is a button a sender presses, one
   escrow and one signature at a time. 32 registered escrows that are never closed still give 6005 on
   the 33rd `register_escrow`.
2. **`close` is called with `escrowIndex: null`.** That is legal and is the right call for a sender
   who never registered anything, but for one who did, the entry stays.
3. **Entries whose `EscrowState` was already closed** before this change cannot be cleaned by
   `close` any more, since the account it closes is gone. `deregister_escrow` remains their only
   exit, and nothing issues that call automatically either.

The cap is still `MAX_ENTRIES = 32`. When it does trigger it matters more than it sounds: the
heaviest supported transaction shape, the one the off-chain co-signer accepts and the one this
README measures at 57,326 compute units, is `deposit` plus `register_escrow` in **one atomic
transaction**, so in that shape the error takes the deposit down with it. A `deposit` sent on its
own still lands, because `deposit` never touches the index. No funds are at risk at any point: the
index holds 16 byte ids and never holds tokens.

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
`4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH`, a single devnet key. This is also the key that pays
the network fee (approximately 0.005 SOL per deposit transaction) for facilitator operations. Today,
one key can replace this program's code on devnet. Anyone can read this in thirty seconds with
`solana program show`, so we would rather state it plainly: **this is a known operational risk.**

That is deliberate for this stage. The program is on devnet, where every balance it holds is faucet
money with no real value (today that is Circle's devnet USDC, not our own test mint: see
[The mint](#the-mint)), and it is still changing, as the two recovery instructions show. An
immutable program is a bad place to discover that a design needs one more instruction.

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

That works against the binary deployed on 2026-08-05. Its `=======BEGIN SECURITY.TXT V1=======`
marker starts at offset 236032 of the dump, and the block carries the contact, the policy URL, the
source repository, and `auditors: None`, which is the honest value and stays that way until it is
not. The offset moves with every build, so grep for the marker rather than seeking to the number.

## The mint

The mint is not hardcoded. It enters every instruction as an account and is recorded in
`EscrowState.mint`, then enforced by `has_one = mint` on every later instruction, so an escrow
can only ever be settled in the mint it was opened with.

That is a decision, not an omission, and it has a condition that would reverse it. The program is
generic escrow infrastructure, while "which token counts as a dollar" is product policy: pinning it
in the binary would mean two builds for devnet and mainnet, two IDLs, two pinned hashes, and a
redeploy to rotate it. So the allow list belongs in the component that sits on the critical path of
every deposit. That control **exists**, in the off-chain co-signer: it compares the deposit's mint
against the one it is configured with and refuses to sign on a mismatch. **What it does not do is
cover every deposit** — it covers the ones that go through it, and a deposit built and signed outside
the sponsor never reaches it. (This paragraph said the control "does not yet exist" until 2026-08-10;
it had existed since 2026-08-04. What is *not* measured from this repository is whether the deployed
service runs that commit.) **What would change this:** the day anything sweeps the chain for deposits and
takes them as good without that co-signature, the mint has to be pinned on chain, because at that
point a self funded deposit with an attacker's mint would enter a product path. The enumerators
that exist today only feed the refund, which is harmless.

Two devnet mints show up around this program and they are easy to confuse:

| Mint | What it is |
|------|-----------|
| `8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q` | Our own 6 decimal test mint, mint authority `4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH`, so we can mint test balances at will. **Freeze authority: none at all** (`freezeAuthority: null`), so no third party can freeze a vault holding it. |
| `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Circle's USDC devnet mint, 6 decimals, mint authority `GrNg1XM2ctzeE2mXxXCfhcTUbejM8Z4z4wNVTy2FjMEz`, which is not ours. **Freeze authority `CJtyoKSLrktozQzjERTiK3btQtiTK3nN4QrqGHLidyCT`, which is not ours either.** |

**Which one the escrow actually holds.** Everything from the next line to the end of the table is the
**verbatim output** of

```bash
python3 scripts/list-live-escrows.py --url devnet --markdown
```

⚠️ **Measured 2026-08-11: that command does not run today, and the reason is not in this repository.**
It needs `getProgramAccounts`, and both endpoints within reach refuse it for different reasons: the
public `https://api.devnet.solana.com` answers `HTTP 429 Too Many Requests` under normal congestion,
and the dedicated provider this project moved to on 2026-08-11 answers
`getProgramAccounts is not available on the Free tier`. So the refresh instruction above is currently
a dead end, and the table under it cannot be regenerated until an endpoint that serves
`getProgramAccounts` is available — a second key without a domain allowlist, a paid tier, or the public
endpoint on a quiet day with backoff. **This is a real gap and not a cosmetic one**: this script is what
answers "which escrows are stuck and can the beneficiary receive", and it gates the deploy.

all eight columns of it, pasted unedited, so that refreshing it is a copy and not a transcription. It
stamps itself with the slot it read, so a refreshed row cannot silently lose its date.

⚠️ The previous version of this paragraph said the table was "not typed by hand: it is the output of"
that command, and **it was not**: the command emits eight columns and the table had six, with the mint
replaced by the labels `test mint` / `Circle`. The data were right and the provenance was false, which
is the worse of the two failures: it offered generation as the guarantee against going stale, while
anybody who ran the command got eight columns that did not fit and would have transcribed by hand
again — the same mechanism that had already left two versions of this paragraph wrong. If you shorten
the table, say that you did.

measured 2026-08-10 11:00:33Z at slot 482622899 against https://api.devnet.solana.com, program DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x

| escrow | status | amount (raw) | mint | beneficiary | deadline | beneficiary can receive | exit |
|---|---|---|---|---|---|---|---|
| `5G4Zaa4RkMysquGpm61ENinp8kzo7Uu3kvpBAxFFwy4` | Deposited | 5000000 | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | `Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq` | 2026-08-10 12:55:42Z | **NO** | live until 2026-08-10 12:55:42Z |
| `2eWYonV4PjznByNkLu7u8YLvbZcSh37d4QzreqeTVG14` | Refunded | 500000 | `8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q` | `Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq` | 2026-08-01 18:58:23Z | yes | terminal |
| `2zWkoznm86cqX6bWExsR3Wvw5njffDpxuCJCXTsT7LWb` | Refunded | 5000000 | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | `Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq` | 2026-08-09 17:07:45Z | **NO** | terminal |
| `4YRtEL1RGuu5zkSYwMUrkEJajbFLbJFKsojMNEoHxVPo` | Refunded | 1000000 | `8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q` | `Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq` | 2026-07-27 22:08:03Z | yes | terminal |
| `93ZUG1zdVrUTHv4zuup1wDCPdYrXa8QegU42D4rfzuJL` | Released | 500000 | `8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q` | `Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq` | 2026-08-01 19:56:59Z | yes | terminal |
| `BSj3YUJUc98w89ckWb96shfRv4sakJuu4BjfKuhmvgdq` | Refunded | 5000000 | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | `Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq` | 2026-08-08 09:29:54Z | **NO** | terminal |
| `BmHDdjKLCJXcdzd8CqbHaeRWY9utbviZduXhbnH5Jm9F` | Refunded | 10000000 | `8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q` | `Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq` | 2026-07-22 21:48:46Z | yes | terminal |
| `Crqz6hQoChPaP3TVPU4H7kbXo4FPUXz3NzriG3JYmWdw` | Refunded | 20000000 | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | `Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq` | 2026-08-05 21:31:48Z | **NO** | terminal |
| `DHc1DYrSm2QeWe6txAs5NnDSzKYeXcCC1WUwviHk11oj` | Released | 2000000 | `8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q` | `Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq` | 2026-07-27 23:20:29Z | yes | terminal |
| `GXY2todK6pJPdT8h1EcRNZgFX7cZXEnDN7L3XSHCHY2J` | Released | 10000000 | `8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q` | `Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq` | 2026-07-22 18:36:14Z | yes | terminal |
| `HnzegD1fxPNpp7DadNWpStS2a5siSVXVXWV2dykJx3uS` | Refunded | 10000000 | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | `Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq` | 2026-08-08 03:12:27Z | **NO** | terminal |

11 escrow_state account(s) total; 0 refund-only; 1 with an unpayable beneficiary.

Eleven `EscrowState` accounts, six on our test mint (`8yRX3fZ2…`) and five on Circle's (`4zMMC9sr…`).
Ten are terminal — seven `Refunded`, three `Released` — and **one is `Deposited`**: the first row,
5,000,000 raw of Circle's USDC, still inside its release window and with `beneficiary can receive:
**NO**`.

⚠️ **That row appeared while this HU was under review**, between slot `482620696` (when this table read
eleven-minus-one and every account was terminal) and `482622899`. It is the incident this change
prevents, happening again against the binary that was deployed **at that time**, which did not have the
guard. ⚠️ **This clause used to end "the guard is in `deposit` and the deploy has not run", and by the
time anyone read it that was false**: the WKH-343 deploy landed in slot `482775110`, and this table was
read at slot `482622899`, which is *earlier*. So the file contradicted itself, one screen apart, and
the contradiction was created by the deploy and not by an edit. That is the same failure this section
is about. Nothing about the incident is hypothetical, and nothing in this
repository caused it. Two earlier versions of this paragraph counted eight accounts and named two of
them as the only ones still `Deposited`; those two addresses are now absent from the chain entirely.
This is the clearest case in the repo of a paragraph that goes stale with nobody editing it — the
paste-from-a-command lowers the cost of refreshing it, and **does not** stop it going stale.

The `beneficiary can receive` column is the WKH-343 check, and it is the useful one: all eleven escrows
share one beneficiary (`Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq`), whose **canonical associated
token account** exists for our test mint (`BQC6fXinyR4KnESJso1oY8nnbQjXjbFAJb221V7UkiVe`) and does
**not** exist for Circle's (`Cq9AinM9WCry8Pyk5EsFJ2hdQomKAUES7Cq7YLunRGMC`). The five rows on Circle's
mint are exactly the five deposits that could not be released, because `release` requires that one
address and does not create it — four already refunded, and one still holding tokens. Creating that
account is one transaction, payable by anyone, and it needs no signature from the beneficiary.

The word "canonical" is doing work there. The column asks for the derived ATA address, not for "does
the beneficiary hold this mint somewhere": the program compares the address
(`associated_token::`) and rejects any other token account of the same owner and mint with
`ConstraintAssociated`. Until the WKH-343 fix pack this script asked the looser question and would have
answered `yes` on an input the program rejects; measured in
`doc/sdd/004-wkh-343-deposito-destinatario-sin-cuenta-token/fix-pack-blq-med-1.txt`.

Existing is not sufficient either, and the column now separates the two `NO`s, because **who can fix
them is not the same**. An ATA that does not exist is one transaction away, payable by anyone, without
the beneficiary's signature. An ATA that exists and is **frozen** is nobody's to fix on this side: the
account constraints still pass, so a `release` can be built, and the SPL transfer is what reverts, with
`AccountFrozen`. Only the mint's freeze authority can lift it — and on the mint that has actually held
custody here, that authority is not ours (see the table above). A frozen row prints `**NO** (frozen)`.

⚠️ **What that does NOT establish.** The mint and the sender co-vary perfectly: the six rows on our
mint came from `8tJVcM2JehYkyPLHUZ3rxNvhfADaQdHx7xaJw6kS6ux8` and the five on Circle's from
`4AvAjtPg1aPwJQRvjnY1U9BHbC46rwVc5BY6FuhqUA7P` — the new `Deposited` row included, which is the fifth.
With eleven rows and that confounding, the data still do **not** separate "the mint is the problem" from
"which client build made the deposit is the problem". What *is* measured is that the beneficiary cannot
explain it: it is byte for byte the same in all eleven rows, including the three that were paid. One
deposit from the first sender on Circle's mint, or the reverse, would separate them; none exists.

That distinction matters because [Known limitations](#known-limitations) names a mint's freeze
authority as the only path to permanent entrapment we know of. Our test mint has no freeze authority
to use; Circle's devnet mint has one and it is not ours. Every balance this program has custodied has
been on that mint, so that limitation has covered 100% of it — **including the 5,000,000 raw that was
still custodied when this paragraph was first written, and which was refunded on 2026-08-10 in slot
`482823756`.** What it costs today is still zero in value: devnet, faucet balances, and no vault has
been frozen (`state: initialized` on both vaults of the day, read 2026-08-05; no vault's own state is
asserted here — `scripts/list-live-escrows.py` reports the *beneficiary's* account state, not the
vault's). The exposure is real in kind, and it stopped being hypothetical with a deposit this
repository did not make — which is the point: it returns with the next deposit, not with an edit to
this file, and the fact that nothing is custodied at this moment is not a property of the program.

Both facts are one command each:

```bash
python3 scripts/list-live-escrows.py --url devnet     # prints the mint of every EscrowState

curl -s https://api.devnet.solana.com -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo",
       "params":["4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",{"encoding":"jsonParsed"}]}'
```

The second one prints `freezeAuthority` for whatever mint you put in it, `null` included.

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

Last measured run: **61 passing**, in about 5 seconds.

| Suite | Tests | What it covers |
|-------|-------|----------------|
| `tests/escrow.ts` | 16 | deposit, release, refund, close, the state machine, the 154 byte canary, and the WKH-343 group: `deposit` requiring the beneficiary's associated token account, plus the test that shows the limit of that guard |
| `tests/escrow-index.ts` | 25 | the index, attacker paths, legacy account compatibility, IDL shape, the entry cap, rent and compute cost, and `close` removing its own entry |
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

| Tool | Version | Compiles the deployed binary? |
|------|---------|-------------------------------|
| rustc, host | 1.89.0, pinned by `rust-toolchain.toml` | No. It runs clippy and the host side tests |
| rustc, platform-tools | 1.89.0-dev, LLVM 20.1.7, shipped inside Agave 3.1.10 | **Yes.** `cargo-build-sbf` overrides `rust-toolchain.toml` with a `+solana` rustup override |
| solana-cli (Agave) | 3.1.10, declared in `[workspace.metadata.cli]` so `solana-verify` picks the matching build image | It selects the row above, so moving it moves the bytes |
| anchor-cli | 1.1.2, in `Anchor.toml:4` and `ci.yml:15` | It drives the build, it is not the compiler |

The host pin and the compiler that produces `escrow.so` are two different things, and only one of
them can change the artifact. Measured on 2026-08-06 rather than assumed: with
`target/sbpf-solana-solana` deleted, `anchor build` was run twice, once with
`channel = "1.89.0"` and once with `channel = "stable"` (rustc 1.97.1). Both runs produced
`escrow.so` with `sha256` `10d6dd04...` and `verify-hash` `455e4e36...`, the value devnet holds.
So a `rust-toolchain.toml` that disagrees with this table does **not** break the reproduction. It
breaks the MSRV check: 1.89.0 is what makes `rust-version = "1.89.0"` in `Cargo.toml` a claim
clippy actually compiles, and a newer channel can also fail `-D warnings` on lints that did not
exist in 1.89.0.

What does break the reproduction is `[workspace.metadata.cli] solana`, because it picks the
platform-tools that emit the bytes. `README.md:196` is the same fact seen from the artifact: the
only absolute paths embedded in `escrow.so` come from `platform-tools/.../out/rust/library/`,
never from the host toolchain directory.

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

| | `true` (today) | `false` |
|---|---|---|
| deployed program == `verify-hash` published above | checked | checked |
| rebuilt `.so` == `verify-hash` published above | checked | not checked |
| rebuilt `.so` == program on devnet | checked | **must differ** |

It was set back to `true` on 2026-08-01, when the custody window was deployed and the source
stopped being ahead of the chain, and it stayed `true` through the 2026-08-05 WKH-326 deploy, whose
hashes were re-read from the chain in the same commit that publishes them here. What the flag does
and does not do:

- It is **not** a mute switch. With `false` the job *requires* the rebuild to differ from devnet.
  Deploy the program and forget to flip the flag, and the run goes red instead of quietly passing.
- The first row is checked in **both** states and does not depend on the source at all, so an
  upgrade nobody announced still turns the workflow red. That is also what the weekly schedule is
  for.

**One comparison changed shape, and it is worth saying why rather than letting it look like a
weakened control.** The middle row used to compare the rebuilt `.so` against `artifact-sha256`.
The 2026-08-01 extend padded the ProgramData account, so `artifact-sha256` is no longer reachable
from any local build and that comparison would now fail forever for a reason unrelated to the
source. It was replaced by the same comparison against `verify-hash`, which is still reproducible.
The job it was doing is preserved: pinning the rebuild against this file is what catches somebody
editing the published hashes to match a chain that moved, and `verify-hash` does that just as well.

The assertion block was exercised against injected hashes in all eight combinations: the two
that must pass, and the six that must fail (deployed without flipping the flag, chain moved
unannounced, empty tool output, non-hex garbage, rebuild differing from the chain, rebuild
differing from this file). All eight behaved as expected. That exercise predates the change to the
middle row, so the injected-failure sweep has not been repeated against its new form. What has run
against the new form is the real thing, and it passed.

**The byte-for-byte claim was green for the 2026-08-01 binary, and is pending for the one deployed
on 2026-08-05.** [Run 30713836991](https://github.com/ferrosasfp/solana-programs/actions/runs/30713836991),
the first one after the 2026-08-01 deploy, printed:

```
built verify hash      9d9c0679c3496d09e0d2e067b0e7a63002bf435ddff6256837b9114949f464f1
on-chain verify hash   9d9c0679c3496d09e0d2e067b0e7a63002bf435ddff6256837b9114949f464f1
ok   deployed program == the verify hash published in README.md
ok   rebuilt artifact == the verify hash published in README.md
ok   rebuilt artifact == the program deployed on devnet
```

Three checks, all with `SOURCE_REPRODUCES_CHAIN=true`, so none of them was skipped by the flag.

For the WKH-326 binary the same three assertions are what the push carrying `455e4e36...` has to
turn green. What already ran locally before that push is the cheap half: `onchain-hash.py` with the
new pins exits 0, and `solana-verify get-executable-hash` on the local artifact prints the same
`455e4e36...` that `get-program-hash` reads off devnet. The part only the runner can add is that a
rebuild in the pinned container, on a machine that is not the one that deployed, lands on it too.

### `ci.yml`

Builds the program and runs the whole suite on every push and pull request. **It is green**, in
about nine minutes.

It was red for a while, and not because of the program: the workflow used to build the Anchor CLI
from its repository HEAD, and one of the CLI's own transitive dependencies raised its minimum
supported rustc above the 1.89.0 this repository pins. The job died installing the tool, before it
ever reached `anchor build`. The fix was to install the CLI from crates.io at the exact pinned
version with `--locked`, and to give that one binary a separate modern host toolchain. That second
toolchain cannot leak into the artifact: `cargo +stable` is scoped to the install command, and the
`.so` is emitted by the platform-tools rustc either way (see the Toolchain table). What the
1.89.0 checkout override still buys is the clippy run on the declared MSRV.

**Lints.** `cargo clippy --all-targets -- -D warnings` now runs before anything else, and the
tree passes it. `cargo fmt` does **not** run and is not enforced: the program does not currently
pass `cargo fmt --all -- --check`, mostly comment alignment and two multi line reformats in
`programs/escrow/src/lib.rs`. Reformatting the program to make a build infrastructure change go
green would have meant touching the source this repository exists to keep verifiable, so the
check was left out and written down here instead. Adding it means one formatting commit first.

## Deploying

```bash
./scripts/deploy-devnet.sh <path to the upgrade authority keypair>
# or: DEPLOY_KEYPAIR=<path> ./scripts/deploy-devnet.sh
```

Devnet only. The script pins the cluster explicitly so an ambient CLI config cannot redirect it,
and **the keypair is an argument with no default**, which it did not use to be.

`anchor deploy --provider.cluster devnet` pins the network and not the wallet, so Anchor used to
fall back to `wallet` in `Anchor.toml`, `~/.config/solana/id.json`. On 2026-08-05 that file did not
exist on the deploying machine and the run died with `Unable to read keypair file` after the size
preflight had already passed, which reads like the preflight broke something. The failure the
default could have produced instead is worse: had the file existed with a different key inside, the
whole binary would have been uploaded and the upgrade would have failed inside the loader for lack
of authority, an error that never mentions the wallet.

So the script now refuses to guess. Before anything is sent it reads the upgrade authority off the
chain, prints it, and aborts if no keypair was given, if the path does not exist, or if
`solana address -k` on it does not equal what devnet expects. The abort names both keys, so the
reader knows which one to go find. All three refusals were exercised, including the mismatch, with
a throwaway keypair.

### Before upgrading the deployed program

This version makes `release` illegal from the deadline on. That is the point of the change, and it
is also **a one way door for escrows that are already on chain**. An account sitting in `Deposited`
with its deadline already past can be released by its authority today; at the instant of the upgrade
it cannot be released at all, and the only exit left is the refund, which only the sender can sign.

The funds are never lost. What changes, with no way back, is who holds the exit. That should be a
decision somebody took, not a side effect somebody discovered afterwards.

"Never lost" is exact only while the sender can still sign. The refund is the last exit, so if the
sender's key is lost the escrow becomes unreachable by everyone, permanently. That is the trade the
custody window makes and it is written up in
[Known limitations](#known-limitations).

So, before running the deploy:

```bash
python3 scripts/list-live-escrows.py --url devnet
```

Read only: it signs nothing and sends no transaction. It lists every `EscrowState` account of the
program, decodes it, and flags two separate conditions: the ones that are `Deposited` with an expired
deadline, and the ones whose recorded beneficiary has no token account for the escrow's mint. Pass
`--exit-nonzero-if-blocking` to use the first as a gate in a script (that flag's name is historical;
see the script's docstring).

For each account it flags, do one of two things, and write down which:

1. **Drain it via the exit that is actually legal.** ⚠️ If the deadline has already passed, `release`
   is **not** an option: since the WKH-326 deploy (2026-08-05, slot `481495859`) `release` past the
   deadline reverts with `ReleaseWindowClosed`, so sending one is not a recovery, it is a transaction
   that fails. Past the deadline the only exit is the **sender's `refund`**. Inside the window either
   works — but if the script says `beneficiary can receive: NO`, a `release` cannot even be built
   until somebody creates the beneficiary's associated token account for that mint, which is one
   transaction payable by anyone. Re-run the script and confirm the list is empty.
2. **Decide the refund is the right outcome**, and record the decision, including who was told.

**What was actually done, on 2026-08-01, before the upgrade.** The script found four `EscrowState`
accounts, three terminal and one blocking: `BmHDdjKLCJXcdzd8CqbHaeRWY9utbviZduXhbnH5Jm9F`, holding
10.000000 units of the test mint with a deadline nine days past. Option 1 was taken, and the exit
chosen was **the refund**, in tx
[`kMF1DtacRjmreipiN7ce1vgLYB1GmPjRLuP64Jqf17J6tbKEix6h5gsT5nidNf6vEt7QJ544cctEJNAwbH522cE`](https://explorer.solana.com/tx/kMF1DtacRjmreipiN7ce1vgLYB1GmPjRLuP64Jqf17J6tbKEix6h5gsT5nidNf6vEt7QJ544cctEJNAwbH522cE?cluster=devnet).
The vault went from 10 to 0 and the sender from 78 to 88.

The refund was chosen over the release for two reasons. It is legal both before and after the
upgrade, so the outcome does not depend on when the deploy lands, which removes the one way door
entirely rather than racing it. And it is what the account meant: the deadline had passed and
nobody had completed the fiat leg.

The `remittance_id` needed to rebuild the instruction was not on file. It was read out of the
original deposit transaction's instruction data, bytes 8 to 24, and the script that sent the refund
aborted unless the PDA derived from it matched the blocking address exactly.

After that, `list-live-escrows.py --exit-nonzero-if-blocking` exited 0: no escrow was `Deposited`
with an expired deadline. Do not trust these sentences, run the script.

### The size preflight

`anchor deploy` on an upgradeable program writes into the ProgramData account that already exists.
That account was sized when the program was first deployed and **does not grow by itself**. Before
2026-08-01 the binary in this tree no longer fitted in it:

| | Before the extend | After |
|---|---|---|
| ProgramData account | `UKjCxFASvoGPp95tdPDH2F3vyyGnQLHAcKiUGpVDpaR` | same account |
| Bytes allocated | 262,613 | 412,613 |
| Loader header | 45 | 45 |
| Usable for the binary | 262,568 | 412,568 |
| This tree's `escrow.so`, on 2026-08-01 | 271,136 | 271,136 |
| | **8,568 missing** | **141,432 of headroom** |

The artifact has grown since: the binary deployed on 2026-08-05 is 274,800 bytes, so the headroom
is 137,768 today. The preflight is what measures it, not this table.

Without the extend, the deploy fails inside the loader with a message that never mentions the size,
after uploading the whole binary, and leaves a buffer account holding your SOL. So the deploy script
runs a read only check first and refuses to continue:

```bash
python3 scripts/programdata-capacity.py \
  --program-id DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x \
  --artifact target/deploy/escrow.so --url devnet
```

It signs nothing and sends no transaction. When the binary does not fit it prints the command,
already filled in, using the exact deficit.

**What was run, and why not the exact deficit.** The command executed was

```bash
solana program extend DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x 150000 --url devnet
```

The deficit was 8,568. Passing exactly that leaves zero headroom, so the next build that grows by a
single byte needs another extend, and an extend cannot be undone. 150,000 buys room for roughly half
the current binary again, which covers the next phase without repeating an irreversible operation.
It cost **1.044 SOL** of additional rent, taking the account's rent-exempt minimum from 1.82867736 to
2.87267736 SOL. On devnet that is faucet SOL; **on mainnet that number is real money and should be
budgeted before the first deploy**, because sizing the account generously up front is cheaper than
extending it later.

One side effect worth knowing, because it silently invalidates a check: after an extend, the
`artifact-sha256` published for the program stops being reproducible from a local build. See
[Reproducing the deployed binary](#reproducing-the-deployed-binary).

The numbers above were read from devnet. Re-run the script rather than trusting the table: the
artifact changes with every build.

### The account list of `close` has no safe deployment order

The vault sweep added a `sender_ata` account to `close`, and WKH-326 added a **second** one,
`escrow_index`, last in the list. There is **no ordering of the program and client deploys that
avoids a break**: a new client against the old program sends accounts the old program does not
expect, and an old client against the new program omits `sender_ata`, which the new program
requires. Both directions fail. The second account is milder than the first only in that it is
optional in the program: a client that always sends `escrowIndex: null` matches the new program's
list. It still does not match the old program's list, which has six accounts and not seven.

What made it tolerable was a fact rather than a promise, and **on 2026-08-10 that fact expired.**
Until then no consumer built `close` at all, so the mismatch was a forward constraint on whoever
wrote the first one and not a live cut. There is now a consumer: `chaski-v3` builds `close` with
both accounts (`src/infrastructure/solana-wallet.ts:911`, `senderAta` derived at `:901`,
`escrowIndex` chosen by an explicit ternary at `:925`), and **six `close` transactions confirmed on
devnet that day**, taking this program's `EscrowState` accounts from 12 to 6 and returning 0.024012
SOL of rent to the sender. So the conditional above is now the live rule: any further change to this
account list has to release the client and the program together, with the escrow lifecycle drained in
between.

⚠️ The `///` doc comment on `sender_ata` in `Close` still carries the expired sentence
(*"Hoy ningún consumidor construye `close`"*), and it is left there on purpose. Anchor copies doc
comments into the IDL, so editing it moves the canonical sha256 and costs a republish on chain plus a
re-pin in both consumers; and the usual workaround, a `//` correction next to it, would shift every
line number below it in a file this repo cites by line from three other places. It is listed with the
other wrong doc comments in [Status, honestly](#status-honestly), and this section is the correction.

Checked again on 2026-08-01, before the deploy, by grepping both consumers. `chaski-v3` carries
`close` in its vendored IDL and never invokes it; `wasiai-facilitator` signs `release` and reads
`EscrowState`, and does not touch `close` either. So the deploy went ahead in the only order that
was safe for everything else: consumers first, program second.

Re-grepped on 2026-08-05 over the four consumer repos for anything that builds this instruction:
still zero. The only hit outside vendored IDLs is
`chaski-v3/src/infrastructure/settlement/solana-deposit-beneficiary.test.ts:123`, which reads
`close`'s **discriminator** from the vendored IDL to build a transaction that is deliberately not a
deposit. Anchor derives that discriminator from the instruction **name**, not from its account list,
so adding an account does not move it and that test is unaffected.

### What the consumers needed before this could be deployed

The custody window is not backward compatible with a client that asks for a short deadline, and one
did. `chaski-v3` derived the escrow deadline from `quote.expiresAt`, and the FX quote lives for ten
minutes, which is below `MIN_CUSTODY_SECS`. Deploying the program without touching the client would
have turned **every** Chaski deposit into `DeadlineTooSoon`.

The two ideas had been conflated: when the *rate* expires is not how long the operator has to
deliver. `chaski-v3` now sends `now + 2h` and no longer reads `expiresAt` for this, and both
consumers re-pinned the IDL. That went out before the program, which is safe in that order because
a longer deadline was always legal under the old program.

## Licence

MIT. See [LICENSE](LICENSE).
