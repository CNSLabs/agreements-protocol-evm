# ERC-8004 periphery

This package is a small, read-only adapter between an agreement input and the
canonical ERC-8004 Identity, Reputation, and Validation registries. It keeps the
integration boundary explicit:

- one configured ERC-8004 `agentId`;
- an allowlist of Reputation clients, a required `tag1`, and an optional exact
  `tag2`;
- an allowlist of Validation validators and an exact tag;
- numeric floors for the Reputation summary and Validation average; and
- no account-to-agent reverse lookup or registry write.

The adapter is a reference integration. It has not been audited and is not a
claim of production readiness, third-party adoption, or ecosystem endorsement.

## Public package

The public surface is:

- [`ERC8004AuthorityVerifier.sol`](../contracts/src/periphery/erc8004/ERC8004AuthorityVerifier.sol)
  — the read-only authority adapter;
- [`IERC8004Registries.sol`](../contracts/src/periphery/erc8004/IERC8004Registries.sol)
  — the minimal registry read interfaces;
- [`IInputVerifier.sol`](../contracts/src/interfaces/IInputVerifier.sol) — the
  minimal verification hook;
- [`linea-sepolia.json`](../contracts/deployments/erc8004/linea-sepolia.json) —
  the pinned registry and evidence manifest; and
- [`erc8004-linea-sepolia.fork.test.ts`](../contracts/test/erc8004-linea-sepolia.fork.test.ts)
  — the deterministic, read-only public-fork reproduction.

The adapter does not deploy or modify an ERC-8004 registry. It reads the
registries configured by the caller at construction.

## What verification means

`verify(...)` succeeds only when all of the following are true:

1. The calling address matches the supplied agreement address.
2. The configured Reputation and Validation registries both identify the
   configured Identity Registry.
3. The submitted sender is the configured agent's owner, token-approved
   address, operator, or nonzero verified agent wallet.
4. The Reputation Registry returns at least one record from the explicitly
   trusted clients under the configured tags, and the normalized summary meets
   the configured floor.
5. The Validation Registry returns at least one response from the explicitly
   trusted validators under the configured tag, and its average meets the
   configured floor.

The adapter rechecks registry wiring on every verification. It fails closed
when a registry read reverts, a summary has no records, an identity does not
authorize the sender, or a floor is not met.

## Configuration

The constructor requires every decision that would otherwise be hidden policy:

| Input | Meaning |
| --- | --- |
| `identityRegistry_` | ERC-8004 Identity Registry used for ownership, approvals, and agent-wallet binding |
| `reputationRegistry_` | ERC-8004 Reputation Registry linked to the same Identity Registry |
| `validationRegistry_` | ERC-8004 Validation Registry linked to the same Identity Registry |
| `agentId_` | The exact identity being authorized |
| `reputationClients_` | Nonempty allowlist of Reputation clients whose records may count |
| `reputationTag1_`, `reputationTag2_` | Reputation classification; `tag1` must be nonempty, while an empty `tag2` deliberately leaves the second tag unfiltered |
| `minReputation_`, `minReputationDecimals_` | Signed decimal Reputation floor |
| `validationValidators_` | Nonempty allowlist of validators whose responses may count |
| `validationTag_` | Required nonempty Validation classification |
| `minValidationAverage_` | Validation floor from 0 through 100 |

Trust lists reject zero and duplicate addresses. The adapter deliberately does
not interpret arbitrary feedback clients or validators as trustworthy.

## Policy scope and non-bindings

Each adapter deployment is a static, aggregate admission policy for one
configured agent. The agreement chooses which inputs use it by registering the
verifier under the relevant verifier key.

The adapter checks that `msg.sender` equals the supplied `agreement` argument.
That is a caller-consistency invariant, not an allowlist of one agreement: any
caller can truthfully identify itself. The current agreement engine supplies
its own address and the input path's `sender` value when it invokes a verifier.

`inputId` and `payload` are intentionally not interpreted. Reputation and
Validation summaries are filtered by the constructor policy, but they are not
bound to the current agreement, input, payload, or a particular Validation
request hash. The v2.0.0 Validation summary also exposes no response timestamp,
so this adapter does not enforce freshness. A consumer that needs request-level
or time-bounded evidence should use a more specific verifier.

The current engine's permit path reports the transaction relayer as `sender`,
not the recovered permit signer. This verifier therefore checks the direct
caller/relayer on permit submissions. It should not be described as authorizing
the permit signer unless the engine-to-verifier sender semantics change.

Both registry summary functions scan growing per-agent history. In particular,
Validation scans all requests for the agent before applying validator and tag
filters. Verification cost can therefore grow without a fixed bound and may
eventually exceed transaction gas limits. This reference adapter provides no
liveness guarantee for unbounded histories.

## Pinned Linea Sepolia provenance

The reproducible snapshot is Linea Sepolia chain ID `59141` at block
`31,080,433`:

- block hash:
  `0x454179bb7d377dd61af9284a247304f0811b27a183970e53fe87e2f8c45773c7`;
