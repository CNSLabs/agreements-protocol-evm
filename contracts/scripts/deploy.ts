import { ethers, run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

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

async function main() {
  console.log("Deploying Agreements Protocol...");

  // Check if verification should be enabled (defaults to false for safety)
  // Set VERIFY_CONTRACTS=true to enable verification
  const shouldVerify = process.env.VERIFY_CONTRACTS === "true";

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

  const network = await ethers.provider.getNetwork();
  const isLocalNetwork = network.name === "hardhat" || network.name === "localhost";

  // Wait for a few block confirmations before verification
  console.log("\n   Waiting for block confirmations...");
  if (!isLocalNetwork) {
    if (implementationTx) {
      console.log("   Waiting for implementation deployment to be confirmed...");
      await implementationTx.wait(5);
    }
    if (factoryTx) {
      console.log("   Waiting for factory deployment to be confirmed...");
      await factoryTx.wait(5);
    }
  } else {
    console.log("   Local network detected - skipping additional block confirmation wait");
  }

  const deploymentInfo = {
    implementation: implementationAddress,
    factory: factoryAddress,
    chainId: network.chainId.toString(),
    network: network.name,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
  };

  const deploymentPath = writeDeploymentInfo(network.name, deploymentInfo);
  console.log("\n3. Deployment info saved to:", deploymentPath);
  console.log("   Note: SDK will automatically pick up this deployment on next build");
  console.log("   (SDK reads directly from contracts/deployments/ folder)");

  // Verify contracts (if enabled)
  console.log("\n5. Contract verification...");
  
  // Only verify on non-local networks and if verification is enabled
  if (network.name !== "hardhat" && network.name !== "localhost" && shouldVerify) {
    try {
      console.log("   Verifying AgreementEngine implementation...");
      await run("verify:verify", {
        address: implementationAddress,
        constructorArguments: [],
      });
      console.log("   ✓ AgreementEngine verified");
    } catch (error: any) {
      if (error.message?.includes("Already Verified")) {
        console.log("   ✓ AgreementEngine already verified");
      } else {
        console.warn("   ⚠ Failed to verify AgreementEngine:", error.message);
      }
    }

    try {
      console.log("   Verifying AgreementFactory...");
      await run("verify:verify", {
        address: factoryAddress,
        constructorArguments: [implementationAddress],
      });
      console.log("   ✓ AgreementFactory verified");
    } catch (error: any) {
      if (error.message?.includes("Already Verified")) {
        console.log("   ✓ AgreementFactory already verified");
      } else {
        console.warn("   ⚠ Failed to verify AgreementFactory:", error.message);
      }
    }
  } else if (network.name === "hardhat" || network.name === "localhost") {
    console.log("   Skipping verification on local network");
  } else if (!shouldVerify) {
    console.log("   ⚠️  Verification skipped (set VERIFY_CONTRACTS=true to enable)");
  }

  console.log("\n=== Deployment Summary ===");
  console.log("Implementation:", implementationAddress);
  console.log("Factory:", factoryAddress);
  console.log("Network:", network.name);
  console.log("Chain ID:", network.chainId.toString());
  console.log("\nDeployment complete!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
