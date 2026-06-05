/**
 * Differential parity — STRING Op family (prior engine vs new AgreementEngine).
 *
 * STRING_MIN_LENGTH desugars to FIELD_LENGTH GTE CONST; STRING_MAX_LENGTH to
 * FIELD_LENGTH LTE CONST; STRING_EQ_CONST/VAR to FIELD EQ CONST/VAR. Byte-length and
 * keccak-equality semantics must match the prior engine exactly.
 */

import { runDifferential, assertParity } from "./harness";
import { stringParityCases } from "./corpus";

describe("Parity — STRING Op family (Legacy vs AgreementEngine)", () => {
  for (const c of stringParityCases()) {
    it(`parity: ${c.name}`, async () => {
      const { legacy, canonical } = await runDifferential(c);
      assertParity(c, legacy, canonical);
    });
  }
});
