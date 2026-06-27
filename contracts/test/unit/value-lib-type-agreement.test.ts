/**
 * ValueLib — type agreement between validateLegality and resolve (R2 hardening, gap 1).
 *
 * The resolved type of a synthesized/derived source is fixed by the SOURCE, not by the
 * author-declared `vType`. validateLegality and resolve must derive the comparison type
 * from the same rule, and a misdeclared `vType` must be rejected consistently (TypeMismatch
 * at resolve; the legality gate uses the source-derived type so it can't be fooled).
 *
 *   AUTH_SIGNER / CALLER / SELF -> ADDRESS
 *   NOW                          -> UINT256
 *   FIELD_LENGTH                 -> UINT256
 *   CONST / VAR / FIELD          -> ref.vType (validated against the value at resolve)
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  FieldType,
  ValueSource,
  CmpOp,
  constRef,
  synthRef,
  cond,
  freshValueLibHarness,
} from "../helpers/value-lib";

const ADDR = ethers.getAddress("0x000000000000000000000000000000000000a11e");

describe("ValueLib — source-derived type: misdeclared synthesized vType is rejected", () => {
  it("AUTH_SIGNER declared as UINT256 reverts TypeMismatch at resolve (not silently ADDRESS)", async () => {
    const h = await freshValueLibHarness();
    await expect(h.resolve(synthRef(ValueSource.AUTH_SIGNER, FieldType.UINT256), []))
      .to.be.revertedWithCustomError(h, "TypeMismatch");
  });

  it("NOW declared as ADDRESS reverts TypeMismatch at resolve", async () => {
    const h = await freshValueLibHarness();
    await expect(h.resolve(synthRef(ValueSource.NOW, FieldType.ADDRESS), []))
      .to.be.revertedWithCustomError(h, "TypeMismatch");
  });

  it("SELF declared as BYTES32 reverts TypeMismatch at resolve", async () => {
    const h = await freshValueLibHarness();
    await expect(h.resolve(synthRef(ValueSource.SELF, FieldType.BYTES32), []))
      .to.be.revertedWithCustomError(h, "TypeMismatch");
  });

  it("AUTH_SIGNER declared correctly as ADDRESS still resolves", async () => {
    const h = await freshValueLibHarness();
    await h.setContext(ADDR, ethers.ZeroAddress, await h.getAddress(), 0n);
    const [t, d] = await h.resolve(synthRef(ValueSource.AUTH_SIGNER, FieldType.ADDRESS), []);
    expect(Number(t)).to.equal(FieldType.ADDRESS);
    expect(ethers.AbiCoder.defaultAbiCoder().decode(["address"], d)[0]).to.equal(ADDR);
  });
});

describe("ValueLib — validateLegality uses the source-derived type", () => {
  it("AUTH_SIGNER-as-UINT256 GT is rejected at init (mis-declared vType caught as TypeMismatch)", async () => {
    const h = await freshValueLibHarness();
    // Author lies: declares UINT256 to sneak an ordered op past the gate. The gate uses
    // the source-derived ADDRESS type, so the UINT256 RHS no longer matches → rejected at
    // init (TypeMismatch — the more fundamental defect — rather than slipping to eval).
    const c = cond(synthRef(ValueSource.AUTH_SIGNER, FieldType.UINT256), CmpOp.GT, constRef(FieldType.UINT256, 1n));
    await expect(h.validateLegality(c)).to.be.revertedWithCustomError(h, "TypeMismatch");
  });

  it("AUTH_SIGNER GT AUTH_SIGNER (both ADDRESS) is rejected at init as IllegalComparison (ordered-on-ADDRESS)", async () => {
    const h = await freshValueLibHarness();
    // Well-typed but illegal: ordered comparison on the source-derived ADDRESS type.
    const c = cond(
      synthRef(ValueSource.AUTH_SIGNER, FieldType.ADDRESS),
      CmpOp.GT,
      synthRef(ValueSource.CALLER, FieldType.ADDRESS)
    );
    await expect(h.validateLegality(c)).to.be.revertedWithCustomError(h, "IllegalComparison");
  });

  it("AUTH_SIGNER-as-STRING is rejected at init as TypeMismatch (mis-declared synthesized vType)", async () => {
    const h = await freshValueLibHarness();
    // Author mis-declares STRING on a synthesized source. The init validator catches the
    // vType lie directly (STRING != source-fixed ADDRESS) — the legality gate's
    // source-derived type and the ref validation agree, so it can't slip through.
    const c = cond(synthRef(ValueSource.AUTH_SIGNER, FieldType.STRING), CmpOp.IN, [constRef(FieldType.ADDRESS, ADDR)]);
    await expect(h.validateLegality(c)).to.be.revertedWithCustomError(h, "TypeMismatch");
  });

  it("AUTH_SIGNER (correctly ADDRESS) IN an address set passes init legality", async () => {
    const h = await freshValueLibHarness();
    const c = cond(synthRef(ValueSource.AUTH_SIGNER, FieldType.ADDRESS), CmpOp.IN, [constRef(FieldType.ADDRESS, ADDR)]);
    await h.validateLegality(c); // ADDRESS is IN-legal; well-typed → passes
  });

  it("NOW GT (true type UINT256) passes init legality", async () => {
    const h = await freshValueLibHarness();
    const c = cond(synthRef(ValueSource.NOW, FieldType.UINT256), CmpOp.GT, constRef(FieldType.UINT256, 1n));
    await h.validateLegality(c); // UINT256 ordered legal
  });
});
