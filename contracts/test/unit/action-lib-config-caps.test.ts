/**
 * Init-time bounded-evaluation caps (spec §13) — ActionLib action components.
 *
 * An action's calls / args / constraints / outputs are all walked or evaluated at submit
 * time, so each is bounded at init in the structural validation pass. An over-cap component
 * reverts with AgreementTypes.ConfigCapExceeded(what, got, max); an at-the-cap component
 * passes. The per-call caps are checked in validateCall; MAX_CALLS_PER_ACTION is checked in
 * the decode walk shared by validateActionsTaint / validateAndAnalyzeActions.
 *
 * Caps: MAX_CALLS_PER_ACTION = 16, MAX_ARGS_PER_CALL = 16, MAX_CONSTRAINTS_PER_CALL = 32,
 *       MAX_OUTPUTS_PER_CALL = 8.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  freshActionLibHarness,
  call,
  constSlot,
  dynSlot,
  output,
  encodeCalls,
} from "../helpers/action-lib";
import {
  FieldType,
  CmpOp,
  constRef,
  fieldRef,
  id,
} from "../helpers/value-lib";

const transferFromSel = "0x23b872dd";
const ZERO32 = "0x" + "00".repeat(32);
const TOKEN = ethers.getAddress("0x000000000000000000000000000000000c0ffee1");

// ABI handle so the AgreementTypes.ConfigCapExceeded error is decodable by the matcher.
async function capError() {
  const ActionLib = await ethers.getContractFactory("ActionLib");
  return ActionLib.attach(ethers.ZeroAddress);
}

describe("Init caps — ActionLib action components", () => {
  describe("MAX_ARGS_PER_CALL = 16 (validateCall)", () => {
    function callWithArgs(n: number) {
      const args = [];
      for (let i = 0; i < n; i++) args.push(constSlot(ZERO32));
      return call(constRef(FieldType.ADDRESS, TOKEN), transferFromSel, args);
    }

    it("accepts a call at the cap (16 args)", async () => {
      const h = await freshActionLibHarness();
      await expect(h.validateCall(callWithArgs(16) as any)).to.not.be.reverted;
    });

    it("rejects a call over the cap (17 args)", async () => {
      const h = await freshActionLibHarness();
      await expect(h.validateCall(callWithArgs(17) as any))
        .to.be.revertedWithCustomError(await capError(), "ConfigCapExceeded")
        .withArgs(ethers.encodeBytes32String("MAX_ARGS_PER_CALL"), 17, 16);
    });
  });

  describe("MAX_CONSTRAINTS_PER_CALL = 32 (validateCall)", () => {
    function callWithConstraints(n: number) {
      const cs = [];
      for (let i = 0; i < n; i++) {
        cs.push({
          left: constRef(FieldType.UINT256, BigInt(i)),
          op: CmpOp.EQ,
          skipIfAbsent: false,
          right: [constRef(FieldType.UINT256, BigInt(i))],
        });
      }
      return call(constRef(FieldType.ADDRESS, TOKEN), transferFromSel, [], cs);
    }

    it("accepts a call at the cap (32 constraints)", async () => {
      const h = await freshActionLibHarness();
      await expect(h.validateCall(callWithConstraints(32) as any)).to.not.be.reverted;
    });

    it("rejects a call over the cap (33 constraints)", async () => {
      const h = await freshActionLibHarness();
      await expect(h.validateCall(callWithConstraints(33) as any))
        .to.be.revertedWithCustomError(await capError(), "ConfigCapExceeded")
        .withArgs(ethers.encodeBytes32String("MAX_CONSTRAINTS_PER_CALL"), 33, 32);
    });
  });

  describe("MAX_OUTPUTS_PER_CALL = 8 (validateCall)", () => {
    function callWithOutputs(n: number) {
      const outs = [];
      for (let i = 0; i < n; i++) outs.push(output(i, FieldType.UINT256, id(`o${i}`)));
      return call(constRef(FieldType.ADDRESS, TOKEN), transferFromSel, [], [], outs);
    }

    it("accepts a call at the cap (8 outputs)", async () => {
      const h = await freshActionLibHarness();
      await expect(h.validateCall(callWithOutputs(8) as any)).to.not.be.reverted;
    });

    it("rejects a call over the cap (9 outputs)", async () => {
      const h = await freshActionLibHarness();
      await expect(h.validateCall(callWithOutputs(9) as any))
        .to.be.revertedWithCustomError(await capError(), "ConfigCapExceeded")
        .withArgs(ethers.encodeBytes32String("MAX_OUTPUTS_PER_CALL"), 9, 8);
    });
  });

  describe("MAX_CALLS_PER_ACTION = 16 (decode walk via validateActionsTaint)", () => {
    function actionWithCalls(n: number): string {
      const calls = [];
      for (let i = 0; i < n; i++) calls.push(call(constRef(FieldType.ADDRESS, TOKEN), transferFromSel, []));
      return encodeCalls(calls);
    }

    it("accepts an action at the cap (16 calls)", async () => {
      const h = await freshActionLibHarness();
      await expect(h.validateActionsTaint([actionWithCalls(16)], [])).to.not.be.reverted;
    });

    it("rejects an action over the cap (17 calls)", async () => {
      const h = await freshActionLibHarness();
      await expect(h.validateActionsTaint([actionWithCalls(17)], []))
        .to.be.revertedWithCustomError(await capError(), "ConfigCapExceeded")
        .withArgs(ethers.encodeBytes32String("MAX_CALLS_PER_ACTION"), 17, 16);
    });
  });

  // The legacy desugar (encodeLegacyCall) was removed — legacy authoring is desugared into
  // the composable Call[] shape OFF-CHAIN by the SDK — so the MAX_ARGS_PER_CALL cap is now
  // exercised solely on the composable path (the validateCall section above).
});
