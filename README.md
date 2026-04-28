# Agreements Protocol EVM

This repository contains the EVM implementation of the Agreements Protocol:

- `contracts/` holds the Solidity core, deployment scripts, and integration tests.
- `sdk/` holds the TypeScript SDK that transforms agreement JSON into on-chain parameters and interaction payloads.
- `agreements/` holds example agreement definitions and fixture inputs used by tests and examples.

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
```

The root validation flow compiles contracts first because the SDK build and some TypeScript checks depend on generated contract artifacts.

## Licensing

This repository is split-licensed:

- Core contracts in `contracts/src/**` are `BUSL-1.1`.
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

### SDK

```bash
npm --prefix sdk run build
npm --prefix sdk run test
```

## Notes

- Example agreements in `agreements/` are illustrative fixtures, not legal templates or legal advice.
- This repo does not include CNS services.
