// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  defineChain,
  getAddress,
  hashTypedData,
  http,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
  type Hex,
} from "viem";
import { AgreementEngineABI } from "../src/generated/AgreementEngineAbi";
import { AgreementFactoryABI } from "../src/generated/AgreementFactoryAbi";
import {
  compileAgreementPackage,
  type AgreementPackage,
} from "../src/package-compiler";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(
  sdkRoot,
  "tests/fixtures/canonical-package-v0-reference-package.json"
);
const evidencePath = path.join(
  sdkRoot,
  "evidence/p0-linea-sepolia-package-deployment.json"
);
const rpcUrl = process.env.LINEA_SEPOLIA_RPC_URL || "https://rpc.sepolia.linea.build";

function sha256(value: string): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function equalHex(actual: string, expected: string, label: string) {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
  console.log(`✓ ${label}: ${actual}`);
}

function equalAddress(actual: string, expected: string, label: string) {
  if (getAddress(actual) !== getAddress(expected)) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
  console.log(`✓ ${label}: ${getAddress(actual)}`);
}

async function main() {
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as any;
  const rawPackage = fs.readFileSync(fixturePath, "utf8");
  const compiled = compileAgreementPackage(JSON.parse(rawPackage) as AgreementPackage);
  const chain = defineChain({
    id: Number(evidence.network.chainId),
    name: "Linea Sepolia",
    nativeCurrency: { name: "Linea Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    testnet: true,
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  equalHex(
    sha256(rawPackage),
    evidence.source.referencePackageSha256,
    "reference package SHA-256"
  );
  equalHex(
    compiled.manifest.packageDigest,
    evidence.package.packageDigest,
    "independently compiled package digest"
  );
  equalHex(
    sha256(compiled.manifest.canonicalPackage),
    evidence.package.canonicalPackageSha256,
    "canonical package SHA-256"
  );

  const [network, implementationCode, factoryCode, agreementCode, transaction, txReceipt] =
    await Promise.all([
      publicClient.getChainId(),
      publicClient.getCode({ address: evidence.protocolDeployment.implementation }),
      publicClient.getCode({ address: evidence.protocolDeployment.factory }),
      publicClient.getCode({ address: evidence.deployment.agreement }),
      publicClient.getTransaction({ hash: evidence.deployment.transactionHash }),
      publicClient.getTransactionReceipt({ hash: evidence.deployment.transactionHash }),
    ]);
  if (network !== Number(evidence.network.chainId)) {
    throw new Error(`chain id mismatch: ${network}`);
  }
  console.log(`✓ chain id: ${network}`);
  if (!implementationCode || !factoryCode || !agreementCode) {
    throw new Error("RPC returned missing runtime code");
  }
  equalHex(
    keccak256(implementationCode),
    evidence.protocolDeployment.runtime.implementationCodeHash,
    "implementation runtime hash"
  );
  equalHex(
    keccak256(factoryCode),
    evidence.protocolDeployment.runtime.factoryCodeHash,
    "factory runtime hash"
  );
  equalHex(
    keccak256(agreementCode),
    evidence.deployment.runtimeCodeHash,
    "agreement runtime hash"
  );
  if (toBytes(agreementCode).length !== evidence.deployment.runtimeCodeBytes) {
    throw new Error("agreement runtime byte length mismatch");
  }

  const readContract = publicClient.readContract.bind(publicClient) as any;
  const [implementation, predictedAddress, docUri, docHash, initialState, currentState, owner] =
    await Promise.all([
      readContract({
        address: evidence.protocolDeployment.factory,
        abi: AgreementFactoryABI,
        functionName: "implementation",
      }),
      readContract({
        address: evidence.protocolDeployment.factory,
        abi: AgreementFactoryABI,
        functionName: "predictAddress",
        args: [evidence.authorization.salt],
      }),
      readContract({
        address: evidence.deployment.agreement,
        abi: AgreementEngineABI,
        functionName: "docUri",
      }),
      readContract({
        address: evidence.deployment.agreement,
        abi: AgreementEngineABI,
        functionName: "docHash",
      }),
      readContract({
        address: evidence.deployment.agreement,
        abi: AgreementEngineABI,
        functionName: "initialState",
      }),
      readContract({
        address: evidence.deployment.agreement,
        abi: AgreementEngineABI,
        functionName: "currentState",
      }),
      readContract({
        address: evidence.deployment.agreement,
        abi: AgreementEngineABI,
        functionName: "owner",
      }),
    ]);
  equalAddress(implementation as string, evidence.protocolDeployment.implementation, "factory implementation");
  equalAddress(predictedAddress as string, evidence.deployment.agreement, "CREATE2 prediction");
  equalHex(docHash as string, compiled.manifest.packageDigest, "on-chain package digest");
  equalHex(initialState as string, compiled.params.initialState, "on-chain initial state");
  equalHex(currentState as string, initialState as string, "current state is initial state");
  equalAddress(owner as string, evidence.authorization.signer, "agreement owner");
  if (docUri !== compiled.manifest.docUri) throw new Error("on-chain docUri mismatch");

  const typedData = {
    ...evidence.authorization.typedData,
    message: {
      ...evidence.authorization.typedData.message,
      nonce: BigInt(evidence.authorization.typedData.message.nonce),
      deadline: BigInt(evidence.authorization.typedData.message.deadline),
    },
  };
  equalHex(hashTypedData(typedData), evidence.authorization.typedDataHash, "typed-data hash");
  const recoveredSigner = await recoverTypedDataAddress({
    ...typedData,
    signature: evidence.authorization.signature as Hex,
  });
  equalAddress(recoveredSigner, evidence.authorization.signer, "recovered permit signer");

  equalHex(
    keccak256(transaction.input),
    evidence.deployment.transactionInputHash,
    "deployment transaction input hash"
  );
  equalAddress(transaction.from, evidence.authorization.submitter, "transaction submitter");
  equalAddress(transaction.to!, evidence.protocolDeployment.factory, "transaction target factory");
  if (txReceipt.status !== "success") throw new Error("deployment transaction did not succeed");
  if (txReceipt.blockNumber.toString() !== evidence.deployment.blockNumber) {
    throw new Error("deployment block number mismatch");
  }
  console.log("\nP0 Linea package proof matches independent compilation and RPC state.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
