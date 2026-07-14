// SPDX-License-Identifier: Apache-2.0

import {
  type Abi,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Hash,
  type TransactionReceipt,
  type WriteContractParameters,
} from 'viem';
import { readContractResult, executeTransaction } from "./transactions.js";
import { OnChainAgreement, AgreementJson } from "./types.js";
import { buildInputPayload, inputToBytes32 } from "./payload-builder.js";
import { stateToBytes32 } from "./transformer.js";
import { withSdkSpan } from "./telemetry.js";
import { AgreementEngineABI } from "./generated/AgreementEngineAbi.js";

// Use inlined ABI data (works in both Node.js and browser)
// ABI is extracted directly from contract artifacts as an array
const engineAbi: Abi = AgreementEngineABI as Abi;

/**
 * Agreement instance for interacting with a specific on-chain agreement
 * 
 * Each agreement is a separate clone contract. This class provides
 * methods to interact with a specific agreement instance.
 */
export class AgreementEngine {
  private publicClient: PublicClient;
  private walletClient?: WalletClient;
  public readonly address: Hex;

  /**
   * Create a new Agreement instance
   * 
   * @param address - The agreement contract address (clone address)
   * @param publicClient - viem PublicClient for read-only operations
   * @param walletClient - Optional viem WalletClient for submitting inputs
   * 
   * @example
   * ```typescript
   * // Read-only agreement
   * const agreement = new Agreement("0x...", provider);
   * const state = await agreement.getCurrentState();
   * 
   * // Agreement with signer (can submit inputs)
   * const agreement = new Agreement("0x...", signer);
   * await agreement.submitInput(agreementJson, "grantorData", { ... });
   * ```
   */
  constructor(address: Hex, publicClient: PublicClient, walletClient?: WalletClient) {
    this.address = address;
    this.publicClient = publicClient;
    this.walletClient = walletClient;
  }

  /**
   * Get all on-chain agreement data
   * 
   * @returns Complete on-chain agreement information
   * 
   * @example
   * ```typescript
   * const agreement = new Agreement("0x...", provider);
   * const data = await agreement.getData();
   * console.log(`Current state: ${data.currentState}`);
   * console.log(`Owner: ${data.owner}`);
   * ```
   */
  async getData(): Promise<OnChainAgreement> {
    return await withSdkSpan(
      "agreement_engine.get_data",
      {
        "blockchain.chain_id": this.publicClient.chain?.id,
        "agreement.address": this.address,
      },
      async () => {
        const [docUri, docHash, initialState, currentState, owner] = await Promise.all([
          readContractResult<typeof engineAbi, 'docUri', string>(this.publicClient, {
            address: this.address,
            abi: engineAbi,
            functionName: 'docUri',
            args: [],
          }),
          readContractResult<typeof engineAbi, 'docHash', Hex>(this.publicClient, {
            address: this.address,
            abi: engineAbi,
            functionName: 'docHash',
            args: [],
          }),
          readContractResult<typeof engineAbi, 'initialState', Hex>(this.publicClient, {
            address: this.address,
            abi: engineAbi,
            functionName: 'initialState',
            args: [],
          }),
          readContractResult<typeof engineAbi, 'currentState', Hex>(this.publicClient, {
            address: this.address,
            abi: engineAbi,
            functionName: 'currentState',
            args: [],
          }),
          readContractResult<typeof engineAbi, 'owner', Hex>(this.publicClient, {
            address: this.address,
            abi: engineAbi,
            functionName: 'owner',
            args: [],
          }),
        ]);

        return {
          address: this.address,
          docUri,
          docHash: docHash as Hex,
          initialState: initialState as Hex,
          currentState: currentState as Hex,
          owner: owner as Hex,
        };
      },
    );
  }

  /**
   * Get the current state of the agreement
   * 
   * @param agreementJson - Optional agreement JSON. If provided, returns the state name string instead of bytes32
   * @returns The current state as bytes32, or state name string if agreementJson is provided
   * 
   * @example
   * ```typescript
   * // Get bytes32 state
   * const agreement = new Agreement("0x...", provider);
   * const stateBytes32 = await agreement.getCurrentState();
   * 
   * // Get state name string
   * const stateName = await agreement.getCurrentState(agreementJson);
   * ```
   */
  async getCurrentState(agreementJson?: AgreementJson): Promise<Hex | string> {
    return await withSdkSpan(
      "agreement_engine.get_current_state",
      {
        "blockchain.chain_id": this.publicClient.chain?.id,
        "agreement.address": this.address,
      },
      async () => {
        const state = await readContractResult<typeof engineAbi, 'currentState', Hex>(this.publicClient, {
          address: this.address,
          abi: engineAbi,
          functionName: 'currentState',
          args: [],
        });
        const stateHex = state;

        if (agreementJson) {
          // Look up state name by comparing bytes32 values
          const states = Object.keys(agreementJson.execution.states);
          for (const stateName of states) {
            if (stateToBytes32(stateName).toLowerCase() === stateHex.toLowerCase()) {
              return stateName;
            }
          }
          throw new Error(`State ${stateHex} not found in agreement states`);
        }

        return stateHex;
      },
    );
  }

