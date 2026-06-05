/**
 * ValueLib — canonical-bytes contract (R2 hardening, gaps 3 & 7).
 *
 * resolve's contract is "returns canonically-encoded bytes". VAR/FIELD already pass
 * through engine storage/input validation; CONST is author-supplied raw bytes, so a
 * malformed CONST must be rejected at INIT (validateLegality), not survive to runtime.
 *
 * Also asserts the exact canonical-bytes identity: resolve(ref) == abi.encode(decoded)
 * for each type, and that malformed words/dynamic payloads are caught.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  FieldType,
  ValueSource,
  CmpOp,
  type FieldTypeVal,
  constRef,
  rawRef,
  cond,
  freshValueLibHarness,
  encFor,
  coder,
} from "../helpers/value-lib";

const ADDR = ethers.getAddress("0x000000000000000000000000000000000000a11e");
const B32 = ethers.id("a-bytes32");

// A scalar EQ condition wrapping a single CONST left, for validateLegality input.
function constEqSelf(fType: FieldTypeVal, v: any) {
  return cond(constRef(fType, v), CmpOp.EQ, constRef(fType, v));
}

// Build a CONST ValueRef with arbitrary raw data bytes (to inject malformed encodings).
function rawConst(fType: FieldTypeVal, data: string) {
  return rawRef(ValueSource.CONST, fType, data);
}

describe("ValueLib canonical — well-formed CONST passes init validation", () => {
  const samples: Array<[FieldTypeVal, any, string]> = [
    [FieldType.UINT256, 42n, "UINT256"],
    [FieldType.STRING, "hi", "STRING"],
    [FieldType.ADDRESS, ADDR, "ADDRESS"],
    [FieldType.BOOL, true, "BOOL"],
    [FieldType.BYTES32, B32, "BYTES32"],
    [FieldType.BYTES, "0xdeadbeef", "BYTES"],
  ];
  for (const [fType, v, name] of samples) {
    it(`${name}: canonical CONST validates`, async () => {
      const h = await freshValueLibHarness();
      await h.validateLegality(constEqSelf(fType, v)); // must not revert
    });
  }
});

describe("ValueLib canonical — malformed fixed-width CONST rejected at init", () => {
  it("UINT256 word too short (31 bytes) reverts", async () => {
    const h = await freshValueLibHarness();
    const short = "0x" + "00".repeat(31);
    await expect(
      h.validateLegality(cond(rawConst(FieldType.UINT256, short), CmpOp.EQ, constRef(FieldType.UINT256, 1n)))
    ).to.be.reverted;
  });

  it("UINT256 word too long (33 bytes) reverts", async () => {
    const h = await freshValueLibHarness();
    const long = "0x" + "00".repeat(33);
    await expect(
      h.validateLegality(cond(rawConst(FieldType.UINT256, long), CmpOp.EQ, constRef(FieldType.UINT256, 1n)))
    ).to.be.reverted;
  });

  it("ADDRESS with dirty high bytes (non-canonical) reverts", async () => {
    const h = await freshValueLibHarness();
    // 32 bytes where bytes above the low 20 are nonzero — not a canonical address word.
    const dirty = "0x" + "ff".repeat(12) + "00".repeat(20);
    await expect(
      h.validateLegality(cond(rawConst(FieldType.ADDRESS, dirty), CmpOp.EQ, constRef(FieldType.ADDRESS, ADDR)))
    ).to.be.reverted;
  });

  it("BOOL with a non-0/1 word reverts", async () => {
    const h = await freshValueLibHarness();
    const two = coder.encode(["uint256"], [2n]); // 0x...02, not a canonical bool
    await expect(
      h.validateLegality(cond(rawConst(FieldType.BOOL, two), CmpOp.EQ, constRef(FieldType.BOOL, true)))
    ).to.be.reverted;
  });

  it("BYTES32 word too short reverts", async () => {
    const h = await freshValueLibHarness();
    const short = "0x" + "11".repeat(16);
    await expect(
      h.validateLegality(cond(rawConst(FieldType.BYTES32, short), CmpOp.EQ, constRef(FieldType.BYTES32, B32)))
    ).to.be.reverted;
  });
});

describe("ValueLib canonical — malformed dynamic CONST rejected at init", () => {
  it("STRING with truncated payload (bad length prefix) reverts", async () => {
    const h = await freshValueLibHarness();
    // Offset=0x20, length=0x40 (64) but no payload bytes follow → malformed.
    const bad =
      "0x" +
      "0000000000000000000000000000000000000000000000000000000000000020" +
      "0000000000000000000000000000000000000000000000000000000000000040";
    await expect(
      h.validateLegality(cond(rawConst(FieldType.STRING, bad), CmpOp.EQ, constRef(FieldType.STRING, "x")))
    ).to.be.reverted;
  });

  it("BYTES with a too-short blob reverts", async () => {
    const h = await freshValueLibHarness();
    const bad = "0x" + "0000000000000000000000000000000000000000000000000000000000000020";
    await expect(
      h.validateLegality(cond(rawConst(FieldType.BYTES, bad), CmpOp.EQ, constRef(FieldType.BYTES, "0x00")))
    ).to.be.reverted;
  });
});

describe("ValueLib canonical — malformed VAR/FIELD/FIELD_LENGTH id data rejected at init", () => {
  // VAR/FIELD/FIELD_LENGTH ref.data must abi.decode to a bytes32 id; short data reverts.
  const shortData = "0x" + "00".repeat(16); // 16 bytes, not a decodable bytes32

  it("VAR with non-bytes32 data reverts at init", async () => {
    const h = await freshValueLibHarness();
    const ref = rawRef(ValueSource.VAR, FieldType.UINT256, shortData);
    await expect(h.validateLegality(cond(ref, CmpOp.EQ, constRef(FieldType.UINT256, 1n)))).to.be.reverted;
  });

  it("FIELD with non-bytes32 data reverts at init", async () => {
    const h = await freshValueLibHarness();
    const ref = rawRef(ValueSource.FIELD, FieldType.UINT256, shortData);
    await expect(h.validateLegality(cond(ref, CmpOp.EQ, constRef(FieldType.UINT256, 1n)))).to.be.reverted;
  });

  it("FIELD_LENGTH with non-bytes32 data reverts at init", async () => {
    const h = await freshValueLibHarness();
    const ref = rawRef(ValueSource.FIELD_LENGTH, FieldType.UINT256, shortData);
    await expect(h.validateLegality(cond(ref, CmpOp.GTE, constRef(FieldType.UINT256, 1n)))).to.be.reverted;
  });
});

describe("ValueLib canonical — resolve returns exactly abi.encode(decoded)", () => {
  const samples: Array<[FieldTypeVal, any, string, string]> = [
    [FieldType.UINT256, 42n, "uint256", "UINT256"],
    [FieldType.ADDRESS, ADDR, "address", "ADDRESS"],
    [FieldType.BOOL, true, "bool", "BOOL"],
    [FieldType.BYTES32, B32, "bytes32", "BYTES32"],
    [FieldType.STRING, "hello", "string", "STRING"],
    [FieldType.BYTES, "0xdeadbeef", "bytes", "BYTES"],
  ];
  for (const [fType, v, abiType, name] of samples) {
    it(`${name}: resolve(CONST) bytes == abi.encode(value)`, async () => {
      const h = await freshValueLibHarness();
      const [t, d] = await h.resolve(constRef(fType, v), []);
      expect(Number(t)).to.equal(fType);
      expect(d).to.equal(encFor(fType, v));
      // And it round-trips through decode to the original value.
      expect(coder.decode([abiType], d)[0]).to.deep.equal(coder.decode([abiType], encFor(fType, v))[0]);
    });
  }
});
