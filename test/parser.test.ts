import assert from "node:assert/strict";
import test from "node:test";
import { parseDisplayedCount, parseSeriesResponse, validateSnapshot } from "../src/parser.ts";
import { NOW, syntheticSeries, syntheticSnapshot, syntheticManualSnapshot } from "./fixtures.ts";

test("display parser preserves numeric totals beyond signed and unsigned 32-bit ranges", () => {
  for (const value of ["5000001234", "5,000,001,234", "5 000 001 234", "5\u00a0000\u00a0001\u00a0234", "5\u202f000\u202f001\u202f234"]) {
    assert.equal(parseDisplayedCount(value), 5_000_001_234);
  }
  assert.equal(parseDisplayedCount("  100,000,567\n"), 100_000_567);
  assert.equal(parseDisplayedCount(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
});

test("display parser rejects missing, malformed, rounded, negative, and unsafe totals", () => {
  const invalid: unknown[] = [undefined, null, 123, {}, "", "   ", "0", "0,000", "-12", "+12", "1.5", "1e6", "1.2B", "Loading…", "123 people", "1,23", "12,345,67", "1 234,567", "1\t234", "9,007,199,254,740,992"];
  for (const value of invalid) {
    assert.throws(() => parseDisplayedCount(value), undefined, `accepted invalid input ${JSON.stringify(value)}`);
  }
});

test("series parser uses each counter's final source anchor without narrowing large integers", () => {
  const payload = syntheticSeries();
  payload.data.series.visitorstats.unshift([NOW / 1000 - 300, 4_999_999_999]);
  assert.deepEqual(parseSeriesResponse(payload, NOW), {
    serverTime: NOW / 1000,
    anchors: {
      visitorstats: { timestamp: NOW / 1000 - 120, value: 5_000_000_123 },
      bagstats: { timestamp: NOW / 1000 - 120, value: 100_000_456 },
    },
  });
});

test("series parser rejects unsuccessful or missing response structures", () => {
  for (const value of [null, [], {}, { success: false, data: {} }, { success: true }, { success: true, data: { server_time: NOW / 1000, series: {} } }]) {
    assert.throws(() => parseSeriesResponse(value, NOW));
  }
});

test("series parser rejects stale responses and malformed or stale per-counter anchors", () => {
  const changes: Array<(value: any) => void> = [
    value => { value.data.server_time = NOW / 1000 - 601; },
    value => { value.data.server_time = NOW / 1000 + 601; },
    value => { value.data.server_time = String(NOW / 1000); },
    value => { value.data.server_time = Infinity; },
    value => { delete value.data.series.bagstats; },
    value => { value.data.series.visitorstats = []; },
    value => { value.data.series.bagstats = [[NOW / 1000 - 86_401, 100]]; },
    value => { value.data.series.visitorstats = [[NOW / 1000 + 61, 100]]; },
    value => { value.data.series.visitorstats[0][0] = NaN; },
    value => { value.data.series.bagstats[0][1] = "100"; },
    value => { value.data.series.bagstats[0][1] = 0; },
    value => { value.data.series.bagstats[0][1] = -5; },
    value => { value.data.series.bagstats[0][1] = 1.5; },
    value => { value.data.series.bagstats[0][1] = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.data.series.bagstats[0].push(123); },
  ];
  for (const change of changes) {
    const payload = syntheticSeries();
    change(payload);
    assert.throws(() => parseSeriesResponse(payload, NOW));
  }
});

test("snapshot validation rejects invalid counts, timestamps, or unexpected source", () => {
  assert.deepEqual(validateSnapshot(syntheticSnapshot()), syntheticSnapshot());
  const changes: Array<(value: any) => void> = [
    value => { value.peopleScreened = NaN; },
    value => { value.bagsScreened = 0; },
    value => { value.peopleAnchor = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.bagsAnchor = 1.5; },
    value => { value.observedAt = ""; },
    value => { value.peopleAnchorAt = "not-a-date"; },
    value => { value.bagsAnchorAt = "not-a-date"; },
    value => { value.sourceUrl = "https://example.invalid/"; },
  ];
  for (const change of changes) {
    const snapshot = syntheticSnapshot();
    change(snapshot);
    assert.throws(() => validateSnapshot(snapshot));
  }
});

test("explicit interactive-browser observations accept unknown anchors without fabricating them", () => {
  const manual = syntheticManualSnapshot();
  assert.deepEqual(validateSnapshot(manual), manual);
  assert.equal(manual.peopleAnchor, null);
  assert.equal(manual.peopleAnchorAt, null);
  assert.equal(manual.bagsAnchor, null);
  assert.equal(manual.bagsAnchorAt, null);
  const mixed = { ...manual, peopleAnchor: syntheticSnapshot().peopleAnchor, peopleAnchorAt: syntheticSnapshot().peopleAnchorAt };
  assert.deepEqual(validateSnapshot(mixed), mixed);
});

test("automatic observations reject missing anchors even if collection method is omitted", () => {
  const legacy = { ...syntheticSnapshot(), collectionMethod: undefined };
  assert.deepEqual(validateSnapshot(legacy), legacy);
  for (const method of ["cloudflare_browser", undefined] as const) {
    const missingAnchors = { ...syntheticManualSnapshot(), collectionMethod: method };
    assert.throws(() => validateSnapshot(missingAnchors));
    for (const field of ["peopleAnchor", "bagsAnchor", "peopleAnchorAt", "bagsAnchorAt"] as const) {
      const invalid = { ...syntheticSnapshot(), collectionMethod: method, [field]: null };
      assert.throws(() => validateSnapshot(invalid));
    }
  }
});

test("manual provenance does not permit invalid displayed counts, inconsistent anchors, or unknown methods", () => {
  const changes: Array<(value: any) => void> = [
    value => { value.peopleScreened = null; },
    value => { value.bagsScreened = 0; },
    value => { value.observedAt = "invalid"; },
    value => { value.peopleAnchor = 123; },
    value => { value.bagsAnchorAt = "2026-09-28T11:58:00.000Z"; },
    value => { value.peopleAnchor = 0; value.peopleAnchorAt = "2026-09-28T11:58:00.000Z"; },
    value => { value.peopleAnchor = 123; value.peopleAnchorAt = "invalid"; },
    value => { value.collectionMethod = "unknown"; },
    value => { value.collectionMethod = null; },
  ];
  for (const change of changes) {
    const invalid = syntheticManualSnapshot();
    change(invalid);
    assert.throws(() => validateSnapshot(invalid));
  }
  for (const collectionMethod of ["unknown", null]) {
    assert.throws(() => validateSnapshot({ ...syntheticSnapshot(), collectionMethod } as any));
  }
});
