#!/usr/bin/env python3
"""Read the deployed program bytes from a Solana cluster and hash them.

No Docker, no Rust, no Solana CLI, no keypair, no dependencies outside the
Python standard library. The point is that a stranger can run this and get the
same numbers this repository publishes, without installing our toolchain and
without taking our word for anything.

Two hashes are printed because two conventions exist and they do NOT agree:

  artifact-sha256  sha256 over the deployed bytes exactly as they are, which is
                   what `sha256sum target/deploy/escrow.so` gives you.
  verify-hash      sha256 over the same bytes with the trailing zero bytes
                   removed, which is what `solana-verify get-program-hash` and
                   `solana-verify get-executable-hash` give you (see
                   `get_binary_hash` in solana-verifiable-build).

The escrow binary ends in 15 zero bytes, so the two values differ. Both are
published in README.md; neither is more correct than the other.

Usage:
    python3 scripts/onchain-hash.py --program-id <PUBKEY> [--url devnet]
    python3 scripts/onchain-hash.py --program-id <PUBKEY> \
        --expect-artifact-sha256 <HEX> --expect-verify-hash <HEX>

Exit status is 1 if an --expect-* value is given and does not match.
"""

import argparse
import base64
import hashlib
import json
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
        headers={"Content-Type": "application/json", "User-Agent": "onchain-hash/1"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.load(resp)
    if "error" in payload:
        raise SystemExit("RPC error from {}: {}".format(url, payload["error"]))
    return payload["result"]


def get_account(url: str, address: str) -> dict:
    result = rpc(url, "getAccountInfo", [address, {"encoding": "base64"}])
    value = result.get("value")
    if value is None:
        raise SystemExit("Account {} does not exist on {}".format(address, url))
    return value


def binary_hashes(executable: bytes) -> tuple:
    trimmed = executable.rstrip(b"\x00")
    return (
        hashlib.sha256(executable).hexdigest(),
        hashlib.sha256(trimmed).hexdigest(),
        len(trimmed),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--program-id", required=True)
    parser.add_argument(
        "--url",
        default="devnet",
        help="cluster alias (devnet, testnet, mainnet, localhost) or a full RPC URL",
    )
    parser.add_argument("--expect-artifact-sha256")
    parser.add_argument("--expect-verify-hash")
    args = parser.parse_args()

    url = CLUSTERS.get(args.url, args.url)

    program = get_account(url, args.program_id)
    if program["owner"] != UPGRADEABLE_LOADER:
        raise SystemExit(
            "Program {} is owned by {}, not the upgradeable loader. This script only "
            "understands upgradeable programs.".format(args.program_id, program["owner"])
        )
    program_data = base64.b64decode(program["data"][0])
    # UpgradeableLoaderState::Program { programdata_address }: 4 byte tag + pubkey.
    if len(program_data) < 36 or struct.unpack("<I", program_data[0:4])[0] != 2:
        raise SystemExit("Unexpected program account layout for {}".format(args.program_id))
    programdata_address = b58encode(program_data[4:36])

    pd_account = get_account(url, programdata_address)
    pd = base64.b64decode(pd_account["data"][0])
    if len(pd) <= PROGRAMDATA_HEADER_LEN or struct.unpack("<I", pd[0:4])[0] != 3:
        raise SystemExit("Unexpected programdata layout at {}".format(programdata_address))

    slot = struct.unpack("<Q", pd[4:12])[0]
    authority = b58encode(pd[13:45]) if pd[12] == 1 else "none (immutable)"
    executable = pd[PROGRAMDATA_HEADER_LEN:]
    artifact_sha256, verify_hash, trimmed_len = binary_hashes(executable)

    print("cluster                {}".format(url))
    print("program id             {}".format(args.program_id))
    print("programdata account    {}".format(programdata_address))
    print("last deployed slot     {}".format(slot))
    print("upgrade authority      {}".format(authority))
    print("deployed bytes         {}".format(len(executable)))
    print("bytes without padding  {}".format(trimmed_len))
    print("artifact-sha256        {}".format(artifact_sha256))
    print("verify-hash            {}".format(verify_hash))

    failures = []
    if args.expect_artifact_sha256 and args.expect_artifact_sha256 != artifact_sha256:
        failures.append(
            "artifact-sha256 mismatch: expected {}, on chain {}".format(
                args.expect_artifact_sha256, artifact_sha256
            )
        )
    if args.expect_verify_hash and args.expect_verify_hash != verify_hash:
        failures.append(
            "verify-hash mismatch: expected {}, on chain {}".format(
                args.expect_verify_hash, verify_hash
            )
        )

    if failures:
        print("")
        for line in failures:
            print("FAIL {}".format(line))
        return 1

    if args.expect_artifact_sha256 or args.expect_verify_hash:
        print("")
        print("OK the deployed bytes match the expected hashes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
