# Publishing the IDL on chain

Right now the explorer shows this program as raw bytes. Publishing the IDL is what turns
`Unknown instruction` into `deposit`, `release`, `refund` with named accounts and decoded
arguments, for anybody looking at a transaction without cloning the repository.

**Executed on 2026-08-01, and again on 2026-08-05 after the WKH-326 deploy.** The IDL is published.
`anchor idl fetch` returns it, and its canonical sha256 is
`bfbdfe5aedd55d68e6dda4663b5d26daada815c99db03df34a1601fe4a4d3922`, the same value this repository
builds and the same one pinned in `chaski-v3` and `wasiai-facilitator`. The number it replaced,
`fb64c937...`, is the 2026-08-01 one and appears below wherever this document describes that first
publication.

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

## Current state, as read from devnet

| | |
|---|---|
| Canonical IDL account | `7tbJDv1gwseQamg816gEgwTSpsPpgec5yxhYpbTrcdbC` |
| Exists? | **No.** `anchor idl fetch` returns `Account not found at address` |
| Derivation | PDA of `ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S`, seeds `[program_id, "", "idl" padded to 16 bytes]`, bump 253 |
| IDL to upload | `target/idl/escrow.json`, produced by `anchor build` |
| Canonical sha256 of that IDL | `fb64c937dbdab7a58045e663a85724808c4539707fedbdf244e11a28dbe5c071` |

The address and the bump were recomputed from the derivation and match what `anchor idl fetch`
looked up, so the account above is the one the tooling will read.

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
4. re-pin the IDL hash in the two consumers, which is a separate and already pending piece of work:
   `chaski-v3/contracts/idl/escrow-idl.hash.test.ts` and
   `wasiai-facilitator/src/chains/escrow-idl.hash.test.ts`

Step 4 is owed regardless of whether the IDL is published on chain: the custody window already
changed the IDL, so the vendored copies in both consumers are stale as of today.

**All four ran on 2026-08-01, in that order.** Step 4 ran first in practice, because the consumers
had to ship before the program did for an unrelated reason (see the README section on what the
consumers needed). Both pinned `fb64c937...` at that point.

**And all four ran again on 2026-08-05, for WKH-326, in the documented order this time:** the
program went to devnet in slot `481495859`, the two binary hashes and `SOURCE_REPRODUCES_CHAIN`
were updated in the workflow and the README, the IDL was republished through the buffer path (step
3 still fails the documented way), and the two consumers were re-pinned last, `chaski-v3` at
`bd85dfa` and `wasiai-facilitator` at `f9bddce`. Both now pin
`bfbdfe5aedd55d68e6dda4663b5d26daada815c99db03df34a1601fe4a4d3922`, which is what `anchor idl fetch`
returns and what `anchor build` produces in this tree.

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

# 2. if a half written metadata account already exists, close it. `create` will not overwrite,
#    and `write`/`update` fail against it exactly as above.
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
