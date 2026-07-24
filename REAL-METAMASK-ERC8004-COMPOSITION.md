# Real MetaMask delegation → agreement → ERC-8004 composition

Status: **real-contract fork proof, live MetaMask Agent Wallet composition, and public ERC-7710
delegated-authority disable trace pass**

## Problem and scope

Prove that a MetaMask-style delegated authority can enter the deterministic agreement engine without
changing the engine, then have the accepted agreement transition emit an objective lifecycle receipt
through the official ERC-8004 Reputation Registry.

The proof is deliberately narrow. It demonstrates contract composition and atomicity; it does not define
a production reputation score, payment-plus-receipt composition, or a general receipt taxonomy.

## Current-state observations

The earlier v3 trace established the call shape with faithful local models:

```text
delegate → DelegationManager → delegator smart account → AgreementEngine.submitInput
```

The engine authorizes the smart account through its existing sender condition. Delegation signatures,
caveats, and revocation remain outside the engine.

The engine also already supports one fixed external action per transition. That is sufficient for a
receipt-only transition to call `ReputationRegistry.giveFeedback(...)` atomically. No change to
`AgreementEngine.sol` is required.

## Implemented proof

`contracts/test/real-metamask-erc8004-composition.fork.test.ts` runs against Linea Sepolia block
`28079114` (2026-04-01) and uses:

- `@metamask/smart-accounts-kit` `1.6.0`
- MetaMask deployment manifest `1.4.0`
- MetaMask DelegationManager `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3`
- MetaMask SimpleFactory `0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c`
- ERC-8004 Identity Registry `0x8004A818BFB912233c491871b3d84c89A494BD9e`
- ERC-8004 Reputation Registry `0x8004B663056A597Dffe9eCcC1965A193B7388713`
- ERC-8004 registry version `2.0.0`

The successful transaction is:

```text
delegate EOA
  → real MetaMask DelegationManager
  → real MetaMask Hybrid smart account
  → unchanged AgreementEngine.submitInput
  → real ERC-8004 ReputationRegistry.giveFeedback
```

It proves that:

1. A direct call by the delegate is rejected by the agreement.
2. A call that violates the delegation's exact-calldata caveat is rejected by MetaMask's real enforcers.
3. A valid redemption advances the agreement from `START` to `DONE`.
4. The same transaction emits the engine's `InputAccepted` and `ActionExecuted` events and ERC-8004's
   `NewFeedback` event.
5. ERC-8004 records the agreement clone as `clientAddress`.
6. The receipt reads back as `1 / agreement-lifecycle / milestone-accepted`.
7. If ERC-8004 rejects the feedback, the agreement transition rolls back to `START` and no receipt is stored.

No local `Mock*` contract participates in this test.

## Run the repeatable proof

Use Node 20 as pinned by `.nvmrc`:

```bash
nvm use
cd contracts
HARDHAT_PORT=18545 npm run test:fork -- test/real-metamask-erc8004-composition.fork.test.ts
```

`HARDHAT_PORT` can be omitted when port 8545 is free.

## Run the public trace

`contracts/scripts/real-metamask-erc8004-live.ts` performs the same successful composition against
public Linea Sepolia. In private-key mode it requires one funded owner key and a distinct delegate key;
the script funds the delegate if its testnet balance is low. Agent Wallet mode, documented below,
replaces the delegate private key with MetaMask Agent Wallet.

```bash
cd contracts
PRIVATE_KEY=<funded-owner-key> \
DELEGATE_PRIVATE_KEY=<distinct-delegate-key> \
LINEA_SEPOLIA_RPC_URL=<rpc-url> \
npm run trace:real-composition
```

The script refuses networks other than Linea Sepolia (with an explicit localhost-fork exception for
smoke testing), checks every external deployment and registry version, runs the two negative cases as
read-only simulations, submits the valid redemption, verifies state and feedback readback, and prints a
JSON evidence bundle with Lineascan links.

### Run with MetaMask Agent Wallet as the delegate

The same runner can replace the local delegate private key with MetaMask Agent Wallet. This is a signer
and transaction-submission adapter; the ERC-7710 delegation, deployed Delegation Manager, Hybrid smart
account, agreement kernel, and ERC-8004 registries remain unchanged.

MetaMask Agent Wallet currently requires its own Node 22 runtime while this repository remains pinned to
Node 20. Point the runner at the Agent Wallet CLI entry point and a supported Node binary explicitly:

```bash
mm login
mm init --wallet server-wallet --mode guard
mm doctor --json

cd contracts
PRIVATE_KEY=<funded-owner-key> \
LINEA_SEPOLIA_RPC_URL=<rpc-url> \
AGENT_WALLET_NODE_BIN=<node-22.18-or-newer-binary> \
AGENT_WALLET_CLI_BIN=<path-to-mm> \
npm run trace:agent-wallet-composition
```

In Agent Wallet mode the runner:

