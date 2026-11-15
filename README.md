# Agreements Protocol EVM

This repository contains the EVM implementation of the Agreements Protocol:

- `contracts/` holds the Solidity core, deployment scripts, and integration tests.
- `contracts/src/periphery/erc8004/` holds an open-source adapter for reading authority evidence from the official ERC-8004 registries.
- `sdk/` holds the TypeScript SDK that transforms agreement JSON into on-chain parameters and interaction payloads.
- `agreements/` holds example agreement definitions and fixture inputs used by tests and examples.

This is the low-level contract and direct-onchain integration repository. Most applications and AI agents should start with the Shodai Agreements API, TypeScript client, or MCP instead of deploying and indexing the contracts themselves.

## Choose an integration path

| Goal | Start here | First useful proof |
| --- | --- | --- |
| Connect an AI agent or MCP client | [MCP quickstart](https://docs.shodai.network/sdks/quickstart-with-mcp) | Authenticate, validate an agreement, run deployment preflight, and prepare typed data without exposing a private key. |
| Build a TypeScript application | [TypeScript SDK quickstart](https://docs.shodai.network/sdks/quickstart-with-typescript-sdk) and the [Agreements SDK + MCP repository](https://github.com/CNSLabs/agreements-api-sdk) | Validate and preflight a complete agreement through the supported API client. |
| Develop the EVM engine or integrate directly onchain | This repository and the [direct SDK guide](./sdk/README.md) | Compile and test the engine, then exercise a local deployment or direct SDK interaction. |
| Verify authority through ERC-8004 | [ERC-8004 periphery guide](./docs/ERC8004-PERIPHERY.md) | Compile the adapter and run its deterministic unit tests against the official registry interfaces. |
| Author or inspect agreement JSON | [Agreement data standard](https://docs.shodai.network/system-architecture/data-standard) and the [standard repository](https://github.com/CNSLabs/agreements-standard) | Validate the agreement definition before selecting an execution path. |

See [Choose an integration surface](https://docs.shodai.network/integration-surfaces) for the API, SDK, and MCP paths, or obtain a testnet API key from the [Developer Portal](https://developers.shodai.network/portal).

Running this repository's compile and test commands proves the EVM implementation and direct SDK path. It does not by itself exercise the hosted Agreements API or MCP lifecycle.

## Requirements

- Node.js `20.x`
- npm `10+`

Use the included [`.nvmrc`](.nvmrc) if you use `nvm`.

## Quick Start

```bash
npm ci
npm run contracts:compile
npm run lint
npm test

# Focused ERC-8004 periphery checks
npm run erc8004:check
```

The root validation flow compiles contracts first because the SDK build and some TypeScript checks depend on generated contract artifacts.

## Licensing

This repository is split-licensed:

- Core contracts in `contracts/src/**` are `BUSL-1.1`.
- `contracts/src/periphery/erc8004/**` and `contracts/src/interfaces/IInputVerifier.sol` are explicit `Apache-2.0` exceptions to that source-tree default.
- SDK, client-facing libraries, examples, tests, scripts, and docs are `Apache-2.0`.

See [`LICENSE`](LICENSE), [`LICENSING.md`](LICENSING.md), and [`NOTICE`](NOTICE) for the repository licensing map.

## Local Development

### Contracts

```bash
# Non-forked local node
npm --prefix contracts run node

# Optional Linea Sepolia fork
npm --prefix contracts run node:fork

# Deterministic forked contract tests
npm run contracts:test:fork

# Deploy to localhost
npm --prefix contracts run deploy:local

# Deploy to Linea Sepolia and verify on LineaScan when ETHERSCAN_API_KEY is set
npm --prefix contracts run deploy:lineaSepolia

# Deploy to Linea mainnet and verify on LineaScan when ETHERSCAN_API_KEY is set
npm --prefix contracts run deploy:linea
```

Local deployments are written to `contracts/deployments/<network>/AgreementsProtocol.json`.

### ERC-8004 periphery

```bash
npm run erc8004:compile
npm run erc8004:lint
npm run erc8004:test
```

The periphery is a narrowly scoped reference integration. It reads ERC-8004 identity, reputation, and validation evidence without publishing the core engine under the periphery license. It has not been audited, and its inclusion here is not a claim of production readiness, third-party adoption, or ecosystem endorsement.

### SDK

```bash
npm --prefix sdk run build
npm --prefix sdk run test
```

## Notes

- Example agreements in `agreements/` are illustrative fixtures, not legal templates or legal advice.
- This repository does not include the hosted Agreements API, Developer Portal, or MCP service.
