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

- **A direct input retires the sender's outstanding input permit.** In V1.1 an
  input accepted through `submitInput` consumes the sender's permit nonce on
  that agreement, as an accepted permit does. An input permit the sender signed
  earlier and that was not submitted is then refused (`InvalidSignature`); sign
  again with `createPermitSignature`, which reads the new nonce. Under V1.0 the
  earlier permit stayed valid and could be submitted the next time the
  agreement accepted its input. Permits signed by other parties are not
  affected. The first direct input an account sends to an agreement costs about
  22,000 more gas than under V1.0, and later ones about 5,000 more.

- **Deterministic creation has its own permit.** A signature from
  `AgreementFactory.createPermitSignature` is no longer accepted by
  `createAgreementDeterministicWithPermit`. Sign with the new
  `AgreementFactory.createDeterministicPermitSignature(walletClient, agreement, salt, deadline, options)`,
  which also binds the salt and the address the agreement will be deployed at.

- **Deterministic addresses belong to their creator.**
  `AgreementFactory.predictAddress` now takes the creator first:
  `predictAddress(creator, salt)`. The creator is the caller of
  `createAgreementDeterministic`, or the signer of a deterministic permit. The
  same salt gives a different address for a different creator, so knowing a
  salt does not let another account deploy to the address it predicts. The
  address does not depend on the agreement's terms: a creator can deploy any
  one agreement at the address of a given salt, so verify a deployed agreement
  before relying on an address that was only predicted. The addresses differ
  from those the V1.0 factory derived for the same salt.

- **ABIs regenerated.** `AgreementEngineABI` and `AgreementFactoryABI` describe
  the V1.1 contracts.

### Added

- `AgreementEngine.cancelPermits(waitForConfirmation?)` withdraws the input
  permit the connected account signed for that agreement and that has not been
  submitted yet (the contract's new `cancelPermits` function). It consumes the
  account's permit nonce, must be sent by the signer itself, and affects no
  other signer or agreement.
- `AgreementFactory.createDeterministicPermitSignature`, described above.
- **Time windows on inputs.** An input in the agreement JSON can carry
  `time: { notBefore, before }`. `notBefore` accepts the input at that moment
  and after it; `before` accepts it only before that moment. Each bound is a
  fixed moment (seconds since 1970-01-01 UTC, or an ISO 8601 date-time with a
  zone) or `"${variables.name}"`, a `uint256` variable that holds seconds and is
  listed in `execution.initialize.data`. The transform turns the window into
  conditions on the block time, which the V1.1 engine reads when the input is
  submitted, directly or by permit. Refused when the agreement is transformed:
  a bound the SDK does not know, anything but exactly one variable reference
  in a bound that names a variable, a date-time without a zone or that does
  not exist, a moment outside 2001 to 2286, a stored date whose value at
  creation is not such a moment, and a window that could never be met (fixed
  bounds in the wrong order, or the same variable on both bounds). An engine
  from before time conditions, V1.0 included, does not enforce a window, and
  an SDK from before them ignores `time`: create such an agreement on a V1.1
  factory with this SDK. `transformInputs` takes an optional third argument,
  the names of the variables stored at creation; it is needed only when a bound
  names a variable. `agreements/delivery-deadline` is an example.
- **Checks and stored values on inputs.** An input can carry `checks`, a list
  of comparisons of one `uint256` field (`equalTo`, `lessThan`,
  `lessThanOrEqualTo`, `greaterThan`, `greaterThanOrEqualTo`) with a whole
  number or a stored `uint256` variable, optionally `plus` or `minus` a whole
  number, and `store`, the fields whose submitted value the agreement keeps.
  With them an agreement can count rounds and repeat one set of states.
  A checked or stored field must be required, a variable in a check must be
  stored at creation or by an input, and a check the SDK cannot read is
  refused. A check with `plus` or `minus` uses the engine's offset
  comparisons, which an engine from before them refuses at creation.
  `agreements/counted-milestones` is an example.

### Limits

- **Actions cannot send native ETH.** A V1.1 agreement has no way to receive
  ETH, so the contracts refuse to create an agreement whose action carries a
  non-zero `value` (`ActionValueNotSupported`), and the SDK refuses to build
  one. Token transfers and other calls with no ETH value are unaffected.
- **`block.timestamp` is a reserved field name.** The engine reads the block
  time for a condition on that field, so an agreement cannot declare an input
  field or a stored variable with it (`ReservedFieldId`), and the SDK refuses
  to build one.
- **An action's target must be a deployed contract when its transition runs.**
  If the target address has no code, the input reverts with
  `ActionTargetHasNoCode` and the state does not move. The target may be
  deployed after the agreement is created.

### Dependencies

- `viem` moves from 2.43.2 to 2.57.20, which brings a patched `ws`. The pin is
  still exact.

### Deployments

The bundled deployment registry (`getDeploymentByChainId` and related helpers)
lists V1.1 on Linea Sepolia (chain 59141). Its record keeps the V1.0 pair it
replaced under `legacy`. The other four networks still list their V1.0
deployments, which this client cannot drive with permits: until V1.1 is
deployed there, pass a V1.1 factory address explicitly on those networks.
