# Agreement Definitions And Fixtures

This directory contains example agreement documents and fixture inputs used by the contract integration tests and SDK tests.

## Layout

- `*/unwrapped/` contains raw JSON agreement definitions and raw input payloads.
- `*/wrapped/` contains sample wrapped inputs where that flow is modeled.
- `*.md` files describe the agreement flow in human-readable form.

## Usage

- Contract integration tests read these files directly.
- SDK tests use selected examples to verify transformation and payload parity.
- New example agreements should come with a corresponding integration test under `contracts/test/integration/`.

## Important

- These files are illustrative protocol fixtures, not legal advice.
- Remove business-specific names, wallet addresses, and commercial terms before using any example as a real agreement template.
