/**
 * Fuzz layer — randomized parity across all legacy Op families
 * (prior engine vs new AgreementEngine).
 *
 * Deterministic-seed random typed values per family; same dual-submit equality
 * assertion as the structured grids. Catches divergences the boundary grids miss.
 */

import { ethers } from "hardhat";
import { runDifferential, assertParity } from "./harness";
import type { ParityCase } from "./corpus";
import { uintFuzzCases, stringFuzzCases, addressFuzzCases, senderFuzzCases } from "./corpus-fuzz";

async function runAll(cases: ParityCase[]) {
  for (const c of cases) {
    const { legacy, canonical } = await runDifferential(c);
    assertParity(c, legacy, canonical);
  }
}

describe("Fuzz parity (Legacy vs AgreementEngine)", () => {
  it("UINT: 200 randomized cases, zero divergence", async function () {
    this.timeout(180000);
    await runAll(uintFuzzCases());
  });

  it("STRING: 150 randomized cases, zero divergence", async function () {
    this.timeout(180000);
    await runAll(stringFuzzCases());
  });

  it("ADDRESS: 150 randomized cases, zero divergence", async function () {
    this.timeout(180000);
    await runAll(addressFuzzCases());
  });

  it("SENDER: 100 randomized direct/permit cases, zero divergence", async function () {
    this.timeout(180000);
    const signers = await ethers.getSigners();
    // signer addresses for indices 1..4 (index 0 is the owner/deployer)
    const pool = [signers[1].address, signers[2].address, signers[3].address, signers[4].address];
    await runAll(senderFuzzCases(pool));
  });
});
