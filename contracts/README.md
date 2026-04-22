# Agreements Protocol - Smart Contracts

This directory contains the core Solidity implementation for the Agreements Protocol.

Licensing for this directory is split:

- `src/**` is `BUSL-1.1`
- `test/**`, `scripts/**`, `deployments/**`, `hardhat.config.ts`, and this documentation are `Apache-2.0`

See [`LICENSE`](LICENSE), [`src/LICENSE`](src/LICENSE), [../LICENSE](../LICENSE), and [../LICENSING.md](../LICENSING.md).

## Setup

```bash
npm ci
```

## Development

### Compile Contracts

```bash
npm run compile
```

### Run Tests

```bash
npm run test
```

By default the test suite runs on a local Hardhat chain without a live network fork.

### Deploy Contracts

```bash
# Deploy to local network
npm run deploy:local

# Deploy to Linea Sepolia
npm run deploy:lineaSepolia

# Deploy to Linea mainnet
npm run deploy:linea
```

Public-network deployments automatically run explorer verification when
`ETHERSCAN_API_KEY` is set. The Hardhat verify plugin uses the Etherscan V2
API for both Linea (`59144`) and Linea Sepolia (`59141`), while the published
code links still resolve to LineaScan.

Required environment variables for public deployments:

```bash
PRIVATE_KEY=0x...
ETHERSCAN_API_KEY=...
LINEA_SEPOLIA_RPC_URL=https://rpc.sepolia.linea.build   # for Linea Sepolia
LINEA_RPC_URL=https://rpc.linea.build                   # for Linea mainnet
```

If you need to suppress verification for a public deployment, set
`SKIP_CONTRACT_VERIFICATION=true`.

### Start Local Hardhat Node

```bash
npm run node
```

### Start A Forked Local Node

```bash
npm run node:fork
```

### Static Analysis

If `slither` is installed locally:

```bash
npm run slither
```

## Project Structure

```text
contracts/
├── src/               # Solidity source files
├── scripts/           # Deployment scripts
├── test/              # Unit and integration tests
├── deployments/       # Network deployment manifests
└── hardhat.config.ts  # Hardhat configuration
```
