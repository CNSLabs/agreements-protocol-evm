/**
 * ActionLib.validateCall — action target + dynamic-arg ValueRefs get the SAME init-time
 * gate that condition operands get (the MAJOR fix). validateCall must:
 *   - validateRef the target and require its staticType == ADDRESS;
 *   - for each dynamic ArgSlot.value: validateRef + require a word-sized staticType,
 *     rejecting dynamic (STRING/BYTES) types, and firing the canonical CONST check (dirty
 *     ADDRESS, non-0/1 BOOL) and malformed VAR/FIELD id. R6: a STATIC_CALL ref is now
 *     validatable (its spec is checked) rather than rejected as UnsupportedSource — a
 *     well-formed STATIC_CALL target/arg is accepted; a malformed spec is rejected.
 *   - NOT validate the unused value ref of a baked (non-dynamic) slot.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { freshActionLibHarness, call, constSlot, dynSlot, wordUint } from "../helpers/action-lib";
import { FieldType, ValueSource, constRef, varRef, fieldRef, synthRef, staticCallRef, rawRef, id } from "../helpers/value-lib";

const SEL = "0xaabbccdd";
const ADDR = ethers.getAddress("0x000000000000000000000000000000000000abcd");
const coder = ethers.AbiCoder.defaultAbiCoder();

describe("ActionLib.validateCall — target ref validation", () => {
  it("accepts a CONST ADDRESS target and a VAR ADDRESS target", async () => {
    const h = await freshActionLibHarness();
    await h.validateCall(call(constRef(FieldType.ADDRESS, ADDR), SEL, []));
    await h.validateCall(call(varRef(FieldType.ADDRESS, id("t")), SEL, []));
    await h.validateCall(call(synthRef(ValueSource.SELF, FieldType.ADDRESS), SEL, []));
  });

  it("rejects a non-ADDRESS target ref (UINT256 CONST) -> NonAddressTarget", async () => {
    const h = await freshActionLibHarness();
    await expect(
      h.validateCall(call(constRef(FieldType.UINT256, 1n), SEL, []))
    ).to.be.revertedWithCustomError(h, "NonAddressTarget");
  });

  it("rejects a FIELD target whose declared type is UINT256 (not ADDRESS)", async () => {
    const h = await freshActionLibHarness();
    await expect(
      h.validateCall(call(fieldRef(FieldType.UINT256, id("t")), SEL, []))
    ).to.be.revertedWithCustomError(h, "NonAddressTarget");
  });

  it("rejects a CONST ADDRESS target with dirty high bytes (MalformedValue via validateRef)", async () => {
    const h = await freshActionLibHarness();
    const dirty = "0x" + "ff" + "00".repeat(11) + "11".repeat(20);
    await expect(
      h.validateCall(call(rawRef(ValueSource.CONST, FieldType.ADDRESS, dirty), SEL, []))
    ).to.be.revertedWithCustomError(h, "MalformedValue");
  });

  it("accepts a well-formed STATIC_CALL ADDRESS target (R6: validates its spec)", async () => {
    const h = await freshActionLibHarness();
    await h.validateCall(
      call(staticCallRef(FieldType.ADDRESS, { target: ADDR, selector: SEL }), SEL, [])
    );
  });

  it("rejects a STATIC_CALL target with a malformed spec (target 0) -> MalformedStaticCallSpec", async () => {
    const h = await freshActionLibHarness();
    await expect(
      h.validateCall(
        call(staticCallRef(FieldType.ADDRESS, { target: ethers.ZeroAddress, selector: SEL }), SEL, [])
      )
    ).to.be.revertedWithCustomError(h, "MalformedStaticCallSpec");
  });
});

describe("ActionLib.validateCall — dynamic-arg ref validation", () => {
  it("accepts well-formed dynamic word args (FIELD uint, VAR address)", async () => {
    const h = await freshActionLibHarness();
    await h.validateCall(
      call(constRef(FieldType.ADDRESS, ADDR), SEL, [
        dynSlot(fieldRef(FieldType.UINT256, id("a"))),
        dynSlot(varRef(FieldType.ADDRESS, id("b"))),
      ])
    );
  });

  it("rejects a dynamic CONST ADDRESS arg with dirty high bytes at init (MalformedValue)", async () => {
    const h = await freshActionLibHarness();
    const dirty = "0x" + "ab" + "00".repeat(11) + "22".repeat(20);
    await expect(
      h.validateCall(call(constRef(FieldType.ADDRESS, ADDR), SEL, [dynSlot(rawRef(ValueSource.CONST, FieldType.ADDRESS, dirty))]))
    ).to.be.revertedWithCustomError(h, "MalformedValue");
  });

  it("rejects a dynamic CONST BOOL arg that is not 0/1 at init (MalformedValue)", async () => {
    const h = await freshActionLibHarness();
    const two = coder.encode(["uint256"], [2n]);
    await expect(
      h.validateCall(call(constRef(FieldType.ADDRESS, ADDR), SEL, [dynSlot(rawRef(ValueSource.CONST, FieldType.BOOL, two))]))
    ).to.be.revertedWithCustomError(h, "MalformedValue");
  });

  it("rejects a dynamic arg whose VAR id data is not a decodable bytes32", async () => {
    const h = await freshActionLibHarness();
    const bad = "0x" + "cd".repeat(31);
    await expect(
      h.validateCall(call(constRef(FieldType.ADDRESS, ADDR), SEL, [dynSlot(rawRef(ValueSource.VAR, FieldType.UINT256, bad))]))
    ).to.be.reverted;
  });

  it("accepts a well-formed dynamic STATIC_CALL word arg (R6: validates its spec)", async () => {
    const h = await freshActionLibHarness();
    await h.validateCall(
      call(constRef(FieldType.ADDRESS, ADDR), SEL, [
        dynSlot(staticCallRef(FieldType.UINT256, { target: ADDR, selector: SEL })),
      ])
    );
  });

  it("rejects a dynamic STATIC_CALL arg with a non-word vType (STRING) -> MalformedStaticCallSpec", async () => {
    const h = await freshActionLibHarness();
    // A STATIC_CALL decoding to STRING is not a word type; validateRef rejects the spec
    // before the arg-word-type check, so the spec error (not NonWordArg) surfaces.
    await expect(
      h.validateCall(
        call(constRef(FieldType.ADDRESS, ADDR), SEL, [
          dynSlot(staticCallRef(FieldType.STRING, { target: ADDR, selector: SEL })),
        ])
      )
    ).to.be.revertedWithCustomError(h, "MalformedStaticCallSpec");
  });

  it("rejects a dynamic STRING arg (dynamic-type substitution) -> NonWordArg (unchanged)", async () => {
    const h = await freshActionLibHarness();
    await expect(
      h.validateCall(call(constRef(FieldType.ADDRESS, ADDR), SEL, [dynSlot(fieldRef(FieldType.STRING, id("s")))]))
    ).to.be.revertedWithCustomError(h, "NonWordArg");
  });

  it("does NOT validate the unused value ref of a baked (non-dynamic) slot", async () => {
    const h = await freshActionLibHarness();
    // A baked slot's `value` is an ignored zero-ref; its (possibly bogus) contents must
    // not be validated. constSlot is fine; the call should pass.
    await h.validateCall(call(constRef(FieldType.ADDRESS, ADDR), SEL, [constSlot(wordUint(7n))]));
  });
});
