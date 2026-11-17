# Changelog

All notable changes to `@shodai-network/agreements-protocol-evm` are recorded here.

## 0.2.0

The client for the V1.1 contracts. It does not work against V1.0 deployments:
the permit calls, `predictAddress` and the bundled ABIs all changed with the
contracts. The names exported from the package root are the same as in 0.1.4.

### Breaking changes

- **Permit signatures are a single hex string, not `{ v, r, s }`.**
  `AgreementEngine.createPermitSignature` and
  `AgreementFactory.createPermitSignature` now return `signature` as one `Hex`
  value, and `AgreementEngine.submitInputWithPermit`,
  `AgreementFactory.createAgreementWithPermit` and
  `AgreementFactory.createAgreementDeterministicWithPermit` take it in that
  form. The contracts accept the bytes as they are, either a normal wallet
  signature or one that a smart-account signer (ERC-1271) accepts. The
  `CreateAgreementPermitSignature` type is now `Hex`.

- **Every permit names its signer.** The signed message of all three permit
  types starts with a `signer` address field. Permits signed with 0.1.4 are not
  accepted by the V1.1 contracts, and the other way round.
  An input permit is otherwise as before: it carries the signer's permit nonce
  on that agreement and a deadline, and does not name a state. Several parties
  can sign up front and have their permits submitted in whatever order the
  agreement's transitions allow. One signer has one live input permit per
  agreement at a time, because each permit uses the signer's current nonce.
  A permit that has not been submitted stays usable until its deadline, so
  keep deadlines short, or withdraw it with `cancelPermits` (below).

- **Deterministic creation has its own permit.** A signature from
  `AgreementFactory.createPermitSignature` is no longer accepted by
  `createAgreementDeterministicWithPermit`. Sign with the new
  `AgreementFactory.createDeterministicPermitSignature(walletClient, agreement, salt, deadline, options)`,
  which also binds the salt and the address the agreement will be deployed at.

- **Deterministic addresses belong to their creator and to one agreement.**
  `AgreementFactory.predictAddress` now takes the creator first and the
  agreement last: `predictAddress(creator, salt, agreement, options)`. The
  creator is the caller of `createAgreementDeterministic`, or the signer of a
  deterministic permit. Pass the agreement and the create options exactly as
  you will pass them to the create call. The same salt gives a different
  address for a different creator, and for the same creator with different
  terms: changing the document, an initial value, an input, a transition, a
  verifier or an action changes the address. One consequence is that an
  agreement's terms cannot contain its own predicted address. The addresses
  differ from those the V1.0 factory derived for the same salt.

- **ABIs regenerated.** `AgreementEngineABI` and `AgreementFactoryABI` describe
  the V1.1 contracts.

### Added

- `AgreementEngine.cancelPermits(waitForConfirmation?)` withdraws the input
  permit the connected account signed for that agreement and that has not been
  submitted yet (the contract's new `cancelPermits` function). It consumes the
  account's permit nonce, must be sent by the signer itself, and affects no
  other signer or agreement.
- `AgreementFactory.createDeterministicPermitSignature`, described above.
- `AgreementFactory.agreementDigest(agreement, options)` returns the digest of
  an agreement's contents that the factory binds into its deterministic
  address (the contract's new `agreementDigest` function). It is computed
  locally, with no network call.

### Limits

- **Actions cannot send native ETH.** A V1.1 agreement has no way to receive
  ETH, so a transition whose action carries a non-zero `value` reverts. Token
  transfers and other calls with no ETH value are unaffected.

### Dependencies

- `viem` moves from 2.43.2 to 2.57.20, which brings a patched `ws`. The pin is
  still exact.

### Deployments

The bundled deployment registry (`getDeploymentByChainId` and related helpers)
lists V1.1 on Linea Sepolia (chain 59141). Its record keeps the V1.0 pair it
replaced under `legacy`. The other four networks still list their V1.0
deployments, which this client cannot drive with permits: until V1.1 is
deployed there, pass a V1.1 factory address explicitly on those networks.
