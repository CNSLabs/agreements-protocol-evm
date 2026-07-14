// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  toBytes,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AgreementEngine } from "../src/AgreementEngine";
import { AgreementFactory } from "../src/AgreementFactory";
import {
  compileAgreementPackage,
  type AgreementPackage,
} from "../src/package-compiler";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(sdkRoot, "..");
const fixturePath = path.join(
  sdkRoot,
  "tests/fixtures/canonical-package-v0-reference-package.json"
);
const deploymentPath = path.join(
  repositoryRoot,
  "contracts/deployments/lineaSepolia/AgreementsProtocol.json"
);
const evidencePath = path.join(
  sdkRoot,
  "evidence/p0-linea-sepolia-package-deployment.json"
);
const explorerBaseUrl = "https://sepolia.lineascan.build";
const rpcUrl = process.env.LINEA_SEPOLIA_RPC_URL || "https://rpc.sepolia.linea.build";
const privateKey = (process.env.PRIVATE_KEY || process.env.CNS_PRIVATE_KEY) as Hex | undefined;

function sha256(value: string): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function sourceCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry),
    2
  );
}

async function main() {
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("PRIVATE_KEY or CNS_PRIVATE_KEY must be a 32-byte hex testnet key");
  }

  const rawPackage = fs.readFileSync(fixturePath, "utf8");
  const agreementPackage = JSON.parse(rawPackage) as AgreementPackage;
  const compiled = compileAgreementPackage(agreementPackage);
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8")) as {
    schemaVersion: string;
    implementation: Hex;
    factory: Hex;
    chainId: string;
    source: { repository: string; commit: string };
    transactions: Record<string, { hash: Hex; blockNumber: string; inputHash: Hex }>;
    runtime: Record<string, string | number>;
  };
  if (deployment.chainId !== agreementPackage.target.chainId) {
    throw new Error("Package target chain does not match the deployment manifest");
  }

  const chain = defineChain({
    id: Number(deployment.chainId),
    name: "Linea Sepolia",
    nativeCurrency: { name: "Linea Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: "LineaScan", url: explorerBaseUrl } },
    testnet: true,
  });
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const factory = new AgreementFactory(
    { factoryAddress: deployment.factory, chainId: chain.id },
    { publicClient: publicClient as any, walletClient: walletClient as any }
  );
  const salt = keccak256(
    stringToHex("shodai-p0-canonical-package-linea-sepolia-v1")
  );
  const predictedAddress = await factory.predictAddress(salt);
  const existingCode = await publicClient.getCode({ address: predictedAddress });
  if (existingCode && existingCode !== "0x") {
    throw new Error(`Deterministic proof address already contains code: ${predictedAddress}`);
  }

  const deadline = Math.floor(Date.now() / 1000) + 3_600;
  const authorization =
    await factory.createCompiledPackageDeterministicPermitSignature(
      walletClient as any,
      compiled,
      salt,
      deadline
    );
  const typedDataHash = hashTypedData(authorization.typedData);
  const recoveredSigner = await recoverTypedDataAddress({
    ...authorization.typedData,
    signature: authorization.signature,
  });
  if (getAddress(recoveredSigner) !== getAddress(authorization.signerAddress)) {
    throw new Error("Local typed-data recovery did not match the permit signer");
  }

  const result = await factory.createCompiledAgreementPackageDeterministicWithPermit(
    authorization.signerAddress,
    salt,
    compiled,
    deadline,
    authorization.signature
  );
  if (getAddress(result.address) !== getAddress(predictedAddress)) {
    throw new Error("Deployed agreement did not match the predicted CREATE2 address");
  }

  const [transaction, agreementCode, onChain, nonceAfter] = await Promise.all([
    publicClient.getTransaction({ hash: result.receipt.transactionHash }),
    publicClient.getCode({ address: result.address }),
    new AgreementEngine(result.address, publicClient as any).getData(),
    factory.getNonce(authorization.signerAddress),
  ]);
  if (!agreementCode || agreementCode === "0x") {
    throw new Error("Agreement runtime code is missing after deployment");
  }

  const checks = {
    compilerIssueCountIsZero: compiled.report.issues.length === 0,
    docHashEqualsPackageDigest:
      compiled.params.docHash.toLowerCase() === compiled.manifest.packageDigest.toLowerCase(),
    typedDataDocHashEqualsPackageDigest:
      authorization.typedData.message.docHash.toLowerCase() ===
      compiled.manifest.packageDigest.toLowerCase(),
    recoveredSignerMatches:
      getAddress(recoveredSigner) === getAddress(authorization.signerAddress),
    predictedAddressEqualsActual: getAddress(predictedAddress) === getAddress(result.address),
    onChainDocHashMatches:
      onChain.docHash.toLowerCase() === compiled.manifest.packageDigest.toLowerCase(),
    onChainOwnerMatches: getAddress(onChain.owner) === getAddress(authorization.signerAddress),
    onChainInitialStateMatches:
      onChain.initialState.toLowerCase() === compiled.params.initialState.toLowerCase(),
    onChainCurrentStateMatchesInitial:
      onChain.currentState.toLowerCase() === onChain.initialState.toLowerCase(),
    permitNonceIncremented:
      nonceAfter === authorization.typedData.message.nonce + 1n,
    transactionSucceeded: result.receipt.status === "success",
  };
  if (Object.values(checks).some((passed) => !passed)) {
    throw new Error(`Proof checks failed: ${stringify(checks)}`);
  }

  const evidence = {
    schemaVersion: "shodai.agreements.p0-linea-package-proof/0.1",
    source: {
      repository: "https://github.com/CNSLabs/agreements-protocol-evm",
      commit: sourceCommit(),
      referencePackage: "sdk/tests/fixtures/canonical-package-v0-reference-package.json",
      referencePackageSha256: sha256(rawPackage),
    },
    network: {
      name: "lineaSepolia",
      chainId: deployment.chainId,
      explorerBaseUrl,
    },
    protocolDeployment: deployment,
    package: {
      schemaVersion: compiled.manifest.schemaVersion,
      profile: compiled.manifest.profile,
      packageDigest: compiled.manifest.packageDigest,
      canonicalPackageBytes: Buffer.byteLength(compiled.manifest.canonicalPackage, "utf8"),
      canonicalPackageSha256: sha256(compiled.manifest.canonicalPackage),
      targetChainId: compiled.manifest.targetChainId,
      docUri: compiled.manifest.docUri,
      compiled: compiled.manifest.compiled,
    },
    authorization: {
      route: "createAgreementDeterministicWithPermit",
      standard: "EIP-712",
      signer: authorization.signerAddress,
      submitter: account.address,
      signature: authorization.signature,
      signatureBytes: toBytes(authorization.signature).length,
      signatureHash: keccak256(authorization.signature),
      typedDataHash,
      typedData: authorization.typedData,
      recoveredSigner,
      salt,
      predictedAddress,
      nonceAfter,
    },
    deployment: {
      agreement: result.address,
      transactionHash: result.receipt.transactionHash,
      transactionInputHash: keccak256(transaction.input),
      blockNumber: result.receipt.blockNumber,
      gasUsed: result.receipt.gasUsed,
      status: result.receipt.status,
      runtimeCodeHash: keccak256(agreementCode),
      runtimeCodeBytes: toBytes(agreementCode).length,
    },
    onChain,
    checks,
    explorer: {
      agreement: `${explorerBaseUrl}/address/${result.address}`,
      transaction: `${explorerBaseUrl}/tx/${result.receipt.transactionHash}`,
      factory: `${explorerBaseUrl}/address/${deployment.factory}`,
      implementation: `${explorerBaseUrl}/address/${deployment.implementation}`,
    },
  };

  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${stringify(evidence)}\n`);
  console.log(`P0 Linea proof written to ${evidencePath}`);
  console.log(`Package digest: ${compiled.manifest.packageDigest}`);
  console.log(`Agreement: ${result.address}`);
  console.log(`Transaction: ${result.receipt.transactionHash}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
