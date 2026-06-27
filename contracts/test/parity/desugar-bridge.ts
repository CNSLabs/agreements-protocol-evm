/**
 * Parity desugar bridge.
 *
 * The differential oracle feeds the SAME legacy `Op`-encoded corpus case to BOTH engines.
 * The frozen LegacyAgreementEngine ingests the legacy `Op` conditions directly (it is the
 * ground-truth oracle). The new composable-only AgreementEngine no longer ingests `Op`, so
 * this bridge desugars the corpus's legacy input defs into the composable init shape — REUSING
 * the SDK's off-chain desugar (`desugarCondition` / `encodeConditions`), the exact code path
 * production authoring runs through. The parity guarantee thus relocates from a Solidity
 * desugar to the SDK TS desugar; it is not dropped.
 *
 * Output is tuple-shaped for the new factory's composable `createAgreement`:
 *   - InputDef  := [id, fields, verifierKeys]   (no conditions)
 *   - CanonicalConditionInit := [inputId, encodedConditions]
 */

import type { InputDef } from "./corpus";

// Reuse the SDK's built desugar (the same translation production uses). Loaded from the
// compiled CJS build so it works under Hardhat's ts-node CommonJS test runner.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdk = require("../../../sdk/dist/cjs/index.js");
const desugarCondition: (
  op: number,
  fieldId: string,
  bytesArg: string,
  fieldOptional: boolean
) => any = sdk.desugarCondition;
const encodeConditions: (conditions: any[]) => string = sdk.encodeConditions;

/** Tuple shape of AgreementEngine.InputDef (the calldata/storage init shape, no conditions). */
type InputDefInitTuple = [
  string, // id
  Array<[string, number, boolean, boolean]>, // fields (fieldId, fType, required, persist)
  string[] // verifierKeys
];

/** Tuple shape of AgreementEngine.CanonicalConditionInit. */
type CanonicalConditionInitTuple = [string, string]; // (inputId, encodedConditions)

/**
 * Desugar the corpus's legacy input defs into (InputDefInit[], CanonicalConditionInit[]) for
 * the new composable engine. Each legacy condition becomes a canonical condition (with
 * IF_PRESENT set from the targeted field's optionality), encoded as the engine's
 * `encodedConditions` bytes.
 */
export function desugarLegacyInputDefs(inputDefs: InputDef[]): {
  inputDefInits: InputDefInitTuple[];
  canonicalConds: CanonicalConditionInitTuple[];
} {
  const inputDefInits: InputDefInitTuple[] = [];
  const canonicalConds: CanonicalConditionInitTuple[] = [];

  for (const d of inputDefs) {
    const optionalByFieldId = new Map<string, boolean>();
    for (const f of d.fields) optionalByFieldId.set(f.fieldId.toLowerCase(), !f.required);

    inputDefInits.push([
      d.id,
      d.fields.map((f) => [f.fieldId, f.fType, f.required, f.persist]),
      d.verifierKeys,
    ]);

    if (d.conditions.length > 0) {
      const canonical = d.conditions.map((c) =>
        desugarCondition(c.op, c.fieldId, c.bytesArg, optionalByFieldId.get(c.fieldId.toLowerCase()) ?? false)
      );
      // The SDK's encodeConditions produces the engine's encodedConditions bytes; but the
      // canonical objects use {left, op, skipIfAbsent, right} with ValueRef objects, which
      // encodeConditions already handles. Pass them straight through.
      canonicalConds.push([d.id, encodeConditions(canonical)]);
    }
  }

  return { inputDefInits, canonicalConds };
}
