/**
 * Init-time bounded-evaluation caps (spec §13) — engine config + condition + dynamic-value.
 *
 * The engine bounds the submit-time evaluation work a config can force, so a griefing
 * config author cannot gas-bomb a counterparty's submitInput. Each cap is checked AT INIT
 * in the shared validation/storage paths (so both the legacy `initialize` and the
 * composable `initialize` are covered) and an over-cap config reverts at creation
 * with AgreementTypes.ConfigCapExceeded(what, got, max). One pair per cap family: an
 * at-the-cap init succeeds, an over-cap init reverts with the cap error.
 *
 * Caps under test here (engine + ValueLib):
 *   MAX_INPUT_DEFS = 256, MAX_TRANSITIONS = 256, MAX_FIELDS_PER_INPUT = 32,
 *   MAX_CONDITIONS_PER_INPUT = 32, MAX_VERIFIER_KEYS_PER_INPUT = 16,
 *   MAX_IN_SET_SIZE = 64, MAX_DYNAMIC_VALUE_BYTES = 4096.
 * The ActionLib action-component caps live in config-caps-actionlib.test.ts.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { createComposableAgreement, canonicalConditionInit } from "../../helpers/action-lib";
import {
  FieldType,
  CmpOp,
  constRef,
  fieldRef,
  encString,
  encBytes,
  id,
} from "../../helpers/value-lib";

const S_START = ethers.id("START");
const S_DONE = ethers.id("DONE");
const INPUT = ethers.id("act");
const F_X = id("x");

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
  // ABI-only handle so AgreementTypes.ConfigCapExceeded is decodable by the matcher
  // (the error is declared in AgreementTypes, surfaced through the engine).
  const engineAbi = Engine.attach(ethers.ZeroAddress);
  return { factory, engineAbi };
}

// One default input `act` with a single optional field, no conditions, no verifiers.
function oneInput(): any {
  return [[INPUT, [[F_X, FieldType.UINT256, false, false]], [], []]];
}
const oneTransition: any = [[S_START, S_DONE, INPUT]];

async function create(
  factory: any,
  opts: {
    inputDefs?: any;
    transitions?: any;
    initVars?: any;
    canonicalConds?: any;
  }
) {
  return createComposableAgreement(factory, 
    "ipfs://x",
    ethers.ZeroHash,
    S_START,
    (opts.inputDefs ?? oneInput()) as any,
    (opts.transitions ?? oneTransition) as any,
    (opts.initVars ?? []) as any,
    [] as any, // no actions
    (opts.canonicalConds ?? []) as any,
    [] as any // no verifiers
  );
}

describe("Init caps — engine config shape", () => {
  describe("MAX_INPUT_DEFS = 256", () => {
    // Each input def needs a unique non-zero id; transitions reference a fixed input,
    // so extra input defs are otherwise inert.
    function inputDefs(n: number): any {
      const defs: any[] = [];
      for (let i = 0; i < n; i++) {
        const iid = i === 0 ? INPUT : ethers.id(`extra-input-${i}`);
        defs.push([iid, [], [], []]);
      }
      return defs;
    }

    it("accepts an init at the cap (256 input defs)", async () => {
      const { factory } = await deployStack();
      await expect(create(factory, { inputDefs: inputDefs(256) })).to.not.be.reverted;
    });

    it("rejects an init over the cap (257) with ConfigCapExceeded", async () => {
      const { factory, engineAbi } = await deployStack();
      await expect(create(factory, { inputDefs: inputDefs(257) }))
        .to.be.revertedWithCustomError(engineAbi, "ConfigCapExceeded")
        .withArgs(ethers.encodeBytes32String("MAX_INPUT_DEFS"), 257, 256);
    });
  });

  describe("MAX_TRANSITIONS = 256", () => {
    function transitions(n: number): any {
      const ts: any[] = [];
      for (let i = 0; i < n; i++) {
        ts.push([ethers.id(`s${i}`), S_DONE, INPUT]);
      }
      return ts;
    }

    it("accepts an init at the cap (256 transitions)", async () => {
      const { factory } = await deployStack();
      await expect(create(factory, { transitions: transitions(256) })).to.not.be.reverted;
    });

    it("rejects an init over the cap (257) with ConfigCapExceeded", async () => {
      const { factory, engineAbi } = await deployStack();
      await expect(create(factory, { transitions: transitions(257) }))
        .to.be.revertedWithCustomError(engineAbi, "ConfigCapExceeded")
        .withArgs(ethers.encodeBytes32String("MAX_TRANSITIONS"), 257, 256);
    });
  });

  describe("MAX_FIELDS_PER_INPUT = 32", () => {
    function inputWithFields(n: number): any {
      const fields: any[] = [];
      for (let i = 0; i < n; i++) {
        fields.push([ethers.id(`f${i}`), FieldType.UINT256, false, false]);
      }
      return [[INPUT, fields, [], []]];
    }

    it("accepts an init at the cap (32 fields)", async () => {
      const { factory } = await deployStack();
      await expect(create(factory, { inputDefs: inputWithFields(32) })).to.not.be.reverted;
    });

    it("rejects an init over the cap (33) with ConfigCapExceeded", async () => {
      const { factory, engineAbi } = await deployStack();
      await expect(create(factory, { inputDefs: inputWithFields(33) }))
        .to.be.revertedWithCustomError(engineAbi, "ConfigCapExceeded")
        .withArgs(ethers.encodeBytes32String("MAX_FIELDS_PER_INPUT"), 33, 32);
    });
  });

  describe("MAX_VERIFIER_KEYS_PER_INPUT = 16", () => {
    function inputWithVerifierKeys(n: number): any {
      const keys: any[] = [];
      for (let i = 0; i < n; i++) keys.push(ethers.id(`vk${i}`));
      return [[INPUT, [], [], keys]];
    }

    it("accepts an init at the cap (16 verifier keys)", async () => {
      const { factory } = await deployStack();
      await expect(create(factory, { inputDefs: inputWithVerifierKeys(16) })).to.not.be.reverted;
    });

    it("rejects an init over the cap (17) with ConfigCapExceeded", async () => {
      const { factory, engineAbi } = await deployStack();
      await expect(create(factory, { inputDefs: inputWithVerifierKeys(17) }))
        .to.be.revertedWithCustomError(engineAbi, "ConfigCapExceeded")
        .withArgs(ethers.encodeBytes32String("MAX_VERIFIER_KEYS_PER_INPUT"), 17, 16);
    });
  });

  describe("MAX_CONDITIONS_PER_INPUT = 32 (canonical conditions path)", () => {
    // A trivially-true EQ on a CONST; legality-valid, evaluated per submit.
    function conds(n: number): any[] {
      const out: any[] = [];
      for (let i = 0; i < n; i++) {
        out.push({
          left: constRef(FieldType.UINT256, BigInt(i)),
          op: CmpOp.EQ,
          skipIfAbsent: false,
          right: [constRef(FieldType.UINT256, BigInt(i))],
        });
      }
      return out;
    }

    it("accepts an init at the cap (32 conditions for one input)", async () => {
      const { factory } = await deployStack();
      await expect(
        create(factory, { canonicalConds: [canonicalConditionInit(INPUT, conds(32))] })
      ).to.not.be.reverted;
    });

    it("rejects an init over the cap (33) with ConfigCapExceeded", async () => {
      const { factory, engineAbi } = await deployStack();
      await expect(create(factory, { canonicalConds: [canonicalConditionInit(INPUT, conds(33))] }))
        .to.be.revertedWithCustomError(engineAbi, "ConfigCapExceeded")
        .withArgs(ethers.encodeBytes32String("MAX_CONDITIONS_PER_INPUT"), 33, 32);
    });
  });

  describe("MAX_IN_SET_SIZE = 64 (an IN condition's right-operand count)", () => {
    function inCond(n: number): any[] {
      const set: any[] = [];
      for (let i = 0; i < n; i++) set.push(constRef(FieldType.UINT256, BigInt(i)));
      return [{ left: fieldRef(FieldType.UINT256, F_X), op: CmpOp.IN, skipIfAbsent: false, right: set }];
    }

    it("accepts an init at the cap (64-element IN set)", async () => {
      const { factory } = await deployStack();
      await expect(
        create(factory, { canonicalConds: [canonicalConditionInit(INPUT, inCond(64))] })
      ).to.not.be.reverted;
    });

    it("rejects an init over the cap (65) with ConfigCapExceeded", async () => {
      const { factory, engineAbi } = await deployStack();
      await expect(create(factory, { canonicalConds: [canonicalConditionInit(INPUT, inCond(65))] }))
        .to.be.revertedWithCustomError(engineAbi, "ConfigCapExceeded")
        .withArgs(ethers.encodeBytes32String("MAX_IN_SET_SIZE"), 65, 64);
    });
  });

  describe("MAX_DYNAMIC_VALUE_BYTES = 4096 (a dynamic CONST/stored value's payload)", () => {
    // Stored init var of STRING type; the engine's _validateFieldDecoding caps its payload.
    function stringInitVar(byteLen: number): any {
      return [[id("sv"), FieldType.STRING, encString("a".repeat(byteLen))]];
    }
    function bytesConstCond(byteLen: number): any[] {
      const v = "0x" + "ab".repeat(byteLen);
      return [
        {
          left: constRef(FieldType.BYTES, v),
          op: CmpOp.EQ,
          skipIfAbsent: false,
          right: [constRef(FieldType.BYTES, v)],
        },
      ];
    }

    it("accepts a stored STRING init var at the cap (4096 bytes)", async () => {
      const { factory } = await deployStack();
      await expect(create(factory, { initVars: stringInitVar(4096) })).to.not.be.reverted;
    });

    it("rejects a stored STRING init var over the cap (4097) with ConfigCapExceeded", async () => {
      const { factory, engineAbi } = await deployStack();
      await expect(create(factory, { initVars: stringInitVar(4097) }))
        .to.be.revertedWithCustomError(engineAbi, "ConfigCapExceeded")
        .withArgs(ethers.encodeBytes32String("MAX_DYNAMIC_VALUE_BYTES"), 4097, 4096);
    });

    it("rejects a dynamic BYTES CONST condition value over the cap (ValueLib gate)", async () => {
      const { factory, engineAbi } = await deployStack();
      await expect(
        create(factory, { canonicalConds: [canonicalConditionInit(INPUT, bytesConstCond(4097))] })
      )
        .to.be.revertedWithCustomError(engineAbi, "ConfigCapExceeded")
        .withArgs(ethers.encodeBytes32String("MAX_DYNAMIC_VALUE_BYTES"), 4097, 4096);
    });
  });
});
