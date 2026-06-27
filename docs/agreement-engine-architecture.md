# AgreementEngine — Architectural Specification

**Status:** draft. Architectural target for the new `AgreementEngine` — the existing engine, evolved into a state machine that can compose and execute onchain calls as a function of runtime state. Composable action execution is the headline new capability. Defines the shape of the changes and the rationale; does not prescribe an implementation sequence. Illustrative struct sketches are for shape, not final ABI.

---

## 1. Motivation

`AgreementEngine` today is a finite state machine whose only side effects are **static actions**: an action is a fixed `(target, value, data)` tuple, frozen at initialization, executed verbatim when a transition fires. This is sufficient for agreements whose effects are fully known at creation, and insufficient for everything else.

The limitation is structural. An agreement often needs to act on values that are not known until execution time — values held in its own storage, values supplied with the input that drives a transition, or values read from external contracts. It may also need to coordinate one or more **companion contracts** that handle concerns the state machine does not model directly (resource accounting, permissioning, escrow, and similar), driving them as the agreement progresses. None of this is expressible when call data is frozen at creation.

This specification evolves the engine into a state machine that **composes and executes calls as a function of runtime state**: it remains the canonical onchain root of an agreement and, through that composable-action capability, owns and coordinates companion contracts. The engine stays agnostic to what it calls — any external contract is reachable through the same mechanism.

## 2. What it enables

Stated abstractly, the architecture enables:

- **Runtime-substituted call arguments.** A transition can execute a call whose target and fixed-size arguments are filled in at execution time from a mix of fixed constants, stored variables, the submitted input, and external reads — anywhere on the spectrum from fully pre-baked to substituted-per-argument (see §9 for the precise boundary).
- **Coordination of companion contracts.** Because the engine can call external contracts with runtime-substituted data, it can drive companion contracts that hold concerns the state machine is poorly suited to express, while remaining the single source of behavioral truth.
- **Composition with existing onchain infrastructure.** External contracts with fixed-size argument interfaces become reachable without bespoke per-integration glue in the engine.
- **Result-sensitive progression.** An agreement's path can depend on what a prior action produced, not only on which input arrived.
- **A single, legible expression language.** Conditions, guards, effects, and call arguments all draw values from one resolution model, so tooling and readers reason about one vocabulary rather than several.
- **Evolution through consent.** An agreement can adjust aspects of itself over its lifetime through the same consented-transition mechanism that governs all its other behavior, with no privileged external operator.

## 3. Goals, non-goals, and deferred extensions

**Goals**

