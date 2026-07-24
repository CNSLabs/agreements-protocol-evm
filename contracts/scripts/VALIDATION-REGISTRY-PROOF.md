# Agent Wallet × ERC-8004 Validation Registry proof

This runner exercises the ERC-8004 Validation Registry address listed by the
official ERC-8004 repository for testnets:

- Linea Sepolia: chain `59141`
- Identity Registry: `0x8004A818BFB912233c491871b3d84c89A494BD9e`
- Validation Registry: `0x8004Cb1BF31DAf7788923b405b754f57acEB4272`
- ERC-8004 source pin: `68fc6765761a10fb26f0692df21c8a6f9d12b1be`

The trace uses ERC-8004 agent `2`, whose owner and registered agent wallet must
both equal the active MetaMask Agent Wallet. The runner generates a one-run
Linea Sepolia signer as the distinct named validator, verifies that it is
neither the agent owner nor an approved operator, and records:

1. a mined unauthorized request rejection from the validator;
2. a successful request from the Agent Wallet;
3. mined duplicate-request, wrong-validator-response, out-of-range-response,
   and zero-validator rejections;
4. a successful response from the distinct validator;
5. exact event fields, registry status, summary, and request indexes;
6. the EIP-1967 implementation slot, runtime bytecode hashes, deployment
   transaction provenance, and pinned source links.

The runner never writes the Agent Wallet policy. It hashes and reads the policy
before and after the trace, then refuses to emit PASS unless the policy remains
byte-for-byte unchanged. It funds the validator only for the mined controls and
response, then refuses to emit PASS unless the balance is swept back to the
Agent Wallet down to a 1,000 wei dust ceiling. The validator private key exists
only in process memory and is never printed or persisted. The validator is a
distinct signing address, not an independent third party.

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
