// SPDX-License-Identifier: Apache-2.0

/**
 * Payload Builder for AgreementEngine.submitInput()
 *
 * Builds ABI-encoded DataField[] payloads from input JSON files
 * or programmatic input data.
 */

import {
  encodeAbiParameters,
  Hex,
  Address,
} from "viem";
import { AgreementJson, FieldType } from "./types.js";
import { fieldToBytes32, inputToBytes32, getInputFieldTypes } from "./transformer.js";

/**
 * A single data field to be submitted
 */
export interface DataFieldInput {
  name: string;
  type: FieldType;
  value: string | bigint | boolean | Address;
}

/**
 * Encoded DataField struct matching the contract
 */
export interface EncodedDataField {
  id: Hex;
  fType: number;
  data: Hex;
}

/**
 * Re-export from transformer for convenience
 */
export { fieldToBytes32, inputToBytes32 };

/**
 * Alias for backwards compatibility
 */
export const fieldNameToBytes32 = fieldToBytes32;
export const inputIdToBytes32 = inputToBytes32;

/**
 * Encode a single field value based on its type
 */
export function encodeFieldValue(type: FieldType, value: unknown): Hex {
  switch (type) {
    case FieldType.STRING:
      return encodeAbiParameters([{ type: "string" }], [value as string]);

    case FieldType.ADDRESS:
      return encodeAbiParameters([{ type: "address" }], [value as Address]);

    case FieldType.UINT256:
      return encodeAbiParameters([{ type: "uint256" }], [BigInt(value as string | bigint)]);

    case FieldType.BOOL:
      const boolValue = typeof value === "boolean" ? value : value === "true";
      return encodeAbiParameters([{ type: "bool" }], [boolValue]);

    case FieldType.BYTES32:
      return encodeAbiParameters([{ type: "bytes32" }], [value as Hex]);

    default:
      throw new Error(`Unsupported field type: ${type}`);
  }
}

/**
 * Encode a single DataField
 */
export function encodeDataField(field: DataFieldInput): EncodedDataField {
  return {
    id: fieldToBytes32(field.name),
    fType: field.type,
    data: encodeFieldValue(field.type, field.value),
  };
}

/**
 * Encode multiple DataFields into the payload format expected by submitInput
 */
export function encodeDataFields(fields: DataFieldInput[]): EncodedDataField[] {
  return fields.map(encodeDataField);
}

/**
 * Build the complete ABI-encoded payload for submitInput
 *
 * @param fields - Array of field inputs to encode
 * @returns Hex-encoded payload ready for submitInput
 */
export function buildSubmitInputPayload(fields: DataFieldInput[]): Hex {
  const encodedFields = encodeDataFields(fields);

  // Encode as tuple array: (bytes32 id, uint8 fType, bytes data)[]
  return encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "id", type: "bytes32" },
          { name: "fType", type: "uint8" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    [
      encodedFields.map((f) => ({
        id: f.id,
        fType: f.fType,
        data: f.data,
      })),
    ]
  );
}

/**
 * Helper to create a STRING field input
 */
export function stringField(name: string, value: string): DataFieldInput {
  return { name, type: FieldType.STRING, value };
}

/**
 * Helper to create an ADDRESS field input
 */
export function addressField(name: string, value: Address): DataFieldInput {
  return { name, type: FieldType.ADDRESS, value };
}

/**
 * Helper to create a UINT256 field input
 */
export function uint256Field(name: string, value: bigint | string): DataFieldInput {
  return { name, type: FieldType.UINT256, value };
}

/**
 * Helper to create a BOOL field input
 */
export function boolField(name: string, value: boolean): DataFieldInput {
  return { name, type: FieldType.BOOL, value };
}

/**
 * Helper to create a BYTES32 field input
 */
export function bytes32Field(name: string, value: Hex): DataFieldInput {
  return { name, type: FieldType.BYTES32, value };
}

/**
 * Input JSON file format (from agreements/grant-simple/unwrapped/input-*.json)
 */
export interface InputJsonFile {
  inputId: string;
  type?: string;
  values: Record<string, unknown>;
}

/**
 * Build payload from an input JSON file structure
 *
 * @param inputJson - Parsed input JSON file
 * @param fieldTypes - Map of field name to FieldType
 * @returns Hex-encoded payload
 */
export function buildPayloadFromInputJson(
  inputJson: InputJsonFile,
  fieldTypes: Record<string, FieldType>
): Hex {
  const fields: DataFieldInput[] = Object.entries(inputJson.values).map(
    ([name, value]) => {
      const type = fieldTypes[name];
      if (type === undefined) {
        throw new Error(`Unknown field type for '${name}'. Provide it in fieldTypes map.`);
      }
      return { name, type, value: value as string | bigint | boolean | Address };
    }
  );

  return buildSubmitInputPayload(fields);
}

/**
 * Build payload from a plain object with explicit field types.
 * 
 * @param data - Plain object with field values
 * @param fieldTypes - Map of field name to FieldType
 * @returns Hex-encoded payload ready for submitInput
 * 
 * @example
 * const payload = buildPayloadFromObject(
 *   { grantorName: "Alice", scope: "Development" },
 *   { grantorName: FieldType.STRING, scope: FieldType.STRING }
 * );
 */
export function buildPayloadFromObject(
  data: Record<string, unknown>,
  fieldTypes: Record<string, FieldType>
): Hex {
  const fields: DataFieldInput[] = Object.entries(data).map(([name, value]) => {
    const type = fieldTypes[name];
    if (type === undefined) {
      throw new Error(`Unknown field type for '${name}'. Provide it in fieldTypes map.`);
    }
    return { name, type, value: value as string | bigint | boolean | Address };
  });
  return buildSubmitInputPayload(fields);
}

/**
 * Build payload for a specific input using the agreement JSON as the schema.
 * This is the most convenient way to build payloads - just pass a plain object!
 * 
 * @param agreement - The agreement JSON definition (provides field types)
 * @param inputId - The input identifier (e.g., "grantorData")
 * @param data - Plain object with field values; optional fields may be omitted
 * @returns Hex-encoded payload ready for submitInput
 * 
 * @example
 * const payload = buildInputPayload(grantSimple, "grantorData", {
 *   grantorName: "Alice",
 *   scope: "Development of Web3 tooling",
 *   termDuration: "6 months",
 *   effectiveDate: "2024-03-20T12:00:00Z",
 * });
 */
export function buildInputPayload(
  agreement: AgreementJson,
  inputId: string,
  data: Record<string, unknown>
): Hex {
  const fieldTypes = getInputFieldTypes(agreement, inputId);
  return buildPayloadFromObject(data, fieldTypes);
}
