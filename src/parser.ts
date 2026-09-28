export const SOURCE_URL = "https://evolv.com/";
export const SERIES_URL = "https://evolv.com/wp-admin/admin-ajax.php";
export const FIELDS = ["visitorstats", "bagstats"] as const;
export type CounterField = (typeof FIELDS)[number];
export type Anchor = { timestamp: number; value: number };
export type Series = { serverTime: number; anchors: Record<CounterField, Anchor> };
export type CollectionMethod = "cloudflare_browser" | "interactive_browser";
export type Snapshot = {
  observedAt: string;
  peopleScreened: number;
  bagsScreened: number;
  peopleAnchor: number | null;
  bagsAnchor: number | null;
  peopleAnchorAt: string | null;
  bagsAnchorAt: string | null;
  sourceUrl: string;
  collectionMethod?: CollectionMethod;
};
export type SnapshotRow = Snapshot & { scheduledAt: string };

export function parseDisplayedCount(text: unknown): number {
  if (typeof text !== "string") throw new Error("Counter text is missing");
  const value = text.trim();
  // English digits with correctly grouped commas, spaces, NBSP, or narrow NBSP.
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)$/.test(value)) {
    throw new Error(`Invalid counter text: ${value.slice(0, 80)}`);
  }
  const count = Number(value.replace(/[, \u00a0\u202f]/g, ""));
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error("Counter must be a positive safe integer");
  return count;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSeriesResponse(payload: unknown, nowMs = Date.now()): Series {
  if (!record(payload) || payload.success !== true || !record(payload.data)) {
    throw new Error("Live counter response was unsuccessful");
  }
  const { data } = payload;
  if (typeof data.server_time !== "number" || !Number.isFinite(data.server_time)
      || Math.abs(data.server_time * 1000 - nowMs) > 10 * 60 * 1000 || !record(data.series)) {
    throw new Error("Live counter response is stale or malformed");
  }
  const anchors = {} as Record<CounterField, Anchor>;
  for (const field of FIELDS) {
    const points = data.series[field];
    const last: unknown = Array.isArray(points) ? points.at(-1) : undefined;
    if (!Array.isArray(last) || last.length !== 2 || typeof last[0] !== "number"
        || !Number.isFinite(last[0]) || typeof last[1] !== "number"
        || !Number.isSafeInteger(last[1]) || last[1] <= 0
        || last[0] > data.server_time + 60 || data.server_time - last[0] > 24 * 60 * 60) {
      throw new Error(`Missing, malformed, or older-than-24h anchor: ${field}`);
    }
    anchors[field] = { timestamp: last[0], value: last[1] };
  }
  return { serverTime: data.server_time, anchors };
}

export function validateSnapshot(snapshot: Snapshot): Snapshot {
  const method = snapshot.collectionMethod === undefined ? "cloudflare_browser" : snapshot.collectionMethod;
  if (method !== "cloudflare_browser" && method !== "interactive_browser") throw new Error("Invalid collection method");
  for (const value of [snapshot.peopleScreened, snapshot.bagsScreened]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid snapshot count");
  }
  if (typeof snapshot.observedAt !== "string" || !Number.isFinite(Date.parse(snapshot.observedAt))) {
    throw new Error("Invalid snapshot timestamp");
  }
  for (const [value, date] of [
    [snapshot.peopleAnchor, snapshot.peopleAnchorAt],
    [snapshot.bagsAnchor, snapshot.bagsAnchorAt],
  ] as const) {
    if (value === null || date === null) {
      if (method !== "interactive_browser" || value !== null || date !== null) {
        throw new Error("Missing or incomplete source anchor");
      }
      continue;
    }
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid snapshot count");
    if (typeof date !== "string" || !Number.isFinite(Date.parse(date))) throw new Error("Invalid snapshot timestamp");
  }
  if (snapshot.sourceUrl !== SOURCE_URL) throw new Error("Unexpected snapshot source");
  return snapshot;
}
