// SPDX-License-Identifier: Apache-2.0

import { isAddress, keccak256, stringToHex, type Hex } from "viem";
import type { AgreementJson, CreateAgreementParams } from "./types.js";
import {
  getRequiredInitVars,
  transformAgreementToOnChainParams,
  type InitValue,
} from "./transformer.js";

export const AGREEMENT_PACKAGE_SCHEMA_VERSION = "0.1" as const;
export const AGREEMENT_PACKAGE_PROFILE_ID = "shodai.evm.agreement-engine" as const;
export const AGREEMENT_PACKAGE_PROFILE_VERSION = "0.1" as const;
export const AGREEMENT_PACKAGE_COMPILER =
  "@shodai-network/agreements-protocol-evm/package-compiler-0.1" as const;

export type AgreementPackageInitValue = string | boolean;

export interface AgreementPackage {
  schemaVersion: typeof AGREEMENT_PACKAGE_SCHEMA_VERSION;
  profile: {
    id: typeof AGREEMENT_PACKAGE_PROFILE_ID;
    version: typeof AGREEMENT_PACKAGE_PROFILE_VERSION;
    compiler: typeof AGREEMENT_PACKAGE_COMPILER;
  };
  target: {
    chainId: string;
  };
  agreement: AgreementJson;
  initialization: {
    values: Record<string, AgreementPackageInitValue>;
  };
}

export type AgreementCompilationIssueCode =
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "UNSUPPORTED_PROFILE"
  | "UNSUPPORTED_PROFILE_VERSION"
  | "UNSUPPORTED_COMPILER"
  | "INVALID_TARGET_CHAIN_ID"
  | "INVALID_INITIALIZATION_VALUE"
  | "INVALID_INITIALIZATION_REFERENCE"
  | "MISSING_INITIALIZATION_VALUE"
  | "UNUSED_INITIALIZATION_VALUE"
  | "UNKNOWN_INPUT_VARIABLE"
  | "UNKNOWN_STATE"
  | "TRANSITION_TRIGGER_COUNT"
  | "DUPLICATE_TRANSITION_TRIGGER"
  | "UNSUPPORTED_TRANSITION_CONDITION"
  | "UNKNOWN_TRANSITION_INPUT"
  | "UNSUPPORTED_ACTION_FAILURE_POLICY"
  | "ACTION_WITHOUT_TRANSITION"
  | "DUPLICATE_ACTION_HOOK"
  | "UNKNOWN_ACTION_CONTRACT"
  | "ACTION_CONTRACT_CHAIN_MISMATCH"
  | "UNSUPPORTED_ONCHAIN_VALIDATION"
  | "TRANSFORM_FAILURE";

export interface AgreementCompilationIssue {
  code: AgreementCompilationIssueCode;
  path: string;
  message: string;
}

export interface AgreementCompilationReport {
  compiler: typeof AGREEMENT_PACKAGE_COMPILER;
  packageDigest: Hex;
  targetChainId: string;
  issues: AgreementCompilationIssue[];
}

export interface AgreementCompilationManifest {
  schemaVersion: typeof AGREEMENT_PACKAGE_SCHEMA_VERSION;
  profile: {
    id: typeof AGREEMENT_PACKAGE_PROFILE_ID;
    version: typeof AGREEMENT_PACKAGE_PROFILE_VERSION;
    compiler: typeof AGREEMENT_PACKAGE_COMPILER;
  };
  packageDigest: Hex;
  canonicalPackage: string;
  targetChainId: string;
  docUri: string;
  compiled: {
    inputDefs: number;
    transitions: number;
    initVars: number;
    verifiers: number;
    actions: number;
  };
}

export interface CompiledAgreementPackage {
  params: CreateAgreementParams;
  report: AgreementCompilationReport;
  manifest: AgreementCompilationManifest;
}

export class AgreementPackageCompilationError extends Error {
  constructor(public readonly report: AgreementCompilationReport) {
    super(
      `Agreement package compilation failed with ${report.issues.length} issue(s): ` +
        report.issues.map((issue) => issue.code).join(", ")
    );
    this.name = "AgreementPackageCompilationError";
  }
}

/**
 * Produce deterministic JSON text for JSON-compatible input.
 *
 * Object keys use ECMAScript's UTF-16 code-unit sort order and array order is
 * retained. Values that cannot be represented without ambiguity in JSON are
 * rejected rather than silently omitted or coerced.
 */
