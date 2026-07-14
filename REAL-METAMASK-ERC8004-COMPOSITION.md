# Real MetaMask delegation → agreement → ERC-8004 composition

Status: **real-contract fork proof and public Linea Sepolia trace pass**

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
public Linea Sepolia. It requires one funded owner key and a distinct delegate key; the script funds the
delegate if its testnet balance is low.

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

## Public Linea Sepolia result

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

## Acceptance status

| Criterion | Status |
| --- | --- |
| Real MetaMask contracts and SDK; no modeled delegation contracts | Pass on pinned fork and public Linea Sepolia |
| Real ERC-8004 Identity and Reputation registries | Pass on pinned fork and public Linea Sepolia |
| Unchanged `AgreementEngine` | Pass |
| Direct-call and exact-calldata negative cases | Pass on pinned fork and public simulations |
| Agreement and ERC-8004 events in the same transaction | Pass on pinned fork and public Linea Sepolia |
| Agreement clone recorded as ERC-8004 `clientAddress` | Pass on pinned fork and public Linea Sepolia |
| Registry failure rolls the transition back | Pass on pinned fork |
| Public explorer evidence | Pass |
| Real on-chain disable/revocation case | Pending a bundler-backed trace |

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
- MetaMask revocation is already proven by the modeled test, but the real-contract revocation flow uses a
  smart-account user operation and therefore needs a bundler-backed test or a direct EntryPoint harness.

## Implementation handoff

The public trace and explorer evidence are complete. The next experiment should answer either real
MetaMask disable/revocation through a bundler or payment-plus-receipt composition; neither is required to
establish the composition proven here.
