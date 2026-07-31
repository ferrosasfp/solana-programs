#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
# This script is for devnet only.
#
# It leaves the upgrade authority in the deployer's own key. That is acceptable on devnet, where
# there is no real value at stake and the program is still changing. It is NOT acceptable for
# mainnet: before any mainnet deployment the authority has to move to a multisig with a timelock,
# or the program has to be deployed with `--final` after an external audit.
solana config set --url devnet
anchor deploy --provider.cluster devnet
