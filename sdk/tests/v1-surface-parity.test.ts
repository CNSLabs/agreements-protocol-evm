// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "@jest/globals";

import * as sdk from "../src/index.js";

/**
 * Runtime names exported from the package root by 0.1.4.
 *
 * 0.2.0 changes the shape of several of these (see CHANGELOG.md) but must not
 * add, drop or rename any root export.
 */
const ROOT_EXPORTS_0_1_4 = [
  "AgreementEngine",
  "AgreementEngineABI",
  "AgreementFactory",
  "AgreementFactoryABI",
  "FieldType",
  "Op",
  "addressField",
  "boolField",
  "buildInitVars",
  "buildInputPayload",
  "buildPayloadFromInputJson",
  "buildPayloadFromObject",
  "buildSubmitInputPayload",
  "bytes32Field",
  "createInstrumentedHttpTransport",
  "encodeDataField",
  "encodeDataFields",
  "encodeFieldValue",
  "extractVariableName",
  "fieldNameToBytes32",
  "fieldToBytes32",
  "generateConditionsFromValidation",
  "getAllFactoryConfigs",
  "getDeploymentByChainId",
  "getDeploymentByNetwork",
  "getFactoryConfigByChainId",
  "getFactoryConfigByNetwork",
  "getInlineValidation",
  "getInlineVariableType",
  "getInputFieldMetadata",
  "getInputFieldTypes",
  "getRequiredInitVars",
  "inputIdToBytes32",
  "inputToBytes32",
  "listDeployments",
  "mapVariableTypeToFieldType",
  "stateToBytes32",
  "stringField",
  "transformActions",
  "transformAgreementToOnChainParams",
  "transformInputs",
  "transformTransitions",
  "uint256Field",
];

describe("root export surface", () => {
  it("exports exactly the names 0.1.4 exported", () => {
    expect(Object.keys(sdk).sort()).toEqual([...ROOT_EXPORTS_0_1_4].sort());
  });
});
