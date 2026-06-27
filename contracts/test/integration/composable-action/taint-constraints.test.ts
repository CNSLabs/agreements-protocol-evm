/**
 * R7 — mandatory init-time taint constraints (the security boundary).
 *
 * A call component is "tainted" if a submitting party can influence its value. Computed
 * at init over the static config:
 *   - direct taint sources: FIELD, FIELD_LENGTH, CALLER, AUTH_SIGNER
 *   - a VAR is tainted if a tainted value can be written into it: an InputFieldDef with
 *     persist=true (a submitted FIELD), or an action Output (a captured external return).
 *
 * The requirement enforced at initialize:
 *   - a tainted TARGET must be pinned by an IN constraint against non-tainted operands;
 *   - each tainted dynamic ARG must be bounded by a constraint referencing that arg's
 *     value (IN/EQ/LTE/GTE) against non-tainted operands.
 *   A constraint that bounds a tainted value against ANOTHER tainted value is not a real
 *   bound (e.g. recipient EQ CALLER does not count).
 *
 * These tests author agreements through createComposableAgreement and assert init
 * accepts/rejects; the runtime negative-security cases (R4) are covered separately and
 * must still pass.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import type { TestERC20 } from "../../../typechain-types";
import { createComposableAgreement, composableActionInit, call, dynSlot, output } from "../../helpers/action-lib";
import {
  FieldType,
  ValueSource,
  CmpOp,
  constRef,
  varRef,
  fieldRef,
  synthRef,
  id,
  encAddress,
  encUint,
} from "../../helpers/value-lib";

const erc20 = new ethers.Interface([
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
]);
const transferFromSel = erc20.getFunction("transferFrom")!.selector;
const quoteSel = "0xaabbccdd";

// FSM
const S_START = ethers.id("START");
const S_DONE = ethers.id("DONE");
const INPUT = ethers.id("act");

// ids
const F_TO = id("recipient");
const F_AMOUNT = id("amount");
const F_TARGET = id("targetField");
const V_PAYER = id("payer");
const V_CAP = id("capVar");
const V_ALLOWED = id("allowedVar");
const V_CAPTURED = id("captured"); // holds a captured external return

const TOKEN = ethers.getAddress("0x000000000000000000000000000000000c0ffee1");
const ALLOWED = ethers.getAddress("0x000000000000000000000000000000000000a110");
const CAP = 1_000n;

async function deployStack() {
  const actionLib = await ethers.deployContract("ActionLib");
  await actionLib.waitForDeployment();
  const Engine = await ethers.getContractFactory("AgreementEngine", {
    libraries: { ActionLib: await actionLib.getAddress() },
  });
  const impl = await Engine.deploy();
  await impl.waitForDeployment();
  const factory = await ethers.deployContract("AgreementFactory", [await impl.getAddress()]);
  await factory.waitForDeployment();
  // ABI-only handle so the ActionLib errors are decodable by the matcher.
  const actionLibAbi = (await ethers.getContractFactory("ActionLib")).attach(ethers.ZeroAddress);
  return { Engine, factory, impl, actionLib: actionLibAbi };
}

/**
 * Build inputDefs for `act` with the given fields. `persist` controls auto-persist.
 */
function inputDefsWith(
  fields: Array<[string, number, boolean, boolean]>
) {
  return [[INPUT, fields, [], []]];
}

const transitions = [[S_START, S_DONE, INPUT]];

async function create(
  factory: any,
  opts: {
    inputFields: Array<[string, number, boolean, boolean]>;
    initVars?: Array<[string, number, string]>;
    calls: any[];
  }
) {
  return createComposableAgreement(factory, 
    "ipfs://x",
    ethers.ZeroHash,
    S_START,
    inputDefsWith(opts.inputFields) as any,
    transitions as any,
    (opts.initVars ?? []) as any,
    [composableActionInit(S_START, INPUT, opts.calls)] as any,
    [] as any,
    [] as any // no verifiers
  );
}

