#!/usr/bin/env python3
"""Guardian for the ~70 lines of hand-rolled crypto in scripts/list-live-escrows.py.

WHY THIS FILE EXISTS. That script decides the half of the WKH-343 deploy gate that says
whether the beneficiary can be paid, and it answers it by DERIVING an address: sha256 plus
an ed25519 off-curve test, written by hand with the standard library. The derivation was
validated once, against `@solana/spl-token`, during the fix pack — and then nothing
exercised it. `npm test` runs bankrun tests over the Rust program and never imports this
Python. So the code that authorises a deploy had no guardian, and a wrong answer here is a
`yes` on a pair the program rejects, which is precisely the defect the fix pack closed.

Standard library only, no network, no keypairs, exit code 1 on any failure. Wired into
.github/workflows/ci.yml so it runs on every push. If it is not in that workflow it does
not exist: a test nobody calls is a file, not a control.

    python3 scripts/derivation-selftest.py

WHAT THE VECTORS ARE, AND WHY EACH ONE IS HERE. None of them is a copy of this script's own
output; every expected address comes from an INDEPENDENT implementation
(`@solana/spl-token`'s getAssociatedTokenAddressSync / web3.js findProgramAddressSync) or
from the chain itself.

  1. The two REAL devnet pairs of this program. One exists on chain, one does not, and the
     second is the one the deploy gate is blocked on. If the derivation drifts, these two
     move and every conclusion written in the runbook and the README stops holding.
  2. LOW-BUMP pairs, 248 down to 242. A digest lands ON the curve roughly half the time, so
     the loop usually finds its answer within a couple of iterations and vectors that stop
     at 255 or 254 prove almost nothing about it. These force it to keep going, and each
     one pins the BUMP as well as the address: a loop that iterated in the wrong direction,
     or that mutated the seed buffer between rounds, gets the bump wrong first.
  3. The DALEK-vs-RFC8032 divergence, as invariants rather than as a table. The runtime uses
     curve25519_dalek, which takes the low 255 bits as `y` and accepts a non-canonical
     encoding; `@solana/web3.js` implements RFC 8032 strictly and rejects it. The two
     disagree, and on those inputs `is_on_curve` must follow the RUNTIME. Two properties
     capture it without needing dalek here:
       (a) bit 255 is the sign of x and cannot change WHETHER x exists, so flipping it must
           not change the answer;
       (b) a `y` in [p, 2^255) must behave exactly like `y - p`, because the field
           arithmetic reduces mod p.
     A stricter implementation fails (b) by construction — which is the point: this is not
     a test that the code is "right in general", it is a test that it agrees with the chain.
  4. base58 round trips, including LEADING ZEROS, which are the byte pattern a naive
     big-integer encoder silently drops.
  5. That `find_program_address` never returns bump 0, which is what the runtime does.
"""

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "lle", os.path.join(HERE, "list-live-escrows.py")
)
lle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lle)

# ---------------------------------------------------------------------------
# 1. The two real devnet pairs. Beneficiary of all 10 escrow_state accounts of
#    this program, against the two mints that show up around it. The first ATA
#    exists on chain (balance read 2026-08-10 at slot 482608313); the SECOND DOES
#    NOT, and that is the unsatisfied half (ii) of the W6 gate.
# ---------------------------------------------------------------------------
BENEFICIARY = "Dr37oH97XPapexJCaE8McQJDxjKiBW6u6Hz7jzFyLXNq"
REAL_PAIRS = [
    # (owner, mint, expected ATA)
    (BENEFICIARY,
     "8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q",   # our 6-decimal test mint
     "BQC6fXinyR4KnESJso1oY8nnbQjXjbFAJb221V7UkiVe"),
    (BENEFICIARY,
     "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",   # Circle's devnet USDC
     "Cq9AinM9WCry8Pyk5EsFJ2hdQomKAUES7Cq7YLunRGMC"),
]

# ---------------------------------------------------------------------------
# 2. Low-bump vectors: (bump, owner, mint, expected ATA). Produced with
#    @solana/web3.js findProgramAddressSync over the ATA seeds, by sampling random
#    pairs until each bump appeared. They are inputs, not secrets: no keypair is
#    needed to derive an address.
# ---------------------------------------------------------------------------
LOW_BUMP_PAIRS = [
    (248, "3oj2Siie8zSNAPbY1kV28Kkj4ZeLUkgWGfZpdnXMGpfx",
          "48MQ8DegyTEwmujqAZvPu5P4rQBvkYg39iURAuDmsANd",
          "FhkKL3WoAF47WTRkc3NWbjtEmccumy2z5mtBBVUSmh6Z"),
    (247, "3yMgHRUALWNLroxbTx5djZ35kxNXSY6JC1e1TmLuGyDw",
          "97RgxCY6Re74FDoECtkeTf6EqQ3Y62cipoLs1cL5puK1",
          "FuBGmy9qMNejWfdxPekzBGayPvgZfbyL6r3iT8TFH8k1"),
    (246, "GURBAdbQxUKgYUGvP4TxynGWx5ukptdB7quqnne4xKm2",
          "7zAeuTSmhp28Zw8bjafggVYJpDfjYLaUkEXWAgNcpLUk",
          "GBkas9936NGkXSBQxNCXXrxrvBuDi7ypqyKSdvytzpcd"),
    (245, "BfD2v2K9osT9kmuHUGiUoR6LWmwPgKXeXqGuKfdjKrwq",
          "8rbMKTT4P84NBpbEXdANTwtTeNhyyKbe7adgpwLrroeT",
          "FREmkLAQVKcMR243J2fmbxYb2MsJdWodeJRW2hksuCxn"),
    (244, "5tpHe2432cxtJjhERRrbchwMkPCxKaThLBVwNUQ9Ynwz",
          "CV856XFyL5jQ7eYigaHJViWL81D5XPYfkPSkSCsqP2Jg",
          "2nYvpdZSpqhDyij8w6PdezKPxYkiZcbgXZN5n6hudNic"),
    (243, "Mat3dowjxU8VsFKarda4whvz42JjTX4wtpoNiXgaLHf",
          "ASMRZGrxYSj5QhC1tgF2V5qzHuiJP7DgcQF6x5em25MD",
          "82xG3sodnxxRbNpoQsfpG6VugC3skuSMRtg7GrnA3rUD"),
    (242, "5QicvmuVA9S97woSstBzBUYcPwNy6PjBtAej8nrNJCxE",
          "C73HKWBJCs2m1tP3Rctf3rBruLqxumgfE1sFWHs6fkkj",
          "4QSPioy8vk8QLonYA2UFy1GsL5admpt2gwiZjRtXcTXE"),
]

