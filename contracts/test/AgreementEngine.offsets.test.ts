// SPDX-License-Identifier: Apache-2.0
//
// Comparisons with a stored value plus or minus a constant (the *_VAR_OFFSET
// codes). They let an agreement count rounds ("the next number is the stored
// one plus one") and put a period on a stored date ("due date + 30 days").

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { SnapshotRestorer } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const abi = ethers.AbiCoder.defaultAbiCoder();
const id = (name: string) => ethers.id(name);
const BLOCK_TIME = id("block.timestamp");
const UINT256 = 0;
const Op = {
  UINT_EQ_CONST: 4,
  UINT_EQ_VAR: 9,
  UINT_LT_VAR: 12,
  SENDER_EQ_VAR_ADDRESS: 16,
  UINT_EQ_VAR_OFFSET: 18,
  UINT_GT_VAR_OFFSET: 19,
  UINT_GTE_VAR_OFFSET: 20,
  UINT_LT_VAR_OFFSET: 21,
  UINT_LTE_VAR_OFFSET: 22,
} as const;

const OPEN = id("OPEN");
const DONE = id("DONE");
const VALUE = id("value");
const STORED = id("stored");
const MINED = { gasLimit: 1_000_000 };
const MAX = 2n ** 256n - 1n;
const INT_MIN = -(2n ** 255n);

const uint = (value: bigint | number) => abi.encode(["uint256"], [value]);
const offsetArg = (variable: string, offset: bigint | number) => abi.encode(["bytes32", "int256"], [variable, offset]);
const payload = (fieldId: string, value: bigint | number) =>
  abi.encode(["tuple(bytes32 id,uint8 fType,bytes data)[]"], [[{ id: fieldId, fType: UINT256, data: uint(value) }]]);
const EMPTY = abi.encode(["tuple(bytes32 id,uint8 fType,bytes data)[]"], [[]]);
const field = (fieldId: string, persist = false) => ({ fieldId, fType: UINT256, required: true, persist });

