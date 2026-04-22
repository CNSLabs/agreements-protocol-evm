// SPDX-License-Identifier: Apache-2.0

/**
 * Agreement JSON to On-Chain Parameters Transformer
 *
 * Transforms agreement JSON definitions into the format required by
 * the AgreementEngine.createAgreement() contract function.
 */

import { keccak256, stringToHex, encodeAbiParameters, encodeFunctionData, Hex, Address, isAddress } from "viem";
import {
  AgreementJson,
  AgreementVariableType,
  CreateAgreementParams,
  InputDef,
  InputFieldDef,
  Condition,
  Transition,
  DataField,
  FieldType,
  Op,
  AgreementVariable,
  ExecutionInputFieldDefinition,
  InputFieldMetadata,
  type ExecutionAction,
  type ActionInit,
} from "./types.js";
import { encodeFieldValue } from "./payload-builder.js";

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

/**
 * Supported value types for initialization variables
 */
export type InitValue = string | bigint | boolean | Address;

/**
 * Information about an initialization variable
 */
export interface InitVarInfo {
  name: string;
  type: AgreementVariableType;
}

/**
 * Transform an agreement JSON into on-chain createAgreement parameters
 *
 * @param agreement - The agreement JSON definition
 * @param docUri - Optional custom document URI (defaults to ipfs://agreement/{id})
 * @param initValues - Required if agreement has initialize.data with variables.
 *                     Maps variable names to their actual values (supports all types:
 *                     string, address, uint256/bigint, bool, bytes32).
 */
export function transformAgreementToOnChainParams(
  agreement: AgreementJson,
  docUri?: string,
  initValues?: Record<string, InitValue>
): CreateAgreementParams {
  const execution = agreement.execution;

  // 1. Generate docUri and docHash
  const uri = docUri ?? `ipfs://agreement/${agreement.metadata.id}`;
  const docHash = keccak256(stringToHex(JSON.stringify(agreement)));

  // 2. Get initial state
  const initialState = keccak256(stringToHex(execution.initialize.initialState));

  // 3. Determine required initialization variables from initialize.data
  const requiredInitVars = getRequiredInitVars(
    execution.initialize.data || {},
    agreement.variables
  );

  // 4. Validate that all required init values are provided
  if (requiredInitVars.length > 0) {
    if (!initValues) {
      const varNames = requiredInitVars.map((v) => v.name);
      throw new Error(
        `Agreement requires initialization values for: ${varNames.join(", ")}. ` +
        `Pass initValues parameter with these values.`
      );
    }
    for (const varInfo of requiredInitVars) {
      if (initValues[varInfo.name] === undefined) {
        throw new Error(
          `Missing initialization value for '${varInfo.name}' (type: ${varInfo.type}). ` +
          `Pass it in initValues: { ${varInfo.name}: <value> }`
        );
      }
    }
  }

  // 5. Build initVars array for contract
  const initVars = buildInitVars(requiredInitVars, initValues || {});

  // 6. Transform inputs to InputDefs (all inputs treated uniformly now)
  const inputDefs = transformInputs(execution.inputs, agreement.variables);

  // 7. Transform transitions
  const transitions = transformTransitions(execution.transitions);

  // 8. Transform actions (optional)
  const actions = transformActions(
    execution.actions || [],
    agreement,
    initValues || {}
  );

  return {
    docUri: uri,
    docHash,
    initialState,
    inputDefs,
    transitions,
    initVars,
    verifiers: [],
    actions,
  };
}

/**
 * Get the list of variables that need to be initialized
 * (all variables referenced in initialize.data)
 */
export function getRequiredInitVars(
  initData: Record<string, string>,
  variables: AgreementJson["variables"]
): InitVarInfo[] {
  const requiredVars: InitVarInfo[] = [];

  for (const [_key, ref] of Object.entries(initData)) {
    const varName = extractVariableName(ref);
    if (varName && variables[varName]) {
      requiredVars.push({
        name: varName,
        type: variables[varName].type,
      });
    }
  }

  return requiredVars;
}

