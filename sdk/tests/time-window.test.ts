// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll } from "@jest/globals";
import { encodeAbiParameters, keccak256, stringToHex, Hex } from "viem";
import * as fs from "fs";
import * as path from "path";
import {
  transformAgreementToOnChainParams,
  transformInputs,
  fieldToBytes32,
  inputToBytes32,
} from "../src/transformer";
import { AgreementJson, Op, InputTimeWindow } from "../src/types";

const SUPPLIER = "0x1111111111111111111111111111111111111111";
const BUYER = "0x2222222222222222222222222222222222222222";
const INIT = { supplier: SUPPLIER, buyer: BUYER, dueDate: "1800000000" };

// The engine's BLOCK_TIME_FIELD.
const BLOCK_TIME = keccak256(stringToHex("block.timestamp")) as Hex;
const seconds = (value: bigint | number) => encodeAbiParameters([{ type: "uint256" }], [BigInt(value)]);

describe("time windows on inputs", () => {
  let deliveryDeadline: AgreementJson;

  beforeAll(() => {
    const file = path.resolve(__dirname, "../../agreements/delivery-deadline/unwrapped/delivery-deadline.json");
    deliveryDeadline = JSON.parse(fs.readFileSync(file, "utf-8"));
  });

  /** The example agreement with `time` replaced on its `deliver` input. */
  function withTime(time: unknown, edit: (agreement: AgreementJson) => void = () => {}): AgreementJson {
    const agreement: AgreementJson = JSON.parse(JSON.stringify(deliveryDeadline));
    agreement.execution.inputs.deliver.time = time as InputTimeWindow;
    edit(agreement);
    return agreement;
  }
  const conditionsOf = (agreement: AgreementJson, input: string) =>
    transformAgreementToOnChainParams(agreement, undefined, INIT).inputDefs.find((def) => def.id === inputToBytes32(input))!
      .conditions;
  const timeConditions = (agreement: AgreementJson, input = "deliver") =>
    conditionsOf(agreement, input).filter((condition) => condition.fieldId === BLOCK_TIME);

  describe("a stored date", () => {
    it("'before' becomes block time < the stored variable", () => {
      expect(timeConditions(deliveryDeadline, "deliver")).toEqual([
        { op: Op.UINT_LT_VAR, fieldId: BLOCK_TIME, bytesArg: fieldToBytes32("dueDate") },
      ]);
    });

    it("'notBefore' becomes block time >= the stored variable", () => {
      expect(timeConditions(deliveryDeadline, "declareLate")).toEqual([
        { op: Op.UINT_GTE_VAR, fieldId: BLOCK_TIME, bytesArg: fieldToBytes32("dueDate") },
      ]);
    });

    it("the time conditions follow the field and sender conditions, which are unchanged", () => {
      const withWindow = conditionsOf(deliveryDeadline, "deliver");
      const without = conditionsOf(withTime(undefined), "deliver");
      expect(without.some((condition) => condition.fieldId === BLOCK_TIME)).toBe(false);
      expect(withWindow.slice(0, without.length)).toEqual(without);
      expect(withWindow).toHaveLength(without.length + 1);
      expect(without.map((condition) => condition.op)).toEqual([Op.STRING_MIN_LENGTH, Op.SENDER_EQ_VAR_ADDRESS]);
    });

    it("the variable must exist", () => {
      expect(() => timeConditions(withTime({ before: "${variables.missing}" }))).toThrow(
        "Input 'deliver': time.before references unknown variable 'missing'"
      );
    });

    it("the variable must be a uint256", () => {
      const agreement = withTime({ before: "${variables.dueDate}" }, (a) => {
        a.variables.dueDate.type = "dateTime";
      });
      expect(() => timeConditions(agreement)).toThrow(
        "variable 'dueDate' must be type 'uint256' holding seconds since 1970-01-01 UTC, received 'dateTime'"
      );
    });

    it("the variable must be stored at creation", () => {
      const agreement = withTime({ before: "${variables.dueDate}" }, (a) => {
        delete a.execution.initialize.data!.dueDate;
        a.execution.inputs.declareLate.time = undefined;
      });
      expect(() => transformAgreementToOnChainParams(agreement, undefined, INIT)).toThrow(
        "variable 'dueDate' is not stored when the agreement is created"
      );
    });

    it.each([
      "${variables.dueDate} + 604800",
      "${variables.dueDate - 3600}",
      "min(${variables.dueDate}, ${variables.cutoff})",
      "${variables.dueDate}000",
      "${variables.dueDate",
      "2027-03-01T00:00:00Z or ${variables.dueDate}",
      "${variable.dueDate}",
    ])("refuses %s: a bound is exactly one reference, with nothing around it", (value) => {
      expect(() => timeConditions(withTime({ before: value }))).toThrow("must be exactly one variable reference");
    });

    it("reads the '.value' form of a reference", () => {
      expect(timeConditions(withTime({ before: "${variables.dueDate.value}" }))).toEqual([
        { op: Op.UINT_LT_VAR, fieldId: BLOCK_TIME, bytesArg: fieldToBytes32("dueDate") },
      ]);
    });

    it("refuses the same stored date on both bounds", () => {
      expect(() => timeConditions(withTime({ notBefore: "${variables.dueDate}", before: "${variables.dueDate}" }))).toThrow(
        "name the same variable 'dueDate'"
      );
    });

    it.each([
      ["an empty value", ""],
      ["milliseconds", "1803859200000"],
      ["zero", "0"],
    ])("refuses %s as the stored date's value at creation", (_label, dueDate) => {
      expect(() => transformAgreementToOnChainParams(deliveryDeadline, undefined, { ...INIT, dueDate })).toThrow(
        /time\.(before|notBefore) names 'dueDate', whose value/
      );
    });

    it("transformInputs called on its own needs the stored variable names", () => {
      const { inputs } = deliveryDeadline.execution;
      expect(() => transformInputs(inputs, deliveryDeadline.variables)).toThrow(
        "transformInputs was not told which variables the agreement stores"
      );
      const defs = transformInputs(inputs, deliveryDeadline.variables, ["supplier", "buyer", "dueDate"]);
      expect(defs).toEqual(transformAgreementToOnChainParams(deliveryDeadline, undefined, INIT).inputDefs);
    });
  });

  describe("a fixed moment", () => {
    it("reads seconds given as a number or as digits", () => {
      expect(timeConditions(withTime({ notBefore: 1800000000, before: "1800003600" }))).toEqual([
        { op: Op.UINT_GTE_CONST, fieldId: BLOCK_TIME, bytesArg: seconds(1800000000) },
        { op: Op.UINT_LT_CONST, fieldId: BLOCK_TIME, bytesArg: seconds(1800003600) },
      ]);
    });

    it("reads an ISO 8601 date-time with a zone", () => {
      const expected = [{ op: Op.UINT_LT_CONST, fieldId: BLOCK_TIME, bytesArg: seconds(1803859200) }];
      expect(Date.UTC(2027, 2, 1) / 1000).toBe(1803859200);
      for (const value of ["2027-03-01T00:00:00Z", "2027-03-01T00:00:00.000Z", "2027-03-01T00:00Z", "2027-03-01T02:00:00+02:00"]) {
        expect(timeConditions(withTime({ before: value }))).toEqual(expected);
      }
    });

    it("needs no stored variable, with transformInputs called on its own too", () => {
      const agreement = withTime({ before: "2027-03-01T00:00:00Z" }, (a) => {
        a.execution.inputs.declareLate.time = undefined;
      });
      const defs = transformInputs(agreement.execution.inputs, agreement.variables);
      expect(defs.find((def) => def.id === inputToBytes32("deliver"))!.conditions.at(-1)!.fieldId).toBe(BLOCK_TIME);
    });

    it.each([
      ["a date-time without a zone", "2027-03-01T00:00:00"],
      ["a date without a time", "2027-03-01"],
      ["words", "next quarter"],
      ["a month and day out of range", "2027-13-45T00:00:00Z"],
      ["a lowercase zone", "2027-03-01T00:00:00z"],
    ])("refuses %s", (_label, value) => {
      expect(() => timeConditions(withTime({ before: value }))).toThrow("is not a moment the SDK can read");
    });

    it.each(["2027-02-29T00:00:00Z", "2027-02-30T00:00:00Z", "2027-04-31T12:00:00+02:00", "2027-11-31T00:00:00Z", "2027-03-01T24:00:00Z"])(
      "refuses %s, a date and time that does not exist, where Date.parse would move it",
      (value) => {
        expect(() => timeConditions(withTime({ before: value }))).toThrow("is not a date and time that exists");
      }
    );

    it("accepts the last day of a month and a leap day that exists", () => {
      expect(timeConditions(withTime({ before: "2028-02-29T23:59:59Z" }))[0].bytesArg).toBe(seconds(Date.UTC(2028, 1, 29, 23, 59, 59) / 1000));
      expect(timeConditions(withTime({ before: "2027-04-30T23:30:00-05:00" }))[0].bytesArg).toBe(seconds(Date.UTC(2027, 4, 1, 4, 30, 0) / 1000));
    });

    it.each([
      ["milliseconds given as seconds", 1803859200000],
      ["a date written as digits", "20270301"],
      ["zero", 0],
      ["a date before 2001", "1999-12-31T00:00:00Z"],
    ])("refuses %s", (_label, value) => {
      expect(() => timeConditions(withTime({ before: value }))).toThrow("outside 2001 to 2286");
    });

    it("refuses a fraction of a second, a negative number and a number that is not whole", () => {
      expect(() => timeConditions(withTime({ before: "2027-03-01T00:00:00.500Z" }))).toThrow("fraction of a second");
      expect(() => timeConditions(withTime({ before: "2027-03-01T00:00:00.0001Z" }))).toThrow("fraction of a second");
      expect(() => timeConditions(withTime({ before: -1 }))).toThrow("whole number of seconds");
      expect(() => timeConditions(withTime({ before: 1800000000.5 }))).toThrow("whole number of seconds");
    });

    it("refuses a window that is empty", () => {
      expect(() => timeConditions(withTime({ notBefore: 1800003600, before: 1800003600 }))).toThrow(
        "time.notBefore is not earlier than time.before"
      );
      expect(() => timeConditions(withTime({ notBefore: "2027-03-02T00:00:00Z", before: "2027-03-01T00:00:00Z" }))).toThrow(
        "time.notBefore is not earlier than time.before"
      );
    });
  });

  describe("the shape of the rule", () => {
    it("refuses a bound it does not know, so a misspelling cannot leave a step open", () => {
      expect(() => timeConditions(withTime({ notAfter: 1800000000 }))).toThrow("unknown time bound 'notAfter'");
      for (const key of ["constructor", "toString", "hasOwnProperty"]) {
        expect(() => timeConditions(withTime({ before: 1800000000, [key]: 1 }))).toThrow(`unknown time bound '${key}'`);
      }
      // A bound inherited from a prototype is not in the hashed document, so it is not a bound.
      expect(() => timeConditions(withTime(Object.create({ before: 1800000000 })))).toThrow("'time' needs 'notBefore', 'before' or both");
      expect(() => timeConditions(withTime({ before: 1800000000, until: 1800000000 }))).toThrow("unknown time bound 'until'");
    });

    it("refuses an empty window object and a value that is not an object", () => {
      expect(() => timeConditions(withTime({}))).toThrow("'time' needs 'notBefore', 'before' or both");
      expect(() => timeConditions(withTime("2027-03-01T00:00:00Z"))).toThrow("'time' must be an object");
      expect(() => timeConditions(withTime([1800000000]))).toThrow("'time' must be an object");
    });

    it("an input field cannot take the reserved block-time name", () => {
      const agreement = withTime(undefined, (a) => {
        a.execution.inputs.deliver.data = { "block.timestamp": { type: "uint256" } };
      });
      expect(() => transformAgreementToOnChainParams(agreement, undefined, INIT)).toThrow(
        "'block.timestamp' is reserved for the block time"
      );
    });

    it("the window is part of the document hash", () => {
      const a = transformAgreementToOnChainParams(deliveryDeadline, undefined, INIT);
      const b = transformAgreementToOnChainParams(withTime({ before: 1800000000 }), undefined, INIT);
      expect(a.docHash).not.toBe(b.docHash);
    });
  });
});
