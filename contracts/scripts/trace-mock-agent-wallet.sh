#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

RPC_URL="${LINEA_SEPOLIA_RPC_URL:-https://rpc.sepolia.linea.build}"
BLOCK_NUMBER="${HARDHAT_FORK_BLOCK_NUMBER:-28079114}"
PORT="${HARDHAT_PORT:-18549}"
LOCAL_RPC_URL="http://127.0.0.1:${PORT}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

started_node=false
node_pid=""

cleanup() {
  if [[ "$started_node" == true ]]; then
    kill "$node_pid" 2>/dev/null || true
    wait "$node_pid" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

if curl -sf -o /dev/null "$LOCAL_RPC_URL"; then
  echo "Port $PORT is already in use; refusing to reuse an unexpected node." >&2
  exit 1
fi

export HARDHAT_FORK=true
export HARDHAT_FORK_BLOCK_NUMBER="$BLOCK_NUMBER"
export HARDHAT_PORT="$PORT"
export LINEA_SEPOLIA_RPC_URL="$RPC_URL"

echo "Starting pinned Linea Sepolia fork for the local Agent Wallet mock..."
npx hardhat node --port "$PORT" >/tmp/agreements-mock-agent-wallet-hardhat.log 2>&1 &
node_pid=$!
started_node=true

for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "$LOCAL_RPC_URL"; then
    break
  fi
  sleep 0.5
done
if ! curl -sf -o /dev/null "$LOCAL_RPC_URL"; then
  echo "Failed to start the forked Hardhat node." >&2
  exit 1
fi

# These are Hardhat's public deterministic development keys. The harness forces
# them explicitly so a real key from the caller's environment cannot be used.
export PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
unset DELEGATE_PRIVATE_KEY || true
export DELEGATE_MODE=agent-wallet
export AGENT_WALLET_PROVIDER_LABEL=mock-agent-wallet-cli
export AGENT_WALLET_NODE_BIN="$(command -v node)"
export AGENT_WALLET_CLI_BIN="$SCRIPT_DIR/mock-agent-wallet-cli.cjs"
export MOCK_AGENT_WALLET_RPC_URL="$LOCAL_RPC_URL"

npx hardhat run scripts/real-metamask-erc8004-live.ts --network localhost
