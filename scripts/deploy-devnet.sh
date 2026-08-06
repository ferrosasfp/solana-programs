#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
# This script is for devnet only.
#
# It leaves the upgrade authority in the deployer's own key. That is acceptable on devnet, where
# there is no real value at stake and the program is still changing. It is NOT acceptable for
# mainnet: before any mainnet deployment the authority has to move to a multisig with a timelock,
# or the program has to be deployed with `--final` after an external audit.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT="${REPO_ROOT}/target/deploy/escrow.so"
# Single source of truth for the id is `declare_id!` in programs/escrow/src/lib.rs; the IDL is
# generated from it, so reading the IDL cannot drift from the binary being deployed.
PROGRAM_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["address"])' \
  "${REPO_ROOT}/target/idl/escrow.json")"

# ---------------------------------------------------------------------------
# PREFLIGHT 1: which key signs this? It has to be said out loud, and it has to be the right one.
# ---------------------------------------------------------------------------
#
# `anchor deploy --provider.cluster devnet` pins the network and NOT the wallet, so Anchor falls
# back to `wallet` in Anchor.toml, which is `~/.config/solana/id.json`. That default has two ways
# of going wrong and neither of them says what happened:
#
#   - the file does not exist. The deploy dies with `Unable to read keypair file` AFTER the size
#     preflight passed, which reads like the preflight broke something. That is exactly what
#     happened on 2026-08-05 and it cost a round trip.
#   - the file exists and holds a DIFFERENT key. Worse: the whole binary is uploaded and the
#     upgrade then fails inside the loader for lack of authority, an error that never mentions the
#     wallet. And any command in this script that signs would be signing with whoever that is.
#
# So the keypair is an input, not a default. Pass it as the first argument or in DEPLOY_KEYPAIR.
# Everything below is read only and runs before a single byte is sent to the cluster.
DEPLOY_KEYPAIR="${1:-${DEPLOY_KEYPAIR:-}}"

die() {
  echo "" >&2
  echo "FAIL $*" >&2
  exit 1
}

# Read the authority off the chain instead of hardcoding it here: a hardcoded copy is one more
# thing that can silently go stale after an authority transfer, and the point of this check is to
# be right about who the chain accepts.
echo "==> reading the upgrade authority the chain expects"
ONCHAIN_AUTHORITY="$(python3 "${REPO_ROOT}/scripts/onchain-hash.py" \
  --program-id "${PROGRAM_ID}" --url devnet | awk '/^upgrade authority/ {print $3}')" \
  || die "could not read ${PROGRAM_ID} from devnet. Nothing was sent. Check the network and retry."

case "${ONCHAIN_AUTHORITY}" in
  "" | none)
    die "devnet reports no upgrade authority for ${PROGRAM_ID} (immutable, or the account layout
     changed). This script cannot upgrade it and nothing was sent."
    ;;
esac
echo "    upgrade authority      ${ONCHAIN_AUTHORITY}"

if [ -z "${DEPLOY_KEYPAIR}" ]; then
  die "no keypair given, and this script will not fall back to ~/.config/solana/id.json.

     Usage:  ./scripts/deploy-devnet.sh <path to the upgrade authority keypair>
             DEPLOY_KEYPAIR=<path> ./scripts/deploy-devnet.sh

     The key devnet expects for ${PROGRAM_ID} is
     ${ONCHAIN_AUTHORITY}
     Nothing was sent to the cluster."
fi

[ -f "${DEPLOY_KEYPAIR}" ] || die "keypair file not found: ${DEPLOY_KEYPAIR}

     The key devnet expects for ${PROGRAM_ID} is
     ${ONCHAIN_AUTHORITY}
     Nothing was sent to the cluster."

DEPLOY_PUBKEY="$(solana address -k "${DEPLOY_KEYPAIR}")" \
  || die "could not read a public key out of ${DEPLOY_KEYPAIR}. Nothing was sent."

if [ "${DEPLOY_PUBKEY}" != "${ONCHAIN_AUTHORITY}" ]; then
  die "the keypair given is NOT the upgrade authority of ${PROGRAM_ID}.

     keypair ${DEPLOY_KEYPAIR}
       is    ${DEPLOY_PUBKEY}
     chain expects
             ${ONCHAIN_AUTHORITY}

     Deploying with it would upload the whole binary and then fail inside the loader with an
     error that does not name the wallet. Nothing was sent to the cluster."
fi
echo "    signing with           ${DEPLOY_PUBKEY} (matches the chain)"

# ---------------------------------------------------------------------------
# PREFLIGHT 2: does the binary still fit in the account it is going to be written into?
# ---------------------------------------------------------------------------
#
# `anchor deploy` writes into the ProgramData account that already exists on chain. That account
# was sized at first deploy and does not grow by itself. A binary that outgrew it fails inside the
# loader with an error that never mentions the size, after uploading the whole thing, and leaves a
# buffer account holding SOL. This check is read only, takes a second, and turns that into a
# sentence with the exact command in it.
#
# It runs BEFORE the deploy on purpose. If it fails, nothing has been sent to the cluster.
echo "==> preflight: comparing ${ARTIFACT} against the space reserved on chain"
python3 "${REPO_ROOT}/scripts/programdata-capacity.py" \
  --program-id "${PROGRAM_ID}" \
  --artifact "${ARTIFACT}" \
  --url devnet

# ---------------------------------------------------------------------------
# The other precondition is not mechanical and cannot be: see the runbook section
# "Before upgrading the deployed program" in README.md. This upgrade makes `release` illegal past
# the deadline, so any escrow that is live TODAY, Deposited and already expired, stops being
# releasable at the instant of the upgrade. Enumerate and drain those first:
#
#     python3 scripts/list-live-escrows.py --url devnet
#
# ---------------------------------------------------------------------------

solana config set --url devnet
# Both providers are pinned on the command line. The cluster so an ambient CLI config cannot
# redirect the deploy, the wallet so Anchor.toml's default cannot decide who signs it.
anchor deploy --provider.cluster devnet --provider.wallet "${DEPLOY_KEYPAIR}"
