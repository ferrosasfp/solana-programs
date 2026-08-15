# Publishing the IDL on chain

Right now the explorer shows this program as raw bytes. Publishing the IDL is what turns
`Unknown instruction` into `deposit`, `release`, `refund` with named accounts and decoded
arguments, for anybody looking at a transaction without cloning the repository.

**Executed on 2026-08-01, again on 2026-08-05 after the WKH-326 deploy, and again on 2026-08-11 after
the WKH-343 one.** The IDL is published. `anchor idl fetch` returns it, and its canonical sha256 is
`cc2761266dcf8335a17562129de040805f37f69cfe654f5be472045ba7bfcd51` over 16,020 bytes.

⚠️ **Until 2026-08-15 this document said that value was `bfbdfe5a…`, that both consumers pinned it,
that republishing "has not been done" and that the tree built something different. All four were
false, and the cause is the one this repository keeps running into: the chain moved and nobody edited
the file.** Measured 2026-08-15, four artefacts read one by one:

| Artefacto | Cómo se midió | Resultado |
|---|---|---|
| la cadena | `getAccountInfo` de `7tbJDv1gwseQamg816gEgwTSpsPpgec5yxhYpbTrcdbC`, zlib inflado desde el offset 96 | `cc276126…`, 16.020 bytes |
| este árbol | `target/idl/escrow.json` canonicalizado | `cc276126…`, 16.020 bytes |
| `wasiai-facilitator` | `ESCROW_IDL_SHA256`, `src/chains/escrow-idl.hash.test.ts:53` | `cc276126…` |
| `chaski-v3` | `ESCROW_IDL_SHA256`, `contracts/idl/escrow-idl.hash.test.ts:50` | `cc276126…` |

The values it replaced, in order: `fb64c937…` (2026-08-01), `bfbdfe5a…` (2026-08-05) and
`d295b7c7…` (published between 2026-08-10 and 2026-08-11). None of the three is pinned by anything
today; they are kept so the movement can be audited. Wherever this document describes an earlier
publication below, it is describing that moment, not today.

