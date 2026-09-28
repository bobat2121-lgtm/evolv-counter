import assert from "node:assert/strict";
import test from "node:test";
import { runScheduled } from "../src/job.ts";
import type { SnapshotRow } from "../src/parser.ts";
import type { SnapshotStore } from "../src/store.ts";
import { NOW, syntheticSnapshot } from "./fixtures.ts";
import { syntheticD1Store } from "./d1-fixture.ts";

function memoryStore() {
  const rows = new Map<string, SnapshotRow>();
  const store: SnapshotStore = {
    async find(scheduledAt) { return rows.has(scheduledAt); },
    async insert(row) { if (!rows.has(row.scheduledAt)) rows.set(row.scheduledAt, row); },
    async list() { return [...rows.values()].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)); },
  };
  return { rows, store };
}

test("repeated schedule preserves the database row and skips another source read", async () => {
  const { store, rows } = syntheticD1Store();
  let reads = 0;
  let completed = 0;
  const read = async () => { reads++; return syntheticSnapshot(); };
  const complete = async () => {
    completed++;
    assert.equal(rows.size, 1, "database commit must precede completion");
  };
  await runScheduled(NOW, store, read, complete);
  assert.equal(rows.size, 1);
  const result = await runScheduled(NOW, store, read, complete);
  assert.deepEqual(result, { scheduledAt: new Date(NOW).toISOString(), alreadyRecorded: true });
  assert.equal(reads, 1);
  assert.equal(completed, 2);
  assert.equal(rows.size, 1);
  assert.deepEqual([...rows.values()][0], { ...syntheticSnapshot(), scheduledAt: new Date(NOW).toISOString() });
});

test("separate 12-hour invocations append distinct timestamped rows", async () => {
  const { store, rows } = memoryStore();
  let uploads = 0;
  for (const time of [NOW, NOW + 12 * 60 * 60 * 1000]) {
    const result = await runScheduled(time, store, async () => syntheticSnapshot(), async () => { uploads++; });
    assert.equal(result.alreadyRecorded, false);
  }
  assert.equal(rows.size, 2);
  assert.equal(uploads, 2);
});

test("a failed source read or invalid snapshot never writes a row or replaces a report", async () => {
  const { store, rows } = memoryStore();
  let uploads = 0;
  const upload = async () => { uploads++; };
  await assert.rejects(runScheduled(NOW, store, async () => { throw new Error("Synthetic source failure"); }, upload), /Synthetic source failure/);
  await assert.rejects(runScheduled(NOW, store, async () => ({ ...syntheticSnapshot(), peopleScreened: 0 }), upload), /Invalid snapshot count/);
  assert.equal(rows.size, 0);
  assert.equal(uploads, 0);
});

test("a database failure prevents publishing a report that omits the requested snapshot", async () => {
  const { store } = memoryStore();
  let uploads = 0;
  store.insert = async () => { throw new Error("Synthetic D1 failure"); };
  await assert.rejects(runScheduled(NOW, store, async () => syntheticSnapshot(), async () => { uploads++; }), /Synthetic D1 failure/);
  assert.equal(uploads, 0);
});
