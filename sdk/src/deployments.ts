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
}

export interface DeploymentsRegistry {
  deployments: Record<string, DeploymentInfo>;
}

/**
 * Load the deployments registry
 */
function loadDeploymentsRegistry(): DeploymentsRegistry {
  return deploymentsRegistry as DeploymentsRegistry;
}

/**
 * Get deployment info by chain ID
 */
export function getDeploymentByChainId(chainId: number | bigint): DeploymentInfo | null {
  const registry = loadDeploymentsRegistry();
  const chainIdStr = chainId.toString();
  
  // Find deployment by chainId
  for (const deployment of Object.values(registry.deployments)) {
    if (deployment.chainId === chainIdStr) {
      return deployment;
    }
  }
  
  return null;
}

/**
 * Get deployment info by network name
 */
export function getDeploymentByNetwork(network: string): DeploymentInfo | null {
  const registry = loadDeploymentsRegistry();
  
  // Find deployment by network name (case-insensitive)
  const networkLower = network.toLowerCase();
  for (const deployment of Object.values(registry.deployments)) {
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
 * List all registered deployments
 */
export function listDeployments(): DeploymentInfo[] {
  const registry = loadDeploymentsRegistry();
  return Object.values(registry.deployments);
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

