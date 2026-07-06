# Public-testnet authority trace — ready to run

`scripts/authority-trace-live.ts` runs the v2 on-chain authority trace against a live network and prints
tx hashes: a single funded signer submits while UNREGISTERED (the tx reverts on-chain), then registers +
attests itself (the tx passes, the FSM advances).

## Run it

Local (proves the script works — already verified):
```
npx hardhat run scripts/authority-trace-live.ts
```

Public testnet (Linea Sepolia — the external artifact):
```
PRIVATE_KEY=<funded Linea Sepolia key> LINEA_SEPOLIA_RPC_URL=<rpc> \
  npx hardhat run scripts/authority-trace-live.ts --network lineaSepolia
```
The `lineaSepolia` network is already configured in `hardhat.config.ts` (accounts from `PRIVATE_KEY`).
Output includes `https://sepolia.lineascan.build/tx/<hash>` links for the reverting and passing txs.

## Status / blocker

Verified end-to-end on the local hardhat network (real txs, real revert, `DONE` state). The **live**
Linea Sepolia run is **one funded key away** — it needs a `PRIVATE_KEY` with Linea Sepolia ETH and an RPC
URL, which are not available in this environment. Provide them and the same script yields a public,
verifiable Lineascan trace. (v3's DelegationManager route would additionally need MetaMask's real
`DelegationManager` deployment address on Linea Sepolia in place of the mock.)
