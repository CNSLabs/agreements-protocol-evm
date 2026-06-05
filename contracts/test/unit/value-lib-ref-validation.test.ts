/**
 * ValueLib.validateRef / staticType — the single-ValueRef init-time gate, now exposed
 * for reuse by ActionLib (action target + dynamic-arg refs must get the same canonical /
 * source-legality validation that condition operands get). These wrap the R2 private
 * helpers; this test pins the exposed surface and its behavior directly.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  FieldType,
  ValueSource,
  constRef,
  varRef,
  fieldRef,
  synthRef,
  staticCallRef,
  rawRef,
  freshValueLibHarness,
  id,
} from "../helpers/value-lib";

const coder = ethers.AbiCoder.defaultAbiCoder();

describe("ValueLib.validateRef — exposed single-ref init gate", () => {
  it("accepts a canonical CONST address and a well-formed VAR/FIELD id", async () => {
    const h = await freshValueLibHarness();
    await h.validateRef(constRef(FieldType.ADDRESS, ethers.getAddress("0x000000000000000000000000000000000000abcd")));
    await h.validateRef(varRef(FieldType.ADDRESS, id("v")));
    await h.validateRef(fieldRef(FieldType.UINT256, id("f")));
    await h.validateRef(synthRef(ValueSource.AUTH_SIGNER, FieldType.ADDRESS));
  });

  it("rejects a CONST ADDRESS with dirty high bytes (non-canonical) -> MalformedValue", async () => {
    const h = await freshValueLibHarness();
    // 32-byte word with a non-zero byte above the 20-byte address region.
    const dirty = "0x" + "ff" + "00".repeat(11) + "11".repeat(20);
    await expect(
      h.validateRef(rawRef(ValueSource.CONST, FieldType.ADDRESS, dirty))
    ).to.be.revertedWithCustomError(h, "MalformedValue");
  });

  it("rejects a CONST BOOL that is not 0 or 1 (non-canonical) -> MalformedValue", async () => {
    const h = await freshValueLibHarness();
    const two = coder.encode(["uint256"], [2n]); // a 32-byte word == 2, decoded as bool
    await expect(
      h.validateRef(rawRef(ValueSource.CONST, FieldType.BOOL, two))
    ).to.be.revertedWithCustomError(h, "MalformedValue");
  });

  it("rejects a VAR ref whose id data is not a decodable bytes32", async () => {
    const h = await freshValueLibHarness();
    // 31-byte data cannot abi.decode to bytes32.
    const bad = "0x" + "ab".repeat(31);
    await expect(h.validateRef(rawRef(ValueSource.VAR, FieldType.UINT256, bad))).to.be.reverted;
  });

  it("accepts a well-formed STATIC_CALL ref (R6: validates the embedded spec)", async () => {
    const h = await freshValueLibHarness();
    await h.validateRef(
      staticCallRef(FieldType.UINT256, {
        target: ethers.getAddress("0x000000000000000000000000000000000000abcd"),
        selector: "0xaabbccdd",
      })
    );
  });

  it("rejects a STATIC_CALL ref whose spec data is undecodable (R6)", async () => {
    const h = await freshValueLibHarness();
    // synthRef leaves data == "0x"; the spec cannot be abi.decoded -> revert.
    await expect(h.validateRef(synthRef(ValueSource.STATIC_CALL, FieldType.UINT256))).to.be
      .reverted;
  });
});

describe("ValueLib.staticType — exposed source-derived type", () => {
  it("synthesized sources fix the type regardless of declared vType", async () => {
    const h = await freshValueLibHarness();
    // AUTH_SIGNER/CALLER/SELF -> ADDRESS; NOW/FIELD_LENGTH -> UINT256.
    expect(Number(await h.staticType(rawRef(ValueSource.AUTH_SIGNER, FieldType.UINT256, "0x")))).to.equal(
      FieldType.ADDRESS
    );
    expect(Number(await h.staticType(rawRef(ValueSource.NOW, FieldType.ADDRESS, "0x")))).to.equal(
      FieldType.UINT256
    );
  });

  it("CONST/VAR/FIELD carry their declared vType", async () => {
    const h = await freshValueLibHarness();
    expect(Number(await h.staticType(constRef(FieldType.BYTES32, ethers.id("x"))))).to.equal(
      FieldType.BYTES32
    );
    expect(Number(await h.staticType(varRef(FieldType.BOOL, id("b"))))).to.equal(FieldType.BOOL);
  });
});