**The command in this document does not work, and the way it fails is worth knowing.** See
[What actually worked](#what-actually-worked) at the end. The rest of the document is kept as it was
written, because the reasoning about authority and ordering is still correct.

## Read this first

**The canonical upload requires the program's upgrade authority to sign.** This is not a detail
that can be worked around by using a different wallet. From the
[Program Metadata](https://github.com/solana-program/program-metadata) README:

> - canonical: these are metadata accounts created by the program upgrade authority. They are
>   derived from `[program key, seed]`.
> - non-canonical (a.k.a. _third-party_): these are metadata accounts created by any authority.
>   They are derived from `[program key, authority key, seed]`.

The upgrade authority of `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x` is
`4wPhH4dCndAEbdKJS3TC3JF6eeNfC4JrVej4DoYd54jH`. If the keypair signing the command below is not
that key, the canonical upload fails.

**And there is a caveat about the payoff**, from the same README:

> At the moment the Solana explorer only reads Codama IDLs that are uploaded as canonical metadata
> accounts. But soon it will also support security files and Anchor IDLs.

So the explorer may not render an *Anchor* IDL yet, which is what this program produces. Publishing
still makes the IDL fetchable by any client (`anchor idl fetch`, the `program-metadata` CLI, and
anything built on them) and that is worth doing on its own. Check the explorer afterwards rather
than assuming the labels appear.

## State as measured on devnet on 2026-08-10, at slot `482579471`

This table used to describe the moment *before* the IDL was ever published, and said the account did
not exist. It does exist. Every row below is a measurement with its slot, not a standing claim.

| | |
|---|---|
| Canonical IDL account | `7tbJDv1gwseQamg816gEgwTSpsPpgec5yxhYpbTrcdbC` |
| Exists? | **Yes**, measured at slot `482579471`: owner `ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S`, 5292 bytes. It was published on 2026-07-28, republished on 2026-08-05 right after the WKH-326 program deploy, and republished again on 2026-08-11 after the WKH-343 one, which is the content it serves today. |
| Derivation | PDA of `ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S`, seeds `[program_id, "", "idl" padded to 16 bytes]`, bump 253 |
| IDL to upload | `target/idl/escrow.json`, produced by `anchor build` |
| Canonical sha256 of what is **on chain** | `cc2761266dcf8335a17562129de040805f37f69cfe654f5be472045ba7bfcd51`, over 16,020 bytes, and this is also the value both consumers pin. Read 2026-08-15 off the account itself, not off any file. This row has now been wrong twice with two different values (`fb64c937…`, then `bfbdfe5a…`), both times because a republication happened and the row did not move. |
| Canonical sha256 of what **this tree builds** | **The same value**, `cc276126…`: `target/idl/escrow.json` canonicalised gives 16,020 bytes and that hash. The divergence this row used to describe was real while WKH-343 was undeployed and ended when the program was deployed (2026-08-10) and the IDL republished (2026-08-11). |

The address and the bump were recomputed from the derivation and match what `anchor idl fetch`
looked up, so the account above is the one the tooling will read.

✅ **The WKH-343 republication has been done**: the program was deployed on 2026-08-10 (slot
`482775110`) and the IDL was republished on 2026-08-11, so the account serves the IDL of the binary
that is actually running. This paragraph used to say the opposite ("is not part of WKH-343 and has not
been done"), and it stayed that way for four days after the fact, because nothing in this repository
compares this file against the chain. The gate it points at,
`doc/sdd/004-wkh-343-deposito-destinatario-sin-cuenta-token/runbook-deploy.md`, records the same
correction on its own header. ⚠️ That republication is also the one that cost several hours of outage,
caused by `scripts/publish-idl.sh` opening with an unconditional `close idl`; the story is in the
"On-chain IDL" row of the README.

## The command

```bash
cd /path/to/solana-programs
anchor build            # regenerate target/idl/escrow.json from the current source
anchor idl init --filepath target/idl/escrow.json \
  DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x \
  --provider.cluster devnet \
  --provider.wallet <path to the upgrade authority keypair>
```

`anchor idl init` can only be run once. After that the command is `anchor idl upgrade`, with the
same arguments.

### What that actually runs

`anchor idl init` does not talk to the chain itself. It shells out to the JavaScript client, at a
version pinned inside the Anchor CLI (`anchor-cli-1.1.2/src/metadata.rs`, `PMP_CLIENT_VERSION`):

```bash
npx --yes --package=@solana-program/program-metadata@0.5.1 -- program-metadata \
  --rpc https://api.devnet.solana.com \
  --keypair <wallet> \
  write idl DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x target/idl/escrow.json
```

Two consequences worth knowing before running it:

- It needs **network access to the npm registry** and a working `npx`, not just the Solana
  toolchain. On a locked-down machine this is the step that fails.
- It costs SOL. The IDL is stored on chain, so the account is rent exempt for roughly the
  compressed size of `target/idl/escrow.json` (about 32 KB uncompressed). Fund the authority
  before running it.

### Verify it worked

```bash
anchor idl fetch DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x \
  --provider.cluster devnet > /tmp/onchain-idl.json
```

Then confirm the published IDL is the one this repository builds, rather than eyeballing it:

```bash
python3 - <<'PY'
import json, hashlib
def canon(v):
    if isinstance(v, list):  return '[' + ','.join(canon(x) for x in v) + ']'
    if isinstance(v, dict):  return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + canon(v[k]) for k in sorted(v)) + '}'
    return json.dumps(v, ensure_ascii=False)
for p in ('target/idl/escrow.json', '/tmp/onchain-idl.json'):
    print(hashlib.sha256(canon(json.load(open(p))).encode()).hexdigest(), p)
PY
```

Both lines must print the same hash. `ensure_ascii=False` is load bearing: the IDL carries accented
characters in its `docs` fields, and Python would escape them where JavaScript does not, producing a
different hash for identical content.

## Order of operations

Publish the IDL **after** the program is upgraded, not before. The IDL describes the instructions
the deployed bytes actually have, so publishing a newer tree's IDL against an older deployed program
would hand clients a description with error codes and a `close` account list the program does not
have. This was the situation before 2026-08-01; the custody window and its IDL are both live now
(see the README), and the rule stands for the next upgrade.

The sequence:

1. deploy the custody window (`scripts/deploy-devnet.sh`, which checks the size first)
2. update the hashes and `SOURCE_REPRODUCES_CHAIN` in `.github/workflows/verified-build.yml` and
   the README
3. publish the IDL with the command above
4. re-pin the IDL hash in the two consumers, each in its own repository:
   `chaski-v3/contracts/idl/escrow-idl.hash.test.ts` and
   `wasiai-facilitator/src/chains/escrow-idl.hash.test.ts`

Step 4 is owed regardless of whether the IDL is published on chain, because the vendored copies are
what the consumers actually load. ⚠️ This paragraph used to end "the vendored copies in both consumers
are stale **as of today**", and "today" was 2026-08-01. Measured 2026-08-15: neither is stale, both
pin `cc276126…`. A sentence with "today" in it and no date is a claim that cannot be checked without
guessing when it was written.

**All four ran on 2026-08-01, in that order.** Step 4 ran first in practice, because the consumers
had to ship before the program did for an unrelated reason (see the README section on what the
consumers needed). Both pinned `fb64c937...` at that point.

**And all four ran again on 2026-08-05, for WKH-326, in the documented order this time:** the
program went to devnet in slot `481495859`, the two binary hashes and `SOURCE_REPRODUCES_CHAIN`
were updated in the workflow and the README, the IDL was republished through the buffer path (step
3 still fails the documented way), and the two consumers were re-pinned last, `chaski-v3` at
`bd85dfa` and `wasiai-facilitator` at `f9bddce`. At that moment both pinned
`bfbdfe5aedd55d68e6dda4663b5d26daada815c99db03df34a1601fe4a4d3922`, which is what `anchor idl fetch`
returned then. ⚠️ **That is history, not state.** The same four steps ran again for WKH-343: program
deployed 2026-08-10, IDL republished 2026-08-11, and both consumers re-pinned, each by its own repo's
decision. Measured 2026-08-15, the chain, this tree and both consumers all carry `cc276126…`. The
sentence that used to close this paragraph, "the re-pin of each consumer ... has not happened", is
exactly the kind of claim about another repository that goes false without anybody editing this one.

## What actually worked

`anchor idl init` **fails**, and so does the raw `program-metadata write` it shells out to. Both
print the same thing and nothing else:

```
[Error] The provided transaction plan failed to execute. See the `transactionPlanResult`
attribute for more details.
```

`transactionPlanResult` is never printed, so the message says nothing about the cause. Chasing it
on chain is more informative: every transaction the tool sent **succeeded**, `err: None`. The
writes were landing. What was left behind was a metadata account holding 2862 bytes of a zlib
stream that needs about 4505, so `anchor idl fetch` returned hex that will not decompress.

That is the part worth remembering: **the failure mode is a half written account, not an absent
one.** A consumer calling `anchor idl fetch` against it gets a truncated stream rather than a clean
"not found". It fails loudly, which is the good case, but the state looks published and is not.

What worked was the buffer path, uploading the payload separately and then creating the account
from it in one step:

```bash
KEY=<path to the upgrade authority keypair>

# 1. upload the IDL into a buffer account (this one succeeds where the direct write does not)
npx --yes --package=@solana-program/program-metadata@0.5.1 -- program-metadata \
  --rpc https://api.devnet.solana.com --keypair "$KEY" \
  create-buffer target/idl/escrow.json
# -> buffer: <BUFFER_ADDRESS>

# 2. ⚠️ ONLY if a half written metadata account already exists. `close` DESTROYS the published copy,
#    and running it unconditionally is what caused several hours of outage on 2026-08-11: the
#    justification written next to it, that the tool "does not overwrite", was a conjecture and is
#    false (`write` is create-or-update, and `update` exists). Verify the account is really unreadable
#    before closing it, and check that you have a replacement in hand. `scripts/publish-idl.sh` is the
#    version of this runbook that got the lesson: measured 2026-08-15, the string `close` does not
#    appear in it at all.
npx --yes --package=@solana-program/program-metadata@0.5.1 -- program-metadata \
  --rpc https://api.devnet.solana.com --keypair "$KEY" \
  close idl DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x

# 3. create the canonical account from the buffer
npx --yes --package=@solana-program/program-metadata@0.5.1 -- program-metadata \
  --rpc https://api.devnet.solana.com --keypair "$KEY" \
  create idl DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x --buffer <BUFFER_ADDRESS>
```

`write --buffer` against the existing partial account still failed, so step 2 is not optional when
a previous attempt left something behind. Growing the account in place is where it breaks;
creating it at full size does not.

**`anchor deploy` runs the broken path automatically.** It tries to write the IDL right after the
upgrade lands, so the program deploy reports `Error: Failed to initialize IDL` and exits non zero
**even though the upgrade itself succeeded**. Read the signature it printed and check the chain
before assuming the deploy failed. On 2026-08-01 the upgrade landed in
`4imyuMmnFgUD2CXk2jMcTRSEbRyoyco9zNxiH9Rq6oZJVQBEcWDCBTd4dskNaczWk8SyvwAVhMBqWzWVRMb8iT2K` and the
non zero exit was entirely about this IDL step.
