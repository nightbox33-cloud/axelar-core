#!/bin/bash
# Reproduce el clonado de la fundación axelarnetwork + commit exacto por repo.
set -e
mkdir -p foundation && cd foundation
REPOS="axelar-core axelar-gmp-sdk-solidity axelar-cgp-solidity interchain-token-service \
axelar-contract-deployments axelar-amplifier axelar-cgp-sui axelar-amplifier-solana \
axelar-amplifier-stellar axelar-cgp-aptos axelar-configs"
for r in $REPOS; do
  [ -d "$r" ] || git clone --quiet "https://github.com/axelarnetwork/$r.git"
  printf "%-32s %s\n" "$r" "$(git -C $r rev-parse HEAD)"
done
