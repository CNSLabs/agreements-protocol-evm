/**
 * Extended differential parity — coverage hardening (multi-condition, cross-input,
 * persist-before-validate, IF_PRESENT with VAR RHS, stored-VAR type mismatch,
 * SENDER_IN_ALLOWED hard cases). All anchored to legacy ground truth via assertParity.
 */

import { ethers } from "hardhat";
import { runDifferential, assertParity } from "./harness";
import {
  multiConditionCases,
  multiConditionOptionalSkipCases,
  crossInputCases,
  persistBeforeValidateCases,
  ifPresentVarRhsCases,
  storedVarTypeMismatchCases,
  senderVarTypeMismatchCases,
  senderInAllowedHardCases,
} from "./corpus-extra";

describe("Parity — multi-condition (single input)", () => {
  for (const c of [...multiConditionCases(), ...multiConditionOptionalSkipCases()]) {
    it(`parity: ${c.name}`, async () => {
      const { legacy, canonical } = await runDifferential(c);
      assertParity(c, legacy, canonical);
    });
  }
});

describe("Parity — cross-input two-step (persist then compare)", () => {
  for (const c of crossInputCases()) {
    it(`parity: ${c.name}`, async () => {
      const { legacy, canonical } = await runDifferential(c);
      assertParity(c, legacy, canonical);
    });
  }
});

describe("Parity — persist-before-validate (submitted field shadows init var)", () => {
  for (const c of persistBeforeValidateCases()) {
    it(`parity: ${c.name}`, async () => {
      const { legacy, canonical } = await runDifferential(c);
      assertParity(c, legacy, canonical);
    });
  }
});

describe("Parity — IF_PRESENT with VAR RHS (agreement level)", () => {
  for (const c of ifPresentVarRhsCases()) {
    it(`parity: ${c.name}`, async () => {
      const { legacy, canonical } = await runDifferential(c);
      assertParity(c, legacy, canonical);
    });
  }
});

describe("Parity — stored-VAR type mismatch", () => {
  for (const c of storedVarTypeMismatchCases()) {
    it(`parity: ${c.name}`, async () => {
      const { legacy, canonical } = await runDifferential(c);
      assertParity(c, legacy, canonical);
    });
  }

  // Sender-related type-mismatch cases need runtime signer addresses.
  it("parity: SENDER VAR type-mismatch cases (dynamic addresses)", async () => {
    const signers = await ethers.getSigners();
    for (const c of senderVarTypeMismatchCases(signers[1].address)) {
      const { legacy, canonical } = await runDifferential(c);
      assertParity(c, legacy, canonical);
    }
  });
});

describe("Parity — SENDER_IN_ALLOWED hard cases", () => {
  it("parity: permit-negative / early-VAR-before-unset-VAR / empty-set (dynamic addresses)", async () => {
    const signers = await ethers.getSigners();
    for (const c of senderInAllowedHardCases(signers[1].address, signers[2].address)) {
      const { legacy, canonical } = await runDifferential(c);
      assertParity(c, legacy, canonical);
    }
  });
});
