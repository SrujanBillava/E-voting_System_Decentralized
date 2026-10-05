import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FACE_VERIFIED_TTL_MS } from "../../../backend-api/src/biometrics/constants.js";
import { ISSUED_TTL_MS, SESSION_ABSOLUTE_MS, STAGE_ORDER, STAGE_TTL_MS, STAGES, canTransition, isStage } from "../../src/auth/voterStages.js";

describe("identity-v3 stage machine", () => {
  it("is exactly AUTHENTICATED -> FACE_VERIFIED -> ELIGIBLE -> COMMITMENT_PENDING -> CREDENTIAL_ISSUED, and has NO V2 ballot stage", () => {
    assert.deepEqual(STAGE_ORDER, ["AUTHENTICATED", "FACE_VERIFIED", "ELIGIBLE", "COMMITMENT_PENDING", "CREDENTIAL_ISSUED"]);
    for (const v2 of ["AUTH_ISSUED", "SUBMITTED", "COMPLETED"]) {
      assert.equal(isStage(v2), false, v2);
      assert.ok(!(v2 in STAGES));
    }
  });

  it("only the next stage is reachable, never backwards, never skipping; CREDENTIAL_ISSUED is terminal", () => {
    for (const [i, from] of STAGE_ORDER.entries()) {
      for (const [j, to] of STAGE_ORDER.entries()) assert.equal(canTransition(from, to), j === i + 1, `${from} -> ${to}`);
    }
    assert.equal(STAGE_ORDER.filter((s) => canTransition(STAGES.CREDENTIAL_ISSUED, s)).length, 0);
    assert.equal(canTransition("SUBMITTED", "COMPLETED"), false);
    assert.equal(canTransition(STAGES.ELIGIBLE, "nonsense"), false);
  });

  it("the terminal stage lives only long enough to deliver the result once; lifetimes are consistent with the V2 biometrics constants", () => {
    assert.equal(STAGE_TTL_MS[STAGES.CREDENTIAL_ISSUED], ISSUED_TTL_MS);
    assert.ok(ISSUED_TTL_MS <= 60_000);
    assert.equal(STAGE_TTL_MS[STAGES.FACE_VERIFIED], FACE_VERIFIED_TTL_MS);
    for (const stage of STAGE_ORDER) assert.ok(STAGE_TTL_MS[stage] > 0 && STAGE_TTL_MS[stage] <= SESSION_ABSOLUTE_MS, stage);
    assert.ok(STAGE_TTL_MS[STAGES.COMMITMENT_PENDING] >= 2 * 60_000, "long enough for an epoch cohort plus confirmation");
  });
});
