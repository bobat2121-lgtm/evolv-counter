import { validateSnapshot, type Snapshot } from "./parser.ts";
import type { SnapshotStore } from "./store.ts";

export async function runScheduled(
  scheduledTime: number,
  store: SnapshotStore,
  readSnapshot: () => Promise<Snapshot>,
  refreshReport: () => Promise<void>,
): Promise<{ scheduledAt: string; alreadyRecorded: boolean }> {
  const scheduledAt = new Date(scheduledTime).toISOString();
  const alreadyRecorded = await store.find(scheduledAt);
  if (!alreadyRecorded) {
    const snapshot = validateSnapshot(await readSnapshot());
    await store.insert({ ...snapshot, scheduledAt });
  }
  // Also run on a repeated invocation: a previous upload may have failed AFTER the DB commit.
  await refreshReport();
  return { scheduledAt, alreadyRecorded };
}
