/**
 * Gas threshold checker - fails if gas costs exceed defined limits
 * Usage: npx hardhat run scripts/check-gas-thresholds.ts
 */

import * as fs from "fs";
import * as path from "path";

interface GasThresholds {
  [contract: string]: {
    [method: string]: {
      max: number; // Maximum acceptable gas
      deployment?: number; // Max deployment gas
    };
  };
}

// Define your gas budgets here
// Thresholds are set ~25-30% above current max values to allow for reasonable variance
const GAS_THRESHOLDS: GasThresholds = {
  AgreementFactory: {
    createAgreement: {
      max: 3500000, // Current max: 2.82M, threshold: 3.5M (~24% leeway)
    },
  },
  AgreementEngine: {
    submitInput: {
      max: 220000, // Current max: 169k, threshold: 220k (~30% leeway)
    },
  },
};

function parseGasReport(): Map<string, Map<string, number>> {
  const reportPath = path.resolve(__dirname, "../gas-report.txt");
  if (!fs.existsSync(reportPath)) {
    throw new Error("gas-report.txt not found. Run tests first.");
  }

  const report = fs.readFileSync(reportPath, "utf-8");
  const gasData = new Map<string, Map<string, number>>();

  // Parse the gas report - format uses · (middle dot) as separators
  // Example: |  AgreementEngine   ·  submitInput      ·      84395  ·     169673  ·     109013  ·           77  ·          -  |
  const methodRegex = /\|\s+(\w+)\s+·\s+(\w+)\s+·\s+[\d-]+\s+·\s+[\d-]+\s+·\s+(\d+)/g;
  let match;

  while ((match = methodRegex.exec(report)) !== null) {
    const contract = match[1];
    const method = match[2];
    const avgGas = parseInt(match[3]);

    if (!gasData.has(contract)) {
      gasData.set(contract, new Map());
    }
    gasData.get(contract)!.set(method, avgGas);
  }

  // Parse deployments - format: |  AgreementEngine                       ·          -  ·          -  ·    2453998  ·        8.2 %  ·          -  |
  // Note: Deployment rows have "-" in the method column (second position), distinguishing them from method rows
  const deployRegex = /\|\s+(\w+)\s+·\s+-\s+·\s+-\s+·\s+(\d+)/g;
  while ((match = deployRegex.exec(report)) !== null) {
    const contract = match[1];
    const deployGas = parseInt(match[2]);

    if (!gasData.has(contract)) {
      gasData.set(contract, new Map());
    }
    gasData.get(contract)!.set("deployment", deployGas);
  }

  return gasData;
}

function checkThresholds() {
  const gasData = parseGasReport();
  const failures: string[] = [];

  for (const [contract, thresholds] of Object.entries(GAS_THRESHOLDS)) {
    const contractData = gasData.get(contract);
    if (!contractData) {
      console.warn(`⚠️  No gas data found for ${contract}`);
      continue;
    }

    for (const [method, threshold] of Object.entries(thresholds)) {
      if (method === "deployment") continue; // Handle separately

      const actualGas = contractData.get(method);
      if (actualGas === undefined) {
        console.warn(`⚠️  No gas data for ${contract}.${method}`);
        continue;
      }

      if (actualGas > threshold.max) {
        failures.push(
          `❌ ${contract}.${method}: ${actualGas} gas exceeds threshold of ${threshold.max} (${((actualGas / threshold.max - 1) * 100).toFixed(1)}% over)`
        );
      } else {
        console.log(`✅ ${contract}.${method}: ${actualGas} gas (threshold: ${threshold.max})`);
      }
    }

    // Check deployment (only if threshold is defined)
    if (thresholds.deployment) {
      const deployGas = contractData.get("deployment");
      if (deployGas && deployGas > thresholds.deployment.max) {
        failures.push(
          `❌ ${contract} deployment: ${deployGas} gas exceeds threshold of ${thresholds.deployment.max}`
        );
      }
    }
  }

  if (failures.length > 0) {
    console.error("\n🚨 Gas threshold violations:");
    failures.forEach((f) => console.error(f));
    process.exit(1);
  }

  console.log("\n✅ All gas costs within thresholds");
}

checkThresholds();