#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

RPC_URL="${LINEA_SEPOLIA_RPC_URL:-https://rpc.sepolia.linea.build}"
BLOCK_NUMBER="${HARDHAT_FORK_BLOCK_NUMBER:-28079114}"
PORT="${HARDHAT_PORT:-8545}"
LOCAL_RPC_URL="http://127.0.0.1:${PORT}"

started_node=false
node_pid=""

cleanup() {
  if [[ "$started_node" == true ]]; then
    echo "Stopping Hardhat node..."
    kill "$node_pid" 2>/dev/null || true
    wait "$node_pid" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

wait_for_node() {
  for _ in $(seq 1 30); do
    if curl -sf -o /dev/null "$LOCAL_RPC_URL"; then
      return 0
    fi
    sleep 0.5
  done

  return 1
}

if curl -sf -o /dev/null "$LOCAL_RPC_URL"; then
  echo "Port $PORT is already in use; refusing to reuse an unexpected node." >&2
  exit 1
fi

export HARDHAT_FORK=true
export HARDHAT_FORK_BLOCK_NUMBER="$BLOCK_NUMBER"
export HARDHAT_PORT="$PORT"
export LINEA_SEPOLIA_RPC_URL="$RPC_URL"

echo "Starting forked Hardhat node on port $PORT at Linea Sepolia block $BLOCK_NUMBER..."
npx hardhat node --port "$PORT" &
node_pid=$!
started_node=true

if ! wait_for_node; then
  echo "Failed to start Hardhat node" >&2
  exit 1
fi

test_exit=0
npx hardhat test --network localhost "$@" || test_exit=$?

exit $test_exit
