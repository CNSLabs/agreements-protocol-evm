/**
 * ActionLib.validateCall + executeCall (R4 core).
 *
 * - validateCall (init-time): a dynamic arg slot must be a fixed-size WORD type;
 *   a dynamic-type (STRING/BYTES) substitution is rejected (NonWordArg). The
 *   selector lives outside the arg-word region (a separate bytes4 field), so it is
 *   structurally non-substitutable; each arg index maps to a disjoint word, so no
 *   two substitutions can overlap. Constraints are validateLegality'd.
 *
 * - executeCall (runtime): resolves target (rejecting address(this) — no-self),
 *   asserts every constraint against the resolved values (fatal), composes the
 *   calldata, and executes the call fatally. Cross-checks that the resolved value a
 *   constraint bounds is the SAME value spliced into the calldata.
 *
 * Live behavior is exercised against a real TestERC20 via transferFrom.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import type { TestERC20 } from "../../typechain-types";
import {
  freshActionLibHarness,
  constSlot,
  dynSlot,
  call,
  wordUint,
  wordAddress,
} from "../helpers/action-lib";
import {
  FieldType,
  CmpOp,
  ValueSource,
  constRef,
  varRef,
  fieldRef,
  field,
  cond,
  encAddress,
  encUint,
  id,
} from "../helpers/value-lib";

const erc20 = new ethers.Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
]);
const transferFromSel = erc20.getFunction("transferFrom")!.selector;

// ValueRef builder for a literal target (CONST address).
function targetConst(addr: string) {
  return constRef(FieldType.ADDRESS, addr);
}

describe("ActionLib.validateCall — init-time structural checks", () => {
  it("accepts a well-formed transferFrom call (CONST target, dynamic word args)", async () => {
    const h = await freshActionLibHarness();
    const c = call(targetConst(ethers.getAddress("0x00000000000000000000000000000000c0ffee01")), transferFromSel, [
      dynSlot(fieldRef(FieldType.ADDRESS, id("from"))),
      dynSlot(fieldRef(FieldType.ADDRESS, id("to"))),
      dynSlot(fieldRef(FieldType.UINT256, id("amount"))),
    ]);
    await h.validateCall(c); // should not revert
  });

  it("rejects a dynamic STRING arg slot (dynamic-type substitution) as NonWordArg", async () => {
    const h = await freshActionLibHarness();
    const c = call(targetConst(ethers.ZeroAddress), transferFromSel, [
      dynSlot(fieldRef(FieldType.STRING, id("note"))), // a dynamic-type slot — illegal
    ]);
    await expect(h.validateCall(c)).to.be.revertedWithCustomError(h, "NonWordArg");
  });

  it("rejects a dynamic BYTES arg slot as NonWordArg", async () => {
    const h = await freshActionLibHarness();
    const c = call(targetConst(ethers.ZeroAddress), transferFromSel, [
      dynSlot(fieldRef(FieldType.BYTES, id("blob"))),
    ]);
    await expect(h.validateCall(c)).to.be.revertedWithCustomError(h, "NonWordArg");
  });

  it("rejects an illegal constraint (ordered op on ADDRESS) via validateLegality", async () => {
    const h = await freshActionLibHarness();
    const c = call(
      targetConst(ethers.ZeroAddress),
      transferFromSel,
      [dynSlot(fieldRef(FieldType.UINT256, id("amount")))],
      // GT on ADDRESS is illegal — caught by ValueLib.validateLegality at init.
      [cond(constRef(FieldType.ADDRESS, ethers.ZeroAddress), CmpOp.GT, constRef(FieldType.ADDRESS, ethers.ZeroAddress))]
    );
    await expect(h.validateCall(c)).to.be.revertedWithCustomError(h, "IllegalComparison");
  });
});

describe("ActionLib.executeCall — live transferFrom + no-self + constraints", () => {
  async function setup() {
    const [payer, payee] = await ethers.getSigners();
    const token = (await ethers.deployContract("TestERC20", ["WorkToken", "WORK"])) as unknown as TestERC20;
    await token.waitForDeployment();
    const h = await freshActionLibHarness();
    // The harness is the caller of transferFrom, so the payer approves the harness.
    await (await token.mint(payer.address, 1000n)).wait();
    await (await token.connect(payer).approve(await h.getAddress(), 1000n)).wait();
    return { payer, payee, token, h };
  }

  it("executes a FIELD-sourced transferFrom; balance delta equals the resolved amount", async () => {
    const { payer, payee, token, h } = await setup();
    const amount = 250n;
    const tokenAddr = await token.getAddress();

    const c = call(targetConst(tokenAddr), transferFromSel, [
      dynSlot(constRef(FieldType.ADDRESS, payer.address)), // from = payer (baked via CONST here)
      dynSlot(fieldRef(FieldType.ADDRESS, id("to"))), // to = field
      dynSlot(fieldRef(FieldType.UINT256, id("amount"))), // amount = field
    ]);

    const before = await token.balanceOf(payee.address);
    await (
      await h.executeCall(c, [field(FieldType.ADDRESS, id("to"), payee.address), field(FieldType.UINT256, id("amount"), amount)])
    ).wait();
    const after = await token.balanceOf(payee.address);
    expect(after - before).to.equal(amount);
  });

  it("rejects a resolved self-target (target == address(this)) with SelfCallRejected", async () => {
    const { h } = await setup();
    const selfAddr = await h.getAddress();
    const c = call(targetConst(selfAddr), transferFromSel, [
      dynSlot(constRef(FieldType.ADDRESS, ethers.ZeroAddress)),
      dynSlot(constRef(FieldType.ADDRESS, ethers.ZeroAddress)),
      dynSlot(constRef(FieldType.UINT256, 1n)),
    ]);
    await expect(h.executeCall(c, [])).to.be.revertedWithCustomError(h, "SelfCallRejected");
  });

  it("constraint in-bounds: amount LTE cap and recipient IN allow-set -> executes", async () => {
    const { payer, payee, token, h } = await setup();
    const amount = 100n;
    const cap = 100n;
    const tokenAddr = await token.getAddress();

    const c = call(
      targetConst(tokenAddr),
      transferFromSel,
      [
        dynSlot(constRef(FieldType.ADDRESS, payer.address)),
        dynSlot(fieldRef(FieldType.ADDRESS, id("to"))),
        dynSlot(fieldRef(FieldType.UINT256, id("amount"))),
      ],
      [
        cond(fieldRef(FieldType.UINT256, id("amount")), CmpOp.LTE, constRef(FieldType.UINT256, cap)),
        cond(fieldRef(FieldType.ADDRESS, id("to")), CmpOp.IN, [constRef(FieldType.ADDRESS, payee.address)]),
      ]
    );

    const before = await token.balanceOf(payee.address);
    await (
      await h.executeCall(c, [field(FieldType.ADDRESS, id("to"), payee.address), field(FieldType.UINT256, id("amount"), amount)])
    ).wait();
    expect((await token.balanceOf(payee.address)) - before).to.equal(amount);
  });

  it("constraint out-of-bounds (amount over cap): reverts pre-call, no transfer", async () => {
    const { payer, payee, token, h } = await setup();
    const cap = 100n;
    const over = 101n;
    const tokenAddr = await token.getAddress();

    const c = call(
      targetConst(tokenAddr),
      transferFromSel,
      [
        dynSlot(constRef(FieldType.ADDRESS, payer.address)),
        dynSlot(fieldRef(FieldType.ADDRESS, id("to"))),
        dynSlot(fieldRef(FieldType.UINT256, id("amount"))),
      ],
      [cond(fieldRef(FieldType.UINT256, id("amount")), CmpOp.LTE, constRef(FieldType.UINT256, cap))]
    );

    const before = await token.balanceOf(payee.address);
    await expect(
      h.executeCall(c, [field(FieldType.ADDRESS, id("to"), payee.address), field(FieldType.UINT256, id("amount"), over)])
    ).to.be.revertedWithCustomError(h, "ConstraintFailed");
    expect(await token.balanceOf(payee.address)).to.equal(before); // no transfer
  });

  it("constraint out-of-bounds (recipient not in allow-set): reverts pre-call, no transfer", async () => {
    const { payer, token, h } = await setup();
    const allowed = ethers.getAddress("0x000000000000000000000000000000000000aaaa");
    const attacker = ethers.getAddress("0x000000000000000000000000000000000000dead");
    const amount = 10n;
    const tokenAddr = await token.getAddress();

    const c = call(
      targetConst(tokenAddr),
      transferFromSel,
      [
        dynSlot(constRef(FieldType.ADDRESS, payer.address)),
        dynSlot(fieldRef(FieldType.ADDRESS, id("to"))),
        dynSlot(fieldRef(FieldType.UINT256, id("amount"))),
      ],
      [cond(fieldRef(FieldType.ADDRESS, id("to")), CmpOp.IN, [constRef(FieldType.ADDRESS, allowed)])]
    );

    const before = await token.balanceOf(attacker);
    await expect(
      h.executeCall(c, [field(FieldType.ADDRESS, id("to"), attacker), field(FieldType.UINT256, id("amount"), amount)])
    ).to.be.revertedWithCustomError(h, "ConstraintFailed");
    expect(await token.balanceOf(attacker)).to.equal(before);
  });

  it("the constraint-bounded value is the SAME value spliced into the calldata", async () => {
    // A constraint bounds amount LTE cap. We pick amount == cap (the boundary): if the
    // splice and the constraint resolved DIFFERENT values, the boundary case would
    // either wrongly revert (constraint saw > cap) or transfer the wrong amount. The
    // exact balance delta == the constrained boundary amount proves they're the same.
    const { payer, payee, token, h } = await setup();
    const cap = 100n;
    const tokenAddr = await token.getAddress();
    const c = call(
      targetConst(tokenAddr),
      transferFromSel,
      [
        dynSlot(constRef(FieldType.ADDRESS, payer.address)),
        dynSlot(fieldRef(FieldType.ADDRESS, id("to"))),
        dynSlot(fieldRef(FieldType.UINT256, id("amount"))),
      ],
      [cond(fieldRef(FieldType.UINT256, id("amount")), CmpOp.LTE, constRef(FieldType.UINT256, cap))]
    );
    const before = await token.balanceOf(payee.address);
    await (
      await h.executeCall(c, [field(FieldType.ADDRESS, id("to"), payee.address), field(FieldType.UINT256, id("amount"), cap)])
    ).wait();
    expect((await token.balanceOf(payee.address)) - before).to.equal(cap);
  });

  it("a failed call (no allowance) reverts fatally with CallReverted", async () => {
    const { payer, payee, token, h } = await setup();
    // Drop the allowance to 0 so transferFrom fails.
    await (await token.connect(payer).approve(await h.getAddress(), 0n)).wait();
    const tokenAddr = await token.getAddress();
    const c = call(targetConst(tokenAddr), transferFromSel, [
      dynSlot(constRef(FieldType.ADDRESS, payer.address)),
      dynSlot(fieldRef(FieldType.ADDRESS, id("to"))),
      dynSlot(fieldRef(FieldType.UINT256, id("amount"))),
    ]);
    await expect(
      h.executeCall(c, [field(FieldType.ADDRESS, id("to"), payee.address), field(FieldType.UINT256, id("amount"), 5n)])
    ).to.be.revertedWithCustomError(h, "CallReverted");
  });
});