/**
 * Build the initVars DataField array from variable info and values
 * Supports all field types: ADDRESS, STRING, UINT256, BOOL, BYTES32
 */
export function buildInitVars(
  varInfos: InitVarInfo[],
  values: Record<string, InitValue>
): DataField[] {
  return varInfos.map((varInfo) => {
    const fieldType = mapVariableTypeToFieldType(varInfo.type);
    return {
      id: fieldToBytes32(varInfo.name),
      fType: fieldType,
      data: encodeFieldValue(fieldType, values[varInfo.name]),
    };
  });
}

/**
 * Transform the execution.inputs object into InputDef[] array
 * All inputs are processed uniformly - conditions based on issuer field
 */
export function transformInputs(
  inputs: AgreementJson["execution"]["inputs"],
  variables: AgreementJson["variables"]
): InputDef[] {
  return Object.entries(inputs).map(([inputKey, inputDef]) => {
    const id = keccak256(stringToHex(inputKey)) as Hex;

    // Build fields from the input's data object
    const fields: InputFieldDef[] = [];
    const conditions: Condition[] = [];
    
    for (const [fieldKey, fieldRef] of Object.entries(inputDef.data || {})) {
      const fieldMeta = resolveInputFieldMetadata(fieldKey, fieldRef, variables);
      const varName = extractVariableName(fieldRef);
      const varDef = varName ? variables[varName] : null;

      // Get validation from variable definition or inline definition
      const validation = varDef?.validation ?? getInlineValidation(fieldRef);

      fields.push({
        fieldId: fieldMeta.fieldId,
        fType: fieldMeta.fType,
        required: fieldMeta.required,
        persist: fieldMeta.persist,
      });

      // Generate conditions from validation rules
      if (validation) {
        // Create a temporary variable definition for inline validations
        const effectiveVarDef: AgreementVariable = varDef || {
          type: getInlineVariableType(fieldRef) as AgreementVariableType,
          name: varName || fieldKey,
          validation,
        };
        const validationConditions = generateConditionsFromValidation(
          fieldMeta.fieldId,
          fieldMeta.fType,
          effectiveVarDef
        );
        conditions.push(...validationConditions);
      }
    }

    conditions.push(...buildIssuerConditions(inputDef.issuer, variables));

    return {
      id,
      fields,
      conditions,
      verifierKeys: [], // Would be populated if external verification is needed
    };
  });
}

/**
 * Transform execution.transitions[] into Transition[] array
 */
export function transformTransitions(
  transitions: AgreementJson["execution"]["transitions"]
): Transition[] {
  return transitions.map((t) => {
    // The condition references an input via conditions[].input
    const inputName = t.conditions?.[0]?.input;

    if (!inputName) {
      throw new Error(
        `Transition from ${t.from} to ${t.to} has no input condition`
      );
    }

    return {
      fromState: keccak256(stringToHex(t.from)) as Hex,
      toState: keccak256(stringToHex(t.to)) as Hex,
      inputId: keccak256(stringToHex(inputName)) as Hex,
    };
  });
}

/**
 * Extract variable name from a template reference string
 * E.g., "${variables.grantorName}" -> "grantorName"
 * E.g., "${variables.grantorEthAddress.value}" -> "grantorEthAddress"
 */
