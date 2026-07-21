#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
# CD-7: la upgrade authority del deploy queda en la EOA del deployer. ANTES de mainnet debe
# migrar a multisig/timelock o deployarse `solana program deploy --final` post-auditoría (HU-SOL-19).
# Este script es SOLO para devnet — NUNCA usar para mainnet en esta HU.
solana config set --url devnet
anchor deploy --provider.cluster devnet