- timestamp: `2026-07-24T19:11:17.000Z`; and
- upstream source pin:
  [`erc-8004/erc-8004-contracts@68fc676`](https://github.com/erc-8004/erc-8004-contracts/tree/68fc6765761a10fb26f0692df21c8a6f9d12b1be).

The upstream address configuration at that pin names these testnet proxies:

| Registry | Proxy | Version at pin | EIP-1967 implementation |
| --- | --- | --- | --- |
| Identity | [`0x8004A818…BD9e`](https://sepolia.lineascan.build/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) | `2.0.0` | `0x7274e874ca62410a93bd8bf61c69d8045e399c02` |
| Reputation | [`0x8004B663…8713`](https://sepolia.lineascan.build/address/0x8004B663056A597Dffe9eCcC1965A193B7388713) | `2.0.0` | `0x16e0fa7f7c56b9a767e34b192b51f921be31da34` |
| Validation | [`0x8004Cb1B…4272`](https://sepolia.lineascan.build/address/0x8004Cb1BF31DAf7788923b405b754f57acEB4272) | `2.0.0` | `0xDB31f5d9167f8ebc8B30FbBF814c4d297c2D7F99` |

All three proxies have the same 130-byte runtime hash:

```text
0xd0e45b1d89fa9b6cc7e97c1f155d64180e5c232aaccf9900ef9d4fd738c02b41
```

The Identity, Reputation, and Validation implementation runtime hashes are,
respectively:

```text
0xa5f9624ea85e45b3f4b8558581f03bfb3e6cefab278d7bf0500ec9bd065dc16f
0x38602de97f1bd86f0a4729f7f3c0a78b1d27892e6eb581272cce5504a68fd00b
0x14ffccec8b46c9175bb80327a5471b0333596aed02e2ff500d772bd505a303c6
```

The manifest records source and runtime provenance separately. Recompiling the
upstream source to reproduce those runtime hashes has not been performed.

## Reproduce the snapshot

The fork test uses no mocks, deploys no contract, and sends no transaction. It
first verifies the manifest's exact fork block number, hash, and timestamp.
Because Hardhat EDR cannot execute `eth_call` at the historical fork block of a
custom chain, the test then mines exactly one empty local-only block solely for
EDR compatibility and performs its reads against the unchanged inherited state:

```bash
HARDHAT_FORK=true \
HARDHAT_FORK_BLOCK_NUMBER=31080433 \
npm --prefix contracts test -- --grep "ERC-8004 canonical Linea Sepolia snapshot"
```

`LINEA_SEPOLIA_RPC_URL` may override the public RPC if the replacement endpoint
serves historical state at the pinned block. The suite rejects a missing or
different `HARDHAT_FORK_BLOCK_NUMBER`. Without `HARDHAT_FORK=true`, it is
skipped cleanly.

The test verifies:

- chain ID, block number, block hash, and timestamp;
- the single local execution block's parent hash and empty transaction list;
- proxy code hashes, EIP-1967 implementation addresses, and implementation code
  hashes;
- registry versions, ownership, and shared Identity Registry wiring;
- the complete sequential agent range and all Reputation and Validation state
  reachable from those agents at the pin; and
- the exact receipts and events for the public transactions below.

## Public evidence and its boundary

At the pinned block, the complete sequential identity range is agent IDs `0`
through `2`; ID `3` does not exist. Each existing agent has exactly one
Reputation record, and agent `2` has exactly one Validation request. These are
CNS-operated test artifacts. No independent ecosystem usage is represented in
this snapshot.

The two public evidence anchors are:

- [agreement composition and Reputation feedback](https://sepolia.lineascan.build/tx/0xcdbc193bb4cffa2ed874fbf53e0bac618f9da2dcf6936f83e77ad42763693a9a),
  mined successfully at block `31,077,981`; and
- [Validation request for agent 2](https://sepolia.lineascan.build/tx/0xd81827772af77710744fa91f0356a691573448c2f2a64dd4dc4d9fcc69b8da0d),
  mined successfully at block `31,080,433`.

The Validation request names validator
`0xf39cAc17C4E6BfF5523f532Ee3D57EB13BA99d34` and request hash
`0xf822cb6a8780c46484813b4d8453832cb6647485c2b05ed04db134183fbedcc3`.
At the pinned block, the registry summary has zero responses for that
validator/request.

Accordingly, this committed snapshot establishes the official-address
deployment, registry read compatibility, Reputation composition, and a mined
Validation request. It does **not** establish an end-to-end Validation
request/response loop, mined rejection controls, signer cleanup, third-party
validator independence, maintainer endorsement, audit status, production
readiness, demand, or token necessity. A response/control/cleanup PASS artifact
had not been committed when this snapshot was prepared.

## Upgrade and data trust

The registries are UUPS proxies owned at the pin by
`0x547289319C3e6aedB179C0b8e8aF0B5ACd062603`. An upgrade can change registry
semantics or code without changing a proxy address. Production consumers should
pin or monitor implementation addresses and bytecode, then deliberately accept
upgrades.

The adapter answers a narrower question: whether configured on-chain signals
meet configured policy. It does not prove that a client or validator used a
sound off-chain method. Operators remain responsible for choosing trusted
clients, validators, tags, floors, chain confirmations, and upgrade policy.

## License

The periphery adapter and minimal verifier interface are Apache-2.0. The
minimal registry ABI declarations were independently written to interoperate
with the public signatures at the pinned upstream commit; no upstream
implementation source is included. The referenced source files carry the MIT
SPDX identifier. See the package
[`LICENSE`](../contracts/src/periphery/erc8004/LICENSE) and
[`NOTICE`](../contracts/src/periphery/erc8004/NOTICE).
