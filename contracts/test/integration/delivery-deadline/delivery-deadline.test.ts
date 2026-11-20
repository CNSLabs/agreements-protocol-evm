// SPDX-License-Identifier: Apache-2.0
//
// Time windows from the agreement JSON down to the contracts: the SDK turns an
// input's `time` window into conditions on the block time, and the engine
// enforces them on direct inputs and on permits.

import { expect } from "chai";
import { ethers } from "hardhat";
import { time, takeSnapshot } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { SnapshotRestorer } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { loadAgreement, deployProtocol, loadSDKModule, createViemClientsForSigner } from "../test-helpers";
import type { AgreementJson } from "../../../../sdk/src/types";

const NOTE = { deliveryNote: "40 units, lot 7" };
const LATE = { lateNote: "Nothing arrived" };

describe("AgreementEngine (integration) - delivery deadline, time windows", () => {
  let deliveryDeadline: AgreementJson;
  let AgreementFactoryClass: any;
  let AgreementEngineClass: any;
  let factoryAddress: `0x${string}`;
  let restorer: SnapshotRestorer;

  before(async () => {
    deliveryDeadline = loadAgreement("delivery-deadline");
    const sdkModule = await loadSDKModule();
    AgreementFactoryClass = sdkModule.AgreementFactory;
    AgreementEngineClass = sdkModule.AgreementEngine;
    // Deployed before the first snapshot: the suite shares this factory.
    factoryAddress = (await (await deployProtocol()).factory.getAddress()) as `0x${string}`;
  });

  // The tests move the chain clock, so each one hands it back as it found it.
  beforeEach(async () => {
    restorer = await takeSnapshot();
  });
  afterEach(async () => {
    await restorer.restore();
  });

  async function setup(agreement: AgreementJson, dueIn = 1000) {
    const [supplier, buyer, relayer] = await ethers.getSigners();
    const dueDate = (await time.latest()) + dueIn;
    const asRelayer = await createViemClientsForSigner(relayer);
    const factory = new AgreementFactoryClass({ factoryAddress }, asRelayer);
    const { address } = await factory.createAgreement(agreement, {
      initValues: { supplier: supplier.address, buyer: buyer.address, dueDate: String(dueDate) },
    });
    const engineFor = async (signer: any) => {
      const clients = await createViemClientsForSigner(signer);
      return { engine: new AgreementEngineClass(address, clients.publicClient, clients.walletClient), ...clients };
    };
    const view = (await engineFor(relayer)).engine;
    return {
      dueDate,
      supplier: await engineFor(supplier),
      buyer: await engineFor(buyer),
      view,
      state: () => view.getCurrentState(agreement),
    };
  }

  const refusal = async (attempt: Promise<unknown>) => {
    try {
      await attempt;
      return null;
    } catch (error: any) {
      return String(error.message);
    }
  };

  it("the supplier delivers before the due date, and the buyer cannot declare it late yet", async () => {
    const s = await setup(deliveryDeadline);

    expect(await refusal(s.buyer.engine.submitInput(deliveryDeadline, "declareLate", LATE, true))).to.match(/ComparisonFailed/);
    expect(await s.state()).to.equal("AWAITING_DELIVERY");

    await s.supplier.engine.submitInput(deliveryDeadline, "deliver", NOTE, true);
    expect(await s.state()).to.equal("DELIVERED");
  });

  it("from the due date on, a delivery is refused and the buyer can declare it late", async () => {
    const s = await setup(deliveryDeadline);
    await time.increaseTo(s.dueDate);

    expect(await refusal(s.supplier.engine.submitInput(deliveryDeadline, "deliver", NOTE, true))).to.match(/ComparisonFailed/);
    expect(await s.state()).to.equal("AWAITING_DELIVERY");

    await s.buyer.engine.submitInput(deliveryDeadline, "declareLate", LATE, true);
    expect(await s.state()).to.equal("LATE");
  });

  it("a delivery permit signed in time is refused when it is submitted after the due date", async () => {
    const s = await setup(deliveryDeadline);
    const deadline = s.dueDate + 3600;
    const permit = await s.supplier.engine.createPermitSignature(s.supplier.walletClient, deliveryDeadline, "deliver", NOTE, deadline);

    await time.increaseTo(s.dueDate);
    const late = s.view.submitInputWithPermit(permit.signerAddress, deliveryDeadline, "deliver", NOTE, deadline, permit.signature, true);
    expect(await refusal(late)).to.match(/ComparisonFailed/);
    expect(await s.state()).to.equal("AWAITING_DELIVERY");
  });

  it("a delivery permit submitted by a relayer before the due date is accepted", async () => {
    const s = await setup(deliveryDeadline);
    const deadline = s.dueDate + 3600;
    const permit = await s.supplier.engine.createPermitSignature(s.supplier.walletClient, deliveryDeadline, "deliver", NOTE, deadline);

    await s.view.submitInputWithPermit(permit.signerAddress, deliveryDeadline, "deliver", NOTE, deadline, permit.signature, true);
    expect(await s.state()).to.equal("DELIVERED");
  });

  it("a window between two fixed moments, written as ISO date-times", async () => {
    const now = await time.latest();
    const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
    const windowed: AgreementJson = JSON.parse(JSON.stringify(deliveryDeadline));
    windowed.execution.inputs.deliver.time = { notBefore: iso(now + 1000), before: iso(now + 2000) };
    const s = await setup(windowed, 5000);

    expect(await refusal(s.supplier.engine.submitInput(windowed, "deliver", NOTE, true))).to.match(/ComparisonFailed/);

    await time.increaseTo(now + 1500);
    await s.supplier.engine.submitInput(windowed, "deliver", NOTE, true);
    expect(await s.state()).to.equal("DELIVERED");

    // A second agreement, tried after the window has closed.
    const closed = await setup(windowed, 5000);
    await time.increaseTo(now + 2000);
    expect(await refusal(closed.supplier.engine.submitInput(windowed, "deliver", NOTE, true))).to.match(/ComparisonFailed/);
  });
});