  /**
   * Get the initial state of the agreement
   * 
   * @returns The initial state as bytes32
   */
  async getInitialState(): Promise<Hex> {
    const state = await readContractResult<typeof engineAbi, 'initialState', Hex>(this.publicClient, {
      address: this.address,
      abi: engineAbi,
      functionName: 'initialState',
      args: [],
    });
    return state;
  }

  /**
   * Get the document URI
   * 
   * @returns The document URI string
   */
  async getDocUri(): Promise<string> {
    return await readContractResult<typeof engineAbi, 'docUri', string>(this.publicClient, {
      address: this.address,
      abi: engineAbi,
      functionName: 'docUri',
      args: [],
    });
  }

  /**
   * Get the document hash
   * 
   * @returns The document hash as bytes32
   */
  async getDocHash(): Promise<Hex> {
    const hash = await readContractResult<typeof engineAbi, 'docHash', Hex>(this.publicClient, {
      address: this.address,
      abi: engineAbi,
      functionName: 'docHash',
      args: [],
    });
    return hash;
  }

  /**
   * Get the owner of the agreement
   * 
   * @returns The owner address
   */
  async getOwner(): Promise<Hex> {
    const owner = await readContractResult<typeof engineAbi, 'owner', Hex>(this.publicClient, {
      address: this.address,
      abi: engineAbi,
      functionName: 'owner',
      args: [],
    });
    return owner;
  }

  /**
   * Submit an input to progress the agreement's state machine
   * 
   * @param agreement - The agreement JSON definition (for field type resolution)
   * @param inputId - The input identifier (e.g., "grantorData")
   * @param data - Plain object with field values
   * @param waitForConfirmation - Whether to wait for transaction confirmation (default: false)
   * @returns Transaction hash, or receipt if waitForConfirmation is true
   * 
   * @example
   * ```typescript
   * const agreement = new Agreement("0x...", signer);
   * 
   * // Fire and forget
   * const txHash = await agreement.submitInput(
   *   agreementJson,
   *   "grantorData",
   *   { grantorName: "Alice", scope: "Development of Web3 tooling" }
   * );
   * 
   * // Wait for confirmation
   * const receipt = await agreement.submitInput(
   *   agreementJson,
   *   "grantorData",
   *   { grantorName: "Alice", scope: "Development of Web3 tooling" },
   *   true
   * );
   * console.log(`Transaction confirmed in block ${receipt.blockNumber}`);
   * ```
   */
  async submitInput(
    agreement: AgreementJson,
    inputId: string,
    data: Record<string, unknown>,
    waitForConfirmation: boolean = false
  ): Promise<Hash | TransactionReceipt> {
    return await withSdkSpan(
      "agreement_engine.submit_input",
      {
        "blockchain.chain_id": this.publicClient.chain?.id,
        "agreement.address": this.address,
        "agreement.input_id": inputId,
      },
      async () => {
        if (!this.walletClient) {
          throw new Error(
            "WalletClient required for submitting inputs. Pass a walletClient to the constructor."
          );
        }

        // Build payload using payload-builder
        const payload = buildInputPayload(agreement, inputId, data);
        const inputIdBytes32 = inputToBytes32(inputId);

        // Build the write contract request
        const request: WriteContractParameters = {
          chain: null,
          account: this.walletClient.account!,
          address: this.address,
          abi: engineAbi,
          functionName: 'submitInput',
          args: [inputIdBytes32, payload],
        };

        // Use executeTransaction utility for optional waiting
        const result = await executeTransaction(
          request,
          this.publicClient,
          this.walletClient,
          waitForConfirmation
        );

        // Return hash if not waiting, full receipt if waiting
        if (waitForConfirmation) {
          return result as TransactionReceipt;
        }
        return result.transactionHash!;
      },
    );
  }

  /**
   * Get the verifier address for a given key
   * 
   * @param key - Verifier key
   * @returns The verifier contract address, or zero address if not registered
   */
  async getVerifier(key: Hex): Promise<Hex> {
    const verifier = await readContractResult<typeof engineAbi, 'verifierRegistry', Hex>(this.publicClient, {
      address: this.address,
      abi: engineAbi,
      functionName: 'verifierRegistry',
      args: [key],
    });
    return verifier;
  }

  /**
   * Get the current nonce for a signer address
   * 
   * @param signer - The signer address to get the nonce for
   * @returns The current nonce value
   */
  async getNonce(signer: Hex): Promise<bigint> {
    const nonce = await readContractResult<typeof engineAbi, 'nonces', bigint>(this.publicClient, {
      address: this.address,
      abi: engineAbi,
      functionName: 'nonces',
      args: [signer],
    });
    return nonce;
  }

