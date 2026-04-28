# Licensing

This repository uses split licensing.

## Core Contracts: BUSL-1.1

The deployable contract implementation in `contracts/src/**` is licensed under `BUSL-1.1`.

The source tree also includes a dedicated `contracts/src/LICENSE` file with the full BUSL text for that boundary.

Parameters for that license in this repository:

- Licensor: `CNS Labs Inc.`
- Additional Use Grant: `None`
- Change Date: `2029-01-01`
- Change License: `GPL-2.0-or-later`

## SDK, Client Libraries, Fixtures, And Docs: Apache-2.0

The following paths are licensed under `Apache-2.0`:

- `sdk/**`
- `contracts/hardhat.config.ts`
- `contracts/test/**`
- `contracts/scripts/**`
- `contracts/deployments/**`
- `agreements/**`
- `.github/**`
- `MAPPING.md`
- repository documentation and ancillary configuration

## Package Notes

- `sdk/package.json` publishes an Apache-2.0 SDK package.
- `contracts/package.json` is intentionally treated as split-licensed because the directory contains BUSL contract sources alongside Apache-2.0 tests and support code.
- Canonical license texts are bundled in `licenses/Apache-2.0.txt` and `licenses/BUSL-1.1.txt`.

## Repository Scope

- This repository is the EVM implementation of the Agreements Protocol.
- The data standard lives separately and should be distributed under `Apache-2.0`.
- CNS services are not distributed from this repository and remain unlicensed unless and until they are published separately.

## Notes

- SPDX headers are authoritative for individual source files where present.
- Package metadata may be more specific for published subpackages such as `sdk/` and `contracts/`.
- If a file is added in the future without an SPDX header, it follows the license for its containing path as described above.
