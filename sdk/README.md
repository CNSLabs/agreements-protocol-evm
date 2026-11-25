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

A bound is exactly one of those forms. Arithmetic or text around a variable
reference, a date that does not exist, a moment outside 2001 to 2286 (usually
milliseconds given as seconds) and the same stored date on both bounds are
refused when the agreement is transformed.

The contract reads the block time when the input is submitted, directly or by
permit. What counts is the block the input lands in, not when it was signed: a
permit signed inside a window is refused if it is submitted after the window
has closed. A refused input reverts with `ComparisonFailed`.

The block time is set by the block producer and can differ from the clock by a
few seconds. Use windows for dates and deadlines, not to order inputs that
arrive seconds apart.

`agreements/delivery-deadline` in the repository is a complete example.

Time windows need both sides to know them:

- **The contracts.** Create the agreement on a V1.1 factory whose engine has
  time conditions. An older engine, V1.0 included, accepts the agreement and
  does not enforce the window: there the party submitting an input can state
  the time itself. The bundled registry only returns V1.1 factories, and
  returns nothing for a network that has none.
- **The SDK.** A version of this SDK from before time windows ignores `time`
  and deploys the agreement with no window, without an error.

### Checks And Stored Values

An input can check a submitted number against a constant or against a value the
agreement stores, and can store a number it submits. Together they let an
agreement repeat a set of steps a counted number of times with one set of
states.

```json
"acceptMilestone": {
  "type": "VerifiedCredentialEIP712",
  "data": {
    "reviewNote": "${variables.reviewNote}",
    "milestone": "${variables.milestone}",
    "currentMilestone": "${variables.currentMilestone}"
  },
  "issuer": "${variables.reviewer.value}",
  "checks": [
    { "field": "milestone", "is": "equalTo", "to": "${variables.currentMilestone}" },
    { "field": "milestone", "is": "lessThan", "to": "${variables.milestoneCount}" },
    { "field": "currentMilestone", "is": "equalTo", "to": "${variables.currentMilestone}", "plus": 1 }
  ],
  "store": ["currentMilestone"]
}
```

- `checks`: each entry compares one `uint256` field of the input. `is` is one of
  `equalTo`, `lessThan`, `lessThanOrEqualTo`, `greaterThan`,
  `greaterThanOrEqualTo`. `to` is a whole number or `"${variables.name}"`, a
  `uint256` variable the agreement stores. With a stored variable, `plus` or
  `minus` adds or subtracts a whole number first. Every check must hold.
- `store`: the fields of the input whose submitted value the agreement keeps
  when the input is accepted. The value replaces the stored variable of the
  same name.

A checked field and a stored field must be required: the contract skips a check
on an optional field that is left out. Checks are evaluated against the values
stored before the input, so "the stored value plus one" in the example means one
more than the milestone the agreement was on.

In a loop, give every repeated step a field that names its round and check it
against the stored round, as `milestone` does above. A step that was signed for
an earlier round and never submitted is then refused in a later one.

Refused when the agreement is transformed, because the agreement could not work
as written:

- a variable in a check that has no value before the check can run: it is not
  listed in `execution.initialize.data`, and every input that stores it also
  checks against it;
- a stored field whose type is not that of the variable it replaces, or of the
  field another input stores under the same name;
- an empty `store` list;
- a value at creation, for a variable that a check names or an input stores,
  that is not a whole number written as digits (`""`, `" 2 "`, `"0x10"` and
  `true` are refused, where they would otherwise be read as 0, 2, 16 and 1).

The SDK does not work out whether the checks of an input can be met together,
or whether a counter starts within its count: run the agreement once before it
is used.

`agreements/counted-milestones` is a complete example.

Checks and stored values need both sides to know them:

- **The contracts.** A check against a stored variable, with or without `plus`
  or `minus`, is built with the engine's offset comparisons. An engine from
  before them, V1.0 included, refuses to create the agreement.
- **The SDK.** A version of this SDK from before checks ignores `checks` and
  `store` and deploys the agreement with nothing checked and nothing stored,
  without an error. Build and deploy such an agreement with this version or a
  later one.

## License

The SDK package is licensed under `Apache-2.0`. See [`LICENSE`](LICENSE), [`NOTICE`](NOTICE), [../licenses/Apache-2.0.txt](../licenses/Apache-2.0.txt), and [../LICENSING.md](../LICENSING.md).
