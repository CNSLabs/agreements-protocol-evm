// SPDX-License-Identifier: Apache-2.0

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type DeploymentProvenance = {
  schemaVersion: string;
  chainId: string;
  implementation: string;
  factory: string;
  transactions: {
    implementationDeployment: { hash: string; inputHash: string };
    factoryDeployment: { hash: string; inputHash: string };
  };
  runtime: {
    implementationCodeHash: string;
    implementationCodeBytes: number;
    factoryCodeHash: string;
    factoryCodeBytes: number;
  };
};

function readDeployment(): DeploymentProvenance {
  const deploymentPath = path.resolve(
    __dirname,
    "../deployments",
    network.name,
    "AgreementsProtocol.json",
  );
  const parsed = JSON.parse(fs.readFileSync(deploymentPath, "utf8")) as DeploymentProvenance;
  if (parsed.schemaVersion !== "shodai.agreements.deployment-provenance/0.1") {
    throw new Error(`Unsupported or missing provenance schema in ${deploymentPath}`);
  }
  return parsed;
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: ${String(actual)} != ${String(expected)}`);
  }
  console.log(`✓ ${label}: ${String(actual)}`);
}

async function checkRuntime(
  label: string,
  address: string,
  expectedHash: string,
  expectedBytes: number,
): Promise<void> {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`${label} has no runtime code at ${address}`);
  assertEqual(`${label} runtime code hash`, ethers.keccak256(code), expectedHash);
  assertEqual(`${label} runtime byte length`, (code.length - 2) / 2, expectedBytes);
}

async function checkTransaction(
  label: string,
  transactionHash: string,
  expectedInputHash: string,
): Promise<void> {
  const transaction = await ethers.provider.getTransaction(transactionHash);
  if (!transaction) throw new Error(`${label} transaction not found: ${transactionHash}`);
  assertEqual(`${label} transaction input hash`, ethers.keccak256(transaction.data), expectedInputHash);
}

async function main(): Promise<void> {
  if (network.name === "hardhat") {
    throw new Error("Use a persistent RPC network so deployment transactions can be re-read");
  }
  const deployment = readDeployment();
  const providerNetwork = await ethers.provider.getNetwork();
  assertEqual("chain id", providerNetwork.chainId.toString(), deployment.chainId);

  await checkRuntime(
    "AgreementEngine",
    deployment.implementation,
    deployment.runtime.implementationCodeHash,
    deployment.runtime.implementationCodeBytes,
  );
  await checkRuntime(
    "AgreementFactory",
    deployment.factory,
    deployment.runtime.factoryCodeHash,
    deployment.runtime.factoryCodeBytes,
  );
  await checkTransaction(
    "AgreementEngine deployment",
    deployment.transactions.implementationDeployment.hash,
    deployment.transactions.implementationDeployment.inputHash,
  );
  await checkTransaction(
    "AgreementFactory deployment",
    deployment.transactions.factoryDeployment.hash,
    deployment.transactions.factoryDeployment.inputHash,
  );

  const factory = await ethers.getContractAt("AgreementFactory", deployment.factory);
  assertEqual("factory implementation", await factory.implementation(), deployment.implementation);
  console.log("\nDeployment provenance matches RPC state.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
