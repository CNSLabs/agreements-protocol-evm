# Agreements Protocol - Smart Contracts

This directory contains the core Solidity implementation for the Agreements Protocol.

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

# Deploy to configured public networks
npm run deploy
```

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
