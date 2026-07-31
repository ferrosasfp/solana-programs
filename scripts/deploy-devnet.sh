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
# PREFLIGHT: does the binary still fit in the account it is going to be written into?
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
anchor deploy --provider.cluster devnet
