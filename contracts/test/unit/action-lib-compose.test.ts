/**
 * ActionLib.composeCalldata — byte-identity (R4 core).
 *
 * The composed calldata (selector ++ encoded fixed-size arg words, substituting each
 * dynamic ArgSlot by argument index with its canonical resolved word) must be
 * BYTE-IDENTICAL to abi.encodeWithSelector(selector, ...finalArgs), i.e. what
 * ethers' Interface.encodeFunctionData produces for the same final values.
 *
 * Coverage: transfer(address,uint256) and transferFrom(address,address,uint256)
 * across boundary amounts (0, 1, type(uint256).max) and addresses (zero, EOA,
 * contract). Mix of dynamic substitution and baked constant slots.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  freshActionLibHarness,
  constSlot,
  dynSlot,
  wordUint,
  wordAddress,
  wordBool,
  wordBytes32,
} from "../helpers/action-lib";
import { FieldType, constRef } from "../helpers/value-lib";

const erc20 = new ethers.Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
]);

const transferSel = erc20.getFunction("transfer")!.selector;
const transferFromSel = erc20.getFunction("transferFrom")!.selector;

const MAX_UINT = (1n << 256n) - 1n;
const ZERO = ethers.ZeroAddress;
const EOA = ethers.getAddress("0x000000000000000000000000000000000000abcd");
// A "contract" address (an arbitrary distinct checksummed address).
const CONTRACTISH = ethers.getAddress("0x00000000000000000000000000000000c0ffee01");

describe("ActionLib.composeCalldata — byte-identity to encodeFunctionData", () => {
  const AMOUNTS = [0n, 1n, MAX_UINT];
  const ADDRS = [ZERO, EOA, CONTRACTISH];

  it("transfer(address,uint256): both dynamic slots, all boundary combos", async () => {
    const h = await freshActionLibHarness();
    for (const to of ADDRS) {
      for (const amount of AMOUNTS) {
        const args = [
          dynSlot(constRef(FieldType.ADDRESS, to)),
          dynSlot(constRef(FieldType.UINT256, amount)),
        ];
        const resolved = [wordAddress(to), wordUint(amount)];
        const composed = await h.composeCalldata(transferSel, args, resolved);
        const expected = erc20.encodeFunctionData("transfer", [to, amount]);
        expect(composed).to.equal(expected);
      }
    }
  });

  it("transferFrom(address,address,uint256): all three dynamic, boundary combos", async () => {
    const h = await freshActionLibHarness();
    for (const from of ADDRS) {
      for (const to of ADDRS) {
        for (const amount of AMOUNTS) {
          const args = [
            dynSlot(constRef(FieldType.ADDRESS, from)),
            dynSlot(constRef(FieldType.ADDRESS, to)),
            dynSlot(constRef(FieldType.UINT256, amount)),
          ];
          const resolved = [wordAddress(from), wordAddress(to), wordUint(amount)];
          const composed = await h.composeCalldata(transferFromSel, args, resolved);
          const expected = erc20.encodeFunctionData("transferFrom", [from, to, amount]);
          expect(composed).to.equal(expected);
        }
      }
    }
  });

  it("mix of baked-constant and dynamic slots composes identically", async () => {
    const h = await freshActionLibHarness();
    const from = EOA;
    const to = CONTRACTISH;
    const amount = 123456789n;
    // from is baked as a constant word; to and amount are dynamic substitutions.
    const args = [
      constSlot(wordAddress(from)),
      dynSlot(constRef(FieldType.ADDRESS, to)),
      dynSlot(constRef(FieldType.UINT256, amount)),
    ];
    // resolved is consulted only for dynamic slots; non-dynamic entries are ignored.
    const resolved = ["0x", wordAddress(to), wordUint(amount)];
    const composed = await h.composeCalldata(transferFromSel, args, resolved);
    const expected = erc20.encodeFunctionData("transferFrom", [from, to, amount]);
    expect(composed).to.equal(expected);
  });

  it("all baked-constant slots composes identically (fully pre-baked call)", async () => {
    const h = await freshActionLibHarness();
    const to = EOA;
    const amount = 7n;
    const args = [constSlot(wordAddress(to)), constSlot(wordUint(amount))];
    const resolved = ["0x", "0x"];
    const composed = await h.composeCalldata(transferSel, args, resolved);
    const expected = erc20.encodeFunctionData("transfer", [to, amount]);
    expect(composed).to.equal(expected);
  });
});

describe("ActionLib.composeCalldata — BOOL / BYTES32 byte-identity", () => {
  const boolIface = new ethers.Interface([
    "function setFlag(bool on, bytes32 ref) returns (bool)",
  ]);
  const setFlagSel = boolIface.getFunction("setFlag")!.selector;

  for (const on of [false, true]) {
    for (const ref of [ethers.ZeroHash, ethers.id("a-ref"), "0x" + "ff".repeat(32)]) {
      it(`setFlag(${on}, ${ref.slice(0, 10)}…) composes byte-identically`, async () => {
        const h = await freshActionLibHarness();
        const args = [
          dynSlot(constRef(FieldType.BOOL, on)),
          dynSlot(constRef(FieldType.BYTES32, ref)),
        ];
        const resolved = [wordBool(on), wordBytes32(ref)];
        const composed = await h.composeCalldata(setFlagSel, args, resolved);
        const expected = boolIface.encodeFunctionData("setFlag", [on, ref]);
        expect(composed).to.equal(expected);
      });
    }
  }
});

describe("ActionLib.composeCalldata — structural rejections", () => {
  it("rejects a resolved-words count != args count (ResolvedArityMismatch)", async () => {
    const h = await freshActionLibHarness();
    const args = [dynSlot(constRef(FieldType.UINT256, 1n)), dynSlot(constRef(FieldType.UINT256, 2n))];
    const resolved = [wordUint(1n)]; // one short
    await expect(h.composeCalldata("0xaabbccdd", args, resolved)).to.be.revertedWithCustomError(
      h,
      "ResolvedArityMismatch"
    );
  });

  it("rejects a dynamic slot whose resolved word is not exactly 32 bytes (NonWordResolved)", async () => {
    const h = await freshActionLibHarness();
    const args = [dynSlot(constRef(FieldType.UINT256, 1n))];
    const resolved = ["0x" + "ab".repeat(31)]; // 31 bytes, not a word
    await expect(h.composeCalldata("0xaabbccdd", args, resolved)).to.be.revertedWithCustomError(
      h,
      "NonWordResolved"
    );
  });
});

describe("ActionLib.composeCalldata — property: arbitrary arg count + order", () => {
  // A fuzz-style sweep over arg counts and a mix of word types/slot kinds; the composed
  // calldata must always equal abi.encodeWithSelector for the same final words.
  const TYPES = ["uint256", "address", "bool", "bytes32"] as const;
  function sample(t: (typeof TYPES)[number], seed: number) {
    if (t === "uint256") return BigInt(seed) * 7n + 1n;
    if (t === "address") return ethers.getAddress("0x" + (BigInt(seed) + 0x1000n).toString(16).padStart(40, "0"));
    if (t === "bool") return seed % 2 === 1;
    return ethers.id("bytes32-" + seed);
  }
  function word(t: (typeof TYPES)[number], v: any) {
    if (t === "uint256") return wordUint(v);
    if (t === "address") return wordAddress(v);
    if (t === "bool") return wordBool(v);
    return wordBytes32(v);
  }
  function ft(t: (typeof TYPES)[number]) {
    if (t === "uint256") return FieldType.UINT256;
    if (t === "address") return FieldType.ADDRESS;
    if (t === "bool") return FieldType.BOOL;
    return FieldType.BYTES32;
  }

  it("composes byte-identically for randomized arg signatures (counts 0..6)", async () => {
    const h = await freshActionLibHarness();
    let seed = 1;
    for (let n = 0; n <= 6; n++) {
      for (let trial = 0; trial < 4; trial++) {
        const types: (typeof TYPES)[number][] = [];
        const values: any[] = [];
        const args: any[] = [];
        const resolved: string[] = [];
        for (let i = 0; i < n; i++) {
          const t = TYPES[(seed + i) % TYPES.length];
          const v = sample(t, seed + i * 13);
          types.push(t);
          values.push(v);
          // Alternate baked vs dynamic slots; baked words must equal the same final word.
          if ((seed + i) % 2 === 0) {
            args.push(constSlot(word(t, v)));
            resolved.push("0x");
          } else {
            args.push(dynSlot(constRef(ft(t), v)));
            resolved.push(word(t, v));
          }
          seed++;
        }
        const sig = `f(${types.join(",")})`;
        const iface = new ethers.Interface([`function ${sig}`]);
        const sel = iface.getFunction("f")!.selector;
        const composed = await h.composeCalldata(sel, args, resolved);
        const expected = iface.encodeFunctionData("f", values);
        expect(composed, sig).to.equal(expected);
      }
    }
  });
});
