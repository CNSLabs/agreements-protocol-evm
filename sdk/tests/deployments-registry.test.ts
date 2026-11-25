// SPDX-License-Identifier: Apache-2.0
//
// The bundled registry only serves deployments of the contract version this SDK
// is the client for. A network whose recorded deployment is V1.0 must not come
// back from any lookup: this SDK's permits, address prediction and ABIs do not
// work against it, and a V1.0 engine does not enforce a time window.

import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  getDeploymentByChainId,
  getDeploymentByNetwork,
  getFactoryConfigByChainId,
  getFactoryConfigByNetwork,
  listDeployments,
  getAllFactoryConfigs,
} from "../src/deployments";

type DeploymentRecord = { implementation: string; factory: string; chainId: string; network: string; version?: string };

// The records the registry is generated from, read independently of it.
const DEPLOYMENTS_DIR = path.resolve(__dirname, "../../contracts/deployments");
const records: DeploymentRecord[] = fs
  .readdirSync(DEPLOYMENTS_DIR)
  .map((network) => path.join(DEPLOYMENTS_DIR, network, "AgreementsProtocol.json"))
  .filter((file) => fs.existsSync(file))
  .map((file) => JSON.parse(fs.readFileSync(file, "utf-8")));
const supported = records.filter((record) => record.version === "1.1");
const unsupported = records.filter((record) => record.version !== "1.1");

describe("the bundled deployments registry", () => {
  it("has records to check, and the three test networks are V1.1", () => {
    expect(records.length).toBeGreaterThanOrEqual(5);
    expect(supported.map((record) => record.chainId).sort()).toEqual(expect.arrayContaining(["11155111", "59141", "84532"]));
  });

  it.each(supported.map((record) => [record.network, record] as const))(
    "%s: every lookup returns the recorded V1.1 pair",
    (_network, record) => {
      const chainId = Number(record.chainId);
      expect(getDeploymentByChainId(chainId)).toMatchObject({ factory: record.factory, implementation: record.implementation, version: "1.1" });
      expect(getDeploymentByChainId(BigInt(chainId))?.factory).toBe(record.factory);
      expect(getDeploymentByNetwork(record.network)?.factory).toBe(record.factory);
      expect(getDeploymentByNetwork(record.network.toUpperCase())?.factory).toBe(record.factory);
      expect(getFactoryConfigByChainId(chainId)).toEqual({ factoryAddress: record.factory, chainId });
      expect(getFactoryConfigByNetwork(record.network)).toEqual({ factoryAddress: record.factory, chainId });
    }
  );

  it.each(unsupported.map((record) => [record.network, record] as const))(
    "%s: a network whose recorded deployment is not V1.1 comes back from no lookup",
    (_network, record) => {
      const chainId = Number(record.chainId);
      expect(getDeploymentByChainId(chainId)).toBeNull();
      expect(getDeploymentByNetwork(record.network)).toBeNull();
      expect(getFactoryConfigByChainId(chainId)).toBeNull();
      expect(getFactoryConfigByNetwork(record.network)).toBeNull();
      expect(listDeployments().some((deployment) => deployment.chainId === record.chainId)).toBe(false);
      expect(getAllFactoryConfigs().some((config) => config.factoryAddress === record.factory)).toBe(false);
    }
  );

  it("the lists hold exactly the V1.1 deployments, and no V1.0 factory address", () => {
    expect(listDeployments().map((deployment) => deployment.chainId).sort()).toEqual(supported.map((record) => record.chainId).sort());
    expect(listDeployments().every((deployment) => deployment.version === "1.1")).toBe(true);
    const served = getAllFactoryConfigs().map((config) => config.factoryAddress.toLowerCase());
    expect(served.sort()).toEqual(supported.map((record) => record.factory.toLowerCase()).sort());
    // The V1.0 pair a V1.1 record replaced stays in the record under `legacy` and is never served as the factory.
    for (const deployment of listDeployments()) {
      if (deployment.legacy) expect(served).not.toContain(deployment.legacy.factory.toLowerCase());
    }
  });

  it("a chain the registry has never heard of returns null", () => {
    expect(getDeploymentByChainId(1)).toBeNull();
    expect(getFactoryConfigByNetwork("mainnet")).toBeNull();
  });
});
