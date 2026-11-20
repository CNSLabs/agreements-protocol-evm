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
import { AgreementFactory } from "@shodai-network/agreements-protocol-evm";
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
import { AgreementEngine } from "@shodai-network/agreements-protocol-evm";
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

### Time Windows

An input can be limited to a period of time. Add `time` to the input in the
agreement JSON:

```json
"deliver": {
  "type": "VerifiedCredentialEIP712",
  "data": { "deliveryNote": "${variables.deliveryNote}" },
  "issuer": "${variables.supplier.value}",
  "time": { "before": "${variables.dueDate}" }
}
```

- `notBefore`: the input is accepted at that moment and after it.
- `before`: the input is accepted only before that moment.

Each bound is a fixed moment or a stored date:

- A fixed moment is a whole number of seconds since 1970-01-01 UTC, or an
  ISO 8601 date-time with a zone, such as `"2027-03-01T00:00:00Z"`.
- A stored date is `"${variables.name}"`. The variable must have type
  `uint256`, hold seconds since 1970-01-01 UTC, and be listed in
  `execution.initialize.data`, so that the agreement stores it when it is
  created.

The contract reads the block time when the input is submitted, directly or by
permit. A permit signed inside a window is refused if it is submitted after the
window has closed. A refused input reverts with `ComparisonFailed`.

The block time is set by the block producer and can differ from the clock by a
few seconds. Use windows for dates and deadlines, not to order inputs that
arrive seconds apart.

`agreements/delivery-deadline` in the repository is a complete example. Time
windows need the V1.1 contracts.

## License

The SDK package is licensed under `Apache-2.0`. See [`LICENSE`](LICENSE), [`NOTICE`](NOTICE), [../licenses/Apache-2.0.txt](../licenses/Apache-2.0.txt), and [../LICENSING.md](../LICENSING.md).
