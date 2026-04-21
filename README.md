# Agreements Protocol EVM

This repository contains the EVM implementation of the Agreements Protocol:

- `contracts/` holds the Solidity core, deployment scripts, and integration tests.
- `sdk/` holds the TypeScript SDK that compiles agreement JSON into on-chain parameters and interaction payloads.
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

## Local Development

### Contracts

```bash
# Non-forked local node
npm --prefix contracts run node

# Optional Linea Sepolia fork
npm --prefix contracts run node:fork

# Deploy to localhost
npm --prefix contracts run deploy:local
```

Local deployments are written to `contracts/deployments/<network>/AgreementsProtocol.json`.

### SDK

```bash
npm --prefix sdk run build
npm --prefix sdk run test
```

## Notes

- Example agreements in `agreements/` are illustrative fixtures, not legal templates or legal advice.
- See [`LICENSE`](LICENSE) and [`LICENSING.md`](LICENSING.md) for the repository's split-licensing model.
