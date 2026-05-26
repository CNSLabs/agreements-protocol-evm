// SPDX-License-Identifier: Apache-2.0

import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-verify";
import * as dotenv from "dotenv";

dotenv.config();

const lineaSepoliaRpcUrl =
  process.env.LINEA_SEPOLIA_RPC_URL || "https://rpc.sepolia.linea.build";
const sepoliaRpcUrl =
  process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const etherscanApiKey = process.env.ETHERSCAN_API_KEY || "";
const etherscanApiUrl = "https://api.etherscan.io/v2/api";
const enableFork = process.env.HARDHAT_FORK === "true";
const hardhatPort = process.env.HARDHAT_PORT || "8545";
const hardhatForkBlockNumber = process.env.HARDHAT_FORK_BLOCK_NUMBER
  ? Number(process.env.HARDHAT_FORK_BLOCK_NUMBER)
  : undefined;
const enableGasReporter = process.env.REPORT_GAS === "true";

if (
  hardhatForkBlockNumber !== undefined &&
  (!Number.isSafeInteger(hardhatForkBlockNumber) || hardhatForkBlockNumber <= 0)
) {
  throw new Error("HARDHAT_FORK_BLOCK_NUMBER must be a positive integer");
}

const hardhatNetwork = enableFork
  ? {
      chainId: 59141,
      forking: {
        url: lineaSepoliaRpcUrl,
        enabled: true,
        ...(hardhatForkBlockNumber !== undefined
          ? { blockNumber: hardhatForkBlockNumber }
          : {}),
      },
    }
  : {
      chainId: 59141,
    };

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: "cancun",
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: hardhatNetwork,
    localhost: {
      url: `http://127.0.0.1:${hardhatPort}`,
      chainId: 59141, // Match Linea Sepolia chain ID
    },
    lineaSepolia: {
      url: lineaSepoliaRpcUrl,
      chainId: 59141,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    sepolia: {
      url: sepoliaRpcUrl,
      chainId: 11155111,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    linea: {
      url: process.env.LINEA_RPC_URL || "https://rpc.linea.build",
      chainId: 59144,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  typechain: {
    outDir: "./typechain-types",
    target: "ethers-v6",
  },
  gasReporter: {
    enabled: enableGasReporter,
    currency: "USD",
    outputFile: "gas-report.txt",
    noColors: true,
  },
  etherscan: {
    apiKey: etherscanApiKey,
    customChains: [
      {
        network: "lineaSepolia",
        chainId: 59141,
        urls: {
          apiURL: etherscanApiUrl,
          browserURL: "https://sepolia.lineascan.build",
        },
      },
      {
        network: "sepolia",
        chainId: 11155111,
        urls: {
          apiURL: etherscanApiUrl,
          browserURL: "https://sepolia.etherscan.io",
        },
      },
      {
        network: "linea",
        chainId: 59144,
        urls: {
          apiURL: etherscanApiUrl,
          browserURL: "https://lineascan.build",
        },
      },
    ],
  },
};

export default config;
