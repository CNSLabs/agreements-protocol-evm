/**
 * Unit coverage for IF_PRESENT (presence-aware conditions) at the ValueLib level.
 *
 * A condition marked skipIfAbsent (IF_PRESENT) whose target field is absent is
 * skipped (treated as satisfied). When the field is present it evaluates normally.
 * A condition NOT marked skipIfAbsent reverts FieldAbsent when its field is absent
 * (the explicit-over-silent default).
 */

import { expect } from "chai";
import { ethers } from "hardhat";

const coder = ethers.AbiCoder.defaultAbiCoder();
const id = (s: string) => ethers.id(s);

// FieldType / ValueSource / CmpOp mirrors (AgreementTypes ordinals)
const FieldType = { UINT256: 0, STRING: 1, ADDRESS: 2, BOOL: 3, BYTES32: 4, BYTES: 5 };
const Source = { CONST: 0, VAR: 1, FIELD: 2, FIELD_LENGTH: 3 };
const Cmp = { EQ: 0, NEQ: 1, GT: 2, GTE: 3, LT: 4, LTE: 5, IN: 6, NOT_IN: 7 };

const FID = id("amount");
const encUint = (v: bigint) => coder.encode(["uint256"], [v]);

// Build a Condition tuple: FIELD(amount) GT CONST(threshold), with the given presence flag.
function gtCondition(threshold: bigint, skipIfAbsent: boolean) {
  return [
    [Source.FIELD, FieldType.UINT256, coder.encode(["bytes32"], [FID])], // left
    Cmp.GT, // op
    skipIfAbsent, // skipIfAbsent
    [[Source.CONST, FieldType.UINT256, encUint(threshold)]], // right (one ValueRef)
  ];
}

const amountField = (v: bigint) => [FID, FieldType.UINT256, encUint(v)];

const VID = id("threshold");
const encBytes32 = (v: string) => coder.encode(["bytes32"], [v]);

// FIELD(amount) <op> VAR(threshold), with the given presence flag and value type.
function eqVarCondition(skipIfAbsent: boolean, vType = FieldType.UINT256) {
  return [
    [Source.FIELD, vType, coder.encode(["bytes32"], [FID])], // left
    Cmp.EQ, // op
    skipIfAbsent,
    [[Source.VAR, vType, encBytes32(VID)]], // right: VAR(threshold)
  ];
}

describe("IF_PRESENT (presence-aware conditions)", () => {
  let harness: any;

  before(async () => {
    harness = await ethers.deployContract("ValueLibHarness");
    await harness.waitForDeployment();
  });

  it("marked IF_PRESENT: skips (no revert) when the field is absent", async () => {
    // skipIfAbsent = true, no fields supplied -> condition is skipped.
    await harness.check(gtCondition(5n, true), []);
  });

  it("marked IF_PRESENT: evaluates normally when the field is present (passes)", async () => {
    await harness.check(gtCondition(5n, true), [amountField(10n)]); // 10 > 5 -> ok
  });

  it("marked IF_PRESENT: evaluates normally when the field is present (fails)", async () => {
    await expect(harness.check(gtCondition(5n, true), [amountField(3n)])) // 3 > 5 -> false
      .to.be.revertedWithCustomError(harness, "ComparisonFailed");
  });

  it("NOT marked IF_PRESENT: reverts FieldAbsent when the field is absent", async () => {
    await expect(harness.check(gtCondition(5n, false), []))
      .to.be.revertedWithCustomError(harness, "FieldAbsent")
      .withArgs(FID);
  });

  it("NOT marked IF_PRESENT: evaluates normally when present", async () => {
    await harness.check(gtCondition(5n, false), [amountField(10n)]); // 10 > 5 -> ok
  });

  // --- skip-before-resolve: the presence skip must short-circuit BEFORE the RHS
  //     VAR operand is resolved, so an unset/wrong-type RHS var must NOT revert.
  it("IF_PRESENT skips before resolving the RHS var when the field is absent (var unset)", async () => {
    // threshold var intentionally not set; field absent -> must skip, not revert VarNotSet.
    await harness.check(eqVarCondition(true), []);
  });

  it("IF_PRESENT skips before resolving the RHS var when the field is absent (var wrong type)", async () => {
    // Set threshold as ADDRESS while the condition expects a UINT VAR; field absent ->
    // must skip BEFORE the type check, not revert TypeMismatch.
    await harness.setVar(VID, FieldType.ADDRESS, coder.encode(["address"], [ethers.ZeroAddress]));
    await harness.check(eqVarCondition(true), []);
  });

  it("IF_PRESENT with VAR RHS: when the field IS present, the RHS var resolves normally (pass)", async () => {
    await harness.setVar(VID, FieldType.UINT256, encUint(7n));
    await harness.check(eqVarCondition(true), [amountField(7n)]); // 7 == 7 -> ok
  });

  it("IF_PRESENT with VAR RHS: when the field IS present, the RHS var resolves normally (fail)", async () => {
    await harness.setVar(VID, FieldType.UINT256, encUint(7n));
    await expect(harness.check(eqVarCondition(true), [amountField(8n)])) // 8 != 7 -> false
      .to.be.revertedWithCustomError(harness, "ComparisonFailed");
  });
});
