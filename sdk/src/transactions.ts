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
  walletClient?: WalletClient,
  waitForConfirmation: boolean = false,
): Promise<Partial<TransactionReceipt>> {
  if (!walletClient) {
    throw new Error("Agreements SDK - WalletClient not available");
  }

  const hash: Hash = await walletClient.writeContract(request);

  if (waitForConfirmation) {
    return await publicClient.waitForTransactionReceipt({ hash });
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


