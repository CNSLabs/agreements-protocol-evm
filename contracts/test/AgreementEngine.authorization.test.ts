// SPDX-License-Identifier: Apache-2.0

import { expect } from "chai";
import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { AgreementEngineStateHarness__factory } from "../typechain-types";
import type { AgreementEngineStateHarness } from "../typechain-types";

const abi = ethers.AbiCoder.defaultAbiCoder();
const INPUT = ethers.id("rotate-authority");
const START = ethers.id("START");
const ACTIVE = ethers.id("ACTIVE");
const AUTHORITY = ethers.id("authority");
const AMOUNT = ethers.id("amount");
const NOTE = ethers.id("note");
const VERIFIER = ethers.id("submission-probe");

// AgreementEngine's public ABI represents these Solidity enums as uint8.
const FieldType = { UINT256: 0, STRING: 1, ADDRESS: 2 } as const;
const Op = {
  STRING_MIN_LENGTH: 0,
  STRING_EQ_VAR: 3,
  UINT_GT_CONST: 5,
  UINT_GT_VAR: 10,
  ADDRESS_EQ_VAR: 15,
  SENDER_EQ_VAR_ADDRESS: 16,
  SENDER_IN_ALLOWED_ADDRESSES: 17,
} as const;

type SubmissionPath = "direct" | "permit";
type AuthorityMode = "sender variable" | "allowed variable" | "mixed allowlist";
type DataField = { id: string; fType: number; data: string };
type Condition = { op: number; fieldId: string; bytesArg: string };

function field(id: string, type: keyof typeof FieldType, value: string | bigint): DataField {
  const encoding = { UINT256: "uint256", STRING: "string", ADDRESS: "address" };
  return { id, fType: FieldType[type], data: abi.encode([encoding[type]], [value]) };
}

function payload(fields: DataField[]): string {
  return abi.encode(["tuple(bytes32 id,uint8 fType,bytes data)[]"], [fields]);
}

function rotation(address: string, amount = 8n): DataField[] {
  return [field(AUTHORITY, "ADDRESS", address), field(AMOUNT, "UINT256", amount)];
}

