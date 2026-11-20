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
  type InputTimeWindow,
  type InputCheck,
} from "./types.js";
import { encodeFieldValue } from "./payload-builder.js";

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

/**
 * The field name the V1.1 engine reserves for the block time. A condition on
 * this field compares `block.timestamp` instead of a submitted value, and the
 * engine refuses an agreement that declares a field or stored variable with it.
 */
const BLOCK_TIME_FIELD_NAME = "block.timestamp";

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
  const inputDefs = transformInputs(
    execution.inputs,
    agreement.variables,
    requiredInitVars.map((v) => v.name)
  );
  assertStoredDatesArePlausible(execution.inputs, initValues || {});

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
 *
 * @param storedVariables - Names of the variables the agreement stores at
 *   creation (those in `execution.initialize.data`). Needed only when an input
 *   has a `time` bound that names a variable.
 */
export function transformInputs(
  inputs: AgreementJson["execution"]["inputs"],
  variables: AgreementJson["variables"],
  storedVariables?: Iterable<string>
): InputDef[] {
  const stored = storedVariables === undefined ? undefined : new Set(storedVariables);
  // A variable an input stores can be compared against as well as one stored at creation.
  const storedByInputs = new Set<string>();
  for (const [inputKey, inputDef] of Object.entries(inputs)) {
    for (const key of storedFieldKeys(inputKey, inputDef)) {
      storedByInputs.add(extractVariableName((inputDef.data || {})[key]) || key);
    }
  }

  return Object.entries(inputs).map(([inputKey, inputDef]) => {
    const id = keccak256(stringToHex(inputKey)) as Hex;

    // Build fields from the input's data object
    const fields: InputFieldDef[] = [];
    const conditions: Condition[] = [];
    
    const storeKeys = new Set(storedFieldKeys(inputKey, inputDef));
    for (const [fieldKey, fieldRef] of Object.entries(inputDef.data || {})) {
      const fieldMeta = resolveInputFieldMetadata(fieldKey, fieldRef, variables);
      if (storeKeys.has(fieldKey)) {
        if (!fieldMeta.required) {
          throw new Error(
            `Input '${inputKey}': stored field '${fieldKey}' must be required. An optional field can be left out, ` +
            `and the stored value would then not change.`
          );
        }
        fieldMeta.persist = true;
      }
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
    conditions.push(...buildTimeConditions(inputKey, inputDef.time, variables, stored));
    conditions.push(...buildCheckConditions(inputKey, inputDef, variables, stored, storedByInputs));

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

  const storeKeys = new Set(storedFieldKeys(inputId, input));
  return Object.entries(input.data || {}).map(([fieldKey, fieldRef]) => {
    const metadata = resolveInputFieldMetadata(fieldKey, fieldRef, agreement.variables);
    return storeKeys.has(fieldKey) ? { ...metadata, persist: true } : metadata;
  });
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
  if ((varName || fieldKey) === BLOCK_TIME_FIELD_NAME) {
    throw new Error(
      `'${BLOCK_TIME_FIELD_NAME}' is reserved for the block time and cannot be an input field. ` +
      `To limit when an input is accepted, give the input a 'time' window.`
    );
  }
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

const TIME_BOUNDS = {
  // The input is accepted from the moment on: block time >= moment.
  notBefore: { fixed: Op.UINT_GTE_CONST, stored: Op.UINT_GTE_VAR },
  // The input is accepted until the moment: block time < moment.
  before: { fixed: Op.UINT_LT_CONST, stored: Op.UINT_LT_VAR },
} as const;

const ISO_DATE_TIME_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/;

// A bound that names a stored date is exactly one variable reference, nothing around it.
const TIME_VARIABLE_REFERENCE = /^\$\{variables\.(\w+)(?:\.value)?\}$/;

// Fixed moments and stored dates outside this range are almost always a mistake:
// milliseconds given as seconds, a date written as digits, or an empty value.
const EARLIEST_MOMENT = 1_000_000_000n; // 2001-09-09
const LATEST_MOMENT = 10_000_000_000n; // 2286-11-20

function assertPlausibleMoment(where: string, seconds: bigint): void {
  if (seconds < EARLIEST_MOMENT || seconds >= LATEST_MOMENT) {
    throw new Error(
      `${where} is ${seconds} seconds since 1970-01-01 UTC, which is outside 2001 to 2286. ` +
      `A moment is given in seconds, not milliseconds, and not as a date written in digits.`
    );
  }
}

/**
 * Seconds since 1970-01-01 UTC for a fixed moment in a `time` window.
 */
function parseFixedMoment(inputKey: string, bound: string, value: unknown): bigint {
  const where = `Input '${inputKey}': time.${bound}`;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${where} must be a whole number of seconds since 1970-01-01 UTC, received ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value !== "string") {
    throw new Error(`${where} must be a number of seconds, an ISO 8601 date-time or a variable reference`);
  }
  if (/^\d+$/.test(value)) {
    return BigInt(value);
  }
  // A date-time without a zone would mean a different moment on each machine.
  const parts = ISO_DATE_TIME_WITH_ZONE.exec(value);
  const ms = parts ? Date.parse(value) : NaN;
  if (!parts || Number.isNaN(ms) || ms < 0) {
    throw new Error(
      `${where} '${value}' is not a moment the SDK can read. Use seconds since 1970-01-01 UTC, ` +
      `an ISO 8601 date-time with a zone such as '2027-03-01T00:00:00Z', or '\${variables.name}'.`
    );
  }
  if (parts[7] !== undefined && /[1-9]/.test(parts[7])) {
    throw new Error(`${where} '${value}' has a fraction of a second; the contract compares whole seconds`);
  }
  // Date.parse moves a day that does not exist into the next month. Read the
  // moment back in the zone it was written in and require the same fields.
  const zone = parts[8] === "Z" ? 0 : (parts[8][0] === "-" ? -1 : 1) * (Number(parts[8].slice(1, 3)) * 60 + Number(parts[8].slice(4, 6)));
  const local = new Date(ms + zone * 60_000);
  const written = [parts[1], parts[2], parts[3], parts[4], parts[5], parts[6] ?? "0"].map(Number);
  const read = [local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds()];
  if (written.some((field, i) => field !== read[i])) {
    throw new Error(`${where} '${value}' is not a date and time that exists`);
  }
  return BigInt(ms / 1000);
}

/**
 * A stored date that a time window names is checked when the agreement is
 * built: an empty value would be stored as 0 and leave the window meaningless.
 */
function assertStoredDatesArePlausible(
  inputs: AgreementJson["execution"]["inputs"],
  initValues: Record<string, InitValue>
): void {
  for (const [inputKey, inputDef] of Object.entries(inputs)) {
    const time = inputDef.time;
    if (typeof time !== "object" || time === null) continue;
    for (const bound of ["notBefore", "before"] as const) {
      const value = Object.prototype.hasOwnProperty.call(time, bound) ? time[bound] : undefined;
      const reference = typeof value === "string" ? TIME_VARIABLE_REFERENCE.exec(value) : null;
      if (!reference) continue;
      const initValue = initValues[reference[1]];
      const where = `Input '${inputKey}': time.${bound} names '${reference[1]}', whose value`;
      if (typeof initValue !== "bigint" && !(typeof initValue === "string" && /^\d+$/.test(initValue))) {
        throw new Error(`${where} must be a whole number of seconds since 1970-01-01 UTC, received '${String(initValue)}'`);
      }
      assertPlausibleMoment(where, BigInt(initValue));
    }
  }
}

/**
 * Conditions for an input's `time` window. Each compares the block time, which
 * the engine reads in place of a submitted field when a condition names the
 * reserved block-time field.
 */
function buildTimeConditions(
  inputKey: string,
  time: InputTimeWindow | undefined,
  variables: AgreementJson["variables"],
  storedVariables: Set<string> | undefined
): Condition[] {
  if (time === undefined) {
    return [];
  }
  if (typeof time !== "object" || time === null || Array.isArray(time)) {
    throw new Error(`Input '${inputKey}': 'time' must be an object with 'notBefore', 'before' or both`);
  }
  const unknown = Object.keys(time).filter((key) => !Object.prototype.hasOwnProperty.call(TIME_BOUNDS, key));
  if (unknown.length > 0) {
    throw new Error(
      `Input '${inputKey}': unknown time bound '${unknown[0]}'. Use 'notBefore' (accepted from that moment on) ` +
      `or 'before' (accepted until that moment).`
    );
  }

  const fieldId = fieldToBytes32(BLOCK_TIME_FIELD_NAME);
  const conditions: Condition[] = [];
  const fixed: { notBefore?: bigint; before?: bigint } = {};

  const stored: { notBefore?: string; before?: string } = {};
  for (const bound of ["notBefore", "before"] as const) {
    // Own properties only: the window is what the hashed document says.
    if (!Object.prototype.hasOwnProperty.call(time, bound) || time[bound] === undefined) {
      continue;
    }
    const value = time[bound];
    const reference = typeof value === "string" ? TIME_VARIABLE_REFERENCE.exec(value) : null;
    if (typeof value === "string" && !reference && value.includes("${")) {
      throw new Error(
        `Input '${inputKey}': time.${bound} '${value}' must be exactly one variable reference such as ` +
        `'\${variables.dueDate}'. Arithmetic and text around a reference are not supported.`
      );
    }
    const varName = reference ? reference[1] : "";
    if (!varName) {
      const seconds = parseFixedMoment(inputKey, bound, value);
      assertPlausibleMoment(`Input '${inputKey}': time.${bound}`, seconds);
      fixed[bound] = seconds;
      conditions.push({
        op: TIME_BOUNDS[bound].fixed,
        fieldId,
        bytesArg: encodeAbiParameters([{ type: "uint256" }], [seconds]) as Hex,
      });
      continue;
    }

    const where = `Input '${inputKey}': time.${bound}`;
    const varDef = variables[varName];
    if (!varDef) {
      throw new Error(`${where} references unknown variable '${varName}'`);
    }
    if (varDef.type !== "uint256") {
      throw new Error(
        `${where}: variable '${varName}' must be type 'uint256' holding seconds since 1970-01-01 UTC, ` +
        `received '${varDef.type}'`
      );
    }
    if (storedVariables === undefined) {
      throw new Error(
        `${where} names variable '${varName}', and transformInputs was not told which variables the agreement ` +
        `stores. Pass the names in execution.initialize.data, or use transformAgreementToOnChainParams.`
      );
    }
    if (!storedVariables.has(varName)) {
      throw new Error(
        `${where}: variable '${varName}' is not stored when the agreement is created, so the input could never ` +
        `be accepted. List it in execution.initialize.data.`
      );
    }
    stored[bound] = varName;
    conditions.push({
      op: TIME_BOUNDS[bound].stored,
      fieldId,
      bytesArg: fieldToBytes32(varName),
    });
  }

  if (conditions.length === 0) {
    throw new Error(`Input '${inputKey}': 'time' needs 'notBefore', 'before' or both`);
  }
  if (stored.notBefore !== undefined && stored.notBefore === stored.before) {
    throw new Error(
      `Input '${inputKey}': time.notBefore and time.before name the same variable '${stored.before}', ` +
      `so the input could never be accepted`
    );
  }
  if (fixed.notBefore !== undefined && fixed.before !== undefined && fixed.notBefore >= fixed.before) {
    throw new Error(
      `Input '${inputKey}': time.notBefore is not earlier than time.before, so the input could never be accepted`
    );
  }
  return conditions;
}

const CHECK_OPS = {
  equalTo: { fixed: Op.UINT_EQ_CONST, stored: Op.UINT_EQ_VAR, offset: Op.UINT_EQ_VAR_OFFSET },
  greaterThan: { fixed: Op.UINT_GT_CONST, stored: Op.UINT_GT_VAR, offset: Op.UINT_GT_VAR_OFFSET },
  greaterThanOrEqualTo: { fixed: Op.UINT_GTE_CONST, stored: Op.UINT_GTE_VAR, offset: Op.UINT_GTE_VAR_OFFSET },
  lessThan: { fixed: Op.UINT_LT_CONST, stored: Op.UINT_LT_VAR, offset: Op.UINT_LT_VAR_OFFSET },
  lessThanOrEqualTo: { fixed: Op.UINT_LTE_CONST, stored: Op.UINT_LTE_VAR, offset: Op.UINT_LTE_VAR_OFFSET },
} as const;
const CHECK_KEYS = ["field", "is", "to", "plus", "minus"];
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

/** The keys of an input's `data` that its `store` list names. */
function storedFieldKeys(inputKey: string, inputDef: AgreementJson["execution"]["inputs"][string]): string[] {
  const store = inputDef.store;
  if (store === undefined) {
    return [];
  }
  if (!Array.isArray(store)) {
    throw new Error(`Input '${inputKey}': 'store' must be a list of the input's field names`);
  }
  const data = inputDef.data || {};
  for (const key of store) {
    if (typeof key !== "string" || !own(data, key)) {
      throw new Error(`Input '${inputKey}': 'store' names '${String(key)}', which is not a field of this input`);
    }
  }
  if (new Set(store).size !== store.length) {
    throw new Error(`Input '${inputKey}': 'store' names a field twice`);
  }
  return store;
}

/** A whole number that is not negative, from a number or a string of digits. */
function wholeNumber(where: string, value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  throw new Error(`${where} must be a whole number that is not negative, received '${String(value)}'`);
}

/**
 * Conditions for an input's `checks`: comparisons of a submitted number with a
 * constant, a stored variable, or a stored variable plus or minus a constant.
 */
function buildCheckConditions(
  inputKey: string,
  inputDef: AgreementJson["execution"]["inputs"][string],
  variables: AgreementJson["variables"],
  storedAtCreation: Set<string> | undefined,
  storedByInputs: Set<string>
): Condition[] {
  const checks = inputDef.checks;
  if (checks === undefined) {
    return [];
  }
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new Error(`Input '${inputKey}': 'checks' must be a list with at least one check`);
  }
  const data = inputDef.data || {};
  return checks.map((check: InputCheck, index) => {
    const where = `Input '${inputKey}': checks[${index}]`;
    if (typeof check !== "object" || check === null || Array.isArray(check)) {
      throw new Error(`${where} must be an object with 'field', 'is' and 'to'`);
    }
    const unknown = Object.keys(check).filter((key) => !CHECK_KEYS.includes(key));
    if (unknown.length > 0) {
      throw new Error(`${where}: unknown key '${unknown[0]}'. A check has 'field', 'is', 'to' and optionally 'plus' or 'minus'.`);
    }
    for (const key of ["field", "is", "to"]) {
      if (!own(check, key)) throw new Error(`${where} needs '${key}'`);
    }

    // The field being checked.
    if (typeof check.field !== "string" || !own(data, check.field)) {
      throw new Error(`${where}: '${String(check.field)}' is not a field of this input`);
    }
    const fieldMeta = resolveInputFieldMetadata(check.field, data[check.field], variables);
    if (fieldMeta.fType !== FieldType.UINT256) {
      throw new Error(`${where}: field '${check.field}' must be type 'uint256'`);
    }
    if (!fieldMeta.required) {
      throw new Error(
        `${where}: field '${check.field}' must be required. The contract skips a check on an optional field that is left out.`
      );
    }

    // The comparison.
    if (typeof check.is !== "string" || !own(CHECK_OPS, check.is)) {
      throw new Error(`${where}: unknown comparison '${String(check.is)}'. Use one of ${Object.keys(CHECK_OPS).join(", ")}.`);
    }
    const ops = CHECK_OPS[check.is];
    const hasPlus = own(check, "plus") && check.plus !== undefined;
    const hasMinus = own(check, "minus") && check.minus !== undefined;
    if (hasPlus && hasMinus) {
      throw new Error(`${where} has both 'plus' and 'minus'; use one`);
    }

    // What it is compared with.
    const reference = typeof check.to === "string" ? TIME_VARIABLE_REFERENCE.exec(check.to) : null;
    if (typeof check.to === "string" && !reference && check.to.includes("${")) {
      throw new Error(
        `${where}: 'to' is '${check.to}', which must be exactly one variable reference such as '\${variables.round}'. ` +
        `Use 'plus' or 'minus' for arithmetic.`
      );
    }
    if (!reference) {
      if (hasPlus || hasMinus) {
        throw new Error(`${where}: 'plus' and 'minus' apply to a stored variable; write the constant itself in 'to'`);
      }
      const constant = wholeNumber(`${where}: 'to'`, check.to);
      return { op: ops.fixed, fieldId: fieldMeta.fieldId, bytesArg: encodeAbiParameters([{ type: "uint256" }], [constant]) as Hex };
    }

    const varName = reference[1];
    const varDef = variables[varName];
    if (!varDef) {
      throw new Error(`${where}: 'to' references unknown variable '${varName}'`);
    }
    if (varDef.type !== "uint256") {
      throw new Error(`${where}: variable '${varName}' must be type 'uint256', received '${varDef.type}'`);
    }
    if (storedAtCreation === undefined) {
      throw new Error(
        `${where} names variable '${varName}', and transformInputs was not told which variables the agreement ` +
        `stores. Pass the names in execution.initialize.data, or use transformAgreementToOnChainParams.`
      );
    }
    if (!storedAtCreation.has(varName) && !storedByInputs.has(varName)) {
      throw new Error(
        `${where}: variable '${varName}' is never stored, so the input could never be accepted. List it in ` +
        `execution.initialize.data, or in the 'store' of an input that submits it.`
      );
    }

    const amount = hasPlus ? wholeNumber(`${where}: 'plus'`, check.plus) : hasMinus ? wholeNumber(`${where}: 'minus'`, check.minus) : 0n;
    if (amount === 0n) {
      return { op: ops.stored, fieldId: fieldMeta.fieldId, bytesArg: fieldToBytes32(varName) };
    }
    if (amount >= 2n ** 255n) {
      throw new Error(`${where}: the amount to add or subtract is too large`);
    }
    return {
      op: ops.offset,
      fieldId: fieldMeta.fieldId,
      bytesArg: encodeAbiParameters([{ type: "bytes32" }, { type: "int256" }], [fieldToBytes32(varName), hasMinus ? -amount : amount]) as Hex,
    };
  });
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

    // The contracts cannot hold ETH, and V1.1 refuses to create an agreement
    // whose action forwards any.
    if (BigInt(a.call.value ?? "0") !== 0n) {
      throw new Error(
        `Action '${a.id}' forwards ETH (value ${a.call.value}), which agreements cannot do: ` +
        `set its value to "0" or leave it out`
      );
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
