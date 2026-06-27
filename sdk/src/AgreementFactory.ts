import {
  type Abi,
  type Hex,
  type PublicClient,
  type WalletClient,
  type WriteContractParameters,
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  stringToHex,
} from 'viem';
import { executeTransaction, readContractResult } from "./transactions.js";
import { withSdkSpan } from "./telemetry.js";
import {
  AgreementJson,
  FactoryConfig,
  ComposableCreateParams,
} from "./types.js";
import { transformAgreementToOnChainParams, InitValue } from "./transformer.js";
import { desugarToComposable } from "./desugar.js";
import { AgreementFactoryABI } from "./generated/AgreementFactoryAbi.js";

// Use inlined ABI data (works in both Node.js and browser)
// ABI is extracted directly from contract artifacts as an array
const factoryAbi: Abi = AgreementFactoryABI as Abi;

// Must match AgreementFactory.sol exactly (PERMIT_AGREEMENT_TYPEHASH — the composable shape,
// binding the composable actions, canonical conditions, and the verifier registrations).
const PERMIT_AGREEMENT_TYPE = "PermitAgreement(string docUri,bytes32 docHash,bytes32 initialState,bytes32 inputDefsHash,bytes32 transitionsHash,bytes32 initVarsHash,bytes32 actionsHash,bytes32 canonicalCondsHash,bytes32 verifiersHash,uint256 nonce,uint256 deadline)";
const PERMIT_AGREEMENT_TYPEHASH: Hex = keccak256(stringToHex(PERMIT_AGREEMENT_TYPE));

/** Desugar an AgreementJson into the composable on-chain params (transform then desugar). */
function buildComposableParams(
  agreement: AgreementJson,
  options?: CreateAgreementOptions
): ComposableCreateParams {
  return desugarToComposable(
    transformAgreementToOnChainParams(agreement, options?.docUri, options?.initValues)
  );
}

export type CreateAgreementOptions = {
  docUri?: string;
  initValues?: Record<string, InitValue>;
};

