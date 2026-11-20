// SPDX-License-Identifier: Apache-2.0
//
// A refused comparison is reported under its own name. Each comparison the
// engine has is failed once and met once, and the ComparisonFailed error is
// checked for the name of the comparison that failed and the type it compared.

import { expect } from "chai";
import { ethers } from "hardhat";

const abi = ethers.AbiCoder.defaultAbiCoder();
const id = (name: string) => ethers.id(name);

// AgreementEngine's public ABI represents these Solidity enums as uint8.
const FieldType = { UINT256: 0, STRING: 1, ADDRESS: 2 } as const;
const TYPE_NAME = { 0: "UINT256", 1: "STRING", 2: "ADDRESS" } as const;
const ENCODING = { 0: "uint256", 1: "string", 2: "address" } as const;

const START = id("START");
const DONE = id("DONE");
const FIELD = id("value");
const STORED = id("stored");
const A = "0x00000000000000000000000000000000000000A1";
const B = "0x00000000000000000000000000000000000000b2";

type Value = bigint | string;
type Case = {
  op: number;
  name: string;
  type: 0 | 1 | 2;
  /** The comparison's argument: a constant, or for a VAR comparison the stored value. */
  against: Value;
  fails: Value;
  meets: Value;
};

// In the order of the engine's Op enum.
const CASES: Case[] = [
  { op: 0, name: "STRING_MIN_LENGTH", type: 1, against: 3n, fails: "ab", meets: "abc" },
  { op: 1, name: "STRING_MAX_LENGTH", type: 1, against: 3n, fails: "abcd", meets: "abc" },
  { op: 2, name: "STRING_EQ_CONST", type: 1, against: "same", fails: "other", meets: "same" },
  { op: 3, name: "STRING_EQ_VAR", type: 1, against: "same", fails: "other", meets: "same" },
  { op: 4, name: "UINT_EQ_CONST", type: 0, against: 5n, fails: 6n, meets: 5n },
  { op: 5, name: "UINT_GT_CONST", type: 0, against: 5n, fails: 5n, meets: 6n },
  { op: 6, name: "UINT_GTE_CONST", type: 0, against: 5n, fails: 4n, meets: 5n },
  { op: 7, name: "UINT_LT_CONST", type: 0, against: 5n, fails: 5n, meets: 4n },
  { op: 8, name: "UINT_LTE_CONST", type: 0, against: 5n, fails: 6n, meets: 5n },
  { op: 9, name: "UINT_EQ_VAR", type: 0, against: 5n, fails: 6n, meets: 5n },
  { op: 10, name: "UINT_GT_VAR", type: 0, against: 5n, fails: 5n, meets: 6n },
  { op: 11, name: "UINT_GTE_VAR", type: 0, against: 5n, fails: 4n, meets: 5n },
  { op: 12, name: "UINT_LT_VAR", type: 0, against: 5n, fails: 5n, meets: 4n },
  { op: 13, name: "UINT_LTE_VAR", type: 0, against: 5n, fails: 6n, meets: 5n },
  { op: 14, name: "ADDRESS_EQ_CONST", type: 2, against: A, fails: B, meets: A },
  { op: 15, name: "ADDRESS_EQ_VAR", type: 2, against: A, fails: B, meets: A },
];

const isVar = (c: Case) => c.name.endsWith("_VAR");
const isLength = (c: Case) => c.name.endsWith("_LENGTH");

describe("AgreementEngine comparison names", function () {
  let implementation: any;
  let factory: any;

  before(async function () {
    implementation = await ethers.deployContract("AgreementEngine");
    factory = await ethers.deployContract("AgreementFactory", [await implementation.getAddress()]);
  });

  async function create(c: Case) {
    // A VAR comparison names the stored variable; the others carry their constant.
    const bytesArg = isVar(c)
      ? abi.encode(["bytes32"], [STORED])
      : abi.encode([isLength(c) ? "uint256" : ENCODING[c.type]], [c.against]);
    const initVars = isVar(c) ? [{ id: STORED, fType: c.type, data: abi.encode([ENCODING[c.type]], [c.against]) }] : [];
    const args = [
      `ipfs://comparison-${c.name}`,
      id(`comparison-${c.name}`),
      START,
      [
        {
          id: id("submit"),
          fields: [{ fieldId: FIELD, fType: c.type, required: true, persist: false }],
          conditions: [{ op: c.op, fieldId: FIELD, bytesArg }],
          verifierKeys: [],
        },
      ],
      [{ fromState: START, toState: DONE, inputId: id("submit") }],
      initVars,
      [],
      [],
    ] as const;
    const address = await factory.createAgreement.staticCall(...args);
    await factory.createAgreement(...args);
    return ethers.getContractAt("AgreementEngine", address) as Promise<any>;
  }

  const payload = (c: Case, value: Value) =>
    abi.encode(
      ["tuple(bytes32 id,uint8 fType,bytes data)[]"],
      [[{ id: FIELD, fType: c.type, data: abi.encode([ENCODING[c.type]], [value]) }]]
    );

  it("covers every comparison the engine has", function () {
    // The Op enum ends with the two sender checks (16, 17), which are not comparisons of a field.
    expect(CASES.map((c) => c.op)).to.deep.equal([...Array(16).keys()]);
  });

  for (const c of CASES) {
    it(`${c.name}: a refusal names ${c.name} and ${TYPE_NAME[c.type]}`, async function () {
      const agreement = await create(c);

      await expect(agreement.submitInput(id("submit"), payload(c, c.fails)))
        .to.be.revertedWithCustomError(implementation, "ComparisonFailed")
        .withArgs(c.name, TYPE_NAME[c.type]);
      expect(await agreement.currentState()).to.equal(START);

      await agreement.submitInput(id("submit"), payload(c, c.meets));
      expect(await agreement.currentState()).to.equal(DONE);
    });
  }
});
