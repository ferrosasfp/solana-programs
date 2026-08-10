# Security policy

## Reporting a vulnerability

Email **fernando@wasiai.io**. That address is a person, not a queue, and it is the
same contact embedded in the deployed binary (see [On-chain contact](#on-chain-contact)).

Please do **not** open a public GitHub issue for an unpatched vulnerability. GitHub
private vulnerability reporting is **not enabled** on this repository today, so email
is the only private channel that exists. Use issues for anything that is not a
vulnerability.

Encrypted mail: we do not publish a PGP key. If you need one, say so in a first
message with no details and we will arrange a channel before you send anything.

### What to expect, and when

| | |
|---|---|
| First human reply | within **48 hours**, business days |
| Assessment (is it real, how bad) | within **7 days** of the first reply |
| Fix or a written decision not to fix | depends on severity; we will tell you the date we are working to, and tell you again if it moves |
| Public disclosure | coordinated with you, after a fix ships. Default embargo **90 days**, and we will not use the embargo to sit on something quietly |
| Credit | your name or handle in the advisory, if you want it. Say so, it is opt in |

If we go quiet past those windows, escalate by replying to your own thread with
`[ESCALATION]` in the subject. A missed SLA is a bug in this process and we would
rather hear about it than have you assume the report was received.

### There is no bug bounty

**We do not pay for vulnerability reports.** There is no bounty program, no
severity table and no reward pool, and we are not going to imply one exists. This
project is self funded. If you want to be paid for your time, this is the wrong
target and we would rather you knew that in the first minute than after a week of
work.

What we can offer: a fast, honest reply from someone who reads the code, public
credit if you want it, and a written record of what we changed.

## Scope

### In scope

- The Anchor program in `programs/escrow/`, at any commit on `main`.
- The program deployed on devnet at `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`.
- The deploy and inspection scripts in `scripts/`, in particular anything that
  would make `programdata-capacity.py` or `onchain-hash.py` report a safe result
  for an unsafe state.
- The reproducible build claim: if `solana-verify build` does not reproduce the
  published hashes on your machine, that is a finding we want, not a support
  question. See [Reproducing the deployed binary](README.md#reproducing-the-deployed-binary).

The classes of bug we care most about, in order:

1. Any path that moves tokens out of a vault to an address not recorded in
   `EscrowState`, or with no valid signature.
2. Any path where `release` and `refund` are both legal for the same escrow at the
   same instant, or where either runs twice. This is the program's single
   invariant; see the module header in `programs/escrow/src/lib.rs`.
3. Any path that permanently traps funds, other than the two already documented
   under [Known limitations](README.md#known-limitations).
4. Any way to make a deposit record a `deadline` outside
   `[now + MIN_CUSTODY_SECS, now + MAX_CUSTODY_SECS]`.
5. PDA seed collisions, missing `has_one`, missing signer checks, or an account
   substitution the constraints do not catch.

### Out of scope

- **Already documented limitations.** A mint's freeze authority can freeze the
  vault; the vault's associated token account can be created by a stranger first to
  block one `(sender, remittance_id)` pair. Both are written up in
  [Known limitations](README.md#known-limitations). Reporting them is not a finding.
  Showing us a *worse* consequence of them than we describe is.
- **The upgrade authority.** The program is upgradeable and the authority is a
  single key. "The authority can replace the program" is the design as it stands
  today, not a vulnerability report. See below.
- Validator clock drift as a concept. `Clock::unix_timestamp` is not wall time and
  we say so; an exploit that turns drift into stolen or trapped funds is in scope.
- Denial of service against a third party RPC, or against devnet itself.
- Social engineering, phishing of maintainers, or physical access.
- Anything requiring control of the Solana validator set.
- The off-chain services that call this program. They live in other repositories
  and have their own contacts.

## What this program is, as of today

Read this before deciding whether a finding matters, because some of it is already
public and none of it is a secret we are keeping.

- **Devnet only.** There is no mainnet deployment, and **no real money is at risk
  right now.**
- **We do NOT control the mint that this program has actually custodied.** The
  automated tests mint their own synthetic 6-decimal mints, but on devnet the
  program has held Circle's devnet USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`),
  whose mint authority (`GrNg1XM2...`) and **freeze authority**
  (`CJtyoKSLrktozQzjERTiK3btQtiTK3nN4QrqGHLidyCT`) are **not ours** — measured
  2026-08-10 at slot `482578725`. **When this program last custodied a balance,
  that limitation covered 100% of it.** (It used to say "100% of the balance this
  program custodied *on that mint*", which with that qualifier says nothing at all
  — of course the mint's own freeze authority covers the balance held in that
  mint. In a document read by whoever is about to report a vulnerability, a "100%"
  that is a tautology invites the strong reading, and the strong reading would be
  false. The claim above is the falsifiable one, and it is true: the last balance
  under custody, the 40,000,000 raw refunded on 2026-08-10, was entirely on
  Circle's mint.) It matters for a finder: a freeze authority we do not
  hold can freeze a vault, and a frozen SPL token account rejects every transfer,
  so neither `release` nor `refund` can move a token regardless of deadline,
  signature or state. That is a real custody limitation, not a hypothetical.
- **No external audit.** The program has never been reviewed by a third party
  security firm. `auditors: "None"` is in the on-chain contact card for that reason.
- **The upgrade authority exists and is a single devnet key**
  (`4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH`). Whoever holds it can replace
  every guarantee the program makes. It has not been revoked and we are not
  claiming immutability.
- **The source and the chain DIVERGE right now, on purpose.** This tree contains a
  change to `programs/escrow/src/lib.rs` (WKH-343: `deposit` now requires the
  beneficiary's associated token account for the escrow's mint) that **has not been
  deployed**. The bytes running on devnet are still the ones deployed on 2026-08-05
  in slot `481495859`, whose hashes the README publishes. The deploy is a separate,
  later step with its own gate, and until it happens a rebuild of this tree will
  **not** reproduce the deployed binary. Independently of that, the upgrade
  authority above can replace the program at any moment. So a finding against
  `main` is not automatically a finding against the deployed bytes: say which one
  you tested, and if you are not sure, say that instead of guessing.
  `scripts/onchain-hash.py` tells you what is actually running.
- **Behaviour driven tests, no fuzzing**, no formal verification, no symbolic
  execution. The current count is the one in the README's "Last measured run" row.
  If your tool found something ours did not, that is expected.

## On-chain contact

The deployed binary carries a [security.txt](https://github.com/neodyme-labs/solana-security-txt)
blob, so a finder holding only a program id can reach us without finding this file
first:

```bash
solana program dump DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x /tmp/escrow.so --url devnet
strings -n 4 /tmp/escrow.so | grep -A 16 'BEGIN SECURITY.TXT'
```

It is emitted by the `security_txt!` block at the top of
`programs/escrow/src/lib.rs`. Two caveats, so the output does not surprise you:

- The blob lands in `.rodata` rather than in a dedicated `.security.txt` ELF
  section. The macro applies `link_section` only under `target_arch = "bpf"`, and
  this program is built for SBF (ELF machine `0x107`). Tools that scan for the
  `=======BEGIN SECURITY.TXT V1=======` marker, which is what the reference parser
  does, find it either way.
- The blob is only in a build of this source. **The currently deployed devnet
  binary predates it**, so the commands above return nothing until the program is
  upgraded. Email still works.
