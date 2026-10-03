import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { createHealthService } from "../../src/services/health.service.js";

describe("health service", () => {
  it("reports ok / degraded from the shallow preflight", async () => {
    const ok = createHealthService({ runPreflight: async () => ({ ok: true }) });
    const bad = createHealthService({ runPreflight: async () => ({ ok: false }) });
    assert.deepEqual(await ok.getPublicHealth(), { status: "ok" });
    assert.deepEqual(await bad.getPublicHealth(), { status: "degraded" });
  });

  it("treats a throwing preflight as degraded, never as an error", async () => {
    const svc = createHealthService({ runPreflight: async () => { throw new Error("boom"); } });
    assert.deepEqual(await svc.getPublicHealth(), { status: "degraded" });
  });

  it("the public view never carries details", async () => {
    const svc = createHealthService({ runPreflight: async () => ({ ok: true, checks: [{ name: "x" }], snapshot: { owner: "0x1" } }) });
    assert.deepEqual(Object.keys(await svc.getPublicHealth()), ["status"]);
  });

  it("caches for the TTL and collapses concurrent probes into one", async () => {
    let calls = 0;
    let t = 1000;
    const svc = createHealthService({
      ttlMs: 5000,
      now: () => t,
      runPreflight: async (opts) => {
        calls++;
        assert.equal(opts.deep, false, "public health must use the cheap probe");
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true };
      },
    });
    await Promise.all([svc.getPublicHealth(), svc.getPublicHealth(), svc.getPublicHealth()]);
    assert.equal(calls, 1);
    t += 4000;
    await svc.getPublicHealth();
    assert.equal(calls, 1);
    t += 2000;
    await svc.getPublicHealth();
    assert.equal(calls, 2);
  });

  it("the system preflight is deep and never cached", async () => {
    let deepCalls = 0;
    const svc = createHealthService({ runPreflight: async (opts) => { if (opts.deep) deepCalls++; return { ok: true }; } });
    await svc.getSystemPreflight();
    await svc.getSystemPreflight();
    assert.equal(deepCalls, 2);
  });
});

const never = () => new Promise(() => {});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("health service: cache edges", () => {
  const counting = (ok = () => true) => {
    const calls = { count: 0 };
    const t = { now: 0 };
    const svc = createHealthService({ ttlMs: 5000, now: () => t.now, runPreflight: async () => (calls.count++, { ok: ok(calls.count) }) });
    return { svc, calls, t };
  };

  it("an answer is fresh for strictly less than the TTL and expires exactly at it", async () => {
    const { svc, calls, t } = counting();
    await svc.getPublicHealth();
    t.now = 4999;
    await svc.getPublicHealth();
    assert.equal(calls.count, 1);
    t.now = 5000;
    await svc.getPublicHealth();
    assert.equal(calls.count, 2);
  });

  it("the TTL defaults to 5 seconds", async () => {
    let calls = 0;
    let t = 0;
    const svc = createHealthService({ now: () => t, runPreflight: async () => (calls++, { ok: true }) });
    await svc.getPublicHealth();
    t = 4999;
    await svc.getPublicHealth();
    assert.equal(calls, 1);
    t = 5000;
    await svc.getPublicHealth();
    assert.equal(calls, 2);
  });

  it("a clock that jumps backwards does not freeze a stale answer", async () => {
    const { svc, calls, t } = counting();
    t.now = 1_000_000;
    await svc.getPublicHealth();
    t.now = 10; // stepped back by ~16 minutes
    await svc.getPublicHealth();
    assert.equal(calls.count, 2, "negative age means 'unknown', so it must re-probe");
  });

  it("a degraded answer is not sticky: the next probe after the TTL can report ok again", async () => {
    const { svc, calls, t } = counting((n) => n >= 2);
    assert.deepEqual(await svc.getPublicHealth(), { status: "degraded" });
    t.now = 5000;
    assert.deepEqual(await svc.getPublicHealth(), { status: "ok" });
    assert.equal(calls.count, 2);
  });

  it("a rejected probe is cached as degraded for the TTL too (an outage cannot be used to hammer the node)", async () => {
    let calls = 0;
    const svc = createHealthService({ now: () => 0, runPreflight: async () => { calls++; throw new Error("down"); } });
    assert.deepEqual(await svc.getPublicHealth(), { status: "degraded" });
    assert.deepEqual(await svc.getPublicHealth(), { status: "degraded" });
    assert.equal(calls, 1);
  });

  it("a malformed report is degraded, not an error", async () => {
    for (const report of [undefined, null, 5]) {
      const svc = createHealthService({ runPreflight: async () => report });
      assert.deepEqual(await svc.getPublicHealth(), { status: "degraded" }, String(report));
    }
  });

  it("a synchronously throwing preflight is degraded as well", async () => {
    const svc = createHealthService({ runPreflight: () => { throw new Error("sync boom"); } });
    assert.deepEqual(await svc.getPublicHealth(), { status: "degraded" });
  });
});

