// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll } from "@jest/globals";
import { keccak256, stringToHex, Address, Hex } from "viem";
import * as fs from "fs";
import * as path from "path";
import {
  transformAgreementToOnChainParams,
  stateToBytes32,
  inputToBytes32,
  fieldToBytes32,
  getRequiredInitVars,
} from "../src/transformer";
import { AgreementJson, FieldType, Op } from "../src/types";

// Mock addresses for testing
const MOCK_GRANTOR_ADDRESS = "0x1111111111111111111111111111111111111111" as Address;
const MOCK_RECIPIENT_ADDRESS = "0x2222222222222222222222222222222222222222" as Address;

describe("Transformer Parity with Integration Test", () => {
  let grantSimpleJson: AgreementJson;

  beforeAll(() => {
    const agreementPath = path.resolve(
      __dirname,
      "../../agreements/grant-simple/unwrapped/grant-simple.json"
    );
    grantSimpleJson = JSON.parse(fs.readFileSync(agreementPath, "utf-8"));
  });

  describe("Basic Structure", () => {
    it("should produce correct docUri and docHash", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );

      expect(params.docUri).toBe("ipfs://agreement/did:example:mou-v1");
      expect(params.docHash).toBe(
        keccak256(stringToHex(JSON.stringify(grantSimpleJson)))
      );
    });

    it("should produce correct initial state", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );

      expect(params.initialState).toBe(
        stateToBytes32("AWAITING_TEMPLATE_VARIABLES")
      );
    });

    it("should produce 5 input definitions", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );

      expect(params.inputDefs.length).toBe(5);
    });

    it("should produce 5 transitions", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );

      expect(params.transitions.length).toBe(5);
    });

    it("should produce 2 initVars for grantor and recipient addresses", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );

      expect(params.initVars.length).toBe(2);
      expect(params.initVars[0].fType).toBe(FieldType.ADDRESS);
      expect(params.initVars[1].fType).toBe(FieldType.ADDRESS);
    });
  });

  describe("Input Definitions - grantorData (first input)", () => {
    it("should have correct input ID", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );
      const grantorData = params.inputDefs.find(
        (d) => d.id === inputToBytes32("grantorData")
      );

      expect(grantorData).toBeDefined();
    });

    it("should have only template variable fields (addresses stored at creation)", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );
      const grantorData = params.inputDefs.find(
        (d) => d.id === inputToBytes32("grantorData")
      )!;

      // Should NOT have grantorEthAddress and recipientEthAddress (stored at creation)
      const grantorAddrField = grantorData.fields.find(
        (f) => f.fieldId === fieldToBytes32("grantorEthAddress")
      );
      const recipientAddrField = grantorData.fields.find(
        (f) => f.fieldId === fieldToBytes32("recipientEthAddress")
      );

      expect(grantorAddrField).toBeUndefined();
      expect(recipientAddrField).toBeUndefined();
    });

    it("should include template variable fields", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );
      const grantorData = params.inputDefs.find(
        (d) => d.id === inputToBytes32("grantorData")
      )!;

      const expectedFields = [
        "grantorName",
        "scope",
        "termDuration",
        "effectiveDate",
      ];

      for (const fieldName of expectedFields) {
        const field = grantorData.fields.find(
          (f) => f.fieldId === fieldToBytes32(fieldName)
        );
        expect(field).toBeDefined();
        expect(field!.fType).toBe(FieldType.STRING);
        expect(field!.persist).toBe(false);
      }
    });

    it("should have 4 total fields (only template vars, no addresses)", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );
      const grantorData = params.inputDefs.find(
        (d) => d.id === inputToBytes32("grantorData")
      )!;

      expect(grantorData.fields.length).toBe(4);
    });

    it("should have SENDER_EQ_VAR_ADDRESS condition (addresses now stored at creation)", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );
      const grantorData = params.inputDefs.find(
        (d) => d.id === inputToBytes32("grantorData")
      )!;

      // First input now has conditions because addresses are stored at creation + validation rules
      // Should have SENDER_EQ_VAR_ADDRESS + STRING_MIN_LENGTH for grantorName
      expect(grantorData.conditions.length).toBe(2);
      const senderCondition = grantorData.conditions.find(
        (c) => c.op === Op.SENDER_EQ_VAR_ADDRESS
      );
      expect(senderCondition).toBeDefined();
      expect(senderCondition!.fieldId).toBe(
        fieldToBytes32("grantorEthAddress")
      );
      const minLengthCondition = grantorData.conditions.find(
        (c) => c.op === Op.STRING_MIN_LENGTH
      );
      expect(minLengthCondition).toBeDefined();
      expect(minLengthCondition!.fieldId).toBe(
        fieldToBytes32("grantorName")
      );
    });
  });

  describe("Input Definitions - recipientSigning", () => {
    it("should have SENDER_EQ_VAR_ADDRESS condition against recipientEthAddress", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );
      const recipientSigning = params.inputDefs.find(
        (d) => d.id === inputToBytes32("recipientSigning")
      )!;

      // Should have SENDER_EQ_VAR_ADDRESS + STRING_MIN_LENGTH for recipientName
      expect(recipientSigning.conditions.length).toBe(2);
      const senderCondition = recipientSigning.conditions.find(
        (c) => c.op === Op.SENDER_EQ_VAR_ADDRESS
      );
      expect(senderCondition).toBeDefined();
      expect(senderCondition!.fieldId).toBe(
        fieldToBytes32("recipientEthAddress")
      );
      const minLengthCondition = recipientSigning.conditions.find(
        (c) => c.op === Op.STRING_MIN_LENGTH
      );
      expect(minLengthCondition).toBeDefined();
      expect(minLengthCondition!.fieldId).toBe(
        fieldToBytes32("recipientName")
      );
      // SENDER_EQ_VAR_ADDRESS has empty bytesArg, STRING_MIN_LENGTH has encoded uint256
      expect(senderCondition!.bytesArg).toBe("0x");
      expect(minLengthCondition!.bytesArg).toMatch(/^0x[a-fA-F0-9]{64}$/); // Encoded uint256 (32 bytes)
    });

    it("should have correct fields", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );
      const recipientSigning = params.inputDefs.find(
        (d) => d.id === inputToBytes32("recipientSigning")
      )!;

      expect(recipientSigning.fields.length).toBe(2);

      const recipientName = recipientSigning.fields.find(
        (f) => f.fieldId === fieldToBytes32("recipientName")
      );
      const recipientSignature = recipientSigning.fields.find(
        (f) => f.fieldId === fieldToBytes32("recipientSignature")
      );

      expect(recipientName).toBeDefined();
      expect(recipientName!.fType).toBe(FieldType.STRING);

      expect(recipientSignature).toBeDefined();
      expect(recipientSignature!.fType).toBe(FieldType.STRING);
    });
  });

  describe("Input Definitions - grantorSigning", () => {
    it("should have SENDER_EQ_VAR_ADDRESS condition against grantorEthAddress", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );
      const grantorSigning = params.inputDefs.find(
        (d) => d.id === inputToBytes32("grantorSigning")
      )!;

      expect(grantorSigning.conditions.length).toBe(1);
      expect(grantorSigning.conditions[0].op).toBe(Op.SENDER_EQ_VAR_ADDRESS);
      expect(grantorSigning.conditions[0].fieldId).toBe(
        fieldToBytes32("grantorEthAddress")
      );
    });
  });

  describe("Input Definitions - grantorRejection", () => {
    it("should have SENDER_EQ_VAR_ADDRESS condition against grantorEthAddress", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );
      const grantorRejection = params.inputDefs.find(
        (d) => d.id === inputToBytes32("grantorRejection")
      )!;

      expect(grantorRejection.conditions.length).toBe(1);
      expect(grantorRejection.conditions[0].op).toBe(Op.SENDER_EQ_VAR_ADDRESS);
      expect(grantorRejection.conditions[0].fieldId).toBe(
        fieldToBytes32("grantorEthAddress")
      );
    });
  });

  describe("Input Definitions - workTokenSentTx", () => {
    it("should have SENDER_EQ_VAR_ADDRESS condition against grantorEthAddress", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );
      const workTokenSentTx = params.inputDefs.find(
        (d) => d.id === inputToBytes32("workTokenSentTx")
      )!;

      expect(workTokenSentTx.conditions.length).toBe(1);
      expect(workTokenSentTx.conditions[0].op).toBe(Op.SENDER_EQ_VAR_ADDRESS);
      expect(workTokenSentTx.conditions[0].fieldId).toBe(
        fieldToBytes32("grantorEthAddress")
      );
    });

    it("should have BYTES32 field for txHash", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );
      const workTokenSentTx = params.inputDefs.find(
        (d) => d.id === inputToBytes32("workTokenSentTx")
      )!;

      expect(workTokenSentTx.fields.length).toBe(1);
      expect(workTokenSentTx.fields[0].fType).toBe(FieldType.BYTES32);
    });
  });

  describe("Transitions", () => {
    it("should have correct happy path transitions", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );

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
      ];

      for (const expected of expectedTransitions) {
        const transition = params.transitions.find(
          (t) =>
            t.fromState === stateToBytes32(expected.from) &&
            t.toState === stateToBytes32(expected.to)
        );

        expect(transition).toBeDefined();
        expect(transition!.inputId).toBe(inputToBytes32(expected.input));
      }
    });

    it("should have rejection transition", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );

      const rejectionTransition = params.transitions.find(
        (t) =>
          t.fromState === stateToBytes32("AWAITING_GRANTOR_SIGNATURE") &&
          t.toState === stateToBytes32("REJECTED")
      );

      expect(rejectionTransition).toBeDefined();
      expect(rejectionTransition!.inputId).toBe(
        inputToBytes32("grantorRejection")
      );
    });
  });

  describe("Initialization Requirements", () => {
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

    it("should correctly identify required init vars", () => {
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
  });

  describe("Integration Test Parity", () => {
    it("should produce output usable by the contract", () => {
      const params = transformAgreementToOnChainParams(
        grantSimpleJson,
        undefined,
        {
          grantorEthAddress: MOCK_GRANTOR_ADDRESS,
          recipientEthAddress: MOCK_RECIPIENT_ADDRESS,
        }
      );

      // Verify all bytes32 values are valid
      expect(params.docHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(params.initialState).toMatch(/^0x[a-fA-F0-9]{64}$/);

      for (const inputDef of params.inputDefs) {
        expect(inputDef.id).toMatch(/^0x[a-fA-F0-9]{64}$/);
        expect(inputDef.verifierKeys).toEqual([]);

        for (const field of inputDef.fields) {
          expect(field.fieldId).toMatch(/^0x[a-fA-F0-9]{64}$/);
          expect(field.fType).toBeGreaterThanOrEqual(0);
          expect(field.fType).toBeLessThanOrEqual(4);
          expect(typeof field.required).toBe("boolean");
          expect(typeof field.persist).toBe("boolean");
        }

        for (const condition of inputDef.conditions) {
          // Conditions can be SENDER_EQ_VAR_ADDRESS, STRING_MIN_LENGTH, STRING_MAX_LENGTH, UINT_GTE_CONST, UINT_LTE_CONST, etc.
          expect([
            Op.SENDER_EQ_VAR_ADDRESS,
            Op.SENDER_IN_ALLOWED_ADDRESSES,
            Op.STRING_MIN_LENGTH,
            Op.STRING_MAX_LENGTH,
            Op.UINT_GTE_CONST,
            Op.UINT_LTE_CONST,
          ]).toContain(condition.op);
          expect(condition.fieldId).toMatch(/^0x[a-fA-F0-9]{64}$/);
          expect(typeof condition.bytesArg).toBe("string");
          expect(condition.bytesArg).toMatch(/^0x([a-fA-F0-9]*)$/);
        }
      }

      for (const transition of params.transitions) {
        expect(transition.fromState).toMatch(/^0x[a-fA-F0-9]{64}$/);
        expect(transition.toState).toMatch(/^0x[a-fA-F0-9]{64}$/);
        expect(transition.inputId).toMatch(/^0x[a-fA-F0-9]{64}$/);
      }

      // Verify initVars
      expect(params.initVars.length).toBe(2);
      for (const initVar of params.initVars) {
        expect(initVar.id).toMatch(/^0x[a-fA-F0-9]{64}$/);
        expect(initVar.fType).toBe(FieldType.ADDRESS);
        expect(initVar.data).toMatch(/^0x[a-fA-F0-9]+$/);
      }

      expect(params.verifiers).toEqual([]);
    });
  });
});
