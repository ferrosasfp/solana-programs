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
    0  always, unless --exit-nonzero-if-blocking was given and at least one
       escrow is Deposited with its deadline already past.

    NOTE on that flag's NAME: it is HISTORICAL. It was added when "blocking"
    meant "would be stranded by the pending WKH-326 upgrade"; that upgrade
    landed on 2026-08-05 (slot 481495859), so what it now means is exactly
    "Deposited and past its deadline", i.e. refund-only. The name is kept
    deliberately: verified by a sweep over .yml, .sh, .md and .json that no
    consumer parses it programmatically (only prose in the README and a comment
    in scripts/deploy-devnet.sh), and renaming a flag whose meaning is written
    down in three documents buys nothing.
"""

import argparse
import base64
import datetime
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

    Returns (unix_ts, slot_or_None, description). The slot is returned SEPARATELY
    and not only baked into the description because every block this script
    prints has to be able to stamp itself with it: a partial copy/paste of the
    output must still carry the slot it was measured at.

    `slot` is None when the cluster clock could not be read. That third state is
    returned explicitly instead of being collapsed into a number, because
    "could not ask" is not "the answer is now".
    """
    try:
        slot = rpc(url, "getSlot", [])
        ts = rpc(url, "getBlockTime", [slot])
        if isinstance(ts, int):
            return ts, slot, "cluster clock at slot {}".format(slot)
    except SystemExit:
        pass
    import time

    return int(time.time()), None, "LOCAL clock (the cluster clock could not be read)"


def slot_label(slot) -> str:
    """How a slot is rendered everywhere, including when it is unknown."""
    return "slot {}".format(slot) if slot is not None else "slot UNKNOWN (cluster clock unreadable)"


def beneficiary_token_accounts(url: str, beneficiary: str, mint: str) -> list:
    """The beneficiary's token accounts for this exact mint. Read only.

    This is the check that decides whether a `release` can be BUILT at all:
    `Release.beneficiary_ata` is declared with `associated_token::` and without
    `init`, so the program requires the account to exist and will not create it.

    Returns a list of (pubkey, raw_amount). Empty list means no release can be
    built for this escrow today, no matter what the deadline says.
    """
    result = rpc(
        url,
        "getTokenAccountsByOwner",
        [beneficiary, {"mint": mint}, {"encoding": "jsonParsed"}],
    )
    out = []
    for item in result.get("value", []):
        info = item["account"]["data"]["parsed"]["info"]
        out.append((item["pubkey"], info["tokenAmount"]["amount"]))
    return out


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

    url = CLUSTERS.get(args.url, args.url)

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

    now, slot, clock_source = cluster_now(url)

    rows = []
    if not args.markdown:
        print("cluster        {}".format(url))
        print("program id     {}".format(program_id))
        print("now            {} ({}) [{}]".format(now, iso(now), clock_source))
        print("escrow_state accounts found: {} (measured at {})".format(len(accounts), slot_label(slot)))
        print("")

    blocking = []
    unpayable = []
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
        tas = beneficiary_token_accounts(url, beneficiary, mint)
        if tas:
            ata, bal = tas[0]
            can_receive = "yes ({}, balance {})".format(ata, bal)
            can_receive_md = "yes"
        else:
            can_receive = (
                "NO -- beneficiary has NO token account for this mint; "
                "release cannot be built"
            )
            can_receive_md = "**NO**"
            if status_byte == 0:
                unpayable.append((addr, beneficiary, mint, amount, sender))
        if status_byte != 0 and not tas:
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
        else:
            verdict = "terminal, nothing to drain"
            verdict_md = "terminal"

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

    if args.markdown:
        # Every refreshed line carries the slot it was measured at, which is the whole point of
        # generating this instead of typing it: a pasted row cannot silently lose its date.
        print("measured {} at {} against {}".format(iso(now), slot_label(slot), url))
        print("")
        print("| escrow | status | amount (raw) | mint | beneficiary | deadline | beneficiary can receive | exit |")
        print("|---|---|---|---|---|---|---|---|")
        for row in rows:
            print(row)
        print("")
        print("{} escrow_state account(s) total; {} refund-only; {} with an unpayable beneficiary.".format(
            len(accounts), len(blocking), len(unpayable)))
        return 1 if (blocking and args.exit_nonzero_if_blocking) else 0

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
        return 0

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
    return 1 if args.exit_nonzero_if_blocking else 0


if __name__ == "__main__":
    sys.exit(main())
