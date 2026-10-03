import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DESCRIPTOR_LENGTH, DESCRIPTOR_MAX_ABS } from "../../src/biometrics/constants.js";
import { isDescriptorShape, toUnitVector } from "../../src/biometrics/descriptor.js";
import { person } from "../helpers/face.js";

const good = () => person(1);
const withAt = (index, value) => {
  const v = good();
  v[index] = value;
  return v;
};

describe("face descriptor validation", () => {
  it("the dimension lives in one central constant", () => {
    assert.equal(DESCRIPTOR_LENGTH, 512);
    assert.equal(good().length, DESCRIPTOR_LENGTH);
  });

  it("accepts an array of exactly DESCRIPTOR_LENGTH finite numbers", () => {
    assert.equal(isDescriptorShape(good()), true);
    assert.equal(isDescriptorShape(good().map((x) => x * 30)), true, "raw model output is not unit length");
    assert.equal(isDescriptorShape(Array(DESCRIPTOR_LENGTH).fill(0)), true, "the shape is fine; toUnitVector rejects it as empty");
  });

  it("rejects every wrong length", () => {
    for (const length of [0, 1, DESCRIPTOR_LENGTH - 1, DESCRIPTOR_LENGTH + 1, 1024, 128]) {
      assert.equal(isDescriptorShape(Array(length).fill(0.1)), false, `length ${length}`);
      assert.equal(toUnitVector(Array(length).fill(0.1)), null, `length ${length}`);
    }
  });

  it("rejects numbers that are not finite", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      for (const index of [0, 255, DESCRIPTOR_LENGTH - 1]) assert.equal(toUnitVector(withAt(index, bad)), null, `${bad} at ${index}`);
    }
  });

  it("rejects values outside the sane range, and accepts the boundary", () => {
    assert.equal(toUnitVector(withAt(3, DESCRIPTOR_MAX_ABS * 1.0001)), null);
    assert.equal(toUnitVector(withAt(3, -DESCRIPTOR_MAX_ABS * 1.0001)), null);
    assert.equal(toUnitVector(withAt(3, 1e308)), null);
    assert.notEqual(toUnitVector(withAt(3, DESCRIPTOR_MAX_ABS)), null);
    assert.notEqual(toUnitVector(withAt(3, -DESCRIPTOR_MAX_ABS)), null);
  });

  it("rejects elements that are not numbers", () => {
    for (const bad of ["0.5", null, undefined, true, {}, [], [0.5], 1n, { valueOf: () => 0.5 }]) assert.equal(toUnitVector(withAt(7, bad)), null, String(typeof bad));
  });

  it("rejects everything that is not a plain array", () => {
    const typed = Float32Array.from(good());
    const arrayLike = { length: DESCRIPTOR_LENGTH, ...good() };
    const sparse = new Array(DESCRIPTOR_LENGTH); // holes are undefined
    for (const bad of [undefined, null, "", "descriptor", 42, {}, typed, arrayLike, sparse, JSON.stringify(good()), { $ne: null }]) assert.equal(toUnitVector(bad), null);
  });

  it("rejects an empty (all-zero) descriptor", () => {
    assert.equal(toUnitVector(Array(DESCRIPTOR_LENGTH).fill(0)), null);
    assert.equal(toUnitVector(Array(DESCRIPTOR_LENGTH).fill(1e-12)), null);
  });

  it("returns a Float32Array of unit length, whatever the input scale, without changing the input", () => {
    for (const scale of [1, 0.001, 37.5]) {
      const input = good().map((x) => x * scale);
      const copy = [...input];
      const unit = toUnitVector(input);
      assert.ok(unit instanceof Float32Array);
      assert.equal(unit.length, DESCRIPTOR_LENGTH);
      const length = Math.sqrt(unit.reduce((s, x) => s + x * x, 0));
      assert.ok(Math.abs(length - 1) < 1e-6, `length ${length}`);
      assert.deepEqual(input, copy);
    }
  });

  it("keeps the direction: scaling a descriptor does not change its unit vector", () => {
    const a = toUnitVector(good());
    const b = toUnitVector(good().map((x) => x * 12));
    for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-6);
  });
});
