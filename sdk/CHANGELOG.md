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

- **Input permits are tied to the agreement's current position.** The
  `PermitInput` message now also carries `expectedState` and
  `expectedStateNonce`. `AgreementEngine.createPermitSignature` reads both from
  the agreement when it signs. Once the agreement accepts any other input, a
  permit signed earlier is rejected with `InvalidSignature` and has to be
  signed again. In 0.1.4 a permit stayed usable until its deadline, or until
  the signer's permit nonce was used.

- **Deterministic creation has its own permit.** A signature from
  `AgreementFactory.createPermitSignature` is no longer accepted by
  `createAgreementDeterministicWithPermit`. Sign with the new
  `AgreementFactory.createDeterministicPermitSignature(walletClient, agreement, salt, deadline, options)`,
  which also binds the salt and the address the agreement will be deployed at.

- **Deterministic addresses belong to their creator.**
  `AgreementFactory.predictAddress` now takes the creator first:
  `predictAddress(creator, salt)`. The creator is the caller of
  `createAgreementDeterministic`, or the signer of a deterministic permit. The
  same salt gives a different address for a different creator, and the
  addresses differ from those the V1.0 factory derived for the same salt.

- **ABIs regenerated.** `AgreementEngineABI` and `AgreementFactoryABI` describe
  the V1.1 contracts.

### Added

- `AgreementEngine.getStateNonce()` returns the number of inputs the agreement
  has accepted so far (the contract's new `stateNonce()` getter).
- `AgreementFactory.createDeterministicPermitSignature`, described above.

### Dependencies

- `viem` moves from 2.43.2 to 2.57.20, which brings a patched `ws`. The pin is
  still exact.

### Deployments

The bundled deployment registry (`getDeploymentByChainId` and related helpers)
is unchanged and still lists the V1.0 deployments. V1.1 addresses will be added
once the contracts are deployed; until then, pass the factory address of a V1.1
deployment explicitly.
