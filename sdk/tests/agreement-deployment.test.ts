// SPDX-License-Identifier: Apache-2.0

/**
 * Agreement Deployment Tests
 *
 * Tests the transformation of agreement JSON files into on-chain
 * createAgreement() parameters.
 */

import { describe, it, expect, beforeAll } from "@jest/globals";
import { keccak256, stringToHex, encodeAbiParameters, encodeFunctionData, getFunctionSelector, Address } from "viem";
import * as fs from "fs";
import * as path from "path";
import {
  transformAgreementToOnChainParams,
  transformInputs,
  transformTransitions,
  getInputFieldMetadata,
  extractVariableName,
  mapVariableTypeToFieldType,
  fieldToBytes32,
  stateToBytes32,
  inputToBytes32,
  getRequiredInitVars,
  buildInitVars,
} from "../src/transformer";
import { AgreementJson, FieldType, Op } from "../src/types";
import { AgreementFactoryABI } from "../src/generated/AgreementFactoryAbi.js";

const AGREEMENT_FACTORY_ABI = AgreementFactoryABI;

// Mock addresses for testing
const MOCK_GRANTOR_ADDRESS = "0x1111111111111111111111111111111111111111" as Address;
const MOCK_RECIPIENT_ADDRESS = "0x2222222222222222222222222222222222222222" as Address;
const MOCK_REVIEWER_ADDRESS = "0x3333333333333333333333333333333333333333" as Address;

const multiIssuerAgreementJson: AgreementJson = {
  metadata: {
    id: "did:example:multi-issuer",
    templateId: "did:template:multi-issuer",
    version: "1.0.0",
    name: "Multi Issuer Approval",
  },
  variables: {
    primaryApprover: {
      type: "address",
      name: "Primary Approver",
      validation: { required: true },
    },
    backupApprover: {
      type: "address",
      name: "Backup Approver",
      validation: { required: true },
    },
    approvalNote: {
      type: "string",
      name: "Approval Note",
      validation: { required: true, minLength: 3 },
    },
  },
  content: {
    type: "md",
    data: "Approval content",
  },
  execution: {
    states: {
      PENDING: { name: "Pending" },
      APPROVED: { name: "Approved" },
    },
    initialize: {
      initialState: "PENDING",
      data: {
        primaryApprover: "${variables.primaryApprover}",
        backupApprover: "${variables.backupApprover}",
      },
    },
    inputs: {
      approve: {
        type: "signedFields",
        data: {
          approvalNote: "${variables.approvalNote}",
        },
        issuer: [
          "${variables.primaryApprover.value}",
          "${variables.backupApprover.value}",
          MOCK_REVIEWER_ADDRESS,
        ],
      },
    },
    transitions: [
      {
        from: "PENDING",
        to: "APPROVED",
        conditions: [{ type: "isValid", input: "approve" }],
      },
    ],
  },
};

