/**
 * ActionLib.executeCall — runtime defenses (defense-in-depth beyond init validation).
 *
 * The harness executeCall path does NOT run validateCall, so these assert the runtime
 * guards directly:
 *   - the resolved target's FieldType must be ADDRESS before abi.decode (the resolved
 *     type is not discarded) — a target that resolves to a non-ADDRESS is rejected.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { freshActionLibHarness, call, dynSlot } from "../helpers/action-lib";
import { FieldType, varRef, constRef, encUint, id } from "../helpers/value-lib";

const SEL = "0xaabbccdd";

describe("ActionLib.executeCall — runtime target-ADDRESS guard", () => {
  it("rejects a target that resolves to a non-ADDRESS type (NonAddressTarget)", async () => {
    const h = await freshActionLibHarness();
    // A VAR declared UINT256 that holds a uint resolves to (UINT256, word). The target
    // guard must reject it on the resolved FieldType, not blindly abi.decode it as address.
    const V = id("badtarget");
    await h.setVar(V, FieldType.UINT256, encUint(123n));
    const c = call(varRef(FieldType.UINT256, V), SEL, []);
    await expect(h.executeCall(c, [])).to.be.revertedWithCustomError(h, "NonAddressTarget");
  });
});