describe("R7 — init-time taint constraints (tainted TARGET)", () => {
  it("rejects a tainted (FIELD) target with no IN allowlist (UnconstrainedTaintedTarget)", async () => {
    const { factory, actionLib } = await deployStack();
    const c = call(fieldRef(FieldType.ADDRESS, F_TARGET), transferFromSel, []);
    await expect(
      create(factory, {
        inputFields: [[F_TARGET, FieldType.ADDRESS, true, false]],
        calls: [c],
      })
    ).to.be.revertedWithCustomError(actionLib, "UnconstrainedTaintedTarget");
  });

  it("accepts a tainted (FIELD) target bounded by a CONST allowlist (IN)", async () => {
    const { factory } = await deployStack();
    const c = call(
      fieldRef(FieldType.ADDRESS, F_TARGET),
      transferFromSel,
      [],
      [
        {
          left: fieldRef(FieldType.ADDRESS, F_TARGET),
          op: CmpOp.IN,
          skipIfAbsent: false,
          right: [constRef(FieldType.ADDRESS, TOKEN), constRef(FieldType.ADDRESS, ALLOWED)],
        },
      ]
    );
    await expect(
      create(factory, {
        inputFields: [[F_TARGET, FieldType.ADDRESS, true, false]],
        calls: [c],
      })
    ).to.not.be.reverted;
  });

  it("rejects a CALLER target with no allowlist (UnconstrainedTaintedTarget)", async () => {
    const { factory, actionLib } = await deployStack();
    const c = call(synthRef(ValueSource.CALLER, FieldType.ADDRESS), transferFromSel, []);
    await expect(
      create(factory, { inputFields: [], calls: [c] })
    ).to.be.revertedWithCustomError(actionLib, "UnconstrainedTaintedTarget");
  });

  it("rejects an AUTH_SIGNER target with no allowlist (UnconstrainedTaintedTarget)", async () => {
    const { factory, actionLib } = await deployStack();
    const c = call(synthRef(ValueSource.AUTH_SIGNER, FieldType.ADDRESS), transferFromSel, []);
    await expect(
      create(factory, { inputFields: [], calls: [c] })
    ).to.be.revertedWithCustomError(actionLib, "UnconstrainedTaintedTarget");
  });
});

describe("R7 — init-time taint constraints (tainted ARG)", () => {
  it("rejects a tainted (FIELD) arg with no bounding constraint (UnconstrainedTaintedArg)", async () => {
    const { factory, actionLib } = await deployStack();
    // target is CONST (safe); the amount arg is FIELD-sourced and unbounded.
    const c = call(
      constRef(FieldType.ADDRESS, TOKEN),
      transferFromSel,
      [
        dynSlot(varRef(FieldType.ADDRESS, V_PAYER)),
        dynSlot(constRef(FieldType.ADDRESS, ALLOWED)),
        dynSlot(fieldRef(FieldType.UINT256, F_AMOUNT)),
      ]
    );
    await expect(
      create(factory, {
        inputFields: [[F_AMOUNT, FieldType.UINT256, true, false]],
        initVars: [[V_PAYER, FieldType.ADDRESS, encAddress(ALLOWED)]],
        calls: [c],
      })
    ).to.be.revertedWithCustomError(actionLib, "UnconstrainedTaintedArg");
  });

  it("accepts a tainted (FIELD) arg bounded by a two-sided range (GTE 0 AND LTE CONST cap)", async () => {
    const { factory } = await deployStack();
    const c = call(
      constRef(FieldType.ADDRESS, TOKEN),
      transferFromSel,
      [
        dynSlot(varRef(FieldType.ADDRESS, V_PAYER)),
        dynSlot(constRef(FieldType.ADDRESS, ALLOWED)),
        dynSlot(fieldRef(FieldType.UINT256, F_AMOUNT)),
      ],
      [
        {
          left: fieldRef(FieldType.UINT256, F_AMOUNT),
          op: CmpOp.GTE,
          skipIfAbsent: false,
          right: [constRef(FieldType.UINT256, 0n)],
        },
        {
          left: fieldRef(FieldType.UINT256, F_AMOUNT),
          op: CmpOp.LTE,
          skipIfAbsent: false,
          right: [constRef(FieldType.UINT256, CAP)],
        },
      ]
    );
    await expect(
      create(factory, {
        inputFields: [[F_AMOUNT, FieldType.UINT256, true, false]],
        initVars: [[V_PAYER, FieldType.ADDRESS, encAddress(ALLOWED)]],
        calls: [c],
      })
    ).to.not.be.reverted;
  });

  it("accepts a tainted (FIELD) arg bounded by a two-sided range against non-tainted author VARs", async () => {
    const { factory } = await deployStack();
    const c = call(
      constRef(FieldType.ADDRESS, TOKEN),
      transferFromSel,
      [
        dynSlot(varRef(FieldType.ADDRESS, V_PAYER)),
        dynSlot(constRef(FieldType.ADDRESS, ALLOWED)),
        dynSlot(fieldRef(FieldType.UINT256, F_AMOUNT)),
      ],
      [
        {
          left: fieldRef(FieldType.UINT256, F_AMOUNT),
          op: CmpOp.GTE,
          skipIfAbsent: false,
          right: [varRef(FieldType.UINT256, V_CAP)],
        },
        {
          left: fieldRef(FieldType.UINT256, F_AMOUNT),
          op: CmpOp.LTE,
          skipIfAbsent: false,
          right: [constRef(FieldType.UINT256, CAP)],
        },
      ]
    );
    await expect(
      create(factory, {
        inputFields: [[F_AMOUNT, FieldType.UINT256, true, false]],
        initVars: [
          [V_PAYER, FieldType.ADDRESS, encAddress(ALLOWED)],
          [V_CAP, FieldType.UINT256, encUint(5n)],
        ],
        calls: [c],
      })
    ).to.not.be.reverted;
  });
});

