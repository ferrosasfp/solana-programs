# Mutation run: every guard broken on purpose, one at a time

A test that does not fail when you break the thing it claims to protect proves nothing. So each
guard in the program was broken, the program was rebuilt, and the whole suite was run against the
rebuilt artifact. What is recorded below is which tests died, by name.

Run on 2026-07-31 against `feat/ventana-de-custodia`, baseline **43 passing, 0 failing**.

**Method, and the part that is easy to get wrong:** the driver patches
`programs/escrow/src/lib.rs`, runs `anchor build`, runs the three suites, and then restores the
source **and rebuilds the artifact**. `anchor deploy` and the bankrun harness both ship whatever is
in `target/deploy/`, they do not compile, so restoring only the source leaves a mutated binary in
place and the next run reports failures that have nothing to do with the code on disk. This repo has
been bitten by that twice. The driver ends by rebuilding and asserting that the set of passing test
titles is byte for byte the baseline set again, which it was.

| # | Mutant | Result | Tests that died |
|---|--------|--------|-----------------|
| M1 | `release`: status guard deleted | KILLED | `escrow.ts` 5; `escrow-window.ts` C1, C4 |
| M2 | `release`: window guard deleted | KILLED | B2, B3, B4 |
| M3 | `release`: `now < deadline` widened to `<=` | KILLED | B2, B3 |
| M4 | `refund`: status guard deleted | KILLED | C2, C3 |
| M5 | `refund`: status guard widened to `!= Released` | KILLED | C3 |
| M6 | `refund`: deadline guard deleted | KILLED | `escrow.ts` 3; B1, B3 |
| M7 | `deposit`: custody floor deleted | KILLED | A1, A1b |
| M8 | `deposit`: floor edge `>=` narrowed to `>` | KILLED | A1b |
| M9 | `deposit`: custody ceiling deleted | KILLED | A2, A2b, A2c |
| M10 | `deposit`: ceiling edge `<=` narrowed to `<` | KILLED | A2b |
| M11 | `close`: terminal whitelist deleted | KILLED | `escrow.ts` 7; D2 |
| M12 | `close`: whitelist replaced by `!= Deposited` | **SURVIVED** | none, and it cannot be otherwise, see below |
| M13 | `close`: vault sweep skipped | KILLED | D1, D1b |
| M14 | `EscrowStatus`: a variant inserted in the middle | KILLED | E1, E1b, E2 |
| M15 | `close`: body of the `if let Some(index)` emptied (the retain deleted) | KILLED | `escrow-index.ts` 12, 14, 21 |
| M16 | `close`: `retain(\|e\| *e != remittance_id)` flipped to `==` | KILLED | `escrow-index.ts` 12, 14, 18, 21 |
| M17 | `close`: the retain replaced by `entries.clear()` | KILLED | `escrow-index.ts` 12, 18 |
| M18 | `close`: `if let Some(index)` replaced by `.as_mut().unwrap()` | KILLED | `escrow-index.ts` 13, 13c, 21; `escrow.ts` 8; D1, D1b, E2, E3 |
| M19 | `Close`: `seeds` and `bump` removed from the `escrow_index` account | KILLED | `escrow-index.ts` 13b, 15 |

## The five of WKH-326 (2026-08-05)

Run on `feat/326-cap-del-indice-liberado-en-close`. Same protocol as the M1..M14 run, plus one extra
check: before starting, the md5 of `target/deploy/escrow.so`, `target/idl/escrow.json` and
`programs/escrow/src/lib.rs` was recorded, and after restoring **and rebuilding** each mutant the
three md5 were compared against that reference rather than assumed.

**These five were measured twice, and the table above holds the second measurement.**

1. First pass, baseline **54 passing, 0 failing** (the 43 above plus the 11 tests of the HU), on the
   tree of commit `bdd9d92`. Reference md5 `70480969808b8fd839f3b8bfe1d8775b` /
   `c8e10be9a38bd96b4f0e2ebb422c0c28` / `2e56fb6a09006c304c2132d5b42eebf6`, identical after all five.
   **The five raw captures in
   `doc/sdd/003-wkh-326-cap-del-indice-liberado-en-close/w4/M*-summary.txt` are from THIS pass, all
   five of them, and none was re-recorded afterwards.** Read them against this list, not against the
   table above: two of them disagree with the table on purpose, and that disagreement is the point of
   the fix pack. Each file now carries a header saying so; the cheap way to tell the passes apart
   without trusting any prose is that `passing + failing` is 54 in a first-pass capture and 55 in a
   second-pass one.
