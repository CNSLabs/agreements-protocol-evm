// SPDX-License-Identifier: Apache-2.0

import { network, run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type DeploymentInfo = {
  implementation: string;
  factory: string;
};

type VerificationStatus = "verified" | "already-verified" | "failed";

type VerificationResult = {
  contractName: string;
  status: VerificationStatus;
  errorMessage?: string;
};

function readDeploymentInfo(networkName: string): DeploymentInfo {
  const deploymentPath = path.join(
    __dirname,
    "../deployments",
    networkName,
    "AgreementsProtocol.json",
  );

  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`Deployment file not found: ${deploymentPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(deploymentPath, "utf8")) as Partial<DeploymentInfo>;
  if (!parsed.implementation || !parsed.factory) {
    throw new Error(`Deployment file is missing implementation or factory address: ${deploymentPath}`);
  }

  return {
    implementation: parsed.implementation,
    factory: parsed.factory,
  };
}

async function verifyContract(
  contractName: string,
  address: string,
  constructorArguments: unknown[],
): Promise<VerificationResult> {
  try {
    console.log(`Verifying ${contractName} at ${address}...`);
    await run("verify:verify", {
      address,
      constructorArguments,
    });
    console.log(`✓ ${contractName} verified`);
    return { contractName, status: "verified" };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const normalizedError = errorMessage.toLowerCase();

    if (
      normalizedError.includes("already verified") ||
      normalizedError.includes("contract source code already verified") ||
      normalizedError.includes("smart-contract already verified")
    ) {
      console.log(`✓ ${contractName} already verified`);
      return { contractName, status: "already-verified" };
    }

    console.warn(`Warning: failed to verify ${contractName}: ${errorMessage}`);
    return { contractName, status: "failed", errorMessage };
  }
}

async function main() {
  if (network.name === "hardhat" || network.name === "localhost") {
    throw new Error(`Refusing to verify deployment on local network: ${network.name}`);
  }

  if (!(process.env.ETHERSCAN_API_KEY ?? "").trim()) {
    throw new Error("ETHERSCAN_API_KEY must be set to verify deployed contracts");
  }

  const deployment = readDeploymentInfo(network.name);
  const results = [
    await verifyContract("AgreementEngine implementation", deployment.implementation, []),
    await verifyContract("AgreementFactory", deployment.factory, [deployment.implementation]),
  ];

  const failed = results.filter((result) => result.status === "failed");
  if (failed.length > 0) {
    console.error("\nVerification failed:");
    for (const result of failed) {
      console.error(`- ${result.contractName}: ${result.errorMessage}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("\nDeployment verification complete.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
