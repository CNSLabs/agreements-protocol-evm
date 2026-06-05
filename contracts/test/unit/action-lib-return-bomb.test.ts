/**
 * ActionLib return-bomb DoS (Codex M-02 / pashov solidity-auditor #2).
 *
 * `executeCall` step 5 used a high-level `(ok, ret) = target.call(data)`, which copies the
 * ENTIRE returndata into `ret` before any bounds-checking. A malicious/compromised/author-
 * chosen target can return a multi-megabyte blob (or revert with huge revert data) to
 * exhaust gas during a counterparty's submitInput — a return-bomb DoS that bypasses the
 * bounded-output intent. The fix:
 *   1. Init cap on Output.returnIndex (MAX_RETURN_WORD_INDEX) so the needed return bytes
 *      a call can ever require — 32*(maxReturnIndex+1) — is statically bounded.
 *   2. A bounded inline-assembly returndata copy in executeCall: copy only
 *      min(returndatasize(), 32*(maxReturnIndex+1)) — 0 bytes when the call has no outputs.
 *   3. A capped revert-data copy (MAX_REVERT_BYTES) carried in CallReverted.
 *
 * Deterministic assertions are preferred over brittle gas thresholds; the one gas assertion
 * (the bounded success copy) only requires the tx to fit under a generous limit that an
 * unbounded full-blob copy would blow past.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  freshActionLibHarness,
  call,
  dynSlot,
  output,
  wordUint,
} from "../helpers/action-lib";
import { FieldType, constRef, id } from "../helpers/value-lib";

// MAX_RETURN_WORD_INDEX = 31 (32 words, 1024 bytes) — see ActionLib §13 caps.
const MAX_RETURN_WORD_INDEX = 31;

const bombIface = new ethers.Interface([
  "function bomb(bytes32 firstWord, uint256 extraWords) returns (uint256)",
  "function boom(uint256 words)",
]);
const bombSel = bombIface.getFunction("bomb")!.selector;
const boomSel = bombIface.getFunction("boom")!.selector;

const ZERO32 = "0x" + "00".repeat(32);

// ABI handle so AgreementTypes.ConfigCapExceeded is decodable by the matcher.
async function capError() {
  const ActionLib = await ethers.getContractFactory("ActionLib");
  return ActionLib.attach(ethers.ZeroAddress);
}

async function deployBomb() {
  const bomb = await ethers.deployContract("MockReturnBomb");
  await bomb.waitForDeployment();
  return bomb;
}

describe("ActionLib return-bomb DoS — init cap on Output.returnIndex", () => {
  it("rejects an Output.returnIndex over MAX_RETURN_WORD_INDEX at validateCall", async () => {
    const h = await freshActionLibHarness();
    const c = call(
      constRef(FieldType.ADDRESS, ethers.ZeroAddress),
      bombSel,
      [],
      [],
      [output(MAX_RETURN_WORD_INDEX + 1, FieldType.UINT256, id("v"))]
    );
    await expect(h.validateCall(c as any))
      .to.be.revertedWithCustomError(await capError(), "ConfigCapExceeded")
      .withArgs(ethers.encodeBytes32String("MAX_RETURN_WORD_INDEX"), MAX_RETURN_WORD_INDEX + 1, MAX_RETURN_WORD_INDEX);
  });

  it("accepts an Output.returnIndex exactly at MAX_RETURN_WORD_INDEX", async () => {
    const h = await freshActionLibHarness();
    const c = call(
      constRef(FieldType.ADDRESS, ethers.ZeroAddress),
      bombSel,
      [],
      [],
      [output(MAX_RETURN_WORD_INDEX, FieldType.UINT256, id("v"))]
    );
    await expect(h.validateCall(c as any)).to.not.be.reverted;
  });
});

describe("ActionLib return-bomb DoS — capped revert data", () => {
  it("a target reverting with a huge blob surfaces CallReverted with revertData.length <= cap", async () => {
    const h = await freshActionLibHarness();
    const bomb = await deployBomb();
    // 4096 words = 131072 bytes of revert data — an unbounded carry would be a bomb.
    const c = call(constRef(FieldType.ADDRESS, await bomb.getAddress()), boomSel, [
      dynSlot(constRef(FieldType.UINT256, 4096n)),
    ]);

    let err: any;
    try {
      await h.executeCall.staticCall(c, []);
      expect.fail("expected executeCall to revert");
    } catch (e) {
      err = e;
    }
    const parsed = h.interface.parseError(err.data);
    expect(parsed?.name).to.equal("CallReverted");
    const revertData: string = parsed!.args.revertData;
    const len = ethers.dataLength(revertData);
    expect(len).to.be.lessThanOrEqual(256); // MAX_REVERT_BYTES
  });
});

describe("ActionLib return-bomb DoS — bounded success copy", () => {
  // 16384 extra words = 512 KiB of returndata. The callee can emit this within the chosen
  // gas budget, but the OLD unbounded caller copy of the same blob (an extra quadratic
  // memory expansion + copy on the caller side) cost ~1.25M gas — measured — versus ~0.63M
  // for the bounded path. A 900k gas limit cleanly separates them: the bounded path passes
  // and the old unbounded path would revert. Deterministic separation, not a brittle exact
  // threshold (the limit sits in the wide gap between the two measured costs).
  const BOMB_WORDS = 16384n;
  const GAS_LIMIT = 900_000;

  it("a NO-output call to a target returning a massive blob still succeeds (copy is bounded)", async () => {
    const h = await freshActionLibHarness();
    const bomb = await deployBomb();
    // With no outputs, neededBytes == 0 — the caller copies nothing regardless of blob size.
    const c = call(constRef(FieldType.ADDRESS, await bomb.getAddress()), bombSel, [
      dynSlot(constRef(FieldType.BYTES32, ZERO32)),
      dynSlot(constRef(FieldType.UINT256, BOMB_WORDS)),
    ]);

    await expect(h.executeAction([c], [], { gasLimit: GAS_LIMIT })).to.not.be.reverted;
  });

  it("a low-index output call to a return-bomb target still captures the correct word", async () => {
    const h = await freshActionLibHarness();
    const bomb = await deployBomb();
    const firstWord = wordUint(0x1234n); // the leading return word
    const c = call(
      constRef(FieldType.ADDRESS, await bomb.getAddress()),
      bombSel,
      [
        dynSlot(constRef(FieldType.BYTES32, firstWord)),
        dynSlot(constRef(FieldType.UINT256, BOMB_WORDS)), // 512 KiB of filler past word 0
      ],
      [],
      [output(0, FieldType.UINT256, id("captured"))]
    );

    // Bounded copy is only the one needed word; the tx fits under GAS_LIMIT and captures it.
    await (await h.executeAction([c], [], { gasLimit: GAS_LIMIT })).wait();
    const [set, fType, data] = await h.getVar(id("captured"));
    expect(set).to.equal(true);
    expect(fType).to.equal(FieldType.UINT256);
    expect(ethers.toBigInt(data)).to.equal(0x1234n);
  });
});

describe("ActionLib return-bomb DoS — regression: short returns still fail closed", () => {
  it("a target returning fewer words than an output needs still reverts ReturnWordOutOfRange", async () => {
    const h = await freshActionLibHarness();
    const bomb = await deployBomb();
    // The bomb returns exactly 1 word (extraWords = 0) but the output reads word index 1.
    const c = call(
      constRef(FieldType.ADDRESS, await bomb.getAddress()),
      bombSel,
      [
        dynSlot(constRef(FieldType.BYTES32, ZERO32)),
        dynSlot(constRef(FieldType.UINT256, 0n)),
      ],
      [],
      [output(1, FieldType.UINT256, id("v"))]
    );
    await expect(h.executeAction([c], [])).to.be.revertedWithCustomError(h, "ReturnWordOutOfRange");
  });
});
