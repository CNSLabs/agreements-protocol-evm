/**
 * Differential parity — SENDER Op family (prior engine vs new AgreementEngine).
 *
 * SENDER_EQ_VAR_ADDRESS desugars to AUTH_SIGNER EQ VAR(address);
 * SENDER_IN_ALLOWED_ADDRESSES to AUTH_SIGNER IN [VAR(address)..., CONST(address)...].
 *
 * Exercises direct vs permit submission: AUTH_SIGNER must resolve to the permit
 * signer under submitInputWithPermit and to msg.sender under direct submitInput,
 * matching the prior engine's permit-signer selection.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { runDifferential, assertParity } from "./harness";
import { senderParityCases } from "./corpus";

describe("Parity — SENDER Op family (Legacy vs AgreementEngine)", () => {
  let cases: ReturnType<typeof senderParityCases>;

  before(async () => {
    const signers = await ethers.getSigners();
    // signer index 1 is the "expected" sender; index 2 is "other".
    cases = senderParityCases(signers[1].address, signers[2].address);
  });

  it("builds the SENDER corpus", () => {
    expect(cases.length).to.be.greaterThan(0);
  });

  // Generated dynamically because addresses come from runtime signers.
  it("parity across all SENDER cases (direct + permit)", async function () {
    this.timeout(120000);
    for (const c of cases) {
      const { legacy, canonical } = await runDifferential(c);
      assertParity(c, legacy, canonical);
    }
  });
});
