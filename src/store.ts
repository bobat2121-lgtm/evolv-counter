import type { SnapshotRow } from "./parser.ts";

export interface SnapshotStore {
  find(scheduledAt: string): Promise<boolean>;
  insert(row: SnapshotRow): Promise<void>;
  list(): Promise<SnapshotRow[]>;
}

export function createStore(db: D1Database): SnapshotStore {
  return {
    async find(scheduledAt) {
      return (await db.prepare("SELECT scheduled_at FROM snapshots WHERE scheduled_at = ?")
        .bind(scheduledAt).first()) !== null;
    },
    async insert(row) {
      await db.prepare(`INSERT INTO snapshots
        (scheduled_at, observed_at, people_screened, bags_screened, people_anchor, bags_anchor,
         people_anchor_at, bags_anchor_at, source_url, collection_method)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scheduled_at) DO NOTHING`)
        .bind(row.scheduledAt, row.observedAt, row.peopleScreened, row.bagsScreened,
          row.peopleAnchor, row.bagsAnchor, row.peopleAnchorAt, row.bagsAnchorAt, row.sourceUrl,
          row.collectionMethod ?? "cloudflare_browser").run();
    },
    async list() {
      const result = await db.prepare(`SELECT scheduled_at AS scheduledAt, observed_at AS observedAt,
        people_screened AS peopleScreened, bags_screened AS bagsScreened,
        people_anchor AS peopleAnchor, bags_anchor AS bagsAnchor,
        people_anchor_at AS peopleAnchorAt, bags_anchor_at AS bagsAnchorAt, source_url AS sourceUrl,
        collection_method AS collectionMethod
        FROM snapshots ORDER BY scheduled_at ASC LIMIT 10001`).all<SnapshotRow>();
      // Bound memory for a non-streaming XLSX (over 13 years of twice-daily history).
      if (result.results.length > 10000) throw new Error("Archive history before exporting over 10,000 snapshots");
      return result.results;
    },
  };
}