export function extractVariableName(ref: unknown): string {
  if (typeof ref !== "string") return "";
  const match = ref.match(/\$\{variables\.(\w+)/);
  return match?.[1] || "";
}

/**
 * Get the type from an inline variable definition
 */
export function getInlineVariableType(fieldRef: unknown): string {
  if (typeof fieldRef === "object" && fieldRef !== null && "type" in fieldRef) {
    return (fieldRef as ExecutionInputFieldDefinition).type;
  }
  return "string";
}

/**
 * Get validation rules from an inline variable definition
 */
export function getInlineValidation(fieldRef: unknown): AgreementJson["variables"][string]["validation"] | undefined {
  if (typeof fieldRef === "object" && fieldRef !== null && "validation" in fieldRef) {
    return (fieldRef as ExecutionInputFieldDefinition).validation;
  }
  return undefined;
}

/**
 * Get the field types for a specific input from the agreement definition.
 * Used for building payloads from plain objects.
 * 
 * @param agreement - The agreement JSON definition
 * @param inputId - The input identifier (e.g., "grantorData")
 * @returns Map of field names to their FieldType
 */
export function getInputFieldTypes(
  agreement: AgreementJson,
  inputId: string
): Record<string, FieldType> {
  const types: Record<string, FieldType> = {};
  for (const field of getInputFieldMetadata(agreement, inputId)) {
    types[field.name] = field.fType;
  }
  return types;
}

/**
 * Get normalized field metadata for a specific input.
 * Useful for upstream UIs that need field type and optionality.
 */
export function getInputFieldMetadata(
  agreement: AgreementJson,
  inputId: string
): InputFieldMetadata[] {
  const input = agreement.execution.inputs[inputId];
  if (!input) {
    throw new Error(`Input '${inputId}' not found in agreement`);
  }

  return Object.entries(input.data || {}).map(([fieldKey, fieldRef]) =>
    resolveInputFieldMetadata(fieldKey, fieldRef, agreement.variables)
  );
}

/**
 * Map agreement variable types to on-chain FieldType enum values
 */
export function mapVariableTypeToFieldType(varType: string): FieldType {
  const typeMap: Record<string, FieldType> = {
    uint256: FieldType.UINT256,
    string: FieldType.STRING,
    address: FieldType.ADDRESS,
    bool: FieldType.BOOL,
    bytes32: FieldType.BYTES32,
    // Agreement-specific types
    signature: FieldType.STRING, // Signatures are stored as strings (the proof)
    dateTime: FieldType.STRING, // DateTimes are stored as ISO strings
    txHash: FieldType.BYTES32, // Transaction hashes are bytes32
  };
  return typeMap[varType] ?? FieldType.STRING;
}

/**
 * Determine if a field should be persisted to storage
 */
function shouldPersist(
  varDef: AgreementJson["variables"][string] | null
): boolean {
  // Persist address variables that might be used in conditions
  if (varDef?.type === "address") {
    return true;
  }
  return false;
}

function resolveInputFieldMetadata(
  fieldKey: string,
  fieldRef: unknown,
  variables: AgreementJson["variables"]
): InputFieldMetadata {
  const varName = extractVariableName(fieldRef);
  const varDef = varName ? variables[varName] : null;
  const varType = varDef?.type ?? getInlineVariableType(fieldRef);
  const validation = varDef?.validation ?? getInlineValidation(fieldRef);

  return {
    name: varName || fieldKey,
    fieldId: keccak256(stringToHex(varName || fieldKey)) as Hex,
    fType: mapVariableTypeToFieldType(varType),
    required: validation?.required ?? true,
    persist: shouldPersist(varDef),
  };
}

function buildIssuerConditions(
  issuer: AgreementJson["execution"]["inputs"][string]["issuer"],
  variables: AgreementJson["variables"]
): Condition[] {
  if (!issuer) {
    return [];
  }

  const issuerEntries = Array.isArray(issuer) ? issuer : [issuer];
  if (issuerEntries.length === 0) {
    throw new Error("Input issuer list cannot be empty");
  }

  const allowedVarFieldIds: Hex[] = [];
  const allowedAddresses: Address[] = [];

  for (const issuerEntry of issuerEntries) {
    const issuerVar = extractVariableName(issuerEntry);
    if (issuerVar) {
      const issuerVarDef = variables[issuerVar];
      if (!issuerVarDef) {
        throw new Error(`Issuer references unknown variable '${issuerVar}'`);
      }
      if (issuerVarDef.type !== "address") {
        throw new Error(
          `Issuer variable '${issuerVar}' must be type 'address', received '${issuerVarDef.type}'`
        );
      }
      allowedVarFieldIds.push(fieldToBytes32(issuerVar));
      continue;
    }

    if (isAddress(issuerEntry)) {
      allowedAddresses.push(issuerEntry);
      continue;
    }

    throw new Error(
      `Issuer entry '${issuerEntry}' must be an address variable reference or literal address`
    );
  }

  if (allowedVarFieldIds.length === 1 && allowedAddresses.length === 0 && issuerEntries.length === 1) {
    return [
      {
        op: Op.SENDER_EQ_VAR_ADDRESS,
        fieldId: allowedVarFieldIds[0],
        bytesArg: "0x" as Hex,
      },
    ];
  }

  return [
    {
      op: Op.SENDER_IN_ALLOWED_ADDRESSES,
      fieldId: ZERO_BYTES32,
      bytesArg: encodeAbiParameters(
        [{ type: "bytes32[]" }, { type: "address[]" }],
        [allowedVarFieldIds, allowedAddresses]
      ) as Hex,
    },
  ];
}

/**
 * Convert a state name to its bytes32 representation
 */
export function stateToBytes32(stateName: string): Hex {
  return keccak256(stringToHex(stateName)) as Hex;
}

/**
 * Convert an input name to its bytes32 representation
 */
export function inputToBytes32(inputName: string): Hex {
  return keccak256(stringToHex(inputName)) as Hex;
}

/**
 * Convert a field name to its bytes32 representation
 */
export function fieldToBytes32(fieldName: string): Hex {
  return keccak256(stringToHex(fieldName)) as Hex;
}

// ============================================================================
// Actions (off-chain format -> on-chain ActionInit)
// ============================================================================

function resolveTemplateValue(
  agreement: AgreementJson,
  initValues: Record<string, InitValue>,
  ref: string
): InitValue | string {
  // ${variables.foo} / ${variables.foo.value}
  const varName = extractVariableName(ref);
  if (varName) {
    const v = initValues[varName];
    if (v === undefined) {
      throw new Error(
        `Missing initValues for action placeholder '${ref}'. ` +
        `Provide initValues.{${varName}} when creating the agreement.`
      );
    }
    return v;
  }

  // ${contracts.someContract.address}
  const contractMatch = ref.match(/\$\{contracts\.(\w+)\.address\}/);
  if (contractMatch) {
    const key = contractMatch[1];
    const addr = agreement.contracts?.[key]?.address;
    if (!addr) {
      throw new Error(`Unknown contract reference '${ref}'. Add it under agreement.contracts.${key}.address`);
    }
    return addr;
  }

  return ref;
}

function coerceArg(paramType: string, value: InitValue | string): unknown {
  if (paramType === "address") return value as string;
  if (paramType === "string") return value as string;
  if (paramType === "bool") {
    if (typeof value === "boolean") return value;
    return value === "true";
  }
  if (paramType === "bytes32") return value as string;

  // uint*/int*
  if (paramType.startsWith("uint") || paramType.startsWith("int")) {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    return BigInt(value as string);
  }

  // Fallback: return as-is (viem will throw if incompatible)
  return value;
}

export function transformActions(
  actions: ExecutionAction[],
  agreement: AgreementJson,
  initValues: Record<string, InitValue>
): ActionInit[] {
  return actions.map((a) => {
    if (a.call.type !== "evmCall") {
      throw new Error(`Unsupported action call type: ${(a.call as any).type}`);
    }

    const abi = a.call.abi as any[];
    const fn = abi.find((x) => x && x.type === "function" && x.name === a.call.method);
    if (!fn) {
      throw new Error(`Action '${a.id}' ABI does not contain function '${a.call.method}'`);
    }

    const inputs: Array<{ name?: string; type: string }> = (fn.inputs || []) as any;
    if (inputs.length !== a.call.args.length) {
      throw new Error(
        `Action '${a.id}' arg length mismatch for '${a.call.method}': ` +
        `expected ${inputs.length}, got ${a.call.args.length}`
      );
    }

    const resolvedArgs = a.call.args.map((arg, i) => {
      const resolved = resolveTemplateValue(agreement, initValues, arg);
      return coerceArg(inputs[i].type, resolved);
    });

    const targetResolved = resolveTemplateValue(agreement, initValues, a.call.target);
    const target = (targetResolved as string) as Hex;
    const value = BigInt(a.call.value ?? "0");

    const data = encodeFunctionData({
      abi: abi as any,
      functionName: a.call.method as any,
      args: resolvedArgs as any,
    }) as Hex;

    return {
      fromState: stateToBytes32(a.when.from),
      inputId: inputToBytes32(a.when.input),
      target,
      value,
      data,
    };
  });
}

/**
 * Generate on-chain conditions from variable validation rules.
 * 
 * Supported validations:
 * - uint256: min (UINT_GTE_CONST), max (UINT_LTE_CONST)
 * - string: minLength (STRING_MIN_LENGTH), maxLength (STRING_MAX_LENGTH)
 * - All types: required (handled by InputFieldDef.required flag, no condition needed)
 * 
 * Unsupported validations (should be validated off-chain):
 * - string: pattern
 * - uint256: step
 * 
 * @param fieldId - The field ID this condition targets
 * @param fieldType - The field type
 * @param varDef - The variable definition with validation rules
 * @returns Array of conditions to add to the input definition
 */
export function generateConditionsFromValidation(
  fieldId: Hex,
  fieldType: FieldType,
  varDef: AgreementVariable
): Condition[] {
  const conditions: Condition[] = [];
  const validation = varDef.validation;
  if (!validation) return conditions;

  // UINT256 validations
  if (fieldType === FieldType.UINT256) {
    if (validation.min !== undefined) {
      // Encode min value as uint256 in bytesArg
      const minBytes = encodeAbiParameters([{ type: "uint256" }], [BigInt(validation.min)]);
      conditions.push({
        op: Op.UINT_GTE_CONST,
        fieldId,
        bytesArg: minBytes as Hex,
      });
    }
    if (validation.max !== undefined) {
      // Encode max value as uint256 in bytesArg
      const maxBytes = encodeAbiParameters([{ type: "uint256" }], [BigInt(validation.max)]);
      conditions.push({
        op: Op.UINT_LTE_CONST,
        fieldId,
        bytesArg: maxBytes as Hex,
      });
    }
    // Note: step is not supported on-chain
    if (validation.step !== undefined) {
      console.warn(
        `Warning: 'step' validation for uint256 field '${varDef.name}' is not supported on-chain. ` +
        `Validate off-chain before submission.`
      );
    }
  }

  // STRING validations
  if (fieldType === FieldType.STRING) {
    // Note: 'required' is handled by InputFieldDef.required flag, no additional condition needed
    if (validation.minLength !== undefined) {
      // Encode minLength value as uint256 in bytesArg
      const minLengthBytes = encodeAbiParameters([{ type: "uint256" }], [BigInt(validation.minLength)]);
      conditions.push({
        op: Op.STRING_MIN_LENGTH,
        fieldId,
        bytesArg: minLengthBytes as Hex,
      });
    }
    if (validation.maxLength !== undefined) {
      // Encode maxLength value as uint256 in bytesArg
      const maxLengthBytes = encodeAbiParameters([{ type: "uint256" }], [BigInt(validation.maxLength)]);
      conditions.push({
        op: Op.STRING_MAX_LENGTH,
        fieldId,
        bytesArg: maxLengthBytes as Hex,
      });
    }
    // Note: pattern is not supported on-chain
    if (validation.pattern !== undefined) {
      console.warn(
        `Warning: 'pattern' validation for string field '${varDef.name}' is not supported on-chain. ` +
        `Validate off-chain before submission.`
      );
    }
  }

  // ADDRESS validations
  // Note: Address fields don't have on-chain validation beyond required (handled by InputFieldDef.required)
  // and equality checks (ADDRESS_EQ_CONST/ADDRESS_EQ_VAR)

  // BOOL and BYTES32 validations
  // Note: These types only support required (handled by InputFieldDef.required)

  return conditions;
}