describe("R7 — taint propagation (option B: VAR taint via persist / output / chains)", () => {
  it("persist: a FIELD persisted into a var, then VAR used as unbounded target -> reject", async () => {
    const { factory, actionLib } = await deployStack();
    // F_TARGET is persisted into vars[F_TARGET]; the action target is VAR(F_TARGET).
    // The var inherits taint from the persisted submitted field -> unbounded target.
    const c = call(varRef(FieldType.ADDRESS, F_TARGET), transferFromSel, []);
    await expect(
      create(factory, {
        inputFields: [[F_TARGET, FieldType.ADDRESS, true, true]], // required + persist
        calls: [c],
      })
    ).to.be.revertedWithCustomError(actionLib, "UnconstrainedTaintedTarget");
  });

  it("persist: a FIELD persisted into a var, then VAR used as unbounded arg -> reject", async () => {
    const { factory, actionLib } = await deployStack();
    // F_AMOUNT persisted into vars[F_AMOUNT]; used as a dynamic arg with no bound.
    const c = call(
      constRef(FieldType.ADDRESS, TOKEN),
      transferFromSel,
      [
        dynSlot(varRef(FieldType.ADDRESS, V_PAYER)),
        dynSlot(constRef(FieldType.ADDRESS, ALLOWED)),
        dynSlot(varRef(FieldType.UINT256, F_AMOUNT)),
      ]
    );
    await expect(
      create(factory, {
        inputFields: [[F_AMOUNT, FieldType.UINT256, true, true]],
        initVars: [[V_PAYER, FieldType.ADDRESS, encAddress(ALLOWED)]],
        calls: [c],
      })
    ).to.be.revertedWithCustomError(actionLib, "UnconstrainedTaintedArg");
  });

  it("output: a var holding a captured external return, used as unbounded target -> reject", async () => {
    const { factory, actionLib } = await deployStack();
    // First call captures quote() -> V_CAPTURED. Second call targets VAR(V_CAPTURED)
    // (an output-tainted var) with no allowlist.
    const capture = call(
      constRef(FieldType.ADDRESS, TOKEN),
      quoteSel,
      [],
      [],
      [output(0, FieldType.ADDRESS, V_CAPTURED)]
    );
    const useTarget = call(varRef(FieldType.ADDRESS, V_CAPTURED), transferFromSel, []);
    await expect(
      create(factory, {
        inputFields: [],
        calls: [capture, useTarget],
      })
    ).to.be.revertedWithCustomError(actionLib, "UnconstrainedTaintedTarget");
  });

  it("output: an output-tainted var used as an unbounded arg -> reject", async () => {
    const { factory, actionLib } = await deployStack();
    const capture = call(
      constRef(FieldType.ADDRESS, TOKEN),
      quoteSel,
      [],
      [],
      [output(0, FieldType.UINT256, V_CAPTURED)]
    );
    const useArg = call(
      constRef(FieldType.ADDRESS, TOKEN),
      transferFromSel,
      [
        dynSlot(varRef(FieldType.ADDRESS, V_PAYER)),
        dynSlot(constRef(FieldType.ADDRESS, ALLOWED)),
        dynSlot(varRef(FieldType.UINT256, V_CAPTURED)),
      ]
    );
    await expect(
      create(factory, {
        inputFields: [],
        initVars: [[V_PAYER, FieldType.ADDRESS, encAddress(ALLOWED)]],
        calls: [capture, useArg],
      })
    ).to.be.revertedWithCustomError(actionLib, "UnconstrainedTaintedArg");
  });
});