2. Second pass, after the review fix pack, baseline **55 passing, 0 failing** (test 13c is the new
   one), on the tree of commit `0fdec52`. Reference md5 `d4b736cf6b9e15421e7cb1d75f3d8e0d` /
   `c8e10be9a38bd96b4f0e2ebb422c0c28` / `e21a3f5e7d06ed83869d6a780c6bbe20`, identical after all
   five. The `.so` differs from the first pass because the W5 comments moved the constraint line
   numbers the binary embeds; no logic changed (see
   `doc/sdd/003-wkh-326-cap-del-indice-liberado-en-close/idl-hash.md`). **This pass has no raw
   captures under `w4/`**: its results are the table above and the two bullets below, and it was not
   re-run to produce evidence files.

The re-run is not ceremony: the fix pack touched two of the tests this table is about, and it moved
two rows.

- **M16 gained test 14.** Test 14 used to assert `max(entries per cycle) <= 1`. Under M16 the series
  is stable at 1 — the close keeps the id it just closed and drops the others, so the index holds
  exactly one entry at the end of every cycle — so `<= 1` passed and the mutant walked through the
  most expensive test in the suite. Tightened to `equal(0)`, which is what the fixed program actually
  produces, 14 dies with M16. Measured, not reasoned: 3 failing before, 4 after. The "before" is
  `w4/M16-summary.txt`, which is the one capture that most visibly contradicts the table — correctly
  so, because it predates the change.
- **M18 gained test 13c.** 13c is a `close` with `escrowIndex: null` on a sender whose index does
  exist, so it hits the same `unwrap()` on `None`. Same mechanism as the other seven, one more
  witness. 7 failing before (`w4/M18-summary.txt`), 8 after.

The other three rows (M15, M17, M19) came back byte for byte the same set of dead tests in both
passes.

Two of the five are the ones worth having:

- **M16** is the silent one. The transaction still confirms and the accounting ends up wrong: the
  index keeps the id that was just closed and drops the ones that are still open. A test that only
  checked "the close succeeded" would have called it green. Test 12 asserts the exact contents of
  `entries` (`[B]`), which is what turns it red.
- **M19** is the security one. Without the seeds, `close` accepts any account of type `EscrowIndex`,
  so a caller can edit somebody else's index. Test 15 does exactly that with a terminal escrow of
  the attacker's own, so the only thing left to reject is the index, and it stops reverting with
  `ConstraintSeeds`.

Two details worth writing down because they are not obvious from the table:

- M15 and M16 also kill test 21, whose last assertion is that the index is empty after both closes.
  That is a side effect of how 21 is written, not a second guard: 21 exists to report compute units.
- **M18 kills 21 for a different reason, and the difference matters.** M18 never reaches that last
  assertion. The second `close` of test 21 passes `escrowIndex: null`
  (`tests/escrow-index.ts:1255-1258`, the `withoutIndex` call; published as `:1206-1209`, which is the
  tail of a different test, and re-read 2026-08-15), and with `if let Some(index)` replaced by
  `.as_mut().unwrap()` the `unwrap()` on `None` panics, so that transaction fails inside
  `processIxs` before any assertion runs. That is the same reason M18 also kills 13, D1, D1b, E2, E3
  and `escrow.ts` 8: every one of those is a `close` without an index, and not one of them looks at
  the index. M18 is not caught by an index assertion — it is caught by `close` without an index
  ceasing to execute at all.
- M19 kills 13b through a **client-side** error, not an on-chain one: with the seeds gone from the
  IDL the resolver can no longer derive the PDA and `@coral-xyz/anchor` throws ``Account
  `escrowIndex` not provided`` while building the instruction. Same conclusion (the seeds in the IDL
  are what makes an absent key resolve to the PDA), different layer, and 15 is the one that proves
  the on-chain guard.

## The survivor, and why it is not a gap

M12 replaces `escrow_state.status.is_terminal()` with `escrow_state.status != Deposited`. With the
enum as it is today, three variants of which exactly one is non terminal, **those two expressions
are the same function**. No input distinguishes them, so no test can kill this mutant. It is an
equivalent mutant, not missing coverage, and writing a test that "kills" it would mean writing a
test that asserts an implementation detail rather than a behaviour.