1. refuses to continue unless `mm doctor` reports an authenticated, initialized wallet;
2. resolves the active Agent Wallet EVM address and makes it the ERC-7710 delegate;
3. funds that address with Linea Sepolia ETH when necessary;
4. has Agent Wallet register its own ERC-8004 identity and verifies `getAgentWallet(agentId)` matches;
5. submits the exact `redeemDelegations(...)` transaction through `mm wallet send-transaction`;
6. verifies the transaction sender, agreement events, state transition, ERC-8004 event, and readback.

Set `AGENT_WALLET_ADDRESS` only when the CLI address lookup cannot be used; the transaction sender is
still checked against that value. The CLI transaction is submitted with `--wait`, so server-wallet MFA,
policy denial, and timeout failures stop the trace rather than producing partial success evidence.

### Smoke-test the Agent Wallet adapter locally

For offline development, run the same Agent Wallet integration path against a pinned local Linea
Sepolia fork:

```bash
cd contracts
npm run trace:mock-agent-wallet-composition
```

The harness replaces only the `mm doctor`, `mm wallet address`, and
`mm wallet send-transaction` boundary. It uses a deterministic local delegate key, but still exercises
the deployed MetaMask Delegation Manager and ERC-8004 registries, the Hybrid smart account, the
unchanged agreement engine, exact-calldata caveat enforcement, agent registration, delegated
redemption, and receipt readback. The evidence bundle identifies this path as
`mock-agent-wallet-cli`, not MetaMask Agent Wallet.

The mock refuses non-local RPC endpoints, non-zero-value calls, and targets other than the Identity
Registry and Delegation Manager. It does not reproduce or establish MetaMask's key custody, TEE,
Guard Mode, policy service, simulation, Blockaid scanning, MEV protection, MFA, availability, or live
transaction behavior. Delegated-authority disable remains `SKIPPED` unless the separate
bundler-backed trace is run.

### Run a real ERC-7710 delegated-authority disable trace

Set `BUNDLER_RPC_URL` to a Linea Sepolia ERC-4337 bundler endpoint. After the successful composition the
runner confirms that the bundler supports the Hybrid account's EntryPoint, funds the smart account,
checks the fresh delegation is enabled, and sends a `disableDelegation` user operation. It then requires
all three independent on-chain/runtime bindings: `disabledDelegations(hash)` changes from `false` to
`true`; the mined transaction emits the exact `DisabledDelegation` event for the delegation hash,
Hybrid account, and Agent Wallet delegate; and replay reaches the Delegation Manager's specific
`CannotUseADisabledDelegation()` error rather than merely failing in the already-terminal agreement.

```bash
PRIVATE_KEY=<funded-owner-key> \
LINEA_SEPOLIA_RPC_URL=<rpc-url> \
BUNDLER_RPC_URL=<linea-sepolia-bundler-rpc> \
AGENT_WALLET_NODE_BIN=<node-22.18-or-newer-binary> \
AGENT_WALLET_CLI_BIN=<path-to-mm> \
npm run trace:agent-wallet-composition
```

Without `BUNDLER_RPC_URL`, the evidence bundle reports `delegationDisable` as `SKIPPED`; it never
upgrades a read-only failure simulation into an on-chain authority-revocation claim. Disabling delegated
authority does not revoke or correct the ERC-8004 feedback record.

## Public Linea Sepolia results

### 2026-07-14 — real contracts with a local-key delegate

The public trace passed on 2026-07-14 at block `30842239`. The machine-readable output, including all
addresses, block numbers, timestamps, and transaction hashes, is preserved in
[`evidence/linea-sepolia-real-metamask-erc8004-2026-07-14.json`](evidence/linea-sepolia-real-metamask-erc8004-2026-07-14.json).

