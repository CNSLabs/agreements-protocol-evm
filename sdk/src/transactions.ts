// SPDX-License-Identifier: Apache-2.0

import {
  type Abi,
  type ContractFunctionName,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
  type WriteContractParameters,
} from 'viem';
import { withSdkSpan } from "./telemetry.js";

/**
 * Execute a previously simulated transaction request.
 *
 * This mirrors the Verax pattern:
 *   - simulateContract(...) → request
 *   - executeTransaction(request, publicClient, walletClient, waitForConfirmation)
 */
export async function executeTransaction(
  request: WriteContractParameters,
  publicClient: PublicClient,
  walletClient: WalletClient | undefined,
  waitForConfirmation: true,
): Promise<TransactionReceipt>;
export async function executeTransaction(
  request: WriteContractParameters,
  publicClient: PublicClient,
  walletClient?: WalletClient,
  waitForConfirmation?: false,
): Promise<{ transactionHash: Hash }>;
export async function executeTransaction(
  request: WriteContractParameters,
  publicClient: PublicClient,
  walletClient: WalletClient | undefined,
  waitForConfirmation: boolean,
): Promise<TransactionReceipt | { transactionHash: Hash }>;
export async function executeTransaction(
  request: WriteContractParameters,
  publicClient: PublicClient,
  walletClient?: WalletClient,
  waitForConfirmation: boolean = false,
): Promise<TransactionReceipt | { transactionHash: Hash }> {
  if (!walletClient) {
    throw new Error("Agreements SDK - WalletClient not available");
  }

  const contractAddress = typeof request.address === "string" ? request.address : undefined;
  const functionName =
    typeof request.functionName === "string" ? request.functionName : undefined;
  const chainId = publicClient.chain?.id;

  const hash: Hash = await withSdkSpan(
    "evm.send_tx",
    {
      "blockchain.chain_id": chainId,
      "blockchain.contract.address": contractAddress,
      "blockchain.contract.function_name": functionName,
      "evm.wait_for_confirmation": waitForConfirmation,
    },
    async (span) => {
      const txHash = await walletClient.writeContract(request);
      span.setAttribute("blockchain.transaction_hash", txHash);
      return txHash;
    },
  );

  if (waitForConfirmation) {
    return await withSdkSpan(
      "evm.wait_receipt",
      {
        "blockchain.chain_id": chainId,
        "blockchain.contract.address": contractAddress,
        "blockchain.contract.function_name": functionName,
        "blockchain.transaction_hash": hash,
      },
      async () => publicClient.waitForTransactionReceipt({ hash }),
    );
  }

  return { transactionHash: hash };
}

/**
 * Small helper to keep readContract callsites terse and consistently typed.
 */
export async function readContractResult<
  TAbi extends Abi,
  TFunctionName extends ContractFunctionName<TAbi>,
  TResult,
>(
  client: PublicClient,
  params: {
    address: `0x${string}`;
    abi: TAbi;
    functionName: TFunctionName;
    args?: readonly unknown[];
  },
): Promise<TResult> {
  return client.readContract(params as any) as Promise<TResult>;
}
