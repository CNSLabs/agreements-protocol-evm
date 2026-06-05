/**
 * R6 — STATIC_CALL value resolution (ValueLib), unit-level.
 *
 * A STATIC_CALL ValueRef performs a BOUNDED read-only external call and decodes the
 * result to a single canonical word of the declared vType. ref.data ABI-encodes a
 * StaticCallSpec { address target; bytes4 selector; bytes args; uint256 gas;
 * uint16 maxReturnBytes; uint8 failMode }.
 *
 * Exercised against a real MockStaticTarget through the ValueLibHarness — no mocks for
 * the lib itself.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  FieldType,
  ValueSource,
  CmpOp,
  FailMode,
  constRef,
  staticCallRef,
  cond,
  rawRef,
  freshValueLibHarness,
} from "../helpers/value-lib";

const iface = new ethers.Interface([
  "function getUint() returns (uint256)",
  "function getAddress() returns (address)",
  "function getBool() returns (bool)",
  "function getBytes32() returns (bytes32)",
  "function echoUint(uint256) returns (uint256)",
  "function getRaw(uint256) returns (uint256)",
  "function boom() returns (uint256)",
  "function returnBomb() returns (bytes)",
  "function getBigWord() returns (uint256)",
  "function returnShort()",
  "function burnGas() returns (uint256)",
  "function splitOnAccess() returns (uint256)",
]);
const SEL = (name: string) => iface.getFunction(name)!.selector;

async function deployTarget(): Promise<any> {
  const t = await ethers.deployContract("MockStaticTarget");
  await t.waitForDeployment();
  return t;
}

const coder = ethers.AbiCoder.defaultAbiCoder();

describe("ValueLib.resolve — STATIC_CALL typed canonical decode", () => {
  it("resolves a uint256 return to its canonical word", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    const ref = staticCallRef(FieldType.UINT256, {
      target: await target.getAddress(),
      selector: SEL("getUint"),
    });
    const [t, v] = await h.resolve(ref, []);
    expect(Number(t)).to.equal(FieldType.UINT256);
    expect(coder.decode(["uint256"], v)[0]).to.equal(42n);
  });

  it("resolves an address return to its canonical word", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    const ref = staticCallRef(FieldType.ADDRESS, {
      target: await target.getAddress(),
      selector: SEL("getAddress"),
    });
    const [t, v] = await h.resolve(ref, []);
    expect(Number(t)).to.equal(FieldType.ADDRESS);
    expect(coder.decode(["address"], v)[0]).to.equal(
      ethers.getAddress("0x000000000000000000000000000000000000bEEF")
    );
  });

  it("resolves a bool return to its canonical word", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    const ref = staticCallRef(FieldType.BOOL, {
      target: await target.getAddress(),
      selector: SEL("getBool"),
    });
    const [t, v] = await h.resolve(ref, []);
    expect(Number(t)).to.equal(FieldType.BOOL);
    expect(coder.decode(["bool"], v)[0]).to.equal(true);
  });

  it("resolves a bytes32 return to its canonical word", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    const ref = staticCallRef(FieldType.BYTES32, {
      target: await target.getAddress(),
      selector: SEL("getBytes32"),
    });
    const [t, v] = await h.resolve(ref, []);
    expect(Number(t)).to.equal(FieldType.BYTES32);
    expect(coder.decode(["bytes32"], v)[0]).to.equal(ethers.id("static-call-r6"));
  });

  it("passes pre-baked CONST args to the target (echoUint)", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    const ref = staticCallRef(FieldType.UINT256, {
      target: await target.getAddress(),
      selector: SEL("echoUint"),
      args: coder.encode(["uint256"], [7n]),
    });
    const [, v] = await h.resolve(ref, []);
    expect(coder.decode(["uint256"], v)[0]).to.equal(7n);
  });
});

describe("ValueLib.evaluate — STATIC_CALL as a condition LEFT operand", () => {
  it("STATIC_CALL(getUint)==42 GTE CONST(10) holds; GTE CONST(100) fails", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    const left = staticCallRef(FieldType.UINT256, {
      target: await target.getAddress(),
      selector: SEL("getUint"),
    });
    expect(await h.checkBool(cond(left, CmpOp.GTE, constRef(FieldType.UINT256, 10n)), [])).to.equal(
      true
    );
    expect(await h.checkBool(cond(left, CmpOp.GTE, constRef(FieldType.UINT256, 100n)), [])).to.equal(
      false
    );
  });

  it("STATIC_CALL(getAddress) EQ a matching CONST address holds", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    const left = staticCallRef(FieldType.ADDRESS, {
      target: await target.getAddress(),
      selector: SEL("getAddress"),
    });
    const beef = ethers.getAddress("0x000000000000000000000000000000000000bEEF");
    expect(await h.checkBool(cond(left, CmpOp.EQ, constRef(FieldType.ADDRESS, beef)), [])).to.equal(
      true
    );
  });
});

describe("ValueLib.resolve — STATIC_CALL bounds and fail modes", () => {
  it("a return-bomb target does not blow up resolution; the first word still decodes", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    // returnBomb returns an 8 KiB blob; with maxReturnBytes == 32 only the first word
    // (the ABI offset == 0x20) is copied. Resolution must not blow up on the big returndata.
    const ref = staticCallRef(FieldType.UINT256, {
      target: await target.getAddress(),
      selector: SEL("returnBomb"),
      gas: 100_000n, // at the MAX_STATIC_CALL_GAS cap — an 8 KiB blob still returns within it.
      maxReturnBytes: 32,
    });
    const [, v] = await h.resolve(ref, []);
    expect(coder.decode(["uint256"], v)[0]).to.equal(32n); // first word = ABI offset 0x20
  });

  it("getBigWord (max uint) decodes correctly under a tight 32-byte cap", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    const ref = staticCallRef(FieldType.UINT256, {
      target: await target.getAddress(),
      selector: SEL("getBigWord"),
      maxReturnBytes: 32,
    });
    const [, v] = await h.resolve(ref, []);
    expect(coder.decode(["uint256"], v)[0]).to.equal(2n ** 256n - 1n);
  });

  it("a reverting target in REVERT fail mode reverts resolution (StaticCallFailed)", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    const ref = staticCallRef(FieldType.UINT256, {
      target: await target.getAddress(),
      selector: SEL("boom"),
      failMode: FailMode.REVERT,
    });
    await expect(h.resolve(ref, [])).to.be.revertedWithCustomError(h, "StaticCallFailed");
  });

  it("a short return (<32 bytes) reverts resolution in REVERT mode (StaticCallFailed)", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    const ref = staticCallRef(FieldType.UINT256, {
      target: await target.getAddress(),
      selector: SEL("returnShort"),
      failMode: FailMode.REVERT,
    });
    await expect(h.resolve(ref, [])).to.be.revertedWithCustomError(h, "StaticCallFailed");
  });

  it("a malformed return word (non-0/1 decoded as BOOL) reverts MalformedValue", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    // getRaw(2) returns the word 2; decoding it AS a BOOL is non-canonical.
    const ref = staticCallRef(FieldType.BOOL, {
      target: await target.getAddress(),
      selector: SEL("getRaw"),
      args: coder.encode(["uint256"], [2n]),
    });
    await expect(h.resolve(ref, [])).to.be.revertedWithCustomError(h, "MalformedValue");
  });

  it("a malformed return word (dirty ADDRESS high bytes) reverts MalformedValue", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    // getRaw(big) returns a word with non-zero high bytes; decoding AS ADDRESS is non-canonical.
    const dirty = 2n ** 200n + 1n;
    const ref = staticCallRef(FieldType.ADDRESS, {
      target: await target.getAddress(),
      selector: SEL("getRaw"),
      args: coder.encode(["uint256"], [dirty]),
    });
    await expect(h.resolve(ref, [])).to.be.revertedWithCustomError(h, "MalformedValue");
  });

  it("NO SELF: a target == address(this) is rejected at runtime (StaticCallSelfTarget)", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    const targetAddr = await target.getAddress();
    // Point ctx.self at the target so the resolved target == self.
    await h.setContext(ethers.ZeroAddress, ethers.ZeroAddress, targetAddr, 0);
    const ref = staticCallRef(FieldType.UINT256, {
      target: targetAddr,
      selector: SEL("getUint"),
    });
    await expect(h.resolve(ref, [])).to.be.revertedWithCustomError(h, "StaticCallSelfTarget");
  });
});

describe("ValueLib.evaluate — STATIC_CALL ABSENT fail mode (guard-candidate skip)", () => {
  it("a reverting ABSENT-mode STATIC_CALL left operand is SKIPPED (evaluate -> true)", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    const left = staticCallRef(FieldType.UINT256, {
      target: await target.getAddress(),
      selector: SEL("boom"),
      failMode: FailMode.ABSENT,
    });
    // Even though the call reverts, ABSENT mode treats it as absent -> condition skipped.
    expect(await h.checkBool(cond(left, CmpOp.GTE, constRef(FieldType.UINT256, 10n)), [])).to.equal(
      true
    );
    // And check() (revert-on-false) must NOT revert — the skip means "satisfied".
    await h.check(cond(left, CmpOp.GTE, constRef(FieldType.UINT256, 10n)), []);
  });

  it("a gas-griefing ABSENT-mode STATIC_CALL skips and the outer tx still proceeds", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    // burnGas consumes its whole stipend; with a small stipend and ABSENT mode the read
    // fails (out of stipend) and the condition is skipped — the outer call returns true
    // rather than the griefing read OOG-ing the whole transaction.
    const left = staticCallRef(FieldType.UINT256, {
      target: await target.getAddress(),
      selector: SEL("burnGas"),
      gas: 50_000n,
      failMode: FailMode.ABSENT,
    });
    expect(await h.checkBool(cond(left, CmpOp.GTE, constRef(FieldType.UINT256, 10n)), [])).to.equal(
      true
    );
  });

  it("a griefing ABSENT guard skips while a LATER (separate) condition still evaluates", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    // Candidate-guard A: a reverting ABSENT-mode STATIC_CALL -> skipped (true), does not
    // block the pipeline.
    const griefGuard = cond(
      staticCallRef(FieldType.UINT256, {
        target: await target.getAddress(),
        selector: SEL("boom"),
        failMode: FailMode.ABSENT,
      }),
      CmpOp.GTE,
      constRef(FieldType.UINT256, 10n)
    );
    expect(await h.checkBool(griefGuard, [])).to.equal(true);

    // A LATER candidate's guard: a working STATIC_CALL (REVERT mode) that genuinely
    // evaluates and fails its comparison — proving the griefing read did not poison the
    // pipeline and a real later candidate is still assessed on its own merits.
    const realGuard = cond(
      staticCallRef(FieldType.UINT256, {
        target: await target.getAddress(),
        selector: SEL("getUint"),
      }),
      CmpOp.GTE,
      constRef(FieldType.UINT256, 100n)
    );
    expect(await h.checkBool(realGuard, [])).to.equal(false); // 42 >= 100 is false
  });

  it("ABSENT mode does NOT skip when the call SUCCEEDS (it then evaluates normally)", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    const left = staticCallRef(FieldType.UINT256, {
      target: await target.getAddress(),
      selector: SEL("getUint"),
      failMode: FailMode.ABSENT,
    });
    // getUint() == 42; ABSENT mode only skips on FAILURE, so a successful call is compared.
    expect(await h.checkBool(cond(left, CmpOp.GTE, constRef(FieldType.UINT256, 100n)), [])).to.equal(
      false
    );
    expect(await h.checkBool(cond(left, CmpOp.GTE, constRef(FieldType.UINT256, 10n)), [])).to.equal(
      true
    );
  });
});

describe("ValueLib.evaluate — STATIC_CALL ABSENT-mode left is read EXACTLY ONCE", () => {
  // The Major double-call: the old code PROBED an ABSENT-mode left (one staticcall) then,
  // on success, re-RESOLVED it (a second staticcall). A non-deterministic target read twice
  // in one tx returns different words, so the value compared would not be the value read on
  // the probe. splitOnAccess() returns 111 on the FIRST read in a tx and 999 on every later
  // read; if the left is read exactly once it sees 111, so `left EQ 111` holds. A second
  // read would make the comparison `999 EQ 111` -> false. So this asserts single-read.
  it("a SUCCEEDING ABSENT-mode left is resolved once (compares the first-read word, not a re-read)", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    const left = staticCallRef(FieldType.UINT256, {
      target: await target.getAddress(),
      selector: SEL("splitOnAccess"),
      failMode: FailMode.ABSENT,
    });
    // EQ 111 (the first-read value): true iff the left was read exactly once.
    expect(await h.checkBool(cond(left, CmpOp.EQ, constRef(FieldType.UINT256, 111n)), [])).to.equal(
      true
    );
    // EQ 999 (the would-be second-read value): false, confirming the second read never happened.
    expect(await h.checkBool(cond(left, CmpOp.EQ, constRef(FieldType.UINT256, 999n)), [])).to.equal(
      false
    );
  });

  it("a REVERT-mode failing left does NOT skip — it reverts (no silent satisfy)", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    const left = staticCallRef(FieldType.UINT256, {
      target: await target.getAddress(),
      selector: SEL("boom"),
      failMode: FailMode.REVERT,
    });
    // check() must propagate the failure (StaticCallFailed), never treat it as satisfied.
    await expect(
      h.check(cond(left, CmpOp.GTE, constRef(FieldType.UINT256, 10n)), [])
    ).to.be.revertedWithCustomError(h, "StaticCallFailed");
  });

  it("the no-self guard fires even for an ABSENT-mode left (StaticCallSelfTarget, not a skip)", async () => {
    const h = await freshValueLibHarness();
    const target = await deployTarget();
    const targetAddr = await target.getAddress();
    // Point ctx.self at the target so the ABSENT-mode left resolves target == self.
    await h.setContext(ethers.ZeroAddress, ethers.ZeroAddress, targetAddr, 0);
    const left = staticCallRef(FieldType.UINT256, {
      target: targetAddr,
      selector: SEL("getUint"),
      failMode: FailMode.ABSENT,
    });
    // ABSENT mode must NOT silently skip a self-target; the no-self guard must still revert.
    await expect(
      h.checkBool(cond(left, CmpOp.GTE, constRef(FieldType.UINT256, 10n)), [])
    ).to.be.revertedWithCustomError(h, "StaticCallSelfTarget");
  });
});

describe("ValueLib.validateRef — STATIC_CALL init validation", () => {
  const TARGET = ethers.getAddress("0x000000000000000000000000000000000000abcd");

  // Encode a STATIC_CALL ValueRef directly from spec fields so a bad spec can be injected.
  function specRef(
    vType: number,
    target: string,
    gas: bigint,
    maxReturnBytes: number,
    failMode: number
  ) {
    return {
      source: ValueSource.STATIC_CALL,
      vType,
      data: coder.encode(
        ["(address target, bytes4 selector, bytes args, uint256 gas, uint16 maxReturnBytes, uint8 failMode)"],
        [[target, "0xaabbccdd", "0x", gas, maxReturnBytes, failMode]]
      ),
    };
  }

  it("accepts a well-formed STATIC_CALL spec (word vType, target!=0, 0<gas<=cap, maxReturnBytes==32, mode in {0,1})", async () => {
    const h = await freshValueLibHarness();
    for (const vType of [FieldType.UINT256, FieldType.ADDRESS, FieldType.BOOL, FieldType.BYTES32]) {
      await h.validateRef(specRef(vType, TARGET, 100_000n, 32, FailMode.REVERT));
      await h.validateRef(specRef(vType, TARGET, 1n, 32, FailMode.ABSENT));
      // Exactly the gas cap (100_000) is accepted (boundary).
      await h.validateRef(specRef(vType, TARGET, 100_000n, 32, FailMode.ABSENT));
    }
  });

  it("rejects target == 0 (MalformedStaticCallSpec)", async () => {
    const h = await freshValueLibHarness();
    await expect(
      h.validateRef(specRef(FieldType.UINT256, ethers.ZeroAddress, 100_000n, 32, FailMode.REVERT))
    ).to.be.revertedWithCustomError(h, "MalformedStaticCallSpec");
  });

  it("rejects gas == 0 (MalformedStaticCallSpec)", async () => {
    const h = await freshValueLibHarness();
    await expect(
      h.validateRef(specRef(FieldType.UINT256, TARGET, 0n, 32, FailMode.REVERT))
    ).to.be.revertedWithCustomError(h, "MalformedStaticCallSpec");
  });

  it("rejects gas over the MAX_STATIC_CALL_GAS cap (MalformedStaticCallSpec)", async () => {
    const h = await freshValueLibHarness();
    // One over the 100_000 cap: a near-all-gas stipend a griefing target could use to
    // starve the outer tx is rejected at init.
    await expect(
      h.validateRef(specRef(FieldType.UINT256, TARGET, 100_001n, 32, FailMode.REVERT))
    ).to.be.revertedWithCustomError(h, "MalformedStaticCallSpec");
  });

  it("rejects maxReturnBytes != 32 — below (MalformedStaticCallSpec)", async () => {
    const h = await freshValueLibHarness();
    await expect(
      h.validateRef(specRef(FieldType.UINT256, TARGET, 100_000n, 31, FailMode.REVERT))
    ).to.be.revertedWithCustomError(h, "MalformedStaticCallSpec");
  });

  it("rejects maxReturnBytes != 32 — above (MalformedStaticCallSpec)", async () => {
    const h = await freshValueLibHarness();
    // Only the first word is ever read; anything other than exactly 32 is misleading.
    await expect(
      h.validateRef(specRef(FieldType.UINT256, TARGET, 100_000n, 64, FailMode.REVERT))
    ).to.be.revertedWithCustomError(h, "MalformedStaticCallSpec");
  });

  it("rejects a non-word vType (STRING) (MalformedStaticCallSpec)", async () => {
    const h = await freshValueLibHarness();
    await expect(
      h.validateRef(specRef(FieldType.STRING, TARGET, 100_000n, 32, FailMode.REVERT))
    ).to.be.revertedWithCustomError(h, "MalformedStaticCallSpec");
  });

  it("rejects a non-word vType (BYTES) (MalformedStaticCallSpec)", async () => {
    const h = await freshValueLibHarness();
    await expect(
      h.validateRef(specRef(FieldType.BYTES, TARGET, 100_000n, 32, FailMode.REVERT))
    ).to.be.revertedWithCustomError(h, "MalformedStaticCallSpec");
  });

  it("rejects a bad failMode (== 2) (MalformedStaticCallSpec)", async () => {
    const h = await freshValueLibHarness();
    await expect(
      h.validateRef(specRef(FieldType.UINT256, TARGET, 100_000n, 32, 2))
    ).to.be.revertedWithCustomError(h, "MalformedStaticCallSpec");
  });

  it("rejects undecodable spec data with MalformedStaticCallSpec (not a raw abi.decode panic)", async () => {
    const h = await freshValueLibHarness();
    await expect(
      h.validateRef(rawRef(ValueSource.STATIC_CALL, FieldType.UINT256, "0x" + "ab".repeat(10)))
    ).to.be.revertedWithCustomError(h, "MalformedStaticCallSpec");
  });
});