- MetaMask smart account: [`0x2bFb...b077`](https://sepolia.lineascan.build/address/0x2bFbC28214D6ff0C9103963545ca30bd533Cb077)
- Agreement clone: [`0xc5E9...c5Dd`](https://sepolia.lineascan.build/address/0xc5E912DDC58AEb998E389E086C96f3E6A250c5Dd)
- ERC-8004 agent: `0`
- Lifecycle receipt: `1 / agreement-lifecycle / milestone-accepted`, feedback index `1`, not revoked
- Negative simulations: direct delegate call rejected; non-delegated calldata rejected
- Composition transaction: [`0x83eb...193e`](https://sepolia.lineascan.build/tx/0x83eb1b96a9009985cf1c36815efc8a573559c6a78574310415215e805b3b193e)

The composition transaction was sent by the delegate to MetaMask's real Delegation Manager. Its four
logs include `InputAccepted` and `ActionExecuted` from the unchanged agreement clone plus `NewFeedback`
from the real ERC-8004 Reputation Registry. The feedback's `clientAddress` is the agreement clone, so the
receipt is objectively attributable to the agreement that accepted the input.

### 2026-07-24 — MetaMask Agent Wallet composition and delegated-authority disable

The live Agent Wallet trace passed from source commit
`3ee6d4d30dce5d46854dcab311b56cf8b968b418`. Its machine-readable evidence is preserved in
[`evidence/linea-sepolia-metamask-agent-wallet-erc8004-2026-07-24.json`](evidence/linea-sepolia-metamask-agent-wallet-erc8004-2026-07-24.json).

- MetaMask Agent Wallet: [`0x478c...E887`](https://sepolia.lineascan.build/address/0x478c3A0377F6f93BfB3DB5167DC3d7dc8840E887)
- MetaMask Hybrid smart account: [`0x2bFb...b077`](https://sepolia.lineascan.build/address/0x2bFbC28214D6ff0C9103963545ca30bd533Cb077)
- Agreement clone: [`0xd046...3A4d`](https://sepolia.lineascan.build/address/0xd0465017fb4A3c603cb3b315C0EF82a3d21E3A4d)
- ERC-8004 agent: `2`, owned by and registered to the Agent Wallet
- Composition transaction at block `31077981`: [`0xcdbc...a9a`](https://sepolia.lineascan.build/tx/0xcdbc193bb4cffa2ed874fbf53e0bac618f9da2dcf6936f83e77ad42763693a9a)
- Delegated-authority disable transaction at block `31077984`: [`0x6ff4...2e36`](https://sepolia.lineascan.build/tx/0x6ff469b2e32bedad238284a700dde4daf2533d3e3a6d3cd6e92142a466d52e36)
- ERC-4337 user operation: `0x8fdf90b67b674eb6df2d64851c4c2e3d66a0c3527dba0a4cf7a88d6cc978ad1d`
- Disabled delegation: `0x126d093bf90a3ae270d405d68c8f3928fa6f297a896c3a3918a0f4b6a1c3f449`

The Agent Wallet was the ERC-7710 delegate and sent the composition transaction through MetaMask's
deployed Delegation Manager. The agreement reached `DONE`, and the same transaction emitted
`InputAccepted`, `ActionExecuted`, and `NewFeedback`.

The Hybrid smart account then disabled that exact delegation through an ERC-4337 user operation. The
Delegation Manager's mapping changed from `false` to `true`, the mined transaction emitted the exact
`DisabledDelegation` event, and a replay failed with `CannotUseADisabledDelegation()` selector
`0x05baa052`. The replay did not change the agreement or create another feedback record. The original
ERC-8004 lifecycle feedback remains unrevoked because disabling delegated authority is separate from
correcting or revoking a reputation record.

## Acceptance status

| Criterion | Status |
| --- | --- |
| Real MetaMask contracts and SDK; no modeled delegation contracts | Pass on pinned fork and public Linea Sepolia |
| Real MetaMask Agent Wallet as ERC-7710 delegate, transaction sender, and ERC-8004 wallet | Pass on public Linea Sepolia |
| Real ERC-8004 Identity and Reputation registries | Pass on pinned fork and public Linea Sepolia |
| Unchanged `AgreementEngine` | Pass |
| Direct-call and exact-calldata negative cases | Pass on pinned fork and public simulations |
| Agreement and ERC-8004 events in the same transaction | Pass on pinned fork and public Linea Sepolia |
| Agreement clone recorded as ERC-8004 `clientAddress` | Pass on pinned fork and public Linea Sepolia |
| Registry failure rolls the transition back | Pass on pinned fork |
| Public explorer evidence for composition and delegated-authority disable | Pass |
| Real on-chain delegated-authority disable | Pass on public Linea Sepolia: mapping, event, and exact replay error |

## Options and tradeoffs

The current single-action engine can emit a receipt directly only when that transition's action slot is
available. A transition that already releases payment has three options:

1. Use a router action for payment plus feedback. This preserves atomicity, but the router—not the
   agreement clone—becomes ERC-8004's `clientAddress`.
2. Emit feedback in a second transaction. This preserves the current kernel but loses atomicity.
3. Add ordered multi-action support to the engine. This preserves direct attribution and atomicity but is
   a kernel change with ordering, gas, failure-policy, and reentrancy consequences.

The recommended next experiment is option 1 only if payment-plus-receipt composition is immediately
required. Otherwise, keep this receipt-only proof as the boundary and defer kernel changes.

## Risks and open questions

- A receipt is only credible if consumers recognize the agreement's factory and implementation. Anyone
  can otherwise deploy a lookalike agreement and publish feedback.
- The proof's `1 / agreement-lifecycle / milestone-accepted` signal is objective but provisional. A
  production taxonomy must define subjects, lifecycle events, corrections, and revocations.
- Fixed initialization calldata cannot include values known only after execution, such as the receipt
  transaction hash. The shared transaction and event log provide the atomic join in this proof.
- The public trace produces persistent testnet state. Its success establishes composition, not production
  key-management, registry-governance, or operational readiness.
- `disableDelegation` closes one exact ERC-7710 authority grant. It does not revoke the Agent Wallet,
  correct the ERC-8004 feedback, or establish account recovery, fleet policy, and mainnet operations.

## Implementation handoff

The live Agent Wallet composition and real delegated-authority disable traces now have public explorer
and machine-readable evidence. The remaining optional experiment is payment-plus-receipt composition;
the receipt-only composition proven here requires no engine change.
