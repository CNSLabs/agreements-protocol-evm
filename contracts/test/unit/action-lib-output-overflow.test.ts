/**
 * ActionLib output capture — extreme returnIndex must fail with the advertised custom
 * error, not an arithmetic-overflow Panic. `(returnIndex + 1) * 32` overflows for huge
 * returnIndex; the bound check must run first and revert ReturnWordOutOfRange.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { freshActionLibHarness, call, output } from "../helpers/action-lib";
import { FieldType, constRef, id } from "../helpers/value-lib";

const sinkIface = new ethers.Interface(["function quoteUint(uint256 x) returns (uint256)"]);
const quoteUintSel = sinkIface.getFunction("quoteUint")!.selector;

const MAX_UINT = (1n << 256n) - 1n;

describe("ActionLib output capture — returnIndex overflow guard", () => {
  it("an extreme returnIndex reverts ReturnWordOutOfRange (not an overflow Panic)", async () => {
    const h = await freshActionLibHarness();
    const sink = await ethers.deployContract("MockSink");
    await sink.waitForDeployment();
    const c = call(
      constRef(FieldType.ADDRESS, await sink.getAddress()),
      quoteUintSel,
      [{ dynamic: true, constWord: "0x" + "00".repeat(32), value: constRef(FieldType.UINT256, 1n) }],
      [],
      [output(MAX_UINT, FieldType.UINT256, id("v"))]
    );
    await expect(h.executeAction([c], [])).to.be.revertedWithCustomError(h, "ReturnWordOutOfRange");
  });

  it("returnIndex == max/32 boundary also reverts ReturnWordOutOfRange (no overflow)", async () => {
    const h = await freshActionLibHarness();
    const sink = await ethers.deployContract("MockSink");
    await sink.waitForDeployment();
    const idx = MAX_UINT / 32n; // (idx + 1) * 32 still in range only at the very edge
    const c = call(
      constRef(FieldType.ADDRESS, await sink.getAddress()),
      quoteUintSel,
      [{ dynamic: true, constWord: "0x" + "00".repeat(32), value: constRef(FieldType.UINT256, 1n) }],
      [],
      [output(idx, FieldType.UINT256, id("v"))]
    );
    await expect(h.executeAction([c], [])).to.be.revertedWithCustomError(h, "ReturnWordOutOfRange");
  });
});
