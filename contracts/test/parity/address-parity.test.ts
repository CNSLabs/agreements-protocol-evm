/**
 * Differential parity — ADDRESS Op family (prior engine vs new AgreementEngine).
 * ADDRESS_EQ_CONST/VAR desugars to FIELD EQ CONST/VAR(address).
 */

import { runDifferential, assertParity } from "./harness";
import { addressParityCases } from "./corpus";

describe("Parity — ADDRESS Op family (Legacy vs AgreementEngine)", () => {
  for (const c of addressParityCases()) {
    it(`parity: ${c.name}`, async () => {
      const { legacy, canonical } = await runDifferential(c);
      assertParity(c, legacy, canonical);
    });
  }
});
