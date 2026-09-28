import puppeteer from "@cloudflare/puppeteer";
import { FIELDS, SERIES_URL, SOURCE_URL, parseDisplayedCount, parseSeriesResponse, type Snapshot } from "./parser.ts";

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
class SourceAccessDenied extends Error {}

async function readOnce(binding: Env["BROWSER"]): Promise<Snapshot> {
  const browser = await puppeteer.launch(binding);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    await page.setCacheEnabled(false);
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    const responseWait = new AbortController();
    // Register before navigation so a quick AJAX response cannot be missed.
    const responsePromise = page.waitForResponse((response) => {
      const request = response.request();
      return response.url() === SERIES_URL && request.method() === "POST"
        && new URLSearchParams(request.postData() ?? "").get("action") === "awss_counter_series";
    }, { timeout: 45_000, signal: responseWait.signal });
    // allSettled observes both rejections even if navigation fails first.
    const [navigation, responseResult] = await Promise.allSettled([
      page.goto(SOURCE_URL, { waitUntil: "domcontentloaded", timeout: 45_000 }).then((response) => {
        if (!response?.ok()) responseWait.abort();
        return response;
      }).catch((error) => { responseWait.abort(); throw error; }),
      responsePromise,
    ]);
    if (navigation.status === "rejected") throw navigation.reason;
    if (navigation.value?.status() === 403) {
      const detail = await page.evaluate(() => document.body?.innerText.slice(0, 600) ?? document.title);
      throw new SourceAccessDenied(`Evolv rejected automated access (HTTP 403): ${detail}`);
    }
    if (!navigation.value?.ok()) throw new Error(`Homepage HTTP ${navigation.value?.status() ?? "unknown"}`);
    if (responseResult.status === "rejected") throw responseResult.reason;
    const response = responseResult.value;
    if (!response.ok()) throw new Error(`Counter feed HTTP ${response.status()}`);
    const body = await response.text();
    if (body.length > 1_000_000) throw new Error("Counter feed exceeds expected size");
    const series = parseSeriesResponse(JSON.parse(body));

    // Match the site's active anchors to the successful response, then verify that
    // its animation has rendered them. Initial HTML / data-value attributes are never used.
    await page.waitForFunction((expected, fields) => {
      const state = (window as Window & {
        flexBannerLiveCounterState?: {
          rates?: Record<string, { anchorTime: number; anchorValue: number }>;
          clockOffset?: number;
        };
      }).flexBannerLiveCounterState;
      if (!state?.rates || typeof state.clockOffset !== "number" || !Number.isFinite(state.clockOffset)) return false;
      const renderTime = Date.now() / 1000 + state.clockOffset;
      return fields.every((field) => {
        const rate = state.rates?.[field];
        const anchor = expected[field];
        const elements = document.querySelectorAll(`.live_counter_num[data-counter-type="${field}"]`);
        if (elements.length !== 1 || rate?.anchorTime !== anchor.timestamp || rate.anchorValue !== anchor.value) return false;
        const text = elements[0].textContent?.trim() ?? "";
        if (!/^[\d,\s\u00a0\u202f]+$/.test(text)) return false;
        const displayed = Number(text.replace(/[,\s\u00a0\u202f]/g, ""));
        // Homepage behavior inspected 2026-09-28: both counters animate at 5/s.
        const expectedDisplay = Math.round(anchor.value + 5 * Math.max(0, renderTime - anchor.timestamp));
        return Number.isSafeInteger(displayed) && Math.abs(displayed - expectedDisplay) <= 10;
      });
    }, { timeout: 20_000 }, series.anchors, [...FIELDS]);

    const captured = await page.evaluate(() => ({
      observedAt: new Date().toISOString(),
      peopleText: document.querySelector('.live_counter_num[data-counter-type="visitorstats"]')?.textContent,
      bagsText: document.querySelector('.live_counter_num[data-counter-type="bagstats"]')?.textContent,
    }));
    return {
      observedAt: captured.observedAt,
      peopleScreened: parseDisplayedCount(captured.peopleText),
      bagsScreened: parseDisplayedCount(captured.bagsText),
      peopleAnchor: series.anchors.visitorstats.value,
      bagsAnchor: series.anchors.bagstats.value,
      peopleAnchorAt: new Date(series.anchors.visitorstats.timestamp * 1000).toISOString(),
      bagsAnchorAt: new Date(series.anchors.bagstats.timestamp * 1000).toISOString(),
      sourceUrl: SOURCE_URL,
    };
  } finally {
    await browser.close();
  }
}

export async function readLiveSnapshot(binding: Env["BROWSER"]): Promise<Snapshot> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await readOnce(binding);
    } catch (error) {
      console.error(JSON.stringify({ event: "counter_read_failed", attempt, error: String(error) }));
      if (error instanceof SourceAccessDenied || attempt === 3) throw error;
      await delay(attempt * 2_000);
    }
  }
  throw new Error("Unreachable collection state");
}
