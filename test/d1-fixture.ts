import { createStore } from "../src/store.ts";
import type { SnapshotRow } from "../src/parser.ts";

// Small D1 transport double. Production createStore still performs its own binding,
// insertion, deduplication lookup, and result mapping through this interface.
export function syntheticD1Store() {
  const rows = new Map<string, SnapshotRow>();
  const database = {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async first() {
          if (!sql.startsWith("SELECT scheduled_at FROM snapshots")) throw new Error(`Unexpected SQL: ${sql}`);
          return rows.has(String(args[0])) ? { scheduled_at: args[0] } : null;
        },
        async run() {
          if (!sql.startsWith("INSERT INTO snapshots")) throw new Error(`Unexpected SQL: ${sql}`);
          const [scheduledAt, observedAt, peopleScreened, bagsScreened, peopleAnchor, bagsAnchor, peopleAnchorAt, bagsAnchorAt, sourceUrl, collectionMethod] = args;
          const row = { scheduledAt, observedAt, peopleScreened, bagsScreened, peopleAnchor, bagsAnchor, peopleAnchorAt, bagsAnchorAt, sourceUrl, collectionMethod } as SnapshotRow;
          if (!rows.has(row.scheduledAt)) rows.set(row.scheduledAt, row);
          return { success: true };
        },
        async all() {
          if (!sql.includes("FROM snapshots ORDER BY scheduled_at ASC LIMIT 10001")) throw new Error(`Unexpected SQL: ${sql}`);
          return { success: true, results: [...rows.values()].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).slice(0, 10001) };
        },
      };
    },
  } as unknown as D1Database;
  return { database, store: createStore(database), rows };
}
