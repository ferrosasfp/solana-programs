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

- **Devnet only.** There is no mainnet deployment. The mint used in testing is one
  we control. **No real money is at risk right now.**
- **No external audit.** The program has never been reviewed by a third party
  security firm. `auditors: "None"` is in the on-chain contact card for that reason.
- **The upgrade authority exists and is a single devnet key**
  (`4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH`). Whoever holds it can replace
  every guarantee the program makes. It has not been revoked and we are not
  claiming immutability.
- **The source is ahead of the chain.** The custody window in this tree is not
  deployed. A finding against `main` may not be a finding against the deployed
  bytes, and the reverse is also true. Say which one you tested; if you are not
  sure, say that instead of guessing.
- **43 tests, behaviour driven.** No fuzzing, no formal verification, no symbolic
  execution. If your tool found something ours did not, that is expected.

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
