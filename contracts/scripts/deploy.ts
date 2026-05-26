// SPDX-License-Identifier: Apache-2.0

import { ethers, run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type VerificationConfig = {
  enabled: boolean;
  reason: string;
};

type VerificationStatus = "verified" | "already-verified" | "failed";

type VerificationResult = {
  status: VerificationStatus;
  errorMessage?: string;
};

function isLocalNetwork(networkName: string) {
  return networkName === "hardhat" || networkName === "localhost";
}

function resolveVerificationConfig(networkName: string): VerificationConfig {
  const skipVerification = process.env.SKIP_CONTRACT_VERIFICATION === "true";
  const hasEtherscanApiKey = (process.env.ETHERSCAN_API_KEY ?? "").trim().length > 0;

  if (isLocalNetwork(networkName)) {
    return { enabled: false, reason: "local network" };
  }

  if (skipVerification) {
    return { enabled: false, reason: "SKIP_CONTRACT_VERIFICATION=true" };
  }

  if (hasEtherscanApiKey) {
    return { enabled: true, reason: "ETHERSCAN_API_KEY detected" };
  }

  return {
    enabled: false,
    reason: "ETHERSCAN_API_KEY is not set; set SKIP_CONTRACT_VERIFICATION=true to skip intentionally",
  };
}

function getExplorerBaseUrl(networkName: string) {
  if (networkName === "linea") {
    return "https://lineascan.build";
  }
  if (networkName === "lineaSepolia") {
    return "https://sepolia.lineascan.build";
  }
  if (networkName === "sepolia") {
    return "https://sepolia.etherscan.io";
  }
  return null;
}

function getCodeUrl(networkName: string, address: string) {
  const explorerBaseUrl = getExplorerBaseUrl(networkName);
  return explorerBaseUrl ? `${explorerBaseUrl}/address/${address}#code` : null;
}

function writeDeploymentInfo(networkName: string, deploymentInfo: Record<string, string>) {
  const deploymentDir = path.join(__dirname, "../deployments");
  const networkDir = path.join(deploymentDir, networkName);

  if (!fs.existsSync(networkDir)) {
    fs.mkdirSync(networkDir, { recursive: true });
  }

  const deploymentPath = path.join(networkDir, "AgreementsProtocol.json");
  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2));

  return deploymentPath;
}

async function verifyContract(
  contractName: string,
  address: string,
  constructorArguments: unknown[],
): Promise<VerificationResult> {
  try {
    console.log(`   Verifying ${contractName}...`);
    await run("verify:verify", {
      address,
      constructorArguments,
    });
    console.log(`   ✓ ${contractName} verified`);
    return { status: "verified" };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const normalizedError = errorMessage.toLowerCase();

    if (
      normalizedError.includes("already verified") ||
      normalizedError.includes("contract source code already verified") ||
      normalizedError.includes("smart-contract already verified")
    ) {
      console.log(`   ✓ ${contractName} already verified`);
      return { status: "already-verified" };
    }

    console.warn(`   Warning: failed to verify ${contractName}: ${errorMessage}`);
    return {
      status: "failed",
      errorMessage,
    };
  }
}

async function main() {
  console.log("Deploying Agreements Protocol...");

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", (await ethers.provider.getBalance(deployer.address)).toString());

  // 1. Deploy AgreementEngine implementation
  console.log("\n1. Deploying AgreementEngine implementation...");
  const AgreementEngine = await ethers.getContractFactory("AgreementEngine");
  const implementation = await AgreementEngine.deploy();
  const implementationTx = await implementation.deploymentTransaction();
  await implementation.waitForDeployment();
  const implementationAddress = await implementation.getAddress();
  console.log("   Implementation deployed to:", implementationAddress);

  // 2. Deploy AgreementFactory pointing to implementation
  console.log("\n2. Deploying AgreementFactory...");
  const AgreementFactory = await ethers.getContractFactory("AgreementFactory");
  const factory = await AgreementFactory.deploy(implementationAddress);
  const factoryTx = await factory.deploymentTransaction();
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("   Factory deployed to:", factoryAddress);

  const providerNetwork = await ethers.provider.getNetwork();
  const networkName = providerNetwork.name;
  const verificationConfig = resolveVerificationConfig(networkName);
  let implementationVerification: VerificationResult | null = null;
  let factoryVerification: VerificationResult | null = null;

  if (verificationConfig.enabled) {
    console.log("\n3. Waiting for block confirmations before verification...");
    if (implementationTx) {
      console.log("   Waiting for implementation deployment to be confirmed...");
      await implementationTx.wait(5);
    }
    if (factoryTx) {
      console.log("   Waiting for factory deployment to be confirmed...");
      await factoryTx.wait(5);
    }
  } else if (!isLocalNetwork(networkName)) {
    console.log(`\n3. Skipping contract verification: ${verificationConfig.reason}`);
  }

  const deploymentInfo = {
    implementation: implementationAddress,
    factory: factoryAddress,
    chainId: providerNetwork.chainId.toString(),
    network: networkName,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
  };

  if (verificationConfig.enabled) {
    console.log(`\n4. Contract verification enabled: ${verificationConfig.reason}`);
    implementationVerification = await verifyContract(
      "AgreementEngine implementation",
      implementationAddress,
      [],
    );
    factoryVerification = await verifyContract(
      "AgreementFactory",
      factoryAddress,
      [implementationAddress],
    );
  }

  const deploymentPath = writeDeploymentInfo(networkName, deploymentInfo);
  console.log("\n5. Deployment info saved to:", deploymentPath);
  console.log("   Note: SDK will automatically pick up this deployment on next build");
  console.log("   (SDK reads directly from contracts/deployments/ folder)");

  console.log("\n=== Deployment Summary ===");
  console.log("Implementation:", implementationAddress);
  console.log("Factory:", factoryAddress);
  console.log("Network:", networkName);
  console.log("Chain ID:", providerNetwork.chainId.toString());

  const implementationCodeUrl = getCodeUrl(networkName, implementationAddress);
  if (implementationCodeUrl) {
    console.log("Implementation explorer:", implementationCodeUrl);
  }
  const factoryCodeUrl = getCodeUrl(networkName, factoryAddress);
  if (factoryCodeUrl) {
    console.log("Factory explorer:", factoryCodeUrl);
  }

  if (verificationConfig.enabled) {
    console.log("Verification:");
    console.log(`  AgreementEngine implementation: ${implementationVerification?.status ?? "unknown"}`);
    console.log(`  AgreementFactory: ${factoryVerification?.status ?? "unknown"}`);
  } else {
    console.log(`Verification: skipped (${verificationConfig.reason})`);
  }

  console.log("\nDeployment complete!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
