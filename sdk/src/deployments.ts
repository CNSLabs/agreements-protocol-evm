// SPDX-License-Identifier: Apache-2.0

import { FactoryConfig } from "./types.js";
import { Hex } from "viem";
import { DeploymentsRegistry } from "./generated/DeploymentsRegistry.js";

// Use inlined deployments data (works in both Node.js and browser)
const deploymentsRegistry = DeploymentsRegistry;

export interface DeploymentInfo {
  implementation: string;
  factory: string;
  chainId: string;
  network: string;
  deployedAt: string;
  deployer: string;
  /** Contract version of this deployment, where recorded ("1.1"). Absent on V1.0 records. */
  version?: string;
  /** The V1.0 deployment this one replaced, kept so old agreements stay findable. */
  legacy?: {
    version: string;
    implementation: string;
    factory: string;
    deployedAt: string;
    deployer: string;
    deprecated: boolean;
  };
}

export interface DeploymentsRegistry {
  deployments: Record<string, DeploymentInfo>;
}

/**
 * The contract version this SDK is the client for. Its permit calls, address
 * prediction and ABIs do not work against another version, and an engine from
 * before V1.1 does not enforce a time window.
 */
const SUPPORTED_CONTRACT_VERSION = "1.1";

/**
 * Load the deployments registry
 */
function loadDeploymentsRegistry(): DeploymentsRegistry {
  return deploymentsRegistry as DeploymentsRegistry;
}

/**
 * The deployments the lookups below serve: those recorded with the contract
 * version this SDK supports. A network whose recorded deployment is another
 * version (a V1.0 record has no version) is not served, so a caller gets no
 * factory there instead of one this SDK cannot use safely.
 */
function supportedDeployments(): DeploymentInfo[] {
  return Object.values(loadDeploymentsRegistry().deployments).filter(
    (deployment) => deployment.version === SUPPORTED_CONTRACT_VERSION
  );
}

/**
 * Get deployment info by chain ID. Returns null when the network has no
 * deployment of the contract version this SDK supports.
 */
export function getDeploymentByChainId(chainId: number | bigint): DeploymentInfo | null {
  const chainIdStr = chainId.toString();
  
  // Find deployment by chainId
  for (const deployment of supportedDeployments()) {
    if (deployment.chainId === chainIdStr) {
      return deployment;
    }
  }
  
  return null;
}

/**
 * Get deployment info by network name. Returns null when the network has no
 * deployment of the contract version this SDK supports.
 */
export function getDeploymentByNetwork(network: string): DeploymentInfo | null {
  // Find deployment by network name (case-insensitive)
  const networkLower = network.toLowerCase();
  for (const deployment of supportedDeployments()) {
    if (deployment.network.toLowerCase() === networkLower) {
      return deployment;
    }
  }
  
  return null;
}

/**
 * Get FactoryConfig by chain ID
 */
export function getFactoryConfigByChainId(chainId: number | bigint): FactoryConfig | null {
  const deployment = getDeploymentByChainId(chainId);
  if (!deployment) {
    return null;
  }
  
  return {
    factoryAddress: deployment.factory as Hex,
    chainId: Number(deployment.chainId),
  };
}

/**
 * Get FactoryConfig by network name
 */
export function getFactoryConfigByNetwork(network: string): FactoryConfig | null {
  const deployment = getDeploymentByNetwork(network);
  if (!deployment) {
    return null;
  }
  
  return {
    factoryAddress: deployment.factory as Hex,
    chainId: Number(deployment.chainId),
  };
}

/**
 * List the registered deployments of the contract version this SDK supports
 */
export function listDeployments(): DeploymentInfo[] {
  return supportedDeployments();
}

/**
 * Get all available FactoryConfigs
 */
export function getAllFactoryConfigs(): FactoryConfig[] {
  const deployments = listDeployments();
  return deployments.map((deployment) => ({
    factoryAddress: deployment.factory as Hex,
    chainId: Number(deployment.chainId),
  }));
}
