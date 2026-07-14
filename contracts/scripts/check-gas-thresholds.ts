// SPDX-License-Identifier: Apache-2.0

/**
 * Gas threshold checker - fails if gas costs exceed defined limits
 * Usage: npx hardhat run scripts/check-gas-thresholds.ts
 */

import * as fs from "fs";
import * as path from "path";

interface MethodGasMeasurement {
  min: number | null;
  max: number | null;
  avg: number;
}

interface GasReport {
  methods: Map<string, Map<string, MethodGasMeasurement>>;
  deployments: Map<string, number>;
}

// These budgets cover the largest observation in the complete P0 test suite.
// A method with a single observation is reported by eth-gas-reporter with only
// an average, so the checker uses that value and labels it explicitly.
const METHOD_GAS_BUDGETS: Record<string, Record<string, number>> = {
  AgreementFactory: {
    createAgreement: 5_750_000,
    createAgreementWithPermit: 410_000,
    createAgreementDeterministicWithPermit: 390_000,
  },
  AgreementEngine: {
    submitInput: 335_000,
    submitInputWithPermit: 135_000,
  },
};

const DEPLOYMENT_GAS_BUDGETS: Record<string, number> = {
  AgreementEngine: 4_100_000,
  AgreementFactory: 1_900_000,
};

function parseReportedNumber(value: string): number | null {
  return value === "-" ? null : Number.parseInt(value, 10);
}

function parseGasReport(): GasReport {
  const reportPath = path.resolve(__dirname, "../gas-report.txt");
  if (!fs.existsSync(reportPath)) {
    throw new Error("gas-report.txt not found. Run `npm run gas:check` to generate it.");
  }

  const report = fs.readFileSync(reportPath, "utf-8");
  const methods = new Map<string, Map<string, MethodGasMeasurement>>();
  const deployments = new Map<string, number>();

  // Parse the gas report - format uses · (middle dot) as separators
  // Example: |  AgreementEngine   ·  submitInput      ·      84395  ·     169673  ·     109013  ·           77  ·          -  |
  const methodRegex =
    /\|\s+(\w+)\s+·\s+(\w+)\s+·\s+([\d-]+)\s+·\s+([\d-]+)\s+·\s+(\d+)/g;
  let match;

  while ((match = methodRegex.exec(report)) !== null) {
    const contract = match[1];
    const method = match[2];
    const measurement = {
      min: parseReportedNumber(match[3]),
      max: parseReportedNumber(match[4]),
      avg: Number.parseInt(match[5], 10),
    };

    if (!methods.has(contract)) {
      methods.set(contract, new Map());
    }
    methods.get(contract)!.set(method, measurement);
  }

  // Deployment rows contain min, max, and average gas rather than a method
  // name. Use the average because it is the only value always present.
  const deployRegex = /\|\s+(\w+)\s+·\s+[\d-]+\s+·\s+[\d-]+\s+·\s+(\d+)/g;
  while ((match = deployRegex.exec(report)) !== null) {
    const contract = match[1];
    deployments.set(contract, Number.parseInt(match[2], 10));
  }

  return { methods, deployments };
}

function writeEvidence(gasReport: GasReport, failures: string[]) {
  const methods = Object.fromEntries(
    [...gasReport.methods.entries()].map(([contract, contractMethods]) => [
      contract,
      Object.fromEntries(contractMethods.entries()),
    ])
  );
  const reportPath = path.resolve(
    process.env.GAS_EVIDENCE_PATH?.trim() ||
      path.resolve(__dirname, "../measurements/p0-gas-gate.json")
  );
  const evidence = {
    schemaVersion: "shodai.agreements.gas-gate/0.1",
    budgets: {
      methods: METHOD_GAS_BUDGETS,
      deployments: DEPLOYMENT_GAS_BUDGETS,
    },
    measurements: {
      methods,
      deployments: Object.fromEntries(gasReport.deployments.entries()),
    },
    result: failures.length === 0 ? "pass" : "fail",
    failures,
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nGas evidence written to ${reportPath}`);
}

function checkThresholds() {
  const gasReport = parseGasReport();
  const failures: string[] = [];

  for (const [contract, budgets] of Object.entries(METHOD_GAS_BUDGETS)) {
    const contractData = gasReport.methods.get(contract);
    if (!contractData) {
      failures.push(`❌ Missing gas data for ${contract}`);
      continue;
    }

    for (const [method, budget] of Object.entries(budgets)) {
      const measurement = contractData.get(method);
      if (!measurement) {
        failures.push(`❌ Missing gas data for ${contract}.${method}`);
        continue;
      }

      const actualGas = measurement.max ?? measurement.avg;
      const metric = measurement.max === null ? "single-sample average" : "max";
      if (actualGas > budget) {
        failures.push(
          `❌ ${contract}.${method}: ${metric} ${actualGas} gas exceeds budget ${budget} (${((actualGas / budget - 1) * 100).toFixed(1)}% over)`
        );
      } else {
        console.log(`✅ ${contract}.${method}: ${metric} ${actualGas} gas (budget: ${budget})`);
      }
    }
  }

  for (const [contract, budget] of Object.entries(DEPLOYMENT_GAS_BUDGETS)) {
    const actualGas = gasReport.deployments.get(contract);
    if (actualGas === undefined) {
      failures.push(`❌ Missing deployment gas data for ${contract}`);
    } else if (actualGas > budget) {
      failures.push(`❌ ${contract} deployment: ${actualGas} gas exceeds budget ${budget}`);
    } else {
      console.log(`✅ ${contract} deployment: ${actualGas} gas (budget: ${budget})`);
    }
  }

  writeEvidence(gasReport, failures);

  if (failures.length > 0) {
    console.error("\n🚨 Gas threshold violations:");
    failures.forEach((f) => console.error(f));
    process.exit(1);
  }

  console.log("\n✅ All gas costs within thresholds");
}

checkThresholds();
