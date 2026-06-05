/**
 * ActionLib multi-call execution + typed output capture (R4 follow-up).
 *
 * - Multi-call: Action.calls run in order; both effects land. If a later call reverts,
 *   the tx reverts so NO net effect remains (atomicity).
 * - Output capture: after a call returns, each Output decodes the returnIndex-th return
 *   word to outType, validates it canonically, and stages it into an in-memory overlay
 *   that commits to vars ONLY after all calls succeed and all outputs validate.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  freshActionLibHarness,
  call,
  dynSlot,
  output,
} from "../helpers/action-lib";
import { FieldType, constRef, id } from "../helpers/value-lib";

const coder = ethers.AbiCoder.defaultAbiCoder();

const sinkIface = new ethers.Interface([
  "function record(uint256 key, uint256 val) returns (uint256)",
  "function quoteUint(uint256 x) returns (uint256)",
  "function quoteAddress(address a) returns (address)",
  "function quoteBool(bool b) returns (bool)",
  "function quoteBytes32(bytes32 b) returns (bytes32)",
  "function quoteRaw(uint256 raw) returns (uint256)",
  "function quotePair(uint256 a, uint256 b) returns (uint256, uint256)",
  "function returnShort() returns (bytes)",
  "function boom()",
]);
const recordSel = sinkIface.getFunction("record")!.selector;
const quoteUintSel = sinkIface.getFunction("quoteUint")!.selector;
const quoteAddressSel = sinkIface.getFunction("quoteAddress")!.selector;
const quoteBoolSel = sinkIface.getFunction("quoteBool")!.selector;
const quoteBytes32Sel = sinkIface.getFunction("quoteBytes32")!.selector;
const quoteRawSel = sinkIface.getFunction("quoteRaw")!.selector;
const quotePairSel = sinkIface.getFunction("quotePair")!.selector;
const returnShortSel = sinkIface.getFunction("returnShort")!.selector;
const boomSel = sinkIface.getFunction("boom")!.selector;

async function setup() {
  const h = await freshActionLibHarness();
  const sink = await ethers.deployContract("MockSink");
  await sink.waitForDeployment();
  return { h, sink };
}

function recordCall(sink: string, key: bigint, val: bigint) {
  return call(constRef(FieldType.ADDRESS, sink), recordSel, [
    dynSlot(constRef(FieldType.UINT256, key)),
    dynSlot(constRef(FieldType.UINT256, val)),
  ]);
}

describe("ActionLib.executeAction — multi-call ordering & atomicity", () => {
  it("two independent calls both execute; both effects land", async () => {
    const { h, sink } = await setup();
    const sinkAddr = await sink.getAddress();
    await (
      await h.executeAction([recordCall(sinkAddr, 1n, 111n), recordCall(sinkAddr, 2n, 222n)], [])
    ).wait();
    expect(await sink.recorded(1n)).to.equal(111n);
    expect(await sink.recorded(2n)).to.equal(222n);
  });

  it("if the 2nd call reverts, the whole action reverts: no net effect, 1st rolled back", async () => {
    const { h, sink } = await setup();
    const sinkAddr = await sink.getAddress();
    const boom = call(constRef(FieldType.ADDRESS, sinkAddr), boomSel, []);
    await expect(
      h.executeAction([recordCall(sinkAddr, 7n, 777n), boom], [])
    ).to.be.revertedWithCustomError(h, "CallReverted");
    // The first call's effect is rolled back by the tx revert.
    expect(await sink.recorded(7n)).to.equal(0n);
  });
});

describe("ActionLib.executeAction — typed output capture", () => {
  it("captures a uint256 return word into a var with the exact value", async () => {
    const { h, sink } = await setup();
    const sinkAddr = await sink.getAddress();
    const V = id("captured");
    const c = call(
      constRef(FieldType.ADDRESS, sinkAddr),
      quoteUintSel,
      [dynSlot(constRef(FieldType.UINT256, 41n))], // quoteUint(41) -> 42
      [],
      [output(0, FieldType.UINT256, V)]
    );
    await (await h.executeAction([c], [])).wait();
    const [set, fType, data] = await h.getVar(V);
    expect(set).to.equal(true);
    expect(Number(fType)).to.equal(FieldType.UINT256);
    expect(ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], data)[0]).to.equal(42n);
  });

  it("captures an address return word into a var", async () => {
    const { h, sink } = await setup();
    const sinkAddr = await sink.getAddress();
    const who = ethers.getAddress("0x000000000000000000000000000000000000beef");
    const V = id("capturedAddr");
    const c = call(
      constRef(FieldType.ADDRESS, sinkAddr),
      quoteAddressSel,
      [dynSlot(constRef(FieldType.ADDRESS, who))],
      [],
      [output(0, FieldType.ADDRESS, V)]
    );
    await (await h.executeAction([c], [])).wait();
    const [, fType, data] = await h.getVar(V);
    expect(Number(fType)).to.equal(FieldType.ADDRESS);
    expect(ethers.AbiCoder.defaultAbiCoder().decode(["address"], data)[0]).to.equal(who);
  });

  it("captures the returnIndex-th word (second return value)", async () => {
    const { h, sink } = await setup();
    const sinkAddr = await sink.getAddress();
    const V = id("second");
    const c = call(
      constRef(FieldType.ADDRESS, sinkAddr),
      quotePairSel,
      [dynSlot(constRef(FieldType.UINT256, 10n)), dynSlot(constRef(FieldType.UINT256, 20n))],
      [],
      [output(1, FieldType.UINT256, V)] // capture the 2nd return word (20)
    );
    await (await h.executeAction([c], [])).wait();
    const [, , data] = await h.getVar(V);
    expect(ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], data)[0]).to.equal(20n);
  });

  it("reverts when the return data is too short for the requested word", async () => {
    const { h, sink } = await setup();
    const sinkAddr = await sink.getAddress();
    const V = id("short");
    // returnShort returns a dynamic bytes payload; requesting return word index 5 is
    // out of range -> must fail closed, not read garbage.
    const c = call(
      constRef(FieldType.ADDRESS, sinkAddr),
      returnShortSel,
      [],
      [],
      [output(5, FieldType.UINT256, V)]
    );
    await expect(h.executeAction([c], [])).to.be.revertedWithCustomError(h, "ReturnWordOutOfRange");
  });

  it("a malformed (non-canonical) captured value is rejected", async () => {
    const { h, sink } = await setup();
    const sinkAddr = await sink.getAddress();
    const V = id("badaddr");
    // quoteUint returns a full uint256 word; decoding it AS an address requires the high
    // 12 bytes be zero. Feed a value whose high bytes are non-zero so the address decode
    // is non-canonical -> MalformedValue.
    const dirty = (1n << 200n); // a uint with bits above the 160-bit address range
    const c = call(
      constRef(FieldType.ADDRESS, sinkAddr),
      quoteUintSel,
      [dynSlot(constRef(FieldType.UINT256, dirty - 1n))], // quoteUint(x) -> x+1 = dirty
      [],
      [output(0, FieldType.ADDRESS, V)] // decode the uint word AS an address
    );
    await expect(h.executeAction([c], [])).to.be.revertedWithCustomError(h, "MalformedValue");
  });

  it("output overlay commits only after ALL calls succeed (later revert leaves no capture)", async () => {
    const { h, sink } = await setup();
    const sinkAddr = await sink.getAddress();
    const V = id("notcommitted");
    const capturing = call(
      constRef(FieldType.ADDRESS, sinkAddr),
      quoteUintSel,
      [dynSlot(constRef(FieldType.UINT256, 1n))],
      [],
      [output(0, FieldType.UINT256, V)]
    );
    const boom = call(constRef(FieldType.ADDRESS, sinkAddr), boomSel, []);
    await expect(h.executeAction([capturing, boom], [])).to.be.revertedWithCustomError(
      h,
      "CallReverted"
    );
    const [set] = await h.getVar(V);
    expect(set).to.equal(false); // no capture committed
  });

  it("captures a BOOL return word into a var", async () => {
    const { h, sink } = await setup();
    const sinkAddr = await sink.getAddress();
    const V = id("flag");
    const c = call(
      constRef(FieldType.ADDRESS, sinkAddr),
      quoteBoolSel,
      [dynSlot(constRef(FieldType.BOOL, true))],
      [],
      [output(0, FieldType.BOOL, V)]
    );
    await (await h.executeAction([c], [])).wait();
    const [, fType, data] = await h.getVar(V);
    expect(Number(fType)).to.equal(FieldType.BOOL);
    expect(coder.decode(["bool"], data)[0]).to.equal(true);
  });

  it("captures a BYTES32 return word into a var", async () => {
    const { h, sink } = await setup();
    const sinkAddr = await sink.getAddress();
    const V = id("ref");
    const refVal = ethers.id("some-ref");
    const c = call(
      constRef(FieldType.ADDRESS, sinkAddr),
      quoteBytes32Sel,
      [dynSlot(constRef(FieldType.BYTES32, refVal))],
      [],
      [output(0, FieldType.BYTES32, V)]
    );
    await (await h.executeAction([c], [])).wait();
    const [, fType, data] = await h.getVar(V);
    expect(Number(fType)).to.equal(FieldType.BYTES32);
    expect(coder.decode(["bytes32"], data)[0]).to.equal(refVal);
  });

  it("rejects capturing a non-0/1 return word AS a BOOL (MalformedValue)", async () => {
    const { h, sink } = await setup();
    const sinkAddr = await sink.getAddress();
    const V = id("badbool");
    // quoteRaw returns the word verbatim; word == 2 captured AS BOOL must be rejected.
    const c = call(
      constRef(FieldType.ADDRESS, sinkAddr),
      quoteRawSel,
      [dynSlot(constRef(FieldType.UINT256, 2n))],
      [],
      [output(0, FieldType.BOOL, V)]
    );
    await expect(h.executeAction([c], [])).to.be.revertedWithCustomError(h, "MalformedValue");
  });

  it("duplicate targetVar across outputs: the last capture wins (deterministic)", async () => {
    const { h, sink } = await setup();
    const sinkAddr = await sink.getAddress();
    const V = id("dup");
    // quotePair(10,20) returns (10,20); capture word 0 then word 1 both into V.
    const c = call(
      constRef(FieldType.ADDRESS, sinkAddr),
      quotePairSel,
      [dynSlot(constRef(FieldType.UINT256, 10n)), dynSlot(constRef(FieldType.UINT256, 20n))],
      [],
      [output(0, FieldType.UINT256, V), output(1, FieldType.UINT256, V)]
    );
    await (await h.executeAction([c], [])).wait();
    const [, , data] = await h.getVar(V);
    // Overlay commits in staged order, so the later (word 1 == 20) overwrites.
    expect(coder.decode(["uint256"], data)[0]).to.equal(20n);
  });

  it("a capture overwrites a pre-existing var value", async () => {
    const { h, sink } = await setup();
    const sinkAddr = await sink.getAddress();
    const V = id("preexisting");
    await h.setVar(V, FieldType.UINT256, coder.encode(["uint256"], [999n]));
    const c = call(
      constRef(FieldType.ADDRESS, sinkAddr),
      quoteUintSel,
      [dynSlot(constRef(FieldType.UINT256, 41n))], // -> 42
      [],
      [output(0, FieldType.UINT256, V)]
    );
    await (await h.executeAction([c], [])).wait();
    const [, , data] = await h.getVar(V);
    expect(coder.decode(["uint256"], data)[0]).to.equal(42n);
  });

  it("first output staged, a later output decode fails -> NO var committed (overlay atomic)", async () => {
    const { h, sink } = await setup();
    const sinkAddr = await sink.getAddress();
    const VOK = id("ok");
    const VBAD = id("bad");
    // quotePair(10, 2): capture word 0 (10) as UINT256 -> staged OK; then capture word 1
    // (2) AS BOOL -> MalformedValue. The whole action reverts; the first staged capture
    // must NOT be committed.
    const c = call(
      constRef(FieldType.ADDRESS, sinkAddr),
      quotePairSel,
      [dynSlot(constRef(FieldType.UINT256, 10n)), dynSlot(constRef(FieldType.UINT256, 2n))],
      [],
      [output(0, FieldType.UINT256, VOK), output(1, FieldType.BOOL, VBAD)]
    );
    await expect(h.executeAction([c], [])).to.be.revertedWithCustomError(h, "MalformedValue");
    expect((await h.getVar(VOK))[0]).to.equal(false); // first capture not committed
    expect((await h.getVar(VBAD))[0]).to.equal(false);
  });
});
