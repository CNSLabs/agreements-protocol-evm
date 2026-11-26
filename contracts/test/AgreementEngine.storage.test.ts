// SPDX-License-Identifier: Apache-2.0
//
// How the engine keeps an agreement in storage: transitions looked up by state
// and input, variables kept by type, conditions and fields in packed form, and
// the reentrancy lock. Each test is a behaviour the layout must preserve at one
// of its edges: a zero state, a duplicate, a 32nd item, an argument of an
// unusual length, a call back in the middle of a transition.

import { expect } from "chai";
import { ethers } from "hardhat";
import { takeSnapshot } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { SnapshotRestorer } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const abi = ethers.AbiCoder.defaultAbiCoder();
const id = (name: string) => ethers.id(name);
const ZERO = ethers.ZeroHash;
const UINT256 = 0, STRING = 1, ADDRESS = 2, BOOL = 3, BYTES32 = 4;
const Op = {
  STRING_EQ_VAR: 3,
  UINT_EQ_CONST: 4,
  UINT_GTE_CONST: 6,
  UINT_EQ_VAR: 9,
  ADDRESS_EQ_VAR: 15,
  SENDER_EQ_VAR_ADDRESS: 16,
  UINT_EQ_VAR_OFFSET: 18,
} as const;

const OPEN = id("OPEN"), MID = id("MID"), DONE = id("DONE"), OTHER = id("OTHER");
const SUBMIT = id("submit"), GO = id("go"), FREE = id("free");
const VALUE = id("value"), STORED = id("stored");
const DATA_FIELDS = "tuple(bytes32 id,uint8 fType,bytes data)[]";

const uint = (value: bigint | number) => abi.encode(["uint256"], [value]);
const addr = (value: string) => abi.encode(["address"], [value]);
const str = (value: string) => abi.encode(["string"], [value]);
const fieldsPayload = (fields: { id: string; fType: number; data: string }[]) => abi.encode([DATA_FIELDS], [fields]);
const one = (fieldId: string, fType: number, data: string) => fieldsPayload([{ id: fieldId, fType, data }]);
const EMPTY = fieldsPayload([]);
const field = (fieldId: string, fType = UINT256, required = true, persist = false) => ({ fieldId, fType, required, persist });
const input = (inputId: string, fields: object[] = [], conditions: object[] = []) => ({ id: inputId, fields, conditions, verifierKeys: [] });
const move = (fromState: string, toState: string, inputId: string) => ({ fromState, toState, inputId });

