// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import {
  AgreementPackageCompilationError,
  canonicalizeJson,
  compileAgreementPackage,
  hashAgreementPackage,
  type AgreementCompilationIssueCode,
  type AgreementPackage,
} from "../src/package-compiler";

const fixturePath = path.resolve(
  __dirname,
  "fixtures/canonical-package-v0-reference-package.json"
);
const referencePackage = JSON.parse(
  fs.readFileSync(fixturePath, "utf8")
) as AgreementPackage;

function clonePackage(): AgreementPackage {
  return structuredClone(referencePackage);
}

function expectCompilationIssue(
  mutate: (agreementPackage: AgreementPackage) => void,
  expectedCode: AgreementCompilationIssueCode
): void {
  const candidate = clonePackage();
  mutate(candidate);

  try {
    compileAgreementPackage(candidate);
    throw new Error("Expected package compilation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(AgreementPackageCompilationError);
    const compilationError = error as AgreementPackageCompilationError;
    expect(compilationError.report.issues.map((entry) => entry.code)).toContain(
      expectedCode
    );
  }
}

describe("canonical agreement package compiler", () => {
  it("canonicalizes object keys while preserving array order", () => {
    expect(canonicalizeJson({ z: 1, a: { y: true, x: "value" } })).toBe(
      '{"a":{"x":"value","y":true},"z":1}'
    );
    expect(canonicalizeJson(["b", "a"])).toBe('["b","a"]');
  });

  it("compiles the reference package with an empty loss report", () => {
    const compiled = compileAgreementPackage(referencePackage);

    expect(compiled.report.issues).toEqual([]);
    expect(compiled.params.docHash).toBe(compiled.manifest.packageDigest);
    expect(compiled.manifest.packageDigest).toBe(
      hashAgreementPackage(referencePackage)
    );
    expect(compiled.manifest.packageDigest).toBe(
      "0xbadcf69305da75949634578328f3496dc4dec02e509c485f3df7421b05eca123"
    );
    expect(Buffer.byteLength(compiled.manifest.canonicalPackage, "utf8")).toBe(
      3114
    );
    expect(compiled.manifest.compiled).toEqual({
      inputDefs: 3,
      transitions: 3,
      initVars: 3,
      verifiers: 0,
      actions: 1,
    });
  });

  it("produces the same digest when object insertion order changes", () => {
    const reordered = {
      initialization: referencePackage.initialization,
      agreement: referencePackage.agreement,
      target: referencePackage.target,
      profile: referencePackage.profile,
      schemaVersion: referencePackage.schemaVersion,
    } as AgreementPackage;

    expect(hashAgreementPackage(reordered)).toBe(
      hashAgreementPackage(referencePackage)
    );
  });

  it.each([
    ["prose", (candidate: AgreementPackage) => {
      candidate.agreement.content.data += " Updated.";
    }],
    ["initialization", (candidate: AgreementPackage) => {
      candidate.initialization.values.amount = "1000001";
    }],
    ["execution", (candidate: AgreementPackage) => {
      candidate.agreement.execution.transitions[2].to = "AWAITING_REVIEW";
    }],
    ["target chain", (candidate: AgreementPackage) => {
      candidate.target.chainId = "59142";
      candidate.agreement.contracts!.milestoneAdapter.chainId = "59142";
    }],
    ["compiler profile", (candidate: AgreementPackage) => {
      candidate.profile.compiler =
        "@shodai-network/agreements-protocol-evm/package-compiler-0.2" as typeof candidate.profile.compiler;
    }],
  ])("binds %s into the package digest", (_label, mutate) => {
    const candidate = clonePackage();
    mutate(candidate);
    expect(hashAgreementPackage(candidate)).not.toBe(
      hashAgreementPackage(referencePackage)
    );
  });

  it("rejects multiple transition triggers instead of dropping all but the first", () => {
    expectCompilationIssue((candidate) => {
      candidate.agreement.execution.transitions[0].conditions!.push({
        type: "isValid",
        input: "submitEvidence",
      });
    }, "TRANSITION_TRIGGER_COUNT");
  });

  it("rejects an unsupported compiler profile instead of compiling under ambient code", () => {
    expectCompilationIssue((candidate) => {
      candidate.profile.compiler =
        "@shodai-network/agreements-protocol-evm/package-compiler-0.2" as typeof candidate.profile.compiler;
    }, "UNSUPPORTED_COMPILER");
  });

  it("rejects action failure semantics the engine cannot represent", () => {
    expectCompilationIssue((candidate) => {
      candidate.agreement.execution.actions![0].revertOnFailure = false;
    }, "UNSUPPORTED_ACTION_FAILURE_POLICY");
  });

  it("rejects action contracts declared for a different chain", () => {
    expectCompilationIssue((candidate) => {
      candidate.agreement.contracts!.milestoneAdapter.chainId = "1";
    }, "ACTION_CONTRACT_CHAIN_MISMATCH");
  });

  it("rejects unsupported on-chain validation rather than warning and continuing", () => {
    expectCompilationIssue((candidate) => {
      candidate.agreement.variables.evidenceHash.validation = {
        required: true,
        pattern: "^0x[0-9a-f]{64}$",
      };
    }, "UNSUPPORTED_ONCHAIN_VALIDATION");
  });

  it("rejects initialization values that the runtime would ignore", () => {
    expectCompilationIssue((candidate) => {
      candidate.initialization.values.unused = "not-on-chain";
    }, "UNUSED_INITIALIZATION_VALUE");
  });

  it("rejects undeclared initialization references", () => {
    expectCompilationIssue((candidate) => {
      candidate.agreement.execution.initialize.data!.grantor =
        "${variables.missingGrantor}";
    }, "INVALID_INITIALIZATION_REFERENCE");
  });

  it("rejects undeclared variables in input fields", () => {
    expectCompilationIssue((candidate) => {
      candidate.agreement.execution.inputs.submitEvidence.data!.evidenceHash =
        "${variables.missingEvidence}";
    }, "UNKNOWN_INPUT_VARIABLE");
  });

  it("rejects duplicate transition triggers", () => {
    expectCompilationIssue((candidate) => {
      candidate.agreement.execution.transitions.push({
        from: "AWAITING_REVIEW",
        to: "AWAITING_EVIDENCE",
        conditions: [{ type: "isValid", input: "acceptAndPay" }],
      });
    }, "DUPLICATE_TRANSITION_TRIGGER");
  });

  it("rejects duplicate actions that the engine would overwrite", () => {
    expectCompilationIssue((candidate) => {
      candidate.agreement.execution.actions!.push(
        structuredClone(candidate.agreement.execution.actions![0])
      );
    }, "DUPLICATE_ACTION_HOOK");
  });
});
