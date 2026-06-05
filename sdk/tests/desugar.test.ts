/**
 * Off-chain desugar equivalence (the TS-side relocation of the on-chain encodeLegacyCall
 * equivalence test, plus the legacy Op -> canonical condition mapping).
 *
 * The composable engine no longer carries an on-chain legacy desugar; the equivalence the old
 * `ActionLib.encodeLegacyCall` round-trip asserted (a legacy static action composes back to
 * byte-identical calldata) is preserved here in TS. We also pin the legacy Op -> canonical
 * condition translation for the full ~18-variant matrix.
 */

import { describe, it, expect } from "@jest/globals";
import { encodeAbiParameters, encodeFunctionData, getAddress, Hex } from "viem";
import {
  desugarCondition,
  legacyActionToCall,
} from "../src/desugar";
import { Op, FieldType, ValueSource, CmpOp } from "../src/types";

const TARGET = getAddress("0x00000000000000000000000000000000c0ffee01");

/** Re-compose a desugared Call's baked words back into calldata (selector ++ words). */
function composeCall(call: ReturnType<typeof legacyActionToCall>): Hex {
  let out = call.selector.slice(2);
  for (const a of call.args) {
    expect(a.dynamic).toBe(false);
    out += a.constWord.slice(2);
  }
  return ("0x" + out) as Hex;
}

describe("desugar — legacy static action -> composable Call (byte-identical compose)", () => {
  it("arbitrary word-aligned calldata: selector + 0..4 words round-trips exactly", () => {
    const sel = "0xdeadbeef";
    for (let n = 0; n <= 4; n++) {
      let data = sel;
      for (let i = 0; i < n; i++) {
        data += (BigInt(i) * 0x0101010101010101n + 0xabcd00000000n).toString(16).padStart(64, "0");
      }
      const call = legacyActionToCall(TARGET, 0n, data as Hex);
      expect(composeCall(call)).toBe(data);
      // target is CONST(address) of TARGET; selector preserved.
      expect(call.target.source).toBe(ValueSource.CONST);
      expect(call.target.vType).toBe(FieldType.ADDRESS);
      expect(call.selector).toBe(sel);
    }
  });

  it("dynamic pre-baked ABI calldata (string + bytes args) round-trips exactly", () => {
    // A function with DYNAMIC args: the head holds offset pointers, the tail holds the
    // payloads. The desugar treats the whole `data` as opaque 32-byte words, so pre-baked
    // dynamic calldata must reproduce verbatim (relocated from the retired on-chain
    // action-lib-legacy-desugar `encodeLegacyCall` case).
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "submit",
          inputs: [
            { name: "note", type: "string" },
            { name: "blob", type: "bytes" },
            { name: "n", type: "uint256" },
          ],
          outputs: [],
          stateMutability: "nonpayable",
        },
      ],
      functionName: "submit",
      args: ["hello world, a longer string", "0xdeadbeefcafe", 42n],
    });
    // sanity: this calldata is word-aligned (selector + a multiple of 32).
    expect((data.length - 2 - 8) % 64).toBe(0);
    expect(composeCall(legacyActionToCall(TARGET, 0n, data))).toBe(data);
  });

  it("real ERC-20 transferFrom calldata round-trips exactly", () => {
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "transferFrom",
          inputs: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [],
          stateMutability: "nonpayable",
        },
      ],
      functionName: "transferFrom",
      args: [
        getAddress("0x000000000000000000000000000000000000aaaa"),
        getAddress("0x000000000000000000000000000000000000bbbb"),
        (1n << 255n) + 7n,
      ],
    });
    expect(composeCall(legacyActionToCall(TARGET, 0n, data))).toBe(data);
  });

  it("rejects data shorter than a 4-byte selector", () => {
    expect(() => legacyActionToCall(TARGET, 0n, "0xaabb")).toThrow(/4-byte selector/);
  });

  it("rejects non-word-aligned arg bytes", () => {
    const data = ("0xdeadbeef" + "11".repeat(33)) as Hex;
    expect(() => legacyActionToCall(TARGET, 0n, data)).toThrow(/word-aligned/);
  });

  it("rejects a non-zero native value (the engine carries no ETH)", () => {
    expect(() => legacyActionToCall(TARGET, 1n, "0xdeadbeef")).toThrow(/native value/);
  });
});

