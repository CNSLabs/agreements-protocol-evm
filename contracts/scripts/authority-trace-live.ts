// Live authority-enforcement trace (v2) — runnable against any network.
//
//   Local (proves the script works):   npx hardhat run scripts/authority-trace-live.ts
//   Public testnet (external artifact): PRIVATE_KEY=<funded key> LINEA_SEPOLIA_RPC_URL=<rpc> \
//                                       npx hardhat run scripts/authority-trace-live.ts --network lineaSepolia
//
// Uses a SINGLE signer (so it runs with one funded testnet key): the signer submits while UNREGISTERED
// → the tx reverts on-chain; then registers + attests itself → the tx passes and the FSM advances. Prints
// each tx hash so a public-testnet run yields verifiable Lineascan links.

import { ethers, network } from "hardhat";

const k = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
const EMPTY = ethers.AbiCoder.defaultAbiCoder().encode(["tuple(bytes32,uint8,bytes)[]"], [[]]);
const START = k("START");
const DONE = k("DONE");
const ADVANCE = k("advance");
const AUTH_KEY = k("authority");
const ROLE = k("role:party");
const explorer = network.name === "lineaSepolia" ? "https://sepolia.lineascan.build/tx/" : "";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log(`network=${network.name}  signer=${signer.address}`);

  const impl = await ethers.deployContract("AgreementEngine");
  await impl.waitForDeployment();
  const factory = await ethers.deployContract("AgreementFactory", [await impl.getAddress()]);
  await factory.waitForDeployment();
  const registry = await ethers.deployContract("MockErc8004Registry");
  await registry.waitForDeployment();
  const verifier = await ethers.deployContract("AuthorityInputVerifier", [await registry.getAddress(), 50, ROLE]);
  await verifier.waitForDeployment();
  console.log(`deployed: engine impl, factory, registry, AuthorityInputVerifier(minRep=50, role=role:party)`);

  const inputDefs = [{ id: ADVANCE, fields: [], conditions: [], verifierKeys: [AUTH_KEY] }];
  const transitions = [{ fromState: START, toState: DONE, inputId: ADVANCE }];
  const verifiers = [{ key: AUTH_KEY, verifier: await verifier.getAddress() }];
  const addr = await factory.createAgreement.staticCall("ipfs://live", k("doc"), START, inputDefs, transitions, [], verifiers, []);
  const createTx = await factory.createAgreement("ipfs://live", k("doc"), START, inputDefs, transitions, [], verifiers, []);
  await createTx.wait();
  const agreement = await ethers.getContractAt("AgreementEngine", addr);
  console.log(`agreement=${addr}  (create tx ${explorer}${createTx.hash})`);

  // 1) UNREGISTERED signer submits → must revert on-chain.
  try {
    const tx = await agreement.submitInput(ADVANCE, EMPTY);
    await tx.wait();
    console.log(`  ✗ UNEXPECTED: unauthorized submit did NOT revert (${tx.hash})`);
    process.exitCode = 1;
    return;
  } catch (e: any) {
    console.log(`  ✅ unauthorized submit REVERTED on-chain (${(e.shortMessage || e.message || "").slice(0, 80)})`);
    console.log(`     state still: ${await agreement.currentState()}`);
  }

  // 2) register + attest, then submit → passes.
  await (await registry.register(signer.address, 80)).wait();
  await (await registry.addValidation(signer.address, ROLE)).wait();
  const okTx = await agreement.submitInput(ADVANCE, EMPTY);
  await okTx.wait();
  console.log(`  ✅ attested submit PASSED (${explorer}${okTx.hash})`);
  console.log(`     state now: ${(await agreement.currentState()) === DONE ? "DONE" : await agreement.currentState()}`);
  console.log(`done — the on-chain authority gate reverts the unauthorized tx and passes the attested one.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