describe("R7 — no false positives (non-tainted components need no constraint)", () => {
  it("accepts a CONST target + CONST/VAR/SELF/NOW args with no constraints", async () => {
    const { factory } = await deployStack();
    const c = call(
      constRef(FieldType.ADDRESS, TOKEN), // non-tainted target
      transferFromSel,
      [
        dynSlot(varRef(FieldType.ADDRESS, V_PAYER)), // author-set non-tainted VAR
        dynSlot(constRef(FieldType.ADDRESS, ALLOWED)), // CONST
        dynSlot(synthRef(ValueSource.SELF, FieldType.ADDRESS)), // SELF (used as data, target is token)
      ]
    );
    await expect(
      create(factory, {
        inputFields: [],
        initVars: [[V_PAYER, FieldType.ADDRESS, encAddress(ALLOWED)]],
        calls: [c],
      })
    ).to.not.be.reverted;
  });

  it("accepts a SELF target and a NOW arg with no constraints (non-tainted)", async () => {
    const { factory } = await deployStack();
    // SELF target would be rejected at execution by the no-self guard, but R7 init
    // analysis must not flag SELF as tainted — it accepts at init.
    const c = call(
      synthRef(ValueSource.SELF, FieldType.ADDRESS),
      quoteSel,
      [dynSlot(synthRef(ValueSource.NOW, FieldType.UINT256))]
    );
    await expect(
      create(factory, { inputFields: [], calls: [c] })
    ).to.not.be.reverted;
  });

  it("accepts a non-tainted VAR target with no allowlist (author-set address)", async () => {
    const { factory } = await deployStack();
    const c = call(varRef(FieldType.ADDRESS, V_ALLOWED), transferFromSel, []);
    await expect(
      create(factory, {
        inputFields: [],
        initVars: [[V_ALLOWED, FieldType.ADDRESS, encAddress(TOKEN)]],
        calls: [c],
      })
    ).to.not.be.reverted;
  });
});