  /**
   * Create an EIP-712 permit signature for submitting an input
   * 
   * @param signer - The signer that will create the signature (must be a Signer, not Provider)
   * @param agreement - The agreement JSON definition
   * @param inputId - The input identifier (e.g., "grantorData")
   * @param data - Plain object with field values
   * @param deadline - Unix timestamp when the permit expires
   * @returns Opaque EOA or ERC-1271 signature bytes and the signer address
   * 
   * @example
   * ```typescript
   * const agreement = new AgreementEngine("0x...", provider);
   * const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
   * 
   * const { signature, signerAddress } = await agreement.createPermitSignature(
   *   signer,
   *   agreementJson,
   *   "grantorData",
   *   { grantorName: "Alice" },
   *   deadline
   * );
   * ```
   */
  async createPermitSignature(
    walletClient: WalletClient,
    agreement: AgreementJson,
    inputId: string,
    data: Record<string, unknown>,
    deadline: number
  ): Promise<{
    signature: Hex;
    signerAddress: Hex;
  }> {
    // Get current nonce for the signer
    const account = walletClient.account;
    if (!account) {
      throw new Error("WalletClient must be connected to an account to sign typed data");
    }
    const signerAddress = account.address as Hex;
    const nonce = await this.getNonce(signerAddress);

    // Build the payload
    const payload = buildInputPayload(agreement, inputId, data);
    const inputIdBytes32 = inputToBytes32(inputId);

    // Get chain ID
    const chainId = await this.publicClient.getChainId();

    // EIP-712 domain & types (kept structurally identical to previous ethers version)
    const domain = {
      name: "AgreementEngine",
      version: "1",
      chainId,
      verifyingContract: this.address,
    } as const;

    const types = {
      PermitInput: [
        { name: "inputId", type: "bytes32" },
        { name: "payload", type: "bytes" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    } as const;

    const message = {
      inputId: inputIdBytes32,
      payload: payload,
      nonce: nonce,
      deadline: BigInt(deadline),
    } as const;

    // Sign using viem WalletClient
    const signature = await walletClient.signTypedData({
      account,
      domain,
      types,
      primaryType: "PermitInput",
      message,
    });

    return {
      signature,
      signerAddress,
    };
  }

  /**
   * Submit an input using a permit signature, allowing someone else to submit on behalf of the signer
   * 
   * @param signer - The address that signed the permit
   * @param agreement - The agreement JSON definition
   * @param inputId - The input identifier
   * @param data - Plain object with field values
   * @param deadline - Unix timestamp when the permit expires
   * @param signature - Opaque EOA or ERC-1271 permit signature bytes
   * @param waitForConfirmation - Whether to wait for transaction confirmation (default: false)
   * @returns Transaction hash, or receipt if waitForConfirmation is true
   * 
   * @example
   * ```typescript
   * // Signer creates permit off-chain
   * const { signature, signerAddress } = await agreement.createPermitSignature(
   *   signer,
   *   agreementJson,
   *   "grantorData",
   *   { grantorName: "Alice" },
   *   deadline
   * );
   * 
   * // Anyone can submit using the permit
   * const agreementWithSubmitter = new AgreementEngine(agreementAddress, submitterSigner);
   * 
   * // Fire and forget
   * const txHash = await agreementWithSubmitter.submitInputWithPermit(
   *   signerAddress,
   *   agreementJson,
   *   "grantorData",
   *   { grantorName: "Alice" },
   *   deadline,
   *   signature
   * );
   * 
   * // Wait for confirmation
   * const receipt = await agreementWithSubmitter.submitInputWithPermit(
   *   signerAddress,
   *   agreementJson,
   *   "grantorData",
   *   { grantorName: "Alice" },
   *   deadline,
   *   signature,
   *   true
   * );
   * console.log(`Transaction confirmed in block ${receipt.blockNumber}`);
   * ```
   */
  async submitInputWithPermit(
    signer: Hex,
    agreement: AgreementJson,
    inputId: string,
    data: Record<string, unknown>,
    deadline: number,
    signature: Hex,
    waitForConfirmation: boolean = false
  ): Promise<Hash | TransactionReceipt> {
    return await withSdkSpan(
      "agreement_engine.submit_input_with_permit",
      {
        "blockchain.chain_id": this.publicClient.chain?.id,
        "agreement.address": this.address,
        "agreement.input_id": inputId,
        "wallet.signer": signer,
      },
      async () => {
        if (!this.walletClient) {
          throw new Error(
            "WalletClient required for submitting inputs. Pass a walletClient to the constructor."
          );
        }

        // Build payload (must match what was signed)
        const payload = buildInputPayload(agreement, inputId, data);
        const inputIdBytes32 = inputToBytes32(inputId);

        // Build the write contract request
        const request: WriteContractParameters = {
          chain: null,
          account: this.walletClient.account!,
          address: this.address,
          abi: engineAbi,
          functionName: 'submitInputWithPermit',
          args: [
            signer,
            inputIdBytes32,
            payload,
            BigInt(deadline),
            signature,
          ],
        };

        // Use executeTransaction utility for optional waiting
        const result = await executeTransaction(
          request,
          this.publicClient,
          this.walletClient,
          waitForConfirmation
        );

        // Return hash if not waiting, full receipt if waiting
        if (waitForConfirmation) {
          return result as TransactionReceipt;
        }
        return result.transactionHash!;
      },
    );
  }
}
