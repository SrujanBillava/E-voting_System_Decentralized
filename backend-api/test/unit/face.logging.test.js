import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { person, rounded, samplesOf } from "../helpers/face.js";

// The biometrics code never hands a descriptor to the logger. This is the safety net behind that rule:
// if a field NAMED like a descriptor ever reaches the logger, its value is not written.

describe("logger: biometric fields", () => {
  const descriptor = rounded(person(41));
  const samples = samplesOf(person(41), 3).map(rounded);
  const needles = [String(descriptor[0]), String(descriptor[300]), String(samples[1][7]), String(samples[2][511])];
  const clean = (lines) => {
    const text = lines.join("");
    for (const needle of needles) assert.ok(!text.includes(needle), `leaked ${needle}`);
    return text;
  };

  it("never writes a value stored under a descriptor-like name, at any depth", () => {
    const { logger, lines } = createMemoryLogger();
    logger.info({ descriptor }, "verify");
    logger.info({ descriptors: samples }, "enrol");
    logger.warn({ body: { attempt: 2, descriptor } }, "request body");
    logger.error({ request: { body: { descriptors: samples } }, faceDescriptor: descriptor, DESCRIPTOR: descriptor, probe_descriptor: descriptor }, "nested");
    const text = clean(lines);
    assert.equal(lines.length, 4);
    assert.ok((text.match(/\[REDACTED\]/g) ?? []).length >= 6);
    assert.match(text, /"attempt":2/, "harmless neighbours are still logged");
  });

  it("an error object carrying a descriptor field does not leak it", () => {
    const { logger, lines } = createMemoryLogger();
    const err = Object.assign(new Error("comparison failed"), { descriptor, descriptors: samples });
    logger.error({ err }, "unhandled error");
    const text = clean(lines);
    assert.match(text, /comparison failed/);
  });

  it("the face audit metadata is plain and small: the logger writes it unchanged", () => {
    const { logger, lines } = createMemoryLogger();
    logger.info({ meta: { voterId: "VC-ABCDEFGHJK", reason: "mismatch", attempt: 2, score: 0.3121, liveness: "reported_pass" } }, "audit");
    const entry = JSON.parse(lines[0]);
    assert.deepEqual(entry.meta, { voterId: "VC-ABCDEFGHJK", reason: "mismatch", attempt: 2, score: 0.3121, liveness: "reported_pass" });
  });
});
