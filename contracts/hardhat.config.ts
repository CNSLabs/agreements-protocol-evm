import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-verify";
import * as dotenv from "dotenv";

dotenv.config();

const lineaSepoliaRpcUrl =
  process.env.LINEA_SEPOLIA_RPC_URL || "https://rpc.sepolia.linea.build";
const enableFork = process.env.HARDHAT_FORK === "true";

const hardhatNetwork = enableFork
  ? {
      chainId: 59141,
      forking: {
        url: lineaSepoliaRpcUrl,
        enabled: true,
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
      url: "http://127.0.0.1:8545",
      chainId: 59141, // Match Linea Sepolia chain ID
    },
    lineaSepolia: {
      url: lineaSepoliaRpcUrl,
      chainId: 59141,
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
    enabled: true,
    currency: "USD",
    outputFile: "gas-report.txt",
    noColors: true,
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
    customChains: [
      {
        network: "lineaSepolia",
        chainId: 59141,
        urls: {
          apiURL: "https://api.lineascan.build/api",
          browserURL: "https://sepolia.lineascan.build",
        },
      },
      {
        network: "linea",
        chainId: 59144,
        urls: {
          apiURL: "https://api.lineascan.build/api",
          browserURL: "https://lineascan.build",
        },
      },
    ],
  },
};

export default config;
