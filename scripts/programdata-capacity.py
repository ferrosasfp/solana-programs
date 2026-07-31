#!/usr/bin/env python3
"""Compare the size of a local .so against the room reserved on chain.

Why this exists: `anchor deploy` on an upgradeable program writes into the
ProgramData account that already exists. That account was sized when the program
was first deployed and it does NOT grow by itself. If the new binary is larger
than the room left there, the deploy fails inside the loader with a message that
never mentions the size, and you are left guessing while a half written buffer
account keeps your SOL. The fix is one command, `solana program extend`, but you
have to know that before you start, not after.

So this runs BEFORE any deploy, reads the chain, and either says "it fits" or
prints the exact extend command with the exact number of bytes.

Read only. It signs nothing, sends no transaction, and needs no keypair. Standard
library only, no dependencies.

Usage:
    python3 scripts/programdata-capacity.py --program-id <PUBKEY> \
        --artifact target/deploy/escrow.so [--url devnet]

Exit status:
    0  the artifact fits (or no artifact was given: it only reported capacity)
    1  the artifact does NOT fit, or the accounts could not be read
"""

import argparse
import base64
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

UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111"

# UpgradeableLoaderState::ProgramData header: 4 bytes enum tag, 8 bytes slot,
# 1 byte Option tag, 32 bytes upgrade authority. The executable starts at 45.
PROGRAMDATA_HEADER_LEN = 45

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


def rpc(url: str, method: str, params: list) -> dict:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    req = urllib.request.Request(
        url,
        data=body.encode(),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "programdata-capacity/1",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.load(resp)
    if "error" in payload:
        raise SystemExit("RPC error from {}: {}".format(url, payload["error"]))
    return payload["result"]


def get_account(url: str, address: str, slice_len: int = None) -> dict:
    config = {"encoding": "base64"}
    if slice_len is not None:
        config["dataSlice"] = {"offset": 0, "length": slice_len}
    result = rpc(url, "getAccountInfo", [address, config])
    value = result.get("value")
    if value is None:
        raise SystemExit("Account {} does not exist on {}".format(address, url))
    return value


def account_space(value: dict) -> int:
    """Total bytes allocated to the account, independent of any dataSlice."""
    if "space" in value and value["space"] is not None:
        return int(value["space"])
    # Older RPC nodes do not report `space`; fall back to the payload length,
    # which is only correct when the account was fetched WITHOUT a dataSlice.
    return len(base64.b64decode(value["data"][0]))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--program-id", required=True)
    parser.add_argument(
        "--artifact",
        help="path to the .so about to be deployed; omit to only report capacity",
    )
    parser.add_argument(
        "--url",
        default="devnet",
        help="cluster alias (devnet, testnet, mainnet, localhost) or a full RPC URL",
    )
    args = parser.parse_args()

    url = CLUSTERS.get(args.url, args.url)

    program = get_account(url, args.program_id, slice_len=36)
    if program["owner"] != UPGRADEABLE_LOADER:
        raise SystemExit(
            "Program {} is owned by {}, not the upgradeable loader. Only upgradeable "
            "programs have a ProgramData account to extend.".format(
                args.program_id, program["owner"]
            )
        )
    program_data = base64.b64decode(program["data"][0])
    # UpgradeableLoaderState::Program { programdata_address }: 4 byte tag + pubkey.
    if len(program_data) < 36 or struct.unpack("<I", program_data[0:4])[0] != 2:
        raise SystemExit(
            "Unexpected program account layout for {}".format(args.program_id)
        )
    programdata_address = b58encode(program_data[4:36])

    pd_account = get_account(url, programdata_address, slice_len=PROGRAMDATA_HEADER_LEN)
    pd_header = base64.b64decode(pd_account["data"][0])
    if len(pd_header) < PROGRAMDATA_HEADER_LEN or struct.unpack("<I", pd_header[0:4])[0] != 3:
        raise SystemExit(
            "Unexpected programdata layout at {}".format(programdata_address)
        )

    total = account_space(pd_account)
    usable = total - PROGRAMDATA_HEADER_LEN

    print("cluster                {}".format(url))
    print("program id             {}".format(args.program_id))
    print("programdata account    {}".format(programdata_address))
    print("programdata bytes      {}".format(total))
    print("loader header          {}".format(PROGRAMDATA_HEADER_LEN))
    print("usable for the binary  {}".format(usable))

    if not args.artifact:
        return 0

    if not os.path.isfile(args.artifact):
        print("")
        print("FAIL artifact not found: {}".format(args.artifact))
        print("     `anchor deploy` ships whatever is in target/deploy/, it does not")
        print("     compile. Run `anchor build` first.")
        return 1

    size = os.path.getsize(args.artifact)
    print("local artifact         {} ({} bytes)".format(args.artifact, size))

    if size <= usable:
        print("headroom               {} bytes".format(usable - size))
        print("")
        print("OK the binary fits in the space already reserved on chain")
        return 0

    missing = size - usable
    print("missing                {} bytes".format(missing))
    print("")
    print("FAIL the binary does NOT fit. `anchor deploy` would fail inside the loader,")
    print("     with an error that does not mention the size. Extend the account first:")
    print("")
    print(
        "         solana program extend {} {} --url {}".format(
            args.program_id, missing, args.url
        )
    )
    print("")
    print("     That number is the exact deficit, so the account ends up with zero")
    print("     headroom and the next build that grows by one byte needs another")
    print("     extend. Pass a larger number if you want room to spare; extending")
    print("     costs rent for the added bytes and cannot be undone.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
