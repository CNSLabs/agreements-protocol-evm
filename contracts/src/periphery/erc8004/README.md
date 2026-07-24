# ERC-8004 Periphery

This directory contains the Apache-2.0 reference adapter for reading agreement
authority evidence from the official ERC-8004 Identity, Reputation, and
Validation registries.

The adapter depends only on the minimal Apache-2.0 verifier interface at
[`../../interfaces/IInputVerifier.sol`](../../interfaces/IInputVerifier.sol).
The core contract implementations elsewhere in `contracts/src/` are outside
this open-source boundary and remain licensed under BUSL-1.1.

See [`../../../../docs/ERC8004-PERIPHERY.md`](../../../../docs/ERC8004-PERIPHERY.md)
for configuration, trust assumptions, reproducible checks, and the pinned
registry provenance.

This code is a reference integration. It has not been audited and is not, by
itself, evidence of production readiness, third-party adoption, or ecosystem
endorsement.

Each deployment applies a static aggregate policy to one configured agent.
It does not bind registry summaries to a particular input payload, Validation
request hash, or response time. See the guide for the complete trust model.

## License

The files in this directory are licensed under Apache-2.0. See
[`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