describe("health service: a hanging preflight cannot hang the endpoint", () => {
  it("answers 'degraded' once the probe deadline passes, and concurrent callers share that answer", async () => {
    let calls = 0;
    const svc = createHealthService({ probeTimeoutMs: 40, runPreflight: () => (calls++, never()) });
    const started = Date.now();
    const answers = await Promise.all([svc.getPublicHealth(), svc.getPublicHealth(), svc.getPublicHealth()]);
    assert.deepEqual(answers, Array(3).fill({ status: "degraded" }));
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 2000);
  });

  it("while a timed-out probe is still hanging no second probe is started, however often the TTL expires", async () => {
    let calls = 0;
    let t = 0;
    const svc = createHealthService({ ttlMs: 10, probeTimeoutMs: 20, now: () => t, runPreflight: () => (calls++, never()) });
    await svc.getPublicHealth();
    for (let i = 1; i <= 5; i++) {
      t = i * 100;
      assert.deepEqual(await svc.getPublicHealth(), { status: "degraded" });
    }
    assert.equal(calls, 1, "the hung probe is not stacked");
  });

  it("recovers by itself once the hung probe finally settles", async () => {
    let t = 0;
    let calls = 0;
    let finish;
    const svc = createHealthService({
      ttlMs: 10,
      probeTimeoutMs: 20,
      now: () => t,
      runPreflight: () => (++calls === 1 ? new Promise((resolve) => (finish = resolve)) : Promise.resolve({ ok: true })),
    });
    assert.deepEqual(await svc.getPublicHealth(), { status: "degraded" });
    t = 100;
    assert.deepEqual(await svc.getPublicHealth(), { status: "degraded" });
    assert.equal(calls, 1);
    finish({ ok: false });
    await delay(5);
    t = 200;
    assert.deepEqual(await svc.getPublicHealth(), { status: "ok" });
    assert.equal(calls, 2);
  });

  it("recovers too when the hung probe eventually rejects (and that rejection is not unhandled)", async () => {
    let t = 0;
    let calls = 0;
    let fail;
    const svc = createHealthService({
      ttlMs: 10,
      probeTimeoutMs: 20,
      now: () => t,
      runPreflight: () => (++calls === 1 ? new Promise((_, reject) => (fail = reject)) : Promise.resolve({ ok: true })),
    });
    await svc.getPublicHealth();
    fail(new Error("late failure"));
    await delay(5);
    t = 100;
    assert.deepEqual(await svc.getPublicHealth(), { status: "ok" });
  });

  it("a probe that is merely slow (within the deadline) still reports its real result", async () => {
    const svc = createHealthService({ probeTimeoutMs: 500, runPreflight: async () => (await delay(60), { ok: true }) });
    assert.deepEqual(await svc.getPublicHealth(), { status: "ok" });
  });

  it("the default probe deadline is 10 seconds", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const svc = createHealthService({ runPreflight: never });
    let answer;
    const pending = svc.getPublicHealth().then((a) => (answer = a));
    await Promise.resolve();
    t.mock.timers.tick(9999);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(answer, undefined, "still waiting after 9.999 s");
    t.mock.timers.tick(1);
    await pending;
    assert.deepEqual(answer, { status: "degraded" });
  });

  it("the full system preflight is bounded too: a hang becomes a failed report that names the problem", async () => {
    const svc = createHealthService({ systemTimeoutMs: 40, runPreflight: never });
    const report = await svc.getSystemPreflight();
    assert.equal(report.ok, false);
    assert.equal(report.status, "fail");
    assert.match(report.checks[0].message, /did not finish within 40 ms/);
    assert.ok(!Number.isNaN(Date.parse(report.checkedAt)));
  });

  it("the system preflight returns the real report when it finishes in time, and propagates real errors", async () => {
    const report = { ok: true, status: "pass", checks: [] };
    assert.equal(await createHealthService({ systemTimeoutMs: 500, runPreflight: async () => report }).getSystemPreflight(), report);
    await assert.rejects(createHealthService({ runPreflight: async () => { throw new Error("real failure"); } }).getSystemPreflight(), /real failure/);
  });

  it("the default system deadline is generous (5 minutes): a large election may take a while to enumerate", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const svc = createHealthService({ runPreflight: never });
    let report;
    const pending = svc.getSystemPreflight().then((r) => (report = r));
    await Promise.resolve();
    t.mock.timers.tick(299_999);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(report, undefined);
    t.mock.timers.tick(1);
    await pending;
    assert.equal(report.ok, false);
  });
});

