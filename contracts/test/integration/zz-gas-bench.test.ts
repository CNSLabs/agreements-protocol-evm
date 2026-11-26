// SPDX-License-Identifier: Apache-2.0
//
// Gas and size figures for fixed workloads, written as JSON to GAS_BENCH_OUT.
// Not a correctness test: it exists to compare builds of the contracts.

import * as fs from "fs";
import * as path from "path";
import { expect } from "chai";
import { ethers, artifacts } from "hardhat";
import { loadAgreement, deployProtocol, loadSDKModule, createViemClientsForSigner } from "./test-helpers";

const OUT = process.env.GAS_BENCH_OUT;
const FINANCING = process.env.GAS_BENCH_FINANCING;

(OUT ? describe : describe.skip)("gas benchmark", () => {
  const figures: Record<string, number> = {};
  let sdk: any;

  const TRACE = (process.env.GAS_BENCH_TRACE || "").split(",").filter(Boolean);
  const traces: Record<string, unknown> = {};
  const lastGas = async (label?: string) => {
    const block = await ethers.provider.getBlock("latest");
    const hash = block!.transactions[0];
    const receipt = await ethers.provider.getTransactionReceipt(hash);
    if (label && TRACE.some((t) => label.includes(t))) {
      const trace = await ethers.provider.send("debug_traceTransaction", [hash, { disableMemory: true, disableStack: true, disableStorage: true }]);
      const byOp: Record<string, { n: number; gas: number }> = {};
      for (const step of trace.structLogs) {
        // A call's own cost includes the gas it hands on; count only what the op itself costs.
        const cost = ["CALL", "STATICCALL", "DELEGATECALL", "CREATE", "CREATE2"].includes(step.op) ? 0 : step.gasCost;
        const entry = (byOp[step.op] ||= { n: 0, gas: 0 });
        entry.n += 1;
        entry.gas += cost;
      }
      const top = Object.entries(byOp).sort((a, b) => b[1].gas - a[1].gas).slice(0, 9).map(([op, v]) => `${op} x${v.n} = ${v.gas}`);
      traces[label] = { gasUsed: Number(receipt!.gasUsed), steps: trace.structLogs.length, top };
    }
    return Number(receipt!.gasUsed);
  };

  before(async () => {
    sdk = await loadSDKModule();
    for (const name of ["AgreementEngine", "AgreementFactory"]) {
      const artifact = await artifacts.readArtifact(name);
      figures[`size.${name}.runtime`] = (artifact.deployedBytecode.length - 2) / 2;
      figures[`size.${name}.init`] = (artifact.bytecode.length - 2) / 2;
    }
  });

  after(() => {
    fs.writeFileSync(OUT!, JSON.stringify(figures, null, 1) + "\n");
    if (TRACE.length) fs.writeFileSync(OUT!.replace(/\.json$/, ".trace.json"), JSON.stringify(traces, null, 1) + "\n");
  });

  async function start(agreement: any, initValues: Record<string, unknown>, label: string) {
    const signers = await ethers.getSigners();
    const relayer = signers[9];
    const { factory: deployed } = await deployProtocol();
    const factory = new sdk.AgreementFactory({ factoryAddress: await deployed.getAddress() }, await createViemClientsForSigner(relayer));
    const { address } = await factory.createAgreement(agreement, { initValues });
    figures[`${label}.create`] = await lastGas(`${label}.create`);
    const engines = new Map<string, any>();
    const engineFor = async (signer: any) => {
      if (!engines.has(signer.address)) {
        const clients = await createViemClientsForSigner(signer);
        engines.set(signer.address, { engine: new sdk.AgreementEngine(address, clients.publicClient, clients.walletClient), ...clients });
      }
      return engines.get(signer.address);
    };
    let n = 0;
    const direct = async (signer: any, inputId: string, values: Record<string, unknown>) => {
      const { engine } = await engineFor(signer);
      await engine.submitInput(agreement, inputId, values, true);
      { const key = `${label}.${String(++n).padStart(2, "0")}.${inputId}`; figures[key] = await lastGas(key); }
    };
    const permit = async (signer: any, inputId: string, values: Record<string, unknown>) => {
      const signerSide = await engineFor(signer);
      const relayerSide = await engineFor(relayer);
      const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
      const signed = await signerSide.engine.createPermitSignature(signerSide.walletClient, agreement, inputId, values, deadline);
      await relayerSide.engine.submitInputWithPermit(signed.signerAddress, agreement, inputId, values, deadline, signed.signature, true);
      { const key = `${label}.${String(++n).padStart(2, "0")}.${inputId}.permit`; figures[key] = await lastGas(key); }
    };
    const state = async () => (await engineFor(relayer)).engine.getCurrentState(agreement);
    return { direct, permit, state, signers };
  }

  it("counted milestones: creation and a two-milestone run", async () => {
    const agreement = loadAgreement("counted-milestones");
    const [grantee, reviewer] = await ethers.getSigners();
    const run = await start(agreement, { grantee: grantee.address, reviewer: reviewer.address, milestoneCount: "2", currentMilestone: "1" }, "counted");
    await run.direct(grantee, "submitWork", { workNote: "delivered", milestone: "1" });
    await run.permit(reviewer, "acceptMilestone", { reviewNote: "accepted", milestone: "1", currentMilestone: "2" });
    await run.permit(grantee, "submitWork", { workNote: "delivered", milestone: "2" });
    await run.direct(reviewer, "acceptFinalMilestone", { reviewNote: "accepted", milestone: "2" });
    expect(await run.state()).to.equal("COMPLETED");
  });

  it("delivery deadline: creation and one input inside its window", async () => {
    const agreement = loadAgreement("delivery-deadline");
    const [supplier, buyer] = await ethers.getSigners();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const run = await start(agreement, { supplier: supplier.address, buyer: buyer.address, dueDate: String(now + 3600) }, "deadline");
    await run.permit(supplier, "deliver", { deliveryNote: "delivered" });
  });

  (FINANCING ? it : it.skip)("financing loop: creation and two quarters", async () => {
    const agreement = JSON.parse(fs.readFileSync(path.resolve(FINANCING!), "utf8"));
    const [cns, legal, reviewer, transactor, delegate] = await ethers.getSigners();
    const run = await start(agreement, {
      cnsRepresentative: cns.address, legalAttester: legal.address, investorReviewer: reviewer.address,
      transactor: transactor.address, investorDelegate: delegate.address,
      effectiveDate: "2026-11-25T00:00:00.000Z", currentQuarter: "1", quarterCount: "2",
    }, "financing");
    const q = (n: number) => String(n);
    await run.permit(legal, "submitExecutedAgreement", { docusignEnvelopeId: "env-1", signedPdfHash: `0x${"ab".repeat(32)}`, executionComment: "Executed by both parties." });
    await run.permit(cns, "confirmAgreementLink", { linkComment: "Matches the signed PDF." });
    for (const n of [1, 2]) {
      if (n > 1) {
        await run.permit(legal, "submitSafeHash", { safeDocusignEnvelopeId: `safe-${n}`, safeSignedPdfHash: `0x${"5a".repeat(32)}`, quarter: q(n) });
        await run.permit(cns, "confirmSafe", { safeComment: "SAFE matches.", quarter: q(n) });
      }
      await run.permit(transactor, "submitPaymentProof", { transactionHash: `0x${"0" + n}`.padEnd(66, "0"), quarter: q(n) });
      await run.permit(cns, "confirmPayment", { paymentComment: `tranche ${n} received`, quarter: q(n), quarterStartDate: "2026-11-25T00:00:00.000Z" });
      if (n === 1) await run.permit(cns, "submitReport", { report: "Quarter 1 report", quarter: q(n), currentQuarter: q(n + 1) });
      else await run.permit(cns, "submitFinalReport", { report: "Quarter 2 report", quarter: q(n) });
    }
    expect(await run.state()).to.equal("COMPLETED");
  });
});
