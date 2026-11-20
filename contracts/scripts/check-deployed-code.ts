// SPDX-License-Identifier: Apache-2.0

/**
 * Checks that the contracts recorded in deployments/<network>/AgreementsProtocol.json
 * run the code this checkout builds.
 *
 *   npx hardhat compile
 *   npx hardhat run scripts/check-deployed-code.ts --network lineaSepolia
 *
 * Read-only: it sends no transaction and needs no key. It exits with an error when
 * anything differs. Set WRITE_EVIDENCE=true to save the result next to the
 * deployment record as code-check.json.
 *
 * Immutable values are written into the runtime code at deployment and differ per
 * network, so those byte ranges are compared separately: every other byte must be
 * identical to the build, and the immutables must include the chain id, the
 * contract's own address and, for the factory, the recorded implementation.
 *
 * When the RPC serves historical state, the creating transaction is located too and
 * the code it sent is compared with the build's creation code. That comparison is
 * exact: creation code carries no immutable values.
 */

import { artifacts, ethers, network } from "hardhat";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

type ImmutableRef = { start: number; length: number };

type ContractCheck = {
  contract: string;
  address: string;
  codeBytes: number;
  codeMatchesBuild: boolean;
  chainCodeHash: string;
  comparedCodeHash: string;
  immutableBytesSetAside: number;
  immutableValues: string[];
  immutablesNameChainId: boolean;
  immutablesNameOwnAddress: boolean;
  immutablesNameImplementation?: boolean;
  creation?: {
    transaction: string;
    block: number;
    minedAt: string;
    from: string;
    sentCodeMatchesBuild: boolean;
  };
  creationLookup?: string;
};

function git(args: string): string {
  try {
    return execSync(`git ${args}`, { cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unavailable";
  }
}

function word(value: bigint | string): string {
  return ethers.zeroPadValue(ethers.toBeHex(value), 32).toLowerCase();
}

/**
 * Finds the transaction that created `address`, when the RPC serves historical state,
 * and compares the code it sent with the build's creation code plus constructor arguments.
 */
async function findCreation(address: string, expectedInput: string): Promise<ContractCheck["creation"]> {
  const provider = ethers.provider;
  let low = 0;
  let high = await provider.getBlockNumber();
  // First block at which the address has code.
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const code = await provider.getCode(address, mid);
    if (code !== "0x") high = mid;
    else low = mid + 1;
  }
  const block = await provider.getBlock(low);
  if (!block) throw new Error(`block ${low} not returned`);
  for (const hash of block.transactions) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt?.contractAddress && receipt.contractAddress.toLowerCase() === address.toLowerCase()) {
      const transaction = await provider.getTransaction(hash);
      return {
        transaction: hash,
        block: low,
        minedAt: new Date(block.timestamp * 1000).toISOString(),
        from: receipt.from,
        sentCodeMatchesBuild: transaction?.data.toLowerCase() === expectedInput.toLowerCase(),
      };
    }
  }
  throw new Error(`no creating transaction found in block ${low}`);
}

