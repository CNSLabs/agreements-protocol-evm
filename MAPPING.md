# Data Standard → EVM Protocol Mapping

This document highlights the **data transformations** needed to implement the agreements data standard on EVM, focusing on:

- **Type mappings**: standard variable/value types → on-chain equivalents
- **State machine mapping**: DFSM definition → EVM contract model
- **Coverage matrix**: what is **on-chain**, **off-chain**, or **delegated** (verifiers/actions)

## Type transformations (data standard → EVM)

### Variable/value types (template/schema level → on-chain representation)

| Standard type (data standard) | Where it appears | EVM-side `FieldType` | EVM storage/transport type | Encoding used | Notes / gotchas |
|---|---|---:|---|---|---|
| `string` | template `variables[*].type` | `STRING` | `bytes data` inside `DataField` / `StoredVar` | `abi.encode(string)` | Equality uses `keccak256(bytes(s))` when needed. |
| `address` | template `variables[*].type` | `ADDRESS` | `bytes` | `abi.encode(address)` | SDK auto-persists address vars so conditions can reference them. |
| `number` | template `variables[*].type` | `UINT256` (opinionated) | `bytes` | `abi.encode(uint256)` (via `BigInt(...)`) | Precision/range change: JSON number → EVM integer; decimals require scaling; no negatives. |
| `dateTime` | template `variables[*].type` | `STRING` (opinionated) | `bytes` | `abi.encode(string)` | Stored as ISO string; no native datetime ops on-chain. |

### Protocol-specific “extended” types (used by EVM protocol JSON)

| Protocol JSON type | EVM-side `FieldType` | Encoding | Why it exists |
|---|---:|---|---|
| `signature` | `STRING` | `abi.encode(string)` | Carries proof/signature data; engine doesn’t interpret without verifiers. |
| `txHash` | `BYTES32` | `abi.encode(bytes32)` | Efficient tx hash storage/compare. |
| `bool` | `BOOL` | `abi.encode(bool)` | Boolean flags/acknowledgements. |
| `bytes32` | `BYTES32` | `abi.encode(bytes32)` | Native hash/id type. |

### Identifier normalization (names → on-chain keys)

| Standard concept | Standard type | EVM type | Transformation |
|---|---|---|---|
| State key (`"AWAITING_SIGNATURES"`, etc.) | `string` | `bytes32` | `keccak256(stringToHex(stateName))` |
| Input key (`"grantorAccept"`, etc.) | `string` | `bytes32` | `keccak256(stringToHex(inputName))` |
| Field key / variable name (`"grantorAddress"`) | `string` | `bytes32` | `keccak256(stringToHex(fieldName))` |

### Validation/type constraints (schema validation → on-chain predicates)

| Standard validation | Applies to | On-chain equivalent | Encoding / notes |
|---|---|---|---|
| `required` | all types | `InputFieldDef.required = true/false` | Required fields revert when missing. Optional fields may be omitted, but if present they are still decoded and validated. |
| `minLength`, `maxLength` | string | `STRING_MIN_LENGTH`, `STRING_MAX_LENGTH` | `bytesArg = abi.encode(uint256)` threshold. |
| `min`, `max` | number/uint256 | `UINT_GTE_CONST`, `UINT_LTE_CONST` | `bytesArg = abi.encode(uint256)` bound. |
| `pattern` (regex) | string | not supported | Must be checked off-chain or via verifier. |
| `step` | number/uint256 | not supported | Must be checked off-chain or via verifier. |

### “Document” representation (whole agreement JSON)

| Standard artifact | EVM representation | Transformation | Gotcha |
|---|---|---|---|
| Full agreement JSON | `docUri: string`, `docHash: bytes32` | `docHash = keccak256(stringToHex(JSON.stringify(agreement)))` | Canonicalization risk: serialization differences change the hash. |

## State machine mapping (DFSM → EVM counterpart)

### Representation mapping (types)

| DFSM (data standard) | Type | EVM counterpart | Type | Transformation |
|---|---|---|---|---|
| `states` keys | `string` | `initialState`, `currentState`, `Transition.fromState/toState` | `bytes32` | `keccak256(stringToHex(stateName))` |
| `inputs` keys | `string` | `InputDef.id`, `Transition.inputId` | `bytes32` | `keccak256(stringToHex(inputName))` |
| input “fields” (via `inputs[*].data`) | object shape | `InputFieldDef[]` + runtime `DataField[] payload` | struct arrays | Variable name → `bytes32 fieldId`; value ABI-encoded into `bytes data`. |
| transition condition `type: "isValid"` | semantic predicate | `Condition[]` + optional external verifiers | `Op` enum + `IInputVerifier` | “isValid VC” becomes typed checks + pluggable verifiers. |

### Operational mapping (supported operations)

