// SPDX-License-Identifier: Apache-2.0

/**
 * Shared test helpers for agreement integration tests
 */

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { AgreementEngine, AgreementFactory } from "../../typechain-types";
import type { AgreementJson } from "../../../sdk/src/types";
import { createPublicClient, createWalletClient, custom } from "viem";
import { lineaSepolia } from "viem/chains";

// ============================================================================
// SDK Loading
// ============================================================================

let _sdkModule: any = null;

/**
 * Load the full SDK module (ES modules)
 * Caches the result for subsequent calls
 */
export async function loadSDKModule(): Promise<any> {
  if (_sdkModule) {
    return _sdkModule;
  }

  const sdkRoot = path.resolve(__dirname, "../../../sdk");
  // Use the CommonJS build of the SDK for Hardhat tests
  const sdkIndex = path.resolve(sdkRoot, "dist/cjs/index.js");

  if (!fs.existsSync(sdkIndex)) {
    throw new Error(
      "SDK build artifacts not found. Run `npm run build` in the sdk directory before running contract tests."
    );
  }

  const dynamicImport = new Function(
    "p",
    "return import(p);"
  ) as (p: string) => Promise<any>;

  _sdkModule = await dynamicImport(pathToFileURL(sdkIndex).href);
  return _sdkModule;
}

// ============================================================================
// viem Clients for Hardhat Signers
// ============================================================================

/**
 * Create viem public & wallet clients backed by the Hardhat provider
 * and bound to a specific signer address.
 *
 * This lets the SDK (which is viem-based) run against the Hardhat in-process
 * network and use unlocked Hardhat accounts for signing.
 */
export async function createViemClientsForSigner(signer: any): Promise<{
  publicClient: any;
  walletClient: any;
}> {
  // Use Hardhat's EIP-1193 provider for viem's `custom` transport
  const provider = (network as any).provider;
  const address = await signer.getAddress();

  const transport = custom(provider as any);

  const publicClient = createPublicClient({
    chain: lineaSepolia,
    transport,
  });

  const walletClient = createWalletClient({
    chain: lineaSepolia,
    transport,
    // For Hardhat tests, the node holds the private keys; we just need the address.
    account: address as `0x${string}`,
  });

  return { publicClient, walletClient };
}


// ============================================================================
// Agreement Loading
// ============================================================================

/**
 * Load an agreement JSON by name
 * @param name - Agreement folder name (e.g., "grant-simple", "grant-with-feedback")
 */
export function loadAgreement(name: string): AgreementJson {
  const agreementPath = path.resolve(
    __dirname,
    `../../../agreements/${name}/unwrapped/${name}.json`
  );
  return JSON.parse(fs.readFileSync(agreementPath, "utf-8"));
}

/**
 * Input file structure in agreements/{name}/unwrapped/input-{id}.json
 */
interface InputFile {
  inputId: string;
  type: string;
  values: Record<string, unknown>;
}

/**
 * Load all sample inputs from an agreement's unwrapped directory
 * Returns a map of inputId -> values
 */
export function loadSampleInputs(agreementName: string): Record<string, Record<string, unknown>> {
  const unwrappedDir = path.resolve(
    __dirname,
    `../../../agreements/${agreementName}/unwrapped`
  );
  
  const inputs: Record<string, Record<string, unknown>> = {};
  
  const files = fs.readdirSync(unwrappedDir);
  for (const file of files) {
    if (file.startsWith("input-") && file.endsWith(".json")) {
      const filePath = path.resolve(unwrappedDir, file);
      const inputFile: InputFile = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      inputs[inputFile.inputId] = inputFile.values;
    }
  }
  
  return inputs;
}

// ============================================================================
// Protocol Deployment (Factory + Implementation)
// ============================================================================

let _factory: AgreementFactory | null = null;
let _implementation: AgreementEngine | null = null;

/**
 * Deploy the protocol (implementation + factory)
 * Caches the result for subsequent calls within the same test run.
 * 
 * NOTE ON TEST ISOLATION:
 * This caches a single implementation + factory across all tests for performance.
 * Each agreement is a separate clone, so most tests are isolated. However:
 * - If tests rely on factory event counts, they may see events from prior tests
 * - If future features add factory-level state, consider using Hardhat fixtures:
 *   
 *   import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
 *   const deployFixture = async () => { ... deploy impl + factory ... };
 *   const { factory, implementation } = await loadFixture(deployFixture);
 * 
 * For now, clone-per-agreement isolation is sufficient for FSM testing.
 */
export async function deployProtocol(): Promise<{
  factory: AgreementFactory;
  implementation: AgreementEngine;
}> {
  if (_factory && _implementation) {
    return { factory: _factory, implementation: _implementation };
  }

  // Deploy implementation (initializers disabled in constructor)
  _implementation = (await ethers.deployContract(
    "AgreementEngine"
  )) as unknown as AgreementEngine;
  await _implementation.waitForDeployment();

  // Deploy factory pointing to implementation
  _factory = (await ethers.deployContract("AgreementFactory", [
    await _implementation.getAddress(),
  ])) as unknown as AgreementFactory;
  await _factory.waitForDeployment();

  return { factory: _factory, implementation: _implementation };
}
