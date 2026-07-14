// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "hardhat";

interface ArtifactMeasurement {
  creationBytes: number;
  creationHash: string;
  runtimeBytes: number;
  runtimeHash: string;
  eip170BytesRemaining: number;
}

const EIP170_RUNTIME_LIMIT = 24_576;
const CONTRACTS = ["AgreementEngine", "AgreementFactory"] as const;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function artifactPath(root: string, contractName: (typeof CONTRACTS)[number]): string {
  return path.join(root, "src", `${contractName}.sol`, `${contractName}.json`);
}

function measureArtifact(root: string, contractName: (typeof CONTRACTS)[number]): ArtifactMeasurement {
  const target = artifactPath(root, contractName);
  if (!fs.existsSync(target)) {
    throw new Error(`Missing compiled artifact: ${target}`);
  }
  const artifact = JSON.parse(fs.readFileSync(target, "utf8")) as {
    bytecode: string;
    deployedBytecode: string;
  };
  const creationBytes = ethers.getBytes(artifact.bytecode).length;
  const runtimeBytes = ethers.getBytes(artifact.deployedBytecode).length;
  return {
    creationBytes,
    creationHash: ethers.keccak256(artifact.bytecode),
    runtimeBytes,
    runtimeHash: ethers.keccak256(artifact.deployedBytecode),
    eip170BytesRemaining: EIP170_RUNTIME_LIMIT - runtimeBytes,
  };
}

function currentCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8",
  }).trim();
}

function solidityMatchesCommit(commit: string): boolean {
  try {
    execFileSync("git", ["diff", "--quiet", commit, "--", "contracts/src"], {
      cwd: path.resolve(__dirname, "../.."),
    });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const baseArtifacts = path.resolve(requiredEnvironment("BASE_ARTIFACTS_DIR"));
  const candidateArtifacts = path.resolve(__dirname, "../artifacts");
  const baseCommit = requiredEnvironment("BASE_COMMIT");
  const candidateCommit = process.env.CANDIDATE_COMMIT?.trim() || currentCommit();
  const reportPath = path.resolve(
    process.env.BYTECODE_REPORT_PATH?.trim() || path.resolve(__dirname, "../measurements/p0-bytecode-delta.json")
  );

  const contracts = Object.fromEntries(
    CONTRACTS.map((contractName) => {
      const baseline = measureArtifact(baseArtifacts, contractName);
      const candidate = measureArtifact(candidateArtifacts, contractName);
      return [
        contractName,
        {
          baseline,
          candidate,
          delta: {
            creationBytes: candidate.creationBytes - baseline.creationBytes,
            runtimeBytes: candidate.runtimeBytes - baseline.runtimeBytes,
          },
        },
      ];
    })
  );

  const report = {
    schemaVersion: "shodai.agreements.bytecode-delta/0.1",
    compiler: {
      solcVersion: "0.8.24",
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "cancun",
    },
    baseline: {
      repository: "https://github.com/CNSLabs/agreements-protocol-evm",
      commit: baseCommit,
    },
    candidate: {
      repository: "https://github.com/CNSLabs/agreements-protocol-evm",
      commit: candidateCommit,
      solidityMatchesCommit: solidityMatchesCommit(candidateCommit),
    },
    contracts,
  };

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Bytecode delta written to ${reportPath}`);
  for (const [contractName, values] of Object.entries(contracts)) {
    console.log(
      `${contractName}: runtime ${values.baseline.runtimeBytes} -> ${values.candidate.runtimeBytes} bytes ` +
        `(${values.delta.runtimeBytes >= 0 ? "+" : ""}${values.delta.runtimeBytes})`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