describe("Agreement Deployment from JSON", () => {
  let grantSimpleJson: AgreementJson;
  let validationTestJson: AgreementJson;

  beforeAll(() => {
    // Load the agreement JSON
    const agreementPath = path.resolve(
      __dirname,
      "../../agreements/grant-simple/unwrapped/grant-simple.json"
    );
    grantSimpleJson = JSON.parse(fs.readFileSync(agreementPath, "utf-8"));

    const validationTestPath = path.resolve(
      __dirname,
      "../../agreements/validation-test/unwrapped/validation-test.json"
    );
    validationTestJson = JSON.parse(fs.readFileSync(validationTestPath, "utf-8"));
  });

  describe("transformAgreementToOnChainParams", () => {
    it("should transform grant-simple.json into createAgreement parameters", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );

      // Verify basic structure
      expect(params.docUri).toBeDefined();
      expect(params.docHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(params.initialState).toMatch(/^0x[a-fA-F0-9]{64}$/);

      // Verify we have inputs for each execution.inputs entry
      const expectedInputCount = Object.keys(
        grantSimpleJson.execution.inputs
      ).length;
      expect(params.inputDefs.length).toBe(expectedInputCount);

      // Verify we have transitions matching execution.transitions
      expect(params.transitions.length).toBe(
        grantSimpleJson.execution.transitions.length
      );

      // Verify initial state matches
      const expectedInitialState = keccak256(
        stringToHex(grantSimpleJson.execution.initialize.initialState)
      );
      expect(params.initialState).toBe(expectedInitialState);

      // Verify initVars are present
      expect(params.initVars.length).toBe(2);
    });

    it("should use custom docUri when provided", () => {
      const customUri = "https://example.com/agreement/123";
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        customUri,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );

      expect(params.docUri).toBe(customUri);
    });

    it("should generate consistent docHash for same input", () => {
      const params1 = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );
      const params2 = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );

      expect(params1.docHash).toBe(params2.docHash);
    });

    it("should produce deterministic values for known input and docUri", () => {
      const docUri = "ipfs://agreement/grant-simple-test";
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        docUri,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );

      const expectedDocHash = keccak256(stringToHex(JSON.stringify(grantSimpleJson)));
      const expectedInitialState = keccak256(
        stringToHex(grantSimpleJson.execution.initialize.initialState)
      );

      expect(params.docUri).toBe(docUri);
      expect(params.docHash).toBe(expectedDocHash);
      expect(params.initialState).toBe(expectedInitialState);
    });

    it("should throw error when initValues not provided", () => {
      expect(() => {
        transformAgreementToOnChainParams(grantSimpleJson);
      }).toThrow(/requires initialization values/);
    });

    it("should throw error when specific init value is missing", () => {
      expect(() => {
        transformAgreementToOnChainParams(grantSimpleJson, undefined, {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          // Missing recipientEthAddress
        });
      }).toThrow(/Missing initialization value for 'recipientEthAddress'/);
    });
  });

  describe("transformInputs", () => {
    it("should correctly map input fields from variables", () => {
      const inputDefs = transformInputs(
        grantSimpleJson.execution.inputs,
        grantSimpleJson.variables
      );

      // Find the grantorData input
      const grantorDataInputId = keccak256(stringToHex("grantorData"));
      const grantorDataInput = inputDefs.find(
        (i) => i.id === grantorDataInputId
      );

      expect(grantorDataInput).toBeDefined();
      // grantorData now only has: grantorName, scope, termDuration, effectiveDate
      // (addresses are stored at creation, not in first input)
      expect(grantorDataInput!.fields.length).toBe(4);
    });

    it("should generate correct input IDs", () => {
      const inputDefs = transformInputs(
        grantSimpleJson.execution.inputs,
        grantSimpleJson.variables
      );

      const expectedInputNames = Object.keys(grantSimpleJson.execution.inputs);
      const expectedIds = expectedInputNames.map((name) =>
        keccak256(stringToHex(name))
      );

      const actualIds = inputDefs.map((def) => def.id);

      for (const expectedId of expectedIds) {
        expect(actualIds).toContain(expectedId);
      }
    });

    it("should set correct field types based on variable types", () => {
      const inputDefs = transformInputs(
        grantSimpleJson.execution.inputs,
        grantSimpleJson.variables
      );

      // Find recipientSigning input which has recipientName (string) and recipientSignature (signature)
      const recipientSigningId = keccak256(stringToHex("recipientSigning"));
      const recipientSigningInput = inputDefs.find(
        (i) => i.id === recipientSigningId
      );

      expect(recipientSigningInput).toBeDefined();
      // Both string and signature types should map to STRING FieldType
      for (const field of recipientSigningInput!.fields) {
        expect(field.fType).toBe(FieldType.STRING);
      }
    });

    it("should create SENDER_EQ_VAR_ADDRESS conditions for all inputs with address issuer", () => {
      const inputDefs = transformInputs(
        grantSimpleJson.execution.inputs,
        grantSimpleJson.variables
      );

      // All inputs with issuers should have conditions now
      const recipientSigning = inputDefs.find(
        (i) => i.id === keccak256(stringToHex("recipientSigning"))
      );
      expect(recipientSigning).toBeDefined();
      expect(
        recipientSigning!.conditions.some(
          (c) =>
            c.op === Op.SENDER_EQ_VAR_ADDRESS &&
            c.fieldId === keccak256(stringToHex("recipientEthAddress"))
        )
      ).toBe(true);

      const grantorSigning = inputDefs.find(
        (i) => i.id === keccak256(stringToHex("grantorSigning"))
      );
      expect(grantorSigning).toBeDefined();
      expect(
        grantorSigning!.conditions.some(
          (c) =>
            c.op === Op.SENDER_EQ_VAR_ADDRESS &&
            c.fieldId === keccak256(stringToHex("grantorEthAddress"))
        )
      ).toBe(true);

      const grantorRejection = inputDefs.find(
        (i) => i.id === keccak256(stringToHex("grantorRejection"))
      );
      expect(grantorRejection).toBeDefined();
      expect(
        grantorRejection!.conditions.some(
          (c) =>
            c.op === Op.SENDER_EQ_VAR_ADDRESS &&
            c.fieldId === keccak256(stringToHex("grantorEthAddress"))
        )
      ).toBe(true);

      // First input now has conditions (addresses stored at creation + validation rules)
      const firstInput = inputDefs.find(
        (i) => i.id === keccak256(stringToHex("grantorData"))
      );
      expect(firstInput).toBeDefined();
      // Should have SENDER_EQ_VAR_ADDRESS + STRING_MIN_LENGTH for grantorName
      expect(firstInput!.conditions.length).toBe(2);
      expect(
        firstInput!.conditions.some(
          (c) =>
            c.op === Op.SENDER_EQ_VAR_ADDRESS &&
            c.fieldId === keccak256(stringToHex("grantorEthAddress"))
        )
      ).toBe(true);
      expect(
        firstInput!.conditions.some(
          (c) =>
            c.op === Op.STRING_MIN_LENGTH &&
            c.fieldId === keccak256(stringToHex("grantorName"))
        )
      ).toBe(true);
    });

    it("should mark address fields as persist=true", () => {
      const inputDefs = transformInputs(
        grantSimpleJson.execution.inputs,
        grantSimpleJson.variables
      );

      // Find any input that has an address field
      for (const inputDef of inputDefs) {
        for (const field of inputDef.fields) {
          // If it's an address type, it should persist
          if (field.fType === FieldType.ADDRESS) {
            expect(field.persist).toBe(true);
          }
        }
      }
    });

    it("should compile issuer arrays into SENDER_IN_ALLOWED_ADDRESSES", () => {
      const inputDefs = transformInputs(
        multiIssuerAgreementJson.execution.inputs,
        multiIssuerAgreementJson.variables
      );

      expect(inputDefs).toHaveLength(1);
      expect(inputDefs[0].conditions).toHaveLength(2);

      const senderCondition = inputDefs[0].conditions.find(
        (condition) => condition.op === Op.SENDER_IN_ALLOWED_ADDRESSES
      );

      expect(senderCondition).toBeDefined();
      expect(senderCondition!.fieldId).toBe(
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      );
      expect(senderCondition!.bytesArg).toBe(
        encodeAbiParameters(
          [{ type: "bytes32[]" }, { type: "address[]" }],
          [
            [fieldToBytes32("primaryApprover"), fieldToBytes32("backupApprover")],
            [MOCK_REVIEWER_ADDRESS],
          ]
        )
      );
    });

    it("should reject invalid issuer entries during transformation", () => {
      const invalidAgreement: AgreementJson = {
        ...multiIssuerAgreementJson,
        execution: {
          ...multiIssuerAgreementJson.execution,
          inputs: {
            approve: {
              ...multiIssuerAgreementJson.execution.inputs.approve,
              issuer: ["not-an-address"],
            },
          },
        },
      };

      expect(() =>
        transformInputs(invalidAgreement.execution.inputs, invalidAgreement.variables)
      ).toThrow(/must be an address variable reference or literal address/);
    });

    it("should preserve optional field metadata for SDK consumers", () => {
      const metadata = getInputFieldMetadata(validationTestJson, "submitValidation");
      const optionalComment = metadata.find((field) => field.name === "optionalComment");
      const optionalScore = metadata.find((field) => field.name === "optionalScore");

      expect(optionalComment).toBeDefined();
      expect(optionalComment!.required).toBe(false);
      expect(optionalComment!.fType).toBe(FieldType.STRING);

      expect(optionalScore).toBeDefined();
      expect(optionalScore!.required).toBe(false);
      expect(optionalScore!.fType).toBe(FieldType.UINT256);
    });
  });

  describe("getRequiredInitVars and buildInitVars", () => {
    it("should identify required init vars from initialize.data", () => {
      const requiredVars = getRequiredInitVars(
        grantSimpleJson.execution.initialize.data || {},
        grantSimpleJson.variables
      );

      const varNames = requiredVars.map((v) => v.name);
      expect(varNames).toContain("grantorEthAddress");
      expect(varNames).toContain("recipientEthAddress");
      expect(requiredVars.length).toBe(2);

      // Verify types are captured
      const grantorVar = requiredVars.find((v) => v.name === "grantorEthAddress");
      expect(grantorVar?.type).toBe("address");
    });

    it("should build initVars array with correct structure", () => {
      const requiredVars = getRequiredInitVars(
        grantSimpleJson.execution.initialize.data || {},
        grantSimpleJson.variables
      );

      const initVars = buildInitVars(requiredVars, {
        grantorEthAddress: MOCK_GRANTOR_ADDRESS,
        recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
      });

      expect(initVars.length).toBe(2);
      for (const initVar of initVars) {
        expect(initVar.id).toMatch(/^0x[a-fA-F0-9]{64}$/);
        expect(initVar.fType).toBe(FieldType.ADDRESS);
        expect(initVar.data).toMatch(/^0x[a-fA-F0-9]+$/);
      }
    });

    it("should build initVars with multiple types", () => {
      // Create a mock agreement with different variable types in initialize.data
      const multiTypeInitData = {
        someAddress: "${variables.testAddress}",
        someString: "${variables.testString}",
        someUint: "${variables.testUint}",
        someBool: "${variables.testBool}",
      };

      const multiTypeVariables = {
        testAddress: { type: "address" as const, name: "Test Address" },
        testString: { type: "string" as const, name: "Test String" },
        testUint: { type: "uint256" as const, name: "Test Uint" },
        testBool: { type: "bool" as const, name: "Test Bool" },
      };

      const requiredVars = getRequiredInitVars(multiTypeInitData, multiTypeVariables);
      expect(requiredVars.length).toBe(4);

      // Verify each type is captured correctly
      expect(requiredVars.find((v) => v.name === "testAddress")?.type).toBe("address");
      expect(requiredVars.find((v) => v.name === "testString")?.type).toBe("string");
      expect(requiredVars.find((v) => v.name === "testUint")?.type).toBe("uint256");
      expect(requiredVars.find((v) => v.name === "testBool")?.type).toBe("bool");

      // Build initVars with mixed types
      const initVars = buildInitVars(requiredVars, {
        testAddress: "0x3333333333333333333333333333333333333333" as Address,
        testString: "Hello World",
        testUint: 12345n,
        testBool: true,
      });

      expect(initVars.length).toBe(4);

      // Verify field types are correct
      const addressVar = initVars.find((v) => v.fType === FieldType.ADDRESS);
      const stringVar = initVars.find((v) => v.fType === FieldType.STRING);
      const uintVar = initVars.find((v) => v.fType === FieldType.UINT256);
      const boolVar = initVars.find((v) => v.fType === FieldType.BOOL);

      expect(addressVar).toBeDefined();
      expect(stringVar).toBeDefined();
      expect(uintVar).toBeDefined();
      expect(boolVar).toBeDefined();

      // All should have valid hex data
      for (const initVar of initVars) {
        expect(initVar.id).toMatch(/^0x[a-fA-F0-9]{64}$/);
        expect(initVar.data).toMatch(/^0x[a-fA-F0-9]+$/);
      }
    });
  });

  describe("transformTransitions", () => {
    it("should generate valid transitions for the state machine", () => {
      const transitions = transformTransitions(
        grantSimpleJson.execution.transitions
      );

      // Check first transition: AWAITING_TEMPLATE_VARIABLES -> AWAITING_RECIPIENT_SIGNATURE
      const fromState = keccak256(stringToHex("AWAITING_TEMPLATE_VARIABLES"));
      const toState = keccak256(stringToHex("AWAITING_RECIPIENT_SIGNATURE"));
      const inputId = keccak256(stringToHex("grantorData"));

      const transition = transitions.find(
        (t) => t.fromState === fromState && t.toState === toState
      );

      expect(transition).toBeDefined();
      expect(transition!.inputId).toBe(inputId);
    });

    it("should create all transitions from the JSON", () => {
      const transitions = transformTransitions(
        grantSimpleJson.execution.transitions
      );

      expect(transitions.length).toBe(
        grantSimpleJson.execution.transitions.length
      );

      // Verify each transition has valid bytes32 values
      for (const t of transitions) {
        expect(t.fromState).toMatch(/^0x[a-fA-F0-9]{64}$/);
        expect(t.toState).toMatch(/^0x[a-fA-F0-9]{64}$/);
        expect(t.inputId).toMatch(/^0x[a-fA-F0-9]{64}$/);
      }
    });

    it("should correctly link inputs to transitions", () => {
      const transitions = transformTransitions(
        grantSimpleJson.execution.transitions
      );

      // Map of expected from->to->input relationships
      const expectedTransitions = [
        {
          from: "AWAITING_TEMPLATE_VARIABLES",
          to: "AWAITING_RECIPIENT_SIGNATURE",
          input: "grantorData",
        },
        {
          from: "AWAITING_RECIPIENT_SIGNATURE",
          to: "AWAITING_GRANTOR_SIGNATURE",
          input: "recipientSigning",
        },
        {
          from: "AWAITING_GRANTOR_SIGNATURE",
          to: "AWAITING_PAYMENT",
          input: "grantorSigning",
        },
        {
          from: "AWAITING_PAYMENT",
          to: "WORK_ACCEPTED_AND_PAID",
          input: "workTokenSentTx",
        },
        {
          from: "AWAITING_GRANTOR_SIGNATURE",
          to: "REJECTED",
          input: "grantorRejection",
        },
      ];

      for (const expected of expectedTransitions) {
        const fromState = stateToBytes32(expected.from);
        const toState = stateToBytes32(expected.to);
        const inputId = inputToBytes32(expected.input);

        const found = transitions.find(
          (t) =>
            t.fromState === fromState &&
            t.toState === toState &&
            t.inputId === inputId
        );

        expect(found).toBeDefined();
      }
    });
  });

  describe("Helper functions", () => {
    describe("extractVariableName", () => {
      it('should extract variable name from "${variables.name}" format', () => {
        expect(extractVariableName("${variables.grantorName}")).toBe(
          "grantorName"
        );
        expect(
          extractVariableName("${variables.grantorEthAddress.value}")
        ).toBe("grantorEthAddress");
        expect(extractVariableName("${variables.scope}")).toBe("scope");
      });

      it("should return empty string for non-variable strings", () => {
        expect(extractVariableName("plain string")).toBe("");
        expect(extractVariableName("")).toBe("");
        expect(extractVariableName(null)).toBe("");
        expect(extractVariableName(undefined)).toBe("");
      });
    });

    describe("mapVariableTypeToFieldType", () => {
      it("should map agreement types to FieldType enum", () => {
        expect(mapVariableTypeToFieldType("string")).toBe(FieldType.STRING);
        expect(mapVariableTypeToFieldType("address")).toBe(FieldType.ADDRESS);
        expect(mapVariableTypeToFieldType("uint256")).toBe(FieldType.UINT256);
        expect(mapVariableTypeToFieldType("bool")).toBe(FieldType.BOOL);
        expect(mapVariableTypeToFieldType("bytes32")).toBe(FieldType.BYTES32);
      });

      it("should map agreement-specific types correctly", () => {
        expect(mapVariableTypeToFieldType("signature")).toBe(FieldType.STRING);
        expect(mapVariableTypeToFieldType("dateTime")).toBe(FieldType.STRING);
        expect(mapVariableTypeToFieldType("txHash")).toBe(FieldType.BYTES32);
      });

      it("should default to STRING for unknown types", () => {
        expect(mapVariableTypeToFieldType("unknown")).toBe(FieldType.STRING);
        expect(mapVariableTypeToFieldType("")).toBe(FieldType.STRING);
      });
    });

    describe("stateToBytes32 and inputToBytes32", () => {
      it("should generate consistent bytes32 values", () => {
        const state1 = stateToBytes32("AWAITING_PAYMENT");
        const state2 = stateToBytes32("AWAITING_PAYMENT");
        expect(state1).toBe(state2);

        const input1 = inputToBytes32("grantorData");
        const input2 = inputToBytes32("grantorData");
        expect(input1).toBe(input2);
      });

      it("should generate different bytes32 for different inputs", () => {
        const state1 = stateToBytes32("AWAITING_PAYMENT");
        const state2 = stateToBytes32("REJECTED");
        expect(state1).not.toBe(state2);
      });
    });
  });

  describe("Full transformation validation", () => {
    it("should produce parameters that match contract expectations", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );

      // Validate docUri is a non-empty string
      expect(typeof params.docUri).toBe("string");
      expect(params.docUri.length).toBeGreaterThan(0);

      // Validate docHash is a valid bytes32
      expect(params.docHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

      // Validate initialState is a valid bytes32
      expect(params.initialState).toMatch(/^0x[a-fA-F0-9]{64}$/);

      // Validate inputDefs structure
      for (const inputDef of params.inputDefs) {
        expect(inputDef.id).toMatch(/^0x[a-fA-F0-9]{64}$/);
        expect(Array.isArray(inputDef.fields)).toBe(true);
        expect(Array.isArray(inputDef.conditions)).toBe(true);
        expect(Array.isArray(inputDef.verifierKeys)).toBe(true);

        for (const field of inputDef.fields) {
          expect(field.fieldId).toMatch(/^0x[a-fA-F0-9]{64}$/);
          expect(typeof field.fType).toBe("number");
          expect(field.fType).toBeGreaterThanOrEqual(0);
          expect(field.fType).toBeLessThanOrEqual(4);
          expect(typeof field.required).toBe("boolean");
          expect(typeof field.persist).toBe("boolean");
        }

        for (const condition of inputDef.conditions) {
          expect(typeof condition.op).toBe("number");
          expect(condition.fieldId).toMatch(/^0x[a-fA-F0-9]{64}$/);
          expect(typeof condition.bytesArg).toBe("string");
          expect(condition.bytesArg).toMatch(/^0x([a-fA-F0-9]*)$/);
        }
      }

      // Validate transitions structure
      for (const transition of params.transitions) {
        expect(transition.fromState).toMatch(/^0x[a-fA-F0-9]{64}$/);
        expect(transition.toState).toMatch(/^0x[a-fA-F0-9]{64}$/);
        expect(transition.inputId).toMatch(/^0x[a-fA-F0-9]{64}$/);
      }

      // Validate initVars structure
      expect(Array.isArray(params.initVars)).toBe(true);
      for (const initVar of params.initVars) {
        expect(initVar.id).toMatch(/^0x[a-fA-F0-9]{64}$/);
        expect(typeof initVar.fType).toBe("number");
        expect(initVar.data).toMatch(/^0x[a-fA-F0-9]+$/);
      }
    });

    it("should be usable with viem encodeAbiParameters", async () => {
      // This test verifies the output format is compatible with viem's encoding
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );

      // The params should be directly usable with writeContract
      // We just verify the structure here without actually encoding
      expect(params).toHaveProperty("docUri");
      expect(params).toHaveProperty("docHash");
      expect(params).toHaveProperty("initialState");
      expect(params).toHaveProperty("inputDefs");
      expect(params).toHaveProperty("transitions");
      expect(params).toHaveProperty("initVars");
      expect(params).toHaveProperty("verifiers");
      expect(params).toHaveProperty("actions");

      // InputDefs should be arrays of tuples
      expect(params.inputDefs.every((d) => "id" in d && "fields" in d)).toBe(
        true
      );

      // Transitions should be arrays of tuples
      expect(
        params.transitions.every(
          (t) => "fromState" in t && "toState" in t && "inputId" in t
        )
      ).toBe(true);

      // InitVars should be arrays of tuples
      expect(
        params.initVars.every((v) => "id" in v && "fType" in v && "data" in v)
      ).toBe(true);

      // Verifiers should be arrays of tuples (may be empty)
      expect(
        params.verifiers.every(
          (v) => "key" in v && "verifier" in v
        )
      ).toBe(true);

      // Actions should be arrays of tuples (may be empty)
      expect(
        params.actions.every(
          (a) =>
            "fromState" in a &&
            "inputId" in a &&
            "target" in a &&
            "value" in a &&
            "data" in a
        )
      ).toBe(true);
    });
  });

  describe("ABI compatibility", () => {
    it("should encode createAgreement calldata matching the Factory ABI", () => {
      const docUri = "ipfs://agreement/grant-simple-test";
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        docUri,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );

      // createAgreement is now in AgreementFactory (EIP-1167 clone pattern)
      const calldata = encodeFunctionData({
        abi: AGREEMENT_FACTORY_ABI,
        functionName: "createAgreement",
        args: [
          params.docUri,
          params.docHash,
          params.initialState,
          params.inputDefs,
          params.transitions,
          params.initVars,
          params.verifiers,
          params.actions,
        ],
      });

      // Factory's createAgreement signature
      const selector = getFunctionSelector(
        "createAgreement(string,bytes32,bytes32,(bytes32,(bytes32,uint8,bool,bool)[],(uint8,bytes32,bytes)[],bytes32[])[],(bytes32,bytes32,bytes32)[],(bytes32,uint8,bytes)[],(bytes32,address)[],(bytes32,bytes32,address,uint256,bytes)[])"
      );

      expect(calldata.startsWith(selector)).toBe(true);
      expect(calldata.length).toBeGreaterThan(selector.length);
    });

    it("should prepare a populated transaction request for AgreementFactory", () => {
      const docUri = "ipfs://agreement/grant-simple-test";
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        docUri,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );
      const factoryAddress = "0x0000000000000000000000000000000000000001";

      // createAgreement is now called on AgreementFactory
      const data = encodeFunctionData({
        abi: AGREEMENT_FACTORY_ABI,
        functionName: "createAgreement",
        args: [
          params.docUri,
          params.docHash,
          params.initialState,
          params.inputDefs,
          params.transitions,
          params.initVars,
          params.verifiers,
          params.actions,
        ],
      });

      const txRequest = {
        to: factoryAddress,
        data,
      };

      expect(txRequest.to).toBe(factoryAddress);
      expect(txRequest.data.startsWith("0x")).toBe(true);
      expect(txRequest.data.length).toBeGreaterThan(10);
    });
  });
});
