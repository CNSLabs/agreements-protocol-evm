# P0 measurements

`p0-bytecode-delta.json` compares the P0 candidate with the clean `origin/main`
baseline using the same checked-in Hardhat compiler settings. It records both
creation and deployed-runtime byte counts and Keccak-256 hashes.

`p0-gas-gate.json` is emitted by `npm run gas:check`. Missing measurements are
failures, and the gate checks the largest observed method cost (or the labeled
single-sample average) plus both implementation deployment costs.

To reproduce it, compile a detached baseline worktree, compile this worktree,
then run:

```sh
BASE_ARTIFACTS_DIR=/path/to/baseline/contracts/artifacts \
BASE_COMMIT=ee44672f6754e7a01bc7ed13f4b0b541b8d3f7b0 \
npm run measure:bytecode
```

The measurement is deliberately the whole integrated P0 candidate, not the
earlier isolated ERC-1271 library spike. That makes the reported delta honest
about the settlement, authorization, deterministic-permit, and smart-account
changes that ship together.