export function canonicalizeJson(value: unknown): string {
  const ancestors = new Set<object>();

  const visit = (current: unknown, path: string): string => {
    if (current === null) return "null";

    if (typeof current === "string" || typeof current === "boolean") {
      return JSON.stringify(current);
    }

    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new TypeError(`Non-finite number at ${path}`);
      }
      return JSON.stringify(current);
    }

    if (
      typeof current === "undefined" ||
      typeof current === "function" ||
      typeof current === "symbol" ||
      typeof current === "bigint"
    ) {
      throw new TypeError(`Unsupported JSON value at ${path}: ${typeof current}`);
    }

    if (typeof current !== "object") {
      throw new TypeError(`Unsupported JSON value at ${path}`);
    }

    if (ancestors.has(current)) {
      throw new TypeError(`Cyclic JSON value at ${path}`);
    }
    ancestors.add(current);

    try {
      if (Array.isArray(current)) {
        const values: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(current, index)) {
            throw new TypeError(`Sparse array at ${path}[${index}]`);
          }
          values.push(visit(current[index], `${path}[${index}]`));
        }
        return `[${values.join(",")}]`;
      }

      // `structuredClone` and test runners can produce plain objects from a
      // different JavaScript realm, so prototype identity is not portable.
      // The intrinsic tag still rejects Date/Map/Set and other non-JSON values.
      if (Object.prototype.toString.call(current) !== "[object Object]") {
        throw new TypeError(`Non-plain JSON object at ${path}`);
      }

      const objectValue = current as Record<string, unknown>;
      const members = Object.keys(objectValue)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${visit(objectValue[key], `${path}.${key}`)}`
        );
      return `{${members.join(",")}}`;
    } finally {
      ancestors.delete(current);
    }
  };

  return visit(value, "$");
}

export function hashAgreementPackage(agreementPackage: AgreementPackage): Hex {
  return keccak256(stringToHex(canonicalizeJson(agreementPackage)));
}

function issue(
  code: AgreementCompilationIssueCode,
  path: string,
  message: string
): AgreementCompilationIssue {
  return { code, path, message };
}

function inspectPackage(agreementPackage: AgreementPackage): AgreementCompilationIssue[] {
  const issues: AgreementCompilationIssue[] = [];
  const { agreement } = agreementPackage;

  if (agreementPackage.schemaVersion !== AGREEMENT_PACKAGE_SCHEMA_VERSION) {
    issues.push(
      issue(
        "UNSUPPORTED_SCHEMA_VERSION",
        "$.schemaVersion",
        `Expected schema version ${AGREEMENT_PACKAGE_SCHEMA_VERSION}`
      )
    );
  }

  if (agreementPackage.profile.id !== AGREEMENT_PACKAGE_PROFILE_ID) {
    issues.push(
      issue(
        "UNSUPPORTED_PROFILE",
        "$.profile.id",
        `Expected executable profile ${AGREEMENT_PACKAGE_PROFILE_ID}`
      )
    );
  }

  if (agreementPackage.profile.version !== AGREEMENT_PACKAGE_PROFILE_VERSION) {
    issues.push(
      issue(
        "UNSUPPORTED_PROFILE_VERSION",
        "$.profile.version",
        `Expected executable profile version ${AGREEMENT_PACKAGE_PROFILE_VERSION}`
      )
    );
  }

  if (agreementPackage.profile.compiler !== AGREEMENT_PACKAGE_COMPILER) {
    issues.push(
      issue(
        "UNSUPPORTED_COMPILER",
        "$.profile.compiler",
        `Expected compiler ${AGREEMENT_PACKAGE_COMPILER}`
      )
    );
  }

  if (!/^[1-9][0-9]*$/.test(agreementPackage.target.chainId)) {
    issues.push(
      issue(
        "INVALID_TARGET_CHAIN_ID",
        "$.target.chainId",
        "Target chainId must be a positive base-10 string"
      )
    );
  }

  const requiredInitVars = getRequiredInitVars(
    agreement.execution.initialize.data || {},
    agreement.variables
  );
  const requiredNames = new Set(requiredInitVars.map((entry) => entry.name));
  const providedValues = agreementPackage.initialization.values;

  for (const [initKey, initReference] of Object.entries(
    agreement.execution.initialize.data || {}
  )) {
    const match = initReference.match(/^\$\{variables\.([A-Za-z0-9_]+)(?:\.value)?\}$/);
    const path = `$.agreement.execution.initialize.data.${initKey}`;
    if (!match || !agreement.variables[match[1]]) {
      issues.push(
        issue(
          "INVALID_INITIALIZATION_REFERENCE",
          path,
          `Initialization entry '${initKey}' must reference a declared variable`
        )
      );
    }
  }

  for (const required of requiredInitVars) {
    const value = providedValues[required.name];
    const path = `$.initialization.values.${required.name}`;
    if (value === undefined) {
      issues.push(
        issue(
          "MISSING_INITIALIZATION_VALUE",
          path,
          `Missing initialization value for '${required.name}'`
        )
      );
      continue;
    }

    if (required.type === "bool" && typeof value !== "boolean") {
      issues.push(
        issue(
          "INVALID_INITIALIZATION_VALUE",
          path,
          `Boolean variable '${required.name}' requires a JSON boolean`
        )
      );
    } else if (required.type === "uint256") {
      if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
        issues.push(
          issue(
            "INVALID_INITIALIZATION_VALUE",
            path,
            `uint256 variable '${required.name}' requires a base-10 string`
          )
        );
      }
    } else if (required.type === "address") {
      if (typeof value !== "string" || !isAddress(value)) {
        issues.push(
          issue(
            "INVALID_INITIALIZATION_VALUE",
            path,
            `Address variable '${required.name}' requires a valid EVM address`
          )
        );
      }
    } else if (typeof value !== "string") {
      issues.push(
        issue(
          "INVALID_INITIALIZATION_VALUE",
          path,
          `Variable '${required.name}' requires a string initialization value`
        )
      );
    }
  }

  for (const providedName of Object.keys(providedValues)) {
    if (!requiredNames.has(providedName)) {
      issues.push(
        issue(
          "UNUSED_INITIALIZATION_VALUE",
          `$.initialization.values.${providedName}`,
          `Initialization value '${providedName}' is not referenced by execution.initialize.data`
        )
      );
    }
  }

  for (const [variableName, variable] of Object.entries(agreement.variables)) {
    if (variable.validation?.pattern !== undefined) {
      issues.push(
        issue(
          "UNSUPPORTED_ONCHAIN_VALIDATION",
          `$.agreement.variables.${variableName}.validation.pattern`,
          "The current EVM compiler does not enforce pattern validation"
        )
      );
    }
    if (variable.validation?.step !== undefined) {
      issues.push(
        issue(
          "UNSUPPORTED_ONCHAIN_VALIDATION",
          `$.agreement.variables.${variableName}.validation.step`,
          "The current EVM compiler does not enforce step validation"
        )
      );
    }
  }

  for (const [inputName, input] of Object.entries(agreement.execution.inputs)) {
    for (const [fieldName, fieldReference] of Object.entries(input.data || {})) {
      const path = `$.agreement.execution.inputs.${inputName}.data.${fieldName}`;
      if (typeof fieldReference === "string") {
        const match = fieldReference.match(/^\$\{variables\.([A-Za-z0-9_]+)(?:\.value)?\}$/);
        if (!match || !agreement.variables[match[1]]) {
          issues.push(
            issue(
              "UNKNOWN_INPUT_VARIABLE",
              path,
              `Input field '${fieldName}' must reference a declared variable`
            )
          );
        }
      } else {
        const validation = fieldReference.validation;
        if (validation?.pattern !== undefined || validation?.step !== undefined) {
          issues.push(
            issue(
              "UNSUPPORTED_ONCHAIN_VALIDATION",
              `${path}.validation`,
              "The current EVM compiler does not enforce inline pattern or step validation"
            )
          );
        }
      }
    }
  }

  if (!agreement.execution.states[agreement.execution.initialize.initialState]) {
    issues.push(
      issue(
        "UNKNOWN_STATE",
        "$.agreement.execution.initialize.initialState",
        `Initial state '${agreement.execution.initialize.initialState}' is not declared`
      )
    );
  }

  const transitionTriggers = new Set<string>();

  agreement.execution.transitions.forEach((transition, transitionIndex) => {
    const path = `$.agreement.execution.transitions[${transitionIndex}]`;
    if (!agreement.execution.states[transition.from]) {
      issues.push(
        issue(
          "UNKNOWN_STATE",
          `${path}.from`,
          `Transition source state '${transition.from}' is not declared`
        )
      );
    }
    if (!agreement.execution.states[transition.to]) {
      issues.push(
        issue(
          "UNKNOWN_STATE",
          `${path}.to`,
          `Transition destination state '${transition.to}' is not declared`
        )
      );
    }
    const conditions = transition.conditions || [];
    if (conditions.length !== 1) {
      issues.push(
        issue(
          "TRANSITION_TRIGGER_COUNT",
          `${path}.conditions`,
          `The current EVM runtime requires exactly one transition trigger; received ${conditions.length}`
        )
      );
      return;
    }

    const [condition] = conditions;
    if (condition.type !== "isValid") {
      issues.push(
        issue(
          "UNSUPPORTED_TRANSITION_CONDITION",
          `${path}.conditions[0].type`,
          `Unsupported transition condition '${condition.type}'`
        )
      );
    }
    if (!agreement.execution.inputs[condition.input]) {
      issues.push(
        issue(
          "UNKNOWN_TRANSITION_INPUT",
          `${path}.conditions[0].input`,
          `Transition references unknown input '${condition.input}'`
        )
      );
    }

    const triggerKey = `${transition.from}\u0000${condition.input}`;
    if (transitionTriggers.has(triggerKey)) {
      issues.push(
        issue(
          "DUPLICATE_TRANSITION_TRIGGER",
          path,
          `More than one transition handles input '${condition.input}' from state '${transition.from}'`
        )
      );
    }
    transitionTriggers.add(triggerKey);
  });

  const actionHooks = new Set<string>();
  (agreement.execution.actions || []).forEach((action, actionIndex) => {
    const path = `$.agreement.execution.actions[${actionIndex}]`;
    if (action.revertOnFailure === false) {
      issues.push(
        issue(
          "UNSUPPORTED_ACTION_FAILURE_POLICY",
          `${path}.revertOnFailure`,
          "The current AgreementEngine always reverts when an action call fails"
        )
      );
    }

    const matchingTransitions = agreement.execution.transitions.filter(
      (transition) =>
        transition.from === action.when.from &&
        transition.conditions?.length === 1 &&
        transition.conditions[0].input === action.when.input
    );
    if (matchingTransitions.length !== 1) {
      issues.push(
        issue(
          "ACTION_WITHOUT_TRANSITION",
          `${path}.when`,
          `Action '${action.id}' must match exactly one transition; matched ${matchingTransitions.length}`
        )
      );
    }

    const hookKey = `${action.when.from}\u0000${action.when.input}`;
    if (actionHooks.has(hookKey)) {
      issues.push(
        issue(
          "DUPLICATE_ACTION_HOOK",
          `${path}.when`,
          `More than one action is attached to '${action.when.from}' + '${action.when.input}'`
        )
      );
    }
    actionHooks.add(hookKey);

    const contractMatch = action.call.target.match(
      /^\$\{contracts\.([A-Za-z0-9_]+)\.address\}$/
    );
    if (contractMatch) {
      const contractName = contractMatch[1];
      const contract = agreement.contracts?.[contractName];
      if (!contract) {
        issues.push(
          issue(
            "UNKNOWN_ACTION_CONTRACT",
            `${path}.call.target`,
            `Action '${action.id}' references unknown contract '${contractName}'`
          )
        );
      } else if (contract.chainId !== agreementPackage.target.chainId) {
        issues.push(
          issue(
            "ACTION_CONTRACT_CHAIN_MISMATCH",
            `$.agreement.contracts.${contractName}.chainId`,
            `Contract '${contractName}' targets chain ${contract.chainId}, package targets ${agreementPackage.target.chainId}`
          )
        );
      }
    }
  });

  return issues;
}

function toTransformerInitValues(
  agreementPackage: AgreementPackage
): Record<string, InitValue> {
  const values: Record<string, InitValue> = {};
  const variables = agreementPackage.agreement.variables;

  for (const [name, value] of Object.entries(
    agreementPackage.initialization.values
  )) {
    values[name] = variables[name]?.type === "uint256" ? BigInt(value as string) : value;
  }

  return values;
}

export function compileAgreementPackage(
  agreementPackage: AgreementPackage,
  docUri?: string
): CompiledAgreementPackage {
  const canonicalPackage = canonicalizeJson(agreementPackage);
  const packageDigest = keccak256(stringToHex(canonicalPackage));
  const report: AgreementCompilationReport = {
    compiler: AGREEMENT_PACKAGE_COMPILER,
    packageDigest,
    targetChainId: agreementPackage.target.chainId,
    issues: inspectPackage(agreementPackage),
  };

  if (report.issues.length > 0) {
    throw new AgreementPackageCompilationError(report);
  }

  let params: CreateAgreementParams;
  try {
    params = transformAgreementToOnChainParams(
      agreementPackage.agreement,
      docUri,
      toTransformerInitValues(agreementPackage)
    );
  } catch (error) {
    report.issues.push(
      issue(
        "TRANSFORM_FAILURE",
        "$.agreement",
        error instanceof Error ? error.message : String(error)
      )
    );
    throw new AgreementPackageCompilationError(report);
  }

  params.docHash = packageDigest;

  return {
    params,
    report,
    manifest: {
      schemaVersion: AGREEMENT_PACKAGE_SCHEMA_VERSION,
      profile: {
        id: AGREEMENT_PACKAGE_PROFILE_ID,
        version: AGREEMENT_PACKAGE_PROFILE_VERSION,
        compiler: AGREEMENT_PACKAGE_COMPILER,
      },
      packageDigest,
      canonicalPackage,
      targetChainId: agreementPackage.target.chainId,
      docUri: params.docUri,
      compiled: {
        inputDefs: params.inputDefs.length,
        transitions: params.transitions.length,
        initVars: params.initVars.length,
        verifiers: params.verifiers.length,
        actions: params.actions.length,
      },
    },
  };
}
