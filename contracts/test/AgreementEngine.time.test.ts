// SPDX-License-Identifier: Apache-2.0
//
// Time conditions. A condition whose field id is the reserved block-time id
// compares the block time, in seconds, where it would otherwise compare a
// submitted field. These tests fix the exact second at which each comparison
// turns, on both submission paths, and the name a refusal reports.

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time, takeSnapshot } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { SnapshotRestorer } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const abi = ethers.AbiCoder.defaultAbiCoder();
const id = (name: string) => ethers.id(name);

// keccak256("block.timestamp"), the engine's BLOCK_TIME_FIELD.
const BLOCK_TIME = id("block.timestamp");

// AgreementEngine's public ABI represents these Solidity enums as uint8.
const FieldType = { UINT256: 0, STRING: 1, ADDRESS: 2 } as const;
const Op = {
  STRING_EQ_CONST: 2,
  UINT_EQ_CONST: 4,
  UINT_GT_CONST: 5,
  UINT_GTE_CONST: 6,
  UINT_LT_CONST: 7,
  UINT_LTE_CONST: 8,
  UINT_GTE_VAR: 11,
  UINT_LT_VAR: 12,
  ADDRESS_EQ_CONST: 14,
  SENDER_EQ_VAR_ADDRESS: 16,
} as const;

type Condition = { op: number; fieldId: string; bytesArg: string };
type FieldDef = { fieldId: string; fType: number; required: boolean; persist: boolean };
type InputDef = { id: string; fields: FieldDef[]; conditions: Condition[]; verifierKeys: string[] };
type DataField = { id: string; fType: number; data: string };

const OPEN = id("OPEN");
const DONE = id("DONE");
const EMPTY = abi.encode(["tuple(bytes32 id,uint8 fType,bytes data)[]"], [[]]);
// A reverting transaction is still mined, so the block carries the timestamp the test set.
const MINED = { gasLimit: 1_000_000 };

const uint = (value: bigint | number) => abi.encode(["uint256"], [value]);
const payload = (fields: DataField[]) => abi.encode(["tuple(bytes32 id,uint8 fType,bytes data)[]"], [fields]);
const numberField = (name: string, value: bigint | number): DataField => ({ id: id(name), fType: FieldType.UINT256, data: uint(value) });

/** The block time against a fixed moment. */
const atFixedMoment = (op: number, moment: number): Condition => ({ op, fieldId: BLOCK_TIME, bytesArg: uint(moment) });
/** The block time against a stored UINT256 variable. */
const atStoredMoment = (op: number, variable: string): Condition => ({
  op,
  fieldId: BLOCK_TIME,
  bytesArg: abi.encode(["bytes32"], [id(variable)]),
});
const input = (name: string, conditions: Condition[], fields: FieldDef[] = []): InputDef => ({
  id: id(name),
  fields,
  conditions,
  verifierKeys: [],
});
/** Every listed input keeps the agreement in OPEN, so it can be tried at several moments. */
const stayOpen = (...names: string[]) => names.map((name) => ({ fromState: OPEN, toState: OPEN, inputId: id(name) }));

