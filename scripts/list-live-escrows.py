#!/usr/bin/env python3
"""Enumerate every EscrowState account of this program and say which ones an
upgrade would strand.

Why this exists: this version makes `release` illegal from the deadline on. That
is the point of the change, and it is also a one way door for accounts that are
ALREADY on chain. An escrow sitting in `Deposited` whose deadline has passed can
be released by the authority today; the instant the upgrade lands it cannot, and
the only remaining exit is the refund, which only the sender can sign. The money
is not lost, but the exit changes hands with no way back, and that should be a
decision somebody took rather than a side effect somebody discovered.

"Not lost" holds only while the sender can still sign: the refund is the last
exit there is, so if that key is gone the escrow is unreachable by everyone,
permanently. See "Known limitations" in the README.

So: run this BEFORE the upgrade, drain what it flags, and run it again.

Read only. It signs nothing, sends no transaction, needs no keypair and takes no
private input. Standard library only.

Usage:
    python3 scripts/list-live-escrows.py [--url devnet] [--program-id <PUBKEY>]
                                         [--idl target/idl/escrow.json]
                                         [--exit-nonzero-if-blocking]

Exit status:
    0  always, unless --exit-nonzero-if-blocking was given and at least one
       escrow is Deposited with its deadline already past.
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
    """The cluster's own clock, which is what the program compares against."""
    try:
        slot = rpc(url, "getSlot", [])
        ts = rpc(url, "getBlockTime", [slot])
        if isinstance(ts, int):
            return ts, "cluster clock at slot {}".format(slot)
    except SystemExit:
        pass
    import time

    return int(time.time()), "LOCAL clock (the cluster clock could not be read)"


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

    now, clock_source = cluster_now(url)
    print("cluster        {}".format(url))
    print("program id     {}".format(program_id))
    print("now            {} ({}) [{}]".format(now, iso(now), clock_source))
    print("escrow_state accounts found: {}".format(len(accounts)))
    print("")

    blocking = []
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
        if status_byte == 0 and expired:
            verdict = "BLOCKING: releasable today, refund-only after the upgrade"
            blocking.append((addr, sender, amount, mint, deadline))
        elif status_byte == 0:
            verdict = "live, still inside its release window"
        else:
            verdict = "terminal, nothing to drain"

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
        print("  -> {}".format(verdict))
        print("")

    print("=" * 78)
    if not blocking:
        print("No escrow is Deposited with an expired deadline.")
        print("The upgrade does not change the exit available to anybody today.")
        return 0

    print("{} escrow(s) would change hands at the instant of the upgrade:".format(len(blocking)))
    for addr, sender, amount, mint, deadline in blocking:
        print(
            "  {}  amount {}  mint {}  sender {}  deadline {}".format(
                addr, amount, mint, sender, iso(deadline)
            )
        )
    print("")
    print("Each of these can be released by its authority RIGHT NOW and cannot be")
    print("released at all once this version is live: only the sender's refund remains.")
    print("The funds are never lost while the sender can still sign: the refund is the")
    print("last exit there is. What changes, irreversibly, is who holds it.")
    print("Drain them first, or decide deliberately that the refund is the right outcome.")
    print("The vault is the associated token account of the escrow address above.")
    return 1 if args.exit_nonzero_if_blocking else 0


if __name__ == "__main__":
    sys.exit(main())
