// SPDX-License-Identifier: Apache-2.0

import {
  type Abi,
  type Hex,
  type PublicClient,
  type WalletClient,
  type WriteContractParameters,
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
} from 'viem';
import { executeTransaction, readContractResult } from "./transactions.js";
import { withSdkSpan } from "./telemetry.js";
import { AgreementJson, FactoryConfig, InputDef, Transition, DataField, VerifierInit, ActionInit } from "./types.js";
import { transformAgreementToOnChainParams, InitValue } from "./transformer.js";
import { AgreementFactoryABI } from "./generated/AgreementFactoryAbi.js";

// Use inlined ABI data (works in both Node.js and browser)
// ABI is extracted directly from contract artifacts as an array
const factoryAbi: Abi = AgreementFactoryABI as Abi;

// EIP-712 field lists. Names, types and order must match AgreementFactory.sol
// exactly (PERMIT_WITH_ACTIONS_TYPEHASH and DETERMINISTIC_PERMIT_WITH_ACTIONS_TYPEHASH).
const PERMIT_WITH_ACTIONS_FIELDS = [
  { name: "signer", type: "address" },
  { name: "docUri", type: "string" },
  { name: "docHash", type: "bytes32" },
  { name: "initialState", type: "bytes32" },
  { name: "inputDefsHash", type: "bytes32" },
  { name: "transitionsHash", type: "bytes32" },
  { name: "initVarsHash", type: "bytes32" },
  { name: "verifiersHash", type: "bytes32" },
  { name: "actionsHash", type: "bytes32" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;

const DETERMINISTIC_PERMIT_WITH_ACTIONS_FIELDS = [
  { name: "signer", type: "address" },
  { name: "docUri", type: "string" },
  { name: "docHash", type: "bytes32" },
  { name: "initialState", type: "bytes32" },
  { name: "inputDefsHash", type: "bytes32" },
  { name: "transitionsHash", type: "bytes32" },
  { name: "initVarsHash", type: "bytes32" },
  { name: "verifiersHash", type: "bytes32" },
  { name: "actionsHash", type: "bytes32" },
  { name: "salt", type: "bytes32" },
  { name: "predictedAgreement", type: "address" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;

export type CreateAgreementOptions = {
  docUri?: string;
  initValues?: Record<string, InitValue>;
  verifiers?: VerifierInit[];
};

/**
 * Opaque permit signature bytes, passed to the factory unchanged: a 65-byte
 * EOA signature, or whatever bytes an ERC-1271 signer contract accepts.
 */
export type CreateAgreementPermitSignature = Hex;

interface FactoryClients {
  walletClient: WalletClient;
  publicClient: PublicClient;
};

/**
 * Factory for creating new Agreement instances
 * 
 * The factory uses EIP-1167 minimal proxy clones where each agreement
 * is deployed as a separate contract. The factory creates clones that
 * point to a shared implementation.
 */
export class AgreementFactory {
  private readonly clients: FactoryClients;
  private config: FactoryConfig;
  private chainId?: number;

  /**
   * Create a new AgreementFactory instance
   * 
   * @param config - Factory configuration
   * @param config.factoryAddress - The AgreementFactory contract address (required)
   * @param config.chainId - Optional chain ID for reference (can be fetched via getChainId())
   * @param clients.walletClient - Wallet client for creating agreements (must be connected to an account)
   * @param clients.publicClient - Public client for reading receipts / logs
   * 
   * @example
   * ```typescript
   * const factory = new AgreementFactory(
   *   { factoryAddress: "0x..." },
   *   { publicClient, walletClient }
   * );
   * ```
   */
  constructor(config: FactoryConfig, clients: FactoryClients) {
    this.config = config;
    this.clients = clients;
  }

  /**
   * Get the current chain ID from the signer's provider
   * 
   * @returns The chain ID as a number
   */
  async getChainId(): Promise<number> {
    if (this.chainId !== undefined) {
      return this.chainId;
    }
    const chainId = await this.clients.publicClient.getChainId();
    this.chainId = chainId;
    return chainId;
  }

  /**
   * Internal helper: simulate a contract call, and if the RPC complains about
   * gas price being below the configured minimum, bump gas values and re-simulate.
   */
  private async simulate(
    functionName:
      | 'createAgreement'
      | 'createAgreementDeterministic'
      | 'createAgreementWithPermit'
      | 'createAgreementDeterministicWithPermit',
    args: readonly unknown[],
  ): Promise<{ request: WriteContractParameters }> {
    const client = this.clients.publicClient;
    const walletClient = this.clients.walletClient;
    const account = walletClient.account;
    if (!account) {
      throw new Error("WalletClient must be connected to an account to simulate/write contracts");
    }

    return await withSdkSpan(
      "evm.simulate_tx",
      {
        "blockchain.chain_id": this.config.chainId ?? client.chain?.id,
        "blockchain.contract.address": this.config.factoryAddress,
        "blockchain.contract.function_name": functionName,
      },
      async () =>
        client.simulateContract({
          account,
          address: this.config.factoryAddress,
          abi: factoryAbi,
          functionName,
          args,
        }),
    );
  }

  private parseAgreementDeployedAddress(receipt: Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>): Hex {
    let deployedAddress: Hex | undefined;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: factoryAbi,
          data: log.data,
          topics: log.topics,
          eventName: 'AgreementDeployed',
        });
        if (decoded.eventName === 'AgreementDeployed') {
          // @ts-expect-error - viem decodes args in a generic way; we know this event has `agreement`
          deployedAddress = decoded.args.agreement as Hex;
          break;
        }
      } catch {
        // Not the event we care about, skip
      }
    }

    if (!deployedAddress) {
      throw new Error("AgreementDeployed event not found in transaction receipt");
    }

    return deployedAddress;
  }

  private hashInputDefs(inputDefs: InputDef[]): Hex {
    // Matches: keccak256(abi.encode(inputDefs_))
    return keccak256(
      encodeAbiParameters(
        [
          {
            type: 'tuple[]',
            name: 'inputDefs',
            components: [
              { name: 'id', type: 'bytes32' },
              {
                name: 'fields',
                type: 'tuple[]',
                components: [
                  { name: 'fieldId', type: 'bytes32' },
                  { name: 'fType', type: 'uint8' },
                  { name: 'required', type: 'bool' },
                  { name: 'persist', type: 'bool' },
                ],
              },
              {
                name: 'conditions',
                type: 'tuple[]',
                components: [
                  { name: 'op', type: 'uint8' },
                  { name: 'fieldId', type: 'bytes32' },
                  { name: 'bytesArg', type: 'bytes' },
                ],
              },
              { name: 'verifierKeys', type: 'bytes32[]' },
            ],
          },
        ],
        [
          inputDefs.map((d) => ({
            id: d.id,
            fields: d.fields.map((f) => ({
              fieldId: f.fieldId,
              fType: f.fType,
              required: f.required,
              persist: f.persist,
            })),
            conditions: d.conditions.map((c) => ({
              op: c.op,
              fieldId: c.fieldId,
              bytesArg: c.bytesArg,
            })),
            verifierKeys: d.verifierKeys,
          })),
        ],
      ),
    );
  }

  private hashTransitions(transitions: Transition[]): Hex {
    // Matches: keccak256(abi.encode(transitions_))
    return keccak256(
      encodeAbiParameters(
        [
          {
            type: 'tuple[]',
            name: 'transitions',
            components: [
              { name: 'fromState', type: 'bytes32' },
              { name: 'toState', type: 'bytes32' },
              { name: 'inputId', type: 'bytes32' },
            ],
          },
        ],
        [
          transitions.map((t) => ({
            fromState: t.fromState,
            toState: t.toState,
            inputId: t.inputId,
          })),
        ],
      ),
    );
  }

  private hashInitVars(initVars: DataField[]): Hex {
    // Matches: keccak256(abi.encode(initVars_))
    return keccak256(
      encodeAbiParameters(
        [
          {
            type: 'tuple[]',
            name: 'initVars',
            components: [
              { name: 'id', type: 'bytes32' },
              { name: 'fType', type: 'uint8' },
              { name: 'data', type: 'bytes' },
            ],
          },
        ],
        [
          initVars.map((v) => ({
            id: v.id,
            fType: v.fType,
            data: v.data,
          })),
        ],
      ),
    );
  }

  private hashVerifiers(verifiers: VerifierInit[]): Hex {
    // Matches: keccak256(abi.encode(verifiers_))
    return keccak256(
      encodeAbiParameters(
        [
          {
            type: 'tuple[]',
            name: 'verifiers',
            components: [
              { name: 'key', type: 'bytes32' },
              { name: 'verifier', type: 'address' },
            ],
          },
        ],
        [
          verifiers.map((v) => ({
            key: v.key,
            verifier: v.verifier,
          })),
        ],
      ),
    );
  }

  private hashActions(actions: ActionInit[]): Hex {
    // Matches: keccak256(abi.encode(actions_))
    return keccak256(
      encodeAbiParameters(
        [
          {
            type: 'tuple[]',
            name: 'actions',
            components: [
              { name: 'fromState', type: 'bytes32' },
              { name: 'inputId', type: 'bytes32' },
              { name: 'target', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'data', type: 'bytes' },
            ],
          },
        ],
        [
          actions.map((a) => ({
            fromState: a.fromState,
            inputId: a.inputId,
            target: a.target,
            value: a.value,
            data: a.data,
          })),
        ],
      ),
    );
  }

  /**
   * Create a new agreement from an AgreementJson definition
   * 
   * @param agreement - The agreement JSON definition
   * @param options - Optional configuration
   * @param options.docUri - Custom document URI (defaults to ipfs://agreement/{id})
   * @param options.initValues - Initialization values for variables referenced in initialize.data
   * @returns The deployed agreement contract address and transaction response
   * 
   * @example
   * ```typescript
   * const factory = new AgreementFactory(
   *   { factoryAddress: "0x..." },
   *   { publicClient, walletClient }
   * );
   * 
   * const { address, receipt } = await factory.createAgreement(agreementJson, {
   *   initValues: {
   *     grantorEthAddress: "0x123...",
   *     recipientEthAddress: "0x456..."
   *   }
   * });
   * ```
   */
  async createAgreement(
    agreement: AgreementJson,
    options?: CreateAgreementOptions
  ): Promise<{
    address: Hex;
    request: WriteContractParameters;
    receipt: Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;
  }> {
    return await withSdkSpan(
      "agreement_factory.create",
      {
        "blockchain.chain_id": this.config.chainId ?? this.clients.publicClient?.chain?.id,
        "blockchain.contract.address": this.config.factoryAddress,
        "agreement.template_id": agreement.metadata?.templateId,
      },
      async () => {
        const params = transformAgreementToOnChainParams(
          agreement,
          options?.docUri,
          options?.initValues
        );
        const verifiers = options?.verifiers ?? params.verifiers;

        const { request } = await this.simulate('createAgreement', [
          params.docUri,
          params.docHash,
          params.initialState,
          params.inputDefs,
          params.transitions,
          params.initVars,
          verifiers,
          params.actions,
        ]);

        const receipt = await executeTransaction(
          request,
          this.clients.publicClient,
          this.clients.walletClient,
          true,
        );

        return {
          address: this.parseAgreementDeployedAddress(receipt),
          request,
          receipt,
        };
      },
    );
  }

  /**
   * Read the current permit nonce for a signer address.
   */
  async getNonce(signer: Hex): Promise<bigint> {
    return await readContractResult<typeof factoryAbi, 'nonces', bigint>(this.clients.publicClient, {
      address: this.config.factoryAddress,
      abi: factoryAbi,
      functionName: 'nonces',
      args: [signer],
    });
  }

  /**
   * Hash the agreement creation parameters the way the factory does before
   * it checks a permit.
   */
  private async permitFields(
    signerAddress: Hex,
    agreement: AgreementJson,
    deadline: number,
    options?: CreateAgreementOptions,
  ) {
    const params = transformAgreementToOnChainParams(
      agreement,
      options?.docUri,
      options?.initValues,
    );
    const verifiers = options?.verifiers ?? params.verifiers;

    const [nonce, chainId] = await Promise.all([
      this.getNonce(signerAddress),
      this.clients.publicClient.getChainId(),
    ]);

    return {
      domain: {
        name: "AgreementFactory",
        version: "1",
        chainId,
        verifyingContract: this.config.factoryAddress,
      } as const,
      agreementFields: {
        signer: signerAddress,
        docUri: params.docUri,
        docHash: params.docHash,
        initialState: params.initialState,
        inputDefsHash: this.hashInputDefs(params.inputDefs),
        transitionsHash: this.hashTransitions(params.transitions),
        initVarsHash: this.hashInitVars(params.initVars),
        verifiersHash: this.hashVerifiers(verifiers),
        actionsHash: this.hashActions(params.actions),
      },
      nonce,
      deadline: BigInt(deadline),
    };
  }

  /**
   * Create an EIP-712 permit signature for creating an agreement via the factory
   * with `createAgreementWithPermit`.
   *
   * The permit names its signer (the wallet client's account) and binds the full
   * agreement creation parameters (docUri/docHash/initialState and hashes of
   * inputDefs/transitions/initVars/verifiers/actions) plus the signer's current
   * nonce + deadline.
   *
   * A permit for `createAgreementDeterministicWithPermit` is a different typed
   * message; sign it with `createDeterministicPermitSignature`.
   *
   * @param walletClient - viem WalletClient to sign typed data (must be connected to an account)
   * @param agreement - The agreement JSON definition
   * @param deadline - Unix timestamp when the permit expires
   * @param options - Optional configuration (docUri + initValues)
   */
  async createPermitSignature(
    walletClient: WalletClient,
    agreement: AgreementJson,
    deadline: number,
    options?: CreateAgreementOptions,
  ): Promise<{
    signature: CreateAgreementPermitSignature;
    signerAddress: Hex;
  }> {
    const account = walletClient.account;
    if (!account) {
      throw new Error("WalletClient must be connected to an account to sign typed data");
    }

    const signerAddress = account.address as Hex;
    const fields = await this.permitFields(signerAddress, agreement, deadline, options);

    const signature = await walletClient.signTypedData({
      account,
      domain: fields.domain,
      types: { PermitAgreementWithActions: PERMIT_WITH_ACTIONS_FIELDS },
      primaryType: "PermitAgreementWithActions",
      message: {
        ...fields.agreementFields,
        nonce: fields.nonce,
        deadline: fields.deadline,
      },
    });

    return { signature, signerAddress };
  }

  /**
   * Create an EIP-712 permit signature for creating an agreement at a
   * deterministic address with `createAgreementDeterministicWithPermit`.
   *
   * In addition to everything `createPermitSignature` binds, the permit binds
   * the salt and the exact clone address the factory derives for this signer
   * and salt (`predictAddress(signerAddress, salt)`).
   *
   * @param walletClient - viem WalletClient to sign typed data (must be connected to an account)
   * @param agreement - The agreement JSON definition
   * @param salt - The signer's salt for deterministic address derivation
   * @param deadline - Unix timestamp when the permit expires
   * @param options - Optional configuration (docUri + initValues)
   */
  async createDeterministicPermitSignature(
    walletClient: WalletClient,
    agreement: AgreementJson,
    salt: Hex,
    deadline: number,
    options?: CreateAgreementOptions,
  ): Promise<{
    signature: CreateAgreementPermitSignature;
    signerAddress: Hex;
  }> {
    const account = walletClient.account;
    if (!account) {
      throw new Error("WalletClient must be connected to an account to sign typed data");
    }

    const signerAddress = account.address as Hex;
    const [fields, predictedAgreement] = await Promise.all([
      this.permitFields(signerAddress, agreement, deadline, options),
      this.predictAddress(signerAddress, salt),
    ]);

    const signature = await walletClient.signTypedData({
      account,
      domain: fields.domain,
      types: { PermitDeterministicAgreementWithActions: DETERMINISTIC_PERMIT_WITH_ACTIONS_FIELDS },
      primaryType: "PermitDeterministicAgreementWithActions",
      message: {
        ...fields.agreementFields,
        salt,
        predictedAgreement,
        nonce: fields.nonce,
        deadline: fields.deadline,
      },
    });

    return { signature, signerAddress };
  }

  /**
   * Create a new agreement using a permit signature, allowing a submitter to create
   * on behalf of the signer (the signer becomes the agreement owner).
   *
   * @param signer - The address the permit names (an EOA, or an ERC-1271 signer contract)
   * @param agreement - The agreement JSON definition
   * @param deadline - Unix timestamp when the permit expires (must be the signed value)
   * @param signature - The permit signature bytes, from `createPermitSignature`
   * @param options - Optional configuration (must match what was signed)
   */
  async createAgreementWithPermit(
    signer: Hex,
    agreement: AgreementJson,
    deadline: number,
    signature: CreateAgreementPermitSignature,
    options?: CreateAgreementOptions,
  ): Promise<{
    address: Hex;
    request: WriteContractParameters;
    receipt: Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;
  }> {
    return await withSdkSpan(
      "agreement_factory.create_with_permit",
      {
        "blockchain.chain_id": this.config.chainId ?? this.clients.publicClient?.chain?.id,
        "blockchain.contract.address": this.config.factoryAddress,
        "agreement.template_id": agreement.metadata?.templateId,
        "wallet.signer": signer,
      },
      async () => {
        const params = transformAgreementToOnChainParams(
          agreement,
          options?.docUri,
          options?.initValues,
        );
        const verifiers = options?.verifiers ?? params.verifiers;

        const { request } = await this.simulate('createAgreementWithPermit', [
          signer,
          params.docUri,
          params.docHash,
          params.initialState,
          params.inputDefs,
          params.transitions,
          params.initVars,
          verifiers,
          params.actions,
          BigInt(deadline),
          signature,
        ]);

        const receipt = await executeTransaction(
          request,
          this.clients.publicClient,
          this.clients.walletClient,
          true,
        );

        return {
          address: this.parseAgreementDeployedAddress(receipt),
          request,
          receipt,
        };
      },
    );
  }

  /**
   * Create a new agreement at a deterministic address
   * 
   * The address is derived from the caller and the salt, so it is the address
   * `predictAddress(callerAddress, salt)` returns and no other account can deploy to it.
   *
   * @param agreement - The agreement JSON definition
   * @param salt - Salt for deterministic address derivation, scoped to the caller
   * @param options - Optional configuration
   * @param options.docUri - Custom document URI (defaults to ipfs://agreement/{id})
   * @param options.initValues - Initialization values for variables referenced in initialize.data
   * @returns The deployed agreement contract address and transaction response
   * 
   * @example
   * ```typescript
   * const factory = new AgreementFactory(
   *   { factoryAddress: "0x..." },
   *   { publicClient, walletClient }
   * );
   * const salt = "0x1234...";
   * 
   * const { address, receipt } = await factory.createAgreementDeterministic(
   *   agreementJson,
   *   salt,
   *   { initValues: { ... } }
   * );
   * ```
   */
  async createAgreementDeterministic(
    agreement: AgreementJson,
    salt: Hex,
    options?: CreateAgreementOptions
  ): Promise<{
    address: Hex;
    request: WriteContractParameters;
    receipt: Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;
  }> {
    return await withSdkSpan(
      "agreement_factory.create_deterministic",
      {
        "blockchain.chain_id": this.config.chainId ?? this.clients.publicClient?.chain?.id,
        "blockchain.contract.address": this.config.factoryAddress,
        "agreement.template_id": agreement.metadata?.templateId,
      },
      async () => {
        const params = transformAgreementToOnChainParams(
          agreement,
          options?.docUri,
          options?.initValues
        );
        const verifiers = options?.verifiers ?? params.verifiers;

        const deterministicArgs: readonly unknown[] = [
          salt,
          params.docUri,
          params.docHash,
          params.initialState,
          params.inputDefs,
          params.transitions,
          params.initVars,
          verifiers,
          params.actions,
        ];

        const { request } = await this.simulate('createAgreementDeterministic', deterministicArgs);
        const receipt = await executeTransaction(
          request,
          this.clients.publicClient,
          this.clients.walletClient,
          true,
        );

        return {
          address: this.parseAgreementDeployedAddress(receipt),
          request,
          receipt,
        };
      },
    );
  }

  /**
   * Create a new deterministic agreement using a permit signature.
   *
   * The permit binds the signer, the agreement parameters, the salt and the clone
   * address the factory derives for that signer and salt, so the agreement is
   * deployed at `predictAddress(signer, salt)`.
   *
   * @param signer - The address the permit names (an EOA, or an ERC-1271 signer contract)
   * @param salt - The signer's salt (must be the signed value)
   * @param agreement - The agreement JSON definition
   * @param deadline - Unix timestamp when the permit expires (must be the signed value)
   * @param signature - The permit signature bytes, from `createDeterministicPermitSignature`
   * @param options - Optional configuration (must match what was signed)
   */
  async createAgreementDeterministicWithPermit(
    signer: Hex,
    salt: Hex,
    agreement: AgreementJson,
    deadline: number,
    signature: CreateAgreementPermitSignature,
    options?: CreateAgreementOptions,
  ): Promise<{
    address: Hex;
    request: WriteContractParameters;
    receipt: Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>>;
  }> {
    return await withSdkSpan(
      "agreement_factory.create_deterministic_with_permit",
      {
        "blockchain.chain_id": this.config.chainId ?? this.clients.publicClient?.chain?.id,
        "blockchain.contract.address": this.config.factoryAddress,
        "agreement.template_id": agreement.metadata?.templateId,
        "wallet.signer": signer,
      },
      async () => {
        const params = transformAgreementToOnChainParams(
          agreement,
          options?.docUri,
          options?.initValues,
        );
        const verifiers = options?.verifiers ?? params.verifiers;

        const { request } = await this.simulate('createAgreementDeterministicWithPermit', [
          signer,
          salt,
          params.docUri,
          params.docHash,
          params.initialState,
          params.inputDefs,
          params.transitions,
          params.initVars,
          verifiers,
          params.actions,
          BigInt(deadline),
          signature,
        ]);

        const receipt = await executeTransaction(
          request,
          this.clients.publicClient,
          this.clients.walletClient,
          true,
        );

        return {
          address: this.parseAgreementDeployedAddress(receipt),
          request,
          receipt,
        };
      },
    );
  }

  /**
   * Predict the address of a deterministic agreement before deployment
   *
   * Deterministic addresses are scoped to their creator: the same salt gives
   * a different address for a different creator.
   * 
   * @param creator The account the address is reserved for: the caller of
   *        `createAgreementDeterministic`, or the signer of a deterministic permit
   * @param salt The creator's salt that will be used for deployment
   * @returns The predicted agreement address
   * 
   * @example
   * ```typescript
   * const factory = new AgreementFactory(
   *   { factoryAddress: "0x..." },
   *   { publicClient, walletClient }
   * );
   * const predictedAddress = await factory.predictAddress(creatorAddress, "0x1234...");
   * ```
   */
  async predictAddress(creator: Hex, salt: Hex): Promise<Hex> {
    return await readContractResult<typeof factoryAbi, 'predictAddress', Hex>(this.clients.publicClient, {
      address: this.config.factoryAddress,
      abi: factoryAbi,
      functionName: 'predictAddress',
      args: [creator, salt],
    });
  }

  /**
   * Get the factory contract address
   */
  getAddress(): Hex {
    return this.config.factoryAddress;
  }

  /**
   * Get the implementation address that clones point to
   */
  async getImplementationAddress(): Promise<Hex> {
    return await readContractResult<typeof factoryAbi, 'implementation', Hex>(this.clients.publicClient, {
      address: this.config.factoryAddress,
      abi: factoryAbi,
      functionName: 'implementation',
      args: [],
    });
  }

}
