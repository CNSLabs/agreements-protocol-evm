// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll } from "@jest/globals";
import { encodeAbiParameters } from "viem";
import * as fs from "fs";
import * as path from "path";
import { transformAgreementToOnChainParams, transformInputs, fieldToBytes32, inputToBytes32, getInputFieldMetadata } from "../src/transformer";
import { AgreementJson, Op, InputCheck } from "../src/types";

const INIT = {
  grantee: "0x1111111111111111111111111111111111111111",
  reviewer: "0x2222222222222222222222222222222222222222",
  milestoneCount: "3",
  currentMilestone: "1",
};
const uint = (value: bigint | number) => encodeAbiParameters([{ type: "uint256" }], [BigInt(value)]);
const offset = (variable: string, by: bigint | number) =>
  encodeAbiParameters([{ type: "bytes32" }, { type: "int256" }], [fieldToBytes32(variable), BigInt(by)]);

describe("checks and stored fields on inputs", () => {
  let counted: AgreementJson;

  beforeAll(() => {
    const file = path.resolve(__dirname, "../../agreements/counted-milestones/unwrapped/counted-milestones.json");
    counted = JSON.parse(fs.readFileSync(file, "utf-8"));
  });

  const edited = (edit: (agreement: AgreementJson) => void): AgreementJson => {
    const agreement: AgreementJson = JSON.parse(JSON.stringify(counted));
    edit(agreement);
    return agreement;
  };
  const inputDef = (agreement: AgreementJson, input: string) =>
    transformAgreementToOnChainParams(agreement, undefined, INIT).inputDefs.find((def) => def.id === inputToBytes32(input))!;
  /** The example with the checks of `acceptMilestone` replaced. */
  const withChecks = (checks: unknown) => edited((a) => { a.execution.inputs.acceptMilestone.checks = checks as InputCheck[]; });
  const checkConditions = (checks: unknown) => inputDef(withChecks(checks), "acceptMilestone").conditions.slice(2);

  describe("the example agreement", () => {
    it("a step names its milestone: equalTo a stored variable", () => {
      expect(inputDef(counted, "submitWork").conditions.at(-1)).toEqual({
        op: Op.UINT_EQ_VAR_OFFSET,
        fieldId: fieldToBytes32("milestone"),
        bytesArg: offset("currentMilestone", 0),
      });
    });

    it("accepting a milestone: this one, not the last, and the stored milestone moves on by one", () => {
      const def = inputDef(counted, "acceptMilestone");
      expect(def.conditions.slice(-3)).toEqual([
        { op: Op.UINT_EQ_VAR_OFFSET, fieldId: fieldToBytes32("milestone"), bytesArg: offset("currentMilestone", 0) },
        { op: Op.UINT_LT_VAR_OFFSET, fieldId: fieldToBytes32("milestone"), bytesArg: offset("milestoneCount", 0) },
        { op: Op.UINT_EQ_VAR_OFFSET, fieldId: fieldToBytes32("currentMilestone"), bytesArg: offset("currentMilestone", 1) },
      ]);
      const stored = def.fields.find((f) => f.fieldId === fieldToBytes32("currentMilestone"))!;
      expect(stored).toMatchObject({ persist: true, required: true });
      // Only the field named in `store` is stored.
      expect(def.fields.filter((f) => f.persist).map((f) => f.fieldId)).toEqual([fieldToBytes32("currentMilestone")]);
      expect(getInputFieldMetadata(counted, "acceptMilestone").find((f) => f.name === "currentMilestone")!.persist).toBe(true);
    });

    it("an agreement without checks or store transforms as before", () => {
      const plain = edited((a) => {
        for (const input of Object.values(a.execution.inputs)) { delete input.checks; delete input.store; }
      });
      for (const def of transformAgreementToOnChainParams(plain, undefined, INIT).inputDefs) {
        expect(def.fields.some((f) => f.persist)).toBe(false);
        expect(def.conditions.every((c) => c.op === Op.STRING_MIN_LENGTH || c.op === Op.SENDER_EQ_VAR_ADDRESS)).toBe(true);
      }
    });
  });

  describe("what a check becomes", () => {
    it.each([
      ["equalTo", Op.UINT_EQ_CONST, Op.UINT_EQ_VAR_OFFSET],
      ["greaterThan", Op.UINT_GT_CONST, Op.UINT_GT_VAR_OFFSET],
      ["greaterThanOrEqualTo", Op.UINT_GTE_CONST, Op.UINT_GTE_VAR_OFFSET],
      ["lessThan", Op.UINT_LT_CONST, Op.UINT_LT_VAR_OFFSET],
      ["lessThanOrEqualTo", Op.UINT_LTE_CONST, Op.UINT_LTE_VAR_OFFSET],
    ])("%s against a constant, a stored variable, and a stored variable plus or minus a constant", (is, fixed, stored) => {
      const fieldId = fieldToBytes32("milestone");
      const to = "${variables.milestoneCount}";
      expect(
        checkConditions([
          { field: "milestone", is, to: 7 },
          { field: "milestone", is, to: "12" },
          { field: "milestone", is, to },
          { field: "milestone", is, to, plus: 2 },
          { field: "milestone", is, to, minus: "1" },
          { field: "milestone", is, to, plus: 0 },
        ])
      ).toEqual([
        { op: fixed, fieldId, bytesArg: uint(7) },
        { op: fixed, fieldId, bytesArg: uint(12) },
        { op: stored, fieldId, bytesArg: offset("milestoneCount", 0) },
        { op: stored, fieldId, bytesArg: offset("milestoneCount", 2) },
        { op: stored, fieldId, bytesArg: offset("milestoneCount", -1) },
        { op: stored, fieldId, bytesArg: offset("milestoneCount", 0) },
      ]);
    });

    it("no check uses a comparison with a stored variable that an engine from before the offset codes knows", () => {
      // Those engines then refuse to create the agreement. V1.0 would accept the plain codes and read them differently.
      const older = [Op.UINT_EQ_VAR, Op.UINT_GT_VAR, Op.UINT_GTE_VAR, Op.UINT_LT_VAR, Op.UINT_LTE_VAR] as number[];
      const defs = transformAgreementToOnChainParams(counted, undefined, INIT).inputDefs;
      const ops = defs.flatMap((def) => def.conditions.map((condition) => condition.op as number));
      expect(ops.filter((op) => older.includes(op))).toEqual([]);
      for (const def of defs) {
        expect(def.conditions.some((condition) => (condition.op as number) >= Op.UINT_EQ_VAR_OFFSET)).toBe(true);
      }
    });

    it("a variable an input stores first can be compared against, as well as one stored at creation", () => {
      const { currentMilestone: _, ...init } = INIT;
      // `start` gives the milestone its first value and does not check against it.
      const agreement = edited((a) => {
        delete a.execution.initialize.data!.currentMilestone;
        a.execution.inputs.start = {
          type: "VerifiedCredentialEIP712",
          data: { currentMilestone: "${variables.currentMilestone}" },
          issuer: "${variables.reviewer.value}",
          checks: [{ field: "currentMilestone", is: "equalTo", to: 1 }],
          store: ["currentMilestone"],
        };
      });
      expect(() => transformAgreementToOnChainParams(agreement, undefined, init)).not.toThrow();
    });

    it("refuses a variable that has no value at creation when every input that stores it also checks against it", () => {
      const { currentMilestone: _, ...init } = INIT;
      const agreement = edited((a) => { delete a.execution.initialize.data!.currentMilestone; });
      expect(() => transformAgreementToOnChainParams(agreement, undefined, init)).toThrow(
        "variable 'currentMilestone' has no value when the agreement is created, and every input that stores it also checks against it"
      );
    });
  });

  describe("what is refused", () => {
    const base = { field: "milestone", is: "equalTo", to: "${variables.milestoneCount}" };
    it.each([
      ["a comparison name it does not know", { ...base, is: "atLeast" }, "unknown comparison 'atLeast'"],
      ["an inherited comparison name", { ...base, is: "constructor" }, "unknown comparison 'constructor'"],
      ["a key it does not know", { ...base, add: 1 }, "unknown key 'add'"],
      ["a missing 'to'", { field: "milestone", is: "equalTo" }, "needs 'to'"],
      ["a field the input does not have", { ...base, field: "round" }, "'round' is not a field of this input"],
      ["a field that is not a number", { ...base, field: "reviewNote" }, "field 'reviewNote' must be type 'uint256'"],
      ["both plus and minus", { ...base, plus: 1, minus: 1 }, "both 'plus' and 'minus'"],
      ["plus on a constant", { ...base, to: 3, plus: 1 }, "'plus' and 'minus' apply to a stored variable"],
      ["a negative amount", { ...base, plus: -1 }, "'plus' must be a whole number that is not negative"],
      ["a fractional constant", { ...base, to: 1.5 }, "'to' must be a whole number that is not negative"],
      ["arithmetic written into the reference", { ...base, to: "${variables.milestoneCount} + 1" }, "must be exactly one variable reference"],
      ["an unknown variable", { ...base, to: "${variables.missing}" }, "references unknown variable 'missing'"],
      ["a variable that is not a number", { ...base, to: "${variables.reviewNote}" }, "variable 'reviewNote' must be type 'uint256'"],
      ["a variable that is never stored", { ...base, to: "${variables.milestone}" }, "variable 'milestone' is never stored"],
    ])("%s", (_label, check, message) => {
      expect(() => checkConditions([check])).toThrow(message);
    });

    it("an empty list, a value that is not a list, and a check that is not an object", () => {
      expect(() => checkConditions([])).toThrow("'checks' must be a list with at least one check");
      expect(() => checkConditions({ field: "milestone" })).toThrow("'checks' must be a list with at least one check");
      expect(() => checkConditions(["milestone"])).toThrow("must be an object with 'field', 'is' and 'to'");
    });

    it("a check on an optional field, which the contract would skip when the field is left out", () => {
      const agreement = edited((a) => { a.variables.milestone.validation = { required: false }; });
      expect(() => transformAgreementToOnChainParams(agreement, undefined, INIT)).toThrow("field 'milestone' must be required");
    });

    it("a stored field that is optional, missing, or named twice", () => {
      const optional = edited((a) => { a.variables.currentMilestone.validation = { required: false }; });
      expect(() => transformAgreementToOnChainParams(optional, undefined, INIT)).toThrow("stored field 'currentMilestone' must be required");
      const missing = edited((a) => { a.execution.inputs.acceptMilestone.store = ["round"]; });
      expect(() => transformAgreementToOnChainParams(missing, undefined, INIT)).toThrow("'store' names 'round', which is not a field of this input");
      const twice = edited((a) => { a.execution.inputs.acceptMilestone.store = ["currentMilestone", "currentMilestone"]; });
      expect(() => transformAgreementToOnChainParams(twice, undefined, INIT)).toThrow("'store' names a field twice");
    });

    it("an empty 'store' list", () => {
      const empty = edited((a) => { a.execution.inputs.acceptMilestone.store = []; });
      expect(() => transformAgreementToOnChainParams(empty, undefined, INIT)).toThrow("'store' must be a list with at least one of the input's field names");
    });

    it("a stored field of another type than the variable it replaces", () => {
      // A text field keyed like the stored number: once stored, every check on the milestone would fail for good.
      const agreement = edited((a) => {
        a.execution.inputs.requestChanges.data!.currentMilestone = { type: "string" };
        a.execution.inputs.requestChanges.store = ["currentMilestone"];
      });
      expect(() => transformAgreementToOnChainParams(agreement, undefined, INIT)).toThrow(
        "Input 'requestChanges': stored field 'currentMilestone' is not of the type of variable 'currentMilestone' ('uint256')"
      );
    });

    it("two inputs that store one name with different types", () => {
      const agreement = edited((a) => {
        a.execution.inputs.submitWork.data!.tally = { type: "uint256" };
        a.execution.inputs.submitWork.store = ["tally"];
        a.execution.inputs.requestChanges.data!.tally = { type: "string" };
        a.execution.inputs.requestChanges.store = ["tally"];
      });
      expect(() => transformAgreementToOnChainParams(agreement, undefined, INIT)).toThrow(
        "Input 'requestChanges': stored field 'tally' has another type than the field of the same name that input 'submitWork' stores"
      );
    });

    it.each([
      ["an empty value, which would be stored as 0", "currentMilestone", ""],
      ["an empty count", "milestoneCount", ""],
      ["digits with spaces around them", "currentMilestone", " 2 "],
      ["a hexadecimal number", "milestoneCount", "0x10"],
      ["a boolean", "currentMilestone", true],
      ["a negative number", "milestoneCount", -3n],
      ["a fraction", "milestoneCount", "2.5"],
      ["words", "currentMilestone", "one"],
    ])("a starting value that is not a whole number written as one: %s", (_label, name, value) => {
      expect(() => transformAgreementToOnChainParams(counted, undefined, { ...INIT, [name]: value })).toThrow(
        `'${name}', whose value at creation must be a whole number that is not negative`
      );
    });

    it("a starting value as digits, a bigint or a whole number is taken, zero included", () => {
      for (const value of ["0", "1", 1n, 7 as unknown as bigint]) {
        expect(() => transformAgreementToOnChainParams(counted, undefined, { ...INIT, currentMilestone: value })).not.toThrow();
      }
    });

    it("transformInputs called on its own needs the stored variable names for a check against a variable", () => {
      expect(() => transformInputs(counted.execution.inputs, counted.variables)).toThrow("was not told which variables the agreement stores");
      expect(transformInputs(counted.execution.inputs, counted.variables, Object.keys(INIT))).toEqual(
        transformAgreementToOnChainParams(counted, undefined, INIT).inputDefs
      );
    });
  });
});