- Replace static action call data with a runtime value-resolution model spanning the four value origins above.
- Unify the value model across conditions, guards, effects, constraints, and action arguments.
- Decompose the monolithic engine into focused, independently reasoned modules (aligns with issues #59, #60, #63).
- Preserve the prior engine's observable semantics for legacy authoring — reproduced through the SDK's off-chain desugar into the canonical encoding — except for a small set of deliberate, named changes (the parity guarantee and its exceptions, §13).
- Keep configuration immutable after initialization except where an agreement explicitly governs itself through transitions.

**Non-goals**

- A general-purpose computation environment. The engine resolves and compares values and composes calls; it does not provide arbitrary arithmetic, iteration, or control flow beyond guarded transitions and effects.
- Domain-specific accounting or lifecycle logic. These belong in companion contracts the engine coordinates, not in the engine.
- Assembling variable-length or structured call arguments from runtime data (see §9). Such arguments are either fixed at creation or produced by a companion contract with a fixed-shape interface.
- Structural self-modification of the state graph. The architecture leaves a seam for it but does not require it.
- Off-chain concerns (authoring, negotiation, identity, semantic vocabularies). The engine is an execution target.

**Deferred extensions (designed-for, not built).** The architecture is shaped so these can be added without rework, but they are out of the initial scope: native-value (ETH) routing and the escrow/funding model it requires (§9); intra-action output chaining (§9); same-transition act-then-route branching and non-fatal calls (§7); **effects** (`SET`/`INC`/`DEC` variable mutations, §8); structural and state-graph self-governance (§12); runtime composition of variable-length/structured arguments (§9); and the remaining `STATIC_CALL` extensions — allowlisted/multi targets, FIELD-derived args inside the static call, and multi-word/dynamic return decode (§9). The bounded single-target, single-word `STATIC_CALL` itself is **built** (§9).

## 4. Module architecture

The current engine defines all enums, structs, errors, interfaces, and logic in a single contract, coupling the factory to the full contract merely for type definitions. The target structure decomposes this along the lines of issue #60, extended to the new model:

| Module | Responsibility | State |
|---|---|---|
| `AgreementTypes` | Shared enums, structs, custom errors (the data model). | none |
| `ValueLib` | The resolve/compare core — turn a value reference into bytes; compare resolved values. | none (operates on passed-in refs) |
| `ActionLib` | Compose call data, apply constraints, execute calls, decode/capture outputs (§9). | none (operates on passed-in refs) |
| `IAgreementEngine`, `IInputVerifier` | Public interface surfaces and events (issue #60). | n/a |
| `PermitVerifier` | Shared permit/auth logic (issue #63). | namespaced nonce state (§4 storage discipline) |
| `AgreementEngine` | Storage, the execution pipeline, init-time validation, self-governance, factory handoff. Delegates logic to the libraries. | all agreement state |

Legacy `Op`-encoded authoring is desugared into canonical conditions **off-chain, in the SDK** (§6); the engine has no on-chain legacy encoding or desugar module.

**Dependency shape.** `ValueLib` is foundational — conditions, guards, effects, and actions all resolve and compare through it. `ActionLib` depends on `ValueLib` and the types; the engine depends on both. Once `ValueLib`'s interface is fixed, the modules above it can be developed against a stable surface independently.

**Storage discipline (EIP-1167 constraint).** Agreements are deployed as minimal-proxy clones, so the engine's storage layout is slot-sensitive: reordering or introducing inherited storage shifts slots for all clones, and clones are not upgradeable. Therefore: logic lives in **stateless libraries that operate on storage references passed in by the engine**; the engine owns storage layout; any state that must be inherited (e.g. `PermitVerifier`'s nonces, per issue #63) uses **namespaced storage slots (ERC-7201)** rather than sequential inherited slots; and each implementation version carries a **mechanically verified storage-layout diff** (strictly append-only) plus explicit implementation/factory versioning.

The concrete rules the codebase enforces (R3):

- **Why append-only matters — and for which clones.** A slot collision corrupts a clone only when that clone can ever *execute newer implementation logic* against an *older* layout. Today's clones are EIP-1167 minimal proxies hard-bound to one immutable implementation at instantiation: they never see a different layout, so for them append-only is a **conservative forward-discipline**, not the thing that protects already-deployed agreements. (Concretely, the frozen legacy reference's later slots shifted when R1/R2 appended `canonicalConditions`; that shift is **harmless** — no clone bridges the two implementations.) The discipline becomes load-bearing the moment any clone *can* run newer logic — an upgradeable-proxy variant, or any scheme that re-points a clone at a new implementation. We hold the line now so that option stays open and future spikes (R4/R5/R8) can't foreclose it silently.
- **Append-only layout, mechanically enforced over the full type graph.** An implementation's storage layout may only evolve by *appending* new top-level state at strictly higher slots. No existing variable's slot/offset/type may change, **and no change inside a reachable struct, mapping value, or array element** (member reorder, packed-offset repack, member insertion, nested type change) is allowed either. This is enforced by a committed snapshot (`contracts/test/unit/engine-storage-layout.snapshot.json`) that captures the **whole nested type graph** (struct members, mapping key/value, array base — with solc's build-local type ids normalized away) and is diffed against the compiler's `storageLayout` on every test run (`engine-storage-layout.test.ts`); any non-append-only change fails the suite. Slots are compared as bigints, so namespaced (256-bit) slots never lose precision. Regenerating the snapshot is deliberate (`UPDATE_LAYOUT_SNAPSHOT=1`) and **gated**: the update path re-runs the diff and refuses to write a non-append-only mutation (a broken layout can never become the baseline), and refuses to run under CI without an explicit override.
- **The rule is conservative: strictly-higher-slot only.** The guardrail recognizes exactly one append shape — a new top-level variable at a slot strictly above the current max. It does **not** model reserved storage gaps (`uint256[N] __gap`) or packing a new field into a free byte of an existing slot; *consuming* a gap or a partial slot would require extending the guardrail before it could be blessed. This is intentional — the simplest rule that cannot be evaded silently.
- **Namespaced (ERC-7201) storage for inherited state.** Any future base that owns its own state — notably the `PermitVerifier` extraction (issue #63), whose `nonces` mapping currently lives as an engine-owned slot — must place that state in an **ERC-7201 namespaced slot**, not a sequential inherited slot. Sequential inheritance *prepends* a base's storage and shifts every engine slot below it (fatal once any clone can run newer logic, a footgun even for fresh clones if inheritance order drifts); a namespaced slot is collision-resistant and order-independent, so extracting the base does not perturb the engine's append-only layout. Note that **manual ERC-7201 namespaced storage does not appear in solc's top-level `storageLayout`** (the slot is computed in assembly, not declared as a state variable), so this guardrail cannot see it — a dedicated namespaced-storage lint attaches to the (deferred) `PermitVerifier` extraction.
- **Owner-less sentinel respects the layout discipline (R8, done).** R8 replaces the old `owner == address(0)` not-initialized sentinel with OpenZeppelin `Initializable`'s state (`_getInitializedVersion()`). Because OZ v5 `Initializable` keeps its `_initialized` counter in an **ERC-7201 namespaced slot** (not a sequential inherited slot), the sentinel change adds no top-level state and does not perturb the engine's layout at all — the `owner` slot is untouched (no reorder, no in-place re-type), so the append-only guardrail passes without even needing an append. (The guardrail still catches the wrong move: replacing `owner` in place would flag as a break.)
- **solc-bump-for-`layout at` is deferred to the `PermitVerifier` extraction.** A solc bump (~0.8.29) makes ERC-7201 namespaced storage a first-class `layout at` language feature instead of hand-rolled assembly slot math. That decision **attaches to the moment inherited state is actually extracted** (the `PermitVerifier` base, #63), not to this spike — the engine stays on **0.8.24**, and until the bump, any namespaced storage is done via manual ERC-7201 assembly (which works on 0.8.24). Bumping recompiles the frozen legacy reference and shifts the build/gas/audit baseline, so it is made deliberately at extraction time, not preemptively.

## 5. The value-resolution core

A single primitive replaces the per-type condition evaluators: a **value reference** that declares where a value comes from, resolved to concrete bytes at execution time.

```
enum ValueSource { CONST, VAR, FIELD, FIELD_LENGTH, AUTH_SIGNER, CALLER, SELF, NOW, STATIC_CALL }
enum CmpOp       { EQ, NEQ, GT, GTE, LT, LTE, IN, NOT_IN }

struct ValueRef  { ValueSource source; FieldType vType; bytes data; }
struct Condition { ValueRef left; CmpOp op; ValueRef[] right; }  // right: 1 scalar, or N for IN / NOT_IN
```

- `CONST` — a literal fixed at creation.
- `VAR` — a stored agreement variable (read from the variable store, §11).
- `FIELD` / `FIELD_LENGTH` — a field of the submitted input, or its byte length.
- `AUTH_SIGNER` — the **authorizing** party: the permit signer for a relayed submission, otherwise `msg.sender`. This is the identity used for authorization checks (it is what the current engine's sender conditions check, and is required for permit parity).
- `CALLER` — the **actual** `msg.sender` (the relayer in the permit case).
- `SELF` — the agreement's own address (as a value, not a call to itself).
- `NOW` — the current block timestamp.
- `STATIC_CALL` — the result of a bounded read-only external call (built; one canonical word, fixed target/selector, gas-capped, return-bomb-safe — see §9).

`ValueLib` exposes two operations: **resolve** a `ValueRef` to `(FieldType, bytes)` against the current input fields and variable store, and **check** a `Condition` by resolving both sides and applying the `CmpOp`. Per-type comparison legality is asserted at evaluation. This one path serves input validation, transition guards, action constraints, and effect amounts — there is no separate evaluator per use site.

Splitting identity into `AUTH_SIGNER` and `CALLER` replaces the single coarse "sender" notion: authorization is expressed against the signer (correct under relayed/permit submission), while the relayer remains separately addressable.

## 6. Conditions

Input conditions, guards, and constraints are expressed as a canonical `Condition` over `ValueRef`s — **there is no legacy encoding on-chain**. The engine speaks exactly one condition model, and the value-resolution core (§5) evaluates it everywhere (input validation, transition guards, action constraints).

**Legacy authoring is desugared off-chain, in the SDK.** The prior engine encodes input conditions as an `Op` enum (a `{TYPE}_{COMPARISON}_{SOURCE}` matrix); the new engine expresses the same meaning as a canonical `Condition` over `ValueRef`s. The legacy→canonical translation lives **off-chain, in the SDK** — where authoring is already compiled into the on-chain shape. The SDK maps each legacy operation to one canonical `(left, op, right)` — e.g. a minimum-length check becomes `FIELD_LENGTH GTE CONST`; a sender-equality check becomes `AUTH_SIGNER EQ …`; a sender-membership check becomes `AUTH_SIGNER IN CONST-set` — and submits canonical conditions at initialization. The engine ingests and evaluates only canonical `Condition`s; it has **no `Op` enum and no on-chain desugar**, so it carries a single encoding. The parity guarantee (§13) holds across the *SDK desugar + canonical engine*.

**Presence-aware conditions (`IF_PRESENT`).** The canonical `Condition` carries a `skipIfAbsent` flag. A condition marked `IF_PRESENT` is **skipped** when its target field is absent and **evaluated** when present; a canonical condition **not** so marked **reverts** (`FieldAbsent`) when its target field is absent — the explicit-over-silent default. The SDK desugar maps a legacy condition on an **optional** field to `IF_PRESENT` (faithfully reproducing legacy skip-if-absent) and a condition on a required field without the flag (so it still reverts when absent). The absent-optional-field axis is therefore at **full legacy parity** — not a deviation.

**Intended semantic deviation from the prior engine** (the named exception to parity, §13): a **self-referential persisted-field `VAR` condition is rejected** — a condition comparing a field's value against the same variable that field is auto-persisted into (a degenerate comparison: persist-before-validate writes the field into that variable before the condition runs, so it would always compare equal). The meaningful "new-versus-prior" comparison is expressed by not auto-persisting and committing the new value with an effect after the condition passes. This is the only deliberate deviation from legacy behavior.

## 7. Transitions and guards

Transitions are **guarded** by the input's conditions. For a `(currentState, inputId)`, the engine evaluates that input's canonical `Condition`s through `ValueLib` — over input fields, stored variables, the authorizing identity, time, and (constrained) external reads — and, if they pass, fires the single transition bound to that `(fromState, inputId)`. An input with no conditions is unconditional. Branching to different destinations is expressed by **distinct inputs** (each with its own guards) plus the result-sensitive pattern below — not by engine-side selection among several candidate transitions for one input. (Engine-side ordered candidate selection — multiple transitions per `(fromState, inputId)`, the first whose guards pass — is a deferred extension; the built model is one transition per `(fromState, inputId)`.)

**Result-sensitive progression** is expressed without inverting the pipeline. An action may persist a value it produced into a stored variable (§9); a subsequent transition then branches on that variable through ordinary guards. Progression that depends on an action's outcome is therefore modelled as an explicit intermediate state followed by a guarded transition. (Resolving an action's result and branching on it within a single transition — act-then-route, with non-fatal calls — is a deferred extension.)

## 8. Effects (deferred extension)

**Status: designed-for, not built.** Effects are specified here but intentionally deferred from the initial scope (rationale below); the architecture and the taint analysis (§13) are already shaped to accept them.

An effect is an internal mutation of a stored variable applied as part of a transition:

```
enum EffectOp { SET, INC, DEC }   // INC / DEC on numeric variables
struct Effect { EffectOp op; bytes32 targetVar; ValueRef value; }
```

Effects would resolve their operand through `ValueLib` and write to the variable store through the preview/commit overlay they would introduce (§11). They are the internal counterpart to actions: an effect mutates the engine's own state, an action calls outward.

**Why deferred.** Effects are orthogonal to the project's core goal of composable, runtime-composed *action* execution — that goal is served entirely by the action engine (§9), which calls outward; effects only mutate the engine's own variables and drive nothing external. Their unique value is state-machine expressiveness — counters (`INC`/`DEC`, e.g. looping multi-milestone patterns) and conditional/`CONST` `SET`s — which neither the headline goal nor the trust-zones target case requires. (Simple "amend a value" is already covered by a persisted input field; capturing an external result into a variable is the action-output `PERSIST` path of §9, not an effect.) Adding them later is low-lift, low-risk: they reuse `ValueLib` resolution and the taint fixpoint — which already accounts for the transitive `var←var` write an effect `SET` would introduce — and would introduce the preview/commit overlay (§11).

## 9. The action engine

An action is a sequence of calls bound to a transition. Each call composes its data at execution time and may carry pre-execution constraints and typed output capture.

The composition model: **the engine fills in individual fixed-size argument values at execution time.** Any argument slot holding an address, amount, boolean, or hash can be drawn live from constants, stored variables, the submitted input, or an external read. **Variable-length or structured arguments (text, byte blobs, lists, tuples) are fixed at creation**; when an agreement needs those assembled from live data, it drives a **companion contract** that exposes a simple, fixed-shape interface and absorbs that complexity. Plainly: the engine composes the simple calls itself and delegates the complex ones to purpose-built contracts it controls.

```
struct Action { Call[] calls; }

struct Call {
    ValueRef     target;       // resolved call target; MUST NOT resolve to address(this)
    bytes4       selector;     // fixed at creation; never substitutable
    ArgSlot[]    args;         // ordered fixed-size (word) argument slots
    Condition[]  constraints;  // asserted on resolved values before the call
    Output[]     outputs;      // typed return-data capture
}

// A slot is either a baked constant word or a runtime substitution.
struct ArgSlot { bool dynamic; bytes32 constWord; ValueRef value; }

struct Output {
    uint256   returnIndex;     // which fixed-size return word
    FieldType outType;         // how to decode it
    bytes32   targetVar;       // where to persist it
}
```

**Composition by typed argument index, not raw offset.** Calls are composed as `selector + encoded fixed-size argument words`, substituting by **argument index**. The engine computes layout itself and enforces: the selector is never substitutable; substitutions land only on fixed-size (word) argument slots; no two substitutions overlap; each substituted value is canonically encoded for its declared type; all writes are bounds-checked. There is no raw-offset byte-write into call data.

**Target routing, never self.** The target is resolvable (fixed, or drawn from a variable/input/read), but a resolved target equal to `address(this)` is rejected — the engine never calls itself. Native-value (ETH) routing is **not** in the base model (no funding/escrow accounting exists for it); it is a deferred extension.

**Constraints.** Before a call executes, its constraints are asserted against resolved values. Constraints reuse `Condition`/`ValueLib` and are the primary runtime guardrail bounding input-derived values; init-time validation makes them mandatory where values are tainted (§13).

**Multiple calls.** An action may contain several independent calls executed in order. Carrying an earlier call's output into a later call's arguments within the same action (intra-action chaining, via an in-memory captured-output reference) is a deferred extension.

**Typed outputs.** A call may capture a fixed-size return word, **decode it to a declared type**, validate it canonically (with a bounded return size and explicit failure behavior for malformed data), and persist it to a variable. Captures land in an **action-output overlay** and commit only after **all** calls in the action have executed and all output decodes have validated — so a partially-executed action never leaves committed output. This makes external results available to later transitions' guards (§7).

**Failure.** Calls are atomic: a failed call reverts the whole transition. Surviving a failed call to branch on it (non-fatal calls) is a deferred extension.

**Bounded `STATIC_CALL` (built).** `STATIC_CALL` is a value source: a bounded read-only external read that resolves to one canonical word of the declared type, usable as a guard/constraint operand or as an action call's target or argument value. The bounds are deliberate and narrow. The target is a **fixed `CONST` target** with a **fixed selector and pre-baked `CONST` argument bytes** (calldata is `selector ++ args`; no runtime-substituted args inside the static call). A **gas stipend** is forwarded under `0 < gas <= MAX_STATIC_CALL_GAS` (100k) so a griefing target cannot starve the outer transition; the returndata copy is capped at `maxReturnBytes == 32` (only the first word is ever consulted, so a return-bomb cannot blow up memory). The first 32-byte word is decoded canonically through the shared `ValueLib.canonicalWord` (the same per-type word decode every other source uses), so a `STATIC_CALL` operand cannot inject a non-canonical value into a downstream comparison or composition. The word type must be a fixed-size type (no `STRING`/`BYTES` return). A resolved target equal to `address(this)` is rejected by a runtime guard (no self-target). Two **fail modes** are defined: `REVERT` (the default) aborts resolution on a failed read (a revert, an out-of-stipend, or a return shorter than 32 bytes); `ABSENT` makes a *failing left operand of a condition* behave like an absent `IF_PRESENT` field — the condition is skipped rather than reverting, so a griefing read in one guard candidate cannot block evaluation of later candidates. The spec is structurally validated at init (`MalformedStaticCallSpec` on a bad target, gas bound, return cap, or fail mode); a non-left, non-`ABSENT`-skipped `STATIC_CALL` that fails always reverts (`StaticCallFailed`), since an argument or target must resolve to a concrete value. `STATIC_CALL` is a **direct taint source** (§13): it reads untrusted external data, so a `STATIC_CALL`-derived target needs a membership allowlist and a `STATIC_CALL`-derived argument needs a bound, exactly as a submitted field would.

**Resolve-once cache (built).** Because a `STATIC_CALL` value can serve both as a constraint operand (checked) and as the target or an argument of the same call (used), a naive resolve-per-reference would re-read the external value once per reference — opening a TOCTOU split where a value-splitting target (one that observes the cold/warm access-gas difference between reads, or otherwise returns different words on successive reads) could pass the allowlist on the checked read and divert the call on the used read. The engine closes this with a **per-action-call in-memory cache**: before constraints are checked or arguments resolved, `ActionLib` prewarms the cache over every distinct `STATIC_CALL` reference reachable in the call (its target, every argument value, and every constraint operand), performing each distinct read **exactly once** and memoizing the raw return word keyed by the spec. Every later resolution within that call returns the memoized word, so the value a constraint checks is byte-identical to the value spliced into the call. The cache is fresh per call (so distinct calls never share a memoized read), and the raw word — not a decoded value — is cached, so two references with the same spec but different declared decode types share the single read and each decodes independently. The guard/condition path uses an empty cache (resolve-once-and-immediately-compare; no check-vs-use split exists there).

**`STATIC_CALL` deferred extensions.** Allowlisted or multiple candidate targets, FIELD-derived (runtime-substituted) arguments inside the static call, and multi-word or dynamic (`STRING`/`BYTES`) return decode are out of the initial scope; the single-target, single-word read above is the built subset.

## 10. Storage and type system

- The uniform variable store — `mapping(bytes32 => (FieldType, bytes))` — is retained. A typed per-type store is not adopted.
- `BYTES` is added to `FieldType` to carry opaque payloads to companion contracts.
- **Canonical encoding rules.** Each `FieldType` has a single canonical stored encoding, validated on **every** write path (field persistence, effects, and output capture alike), with bounded length for dynamic types (`BYTES`/string). The model distinguishes a value's **compare representation** (how `ValueLib` reads and compares it) from its **call-word encoding** (how it is placed into a fixed-size argument slot); both are defined per type, and writes from new sources (`STATIC_CALL` results, captured outputs, raw `BYTES`) are validated against the canonical form before storage.
- Persisted input fields are written **directly** to the variable store before conditions are evaluated (persist-before-validate); atomicity comes from EVM revert — any failed check reverts the whole submission and rolls the writes back. A preview/commit overlay that evaluates not-yet-committed values in memory is the deferred generalization effects would introduce (§8); today only **action outputs** stage in an overlay and commit after success (§9).

## 11. Execution pipeline

`submitInput` proceeds as follows. Actions run last; their effects on the engine's storage (output capture) commit only after all calls succeed, and submission is non-reentrant (§13).

1. Verify the agreement is initialized.
2. Decode the input payload into fields; structurally validate (required fields present, types decodable; a canonical condition on an absent field reverts unless it is marked `IF_PRESENT`, in which case it is skipped — §6).
3. Persist input fields flagged `persist = true` **directly** to the variable store (before condition evaluation). Atomicity is by EVM revert: any later check that fails reverts the whole `submitInput`, rolling these writes back.
4. Evaluate input conditions through `ValueLib` against the decoded fields and the variable store (which now includes the just-persisted fields).
5. Run verifiers (view-only).
6. Select the transition: in the `(currentState, inputId)` bucket, the first candidate whose guards pass — yielding the destination state and the bound action.
7. *(Reserved — deferred.)* Apply any effects (§8) and any self-governing reconfiguration as internal effects (§12, a stretch capability). Neither is in the built scope; when effects land they introduce the preview/commit overlay so values written mid-submission are evaluated before commit (today step 3 writes directly and atomicity is by revert).
8. Set `currentState` to the destination.
9. Execute the action: for each call, resolve target (≠ self) and arguments, assert constraints, execute, decode outputs into an action-output overlay; after all calls succeed and all outputs validate, commit the output overlay.
10. Emit events.

`STATIC_CALL` resolution (used in guards, constraints, and arguments) is bounded (§9): a fixed `CONST` target and selector with pre-baked args, a gas stipend (`0 < gas <= 100k`), a 32-byte return cap, a canonical single-word decoder, and an explicit fail mode — so a reverting or griefing external read in one guard candidate cannot block evaluation of later candidates (the `ABSENT` fail mode), and malformed return data cannot corrupt downstream comparisons or composition. On the action path the read is performed once and memoized in the per-call resolve-once cache (§9), so the value a constraint checks is the value the call uses.

## 12. Owner-less governance

The engine is **owner-less (built, R8)**. The privileged-operator role is removed: there is no post-init configuration surface — no privileged mutators, no post-init verifier or action registration. Configuration (verifiers, actions, conditions, transitions) is fixed at initialization. The principled exception remains *immutable except through the state machine*: an agreement may govern aspects of itself through consented transitions, where the consent gate for any change is the transition that performs it (its input, conditions, and verifiers).

What R8 actually changed:

- **The init sentinel is OZ `Initializable`'s state, not `owner`.** "Is this clone initialized?" is now read from OpenZeppelin's `Initializable` (`_getInitializedVersion() != 0`), set by the `initializer` modifier on initialization — not from the prior `owner == address(0)` check. For clones this is behavior-equivalent (an init-time `OwnerZero` guard rejected a zero owner, so an initialized clone always had a non-zero owner under the old check) and reverts the same `NotInitialized`.
- **`owner` is a powerless immutable identity.** It is still set once at init and exposed publicly, but it is never read by any access control or sentinel; it remains only for provenance/observability and to preserve the init ABI and clone storage layout.
- **Verifiers are registered at init.** Initialization takes a `VerifierReg[]` (key → verifier contract) and stores it once; `verifierRegistry` has exactly one writer (`_storeVerifiers`, init-only) and no post-init registration entrypoint. The removed post-init `registerVerifier` / `registerAction` mutators — and their `NotOwner` gate — no longer exist.

**Self-governance (deferred stretch).** Reconfiguration through transitions is performed exclusively as **internal effects** in the commit phase — never as a self-targeted external call (the action engine cannot call `address(this)` at all, §9, so there is no `onlySelf` external surface to reach governance through the generic call mechanism). It rides on effects (§8), which are deferred, so it is not in the built scope:

- **Parameter governance** requires no new mechanism: because actions resolve values from variables at runtime, and effects can set variables on a consented transition, amending a value (an amount, a recipient, a deadline) is just an effect that updates a variable; the next action reads the new value.
- **Structural governance** — rebinding a verifier to a different contract, or changing an action's target or selector — would be a new internal-effect reconfiguration applied during the commit phase, reusing the initialization-time validators so the same invariants hold (no back door). State-graph self-mutation (adding/removing/retargeting transitions and states) is the highest-risk form and remains a deferred extension; the validation-reuse seam is designed to accommodate it later.

In all cases the self-governance surface itself would be fixed at initialization (no meta-reconfiguration), and agreement identity (document hash, participant identities) is immutable.

## 13. Security model and invariants

**Threat model.** The engine defends against a party who, by submitting an input, attempts to subvert the calls the agreement was built to make. It does not attempt to protect parties from an agreement they consented to; what a well-formed agreement is allowed to do is a concern of the layers that author and negotiate it. The sensitive value origin is the submitted input, the bounded external read (`STATIC_CALL`, which returns untrusted external data), and any variable populated from either — "tainted" values.

**Immutability after init.** Actions, transitions, conditions, constraints, and verifiers are fixed at initialization and not reconfigurable out-of-band — there is no post-init configuration surface at all (owner-less, §12). Only the *values* inside fixed call shapes vary at runtime; the deferred self-governance stretch would let configuration change through consented transitions (§12), but it is not built, so today's config is strictly init-fixed. This is consistent with the existing deployment model: the factory is stable and implementations are versioned, so an agreement is bound to an implementation at instantiation and existing agreements are unaffected by later implementations.

**Mandatory constraints on tainted call components (enforced at init).** It is not enough to *offer* constraints — the architecture **requires** them. At `initialize`, the engine performs a taint analysis over every action: any call component that can be influenced by the submitted input or by an input-derived variable must be bounded by a constraint, or the agreement is rejected at creation. Concretely: an input-derived **target** requires a membership (allowlist) constraint; an input-derived **argument** requires a range or membership constraint tied to that argument. A missing constraint is a creation-time error, not a latent subversion path.

**Default trust boundary within a call.** A call's `target` and `selector` are author-fixed by default, so a submitting party cannot redirect the agreement to a different contract or function. Arguments may be input-derived but only when constraint-bound (above). Input-derived targets are a deliberate, constrained opt-in (allowlist-bound), off the default path.

**No self-calls.** The action engine rejects any call whose resolved target is `address(this)` (and likewise for `STATIC_CALL` targets). Because the engine is owner-less with no post-init configuration surface (§12), there is no `onlySelf` external surface and no path to reconfiguration, input submission, or initialization through the generic call mechanism in the first place; the no-self-call guard keeps that closed for any future internal-effect governance seam too.

**Bounded evaluation (enforced at init, done).** Configuration arrays are capped at initialization — `ConfigCapExceeded(what, got, max)` on an over-cap config — so a config author cannot force unbounded submit-time work on a counterparty: input-defs and transitions ≤ 256; fields and conditions per input ≤ 32; verifier keys per input ≤ 16; `IN`-set size ≤ 64; dynamic (`BYTES`/`STRING`) value length ≤ 4096; and per action calls ≤ 16, args ≤ 16, constraints ≤ 32, outputs ≤ 8. (There is one transition per `(fromState, inputId)` — engine-side candidate selection is deferred, §7 — so there is no candidate-count to cap.)

**Reentrancy.** Input submission is non-reentrant. External calls run last; the only engine-storage write that follows them — output capture — is committed atomically from the action-output overlay after all calls complete, under the non-reentrancy guard, so the post-call write is not an exploitable interaction-then-effect window.

**R7 — mandatory init-time taint enforcement (done).** The "tainted-and-unconstrained is unconstructable" invariant is now **enforced at initialization**. A taint analysis runs over the whole static config (the composable actions and the agreement's input-defs/outputs) and reverts the creation if any submitter-influenceable call component lacks a real bound. It is pure and init-only — no cost on the `submitInput` hot path. The model:

- *Direct taint sources.* A `ValueRef` is directly tainted when its source is `FIELD`, `FIELD_LENGTH`, `CALLER`, `AUTH_SIGNER`, or `STATIC_CALL` — anything a submitting party (or the relayer/signer) can set, plus the bounded external read (`STATIC_CALL` (R6) reads untrusted external data, so it joins the set; a `STATIC_CALL`-derived target needs a membership allowlist and a `STATIC_CALL`-derived argument needs a bound, exactly as a submitted field would). `CONST`, `SELF`, and `NOW` are not tainted.
- *Var taint propagation (option B, a fixpoint over the static config).* A stored variable is tainted if a tainted value can be written into it. The writers that exist today are an `InputFieldDef` with `persist = true` (a submitted `FIELD` is written into its var) and an action `Output` (an external return is captured into its target var) — both unconditional taint seeds. The analysis takes the persisted field ids as seeds and unions in every action's output target vars, so a var holding a captured return (or an auto-persisted field) is tainted wherever it is later read — including across calls and actions. A transitive var←var write chain (e.g. a future effect `SET`-ing a tainted var into another var) is taken to a fixpoint by `computeTaintedVars` (implemented and unit-tested). Effects are deferred (§8), so no such chain exists in the current config and `computeTaintedVars` is not yet on the init path; wiring it into the mandatory init analysis is a **required** step **when effects land**, not an optional one — an effect that writes a tainted value into a var must extend the tainted-var set before the bound check runs, or the guarantee is unsound.
- *The requirement (reject at init).* A tainted **target** must be pinned by an `IN` membership constraint whose left operand is exactly that target and whose set operands are **all non-tainted** (CONST / non-tainted author var / SELF) — missing → `UnconstrainedTaintedTarget`. Each tainted dynamic **argument** must be **fully** bounded by constraints whose left operand is exactly that argument's value, over **non-tainted** operands, in one of three shapes: an `EQ` (a single point), an `IN` (a membership set), or a **two-sided range** — at least one upper op (`LTE`/`LT`) *and* at least one lower op (`GTE`/`GT`) on the same argument. Missing → `UnconstrainedTaintedArg`. A **lone one-sided ordered op does not bound** — `amount GTE 1` leaves `amount` unbounded above, so a huge `transferFrom` amount would slip through, and the engine cannot infer which side is security-critical for an arbitrary argument; one-sided is therefore unsound and rejected. `NEQ` / `NOT_IN` never bound (they exclude points, not constrain a range).
- *Bound-against-non-tainted is load-bearing.* A constraint that bounds a tainted value against **another tainted value** is not a real bound and is rejected — e.g. `recipient EQ CALLER` does not count (`CALLER` is tainted), and `amount LTE FIELD(other)` does not count (the RHS is a submitter-set field). The bounding operand(s) must be non-tainted.
- *Soundness simplification — the exact-`ValueRef`-match false-reject cliff.* The "this constraint bounds this exact component" match is by **exact `ValueRef` equality** (source + type + `keccak256(data)`) between a constraint's left operand and the component's ref. This is a sound subset: it never accepts a weak bound, but it is conservative — a bound expressed through an equivalent-but-differently-shaped ref is **not** recognized and the agreement is rejected (a false reject, never a false accept). Authoring consequence: a bounding constraint must reference the component with the **same ref shape** the call site uses. Concretely, a constraint on `FIELD(id)` does **not** credit an argument that reads `VAR(id)` after that field is persisted — even though both resolve to the same value at runtime, they are different refs (`FIELD` vs `VAR`), so the author must bound the argument's **exact** ref (here, `VAR(id)`). A later usability refinement could teach the matcher a `FIELD(id) ↔ VAR(id)` canonical alias (a persisted field and its var are the same value), removing this particular cliff; it is intentionally out of scope here to keep the matcher provably sound and simple. The heavy nested-struct analysis lives in the linked `ActionLib` (`validateActionsTaint`), keeping the engine clone under the code-size limit.

**R8 — owner-less governance (done).** The post-init owner-mutator gap this section previously flagged is **closed**: the `onlyOwner` `registerVerifier` / `registerAction` mutators (and the `NotOwner` gate) are **removed**. There is no post-init configuration surface. Verifiers are registered once at initialization from a `VerifierReg[]`; actions, transitions, and conditions are fixed at init; the init sentinel is OZ `Initializable`'s state, not `owner`; and `owner` is retained only as a powerless immutable identity (§12). An agreement's post-init configuration is therefore no longer "only as trustworthy as its owner" — it is immutable except through consented transitions.

**Invariants.**

- *Canonical-only on-chain* — the engine has no legacy condition encoding; legacy authoring is desugared off-chain by the SDK into canonical conditions (§6).
- *Parity (with one named exception)* — legacy authoring desugared by the SDK and run through the canonical engine reproduces the prior engine's observable accept/reject behavior, except for the single deliberate deviation in §6 (self-referential persisted-field `VAR` conditions are rejected). The absent-optional-field axis is at full parity via the SDK's `IF_PRESENT` desugar. This guarantee makes the value-model change safe; it is validated as an SDK-desugar-to-canonical equivalence against the frozen legacy reference (§15).
- *No self-call* — no executed call (or static read) targets `address(this)`.
- *Tainted-and-unconstrained is unconstructable* — an agreement with an input-derived call component lacking a bounding constraint cannot be initialized.
- *Storage-layout stability* — clone storage layout is owned by the engine, uses namespaced slots for inherited state, and changes only via a verified append-only diff (§4).

## 14. Delta versus the current engine

| Area | Current | Target |
|---|---|---|
| Value model | per-type `Op` evaluators; `*_CONST` / `*_VAR` split; single sender notion | one `ValueRef` + `CmpOp` core (canonical-only on-chain); legacy `Op` desugared off-chain by the SDK; identity split into `AUTH_SIGNER` / `CALLER`; bounded `STATIC_CALL` source (built) with a per-call resolve-once cache |
| Conditions | input-level only; absent-optional-field skipped; self-ref allowed | input conditions + guards + constraints, all canonical; `IF_PRESENT` skips on absent / canonical default reverts on absent (legacy optional-field parity via the SDK desugar); self-ref rejected |
| Transitions | one destination per `(fromState, inputId)`, linear scan | one transition per `(fromState, inputId)`, gated by the input's guards; branching via distinct inputs + the result-var pattern (engine-side candidate selection deferred) |
| Effects | none | `SET` / `INC` / `DEC` on variables — **deferred extension (§8), designed but not built** |
| Actions | static `(target, value, data)`, one per transition | composed `Call[]`: resolvable target (never self), typed argument-index substitution, no native value, constraints, typed output capture |
| Action results | unused | typed-decoded, captured into variables, drive later guarded transitions |
| Variable store | uniform `(FieldType, bytes)`; persist-before-validate | uniform store retained; canonical per-type encoding validated on every write; persist-before-validate with revert atomicity; action-output overlay for captures |
| Types | 5 field types | adds `BYTES` |
| Security | static call data; owner-mediated | mandatory init-time constraints on tainted components; no self-calls; init-time bounded-evaluation caps (`ConfigCapExceeded`); resolve-once `STATIC_CALL` cache (closes the check-vs-use TOCTOU) |
| Authority | `owner` may reconfigure post-init | owner-less (built): no post-init mutators; verifiers/actions/conditions fixed at init; init sentinel is OZ `Initializable`'s state; `owner` retained as a powerless immutable identity; self-governance through consented transitions is a deferred stretch (rides on effects) |
| Structure | single contract | decomposed into types/core/action libraries + interfaces + engine (legacy desugar lives off-chain in the SDK); namespaced inherited storage (issues #59, #60, #63) |

## 15. Validation approach

Because parts of this architecture carry genuine uncertainty, it is validated risk-first rather than built to a fixed plan: the assumptions with the most architectural leverage and least certainty are isolated and proven with test-driven spikes before broader construction. The parity guarantee (§13), with its single named exception, is the first anchor — legacy authoring desugared by the SDK (off-chain) and run through the canonical engine must reproduce the prior engine's observable behavior against the frozen legacy reference (including legacy skip-if-absent on optional fields, via the `IF_PRESENT` desugar) — and it gates the value-model change. Subsequent spikes target, in risk order, the remaining high-leverage assumptions: clone storage-layout stability under the library/namespaced split; typed argument-index call composition; the resolution core across the full source-and-type matrix (including bounded `STATIC_CALL` with its resolve-once cache); the actions-last pipeline with post-call output commit; an adversarial CEI/reentrancy regression suite over that pipeline; mandatory init-time constraint enforcement on tainted components; and owner-less governance (configuration fixed at init, the init sentinel moved to OZ `Initializable`'s state), with the internal-effect self-governance seam left as a deferred stretch. The companion risk register tracks each assumption, its spike, and its fallback.
