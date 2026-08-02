# Decision needed: the escrow deadline is the quote's expiry, and the quote lives 10 minutes

**Status: CLOSED 2026-08-01. Option A was taken and shipped before the program was deployed.**

The client computes the escrow deadline itself now, as `now + CUSTODY_WINDOW_SECS` (2 hours), and
no longer reads `quote.expiresAt` for it. See `chaski-v3/src/infrastructure/solana-wallet.ts`,
constant `CUSTODY_WINDOW_SECS`, merged in `def357a`. The program was deployed after that, in that
order, which is the only order that does not break the deposit path.

The rest of this document is kept as it was written, because the reasoning and the cost of option
B are still the record of why A was chosen.

**One thing option A did not close, and it is a real follow up.** This document already pointed at
`flow.tsx:856`, where the UI decides whether the refund is available from the same quote expiry.
That line was correct while both instants were the same and it is now wrong by design: the UI says
the window opens about 110 minutes before it actually does, and `RefundLockedNotice` renders that
wrong instant as a specific time. No money is at risk, the authoritative guard reads the chain and
fails closed before signing, but the interface states something false about when somebody can have
their money back. Tracked separately.

## The fact

The custody window in this program has a floor: `MIN_CUSTODY_SECS = 3600`. A deposit whose deadline
is less than one hour away reverts with `DeadlineTooSoon`.

The client sets that deadline to the expiry of the price quote:

```ts
// chaski-v3/src/infrastructure/solana-wallet.ts:203
const deadline = new anchor.BN(String(Math.floor(Date.parse(quote.expiresAt) / 1000)));
```

And the quote is short lived. The local fallback gateway issues quotes with a 10 minute TTL
(`chaski-v3/src/infrastructure/fallback/gateways.ts:26`, `QUOTE_TTL_MS = 10 * 60_000`), and the
real quotes come from the quoting agent over A2A, which sets `expiresAt` itself: we read it, we do
not choose it (`chaski-v3/src/infrastructure/a2a/gateways.ts`, `isValidQuoteShape`).

So today, **every deposit the client builds would revert**, and for the A2A path the value that
decides it belongs to a third party.

The client also derives the availability of the refund button from that same instant:

```ts
// chaski-v3/src/presentation/flow.tsx:856
const deadlineReached = rem.quote ? Date.now() >= Date.parse(rem.quote.expiresAt) : false;
```

That is what makes this a product decision rather than a constant: the quote expiry is currently
doing two unrelated jobs, "this price is stale" and "the sender may take the money back".

## Option A: decouple the deadline from the quote expiry

The client computes the escrow deadline on its own, inside the on-chain window, for example
`now + 1 h` or `now + 2 h`, and keeps the quote's TTL where it is.

- **What it costs.** The UI can no longer read refund availability off the quote. `flow.tsx:856`
  has to stop using `quote.expiresAt` and use the deadline actually recorded in the escrow account,
  which means either storing it in the remittance snapshot when the deposit is built, or reading it
  on chain. Until that is done the button would appear an hour early, while the on-chain refund
  still reverts with `DeadlineNotReached`, so the user is told they can do something they cannot.
- **What it also costs, and it is the real one.** The price and the custody stop expiring together.
  A quote that went stale at minute 10 sits inside an escrow that the operator can still release at
  minute 50, at a rate agreed an hour earlier. Somebody has to decide what the operator is allowed
  to do with a released escrow whose quote is stale, and that is a pricing question, not a UI one.

## Option B: raise the quote TTL to one hour

The quote lives an hour, the deadline stays equal to its expiry, everything downstream keeps
working unchanged, and no client code moves.

- **What it costs.** One hour of FX exposure per quote instead of ten minutes. Whoever honours the
  rate is short USD/PEN for an hour with no way to reprice, and that risk is real money, not an
  inconvenience. Six times the window is not six times the risk, it is worse than linear on any
  volatile pair.
- **And it is not entirely ours to set.** For A2A quotes the TTL belongs to the quoting agent. We
  would be asking every quoting agent to hold a price for an hour, or rejecting the ones that will
  not, which shrinks the set of agents the product can use.

## The half of the floor that is not a benefit

Whatever is chosen, this is true and belongs next to it: **the floor is also the minimum time the
sender cannot get their money back.** `refund` requires `now >= deadline`, and the deadline cannot
be set below the floor, so a deposit made by mistake, to the wrong beneficiary or for the wrong
amount, is immobilised for at least an hour. Going from a 10 minute deadline to a 1 hour floor
multiplies that wait by six for every sender, including the ones whose remittance was paid in two
minutes.

The floor buys the operator a window in which the release is reachable. It charges the sender for
that window. Both halves are stated where the constant is defined
(`programs/escrow/src/lib.rs`, `MIN_CUSTODY_SECS`).

## What is NOT in scope here

`chaski-v3` and `wasiai-facilitator` were not touched. This is a decision, not an implementation.
Whoever implements it does it in those repositories, and this program does not change either way:
the floor is already enforced on chain.
