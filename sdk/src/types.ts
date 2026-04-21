/**
 * Type definitions for the Agreements Protocol SDK
 */

import { Hex } from "viem";

// ============================================================================
// On-Chain Types (matching AgreementEngine.sol)
// ============================================================================

/**
 * FieldType enum matching the contract
 */
export enum FieldType {
  UINT256 = 0,
  STRING = 1,
  ADDRESS = 2,
  BOOL = 3,
  BYTES32 = 4,
}

/**
 * Op enum for conditions matching the contract
 */
export enum Op {
  // String operations
  STRING_MIN_LENGTH = 0,
  STRING_MAX_LENGTH = 1,
  STRING_EQ_CONST = 2,
  STRING_EQ_VAR = 3,

  // UINT256 operations - compare with constant
  UINT_EQ_CONST = 4,
  UINT_GT_CONST = 5,
  UINT_GTE_CONST = 6,
  UINT_LT_CONST = 7,
  UINT_LTE_CONST = 8,

  // UINT256 operations - compare with stored variable
  UINT_EQ_VAR = 9,
  UINT_GT_VAR = 10,
  UINT_GTE_VAR = 11,
  UINT_LT_VAR = 12,
  UINT_LTE_VAR = 13,

  // Address operations
  ADDRESS_EQ_CONST = 14,
  ADDRESS_EQ_VAR = 15,

  // Sender operations
  SENDER_EQ_VAR_ADDRESS = 16,
  SENDER_IN_ALLOWED_ADDRESSES = 17,
}

/**
 * InputFieldDef struct matching the contract
 */
export interface InputFieldDef {
  fieldId: Hex;
  fType: FieldType;
  required: boolean;
  persist: boolean;
}

/**
 * Condition struct matching the contract
 */
export interface Condition {
  op: Op;
  fieldId: Hex;
  bytesArg: Hex;
}

/**
 * InputDef struct matching the contract
 */
export interface InputDef {
  id: Hex;
  fields: InputFieldDef[];
  conditions: Condition[];
  verifierKeys: Hex[];
}

/**
 * Transition struct matching the contract
 */
export interface Transition {
  fromState: Hex;
  toState: Hex;
  inputId: Hex;
}

/**
 * DataField struct matching the contract
 * Used for both submitInput payloads and initialization variables
 */
export interface DataField {
  id: Hex;
  fType: FieldType;
  data: Hex;
}

/**
 * Action init payload matching AgreementEngine.ActionInit (used at agreement initialization).
 */
export interface ActionInit {
  fromState: Hex;
  inputId: Hex;
  target: Hex;     // address
  value: bigint;   // msg.value forwarded to target
  data: Hex;       // calldata
}

/**
 * Parameters for createAgreement contract call
 */
export interface CreateAgreementParams {
  docUri: string;
  docHash: Hex;
  initialState: Hex;
  inputDefs: InputDef[];
  transitions: Transition[];
  initVars: DataField[];
  actions: ActionInit[];
}

/**
 * On-chain agreement data returned from the contract
 * Note: Each agreement is a separate clone contract, so the address IS the identifier
 */
export interface OnChainAgreement {
  address: Hex;       // Clone contract address (the agreement identifier)
  docUri: string;
  docHash: Hex;
  initialState: Hex;
  currentState: Hex;
  owner: Hex;
}

// ============================================================================
// Agreement JSON Types (off-chain format)
// ============================================================================

/**
 * Agreement metadata
 */
export interface AgreementMetadata {
  id: string;
  templateId: string;
  version: string;
  createdAt?: string;
  name: string;
  author?: string;
  description?: string;
}

/**
 * Variable type in agreement JSON
 */
export type AgreementVariableType =
  | "string"
  | "address"
  | "signature"
  | "dateTime"
  | "txHash"
  | "uint256"
  | "bool"
  | "bytes32";

/**
 * Variable validation rules (MDAST validation format)
 * Note: Some validations (pattern, step) are not supported on-chain
 * and should be validated off-chain before submission.
 */
