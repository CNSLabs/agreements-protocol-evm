// SPDX-License-Identifier: Apache-2.0
//
// A counted loop from the agreement JSON down to the contracts: the SDK turns
// an input's `checks` and `store` into conditions and a stored field, and the
// engine counts the milestones.

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadAgreement, deployProtocol, loadSDKModule, createViemClientsForSigner } from "../test-helpers";
import type { AgreementJson } from "../../../../sdk/src/types";

describe("AgreementEngine (integration) - counted milestones, checks and stored fields", () => {
  let counted: AgreementJson;
  let AgreementFactoryClass: any;
  let AgreementEngineClass: any;

  before(async () => {
    counted = loadAgreement("counted-milestones");
    const sdkModule = await loadSDKModule();
    AgreementFactoryClass = sdkModule.AgreementFactory;
    AgreementEngineClass = sdkModule.AgreementEngine;
  });

  async function setup(milestoneCount: number) {
    const [grantee, reviewer, relayer] = await ethers.getSigners();
    const { factory: deployed } = await deployProtocol();
    const factory = new AgreementFactoryClass({ factoryAddress: await deployed.getAddress() }, await createViemClientsForSigner(relayer));
    const { address } = await factory.createAgreement(counted, {
      initValues: { grantee: grantee.address, reviewer: reviewer.address, milestoneCount: String(milestoneCount), currentMilestone: "1" },
    });
    const engineFor = async (signer: any) => {
      const clients = await createViemClientsForSigner(signer);
      return { engine: new AgreementEngineClass(address, clients.publicClient, clients.walletClient), ...clients };
    };
    const g = await engineFor(grantee);
    const r = await engineFor(reviewer);
    const view = (await engineFor(relayer)).engine;
    const refused = async (attempt: Promise<unknown>) => {
      try { await attempt; return null; } catch (error: any) { return String(error.message); }
    };
    return {
      state: () => view.getCurrentState(counted),
      view,
      grantee: g,
      reviewer: r,
      refused,
      submitWork: (milestone: number) => g.engine.submitInput(counted, "submitWork", { workNote: "delivered", milestone: String(milestone) }, true),
      requestChanges: (milestone: number) => r.engine.submitInput(counted, "requestChanges", { reviewNote: "please revise", milestone: String(milestone) }, true),
      accept: (milestone: number, next = milestone + 1) =>
        r.engine.submitInput(counted, "acceptMilestone", { reviewNote: "accepted", milestone: String(milestone), currentMilestone: String(next) }, true),
      acceptFinal: (milestone: number) => r.engine.submitInput(counted, "acceptFinalMilestone", { reviewNote: "accepted", milestone: String(milestone) }, true),
    };
  }

  for (const count of [1, 3]) {
    it(`a grant of ${count} milestone(s) runs to completion, each milestone once and in order`, async () => {
      const s = await setup(count);
      for (let m = 1; m <= count; m++) {
        const last = m === count;
        // Work named for another milestone is refused.
        expect(await s.refused(s.submitWork(m + 1))).to.match(/ComparisonFailed/);
        await s.submitWork(m);
        expect(await s.state()).to.equal("IN_REVIEW");
        if (m === 1) {
          await s.requestChanges(m);
          await s.submitWork(m);
        }
        // The wrong kind of acceptance, another milestone, and a skip are refused.
        expect(await s.refused(last ? s.accept(m) : s.acceptFinal(m))).to.match(/ComparisonFailed/);
        expect(await s.refused(last ? s.acceptFinal(m - 1) : s.accept(m + 1))).to.match(/ComparisonFailed/);
        if (!last) expect(await s.refused(s.accept(m, m + 2)), "skipping a milestone").to.match(/ComparisonFailed/);
        expect(await s.state()).to.equal("IN_REVIEW");

        await (last ? s.acceptFinal(m) : s.accept(m));
        expect(await s.state()).to.equal(last ? "COMPLETED" : "WORK_IN_PROGRESS");
      }
    });
  }

  it("work signed for one milestone and never submitted is refused for the next, by the check on the milestone", async () => {
    const s = await setup(3);
    await s.submitWork(1);
    // While milestone 1 is in review the grantee signs a resubmission, in case changes are requested.
    // The grantee submits nothing after this, so the permit stays valid for the grantee's next input.
    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 3600;
    const stale = { workNote: "revised", milestone: "1" };
    const permit = await s.grantee.engine.createPermitSignature(s.grantee.walletClient, counted, "submitWork", stale, deadline);
    // The reviewer accepts instead: the agreement is on milestone 2 and takes work again.
    await s.accept(1);
    expect(await s.state()).to.equal("WORK_IN_PROGRESS");

    const replay = s.view.submitInputWithPermit(permit.signerAddress, counted, "submitWork", stale, deadline, permit.signature, true);
    expect(await s.refused(replay)).to.match(/ComparisonFailed/);
    expect(await s.state()).to.equal("WORK_IN_PROGRESS");

    // The refusal was the milestone check and nothing else: the same signer, at the same permit
    // nonce and deadline, is accepted for milestone 2.
    const current = { workNote: "delivered", milestone: "2" };
    const fresh = await s.grantee.engine.createPermitSignature(s.grantee.walletClient, counted, "submitWork", current, deadline);
    await s.view.submitInputWithPermit(fresh.signerAddress, counted, "submitWork", current, deadline, fresh.signature, true);
    expect(await s.state()).to.equal("IN_REVIEW");
  });
});
