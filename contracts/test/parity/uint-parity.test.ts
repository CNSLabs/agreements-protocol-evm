/**
 * Differential parity — UINT Op family (prior engine vs new AgreementEngine).
 *
 * Every legacy UINT `Op` condition, desugared at `initialize` into a canonical
 * Condition over ValueRefs and evaluated through ValueLib, must reproduce the frozen
 * prior engine's observable accept/reject behavior — except the one remaining named
 * exception (self-referential persisted-VAR condition rejected at init), asserted as
 * a deliberate divergence.
 *
 * Conditions on absent optional fields are full parity: the prior engine skips them
 * and the new engine desugars them to IF_PRESENT and likewise skips them (see the
 * missing-optional cases folded into the per-family parity aggregators).
 */

import { expect } from "chai";
import { runDifferential, assertParity } from "./harness";
import { uintParityCases, namedExceptionCases } from "./corpus";

describe("Parity — UINT Op family (Legacy vs AgreementEngine)", () => {
  const cases = uintParityCases();

  for (const c of cases) {
    it(`parity: ${c.name}`, async () => {
      const { legacy, canonical } = await runDifferential(c);
      assertParity(c, legacy, canonical);
    });
  }
});

describe("Named exceptions (deliberate divergences from the prior engine)", () => {
  for (const c of namedExceptionCases()) {
    if (c.namedException === "selfReferentialVar") {
      it(`self-referential persisted VAR: legacy inits, new rejects at init: ${c.name}`, async () => {
        const { legacy, canonical } = await runDifferential(c);

        // The divergence is at INITIALIZE: the prior engine accepts this configuration
        // (it inits fine and merely persists-before-checks), whereas the new engine
        // rejects the degenerate self-referential VAR condition at init. Whether the
        // prior engine then accepts the submission depends on the op (EQ/GTE/LTE pass,
        // GT/LT fail on field-vs-itself), which is not the point of this exception.
        expect(legacy.initReverted, "prior engine should initialize successfully").to.equal(false);
        expect(legacy.submitReverted, "prior submit outcome matches corpus ground truth").to.equal(
          !c.expectAccept
        );

        // New engine: deliberate deviation -> rejected at initialize.
        expect(canonical.initReverted, "new should reject self-referential VAR at init").to.equal(true);
      });
    }
  }
});