_P = 2**255 - 19
failures = []


def check(label, got, expected):
    if got != expected:
        failures.append(label)
        print("FAIL  {}".format(label))
        print("        got      {!r}".format(got))
        print("        expected {!r}".format(expected))
    else:
        print("ok    {}".format(label))


def ata_and_bump(owner, mint):
    return lle.find_program_address(
        [lle.b58decode(owner), lle.b58decode(lle.TOKEN_PROGRAM_ID), lle.b58decode(mint)],
        lle.ASSOCIATED_TOKEN_PROGRAM_ID,
    )


print("== 0. the two program ids that go into the seeds ==")
check("TOKEN_PROGRAM_ID", lle.TOKEN_PROGRAM_ID,
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
check("ASSOCIATED_TOKEN_PROGRAM_ID", lle.ASSOCIATED_TOKEN_PROGRAM_ID,
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")

print("")
print("== 1. the two real devnet pairs ==")
for owner, mint, expected in REAL_PAIRS:
    check("canonical_ata({}..., {}...)".format(owner[:6], mint[:6]),
          lle.canonical_ata(owner, mint), expected)

print("")
print("== 2. low-bump vectors: address AND bump ==")
for bump, owner, mint, expected in LOW_BUMP_PAIRS:
    addr, got_bump = ata_and_bump(owner, mint)
    check("bump {} address".format(bump), addr, expected)
    check("bump {} value".format(bump), got_bump, bump)

print("")
print("== 3. agreement with the RUNTIME, where the runtime and RFC 8032 differ ==")
# (a) bit 255 is the sign of x: it cannot change whether x exists.
for i in range(64):
    raw = bytes([(i * 37 + k * 11) % 256 for k in range(32)])
    flipped = raw[:31] + bytes([raw[31] ^ 0x80])
    if lle.is_on_curve(raw) != lle.is_on_curve(flipped):
        failures.append("bit255 independence on vector {}".format(i))
print("ok    bit 255 does not change the answer (64 vectors)")
# (b) a non-canonical y in [p, 2^255) behaves like y - p. An RFC 8032 strict
#     implementation rejects these outright; dalek, and therefore the chain, does not.
noncanonical = [_P, _P + 1, _P + 2, _P + 7, (1 << 255) - 1]
for y in noncanonical:
    a = lle.is_on_curve(y.to_bytes(32, "little"))
    b = lle.is_on_curve((y - _P).to_bytes(32, "little"))
    check("non-canonical y=p+{} matches y-p".format(y - _P), a, b)

print("")
print("== 4. base58 round trips, leading zeros included ==")
check("b58encode(32 zero bytes)", lle.b58encode(b"\x00" * 32), "1" * 32)
check("b58decode round trip, 1 leading zero",
      lle.b58decode(lle.b58encode(b"\x00" + b"\x11" * 31)), b"\x00" + b"\x11" * 31)
check("b58decode round trip, 4 leading zeros",
      lle.b58decode(lle.b58encode(b"\x00" * 4 + b"\xfe" * 28)), b"\x00" * 4 + b"\xfe" * 28)
check("b58 known vector: system program",
      lle.b58encode(b"\x00" * 32), "11111111111111111111111111111111")
for owner, mint, _ in REAL_PAIRS:
    check("b58 round trip {}...".format(owner[:6]),
          lle.b58encode(lle.b58decode(owner)), owner)
    check("b58 round trip {}...".format(mint[:6]),
          lle.b58encode(lle.b58decode(mint)), mint)

print("")
print("== 5. the loop stops at 1, like Pubkey::find_program_address ==")
bumps = set()
for i in range(200):
    seed = bytes([i]) * 32
    _addr, bump = lle.find_program_address([seed], lle.ASSOCIATED_TOKEN_PROGRAM_ID)
    bumps.add(bump)
check("no derivation returned bump 0", 0 in bumps, False)
check("bumps stay inside 1..255", all(1 <= b <= 255 for b in bumps), True)

print("")
if failures:
    print("SELF-TEST FAILED: {} check(s)".format(len(failures)))
    for f in failures:
        print("  - {}".format(f))
    sys.exit(1)
print("SELF-TEST OK: the derivation still agrees with every independent vector.")
sys.exit(0)