export type CreateAgreementPermitSignature = {
  v: number;
  r: Hex;
  s: Hex;
};

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
   *   signer
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

  // ---- Permit array hashes (must match AgreementFactory.sol _verifyPermit) ----
  // The contract binds each array as keccak256(abi.encode(array)) with the COMPOSABLE
  // tuple shapes. These helpers reproduce that encoding for the EIP-712 message hashes.

  private hashInputDefs(inputDefs: ComposableCreateParams["inputDefs"]): Hex {
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
              { name: 'verifierKeys', type: 'bytes32[]' },
            ],
          },
        ],
        [inputDefs],
      ),
    );
  }

  private hashTransitions(transitions: ComposableCreateParams["transitions"]): Hex {
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
        [transitions],
      ),
    );
  }

  private hashInitVars(initVars: ComposableCreateParams["initVars"]): Hex {
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
        [initVars],
      ),
    );
  }

  private hashActions(actions: ComposableCreateParams["actions"]): Hex {
    return keccak256(
      encodeAbiParameters(
        [
          {
            type: 'tuple[]',
            name: 'actions',
            components: [
              { name: 'fromState', type: 'bytes32' },
              { name: 'inputId', type: 'bytes32' },
              { name: 'encodedCalls', type: 'bytes' },
            ],
          },
        ],
        [actions],
      ),
    );
  }

  private hashCanonicalConds(conds: ComposableCreateParams["canonicalConds"]): Hex {
    return keccak256(
      encodeAbiParameters(
        [
          {
            type: 'tuple[]',
            name: 'conds',
            components: [
              { name: 'inputId', type: 'bytes32' },
              { name: 'encodedConditions', type: 'bytes' },
            ],
          },
        ],
        [conds],
      ),
    );
  }

  private hashVerifiers(verifiers: ComposableCreateParams["verifiers"]): Hex {
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
        [verifiers],
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
   * const factory = new AgreementFactory("0x...", signer);
   * 
   * const { address, tx } = await factory.createAgreement(agreementJson, {
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
        const params = buildComposableParams(agreement, options);

        const { request } = await this.simulate('createAgreement', [
          params.docUri,
          params.docHash,
          params.initialState,
          params.inputDefs,
          params.transitions,
          params.initVars,
          params.actions,
          params.canonicalConds,
          params.verifiers,
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
   * Create an EIP-712 permit signature for creating an agreement via the factory.
   *
   * The permit binds the full COMPOSABLE agreement creation parameters (docUri/docHash/
   * initialState and hashes of inputDefs/transitions/initVars/actions/canonicalConds/
   * verifiers) plus the signer's current nonce + deadline. The verifiersHash adopts the
   * verifier binding so a relayer cannot swap verifiers, actions, or conditions.
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
    const nonce = await this.getNonce(signerAddress);

    const params = buildComposableParams(agreement, options);

    const inputDefsHash = this.hashInputDefs(params.inputDefs);
    const transitionsHash = this.hashTransitions(params.transitions);
    const initVarsHash = this.hashInitVars(params.initVars);
    const actionsHash = this.hashActions(params.actions);
    const canonicalCondsHash = this.hashCanonicalConds(params.canonicalConds);
    const verifiersHash = this.hashVerifiers(params.verifiers);

    const chainId = await this.clients.publicClient.getChainId();
    const domain = {
      name: "AgreementFactory",
      version: "1",
      chainId,
      verifyingContract: this.config.factoryAddress,
    } as const;

    const types = {
      PermitAgreement: [
        { name: "docUri", type: "string" },
        { name: "docHash", type: "bytes32" },
        { name: "initialState", type: "bytes32" },
        { name: "inputDefsHash", type: "bytes32" },
        { name: "transitionsHash", type: "bytes32" },
        { name: "initVarsHash", type: "bytes32" },
        { name: "actionsHash", type: "bytes32" },
        { name: "canonicalCondsHash", type: "bytes32" },
        { name: "verifiersHash", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    } as const;

    const message = {
      docUri: params.docUri,
      docHash: params.docHash,
      initialState: params.initialState,
      inputDefsHash,
      transitionsHash,
      initVarsHash,
      actionsHash,
      canonicalCondsHash,
      verifiersHash,
      nonce,
      deadline: BigInt(deadline),
    } as const;

    // Optional sanity check: ensure our local typehash matches the contract's constant.
    // (If this ever fails, the permit string in PERMIT_AGREEMENT_TYPE is wrong.)
    if (!PERMIT_AGREEMENT_TYPEHASH) {
      throw new Error("PERMIT_AGREEMENT_TYPEHASH not initialized");
    }

    const signatureHex = await walletClient.signTypedData({
      account,
      domain,
      types,
      primaryType: "PermitAgreement",
      message,
    });

    const r = `0x${signatureHex.slice(2, 66)}` as Hex;
    const s = `0x${signatureHex.slice(66, 130)}` as Hex;
    const v = parseInt(signatureHex.slice(130, 132), 16);

    return { signature: { v, r, s }, signerAddress };
  }

  /**
   * Create a new agreement using a permit signature, allowing a submitter to create
   * on behalf of the signer (the signer becomes the agreement owner).
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
        const params = buildComposableParams(agreement, options);

        const { request } = await this.simulate('createAgreementWithPermit', [
          signer,
          params.docUri,
          params.docHash,
          params.initialState,
          params.inputDefs,
          params.transitions,
          params.initVars,
          params.actions,
          params.canonicalConds,
          params.verifiers,
          BigInt(deadline),
          signature.v,
          signature.r,
          signature.s,
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
   * @param agreement - The agreement JSON definition
   * @param salt - Salt for deterministic address derivation
   * @param options - Optional configuration
   * @param options.docUri - Custom document URI (defaults to ipfs://agreement/{id})
   * @param options.initValues - Initialization values for variables referenced in initialize.data
   * @returns The deployed agreement contract address and transaction response
   * 
   * @example
   * ```typescript
   * const factory = new AgreementFactory("0x...", signer);
   * const salt = "0x1234...";
   * 
   * const { address, tx } = await factory.createAgreementDeterministic(
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
        const params = buildComposableParams(agreement, options);

        const deterministicArgs: readonly unknown[] = [
          salt,
          params.docUri,
          params.docHash,
          params.initialState,
          params.inputDefs,
          params.transitions,
          params.initVars,
          params.actions,
          params.canonicalConds,
          params.verifiers,
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
   * Note: The on-chain permit does NOT bind the salt; the signature authorizes the agreement params.
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
        const params = buildComposableParams(agreement, options);

        const { request } = await this.simulate('createAgreementDeterministicWithPermit', [
          signer,
          salt,
          params.docUri,
          params.docHash,
          params.initialState,
          params.inputDefs,
          params.transitions,
          params.initVars,
          params.actions,
          params.canonicalConds,
          params.verifiers,
          BigInt(deadline),
          signature.v,
          signature.r,
          signature.s,
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
   * @param salt The salt that will be used for deployment
   * @returns The predicted agreement address
   * 
   * @example
   * ```typescript
   * const factory = new AgreementFactory("0x...", provider);
   * const predictedAddress = await factory.predictAddress("0x1234...");
   * ```
   */
  async predictAddress(salt: Hex): Promise<Hex> {
    return await readContractResult<typeof factoryAbi, 'predictAddress', Hex>(this.clients.publicClient, {
      address: this.config.factoryAddress,
      abi: factoryAbi,
      functionName: 'predictAddress',
      args: [salt],
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