describe("AgreementEngine comparisons with a stored value and an offset", function () {
  let implementation: any;
  let factory: any;
  let restorer: SnapshotRestorer;
  let n = 0;

  beforeEach(async function () {
    restorer = await takeSnapshot();
    implementation = await ethers.deployContract("AgreementEngine");
    factory = await ethers.deployContract("AgreementFactory", [await implementation.getAddress()]);
  });
  afterEach(async function () {
    await restorer.restore();
  });

  async function create(inputDefs: object[], transitions: object[], initVars: object[]) {
    const args = [`ipfs://offset-${++n}`, id(`offset-${n}`), OPEN, inputDefs, transitions, initVars, [], []] as const;
    const address = await factory.createAgreement.staticCall(...args);
    await factory.createAgreement(...args);
    return ethers.getContractAt("AgreementEngine", address) as Promise<any>;
  }
  /** One input `submit` with one condition on its field, against `stored`. */
  const single = (op: number, storedValue: bigint | number, offset: bigint | number) =>
    create(
      [{ id: id("submit"), fields: [field(VALUE)], conditions: [{ op, fieldId: VALUE, bytesArg: offsetArg(STORED, offset) }], verifierKeys: [] }],
      [{ fromState: OPEN, toState: OPEN, inputId: id("submit") }],
      [{ id: STORED, fType: UINT256, data: uint(storedValue) }]
    );

  describe("each comparison turns at stored plus offset", function () {
    // stored 100. With offset +5 the comparison is against 105, with -5 against 95.
    // `fails` and `meets` sit on the two sides of the turning point. Every value on each side is tried:
    // the far ones tell an inequality from an equality, and a comparison from its mirror image.
    const CASES: Array<[string, number, (target: bigint) => { fails: bigint[]; meets: bigint[] }]> = [
      ["UINT_EQ_VAR_OFFSET", Op.UINT_EQ_VAR_OFFSET, (t) => ({ fails: [t - 1n, t + 1n], meets: [t] })],
      ["UINT_GT_VAR_OFFSET", Op.UINT_GT_VAR_OFFSET, (t) => ({ fails: [t, t - 1n, 0n], meets: [t + 1n, t + 50n] })],
      ["UINT_GTE_VAR_OFFSET", Op.UINT_GTE_VAR_OFFSET, (t) => ({ fails: [t - 1n, 0n], meets: [t, t + 1n, t + 50n] })],
      ["UINT_LT_VAR_OFFSET", Op.UINT_LT_VAR_OFFSET, (t) => ({ fails: [t, t + 1n, t + 50n], meets: [t - 1n, 0n] })],
      ["UINT_LTE_VAR_OFFSET", Op.UINT_LTE_VAR_OFFSET, (t) => ({ fails: [t + 1n, t + 50n], meets: [t, t - 1n, 0n] })],
    ];
    for (const [name, op, at] of CASES) {
      for (const offset of [5n, -5n, 0n]) {
        it(`${name} with offset ${offset}`, async function () {
          const agreement = await single(op, 100n, offset);
          const { fails, meets } = at(100n + offset);
          for (const value of fails) {
            await expect(agreement.submitInput(id("submit"), payload(VALUE, value)), `${value} is refused`)
              .to.be.revertedWithCustomError(implementation, "ComparisonFailed")
              .withArgs(name, "UINT256");
          }
          for (const value of meets) {
            await expect(agreement.submitInput(id("submit"), payload(VALUE, value)), `${value} is accepted`).to.emit(agreement, "InputAccepted");
          }
        });
      }
    }

    it("an offset of any size is applied exactly", async function () {
      const BIG = 2n ** 200n;
      for (const [storedValue, offset] of [[7n, BIG], [BIG + 7n, -BIG], [1n, 2n ** 255n - 1n], [MAX, -(2n ** 255n - 1n)]] as const) {
        const target = storedValue + offset;
        const agreement = await single(Op.UINT_EQ_VAR_OFFSET, storedValue, offset);
        for (const wrong of [target - 1n, target + 1n, storedValue]) {
          await expect(agreement.submitInput(id("submit"), payload(VALUE, wrong)), `${wrong} against ${storedValue} offset ${offset}`)
            .to.be.revertedWithCustomError(implementation, "ComparisonFailed")
            .withArgs("UINT_EQ_VAR_OFFSET", "UINT256");
        }
        await expect(agreement.submitInput(id("submit"), payload(VALUE, target))).to.emit(agreement, "InputAccepted");
      }
    });
  });

  it("a comparison code past the last one the engine has is refused when the agreement is created", async function () {
    // An engine from before the offset codes refuses them for the same reason: the code is outside its list.
    const definition = (op: number) =>
      [
        "ipfs://unknown-code",
        id(`unknown-code-${op}`),
        OPEN,
        [{ id: id("submit"), fields: [field(VALUE)], conditions: [{ op, fieldId: VALUE, bytesArg: offsetArg(STORED, 0) }], verifierKeys: [] }],
        [{ fromState: OPEN, toState: OPEN, inputId: id("submit") }],
        [{ id: STORED, fType: UINT256, data: uint(1n) }],
        [],
        [],
      ] as const;
    // Sent as raw calldata, since the typed binding would refuse an unknown code before the call.
    const send = async (op: number) => {
      const [sender] = await ethers.getSigners();
      const known = factory.interface.encodeFunctionData("createAgreement", definition(Op.UINT_LTE_VAR_OFFSET));
      const marker = abi.encode(["uint8"], [Op.UINT_LTE_VAR_OFFSET]);
      const at = known.indexOf(marker.slice(2));
      expect(at, "the code appears once in the calldata").to.be.greaterThan(0);
      expect(known.indexOf(marker.slice(2), at + 1)).to.equal(-1);
      const data = known.slice(0, at) + abi.encode(["uint8"], [op]).slice(2) + known.slice(at + 64);
      return sender.sendTransaction({ to: await factory.getAddress(), data, ...MINED });
    };
    await expect(send(Op.UINT_LTE_VAR_OFFSET)).to.emit(factory, "AgreementDeployed");
    await expect(send(Op.UINT_LTE_VAR_OFFSET + 1)).to.be.reverted;
    await expect(send(255)).to.be.reverted;
  });

  describe("an offset that leaves the uint256 range refuses the input", function () {
    it("below zero", async function () {
      const agreement = await single(Op.UINT_GTE_VAR_OFFSET, 3n, -4n);
      await expect(agreement.submitInput(id("submit"), payload(VALUE, 7n)))
        .to.be.revertedWithCustomError(implementation, "OffsetOutOfRange")
        .withArgs(STORED, 3n, -4n);
      // Down to zero exactly is in range.
      const atZero = await single(Op.UINT_EQ_VAR_OFFSET, 3n, -3n);
      await expect(atZero.submitInput(id("submit"), payload(VALUE, 0n))).to.emit(atZero, "InputAccepted");
    });

    it("above the largest uint256", async function () {
      const agreement = await single(Op.UINT_LTE_VAR_OFFSET, MAX, 1n);
      await expect(agreement.submitInput(id("submit"), payload(VALUE, 7n)))
        .to.be.revertedWithCustomError(implementation, "OffsetOutOfRange")
        .withArgs(STORED, MAX, 1n);
      const atMax = await single(Op.UINT_EQ_VAR_OFFSET, MAX - 1n, 1n);
      await expect(atMax.submitInput(id("submit"), payload(VALUE, MAX))).to.emit(atMax, "InputAccepted");
    });

    it("the most negative offset there is", async function () {
      const agreement = await single(Op.UINT_EQ_VAR_OFFSET, 2n ** 255n, INT_MIN);
      await expect(agreement.submitInput(id("submit"), payload(VALUE, 0n))).to.emit(agreement, "InputAccepted");
      const below = await single(Op.UINT_EQ_VAR_OFFSET, 2n ** 255n - 1n, INT_MIN);
      await expect(below.submitInput(id("submit"), payload(VALUE, 0n))).to.be.revertedWithCustomError(implementation, "OffsetOutOfRange");
    });
  });

  it("the stored value must be set and be a number", async function () {
    const condition = { op: Op.UINT_EQ_VAR_OFFSET, fieldId: VALUE, bytesArg: offsetArg(STORED, 1) };
    const inputDefs = [{ id: id("submit"), fields: [field(VALUE)], conditions: [condition], verifierKeys: [] }];
    const transitions = [{ fromState: OPEN, toState: DONE, inputId: id("submit") }];
    const unset = await create(inputDefs, transitions, []);
    await expect(unset.submitInput(id("submit"), payload(VALUE, 1n))).to.be.revertedWithCustomError(implementation, "VarNotSet").withArgs(STORED);
    const [someone] = await ethers.getSigners();
    const wrongType = await create(inputDefs, transitions, [{ id: STORED, fType: 2, data: abi.encode(["address"], [someone.address]) }]);
    await expect(wrongType.submitInput(id("submit"), payload(VALUE, 1n)))
      .to.be.revertedWithCustomError(implementation, "TypeMismatch")
      .withArgs("UINT256", "ADDRESS");
  });

  it("the plain *_VAR codes still ignore anything after the variable id", async function () {
    // An agreement written for the offset codes cannot be mistaken for this: the codes differ.
    const agreement = await create(
      [{ id: id("submit"), fields: [field(VALUE)], conditions: [{ op: Op.UINT_EQ_VAR, fieldId: VALUE, bytesArg: offsetArg(STORED, 5) }], verifierKeys: [] }],
      [{ fromState: OPEN, toState: DONE, inputId: id("submit") }],
      [{ id: STORED, fType: UINT256, data: uint(100n) }]
    );
    await expect(agreement.submitInput(id("submit"), payload(VALUE, 105n))).to.be.revertedWithCustomError(implementation, "ComparisonFailed");
    await expect(agreement.submitInput(id("submit"), payload(VALUE, 100n))).to.emit(agreement, "InputAccepted");
  });

  describe("counting rounds", function () {
    const ROUND = id("round");
    const TOTAL = id("total");
    // `next` moves the stored round on by exactly one while rounds remain; `last` ends at the total.
    const counted = (total: number) =>
      create(
        [
          {
            id: id("next"),
            fields: [field(ROUND, true)],
            conditions: [
              { op: Op.UINT_EQ_VAR_OFFSET, fieldId: ROUND, bytesArg: offsetArg(ROUND, 1) },
              { op: Op.UINT_LT_VAR, fieldId: ROUND, bytesArg: abi.encode(["bytes32"], [TOTAL]) },
            ],
            verifierKeys: [],
          },
          {
            id: id("last"),
            fields: [field(ROUND, true)],
            conditions: [
              { op: Op.UINT_EQ_VAR_OFFSET, fieldId: ROUND, bytesArg: offsetArg(ROUND, 1) },
              { op: Op.UINT_EQ_VAR, fieldId: ROUND, bytesArg: abi.encode(["bytes32"], [TOTAL]) },
            ],
            verifierKeys: [],
          },
        ],
        [
          { fromState: OPEN, toState: OPEN, inputId: id("next") },
          { fromState: OPEN, toState: DONE, inputId: id("last") },
        ],
        [
          { id: ROUND, fType: UINT256, data: uint(0) },
          { id: TOTAL, fType: UINT256, data: uint(total) },
        ]
      );

    for (const total of [1, 2, 5]) {
      it(`${total} round(s): each round is accepted once, in order, and only the last one ends`, async function () {
        const agreement = await counted(total);
        for (let round = 1; round <= total; round++) {
          const last = round === total;
          // A skipped, repeated or earlier round is refused, and so is the wrong kind of step.
          for (const wrong of [round - 1, round + 1, total + 1]) {
            if (wrong === round) continue;
            await expect(agreement.submitInput(id(last ? "last" : "next"), payload(ROUND, wrong)))
              .to.be.revertedWithCustomError(implementation, "ComparisonFailed")
              .withArgs("UINT_EQ_VAR_OFFSET", "UINT256");
          }
          await expect(agreement.submitInput(id(last ? "next" : "last"), payload(ROUND, round))).to.be.revertedWithCustomError(
            implementation,
            "ComparisonFailed"
          );
          await agreement.submitInput(id(last ? "last" : "next"), payload(ROUND, round));
          expect(await agreement.currentState()).to.equal(last ? DONE : OPEN);
        }
      });
    }

    it("a permit that names a round is refused once that round has passed, and a permit for the current round moves it on", async function () {
      const [party, relayer] = await ethers.getSigners();
      const agreement = await counted(3);
      const deadline = (await time.latest()) + 3600;
      const sign = async (body: string) =>
        party.signTypedData(
          { name: "AgreementEngine", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await agreement.getAddress() },
          {
            PermitInput: [
              { name: "signer", type: "address" },
              { name: "inputId", type: "bytes32" },
              { name: "payload", type: "bytes" },
              { name: "nonce", type: "uint256" },
              { name: "deadline", type: "uint256" },
            ],
          },
          { signer: party.address, inputId: id("next"), payload: body, nonce: 0n, deadline }
        );
      const stale = payload(ROUND, 1);
      const staleSignature = await sign(stale);
      // Someone else completes round 1 directly; the permit for round 1 is now for a past round.
      await agreement.connect(relayer).submitInput(id("next"), payload(ROUND, 1));
      await expect(agreement.connect(relayer).submitInputWithPermit(party.address, id("next"), stale, deadline, staleSignature))
        .to.be.revertedWithCustomError(implementation, "ComparisonFailed")
        .withArgs("UINT_EQ_VAR_OFFSET", "UINT256");

      // A permit for round 2, at the same nonce, is accepted: on the permit path too the round is
      // compared with the value stored before the input, and stored afterwards.
      const current = payload(ROUND, 2);
      await expect(agreement.connect(relayer).submitInputWithPermit(party.address, id("next"), current, deadline, await sign(current))).to.emit(
        agreement,
        "InputAccepted"
      );
      await agreement.connect(relayer).submitInput(id("last"), payload(ROUND, 3));
      expect(await agreement.currentState()).to.equal(DONE);
    });
  });

  describe("a period on a stored date", function () {
    it("'before the due date plus 30 days' and 'not before' it turn at that second", async function () {
      const now = await time.latest();
      const dueDate = now + 100;
      const GRACE = 30 * 24 * 60 * 60;
      const at = (op: number) => ({ op, fieldId: BLOCK_TIME, bytesArg: offsetArg(id("dueDate"), GRACE) });
      const agreement = await create(
        [
          { id: id("deliverLate"), fields: [], conditions: [at(Op.UINT_LT_VAR_OFFSET)], verifierKeys: [] },
          { id: id("terminate"), fields: [], conditions: [at(Op.UINT_GTE_VAR_OFFSET)], verifierKeys: [] },
        ],
        [
          { fromState: OPEN, toState: OPEN, inputId: id("deliverLate") },
          { fromState: OPEN, toState: DONE, inputId: id("terminate") },
        ],
        [{ id: id("dueDate"), fType: UINT256, data: uint(dueDate) }]
      );
      const submitAt = async (when: number, name: string) => {
        await time.setNextBlockTimestamp(when);
        return agreement.submitInput(id(name), EMPTY, MINED);
      };
      const end = dueDate + GRACE;
      await expect(submitAt(end - 2, "terminate"))
        .to.be.revertedWithCustomError(implementation, "ComparisonFailed")
        .withArgs("UINT_GTE_VAR_OFFSET", "UINT256");
      await expect(submitAt(end - 1, "deliverLate")).to.emit(agreement, "InputAccepted");
      await expect(submitAt(end, "deliverLate"))
        .to.be.revertedWithCustomError(implementation, "ComparisonFailed")
        .withArgs("UINT_LT_VAR_OFFSET", "UINT256");
      await expect(submitAt(end + 1, "terminate")).to.emit(agreement, "InputAccepted");
    });

    it("a negative period: 'not before three days ahead of the stored date'", async function () {
      const now = await time.latest();
      const THREE_DAYS = 3 * 24 * 60 * 60;
      const date = now + THREE_DAYS + 100;
      const agreement = await create(
        [{ id: id("remind"), fields: [], conditions: [{ op: Op.UINT_GTE_VAR_OFFSET, fieldId: BLOCK_TIME, bytesArg: offsetArg(id("date"), -THREE_DAYS) }], verifierKeys: [] }],
        [{ fromState: OPEN, toState: DONE, inputId: id("remind") }],
        [{ id: id("date"), fType: UINT256, data: uint(date) }]
      );
      await time.setNextBlockTimestamp(date - THREE_DAYS - 1);
      await expect(agreement.submitInput(id("remind"), EMPTY, MINED)).to.be.revertedWithCustomError(implementation, "ComparisonFailed");
      await time.setNextBlockTimestamp(date - THREE_DAYS);
      await expect(agreement.submitInput(id("remind"), EMPTY, MINED)).to.emit(agreement, "InputAccepted");
    });
  });
});
