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

## How to repeat it

There is no committed harness: the driver was a throwaway script, because a mutation harness that
lives in the repository is one more thing that can rot silently. To repeat a single mutant by hand:

```bash
# 1. break one guard in programs/escrow/src/lib.rs
anchor build                     # REBUILD, or you are testing the previous binary
anchor test --skip-build --skip-deploy --skip-local-validator
# 2. restore the source
anchor build                     # REBUILD AGAIN, or the next run lies to you
anchor test --skip-build --skip-deploy --skip-local-validator   # must be 43 passing
```