export interface VariableValidation {
  required?: boolean;
  minLength?: number;  // Supported on-chain for strings (uses STRING_MIN_LENGTH)
  maxLength?: number;  // Supported on-chain for strings (uses STRING_MAX_LENGTH)
  min?: number;        // Supported on-chain for uint256 (uses UINT_GTE_CONST)
  max?: number;        // Supported on-chain for uint256 (uses UINT_LTE_CONST)
  step?: number;       // Not supported on-chain
  pattern?: string;    // Not supported on-chain (regex validation)
}

/**
 * Transaction metadata for txHash variables
 */
export interface TxMetadata {
  transactionType: string;
  method: string;
  params: Record<string, unknown>;
  contractReference?: string;
  signer?: string;
}

/**
 * Variable definition in agreement JSON
 */
export interface AgreementVariable {
  type: AgreementVariableType;
  name: string;
  description?: string;
  validation?: VariableValidation;
  txMetadata?: TxMetadata;
}

/**
 * Inline input field definition in agreement JSON.
 */
export interface ExecutionInputFieldDefinition {
  type: AgreementVariableType;
  description?: string;
  validation?: VariableValidation;
}

/**
 * Contract reference in agreement JSON
 */
export interface ContractReference {
  description?: string;
  address: string;
  chainId: string;
  abi?: string;
}

/**
 * Agreement content (the document itself)
 */
export interface AgreementContent {
  type: "md" | "html" | "text";
  data: string;
}

/**
 * State definition in execution
 */
export interface StateDefinition {
  name: string;
  description?: string;
}

/**
 * Initialize configuration
 */
export interface InitializeConfig {
  name?: string;
  description?: string;
  initialState: string;
  data?: Record<string, string>;
}

/**
 * Input definition in execution
 */
export interface ExecutionInput {
  type: string;
  schema?: string;
  displayName?: string;
  description?: string;
  data?: Record<string, string | ExecutionInputFieldDefinition>;
  issuer?: string | string[];
}

/**
 * Transition condition
 */
export interface TransitionCondition {
  type: string;
  input: string;
}

/**
 * Transition definition
 */
export interface ExecutionTransition {
  from: string;
  to: string;
  conditions?: TransitionCondition[];
}

// ============================================================================
// Optional Actions (off-chain format; compiled to ActionInit at deployment)
// ============================================================================

export interface ExecutionActionWhen {
  from: string;   // state name
  input: string;  // input name
}

export interface ExecutionActionCallEvmCall {
  type: "evmCall";
  target: string;        // template ref or literal address
  value?: string;        // stringified uint256 (defaults to "0")
  abi: unknown[];        // JSON ABI array (subset is fine)
  method: string;        // function name
  args: string[];        // template refs or literals, coerced by ABI input types
}

export interface ExecutionAction {
  id: string;
  when: ExecutionActionWhen;
  call: ExecutionActionCallEvmCall;
  revertOnFailure?: boolean; // defaults to true (engine is atomic)
}

/**
 * Execution configuration (state machine)
 */
export interface AgreementExecution {
  states: Record<string, StateDefinition>;
  initialize: InitializeConfig;
  inputs: Record<string, ExecutionInput>;
  transitions: ExecutionTransition[];
  actions?: ExecutionAction[];
}

/**
 * Complete agreement JSON structure
 */
export interface AgreementJson {
  metadata: AgreementMetadata;
  variables: Record<string, AgreementVariable>;
  contracts?: Record<string, ContractReference>;
  content: AgreementContent;
  execution: AgreementExecution;
}

/**
 * Normalized input field metadata for UI/schema consumers.
 */
export interface InputFieldMetadata {
  name: string;
  fieldId: Hex;
  fType: FieldType;
  required: boolean;
  persist: boolean;
}

// ============================================================================
// SDK Protocol Types
// ============================================================================

/**
 * Protocol configuration
 */
export interface ProtocolConfig {
  factoryAddress?: Hex;        // AgreementFactory contract address
  implementationAddress?: Hex; // AgreementEngine implementation (for reference)
  chainId?: number;
  rpcUrl?: string;
}

/**
 * Factory configuration
 */
export interface FactoryConfig {
  factoryAddress: Hex;        // Required: AgreementFactory contract address
  chainId?: number;           // Optional: Chain ID for validation (will be inferred from provider if not provided)
}

/**
 * Agreement (for SDK use)
 */
export interface Agreement {
  id: string;
  json?: AgreementJson;
  onChain?: OnChainAgreement;
}
