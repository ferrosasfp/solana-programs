#!/usr/bin/env python3
"""Enumerate every EscrowState account of this program and say, for each one, what
exit it actually has left.

Two questions this answers, and both are read straight off the chain:

1. WHICH EXIT IS LEGAL RIGHT NOW. `release` is legal only while
   `now < deadline`; from the deadline on, the only exit is a refund, and only
   the sender can sign it. So an escrow in `Deposited` past its deadline is
   REFUND-ONLY, and that is a statement about the binary that is live today, not
   about a pending upgrade.

2. WHETHER THE BENEFICIARY CAN RECEIVE THE TOKEN AT ALL. `release` requires the
   beneficiary's associated token account for the escrow's mint, and it does NOT
   create it. If that account does not exist, no release can even be built: the
   escrow is stuck regardless of the deadline. This is the WKH-343 failure mode,
   and it is the most valuable line this script prints, because it works against
   the binary ALREADY DEPLOYED and needs no upgrade to be useful.

   ⚠️ It asks for the CANONICAL ATA, by deriving its address, and that is not the
   same question as "does the beneficiary hold a token account for this mint".
   This check used to be `getTokenAccountsByOwner(beneficiary, {mint})`, which
   filters on the ACCOUNT DATA (owner + mint) and therefore also returns token
   accounts that are not the canonical ATA. The program constrains the ADDRESS
   (`associated_token::mint` + `associated_token::authority`), so a non-canonical
   account satisfies the old filter and is rejected by the program with
   `ConstraintAssociated (2009)`. The two predicates disagreed on exactly that
   input, and this script is what a deploy gate reads, so it now derives the
   address and asks whether the listing CONTAINS it (measured: see
   `doc/sdd/004-.../fix-pack-blq-med-1.txt`, which feeds one bankrun fixture to
   the program and to both versions of this check and gets opposite answers).
   The non-canonical accounts are still counted, and reported as what they are:
   present, and useless to `release`.

"The funds are not lost" holds only while the sender can still sign: the refund
is the last exit there is, so if that key is gone the escrow is unreachable by
everyone, permanently. See "Known limitations" in the README.

Read only. It signs nothing, sends no transaction, needs no keypair and takes no
private input. Standard library only.

Usage:
    python3 scripts/list-live-escrows.py [--url devnet] [--program-id <PUBKEY>]
                                         [--idl target/idl/escrow.json]
                                         [--exit-nonzero-if-blocking]
                                         [--markdown]

Exit status:
    0  always, unless --exit-nonzero-if-blocking was given and there is at least
       one reason not to read the sweep as a clean bill of health. FIVE
       independent conditions count, and they are listed on stdout every run:
         - a Deposited escrow with its deadline already past (refund-only),
         - a Deposited escrow whose beneficiary cannot receive the mint,
         - an escrow with a status byte this script does not recognise,
         - ZERO escrow_state accounts observed, or
         - the cluster clock could not be read.

    ⚠️ Only the first counted originally, and each of the other four was a case of
    the script PRINTING something and then dropping it from the return value:
      - `unpayable` was reported and ignored, so the one condition no amount of
        waiting resolves was invisible to `$?`.
      - a wrong --program-id, a stale --idl or the wrong cluster all produce "0
        accounts found" and used to exit 0: a sweep that looked at nothing was
        indistinguishable from a healthy one.
      - when the cluster clock is unreadable this script substitutes the LOCAL
        clock, which flips deadline verdicts. The header said so; `$?` did not.

    ⚠️ A non-zero status is NOT self-describing: an aborted run (for example an
    HTTP 429 from a public endpoint mid-sweep) also exits non-zero. Whoever gates
    on `$?` reads the reason from stdout, which always prints it.

    NOTE on that flag's NAME: it is HISTORICAL. It was added when "blocking"
    meant "would be stranded by the pending WKH-326 upgrade"; that upgrade
    landed on 2026-08-05 (slot 481495859). The name is kept deliberately:
    verified by a sweep over .yml, .sh, .md and .json that no consumer parses it
    programmatically (only prose in the README and a comment in
    scripts/deploy-devnet.sh), and renaming a flag whose meaning is written down
    in three documents buys nothing. What DID change is what it covers, so read
    the two conditions above rather than the name.
"""