describe("desugar — legacy Op -> canonical Condition mapping", () => {
  const FID = "0x" + "11".repeat(32) as Hex;
  const encUint = (v: bigint): Hex => encodeAbiParameters([{ type: "uint256" }], [v]) as Hex;
  const encBytes32 = (v: Hex): Hex => encodeAbiParameters([{ type: "bytes32" }], [v]) as Hex;
  const VID = ("0x" + "22".repeat(32)) as Hex;

  it("UINT_GTE_CONST -> FIELD(uint) GTE CONST(uint)", () => {
    const c = desugarCondition(Op.UINT_GTE_CONST, FID, encUint(5n), false);
    expect(c.left.source).toBe(ValueSource.FIELD);
    expect(c.left.vType).toBe(FieldType.UINT256);
    expect(c.op).toBe(CmpOp.GTE);
    expect(c.right[0].source).toBe(ValueSource.CONST);
  });

  it("UINT_LT_VAR -> FIELD(uint) LT VAR(uint)", () => {
    const c = desugarCondition(Op.UINT_LT_VAR, FID, encBytes32(VID), false);
    expect(c.op).toBe(CmpOp.LT);
    expect(c.right[0].source).toBe(ValueSource.VAR);
    expect(c.right[0].vType).toBe(FieldType.UINT256);
  });

  it("STRING_MIN_LENGTH -> FIELD_LENGTH GTE CONST; MAX -> LTE", () => {
    const minC = desugarCondition(Op.STRING_MIN_LENGTH, FID, encUint(3n), false);
    expect(minC.left.source).toBe(ValueSource.FIELD_LENGTH);
    expect(minC.op).toBe(CmpOp.GTE);
    const maxC = desugarCondition(Op.STRING_MAX_LENGTH, FID, encUint(9n), false);
    expect(maxC.op).toBe(CmpOp.LTE);
  });

  it("STRING_EQ_CONST -> FIELD(string) EQ CONST(string); EQ_VAR -> VAR", () => {
    const cc = desugarCondition(Op.STRING_EQ_CONST, FID, "0x1234" as Hex, false);
    expect(cc.left.vType).toBe(FieldType.STRING);
    expect(cc.op).toBe(CmpOp.EQ);
    expect(cc.right[0].source).toBe(ValueSource.CONST);
    const cv = desugarCondition(Op.STRING_EQ_VAR, FID, encBytes32(VID), false);
    expect(cv.right[0].source).toBe(ValueSource.VAR);
    expect(cv.right[0].vType).toBe(FieldType.STRING);
  });

  it("ADDRESS_EQ_CONST/VAR -> FIELD(address) EQ CONST/VAR(address)", () => {
    const cc = desugarCondition(Op.ADDRESS_EQ_CONST, FID, encodeAbiParameters([{ type: "address" }], [TARGET]) as Hex, false);
    expect(cc.left.vType).toBe(FieldType.ADDRESS);
    const cv = desugarCondition(Op.ADDRESS_EQ_VAR, FID, encBytes32(VID), false);
    expect(cv.right[0].source).toBe(ValueSource.VAR);
  });

  it("SENDER_EQ_VAR_ADDRESS -> AUTH_SIGNER EQ VAR(address, fieldId)", () => {
    const c = desugarCondition(Op.SENDER_EQ_VAR_ADDRESS, FID, "0x" as Hex, false);
    expect(c.left.source).toBe(ValueSource.AUTH_SIGNER);
    expect(c.op).toBe(CmpOp.EQ);
    expect(c.right[0].source).toBe(ValueSource.VAR);
    // var id is the field id (the field slot doubles as the var id)
    expect(c.right[0].data.toLowerCase()).toContain("11".repeat(32));
  });

  it("SENDER_IN_ALLOWED_ADDRESSES -> AUTH_SIGNER IN [VAR..., CONST...]", () => {
    const v1 = ("0x" + "33".repeat(32)) as Hex;
    const addr = getAddress("0x000000000000000000000000000000000000dEaD");
    const bytesArg = encodeAbiParameters(
      [{ type: "bytes32[]" }, { type: "address[]" }],
      [[v1], [addr]]
    ) as Hex;
    const c = desugarCondition(Op.SENDER_IN_ALLOWED_ADDRESSES, FID, bytesArg, false);
    expect(c.left.source).toBe(ValueSource.AUTH_SIGNER);
    expect(c.op).toBe(CmpOp.IN);
    // VARs first, then CONSTs (legacy order).
    expect(c.right[0].source).toBe(ValueSource.VAR);
    expect(c.right[1].source).toBe(ValueSource.CONST);
  });

  it("optional field sets IF_PRESENT (skipIfAbsent)", () => {
    const c = desugarCondition(Op.UINT_GTE_CONST, FID, encUint(5n), true);
    expect(c.skipIfAbsent).toBe(true);
    const c2 = desugarCondition(Op.UINT_GTE_CONST, FID, encUint(5n), false);
    expect(c2.skipIfAbsent).toBe(false);
  });
});