It stops being equivalent the moment a fourth, non terminal variant exists: then the negation lets
that account be closed with a full vault and the whitelist does not. That is exactly the change the
payout freeze would make, and the ordering is enforced by a different test, E1b, which fails the day
a fourth variant appears.

## What the new tests bought

The status guard of `refund` was the only guard in this change that became **more permissive** than
what it replaced, and before this run nothing in any suite tried a `refund` from a terminal state.
Three of the mutants above are killed only by tests written for that gap:

- M4 (refund's status guard deleted) is killed **only** by C2 and C3.
- M5 (refund's status guard widened to `!= Released`) is killed **only** by C3.
- M1 (release's status guard deleted) is killed by `escrow.ts` 5, but C1 and C4 are what prove that
  no money moves twice: the older test only pinned the error code with an empty vault, where SPL
  would have refused the transfer anyway.

That is the whole reason C1 to C4 refill the vault before retrying.

## The five of WKH-343 (2026-08-10)

Run on `feat/004-wkh-343-deposito-destinatario-sin-cuenta-token`, **baseline 61 passing, 0 failing**
(the 55 above plus the 6 tests of this HU), on the tree of commit `000c96c`. Same protocol, plus one
control this run added:

**Before running the suite on a mutant, the `sha256sum` of `lib.rs` was required to DIFFER from the
original.** A mutant that was never applied and a mutant that survived produce the identical green
output, and the conclusion drawn from each is the opposite one. The reference digest was
`52dd64c8ea6047f4f2925812d4de479c1ed8aa53ee7a4f98696e4f95f0f9b2be`, and each mutant's digest is
recorded in its capture. Restoration was proven with `git checkout` plus an **empty** `git diff HEAD`
and the three md5 compared against the reference, never against a copy kept outside the repository.

Reference md5 for this run: `b024cd91d03d6cec8fcbb5bf34884c23` /
`26b2685ce861b04e22322b6d52430836` / `4904ecc950795662d8c4e7cca262247c`, identical after all of them.

⚠️ **Two of those three moved AFTER this run, in the review fix pack, and that is expected.** The fix
pack added `//` comments to `lib.rs` (the measured consequence of adding `mut` to `beneficiary_ata`, and
the second route to a stuck escrow), so:

| File | During this run | Fix pack round 1 | Fix pack round 2 | Why |
|---|---|---|---|---|
| `programs/escrow/src/lib.rs` | `4904ecc950795662d8c4e7cca262247c` | `8ea46d368a0a6d6c89fa59c90a611546` | `15c8d5ecea1babd3f029b8bcce0798ed` | round 1 added `//` comments; round 2 also rewrote a `///` |
| `target/deploy/escrow.so` | `b024cd91d03d6cec8fcbb5bf34884c23` | `1ee62827125e75587f5595305664834c` | `1588018c0cc754db49462f93054455c9` | the binary embeds the constraint LINE NUMBERS, and the comments moved them. Same as the WKH-326 second pass. 276 800 bytes throughout, so the capacity preflight is unaffected |
| `target/idl/escrow.json` | `26b2685ce861b04e22322b6d52430836` | `26b2685ce861b04e22322b6d52430836` | `25b498214df3f6f87a936b3e536b290b` | round 1 did **not** move it (byte for byte identical, `diff`-verified): `//` does not reach the IDL. Round 2 corrected a `///` on `Deposit.mint`, which Anchor copies into the IDL, so the canonical sha256 moved to `d295b7c7…` — recorded in `idl-hash.md`, and why it was worth a rebuild is written there |

**None of the above is a re-run.** The five mutants were measured on the tree of `000c96c` with the md5
of the first column, and they were not re-measured. What justifies that, and it is checkable rather than
asserted: neither round changed an **executable line** of `lib.rs`. Round 1 was classified over the diff
(19 added lines, all `//`, 0 removed, 0 non-comment) and round 2 only rewrote comment text — the `///`
of `Deposit.mint`, which is documentation that Anchor happens to copy into the IDL, not code. The
mutants and their killers are the same code. If a future change touches anything but comments, this
table needs a new pass, like WKH-326 needed one.

| # | Mutant | Result | Tests that died |
|---|--------|--------|-----------------|
| M20 | `Deposit`: the `beneficiary_ata` field deleted | KILLED | `escrow.ts` 10, 11, 12, 13; `escrow-index.ts` 20 |
| M21 | `associated_token::authority = beneficiary` → `= sender` | KILLED | `escrow.ts` 10, 11, 13 — **not 12**, see below |
| M22 | `Account<'info, TokenAccount>` → `UncheckedAccount<'info>` | **DOES NOT COMPILE** | none: rustc rejects it, so no binary exists to test |
| M23 | `associated_token::mint/authority` → `token::mint/authority` | KILLED | 51 of 61, including `escrow.ts` 11 and 13 — the reason is not the one predicted, see below |
| M24 | (form B) the `require_keys_eq!` in the handler deleted | **NOT APPLICABLE** | form B was not implemented: there is no `require_keys_eq!` to delete |

Raw captures, one per mutant, in
`doc/sdd/004-wkh-343-deposito-destinatario-sin-cuenta-token/w5/M*-summary.txt`.

Three of these five did **not** behave as the story file predicted, and the differences are the
useful part of the run.

- **M21 is not killed by test 12, and test 12 cannot kill it.** The prediction was "12, 13". Measured:
  10, 11, 13. Read off the generator (`anchor-syn` 1.1.2 `codegen/accounts/constraints.rs:1313-1322`),
  the constraint checks the token account's **owner** first and its **address** second. Test 12 passes
  the *attacker's* ATA, whose owner is neither the beneficiary nor the sender, so it fails with
  `ConstraintTokenOwner` under the healthy guard **and** under the mutant — same code, same account.
  Distinguishing "looks at the beneficiary" from "looks at the sender" needs a case where the account
  belongs to the **sender**, and that is what tests 10 and 13 supply. The guard is still covered by
  three tests; the attribution was wrong, not the coverage.

- **M22 is stopped by the compiler, which is stronger than being killed by a test.** A mutant that dies
  by test needs somebody to run the tests; a mutant that does not compile cannot reach a binary at all.
  It also means the **one-line** mutant that would restore the full ambiguity of error 3012 does not
  exist: reaching an `UncheckedAccount` requires *also* deleting the two `associated_token::`
  constraints, because they are what fails to compile against that type (`can't compare &__Pubkey with
  __Pubkey`, since `UncheckedAccount::owner` is the AccountInfo owner and not the token account's owner
  field). That two-part edit begins with what is essentially M20, which five tests kill.

- **M23 kills 51 tests, and the mechanism is not the predicted one.** The prediction was tests 11 and 13
  (the non-canonical ATA cases). They do die, but so does most of the suite, including tests that have
  nothing to do with the beneficiary. Measured by rebuilding under the mutant and reading the IDL: with
  `token::` the `beneficiary_ata` entry has a single key, `name`, and **no `pda` block**. The `pda`
  block is what lets the client derive the account without anyone naming it, so without it every
  `deposit` that does not pass the account explicitly fails **client side**, before reaching the chain.
  This is the same fact as the W2.3 result measured from the opposite direction: `associated_token::`
  yields a `pda` block and the client derives the account on its own (which is why none of the four
  `deposit` builders in the test suites needed changing), while `token::` removes it. The automatic
  derivation is a consequence of the constraint CD-6 demands for a security reason, not a convenience.

## How to repeat it

There is no committed harness: the driver was a throwaway script, because a mutation harness that
lives in the repository is one more thing that can rot silently. To repeat a single mutant by hand:

```bash
# 1. break one guard in programs/escrow/src/lib.rs
anchor build                     # REBUILD, or you are testing the previous binary
anchor test --skip-build --skip-deploy --skip-local-validator
# 2. restore the source
anchor build                     # REBUILD AGAIN, or the next run lies to you
anchor test --skip-build --skip-deploy --skip-local-validator   # must match the baseline recorded
                                                                # at the top of this file
```

**The restoration criterion is the baseline of the tree you are standing on, not a literal.** Each
section above states its own: **43** for the M1..M14 run on `feat/ventana-de-custodia`, **54** for
the first WKH-326 pass, **55** for the second, **61** for the WKH-343 run. Read it off the section you
are repeating, and if the tree has moved since, take the baseline from a clean run *before* you break
anything. And check the mutant is actually applied: compare the `sha256sum` of `lib.rs` against the
unmutated file, because a mutant that never got written and a mutant that survived look the same. A hardcoded
number here ages the moment a HU adds a test, and then it produces exactly the failure this file
warns about twice: you restore correctly, count more tests than the literal says, and conclude you
restored wrong.
