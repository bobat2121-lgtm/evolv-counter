import { timingSafeEqual } from "node:crypto";
import { readLiveSnapshot } from "./browser.ts";
import { runScheduled } from "./job.ts";
import { SOURCE_URL } from "./parser.ts";
import { REPORT_KEY, XLSX_TYPE, createWorkbook } from "./report.ts";
import { createStore } from "./store.ts";

export async function isAuthorized(request: Request, expected: string | undefined): Promise<boolean> {
  if (!expected || expected.length < 32) return false;
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ") || header.length > 512) return false;
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(header.slice(7))),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return timingSafeEqual(new Uint8Array(actualHash), new Uint8Array(expectedHash));
}

type CollectionResult = Awaited<ReturnType<typeof runScheduled>>;
export type Collector = (env: Env, scheduledTime: number) => Promise<CollectionResult>;

async function collectAndStore(env: Env, scheduledTime: number): Promise<CollectionResult> {
  const store = createStore(env.DB);
  // D1 is the durable record. Excel is generated from that history on download.
  return runScheduled(scheduledTime, store,
    () => readLiveSnapshot(env.BROWSER), async () => {});
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401, headers: {
    "WWW-Authenticate": "Bearer", "Cache-Control": "no-store",
  } });
}

function landingPage(sourceStatus: string): Response {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Evolv screening counts</title>
<style nonce="${nonce}">
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#173149;background:#f3f6f8;color-scheme:light}*{box-sizing:border-box}body{margin:0;padding:48px 20px}main{max-width:640px;margin:6vh auto;background:white;border:1px solid #d9e3e9;border-radius:18px;padding:40px;box-shadow:0 16px 48px #1731490a}.eyebrow{font-size:12px;font-weight:750;letter-spacing:.14em;text-transform:uppercase;color:#39746f}h1{font-size:34px;line-height:1.15;letter-spacing:-.03em;margin:16px 0}p{line-height:1.6;color:#496174}.schedule{margin:24px 0;padding:14px 16px;border-radius:10px;background:#eef6f4;color:#255a54;font-size:14px}label{display:block;font-weight:650;margin-bottom:8px}input{display:block;width:100%;border:1px solid #9eafbd;border-radius:8px;padding:13px;font:inherit}input:focus{outline:3px solid #b8dbd4;outline-offset:2px}button{margin-top:14px;width:100%;border:0;border-radius:8px;padding:14px;background:#17655a;color:white;font:inherit;font-weight:700;cursor:pointer}button:disabled{opacity:.6;cursor:wait}#status{font-size:14px;min-height:44px;margin:16px 0}.note{font-size:13px;border-top:1px solid #e2e9ed;padding-top:22px;margin-bottom:0}@media(max-width:480px){body{padding:16px}main{padding:26px;margin:4vh auto}h1{font-size:29px}}
</style></head><body><main>
<div class="eyebrow">Private report</div><h1>Evolv screening counts</h1>
<p>Download the history of people and bags screened, as displayed on the Evolv homepage.</p>
<div class="schedule">Collection scheduled for <strong>00:00 and 12:00 UTC</strong> every day.</div>
${sourceStatus === "blocked_by_source" ? '<p role="note"><strong>Automatic collection is currently blocked by Evolv.</strong> The workbook contains a manual browser observation. New automatic readings require approved access to the source.</p>' : ''}
<form id="download-form" method="post" autocomplete="off">
<label for="access-key">Access key</label><input id="access-key" name="access-key" type="password" autocomplete="off" required minlength="32" maxlength="505" spellcheck="false">
<button id="download-button" type="submit">Download Excel</button></form>
<p id="status" role="status" aria-live="polite">Enter your private access key to download the latest workbook. Your key is not saved by this page.</p>
<p class="note">These are animated homepage counts, not independently verified screening records. The workbook includes observation times and source readings.</p>
</main><script nonce="${nonce}">
const form=document.getElementById("download-form");
const keyInput=document.getElementById("access-key");
const button=document.getElementById("download-button");
const status=document.getElementById("status");
form.addEventListener("submit",async(event)=>{
  event.preventDefault();button.disabled=true;status.textContent="Preparing your workbook…";
  try{
    const response=await fetch("/${REPORT_KEY}",{headers:{Authorization:"Bearer "+keyInput.value.trim()},cache:"no-store"});
    if(!response.ok){
      status.textContent=response.status===401?"That access key was not accepted.":response.status===404?"No readings have been collected yet.":"The report is temporarily unavailable. Please try again.";
      return;
    }
    const downloadUrl=URL.createObjectURL(await response.blob());
    const link=document.createElement("a");link.href=downloadUrl;link.download="${REPORT_KEY}";
    document.body.appendChild(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(downloadUrl),1000);
    status.textContent="Your workbook has been downloaded.";
  }catch{status.textContent="The download could not connect. Please try again.";}
  finally{button.disabled=false;}
});
</script></body></html>`;
  return new Response(html, { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  } });
}

// The injected collector lets route tests verify authorization and completion
// behavior without opening a browser or writing Cloudflare resources.
export function createHandler(collect: Collector = collectAndStore) {
  return {
  async scheduled(controller, env) {
    try {
      const result = await collect(env, controller.scheduledTime);
      console.log(JSON.stringify({ event: "snapshot_saved", ...result }));
    } catch (error) {
      console.error(JSON.stringify({ event: "scheduled_job_failed", error: String(error) }));
      throw error;
    }
  },
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/admin/collect") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
      if (!(await isAuthorized(request, env.ADMIN_TOKEN))) return unauthorized();
      // A manual run gets its actual invocation time, not a fabricated cron slot.
      const scheduledTime = Date.now();
      try {
        const result = await collect(env, scheduledTime);
        console.log(JSON.stringify({ event: "manual_snapshot_saved", ...result }));
        return Response.json({ ok: true, trigger: "manual", ...result }, {
          headers: { "Cache-Control": "private, no-store" },
        });
      } catch (error) {
        const scheduledAt = new Date(scheduledTime).toISOString();
        console.error(JSON.stringify({ event: "manual_collection_failed", scheduledAt, error: String(error) }));
        return Response.json({ ok: false, error: "Collection failed. Check Workers Logs.", scheduledAt }, {
          status: 502, headers: { "Cache-Control": "no-store" },
        });
      }
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
    if (path === "/") return landingPage(env.SOURCE_ACCESS_STATUS);
    if (path === "/health") return Response.json({ ok: true, sourceAccessStatus: env.SOURCE_ACCESS_STATUS });
    if (path !== `/${REPORT_KEY}` && path !== "/data.json") return new Response("Not found", { status: 404 });
    if (!(await isAuthorized(request, env.DOWNLOAD_TOKEN))) return unauthorized();
    if (path === "/data.json") {
      try {
        const snapshots = await createStore(env.DB).list();
        const latest = snapshots.reduce<(typeof snapshots)[number] | null>((newest, row) =>
          !newest || row.observedAt > newest.observedAt ? row : newest, null);
        return Response.json({
          schemaVersion: 1, source: SOURCE_URL, scheduleUtc: ["00:00", "12:00"],
          sourceAccessStatus: env.SOURCE_ACCESS_STATUS,
          generatedAt: new Date().toISOString(), count: snapshots.length, latest, snapshots,
        }, { headers: { "Cache-Control": "private, no-store" } });
      } catch (error) {
        console.error(JSON.stringify({ event: "data_read_failed", error: String(error) }));
        return Response.json({ ok: false, error: "Stored observations are temporarily unavailable." }, {
          status: 503, headers: { "Cache-Control": "no-store" },
        });
      }
    }
    try {
      const snapshots = await createStore(env.DB).list();
      if (!snapshots.length) return new Response("No report has been collected yet", {
        status: 404, headers: { "Cache-Control": "no-store" },
      });
      const bytes = await createWorkbook(snapshots);
      return new Response(bytes, { headers: {
        "Content-Type": XLSX_TYPE,
        "Content-Disposition": `attachment; filename="${REPORT_KEY}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      } });
    } catch (error) {
      console.error(JSON.stringify({ event: "report_generation_failed", error: String(error) }));
      return Response.json({ ok: false, error: "The Excel report is temporarily unavailable." }, {
        status: 503, headers: { "Cache-Control": "no-store" },
      });
    }
  },
  } satisfies ExportedHandler<Env>;
}

export default createHandler();