describe("R7 — weak-bound rejection (tainted bounded only against tainted)", () => {
  it("rejects recipient EQ CALLER as a bound (CALLER is tainted) -> UnconstrainedTaintedArg", async () => {
    const { factory, actionLib } = await deployStack();
    // recipient is a FIELD arg; the only constraint bounds it against CALLER (tainted),
    // which is not a real bound — the arg stays effectively unconstrained.
    const c = call(
      constRef(FieldType.ADDRESS, TOKEN),
      transferFromSel,
      [
        dynSlot(varRef(FieldType.ADDRESS, V_PAYER)),
        dynSlot(fieldRef(FieldType.ADDRESS, F_TO)),
        dynSlot(constRef(FieldType.UINT256, 1n)),
      ],
      [
        {
          left: fieldRef(FieldType.ADDRESS, F_TO),
          op: CmpOp.EQ,
          skipIfAbsent: false,
          right: [synthRef(ValueSource.CALLER, FieldType.ADDRESS)],
        },
      ]
    );
    await expect(
      create(factory, {
        inputFields: [[F_TO, FieldType.ADDRESS, true, false]],
        initVars: [[V_PAYER, FieldType.ADDRESS, encAddress(ALLOWED)]],
        calls: [c],
      })
    ).to.be.revertedWithCustomError(actionLib, "UnconstrainedTaintedArg");
  });

  it("rejects amount LTE FIELD(otherAmount) (RHS tainted) -> UnconstrainedTaintedArg", async () => {
    const { factory, actionLib } = await deployStack();
    const F_OTHER = id("otherAmount");
    const c = call(
      constRef(FieldType.ADDRESS, TOKEN),
      transferFromSel,
      [
        dynSlot(varRef(FieldType.ADDRESS, V_PAYER)),
        dynSlot(constRef(FieldType.ADDRESS, ALLOWED)),
        dynSlot(fieldRef(FieldType.UINT256, F_AMOUNT)),
      ],
      [
        {
          left: fieldRef(FieldType.UINT256, F_AMOUNT),
          op: CmpOp.LTE,
          skipIfAbsent: false,
          right: [fieldRef(FieldType.UINT256, F_OTHER)],
        },
      ]
    );
    await expect(
      create(factory, {
        inputFields: [
          [F_AMOUNT, FieldType.UINT256, true, false],
          [F_OTHER, FieldType.UINT256, true, false],
        ],
        initVars: [[V_PAYER, FieldType.ADDRESS, encAddress(ALLOWED)]],
        calls: [c],
      })
    ).to.be.revertedWithCustomError(actionLib, "UnconstrainedTaintedArg");
  });

  it("accepts the arg when a real two-sided CONST range is present alongside a weak bound", async () => {
    const { factory } = await deployStack();
    // amount LTE FIELD(other) (weak, ignored) AND amount LTE CONST(cap) AND amount GTE
    // CONST(0) (a real two-sided range over non-tainted operands) -> bounded.
    const F_OTHER = id("otherAmount");
    const c = call(
      constRef(FieldType.ADDRESS, TOKEN),
      transferFromSel,
      [
        dynSlot(varRef(FieldType.ADDRESS, V_PAYER)),
        dynSlot(constRef(FieldType.ADDRESS, ALLOWED)),
        dynSlot(fieldRef(FieldType.UINT256, F_AMOUNT)),
      ],
      [
        {
          left: fieldRef(FieldType.UINT256, F_AMOUNT),
          op: CmpOp.LTE,
          skipIfAbsent: false,
          right: [fieldRef(FieldType.UINT256, F_OTHER)],
        },
        {
          left: fieldRef(FieldType.UINT256, F_AMOUNT),
          op: CmpOp.LTE,
          skipIfAbsent: false,
          right: [constRef(FieldType.UINT256, CAP)],
        },
        {
          left: fieldRef(FieldType.UINT256, F_AMOUNT),
          op: CmpOp.GTE,
          skipIfAbsent: false,
          right: [constRef(FieldType.UINT256, 0n)],
        },
      ]
    );
    await expect(
      create(factory, {
        inputFields: [
          [F_AMOUNT, FieldType.UINT256, true, false],
          [F_OTHER, FieldType.UINT256, true, false],
        ],
        initVars: [[V_PAYER, FieldType.ADDRESS, encAddress(ALLOWED)]],
        calls: [c],
      })
    ).to.not.be.reverted;
  });
});