async function fixture(
  path: SubmissionPath,
  mode: AuthorityMode = "sender variable",
  options: {
    noTransition?: boolean;
    probe?: boolean;
    conditions?: Condition[];
    unsetVars?: string[];
  } = {}
) {
  const [authorized, attacker, next, literal, relayer] = await ethers.getSigners();
  const signers = [authorized, attacker, next, literal, relayer];
  const implementation = await ethers.deployContract("AgreementEngineStateHarness");
  const factory = await ethers.deployContract("AgreementFactory", [await implementation.getAddress()]);
  const probe = options.probe
    ? await ethers.deployContract("SubmissionValidationProbe", [
        AUTHORITY, authorized.address, next.address, START, ACTIVE,
        authorized.address,
      ])
    : undefined;
  const senderCondition: Condition = mode === "sender variable"
    ? { op: Op.SENDER_EQ_VAR_ADDRESS, fieldId: AUTHORITY, bytesArg: "0x" }
    : {
        op: Op.SENDER_IN_ALLOWED_ADDRESSES,
        fieldId: ethers.ZeroHash,
        bytesArg: abi.encode(
          ["bytes32[]", "address[]"],
          [[AUTHORITY], mode === "mixed allowlist" ? [literal.address] : []]
        ),
      };
  const inputDefs = [{
    id: INPUT,
    fields: [
      { fieldId: AUTHORITY, fType: FieldType.ADDRESS, required: false, persist: true },
      { fieldId: AMOUNT, fType: FieldType.UINT256, required: true, persist: true },
      { fieldId: NOTE, fType: FieldType.STRING, required: false, persist: true },
    ],
    conditions: [
      senderCondition,
      { op: Op.UINT_GT_CONST, fieldId: AMOUNT, bytesArg: abi.encode(["uint256"], [0]) },
      { op: Op.STRING_MIN_LENGTH, fieldId: NOTE, bytesArg: abi.encode(["uint256"], [3]) },
      ...(options.conditions ?? []),
    ],
    verifierKeys: probe ? [VERIFIER] : [],
  }];
  const transitions = options.noTransition ? [] : [
    { fromState: START, toState: ACTIVE, inputId: INPUT },
    { fromState: ACTIVE, toState: ACTIVE, inputId: INPUT },
  ];
  const initVars = [
    field(AUTHORITY, "ADDRESS", authorized.address),
    field(AMOUNT, "UINT256", 7n),
    field(NOTE, "STRING", "original"),
  ].filter(value => !options.unsetVars?.includes(value.id));
  const verifiers = probe ? [{ key: VERIFIER, verifier: await probe.getAddress() }] : [];
  const actions = probe ? [{
    fromState: START, inputId: INPUT, target: await probe.getAddress(), value: 0,
    data: probe.interface.encodeFunctionData("execute"),
  }] : [];
  const args = [
    "ipfs://submission-validation", ethers.id("submission-validation"), START,
    inputDefs, transitions, initVars, verifiers, actions,
  ] as const;
  const address = await factory.createAgreement.staticCall(...args);
  await factory.createAgreement(...args);
  const agreement = AgreementEngineStateHarness__factory.connect(address, ethers.provider);

  // Capture a permit once so failed execution can retry the exact same signature.
  async function prepare(signer: HardhatEthersSigner, fields: DataField[]) {
    const encoded = payload(fields);
    if (path === "direct") {
      return () => agreement.connect(signer).submitInput(INPUT, encoded);
    }
    const block = await ethers.provider.getBlock("latest");
    const deadline = block!.timestamp + 3600;
    const signature = await signer.signTypedData(
      {
        name: "AgreementEngine", version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: address,
      },
      { PermitInput: [
        { name: "signer", type: "address" },
        { name: "inputId", type: "bytes32" },
        { name: "payload", type: "bytes" },
        { name: "expectedState", type: "bytes32" },
        { name: "expectedStateNonce", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ] },
      {
        signer: signer.address,
        inputId: INPUT,
        payload: encoded,
        expectedState: await agreement.currentState(),
        expectedStateNonce: await agreement.stateNonce(),
        nonce: await agreement.nonces(signer.address),
        deadline,
      }
    );
    return () => agreement.connect(relayer).submitInputWithPermit(
      signer.address, INPUT, encoded, deadline, signature
    );
  }

  async function snapshot() {
    return {
      state: await agreement.currentState(),
      vars: await Promise.all([AUTHORITY, AMOUNT, NOTE].map(id => agreement.getStoredVar(id))),
      nonces: await Promise.all(signers.map(signer => agreement.nonces(signer.address))),
    };
  }

  return { agreement, authorized, attacker, next, literal, relayer, probe, prepare, snapshot };
}

async function expectStored(
  agreement: AgreementEngineStateHarness,
  id: string,
  type: keyof typeof FieldType,
  value: string | bigint
) {
  const expected = field(id, type, value);
  expect(await agreement.getStoredVar(id)).to.deep.equal([BigInt(expected.fType), expected.data]);
}

describe("AgreementEngine — pre-submission authorization", function () {
  for (const path of ["direct", "permit"] as const) {
    describe(path, function () {
      for (const mode of ["sender variable", "allowed variable", "mixed allowlist"] as const) {
        describe(mode, function () {
          it("rejects self-authorization without changing state, authority, or nonces", async function () {
            const f = await fixture(path, mode);
            const before = await f.snapshot();
            const submit = await f.prepare(f.attacker, rotation(f.attacker.address));
            const error = mode === "sender variable" ? "SenderAddressMismatch" : "SenderAddressNotAllowed";
            const args = mode === "sender variable"
              ? [f.attacker.address, f.authorized.address] : [f.attacker.address];
            await expect(submit()).to.be.revertedWithCustomError(f.agreement, error).withArgs(...args);
            expect(await f.snapshot()).to.deep.equal(before);
          });

          it("lets the current authority rotate, then rejects the old authority and accepts the new one", async function () {
            const f = await fixture(path, mode);
            await (await f.prepare(f.authorized, rotation(f.next.address)))();
            expect(await f.agreement.currentState()).to.equal(ACTIVE);
            await expectStored(f.agreement, AUTHORITY, "ADDRESS", f.next.address);
            expect(await f.agreement.nonces(f.authorized.address)).to.equal(path === "permit" ? 1n : 0n);

            const afterRotation = await f.snapshot();
            const oldSubmit = await f.prepare(f.authorized, rotation(f.authorized.address));
            await expect(oldSubmit()).to.be.revertedWithCustomError(
              f.agreement, mode === "sender variable" ? "SenderAddressMismatch" : "SenderAddressNotAllowed"
            );
            expect(await f.snapshot()).to.deep.equal(afterRotation);

            // Omitted optional persisted fields retain their previously committed values.
            await (await f.prepare(f.next, [field(AMOUNT, "UINT256", 9n)]))();
            await expectStored(f.agreement, AUTHORITY, "ADDRESS", f.next.address);
            await expectStored(f.agreement, AMOUNT, "UINT256", 9n);
            await expectStored(f.agreement, NOTE, "STRING", "original");
            expect(await f.agreement.nonces(f.next.address)).to.equal(path === "permit" ? 1n : 0n);
          });
        });
      }

      it("preserves literal allowlist authorization alongside variable-based rotation", async function () {
        const f = await fixture(path, "mixed allowlist");
        await (await f.prepare(f.literal, rotation(f.next.address)))();
        await expectStored(f.agreement, AUTHORITY, "ADDRESS", f.next.address);
        await (await f.prepare(f.literal, [field(AMOUNT, "UINT256", 9n)]))();
        await (await f.prepare(f.next, [field(AMOUNT, "UINT256", 10n)]))();
        await expectStored(f.agreement, AMOUNT, "UINT256", 10n);
      });

      it("validates submitted field values, and rolls back a rejected condition", async function () {
        const f = await fixture(path);
        const before = await f.snapshot();
        for (const fields of [
          rotation(f.next.address, 0n),
          [...rotation(f.next.address), field(NOTE, "STRING", "x")],
        ]) {
          const submit = await f.prepare(f.authorized, fields);
          await expect(submit()).to.be.revertedWithCustomError(f.agreement, "ComparisonFailed");
          expect(await f.snapshot()).to.deep.equal(before);
        }
        await (await f.prepare(f.authorized, [
          ...rotation(f.next.address), field(NOTE, "STRING", "replacement"),
        ]))();
        await expectStored(f.agreement, NOTE, "STRING", "replacement");
      });

      it("compares submitted values against stored pre-submission variables", async function () {
        const f = await fixture(path, "sender variable", { conditions: [{
          op: Op.UINT_GT_VAR, fieldId: AMOUNT, bytesArg: abi.encode(["bytes32"], [AMOUNT]),
        }] });
        const before = await f.snapshot();
        const submitTooSmall = await f.prepare(f.authorized, rotation(f.next.address, 6n));
        await expect(submitTooSmall()).to.be.revertedWithCustomError(f.agreement, "ComparisonFailed");
        expect(await f.snapshot()).to.deep.equal(before);
        // This must compare 8 > the stored 7, not 8 > itself after persistence.
        await (await f.prepare(f.authorized, rotation(f.next.address, 8n)))();
        await expectStored(f.agreement, AMOUNT, "UINT256", 8n);
        await (await f.prepare(f.next, [field(AMOUNT, "UINT256", 9n)]))();
        await expectStored(f.agreement, AMOUNT, "UINT256", 9n);
      });

      for (const comparison of [
        { name: "STRING_EQ_VAR", op: Op.STRING_EQ_VAR, fieldId: NOTE, type: "STRING" },
        { name: "ADDRESS_EQ_VAR", op: Op.ADDRESS_EQ_VAR, fieldId: AUTHORITY, type: "ADDRESS" },
      ] as const) {
        it(`${comparison.name} reads the stored operand before payload persistence`, async function () {
          const f = await fixture(path, "mixed allowlist", { conditions: [{
            op: comparison.op, fieldId: comparison.fieldId,
            bytesArg: abi.encode(["bytes32"], [comparison.fieldId]),
          }] });
          const original = comparison.type === "STRING" ? "original" : f.authorized.address;
          const changed = comparison.type === "STRING" ? "replacement" : f.next.address;
          const before = await f.snapshot();
          const values = (value: string) => [
            field(AMOUNT, "UINT256", 8n), field(comparison.fieldId, comparison.type, value),
          ];
          // Literal membership is unaffected by changing AUTHORITY, isolating the VAR check.
          const rejected = await f.prepare(f.literal, values(changed));
          await expect(rejected()).to.be.revertedWithCustomError(f.agreement, "ComparisonFailed");
          expect(await f.snapshot()).to.deep.equal(before);
          await (await f.prepare(f.literal, values(original)))();
          await expectStored(f.agreement, comparison.fieldId, comparison.type, original);
          expect(await f.agreement.currentState()).to.equal(ACTIVE);
        });
      }

      it("cannot initialize a missing authority through the submission it would authorize", async function () {
        for (const mode of ["sender variable", "allowed variable"] as const) {
          const f = await fixture(path, mode, { unsetVars: [AUTHORITY] });
          const before = await f.snapshot();
          const submit = await f.prepare(f.attacker, rotation(f.attacker.address));
          await expect(submit()).to.be.revertedWithCustomError(f.agreement, "VarNotSet").withArgs(AUTHORITY);
          expect(await f.snapshot()).to.deep.equal(before);
        }
      });

      it("rejects unset comparison operands even when the payload would persist them", async function () {
        for (const comparison of [
          { op: Op.UINT_GT_VAR, fieldId: AMOUNT, type: "UINT256", value: 8n },
          { op: Op.STRING_EQ_VAR, fieldId: NOTE, type: "STRING", value: "replacement" },
        ] as const) {
          const f = await fixture(path, "sender variable", {
            unsetVars: [comparison.fieldId],
            conditions: [{
              op: comparison.op, fieldId: comparison.fieldId,
              bytesArg: abi.encode(["bytes32"], [comparison.fieldId]),
            }],
          });
          const before = await f.snapshot();
          const values = [field(comparison.fieldId, comparison.type, comparison.value)];
          if (comparison.fieldId !== AMOUNT) values.push(field(AMOUNT, "UINT256", 8n));
          const submit = await f.prepare(f.authorized, values);
          await expect(submit()).to.be.revertedWithCustomError(f.agreement, "VarNotSet")
            .withArgs(comparison.fieldId);
          expect(await f.snapshot()).to.deep.equal(before);
        }
      });

      for (const failure of ["field", "transition", "verifier", "action"] as const) {
        it(`rolls back state, persisted values, and nonces after ${failure} failure`, async function () {
          const f = await fixture(path, "sender variable", {
            noTransition: failure === "transition",
            probe: failure === "verifier" || failure === "action",
          });
          if (f.probe) await f.probe.setFailures(failure === "verifier", failure === "action");
          const before = await f.snapshot();
          const fields = failure === "field"
            ? [field(AUTHORITY, "ADDRESS", f.next.address)] // Missing required amount.
            : rotation(f.next.address);
          const submit = await f.prepare(f.authorized, fields);
          if (failure === "action") {
            await expect(submit()).to.be.revertedWithCustomError(f.agreement, "ActionCallFailed");
          } else {
            const reason = {
              field: "Required field missing", transition: "No valid transition", verifier: "Verifier rejected",
            }[failure];
            await expect(submit()).to.be.revertedWith(reason);
          }
          expect(await f.snapshot()).to.deep.equal(before);
          if (f.probe) {
            expect(await f.probe.actionsExecuted()).to.equal(0n);
            await f.probe.setFailures(false, false);
            // Retrying the same permit proves the failed attempt did not consume its nonce.
            await submit();
            expect(await f.probe.actionsExecuted()).to.equal(1n);
            expect(await f.agreement.currentState()).to.equal(ACTIVE);
            await expectStored(f.agreement, AUTHORITY, "ADDRESS", f.next.address);
            expect(await f.agreement.nonces(f.authorized.address)).to.equal(path === "permit" ? 1n : 0n);
            expect(await f.agreement.nonces(f.relayer.address)).to.equal(0n);
          }
        });
      }
    });
  }
});
