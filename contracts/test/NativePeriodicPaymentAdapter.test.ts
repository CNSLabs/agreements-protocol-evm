import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const coder = ethers.AbiCoder.defaultAbiCoder();
const EMPTY = coder.encode(["tuple(bytes32 id,uint8 fType,bytes data)[]"], [[]]);
const ON = ethers.id("AUTO_RENEW_ON"), OFF = ethers.id("AUTO_RENEW_OFF");
const RENEW = ethers.id("renew"), CANCEL = ethers.id("cancel");
const AMOUNT = 1_000_000_000n, PERIOD = 60n;

async function fixture() {
  const [subscriber, merchant, other] = await ethers.getSigners();
  const manager = await ethers.deployContract("MockNativeDelegationManager");
  const payer = await manager.getAddress();
  const start = BigInt(await time.latest()) + 30n;
  const adapter = await ethers.deployContract("NativePeriodicPaymentAdapter", [
    payer, subscriber.address, payer, merchant.address, AMOUNT, start, PERIOD,
  ]);
  const implementation = await ethers.deployContract("AgreementEngine");
  const factory = await ethers.deployContract("AgreementFactory", [await implementation.getAddress()]);
  const allowed = (who: string) => [{ op: 17, fieldId: ethers.ZeroHash,
    bytesArg: coder.encode(["bytes32[]", "address[]"], [[], [who]]) }];
  const args = ["test://native-subscription", ethers.id("native-subscription"), ON,
    [{ id: RENEW, fields: [], conditions: allowed(merchant.address), verifierKeys: [] },
      { id: CANCEL, fields: [], conditions: allowed(subscriber.address), verifierKeys: [] }],
    [{ fromState: ON, toState: ON, inputId: RENEW }, { fromState: ON, toState: OFF, inputId: CANCEL }], [], [],
    [{ fromState: ON, inputId: RENEW, target: await adapter.getAddress(), value: 0,
      data: adapter.interface.encodeFunctionData("renew") }]] as const;
  const agreementAddress = await factory.createAgreement.staticCall(...args);
  await factory.createAgreement(...args);
  const agreement = await ethers.getContractAt("AgreementEngine", agreementAddress);
  await adapter.connect(subscriber).bindAgreement(agreementAddress);
  const delegation = { delegate: await adapter.getAddress(), delegator: payer,
    authority: ethers.toBeHex(ethers.MaxUint256), caveats: [], salt: 1n, signature: "0x" };
  await adapter.connect(subscriber).installPermissionContext(coder.encode([
    "tuple(address delegate,address delegator,bytes32 authority,tuple(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature)[]",
  ], [[delegation]]));
  return { subscriber, merchant, other, manager, adapter, agreement, start, payer };
}

describe("Native periodic payment", () => {
  it("transfers ETH and advances from the current paid-through time for an on-time renewal", async () => {
    const { subscriber, merchant, adapter, agreement, start, payer } = await loadFixture(fixture);
    await subscriber.sendTransaction({ to: payer, value: AMOUNT * 3n });
    await time.increaseTo(start);
    const merchantBefore = await ethers.provider.getBalance(merchant.address);
    const first = await (await agreement.connect(merchant).submitInput(RENEW, EMPTY)).wait();
    const firstTime = BigInt((await ethers.provider.getBlock(first!.blockNumber))!.timestamp);
    expect(await adapter.lastPaidThrough()).to.equal(firstTime + PERIOD);
    expect(await ethers.provider.getBalance(payer)).to.equal(AMOUNT * 2n);
    expect(await ethers.provider.getBalance(merchant.address)).to.equal(
      merchantBefore + AMOUNT - first!.fee,
    );

    await time.increaseTo(firstTime + PERIOD - 2n);
    const second = await (await agreement.connect(merchant).submitInput(RENEW, EMPTY)).wait();
    const secondTime = BigInt((await ethers.provider.getBlock(second!.blockNumber))!.timestamp);
    expect(secondTime).to.be.lessThan(firstTime + PERIOD);
    expect(await adapter.lastPaidThrough()).to.equal(firstTime + 2n * PERIOD);
    expect(await ethers.provider.getBalance(payer)).to.equal(AMOUNT);
  });

  it("starts a full new term after expiry and rejects a duplicate collection", async () => {
    const { subscriber, merchant, adapter, agreement, start, payer } = await loadFixture(fixture);
    await subscriber.sendTransaction({ to: payer, value: AMOUNT * 3n });
    await time.increaseTo(start);
    await agreement.connect(merchant).submitInput(RENEW, EMPTY);
    const originalPaidThrough = await adapter.lastPaidThrough();
    await expect(agreement.connect(merchant).submitInput(RENEW, EMPTY)).to.be.revertedWithCustomError(
      agreement, "ActionCallFailed",
    );
    expect(await ethers.provider.getBalance(payer)).to.equal(AMOUNT * 2n);
    await time.increaseTo(originalPaidThrough + 30n);
    const late = await (await agreement.connect(merchant).submitInput(RENEW, EMPTY)).wait();
    const lateTime = BigInt((await ethers.provider.getBlock(late!.blockNumber))!.timestamp);
    expect(await adapter.lastPaidThrough()).to.equal(lateTime + PERIOD);
    expect(await ethers.provider.getBalance(payer)).to.equal(AMOUNT);
  });

  it("does not grant coverage for a failed transfer", async () => {
    const { merchant, adapter, agreement, start } = await loadFixture(fixture);
    await time.increaseTo(start);
    await expect(agreement.connect(merchant).submitInput(RENEW, EMPTY)).to.be.revertedWithCustomError(
      agreement, "ActionCallFailed",
    );
    expect(await adapter.lastPaidThrough()).to.equal(0);
    expect(await agreement.currentState()).to.equal(ON);
  });

  it("preserves coverage when the subscriber cancels, then prevents collection", async () => {
    const { subscriber, merchant, adapter, agreement, start, payer } = await loadFixture(fixture);
    await subscriber.sendTransaction({ to: payer, value: AMOUNT * 3n });
    await time.increaseTo(start);
    await agreement.connect(merchant).submitInput(RENEW, EMPTY);
    const paidThrough = await adapter.lastPaidThrough();
    await agreement.connect(subscriber).submitInput(CANCEL, EMPTY);
    expect(await agreement.currentState()).to.equal(OFF);
    expect(await adapter.lastPaidThrough()).to.equal(paidThrough);
    await time.increaseTo(paidThrough);
    await expect(agreement.connect(merchant).submitInput(RENEW, EMPTY)).to.be.revertedWith("No valid transition");
    expect(await ethers.provider.getBalance(payer)).to.equal(AMOUNT * 2n);
  });
});
