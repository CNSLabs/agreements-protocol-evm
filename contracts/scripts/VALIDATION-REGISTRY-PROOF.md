# Agent Wallet × ERC-8004 Validation Registry proof

This runner exercises the ERC-8004 Validation Registry address listed by the
official ERC-8004 repository for testnets:

- Linea Sepolia: chain `59141`
- Identity Registry: `0x8004A818BFB912233c491871b3d84c89A494BD9e`
- Validation Registry: `0x8004Cb1BF31DAf7788923b405b754f57acEB4272`
- ERC-8004 source pin: `68fc6765761a10fb26f0692df21c8a6f9d12b1be`

The trace uses ERC-8004 agent `2`, whose owner and registered agent wallet must
both equal the active MetaMask Agent Wallet. It generates a distinct validator
key in memory, temporarily funds that validator, and records:

1. a mined unauthorized request rejection from the validator;
2. a successful request from the Agent Wallet;
3. mined duplicate-request, wrong-validator-response, out-of-range-response,
   and zero-validator rejections;
4. a successful response from the distinct validator;
5. exact event fields, registry status, summary, and request indexes;
6. the EIP-1967 implementation slot, runtime bytecode hashes, deployment
   transaction provenance, and pinned source links.

The runner temporarily adds the Validation Registry and the one-run validator
to the Agent Wallet allowlist and raises the rolling 24-hour outflow limit to
at least USD 5 so it can fund the validator. On normal control flow it returns
the validator balance to a 1,000 wei dust ceiling and restores the original
policy byte-for-byte before emitting PASS. Restoration uses a compare-and-swap
check and refuses to overwrite an intervening policy change. The validator
private key is never printed or persisted.

Run:

```sh
npm --prefix contracts run trace:agent-wallet-validation
```

If `mm` is not on `PATH`, or the CLI needs a different Node runtime, set
`AGENT_WALLET_CLI_BIN` and `AGENT_WALLET_NODE_BIN`.

The resulting evidence is written to:

```text
evidence/linea-sepolia-metamask-agent-wallet-validation-registry-2026-07-24-<request-hash-prefix>.json
```

This is a bounded testnet composition proof. It does not establish mainnet or
production readiness, audit status, challenge/slashing/finality semantics,
agreement-outcome enforcement, demand, economics, or token necessity.