| DFSM operation (conceptual) | EVM operation | What it does |
|---|---|---|
| Instantiate execution model at initial state | `AgreementEngine.initialize(...)` (via factory) | Stores `docUri/docHash`, sets `currentState`, stores input defs/transitions/init vars/verifiers/actions. |
| Provide an input, evaluate conditions, transition | `submitInput(inputId, payload)` | Decode/validate/persist/condition-check/verify, apply `(currentState,inputId)->toState`, run action atomically. |
| Relayed submission on behalf of signer | `submitInputWithPermit(...)` | Same as `submitInput` but signer is authenticated by permit; sender conditions check signer. |
| Validate “issuer” of an input | `Op.SENDER_EQ_VAR_ADDRESS` for one address-var ref, or `Op.SENDER_IN_ALLOWED_ADDRESSES` for a list of address-var refs and/or literal addresses (both compiled from `inputDef.issuer`) | Enforces tx sender (or permit signer) matches one allowed address. |
| Add richer validity checks | verifier registry + `InputDef.verifierKeys[]` + `IInputVerifier.verify(...)` | Extension point for VC/proof verification etc. |
| Execute side effects on transition | `ActionInit[]` at initialization | Atomic “do X” alongside the transition (e.g., token transfer). |

### Condition language mapping (what’s supported on-chain)

| Category | Supported ops | What this means for the standard |
|---|---|---|
| Strings | min/max length; equals const; equals stored var | Basic shape + equality; no regex/pattern matching. |
| Integers (`uint256`) | eq/gt/gte/lt/lte vs const or stored var | Standard `number` must be treated as integer. |
| Addresses | equals const; equals stored var | Role/participant checks. |
| Sender | sender equals stored address var; sender in allowed address set | Encodes “who is allowed to submit” (or who authorized via permit). |

## Coverage matrix (DFSM → EVM)

This matrix enumerates DFSM surface area and shows what is:

- **On-chain**: represented/enforced directly by `AgreementEngine`/`AgreementFactory`
- **Off-chain**: kept in `docUri` content / client logic
- **Delegated**: enforced by **verifiers** (`IInputVerifier`) and/or **actions** (`ActionInit`)

| DFSM field / concept | On-chain coverage | Off-chain coverage | Delegated coverage (verifiers/actions) | Notes |
|---|---|---|---|---|
| `states` (definitions: name/description) | Stored only as `bytes32` identifiers (`initialState`, `currentState`, `Transition.*State`) | Full human-readable state metadata stays in the document at `docUri` | N/A | EVM does not store state “descriptions”; only identifiers + current state. |
| `states[*].isInitial` | Represented via `initialState` set at initialization | DFSM flag itself remains in document | N/A | Mapping picks exactly one initial state string and hashes it. |
| `states[*].initialParams` | Not represented as a “state-local bag” | Source-of-truth can remain in document | Use `initVars` (`DataField[]`) if you want these values available on-chain | EVM uses a flat key/value store (`vars`) rather than per-state params. |
| `inputs` (input identifiers, displayName, description, schema/type) | Only `inputId` (`bytes32`) + compiled `InputDef` (fields + conditions + verifier keys) | UI/display metadata, schema references, and VC typing remain in document/client | Verifiers can enforce schema/type/VC/proof semantics | The on-chain engine is input-ID-driven; “schema” is not a first-class EVM concept. |
| `inputs[*].data` (expected credentialSubject fields) | Compiled to `InputFieldDef[]` (fieldId/type/required/persist) and enforced by `_validateFields` | Original JSON field names/types stay in document; client uses them to build payloads | Verifiers can enforce cross-field constraints not expressible as ops | Payload is `DataField[]` with ABI-typed `bytes`. Optional fields skip field-local validation only when omitted. |
| `inputs[*].issuer` (who must sign) | If issuer is one address-var ref, compiled to `SENDER_EQ_VAR_ADDRESS`; if issuer is a list of address-var refs and/or literal addresses, compiled to `SENDER_IN_ALLOWED_ADDRESSES` (both check tx sender or permit signer). New templates should prefer the list form even for one signer. | Any richer “issuer DID / verificationMethod” semantics remain off-chain | Verifier can validate VC issuer/signature proofs | Engine does not natively validate W3C VC/EIP-712 proofs. |
| `transitions` (from/to/input linkage) | Stored as `Transition[]` (`bytes32 fromState,toState,inputId`) and enforced by `_findTransition` | Full DFSM doc remains at `docUri` | N/A | EVM transition function is deterministic: one `(state,input)` maps to one next state, or revert. |
| `transitions[*].conditions` (e.g., `isValid(input)`) | Realized as `Condition[]` inside `InputDef` plus `_validateConditions` | “isValid” semantics as defined by the standard remain off-chain | Verifier(s) can implement “isValid VC” (including signature checks) | EVM replaces semantic `isValid` with a fixed predicate DSL + hooks. |
| Validation rules on variables/fields (min/max, etc.) | Partially compiled into `Condition(Op, fieldId, bytesArg)` and/or `required` flag | Unsupported validations (regex/pattern/step) must be handled off-chain | Verifier can enforce unsupported validations | This is the biggest “expressivity gap” between standard validation and on-chain enforcement. |
| Side effects associated with transitions | Supported via `ActionInit[]` at initialization and executed atomically with the transition | Any non-EVM side effects are off-chain | Actions are the on-chain side-effect mechanism | This is an EVM opinion not inherent to DFSM: “transition-triggered call”. |
