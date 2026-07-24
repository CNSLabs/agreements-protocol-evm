#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Local-only compatibility shim for the subset of MetaMask Agent Wallet CLI
// consumed by real-metamask-erc8004-live.ts. It is deliberately not a model of
// MetaMask's TEE custody, Guard Mode, simulation, Blockaid scan, MEV protection,
// MFA, or server policy service.

const { JsonRpcProvider, Wallet, getAddress } = require("ethers");

const LINEA_SEPOLIA_CHAIN_ID = 59141n;
const DEFAULT_HARDHAT_DELEGATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const DELEGATION_MANAGER = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
const ALLOWED_TARGETS = new Set(
  [IDENTITY_REGISTRY, DELEGATION_MANAGER].map((address) => address.toLowerCase()),
);

function output(data) {
  process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
}

function fail(error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      error: {
        code: "MOCK_AGENT_WALLET_REJECTED",
        message: error instanceof Error ? error.message : String(error),
      },
    })}\n`,
  );
  process.exitCode = 1;
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function localWallet() {
  const rpcUrl = process.env.MOCK_AGENT_WALLET_RPC_URL;
  if (!rpcUrl) throw new Error("MOCK_AGENT_WALLET_RPC_URL is required");
  const parsedRpcUrl = new URL(rpcUrl);
  if (parsedRpcUrl.hostname !== "127.0.0.1" && parsedRpcUrl.hostname !== "localhost") {
    throw new Error("The mock Agent Wallet refuses non-local RPC endpoints");
  }
  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== LINEA_SEPOLIA_CHAIN_ID) {
    throw new Error(`Expected local chain id ${LINEA_SEPOLIA_CHAIN_ID}`);
  }
  return new Wallet(
    process.env.MOCK_AGENT_WALLET_PRIVATE_KEY || DEFAULT_HARDHAT_DELEGATE_KEY,
    provider,
  );
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--json");
  if (args[0] === "doctor") {
    output({ authenticated: true, initialized: true, mock: true });
    return;
  }

  const wallet = await localWallet();
  if (args[0] === "wallet" && args[1] === "address") {
    output({ address: wallet.address, mock: true });
    return;
  }

  if (args[0] === "wallet" && args[1] === "send-transaction") {
    if (!args.includes("--wait")) throw new Error("The mock requires --wait");
    const chainId = flagValue(args, "--chain-id");
    if (chainId !== LINEA_SEPOLIA_CHAIN_ID.toString()) {
      throw new Error(`Expected --chain-id ${LINEA_SEPOLIA_CHAIN_ID}`);
    }
    const rawPayload = flagValue(args, "--payload");
    if (!rawPayload) throw new Error("Missing --payload");
    const payload = JSON.parse(rawPayload);
    const target = getAddress(payload.to);
    if (!ALLOWED_TARGETS.has(target.toLowerCase())) {
      throw new Error(`Target ${target} is outside the mock allowlist`);
    }
    if (payload.value !== undefined && BigInt(payload.value) !== 0n) {
      throw new Error("The mock permits only zero-value calls");
    }
    const transaction = await wallet.sendTransaction({
      to: target,
      data: payload.data,
      value: 0n,
    });
    await transaction.wait();
    output({ hash: transaction.hash, status: "confirmed", mock: true });
    return;
  }

  throw new Error(`Unsupported mock command: ${args.join(" ")}`);
}

main().catch(fail);
