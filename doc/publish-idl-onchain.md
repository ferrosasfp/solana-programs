# Publishing the IDL on chain

Right now the explorer shows this program as raw bytes. Publishing the IDL is what turns
`Unknown instruction` into `deposit`, `release`, `refund` with named accounts and decoded
arguments, for anybody looking at a transaction without cloning the repository.

**Nothing in this document has been executed.** Everything below was read off the tools and the
chain, but the write itself is a decision for whoever holds the upgrade authority.

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
the deployed bytes actually have, and the source in this repository is currently ahead of the chain
(see the README). Publishing this tree's IDL against the older deployed program would hand clients
a description with three error codes and a `close` account list that the deployed program does not
have.

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
