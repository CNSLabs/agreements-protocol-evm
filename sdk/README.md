# Agreements Protocol - TypeScript SDK

This directory contains the TypeScript SDK for transforming agreement JSON into on-chain parameters and interacting with deployed agreement contracts.

This package is licensed under `Apache-2.0`. It is intended to remain redistributable independently of the BUSL-licensed core contract implementations.

## Setup

```bash
npm ci
```

The SDK build inlines ABIs and deployment metadata from `../contracts`, so compile the contracts first in a fresh clone:

```bash
npm --prefix ../contracts run compile
```

## Development

### Build

```bash
npm run build
```

### Run Tests

```bash
npm run test
```

### Watch Mode

```bash
npm run test:watch
```

## Usage

Once built, you can import and use the SDK.

### Creating Agreements

```typescript
import { AgreementFactory } from "@cns-labs/agreements-protocol-evm";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const publicClient = createPublicClient({
  transport: http("http://127.0.0.1:8545"),
});

const walletClient = createWalletClient({
  account: privateKeyToAccount("0x..."),
  transport: http("http://127.0.0.1:8545"),
});

const factory = new AgreementFactory(
  { factoryAddress: "0x..." },
  { publicClient, walletClient },
);

const { address } = await factory.createAgreement(agreementJson, {
  initValues: {
    grantorEthAddress: "0x123...",
    recipientEthAddress: "0x456...",
  },
});
```

### Interacting With Agreements

```typescript
import { AgreementEngine } from "@cns-labs/agreements-protocol-evm";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const publicClient = createPublicClient({
  transport: http("http://127.0.0.1:8545"),
});

const walletClient = createWalletClient({
  account: privateKeyToAccount("0x..."),
  transport: http("http://127.0.0.1:8545"),
});

const agreement = new AgreementEngine("0x...", publicClient, walletClient);

await agreement.submitInput(agreementJson, "grantorData", {
  grantorName: "Alice",
  scope: "Development of Web3 tooling",
});

const readOnlyAgreement = new AgreementEngine("0x...", publicClient);
const state = await readOnlyAgreement.getCurrentState();
const data = await readOnlyAgreement.getData();
```

## License

The SDK package is licensed under `Apache-2.0`. See [`LICENSE`](LICENSE), [`NOTICE`](NOTICE), [../licenses/Apache-2.0.txt](../licenses/Apache-2.0.txt), and [../LICENSING.md](../LICENSING.md).
