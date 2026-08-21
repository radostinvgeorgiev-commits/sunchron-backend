import assert from "node:assert/strict";
import test from "node:test";

import { ECOSYSTEM_MODULES, getEcosystemStatus } from "../src/config/ecosystem.js";

test("NOVARIUM ecosystem skeleton keeps legal and token modules disabled", () => {
  assert.equal(ECOSYSTEM_MODULES.novarium.enabled, true);
  assert.equal(ECOSYSTEM_MODULES.token.enabled, false);
  assert.equal(ECOSYSTEM_MODULES.foundation.enabled, false);
  assert.equal(ECOSYSTEM_MODULES.corporation.enabled, false);
  assert.equal(ECOSYSTEM_MODULES.token.safety.noIssuance, true);
  assert.equal(ECOSYSTEM_MODULES.corporation.safety.noRegistration, true);
  assert.equal(getEcosystemStatus().foundation.status, "planned");
});