describe("R7 — lone one-sided ordered bound: init reject + runtime exploit closed", () => {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  function df(fieldId: string, fType: number, data: string) {
    return { id: fieldId, fType, data };
  }
  function encodePayload(fields: { id: string; fType: number; data: string }[]) {
    return coder.encode(["tuple(bytes32 id, uint8 fType, bytes data)[]"], [fields]);
  }

  it("a FIELD transferFrom amount with only GTE is rejected at init", async () => {
    const { factory, actionLib } = await deployStack();
    const c = call(
      constRef(FieldType.ADDRESS, TOKEN),
      transferFromSel,
      [
        dynSlot(varRef(FieldType.ADDRESS, V_PAYER)),
        dynSlot(constRef(FieldType.ADDRESS, ALLOWED)),
        dynSlot(fieldRef(FieldType.UINT256, F_AMOUNT)),
      ],
      [
        {
          left: fieldRef(FieldType.UINT256, F_AMOUNT),
          op: CmpOp.GTE,
          skipIfAbsent: false,
          right: [constRef(FieldType.UINT256, 1n)],
        },
      ]
    );
    await expect(
      create(factory, {
        inputFields: [[F_AMOUNT, FieldType.UINT256, true, false]],
        initVars: [[V_PAYER, FieldType.ADDRESS, encAddress(ALLOWED)]],
        calls: [c],
      })
    ).to.be.revertedWithCustomError(actionLib, "UnconstrainedTaintedArg");
  });

  it("with a two-sided bound it deploys; an over-cap amount reverts pre-call (no transfer)", async () => {
    const [, payer, payee] = await ethers.getSigners();
    const actionLib = await ethers.deployContract("ActionLib");
    await actionLib.waitForDeployment();
    const Engine = await ethers.getContractFactory("AgreementEngine", {
      libraries: { ActionLib: await actionLib.getAddress() },
    });
    const impl = await Engine.deploy();
    await impl.waitForDeployment();
    const factory = await ethers.deployContract("AgreementFactory", [await impl.getAddress()]);
    await factory.waitForDeployment();
    const actionLibAbi = (await ethers.getContractFactory("ActionLib")).attach(ethers.ZeroAddress);

    const token = (await ethers.deployContract("TestERC20", ["WorkToken", "WORK"])) as unknown as TestERC20;
    await token.waitForDeployment();
    await (await token.mint(payer.address, 10_000n)).wait();

    // amount bounded two-sided: GTE 1 AND LTE 100 (cap). Target = the real token.
    const c = call(
      constRef(FieldType.ADDRESS, await token.getAddress()),
      transferFromSel,
      [
        dynSlot(varRef(FieldType.ADDRESS, V_PAYER)),
        dynSlot(constRef(FieldType.ADDRESS, payee.address)),
        dynSlot(fieldRef(FieldType.UINT256, F_AMOUNT)),
      ],
      [
        {
          left: fieldRef(FieldType.UINT256, F_AMOUNT),
          op: CmpOp.GTE,
          skipIfAbsent: false,
          right: [constRef(FieldType.UINT256, 1n)],
        },
        {
          left: fieldRef(FieldType.UINT256, F_AMOUNT),
          op: CmpOp.LTE,
          skipIfAbsent: false,
          right: [constRef(FieldType.UINT256, 100n)],
        },
      ]
    );
    const tx = await createComposableAgreement(factory, 
      "ipfs://x",
      ethers.ZeroHash,
      S_START,
      inputDefsWith([[F_AMOUNT, FieldType.UINT256, true, false]]) as any,
      transitions as any,
      [[V_PAYER, FieldType.ADDRESS, encAddress(payer.address)]] as any,
      [composableActionInit(S_START, INPUT, [c])] as any,
      [] as any,
      [] as any // no verifiers
    );
    const receipt = await tx.wait();
    const log = receipt!.logs
      .map((l: any) => {
        try {
          return factory.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: any) => p && p.name === "AgreementDeployed");
    const engine = Engine.attach(log!.args.agreement as string) as any;
    await (await token.connect(payer).approve(await engine.getAddress(), 10_000n)).wait();

    const before = await token.balanceOf(payee.address);
    // amount = cap + 1 = 101 -> above the upper bound -> ConstraintFailed pre-call.
    await expect(
      engine.submitInput(INPUT, encodePayload([df(F_AMOUNT, FieldType.UINT256, encUint(101n))]))
    ).to.be.revertedWithCustomError(actionLibAbi, "ConstraintFailed");
    expect(await token.balanceOf(payee.address)).to.equal(before);
    expect(await engine.currentState()).to.equal(S_START);

    // an in-range amount (50) goes through.
    await (
      await engine.submitInput(INPUT, encodePayload([df(F_AMOUNT, FieldType.UINT256, encUint(50n))]))
    ).wait();
    expect((await token.balanceOf(payee.address)) - before).to.equal(50n);
    expect(await engine.currentState()).to.equal(S_DONE);
  });
});