describe("AgreementEngine time conditions", function () {
  let restorer: SnapshotRestorer;
  let party: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let relayer: HardhatEthersSigner;
  let implementation: any;
  let factory: any;
  let now: number;

  // The tests move the chain clock. Each one starts from the same snapshot and
  // leaves the clock where it found it for the rest of the suite.
  beforeEach(async function () {
    restorer = await takeSnapshot();
    [party, other, relayer] = await ethers.getSigners();
    implementation = await ethers.deployContract("AgreementEngine");
    factory = await ethers.deployContract("AgreementFactory", [await implementation.getAddress()]);
    now = await time.latest();
  });

  afterEach(async function () {
    await restorer.restore();
  });

  async function create(inputDefs: InputDef[], transitions: object[], initVars: DataField[] = []) {
    const args = ["ipfs://time", id("time"), OPEN, inputDefs, transitions, initVars, [], []] as const;
    const address = await factory.createAgreement.staticCall(...args);
    await factory.createAgreement(...args);
    return ethers.getContractAt("AgreementEngine", address) as Promise<any>;
  }

  /** Send `name` in a block stamped `at`. */
  async function submitAt(agreement: any, at: number, name: string, body: string = EMPTY, from = party) {
    await time.setNextBlockTimestamp(at);
    return agreement.connect(from).submitInput(id(name), body, MINED);
  }

  async function signPermit(agreement: any, signer: HardhatEthersSigner, name: string, body: string, deadline: number) {
    const signature = await signer.signTypedData(
      {
        name: "AgreementEngine",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await agreement.getAddress(),
      },
      {
        PermitInput: [
          { name: "signer", type: "address" },
          { name: "inputId", type: "bytes32" },
          { name: "payload", type: "bytes" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { signer: signer.address, inputId: id(name), payload: body, nonce: await agreement.nonces(signer.address), deadline }
    );
    return (at: number) =>
      time
        .setNextBlockTimestamp(at)
        .then(() => agreement.connect(relayer).submitInputWithPermit(signer.address, id(name), body, deadline, signature, MINED));
  }

  describe("against a fixed moment", function () {
    it("'not before' refuses the second before the moment and accepts from the moment on", async function () {
      const opensAt = now + 100;
      const agreement = await create([input("start", [atFixedMoment(Op.UINT_GTE_CONST, opensAt)])], stayOpen("start"));

      await expect(submitAt(agreement, opensAt - 1, "start"))
        .to.be.revertedWithCustomError(implementation, "ComparisonFailed")
        .withArgs("UINT_GTE_CONST", "UINT256");
      expect(await agreement.nonces(party.address)).to.equal(0n);

      await expect(submitAt(agreement, opensAt, "start")).to.emit(agreement, "InputAccepted");
      await expect(submitAt(agreement, opensAt + 1, "start")).to.emit(agreement, "InputAccepted");
      expect(await agreement.nonces(party.address)).to.equal(2n);
    });

    it("'before' accepts up to the second before the moment and refuses from the moment on", async function () {
      const closesAt = now + 100;
      const agreement = await create([input("file", [atFixedMoment(Op.UINT_LT_CONST, closesAt)])], stayOpen("file"));

      await expect(submitAt(agreement, closesAt - 1, "file")).to.emit(agreement, "InputAccepted");
      await expect(submitAt(agreement, closesAt, "file"))
        .to.be.revertedWithCustomError(implementation, "ComparisonFailed")
        .withArgs("UINT_LT_CONST", "UINT256");
      await expect(submitAt(agreement, closesAt + 1, "file")).to.be.revertedWithCustomError(implementation, "ComparisonFailed");
      expect(await agreement.nonces(party.address)).to.equal(1n);
    });

    it("'not before' and 'before' the same moment split time with no gap and no overlap", async function () {
      const moment = now + 100;
      const agreement = await create(
        [input("early", [atFixedMoment(Op.UINT_LT_CONST, moment)]), input("late", [atFixedMoment(Op.UINT_GTE_CONST, moment)])],
        stayOpen("early", "late")
      );

      await expect(submitAt(agreement, moment - 2, "late")).to.be.revertedWithCustomError(implementation, "ComparisonFailed");
      await expect(submitAt(agreement, moment - 1, "early")).to.emit(agreement, "InputAccepted");
      await expect(submitAt(agreement, moment, "early")).to.be.revertedWithCustomError(implementation, "ComparisonFailed");
      await expect(submitAt(agreement, moment + 1, "late")).to.emit(agreement, "InputAccepted");
    });

    it("in one block at the moment itself, 'before' is refused and 'not before' is accepted; one second earlier, the reverse", async function () {
      const moment = now + 100;
      const agreement = await create(
        [input("early", [atFixedMoment(Op.UINT_LT_CONST, moment)]), input("late", [atFixedMoment(Op.UINT_GTE_CONST, moment)])],
        stayOpen("early", "late")
      );
      // Both inputs are mined in the same block, so they see the same second.
      const bothAt = async (at: number) => {
        await network.provider.send("evm_setAutomine", [false]);
        try {
          const early = await agreement.connect(party).submitInput(id("early"), EMPTY, MINED);
          const late = await agreement.connect(other).submitInput(id("late"), EMPTY, MINED);
          await time.setNextBlockTimestamp(at);
          await network.provider.send("evm_mine");
          const [earlyReceipt, lateReceipt] = await Promise.all([early.hash, late.hash].map((hash) => ethers.provider.getTransactionReceipt(hash)));
          expect(earlyReceipt!.blockNumber).to.equal(lateReceipt!.blockNumber);
          expect((await ethers.provider.getBlock(earlyReceipt!.blockNumber))!.timestamp).to.equal(at);
          return { early: earlyReceipt!.status === 1, late: lateReceipt!.status === 1 };
        } finally {
          await network.provider.send("evm_setAutomine", [true]);
        }
      };

      expect(await bothAt(moment - 1)).to.deep.equal({ early: true, late: false });
      expect(await bothAt(moment)).to.deep.equal({ early: false, late: true });
    });

    it("the other number comparisons turn at the second they name", async function () {
      const moment = now + 100;
      const agreement = await create(
        [
          input("after", [atFixedMoment(Op.UINT_GT_CONST, moment)]),
          input("upTo", [atFixedMoment(Op.UINT_LTE_CONST, moment)]),
          input("exactly", [atFixedMoment(Op.UINT_EQ_CONST, moment + 2)]),
        ],
        stayOpen("after", "upTo", "exactly")
      );

      await expect(submitAt(agreement, moment, "after")).to.be.revertedWithCustomError(implementation, "ComparisonFailed");
      await expect(submitAt(agreement, moment + 1, "exactly")).to.be.revertedWithCustomError(implementation, "ComparisonFailed");
      await expect(submitAt(agreement, moment + 2, "exactly")).to.emit(agreement, "InputAccepted");
      await expect(submitAt(agreement, moment + 3, "after")).to.emit(agreement, "InputAccepted");
      await expect(submitAt(agreement, moment + 4, "upTo")).to.be.revertedWithCustomError(implementation, "ComparisonFailed");

      const second = await create([input("upTo", [atFixedMoment(Op.UINT_LTE_CONST, moment + 10)])], stayOpen("upTo"));
      await expect(submitAt(second, moment + 10, "upTo")).to.emit(second, "InputAccepted");
      await expect(submitAt(second, moment + 11, "upTo")).to.be.revertedWithCustomError(implementation, "ComparisonFailed");
    });
  });

  describe("against a stored date", function () {
    it("a report is accepted before the stored due date, and 'overdue' from the due date on", async function () {
      const dueDate = now + 100;
      const agreement = await create(
        [
          input("submitReport", [atStoredMoment(Op.UINT_LT_VAR, "dueDate")]),
          input("declareOverdue", [atStoredMoment(Op.UINT_GTE_VAR, "dueDate")]),
        ],
        [
          { fromState: OPEN, toState: OPEN, inputId: id("submitReport") },
          { fromState: OPEN, toState: DONE, inputId: id("declareOverdue") },
        ],
        [numberField("dueDate", dueDate)]
      );

      await expect(submitAt(agreement, dueDate - 2, "declareOverdue"))
        .to.be.revertedWithCustomError(implementation, "ComparisonFailed")
        .withArgs("UINT_GTE_VAR", "UINT256");
      await expect(submitAt(agreement, dueDate - 1, "submitReport")).to.emit(agreement, "InputAccepted");
      await expect(submitAt(agreement, dueDate, "submitReport"))
        .to.be.revertedWithCustomError(implementation, "ComparisonFailed")
        .withArgs("UINT_LT_VAR", "UINT256");
      expect(await agreement.currentState()).to.equal(OPEN);

      await expect(submitAt(agreement, dueDate + 1, "declareOverdue")).to.emit(agreement, "InputAccepted");
      expect(await agreement.currentState()).to.equal(DONE);
    });

    it("the date may be stored by an earlier input", async function () {
      const dueDate = now + 100;
      const agreement = await create(
        [
          input("agreeDate", [], [{ fieldId: id("dueDate"), fType: FieldType.UINT256, required: true, persist: true }]),
          input("deliver", [atStoredMoment(Op.UINT_LT_VAR, "dueDate")]),
        ],
        stayOpen("agreeDate", "deliver")
      );

      // Nothing is stored yet, so the condition cannot be met.
      await expect(submitAt(agreement, now + 10, "deliver"))
        .to.be.revertedWithCustomError(implementation, "VarNotSet")
        .withArgs(id("dueDate"));

      await submitAt(agreement, now + 20, "agreeDate", payload([numberField("dueDate", dueDate)]));
      await expect(submitAt(agreement, dueDate - 1, "deliver")).to.emit(agreement, "InputAccepted");
      await expect(submitAt(agreement, dueDate, "deliver")).to.be.revertedWithCustomError(implementation, "ComparisonFailed");

      // A later date reopens the step: the condition reads the stored value each time.
      await submitAt(agreement, dueDate + 1, "agreeDate", payload([numberField("dueDate", dueDate + 50)]));
      await expect(submitAt(agreement, dueDate + 2, "deliver")).to.emit(agreement, "InputAccepted");
    });

    it("a stored value that is not a number refuses the input", async function () {
      const agreement = await create(
        [input("deliver", [atStoredMoment(Op.UINT_LT_VAR, "dueDate")])],
        stayOpen("deliver"),
        [{ id: id("dueDate"), fType: FieldType.ADDRESS, data: abi.encode(["address"], [other.address]) }]
      );
      await expect(submitAt(agreement, now + 10, "deliver"))
        .to.be.revertedWithCustomError(implementation, "TypeMismatch")
        .withArgs("UINT256", "ADDRESS");
    });
  });

  describe("permits", function () {
    it("the time is read when the permit is submitted, not when it is signed", async function () {
      const closesAt = now + 100;
      const agreement = await create([input("file", [atFixedMoment(Op.UINT_LT_CONST, closesAt)])], stayOpen("file"));

      // Signed inside the window, with a permit deadline well past it.
      const submit = await signPermit(agreement, party, "file", EMPTY, closesAt + 3600);

      await expect(submit(closesAt)).to.be.revertedWithCustomError(implementation, "ComparisonFailed");
      // The refusal consumed nothing: the permit and its nonce are as they were.
      expect(await agreement.nonces(party.address)).to.equal(0n);
      await expect(submit(closesAt + 1)).to.be.revertedWithCustomError(implementation, "ComparisonFailed");
    });

    it("a permit submitted inside the window is accepted, and one signed before the window opens waits for it", async function () {
      const opensAt = now + 100;
      const agreement = await create([input("start", [atFixedMoment(Op.UINT_GTE_CONST, opensAt)])], stayOpen("start"));
      const submit = await signPermit(agreement, party, "start", EMPTY, opensAt + 3600);

      await expect(submit(opensAt - 1)).to.be.revertedWithCustomError(implementation, "ComparisonFailed");
      await expect(submit(opensAt)).to.emit(agreement, "InputSubmittedWithPermit").withArgs(party.address, relayer.address, id("start"));
      expect(await agreement.nonces(party.address)).to.equal(1n);
    });
  });

  describe("beside other conditions", function () {
    it("a time condition, a sender condition and a field condition must all hold", async function () {
      const closesAt = now + 100;
      const amount = { fieldId: id("amount"), fType: FieldType.UINT256, required: true, persist: false };
      const agreement = await create(
        [
          input(
            "claim",
            [
              { op: Op.SENDER_EQ_VAR_ADDRESS, fieldId: id("claimant"), bytesArg: "0x" },
              atFixedMoment(Op.UINT_LT_CONST, closesAt),
              { op: Op.UINT_GT_CONST, fieldId: id("amount"), bytesArg: uint(0) },
            ],
            [amount]
          ),
        ],
        stayOpen("claim"),
        [{ id: id("claimant"), fType: FieldType.ADDRESS, data: abi.encode(["address"], [party.address]) }]
      );
      const claim = (value: number) => payload([numberField("amount", value)]);

      await expect(submitAt(agreement, now + 10, "claim", claim(5), other))
        .to.be.revertedWithCustomError(implementation, "SenderAddressMismatch")
        .withArgs(other.address, party.address);
      await expect(submitAt(agreement, now + 11, "claim", claim(0))).to.be.revertedWithCustomError(implementation, "ComparisonFailed");
      await expect(submitAt(agreement, now + 12, "claim", claim(5))).to.emit(agreement, "InputAccepted");
      await expect(submitAt(agreement, closesAt, "claim", claim(5))).to.be.revertedWithCustomError(implementation, "ComparisonFailed");
    });

    it("a comparison that is not a number comparison cannot be met on the block time", async function () {
      const agreement = await create(
        [
          input("asText", [{ op: Op.STRING_EQ_CONST, fieldId: BLOCK_TIME, bytesArg: abi.encode(["string"], ["now"]) }]),
          input("asAddress", [{ op: Op.ADDRESS_EQ_CONST, fieldId: BLOCK_TIME, bytesArg: abi.encode(["address"], [party.address]) }]),
        ],
        stayOpen("asText", "asAddress")
      );
      await expect(submitAt(agreement, now + 10, "asText"))
        .to.be.revertedWithCustomError(implementation, "TypeMismatch")
        .withArgs("STRING", "UINT256");
      await expect(submitAt(agreement, now + 11, "asAddress"))
        .to.be.revertedWithCustomError(implementation, "TypeMismatch")
        .withArgs("ADDRESS", "UINT256");
    });
  });

  describe("the reserved id", function () {
    const create8 = (inputDefs: InputDef[], initVars: DataField[]) =>
      factory.createAgreement("ipfs://reserved", id("reserved"), OPEN, inputDefs, stayOpen("go"), initVars, [], []);

    it("cannot be declared as an input field", async function () {
      const field = { fieldId: BLOCK_TIME, fType: FieldType.UINT256, required: true, persist: false };
      await expect(create8([input("go", [], [field])], []))
        .to.be.revertedWithCustomError(implementation, "ReservedFieldId")
        .withArgs(BLOCK_TIME);
    });

    it("cannot be a stored variable", async function () {
      await expect(create8([input("go", [])], [{ id: BLOCK_TIME, fType: FieldType.UINT256, data: uint(now) }]))
        .to.be.revertedWithCustomError(implementation, "ReservedFieldId")
        .withArgs(BLOCK_TIME);
    });

    it("a submitted field with the reserved id does not stand in for the block time", async function () {
      const opensAt = now + 100;
      const agreement = await create([input("start", [atFixedMoment(Op.UINT_GTE_CONST, opensAt)])], stayOpen("start"));
      // The submitter claims a time past the opening. The condition reads the block.
      const claimed = payload([{ id: BLOCK_TIME, fType: FieldType.UINT256, data: uint(opensAt + 1000) }]);
      await expect(submitAt(agreement, opensAt - 1, "start", claimed)).to.be.revertedWithCustomError(implementation, "ComparisonFailed");
      await expect(submitAt(agreement, opensAt, "start", claimed)).to.emit(agreement, "InputAccepted");
    });
  });
});