async function checkContract(
  name: string,
  address: string,
  chainId: bigint,
  implementation?: string,
): Promise<ContractCheck> {
  const buildInfo = await artifacts.getBuildInfo(`src/${name}.sol:${name}`);
  if (!buildInfo) throw new Error(`No build info for ${name}. Run "npx hardhat compile" first.`);
  const evm = (buildInfo.output.contracts[`src/${name}.sol`][name] as any).evm;
  const deployed = evm.deployedBytecode;
  const constructorArguments = implementation
    ? ethers.AbiCoder.defaultAbiCoder().encode(["address"], [implementation]).slice(2)
    : "";
  const expectedCreationInput = "0x" + evm.bytecode.object + constructorArguments;

  const local = Buffer.from(deployed.object, "hex");
  const chain = Buffer.from((await ethers.provider.getCode(address)).slice(2), "hex");
  const chainCodeHash = ethers.keccak256(chain);

  const immutableValues = new Set<string>();
  let immutableBytesSetAside = 0;
  const references = Object.values(deployed.immutableReferences ?? {}) as ImmutableRef[][];
  for (const refs of references) {
    for (const ref of refs) {
      if (ref.start + ref.length <= chain.length) {
        immutableValues.add("0x" + chain.subarray(ref.start, ref.start + ref.length).toString("hex"));
        chain.fill(0, ref.start, ref.start + ref.length);
      }
      local.fill(0, ref.start, ref.start + ref.length);
      immutableBytesSetAside += ref.length;
    }
  }

  const result: ContractCheck = {
    contract: name,
    address,
    codeBytes: chain.length,
    codeMatchesBuild: chain.length > 0 && local.equals(chain),
    chainCodeHash,
    comparedCodeHash: ethers.keccak256(chain),
    immutableBytesSetAside,
    immutableValues: [...immutableValues],
    immutablesNameChainId: immutableValues.has(word(chainId)),
    immutablesNameOwnAddress: immutableValues.has(word(address)),
  };
  if (implementation) {
    result.immutablesNameImplementation = immutableValues.has(word(implementation));
  }

  try {
    result.creation = await findCreation(address, expectedCreationInput);
  } catch (error) {
    result.creationLookup = `not available from this RPC: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  }
  return result;
}

async function main() {
  if (network.name === "hardhat" || network.name === "localhost") {
    throw new Error(`Run this against a deployed network, not ${network.name}`);
  }

  const recordPath = path.join(__dirname, "../deployments", network.name, "AgreementsProtocol.json");
  if (!fs.existsSync(recordPath)) throw new Error(`Deployment record not found: ${recordPath}`);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));

  const { chainId } = await ethers.provider.getNetwork();
  if (chainId.toString() !== String(record.chainId)) {
    throw new Error(`The RPC answers for chain ${chainId}, the record is for chain ${record.chainId}`);
  }

  const buildInfo = await artifacts.getBuildInfo("src/AgreementEngine.sol:AgreementEngine");
  if (!buildInfo) throw new Error(`No build info. Run "npx hardhat compile" first.`);
  const settings = buildInfo.input.settings as any;
  const openZeppelin = JSON.parse(
    fs.readFileSync(require.resolve("@openzeppelin/contracts/package.json"), "utf8"),
  ).version;

  const engine = await checkContract("AgreementEngine", record.implementation, chainId);
  const factory = await checkContract("AgreementFactory", record.factory, chainId, record.implementation);

  const factoryContract = await ethers.getContractAt("AgreementFactory", record.factory);
  const factoryImplementation: string = await factoryContract.implementation();
  const factoryPointsAtRecordedImplementation =
    factoryImplementation.toLowerCase() === String(record.implementation).toLowerCase();

  const evidence = {
    network: network.name,
    chainId: chainId.toString(),
    checkedAt: new Date().toISOString(),
    record: {
      version: record.version ?? null,
      implementation: record.implementation,
      factory: record.factory,
      deployedAt: record.deployedAt,
      deployer: record.deployer,
    },
    build: {
      commit: git("rev-parse HEAD"),
      contractSourceTree: git("rev-parse HEAD:contracts/src"),
      uncommittedSourceChanges: git("status --porcelain -- src") !== "",
      solc: buildInfo.solcLongVersion,
      optimizer: settings.optimizer,
      viaIR: settings.viaIR ?? false,
      evmVersion: settings.evmVersion,
      openZeppelin,
    },
    contracts: [engine, factory],
    factoryPointsAtRecordedImplementation,
  };

  const failures: string[] = [];
  for (const c of [engine, factory]) {
    if (!c.codeMatchesBuild) failures.push(`${c.contract}: on-chain code differs from the build`);
    if (!c.immutablesNameChainId) failures.push(`${c.contract}: no immutable holds chain id ${chainId}`);
    if (!c.immutablesNameOwnAddress) failures.push(`${c.contract}: no immutable holds its own address`);
    if (c.immutablesNameImplementation === false) {
      failures.push(`${c.contract}: no immutable holds the recorded implementation`);
    }
    if (c.creation && !c.creation.sentCodeMatchesBuild) {
      failures.push(`${c.contract}: the creating transaction did not send the build's creation code`);
    }
  }
  if (!factoryPointsAtRecordedImplementation) {
    failures.push(`factory.implementation() is ${factoryImplementation}, the record says ${record.implementation}`);
  }
  if (evidence.build.uncommittedSourceChanges) {
    failures.push("contracts/src has uncommitted changes, so the build is not the named commit");
  }

  const output = JSON.stringify({ ...evidence, result: failures.length === 0 ? "match" : "mismatch", failures }, null, 2);
  console.log(output);

  if (process.env.WRITE_EVIDENCE === "true") {
    const evidencePath = path.join(path.dirname(recordPath), "code-check.json");
    fs.writeFileSync(evidencePath, output + "\n");
    console.error(`Saved to ${evidencePath}`);
  }

  if (failures.length > 0) {
    throw new Error(`Deployed code check failed:\n- ${failures.join("\n- ")}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