import argparse
import base64
import datetime
import hashlib
import json
import os
import struct
import sys
import urllib.request

CLUSTERS = {
    "devnet": "https://api.devnet.solana.com",
    "testnet": "https://api.testnet.solana.com",
    "mainnet": "https://api.mainnet-beta.solana.com",
    "mainnet-beta": "https://api.mainnet-beta.solana.com",
    "localhost": "http://localhost:8899",
}

# 8 byte anchor discriminator + 32*4 + 8 + 8 + 1 + 1
ESCROW_STATE_SIZE = 154
STATUS_NAMES = {0: "Deposited", 1: "Released", 2: "Refunded"}

B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

# The two program ids the ATA derivation needs. `Deposit`/`Release` declare
# `Program<'info, Token>`, i.e. the ORIGINAL SPL Token program and not Token-2022,
# so this is the one that goes into the seeds. If the program is ever moved to
# Token-2022 this constant moves with it or every derivation below is wrong.
TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"

PDA_MARKER = b"ProgramDerivedAddress"

# ed25519 field, for the only part of the derivation that is not a hash: a PDA is
# valid exactly when the 32 bytes are NOT a point on the curve, so the bump loop
# needs the same off-curve test the runtime uses
# (curve25519_dalek CompressedEdwardsY::decompress returning None).
_ED_P = 2**255 - 19
_ED_D = (-121665 * pow(121666, _ED_P - 2, _ED_P)) % _ED_P


def b58encode(raw: bytes) -> str:
    n = int.from_bytes(raw, "big")
    out = ""
    while n > 0:
        n, rem = divmod(n, 58)
        out = B58_ALPHABET[rem] + out
    for byte in raw:
        if byte != 0:
            break
        out = "1" + out
    return out


def b58decode(text: str) -> bytes:
    n = 0
    for ch in text:
        digit = B58_ALPHABET.find(ch)
        if digit < 0:
            raise ValueError("not base58: {!r}".format(text))
        n = n * 58 + digit
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = 0
    for ch in text:
        if ch != "1":
            break
        pad += 1
    return b"\x00" * pad + raw