describe("AgreementEngine storage layout", function () {
  let implementation: any;
  let factory: any;
  let restorer: SnapshotRestorer;
  let alice: any, bob: any;
  let n = 0;

  beforeEach(async function () {
    restorer = await takeSnapshot();
    [, alice, bob] = await ethers.getSigners();
    implementation = await ethers.deployContract("AgreementEngine");
    factory = await ethers.deployContract("AgreementFactory", [await implementation.getAddress()]);
  });
  afterEach(async function () {
    await restorer.restore();
  });

  async function create(inputDefs: object[], transitions: object[], initVars: object[] = [], actions: object[] = []) {
    const args = [`ipfs://storage-${++n}`, id(`storage-${n}`), OPEN, inputDefs, transitions, initVars, [], actions] as const;
    const address = await factory.createAgreement.staticCall(...args);
    await factory.createAgreement(...args);
    return ethers.getContractAt("AgreementEngine", address) as Promise<any>;
  }

  describe("transitions", function () {
    it("takes the first transition registered for a state and input", async function () {
      const agreement = await create([input(SUBMIT)], [move(OPEN, MID, SUBMIT), move(OPEN, DONE, SUBMIT)]);
      await agreement.submitInput(SUBMIT, EMPTY);
      expect(await agreement.currentState()).to.equal(MID);
    });

    it("moves to the zero state and on from it", async function () {
      const agreement = await create([input(SUBMIT)], [move(OPEN, ZERO, SUBMIT), move(ZERO, DONE, SUBMIT)]);
      await expect(agreement.submitInput(SUBMIT, EMPTY)).to.emit(agreement, "InputAccepted").withArgs(OPEN, ZERO, SUBMIT, EMPTY);
      expect(await agreement.currentState()).to.equal(ZERO);
      await agreement.submitInput(SUBMIT, EMPTY);
      expect(await agreement.currentState()).to.equal(DONE);
    });

    it("keeps a first transition to the zero state when a later one names another target", async function () {
      const agreement = await create([input(SUBMIT)], [move(OPEN, ZERO, SUBMIT), move(OPEN, MID, SUBMIT)]);
      await agreement.submitInput(SUBMIT, EMPTY);
      expect(await agreement.currentState()).to.equal(ZERO);
    });

    it("keeps a first transition when a later one for the pair goes to the zero state", async function () {
      const agreement = await create([input(SUBMIT)], [move(OPEN, MID, SUBMIT), move(OPEN, ZERO, SUBMIT)]);
      await agreement.submitInput(SUBMIT, EMPTY);
      expect(await agreement.currentState()).to.equal(MID);
    });

    it("refuses an input that has a transition from another state only", async function () {
      const agreement = await create([input(SUBMIT)], [move(MID, DONE, SUBMIT), move(OTHER, ZERO, SUBMIT)]);
      await expect(agreement.submitInput(SUBMIT, EMPTY)).to.be.revertedWith("No valid transition");
    });
  });

  describe("a call back into the agreement while its transition runs", function () {
    // `go` moves OPEN to MID and runs an action; `free` is open to anyone and moves MID to DONE.
    // Without the lock, a target that calls `free` back would be accepted and end in DONE.
    const REENTRANT = "0x3ee5aeb5"; // ReentrancyGuardReentrantCall()
    async function setup(reentry: (agreementInterface: any) => string, swallow: boolean) {
      const engine = await ethers.getContractFactory("AgreementEngine");
      const target = await ethers.deployContract("ReentrantActionTarget", [reentry(engine.interface), swallow]);
      const agreement = await create(
        [input(GO), input(FREE)],
        [move(OPEN, MID, GO), move(MID, DONE, FREE)],
        [],
        [{ fromState: OPEN, inputId: GO, target: await target.getAddress(), value: 0, data: "0x1234" }]
      );
      return { agreement, target };
    }
    const callFree = (iface: any) => iface.encodeFunctionData("submitInput", [FREE, EMPTY]);

    it("refuses the inner input and, when the target passes the failure on, the outer one", async function () {
      const { agreement, target } = await setup(callFree, false);
      await expect(agreement.submitInput(GO, EMPTY))
        .to.be.revertedWithCustomError(agreement, "ActionCallFailed")
        .withArgs(await target.getAddress(), REENTRANT);
      expect(await agreement.currentState()).to.equal(OPEN);
    });

    it("refuses the inner input and completes the outer one when the target ignores the failure", async function () {
      const { agreement, target } = await setup(callFree, true);
      const receipt = await (await agreement.submitInput(GO, EMPTY)).wait();
      const accepted = receipt.logs.filter((log: any) => log.topics[0] === agreement.interface.getEvent("InputAccepted").topicHash);
      expect(accepted).to.have.length(1);
      expect(await agreement.currentState()).to.equal(MID);
      expect(await target.calls()).to.equal(1n);
    });

    it("holds the lock for an input submitted by permit as well", async function () {
      const { agreement } = await setup(callFree, true);
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
      const { chainId } = await ethers.provider.getNetwork();
      const signature = await alice.signTypedData(
        { name: "AgreementEngine", version: "1", chainId, verifyingContract: await agreement.getAddress() },
        { PermitInput: [
          { name: "signer", type: "address" }, { name: "inputId", type: "bytes32" }, { name: "payload", type: "bytes" },
          { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
        ] },
        { signer: alice.address, inputId: GO, payload: EMPTY, nonce: 0, deadline }
      );
      await agreement.connect(bob).submitInputWithPermit(alice.address, GO, EMPTY, deadline, signature);
      expect(await agreement.currentState()).to.equal(MID);
    });

    it("releases the lock after a transition, so the next input is accepted", async function () {
      const { agreement } = await setup(callFree, true);
      await agreement.submitInput(GO, EMPTY);
      await agreement.submitInput(FREE, EMPTY);
      expect(await agreement.currentState()).to.equal(DONE);
    });

    it("lets a target cancel its own permits, which changes nothing but its own nonce", async function () {
      const { agreement, target } = await setup((iface) => iface.encodeFunctionData("cancelPermits"), false);
      await agreement.submitInput(GO, EMPTY);
      expect(await agreement.currentState()).to.equal(MID);
      expect(await agreement.nonces(await target.getAddress())).to.equal(1n);
    });
  });

  describe("conditions", function () {
    const withArg = (bytesArg: string) =>
      create([input(SUBMIT, [field(VALUE)], [{ op: Op.UINT_EQ_CONST, fieldId: VALUE, bytesArg }])], [move(OPEN, DONE, SUBMIT)]);

    for (const extra of [0, 1, 32, 64]) {
      it(`reads an argument of ${32 + extra} bytes as it was given`, async function () {
        // Decoding takes the first word and ignores what follows it.
        const agreement = await withArg(ethers.concat([uint(7), ethers.hexlify(ethers.randomBytes(extra))]));
        await expect(agreement.submitInput(SUBMIT, one(VALUE, UINT256, uint(8)))).to.be.revertedWithCustomError(agreement, "ComparisonFailed");
        await agreement.submitInput(SUBMIT, one(VALUE, UINT256, uint(7)));
        expect(await agreement.currentState()).to.equal(DONE);
      });
    }

    for (const length of [0, 1, 31]) {
      it(`refuses the input when a comparison's argument is ${length} bytes, too short to decode`, async function () {
        const agreement = await withArg(ethers.hexlify(new Uint8Array(length)));
        await expect(agreement.submitInput(SUBMIT, one(VALUE, UINT256, uint(0)))).to.be.revertedWithoutReason();
        expect(await agreement.currentState()).to.equal(OPEN);
      });
    }

    it("evaluates every condition of an input that has more than 31", async function () {
      // Condition k requires value >= k. Only the last one, at index 39, tells 38 from 39.
      const conditions = Array.from({ length: 40 }, (_, k) => ({ op: Op.UINT_GTE_CONST, fieldId: VALUE, bytesArg: uint(k) }));
      const agreement = await create([input(SUBMIT, [field(VALUE)], conditions)], [move(OPEN, DONE, SUBMIT)]);
      await expect(agreement.submitInput(SUBMIT, one(VALUE, UINT256, uint(38)))).to.be.revertedWithCustomError(agreement, "ComparisonFailed");
      await agreement.submitInput(SUBMIT, one(VALUE, UINT256, uint(39)));
      expect(await agreement.currentState()).to.equal(DONE);
    });

    it("keeps the order and the arguments of conditions of different shapes on one input", async function () {
      // A sender check with no argument, a one-word constant, a two-word offset and a long allowed list.
      const agreement = await create(
        [input(SUBMIT, [field(VALUE)], [
          { op: Op.SENDER_EQ_VAR_ADDRESS, fieldId: id("who"), bytesArg: "0x" },
          { op: Op.UINT_GTE_CONST, fieldId: VALUE, bytesArg: uint(3) },
          { op: Op.UINT_EQ_VAR_OFFSET, fieldId: VALUE, bytesArg: abi.encode(["bytes32", "int256"], [STORED, -2]) },
          { op: 17, fieldId: ZERO, bytesArg: abi.encode(["bytes32[]", "address[]"], [[id("who")], Array(20).fill(bob.address)]) },
        ])],
        [move(OPEN, DONE, SUBMIT)],
        [{ id: id("who"), fType: ADDRESS, data: addr(alice.address) }, { id: STORED, fType: UINT256, data: uint(7) }]
      );
      await expect(agreement.connect(bob).submitInput(SUBMIT, one(VALUE, UINT256, uint(5)))).to.be.revertedWithCustomError(agreement, "SenderAddressMismatch");
      await expect(agreement.connect(alice).submitInput(SUBMIT, one(VALUE, UINT256, uint(4)))).to.be.revertedWithCustomError(agreement, "ComparisonFailed");
      await agreement.connect(alice).submitInput(SUBMIT, one(VALUE, UINT256, uint(5)));
      expect(await agreement.currentState()).to.equal(DONE);
    });
  });

  describe("input fields", function () {
    it("validates the first field of an input", async function () {
      const agreement = await create([input(SUBMIT, [field(VALUE, UINT256), field(id("note"), STRING)])], [move(OPEN, DONE, SUBMIT)]);
      const note = { id: id("note"), fType: STRING, data: str("ok") };
      await expect(agreement.submitInput(SUBMIT, fieldsPayload([{ id: VALUE, fType: ADDRESS, data: addr(alice.address) }, note]))).to.be.revertedWith("Field type mismatch");
      await expect(agreement.submitInput(SUBMIT, fieldsPayload([{ id: VALUE, fType: UINT256, data: "0x01" }, note]))).to.be.revertedWith("Invalid uint256 encoding");
      await expect(agreement.submitInput(SUBMIT, fieldsPayload([note]))).to.be.revertedWith("Required field missing");
    });

    it("keeps type, required and persist for each of more than 31 fields", async function () {
      // 40 fields. Field 35 is required, field 36 optional, field 39 is stored. A second input compares against what was stored.
      const ids = Array.from({ length: 40 }, (_, k) => id(`field-${k}`));
      const fields = ids.map((fieldId, k) => field(fieldId, k === 37 ? ADDRESS : UINT256, k !== 36, k === 39));
      const agreement = await create(
        [input(SUBMIT, fields), input(GO, [field(VALUE)], [{ op: Op.UINT_EQ_VAR, fieldId: VALUE, bytesArg: abi.encode(["bytes32"], [ids[39]]) }])],
        [move(OPEN, MID, SUBMIT), move(MID, DONE, GO)]
      );
      const all = ids.map((fieldId, k) => ({ id: fieldId, fType: k === 37 ? ADDRESS : UINT256, data: k === 37 ? addr(alice.address) : uint(100 + k) }));
      await expect(agreement.submitInput(SUBMIT, fieldsPayload(all.filter((_, k) => k !== 35)))).to.be.revertedWith("Required field missing");
      await expect(agreement.submitInput(SUBMIT, fieldsPayload(all.map((f, k) => (k === 37 ? { ...f, fType: UINT256, data: uint(1) } : f))))).to.be.revertedWith("Field type mismatch");
      await agreement.submitInput(SUBMIT, fieldsPayload(all.filter((_, k) => k !== 36)));
      await expect(agreement.submitInput(GO, one(VALUE, UINT256, uint(138)))).to.be.revertedWithCustomError(agreement, "ComparisonFailed");
      await agreement.submitInput(GO, one(VALUE, UINT256, uint(139)));
      expect(await agreement.currentState()).to.equal(DONE);
    });

    it("does not store a field that is not marked to be stored", async function () {
      const agreement = await create(
        [input(SUBMIT, [field(VALUE, UINT256, true, false)]), input(GO, [field(id("x"))], [{ op: Op.UINT_EQ_VAR, fieldId: id("x"), bytesArg: abi.encode(["bytes32"], [VALUE]) }])],
        [move(OPEN, MID, SUBMIT), move(MID, DONE, GO)]
      );
      await agreement.submitInput(SUBMIT, one(VALUE, UINT256, uint(5)));
      await expect(agreement.submitInput(GO, one(id("x"), UINT256, uint(5)))).to.be.revertedWithCustomError(agreement, "VarNotSet").withArgs(VALUE);
    });
  });

  describe("stored variables", function () {
    const compareUint = { op: Op.UINT_EQ_VAR, fieldId: VALUE, bytesArg: abi.encode(["bytes32"], [STORED]) };
    const uintAgainst = (initVars: object[]) => create([input(SUBMIT, [field(VALUE)], [compareUint])], [move(OPEN, DONE, SUBMIT)], initVars);

    it("reads back a number, an address and a string of each length class", async function () {
      for (const text of ["", "alpha", "x".repeat(31), "x".repeat(32), "x".repeat(70)]) {
        const agreement = await create(
          [input(SUBMIT, [field(VALUE), field(id("who"), ADDRESS), field(id("text"), STRING)], [
            compareUint,
            { op: Op.ADDRESS_EQ_VAR, fieldId: id("who"), bytesArg: abi.encode(["bytes32"], [id("party")]) },
            { op: Op.STRING_EQ_VAR, fieldId: id("text"), bytesArg: abi.encode(["bytes32"], [id("name")]) },
          ])],
          [move(OPEN, DONE, SUBMIT)],
          [
            { id: STORED, fType: UINT256, data: uint(2n ** 256n - 1n) },
            { id: id("party"), fType: ADDRESS, data: addr(alice.address) },
            { id: id("name"), fType: STRING, data: str(text) },
          ]
        );
        const payload = (value: bigint, who: string, name: string) => fieldsPayload([
          { id: VALUE, fType: UINT256, data: uint(value) }, { id: id("who"), fType: ADDRESS, data: addr(who) }, { id: id("text"), fType: STRING, data: str(name) },
        ]);
        await expect(agreement.submitInput(SUBMIT, payload(2n ** 256n - 2n, alice.address, text))).to.be.revertedWithCustomError(agreement, "ComparisonFailed");
        await expect(agreement.submitInput(SUBMIT, payload(2n ** 256n - 1n, bob.address, text))).to.be.revertedWithCustomError(agreement, "ComparisonFailed");
        await expect(agreement.submitInput(SUBMIT, payload(2n ** 256n - 1n, alice.address, text + "!"))).to.be.revertedWithCustomError(agreement, "ComparisonFailed");
        await agreement.submitInput(SUBMIT, payload(2n ** 256n - 1n, alice.address, text));
        expect(await agreement.currentState(), `text of ${text.length} characters`).to.equal(DONE);
      }
    });

    it("names the stored type when a comparison needs another", async function () {
      const cases: [number, string, string][] = [
        [ADDRESS, addr(alice.address), "ADDRESS"],
        [STRING, str("5"), "STRING"],
        [BOOL, abi.encode(["bool"], [true]), "BOOL"],
        [BYTES32, uint(5), "BYTES32"],
      ];
      for (const [fType, data, name] of cases) {
        const agreement = await uintAgainst([{ id: STORED, fType, data }]);
        await expect(agreement.submitInput(SUBMIT, one(VALUE, UINT256, uint(5))))
          .to.be.revertedWithCustomError(agreement, "TypeMismatch").withArgs("UINT256", name);
      }
    });

    it("does not read a bool or a number where an address is needed", async function () {
      for (const [fType, data, name] of [[BOOL, abi.encode(["bool"], [true]), "BOOL"], [UINT256, uint(1), "UINT256"]] as [number, string, string][]) {
        const agreement = await create(
          [input(SUBMIT, [], [{ op: Op.SENDER_EQ_VAR_ADDRESS, fieldId: STORED, bytesArg: "0x" }])],
          [move(OPEN, DONE, SUBMIT)],
          [{ id: STORED, fType, data }]
        );
        await expect(agreement.submitInput(SUBMIT, EMPTY)).to.be.revertedWithCustomError(agreement, "TypeMismatch").withArgs("ADDRESS", name);
      }
    });

    it("reports a variable that was never set", async function () {
      const agreement = await uintAgainst([]);
      await expect(agreement.submitInput(SUBMIT, one(VALUE, UINT256, uint(0)))).to.be.revertedWithCustomError(agreement, "VarNotSet").withArgs(STORED);
    });

    describe("a variable that changes type", function () {
      // One name, `stored`, written by three inputs as a string, a number and an address. Every state loops.
      const TEXT = id("text"), NUMBER = id("number"), WHO = id("who");
      async function setup() {
        const harness = await ethers.deployContract("AgreementEngineStateHarness");
        const harnessFactory: any = await ethers.deployContract("AgreementFactory", [await harness.getAddress()]);
        const args = ["ipfs://type-change", id("type-change"), OPEN,
          [input(TEXT, [field(STORED, STRING, true, true)]), input(NUMBER, [field(STORED, UINT256, true, true)]), input(WHO, [field(STORED, ADDRESS, true, true)])],
          [move(OPEN, OPEN, TEXT), move(OPEN, OPEN, NUMBER), move(OPEN, OPEN, WHO)], [], [], []] as const;
        const address = await harnessFactory.createAgreement.staticCall(...args);
        await harnessFactory.createAgreement(...args);
        return ethers.getContractAt("AgreementEngineStateHarness", address) as Promise<any>;
      }
      const gasOf = async (tx: Promise<any>) => (await (await tx).wait()).gasUsed as bigint;

      it("leaves nothing of the old type in storage", async function () {
        const agreement = await setup();
        const raw = async () => { const [tag, a, word, text] = await agreement.getStoredVarRaw(STORED); return { tag, a, word, text }; };

        await agreement.submitInput(TEXT, one(STORED, STRING, str("x".repeat(100))));
        expect(await raw()).to.deep.equal({ tag: BigInt(STRING + 1), a: ethers.ZeroAddress, word: ZERO, text: ethers.hexlify(ethers.toUtf8Bytes("x".repeat(100))) });

        await agreement.submitInput(NUMBER, one(STORED, UINT256, uint(7)));
        expect(await raw()).to.deep.equal({ tag: BigInt(UINT256 + 1), a: ethers.ZeroAddress, word: uint(7), text: "0x" });

        await agreement.submitInput(WHO, one(STORED, ADDRESS, addr(alice.address)));
        expect(await raw()).to.deep.equal({ tag: BigInt(ADDRESS + 1), a: alice.address, word: ZERO, text: "0x" });

        await agreement.submitInput(TEXT, one(STORED, STRING, str("y")));
        expect(await raw()).to.deep.equal({ tag: BigInt(STRING + 1), a: ethers.ZeroAddress, word: ZERO, text: ethers.hexlify(ethers.toUtf8Bytes("y")) });
      });

      it("charges the clearing of a long string to the input that replaces it, not to a later one", async function () {
        const agreement = await setup();
        await agreement.submitInput(TEXT, one(STORED, STRING, str("x".repeat(3200))));
        const replacing = await gasOf(agreement.submitInput(NUMBER, one(STORED, UINT256, uint(7))));
        const later = await gasOf(agreement.connect(bob).submitInput(TEXT, one(STORED, STRING, str("y"))));
        // Clearing a hundred slots costs several hundred thousand gas. A short string on its own costs a fraction of that.
        expect(replacing, "the input that changes the type").to.be.greaterThan(300_000n);
        expect(later, "the next input to store a string").to.be.lessThan(150_000n);
      });
    });

    it("takes the type of the value last stored when a field replaces a variable of another type", async function () {
      // `stored` starts as the number 5. An input then stores an address under the same name.
      const agreement = await create(
        [
          input(SUBMIT, [field(STORED, ADDRESS, true, true)]),
          input(GO, [field(VALUE)], [compareUint]),
          input(FREE, [], [{ op: Op.SENDER_EQ_VAR_ADDRESS, fieldId: STORED, bytesArg: "0x" }]),
        ],
        [move(OPEN, MID, SUBMIT), move(MID, DONE, GO), move(MID, DONE, FREE)],
        [{ id: STORED, fType: UINT256, data: uint(5) }]
      );
      await agreement.submitInput(SUBMIT, one(STORED, ADDRESS, addr(alice.address)));
      // The number is gone as far as any comparison can tell, also for the value it used to hold.
      await expect(agreement.submitInput(GO, one(VALUE, UINT256, uint(5)))).to.be.revertedWithCustomError(agreement, "TypeMismatch").withArgs("UINT256", "ADDRESS");
      await expect(agreement.connect(bob).submitInput(FREE, EMPTY)).to.be.revertedWithCustomError(agreement, "SenderAddressMismatch");
      await agreement.connect(alice).submitInput(FREE, EMPTY);
      expect(await agreement.currentState()).to.equal(DONE);
    });
  });
});
