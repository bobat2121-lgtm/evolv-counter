import type { Snapshot } from "../src/parser.ts";

// Every value in this module is synthetic test data, never a live observation.
export const NOW = Date.parse("2026-09-28T12:00:00.000Z");

export function syntheticSeries() {
  return {
    success: true,
    data: {
      server_time: NOW / 1000,
      series: {
        visitorstats: [[NOW / 1000 - 120, 5_000_000_123]],
        bagstats: [[NOW / 1000 - 120, 100_000_456]],
      },
    },
  };
}

export function syntheticSnapshot(): Snapshot {
  return {
    observedAt: "2026-09-28T12:00:03.000Z",
    peopleScreened: 5_000_001_234,
    bagsScreened: 100_000_567,
    peopleAnchor: 5_000_000_123,
    bagsAnchor: 100_000_456,
    peopleAnchorAt: "2026-09-28T11:58:00.000Z",
    bagsAnchorAt: "2026-09-28T11:58:00.000Z",
    sourceUrl: "https://evolv.com/",
    collectionMethod: "cloudflare_browser",
  };
}

export function syntheticManualSnapshot(): Snapshot {
  return {
    ...syntheticSnapshot(),
    peopleAnchor: null,
    bagsAnchor: null,
    peopleAnchorAt: null,
    bagsAnchorAt: null,
    collectionMethod: "interactive_browser",
  };
}