def is_on_curve(raw: bytes) -> bool:
    """True when these 32 bytes decompress to an ed25519 point.

    Mirrors the decompression the runtime does: recover x from y and reject when
    (y^2 - 1) / (d*y^2 + 1) has no square root. Anything ON the curve could be a
    real keypair's public key and therefore cannot be a program address; the
    bump loop wants the first candidate that is OFF it.

    ⚠️ The masking on the next line is NOT sloppiness, and it is the one place where
    this function deliberately DISAGREES with a stricter implementation. The runtime
    uses `curve25519_dalek`'s `CompressedEdwardsY::decompress`, which takes the low
    255 bits as `y` and does not reject a non-canonical encoding (`y >= p`).
    `@solana/web3.js` validates RFC 8032 strictly and rejects those. Measured over
    19 hand-built encoding vectors: the two implementations disagree on 5 of them,
    and on those 5 THIS function matches the runtime and the library does not. The
    disagreement can only be reached by a digest whose 255-bit value lands in
    [p, 2^255), i.e. with probability 19/2^255 per candidate, so it never decides a
    real derivation — but a check that has to predict what the chain does follows the
    chain, and the divergence is written down rather than left to be rediscovered.
    """
    y = int.from_bytes(raw, "little") & ((1 << 255) - 1)
    u = (y * y - 1) % _ED_P
    v = (_ED_D * y * y + 1) % _ED_P
    # x = sqrt(u/v) for p = 2^255-19, which is 5 mod 8.
    v3 = pow(v, 3, _ED_P)
    v7 = pow(v, 7, _ED_P)
    x = (u * v3 % _ED_P) * pow(u * v7 % _ED_P, (_ED_P - 5) // 8, _ED_P) % _ED_P
    if (v * x * x - u) % _ED_P == 0:
        return True
    sqrt_m1 = pow(2, (_ED_P - 1) // 4, _ED_P)
    x = x * sqrt_m1 % _ED_P
    return (v * x * x - u) % _ED_P == 0


def find_program_address(seeds: list, program_id: str) -> tuple:
    """(address, bump), the same way the runtime derives it. No RPC, no packages.

    The loop stops at bump 1, which is what `Pubkey::find_program_address` does: it
    iterates 255 down to 1 and never tries 0. This used to run down to 0, so the
    docstring's "the same way the runtime derives it" was falsifiable — in an
    unreachable direction (it would take all 255 real bumps landing on the curve,
    ~2^-255), but the sentence claims equivalence and now it holds.
    """
    program_raw = b58decode(program_id)
    for bump in range(255, 0, -1):
        digest = hashlib.sha256(
            b"".join(seeds) + bytes([bump]) + program_raw + PDA_MARKER
        ).digest()
        if not is_on_curve(digest):
            return b58encode(digest), bump
    raise ValueError("no off-curve bump for these seeds")


def canonical_ata(owner: str, mint: str) -> str:
    """The ONE address `associated_token::mint = mint` + `authority = owner` accepts.

    Seeds are [owner, token program, mint] over the associated token program, which
    is what `anchor_spl` checks the account's key against. Deriving it is the whole
    point: the program constrains the ADDRESS, so a check that filters accounts by
    their CONTENTS answers a different question (see the module docstring).
    """
    address, _bump = find_program_address(
        [b58decode(owner), b58decode(TOKEN_PROGRAM_ID), b58decode(mint)],
        ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    return address


def rpc(url: str, method: str, params: list):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    req = urllib.request.Request(
        url,
        data=body.encode(),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "list-live-escrows/1",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.load(resp)
    if "error" in payload:
        raise SystemExit("RPC error from {}: {}".format(url, payload["error"]))
    return payload["result"]


def cluster_now(url: str) -> tuple:
    """The cluster's own clock, which is what the program compares against.

    Returns (unix_ts, slot_or_None, description, trusted). The slot is returned
    SEPARATELY and not only baked into the description because every block this
    script prints has to be able to stamp itself with it: a partial copy/paste of
    the output must still carry the slot it was measured at.

    `slot` is None when the cluster clock could not be read. That third state is
    returned explicitly instead of being collapsed into a number, because
    "could not ask" is not "the answer is now".

    ⚠️ `trusted` exists because the SLOT kept its third state and the TIMESTAMP did
    not: on failure this function substitutes the LOCAL clock and carries on, and
    every verdict downstream ("REFUND-ONLY" vs "live, still inside its release
    window") is a comparison against that number. Measured on one and the same
    escrow: with the cluster clock it prints REFUND-ONLY and exits 1; with
    `getBlockTime` returning `null` it prints "live, still inside its release
    window" and exited 0. A human sees the `LOCAL clock` warning in the header; `$?`
    did not, and `$?` is now load-bearing. So the flag treats an unread cluster
    clock as a reason to fail, and this returns the fact instead of hiding it.

    Neither failure is exotic: `getBlockTime` answers `null` for pruned or
    not-yet-rooted slots on a public endpoint, and a container clock that drifts is
    ordinary.
    """
    try:
        slot = rpc(url, "getSlot", [])
        ts = rpc(url, "getBlockTime", [slot])
        if isinstance(ts, int):
            return ts, slot, "cluster clock at slot {}".format(slot), True
        # The slot WAS read; only the block time was not. Both facts are kept: the
        # slot still stamps the output, and `trusted` still says the comparison
        # below is against a clock the cluster never confirmed.
        return (
            int(__import__("time").time()),
            slot,
            "LOCAL clock (getBlockTime returned {!r} for slot {}); every deadline "
            "verdict below is a comparison against THIS host's clock".format(ts, slot),
            False,
        )
    except SystemExit:
        pass
    import time

    return (
        int(time.time()),
        None,
        "LOCAL clock (the cluster clock could not be read)",
        False,
    )


def slot_label(slot) -> str:
    """How a slot is rendered everywhere, including when it is unknown."""
    return "slot {}".format(slot) if slot is not None else "slot UNKNOWN (cluster clock unreadable)"


# Memo for beneficiary_ata_state: the answer is a property of (beneficiary, mint),
# not of the escrow, and escrows share pairs. See that function's docstring.
#
# ⚠️ ITS LIFETIME IS THE PROCESS, and there is no invalidation. That is correct for
# this script — one sweep, one snapshot of the chain, then exit, and a sweep whose
# rows disagreed with each other about the same pair would be worse than a slow one.
# It is a footgun for anything that IMPORTS this module and asks twice expecting
# fresh answers: the second call replays the first. Measured, on my own probe: with
# the RPC re-stubbed to the opposite state, the answer did not change until the cache
# was cleared. Callers that need a second look call `_ATA_STATE_CACHE.clear()`.
_ATA_STATE_CACHE = {}


def beneficiary_ata_state(url: str, beneficiary: str, mint: str) -> dict:
    """Can `release` be BUILT for this (beneficiary, mint) pair? Read only.

    `Release.beneficiary_ata` is declared with `associated_token::mint` +
    `associated_token::authority` and without `init`, so the program requires ONE
    specific address to already exist and will not create it. This asks about that
    address, derived here, and nothing else.

    ⚠️ The distinction this function exists to keep is not cosmetic, it is the
    difference between two answers on the same input:

      - `getTokenAccountsByOwner(beneficiary, {mint})` returns every token account
        whose DATA says (owner, mint). A non-canonical one satisfies that.
      - the program compares the account's ADDRESS against the derived ATA and
        rejects anything else with `ConstraintAssociated (2009)`.

    So on a pair whose canonical ATA is missing while a non-canonical account
    exists, the old check said `yes` and the program says no. Both are reported
    now: `ok` is the program's answer, and `non_canonical` is how many accounts
    would have produced the wrong one.

    ⚠️ EXISTING IS NOT ENOUGH: a FROZEN account is checked here too. The address
    constraints are all Anchor verifies (`anchor-syn` 1.1.2
    `codegen/accounts/constraints.rs:1313-1322` compares the owner and the address
    and nothing else), so `release` on a frozen ATA is CONSTRUCTIBLE and then the
    SPL transfer rejects it with `AccountFrozen`. For the question this script
    exists to answer — can the beneficiary be paid — frozen is a NO, and it is the
    worse one: a missing account is one transaction away from anybody, and a frozen
    one cannot be fixed from our side at all. It is the freeze authority's to lift,
    and on the mint that has actually held custody here that authority is not ours.
    `state` arrives in the SAME response already being requested, so asking costs
    zero extra calls.

    Keys: `ata` (the derived address, always), `ok` (bool: that exact account is
    among the beneficiary's token accounts for this mint AND is not frozen),
    `frozen` (bool), `state` (the raw SPL state string, or None when absent),
    `balance` (raw string or None) and `non_canonical` (count of the beneficiary's
    other token accounts for this mint, which `release` cannot use).

    ONE RPC call per DISTINCT pair, and that is deliberate twice over:
      - one call and not two, because the first version of this fix asked
        `getAccountInfo(derived)` AND `getTokenAccountsByOwner`, which doubled the
        requests and made the public devnet endpoint answer `HTTP 429` halfway
        through the 10 escrows. A gate script that dies with a traceback is not an
        improvement over one that answers wrongly. The single listing is a superset:
        the canonical ATA, if it exists, is one of the accounts it returns, so `ok`
        is a CONTAINMENT check and everything else in the list is non-canonical.
      - memoized per `(beneficiary, mint)`, because the answer is a property of that
        pair and not of the escrow. Measured on devnet: 10 escrows share 2 pairs, so
        the sweep went from 13 RPC calls to 5 (-62%) with the same predicate. That
        is the mitigation for the 429 above, and it grows better the more escrows
        share a beneficiary, which is the real shape of this program's traffic.
    """
    cached = _ATA_STATE_CACHE.get((beneficiary, mint))
    if cached is not None:
        return cached

    ata = canonical_ata(beneficiary, mint)

    result = rpc(
        url,
        "getTokenAccountsByOwner",
        [beneficiary, {"mint": mint}, {"encoding": "jsonParsed"}],
    )
    present = False
    frozen = False
    state = None
    balance = None
    non_canonical = 0
    for item in result.get("value", []):
        if item["pubkey"] == ata:
            present = True
            info = item["account"]["data"]["parsed"]["info"]
            balance = info["tokenAmount"]["amount"]
            state = info.get("state")
            frozen = state == "frozen"
        else:
            non_canonical += 1

    out = {
        "ata": ata,
        "ok": present and not frozen,
        "present": present,
        "frozen": frozen,
        "state": state,
        "balance": balance,
        "non_canonical": non_canonical,
    }
    _ATA_STATE_CACHE[(beneficiary, mint)] = out
    return out


def exit_reasons(
    blocking: list,
    unpayable: list,
    unknown_status: list,
    accounts_seen: int,
    clock_trusted: bool,
) -> list:
    """Every reason this sweep must NOT be read as a clean bill of health.

    The ONE place that decides, and it has grown twice for the same reason: a
    condition that was printed and then dropped from the return value.

      1. `blocking`  — Deposited and past the deadline (refund-only).
      2. `unpayable` — Deposited and the beneficiary cannot receive the mint. Used to
         be printed and ignored here.
      3. AN UNRECOGNISED STATUS BYTE — not reachable from this program today, and
         for that very reason it must not be filed under "terminal, nothing to
         drain", which is where it used to land.
      4. NOTHING OBSERVED — zero `escrow_state` accounts. A sweep that looked at
         nothing is indistinguishable, from the exit code, from a sweep that looked
         at everything and found it healthy. Measured: a valid but WRONG
         `--program-id` prints "0 accounts found" and used to exit 0, and so did a
         `--idl` from another build or a `--url` pointing at the wrong cluster. That
         is this HU's own defect in another shape — an instrument that answers a
         question nobody asked — so zero accounts is fail-closed. If zero is the
         genuinely expected state, the operator confirms the program id and the
         cluster by hand; the script will not confirm it for them.
      5. THE CLUSTER CLOCK WAS NOT READ — every deadline verdict is then a
         comparison against this host's clock. See `cluster_now`.

    Returns the reasons as text so the caller can print them: an exit code of 1 says
    "do not proceed", and only stdout can say why. (Which is also true of the 429
    case: a rate-limited sweep aborts with a traceback and a non-zero status, and
    that status looks exactly like this one. The reason is always in the output.)
    """
    reasons = []
    if blocking:
        reasons.append(
            "{} escrow(s) are Deposited with the deadline already past (refund-only)".format(
                len(blocking)
            )
        )
    if unpayable:
        reasons.append(
            "{} Deposited escrow(s) whose beneficiary cannot receive the mint".format(
                len(unpayable)
            )
        )
    if unknown_status:
        reasons.append(
            "{} escrow(s) carry a status byte this script does not recognise ({}), "
            "so it will not classify them as terminal".format(
                len(unknown_status),
                ", ".join("{}={}".format(a, b) for a, b in unknown_status),
            )
        )
    if accounts_seen == 0:
        reasons.append(
            "NOTHING WAS OBSERVED: 0 escrow_state accounts matched. Either this "
            "program has no escrows, or the program id / IDL / cluster is wrong. "
            "This script cannot tell those apart, so it refuses to pass"
        )
    if not clock_trusted:
        reasons.append(
            "the CLUSTER CLOCK was not read, so every deadline verdict above "
            "compares against this host's local clock"
        )
    return reasons


def exit_code(reasons: list, flag: bool) -> int:
    """0 unless the flag was given and there is at least one reason not to pass.

    That an aborted run ALSO exits non-zero is stated once, in the module docstring
    ("A non-zero status is NOT self-describing"). Not repeated here on purpose: two
    copies of the same rule drift.

    ⚠️ ONE THING THAT IS NOT WRITTEN ANYWHERE ELSE, added 2026-08-12. Do not "harmonise"
    this with the exit 2 that `wasiai-facilitator/.github/workflows/idl-onchain-drift.yml`
    uses for "could not ask". That control is a MONITOR and its own header argues that a
    job going red on a devnet hiccup trains people to ignore it. This script is a DEPLOY
    GATE (runbook-deploy.md runs it before W6), so the opposite answer is the correct one:
    a gate that cannot see must block. Making it pass when the RPC is unavailable would
    open it exactly when nobody can check anything.
    """
    if not flag:
        return 0
    return 1 if reasons else 0


def iso(ts: int) -> str:
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%SZ"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="devnet")
    parser.add_argument(
        "--idl",
        default=os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", "target", "idl", "escrow.json"
        ),
        help="built IDL, used for the program id and the account discriminator",
    )
    parser.add_argument("--program-id", help="overrides the id read from the IDL")
    parser.add_argument("--exit-nonzero-if-blocking", action="store_true")
    parser.add_argument(
        "--markdown",
        action="store_true",
        help="same information as a markdown table, stamped with its slot, for pasting into a doc",
    )
    args = parser.parse_args()

    # A bare typo used to become an RPC target: anything that was not a known
    # cluster name was passed through as a URL, so `--url devnett` failed with a
    # urllib error and `--url https://api.mainnet-beta.solana.com` (a real cluster,
    # the wrong one for this program) answered 0 accounts and exited 0. Names are
    # checked against the table and anything else has to look like a URL.
    if args.url in CLUSTERS:
        url = CLUSTERS[args.url]
    elif args.url.startswith(("http://", "https://")):
        url = args.url
    else:
        raise SystemExit(
            "--url must be one of {} or an http(s) URL; got {!r}".format(
                ", ".join(sorted(CLUSTERS)), args.url
            )
        )

    if not os.path.isfile(args.idl):
        raise SystemExit(
            "IDL not found at {}. Run `anchor build`, or pass --idl.".format(args.idl)
        )
    with open(args.idl) as fh:
        idl = json.load(fh)
    program_id = args.program_id or idl["address"]
    account = next(a for a in idl["accounts"] if a["name"] == "EscrowState")
    discriminator = bytes(account["discriminator"])

    accounts = rpc(
        url,
        "getProgramAccounts",
        [
            program_id,
            {
                "encoding": "base64",
                "filters": [
                    {"dataSize": ESCROW_STATE_SIZE},
                    {"memcmp": {"offset": 0, "bytes": b58encode(discriminator)}},
                ],
            },
        ],
    )

    now, slot, clock_source, clock_trusted = cluster_now(url)

    rows = []
    if not args.markdown:
        print("cluster        {}".format(url))
        print("program id     {}".format(program_id))
        print("now            {} ({}) [{}]".format(now, iso(now), clock_source))
        print("escrow_state accounts found: {} (measured at {})".format(len(accounts), slot_label(slot)))
        print("")

    blocking = []
    unpayable = []
    unknown_status = []
    for entry in accounts:
        addr = entry["pubkey"]
        data = base64.b64decode(entry["account"]["data"][0])
        o = 8
        sender = b58encode(data[o : o + 32]); o += 32
        beneficiary = b58encode(data[o : o + 32]); o += 32
        authority = b58encode(data[o : o + 32]); o += 32
        mint = b58encode(data[o : o + 32]); o += 32
        amount = struct.unpack("<Q", data[o : o + 8])[0]; o += 8
        deadline = struct.unpack("<q", data[o : o + 8])[0]; o += 8
        status_byte = data[o]; o += 1
        status = STATUS_NAMES.get(status_byte, "UNKNOWN({})".format(status_byte))

        # An unrecognised status byte used to fall through to "terminal, nothing to drain",
        # which is the one reading that makes it invisible: terminal escrows are excluded from
        # `unpayable`, so an unknown byte was reported as harmless. Today the program only ever
        # writes 0/1/2 (EscrowStatus has three variants and the 154-byte canary in
        # tests/escrow.ts guards the layout), so this is not reachable from this program — which
        # is exactly why it must not be silently classified as safe. TERMINAL is a whitelist.
        terminal = status_byte in (1, 2)
        deposited = status_byte == 0
        if not (terminal or deposited):
            unknown_status.append((addr, status_byte))

        expired = deadline <= now

        # Can the recorded beneficiary receive this mint at all?
        #
        # Asked for EVERY escrow, terminal ones included, and the two things it means are kept
        # apart on purpose:
        #   - the FACT (does the account exist) is a property of (beneficiary, mint), and it is
        #     worth printing on a terminal escrow too: it is what explains why a past escrow got
        #     stuck, and it predicts what the NEXT deposit to that pair will do.
        #   - whether that fact is BLOCKING depends on the status. On a terminal escrow the tokens
        #     already left, so a missing account strands nothing. Only a `Deposited` escrow with no
        #     payable beneficiary is actually stuck, and only those go into `unpayable`.
        # Collapsing the two would either hide the fact or overstate the damage.
        state = beneficiary_ata_state(url, beneficiary, mint)
        if state["ok"]:
            can_receive = "yes ({}, balance {}, state {})".format(
                state["ata"], state["balance"], state["state"]
            )
            can_receive_md = "yes"
        elif state["frozen"]:
            # The two NOs are NOT the same and the difference is who can fix it. Absent: one
            # transaction, by anyone, no signature from the beneficiary. FROZEN: only the mint's
            # freeze authority can lift it, and on the mint that has actually held custody here
            # that authority is not ours. Anchor does not check this (it compares owner and
            # address only), so `release` is constructible and the SPL transfer is what reverts,
            # with AccountFrozen. The `///` on Deposit.mint already said a frozen vault strands
            # both release and refund; the instrument now asks.
            can_receive = (
                "NO -- the canonical ATA {} exists but is FROZEN (state {}, balance {}). The "
                "account constraints PASS, so a release can be built, and the SPL transfer "
                "reverts with AccountFrozen. Nobody on our side can fix this: only the mint's "
                "freeze authority can thaw it".format(
                    state["ata"], state["state"], state["balance"]
                )
            )
            can_receive_md = "**NO** (frozen)"
        else:
            can_receive = (
                "NO -- the canonical ATA {} does NOT exist; release cannot be "
                "built. Creating it is ONE transaction, payable by anyone".format(state["ata"])
            )
            can_receive_md = "**NO**"
            if state["non_canonical"]:
                # Printed because this is the input on which the OLD check said `yes`:
                # these accounts exist, hold this mint, belong to the beneficiary, and
                # the program rejects every one of them (ConstraintAssociated 2009).
                can_receive += (
                    "; the beneficiary DOES have {} other token account(s) for this "
                    "mint, and `release` cannot use any of them".format(
                        state["non_canonical"]
                    )
                )
                can_receive_md = "**NO** (non-canonical only)"

        if not state["ok"]:
            # `terminal` is a whitelist: an unknown status byte counts as possibly holding
            # tokens, so it does NOT get the "not blocking" pass.
            if not terminal:
                unpayable.append((addr, beneficiary, mint, amount, sender))
            else:
                can_receive += " (not blocking: this escrow is already terminal)"

        if status_byte == 0 and expired:
            verdict = (
                "REFUND-ONLY: the release window closed at {}; the only exit is a "
                "refund signed by {}".format(iso(deadline), sender)
            )
            verdict_md = "REFUND-ONLY, refund signed by `{}`".format(sender)
            blocking.append((addr, sender, amount, mint, deadline))
        elif status_byte == 0:
            verdict = "live, still inside its release window (closes {})".format(iso(deadline))
            verdict_md = "live until {}".format(iso(deadline))
        elif terminal:
            verdict = "terminal, nothing to drain"
            verdict_md = "terminal"
        else:
            verdict = (
                "UNKNOWN status byte {}: this script cannot classify it and does NOT assume it "
                "is terminal".format(status_byte)
            )
            verdict_md = "**UNKNOWN status {}**".format(status_byte)

        if args.markdown:
            rows.append(
                "| `{}` | {} | {} | `{}` | `{}` | {} | {} | {} |".format(
                    addr, status, amount, mint, beneficiary, iso(deadline),
                    can_receive_md, verdict_md,
                )
            )
            continue

        print("escrow        {}".format(addr))
        print("  status      {}".format(status))
        print("  amount      {} (raw, in the mint's smallest unit)".format(amount))
        print("  mint        {}".format(mint))
        print("  sender      {}".format(sender))
        print("  beneficiary {}".format(beneficiary))
        print("  authority   {}".format(authority))
        print(
            "  deadline    {} ({}) {}".format(
                deadline, iso(deadline), "PASSED" if expired else "in the future"
            )
        )
        print("  beneficiary can receive: {}".format(can_receive))
        print("  -> {}".format(verdict))
        print("")

    reasons = exit_reasons(
        blocking, unpayable, unknown_status, len(accounts), clock_trusted
    )

    if args.markdown:
        # Every refreshed line carries the slot it was measured at, which is the whole point of
        # generating this instead of typing it: a pasted row cannot silently lose its date. The
        # program id and the cluster travel with it for the same reason: a pasted table that does
        # not say WHICH program it enumerated cannot be checked by the person reading it.
        print("measured {} at {} against {}, program {}".format(
            iso(now), slot_label(slot), url, program_id))
        print("")
        print("| escrow | status | amount (raw) | mint | beneficiary | deadline | beneficiary can receive | exit |")
        print("|---|---|---|---|---|---|---|---|")
        for row in rows:
            print(row)
        print("")
        print("{} escrow_state account(s) total; {} refund-only; {} with an unpayable beneficiary.".format(
            len(accounts), len(blocking), len(unpayable)))
        for reason in reasons:
            print("")
            print("⚠️ {}".format(reason))
        return exit_code(reasons, args.exit_nonzero_if_blocking)

    print("=" * 78)
    print("measured {} at {} against {}".format(iso(now), slot_label(slot), url))
    print("")

    # Reported BEFORE the refund-only list on purpose: an escrow whose beneficiary cannot receive
    # the mint is stuck no matter what its deadline says, and it is the one condition here that no
    # amount of waiting resolves.
    if unpayable:
        print("{} escrow(s) whose BENEFICIARY CANNOT RECEIVE the escrowed mint:".format(len(unpayable)))
        for addr, beneficiary, mint, amount, sender in unpayable:
            print(
                "  {}  amount {}  mint {}  beneficiary {}".format(addr, amount, mint, beneficiary)
            )
        print("")
        print("For these, `release` cannot even be built: it requires the beneficiary's associated")
        print("token account for that mint and never creates it. Creating that account is ONE")
        print("transaction, payable by anyone, and it makes the release constructible again.")
        print("Otherwise the exit is the sender's refund, once the deadline has passed.")
        print("")

    if not blocking:
        print("No escrow is Deposited with an expired deadline, so no escrow is refund-only today.")
    else:
        print("{} escrow(s) are REFUND-ONLY as of {}:".format(len(blocking), slot_label(slot)))
        for addr, sender, amount, mint, deadline in blocking:
            print(
                "  {}  amount {}  mint {}  sender {}  deadline {}".format(
                    addr, amount, mint, sender, iso(deadline)
                )
            )
        print("")
        print("Their release window is CLOSED: `release` on these reverts with ReleaseWindowClosed,")
        print("so the only exit is a refund, and only the sender can sign it. Sending a release is")
        print("not a recovery path here, it is a transaction that fails.")
        print("The funds are never lost while the sender can still sign: the refund is the")
        print("last exit there is.")
        print("The vault is the associated token account of the escrow address above.")

    # The reasons are printed LAST and always, because a non-zero status is unreadable on its own:
    # 429, "nothing observed" and "there are blocking escrows" all exit 1. Only stdout separates
    # them. Printed even without the flag, so the human sees what the flag WOULD have caught.
    print("")
    if not reasons:
        print("Nothing here blocks: every condition this script checks came back clean, and the")
        print("cluster clock was read (so the deadline verdicts are the cluster's, not this host's).")
    else:
        print("{} reason(s) NOT to read this sweep as a clean bill of health:".format(len(reasons)))
        for reason in reasons:
            print("  - {}".format(reason))
        if not args.exit_nonzero_if_blocking:
            print("")
            print("(Exit status is 0 because --exit-nonzero-if-blocking was not given. With it,")
            print(" this run would exit 1.)")
    return exit_code(reasons, args.exit_nonzero_if_blocking)


if __name__ == "__main__":
    sys.exit(main())
