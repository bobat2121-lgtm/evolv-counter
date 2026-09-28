import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import worker, { createHandler, isAuthorized } from "../src/index.ts";
import { REPORT_KEY, XLSX_TYPE } from "../src/report.ts";
import { syntheticD1Store } from "./d1-fixture.ts";
import { NOW, syntheticSnapshot } from "./fixtures.ts";

const token = "synthetic-test-token-with-at-least-32-characters";
const adminToken = "synthetic-admin-secret-with-at-least-32-characters";
const url = `https://example.invalid/${REPORT_KEY}`;

test("public landing page protects its scripts and never embeds or persists access secrets", async () => {
  const env = { DOWNLOAD_TOKEN: token, ADMIN_TOKEN: adminToken } as Env;
  const response = await worker.fetch(new Request("https://example.invalid/"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  const policy = response.headers.get("Content-Security-Policy")!;
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /form-action 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  const nonce = policy.match(/script-src 'nonce-([^']+)'/)?.[1];
  assert.ok(nonce);
  const html = await response.text();
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.match(html, /type="password"/);
  assert.equal(html.includes(token), false);
  assert.equal(html.includes(adminToken), false);
  assert.doesNotMatch(html, /localStorage|sessionStorage|document\.cookie/);
});

test("download authorization requires exact bearer token and an adequately configured secret", async () => {
  assert.equal(await isAuthorized(new Request(url, { headers: { Authorization: `Bearer ${token}` } }), token), true);
  for (const [header, secret] of [
    [undefined, token],
    [`Bearer ${token}x`, token],
    [`Basic ${token}`, token],
    [`Bearer ${token}`, undefined],
    ["Bearer short", "short"],
    [`Bearer ${"x".repeat(600)}`, token],
  ] as const) {
    const request = new Request(url, { headers: header ? { Authorization: header } : {} });
    assert.equal(await isAuthorized(request, secret), false);
  }
});

test("unauthorized report routes cannot read storage, including query-string tokens", async () => {
  let reads = 0;
  const env = {
    DOWNLOAD_TOKEN: token,
    DB: { prepare() { reads++; throw new Error("Storage must not be read"); } },
  } as unknown as Env;
  const requestUrls = [url, `${url}?token=${token}`];
  for (const requestUrl of requestUrls) {
    const response = await worker.fetch(new Request(requestUrl), env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("WWW-Authenticate"), "Bearer");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  const missingSecret = await worker.fetch(new Request(url, { headers: { Authorization: `Bearer ${token}` } }), { ...env, DOWNLOAD_TOKEN: "" });
  assert.equal(missingSecret.status, 401);
  assert.equal(reads, 0);
});

test("report download exports current D1 history with private non-cacheable headers", async () => {
  const { database, store } = syntheticD1Store();
  await store.insert({ ...syntheticSnapshot(), scheduledAt: new Date(NOW).toISOString() });
  const env = {
    DOWNLOAD_TOKEN: token,
    DB: database,
  } as unknown as Env;
  const response = await worker.fetch(new Request(url, { headers: { Authorization: `Bearer ${token}` } }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), XLSX_TYPE);
  assert.equal(response.headers.get("Content-Disposition"), `attachment; filename="${REPORT_KEY}"`);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()) as never);
  assert.equal(workbook.getWorksheet("Screening counts")!.getCell("C2").value, syntheticSnapshot().peopleScreened);
  assert.equal(workbook.getWorksheet("Screening counts")!.getCell("D2").value, syntheticSnapshot().bagsScreened);
});

test("health, missing report, unknown routes and disallowed methods return explicit status", async () => {
  const { database } = syntheticD1Store();
  const env = { DOWNLOAD_TOKEN: token, DB: database } as unknown as Env;
  const health = await worker.fetch(new Request("https://example.invalid/health"), env);
  assert.deepEqual(await health.json(), { ok: true });
  const missing = await worker.fetch(new Request(url, { headers: { Authorization: `Bearer ${token}` } }), env);
  assert.equal(missing.status, 404);
  assert.equal((await worker.fetch(new Request("https://example.invalid/unknown"), env)).status, 404);
  const method = await worker.fetch(new Request(url, { method: "POST" }), env);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("Allow"), "GET");
});

test("report export failure returns sanitized 503 without changing stored observations", async () => {
  const { database, store, rows } = syntheticD1Store();
  await store.insert({ ...syntheticSnapshot(), scheduledAt: new Date(NOW).toISOString() });
  // Simulate a temporary read outage while the already committed row remains.
  const env = { DOWNLOAD_TOKEN: token, DB: {
    prepare() { throw new Error("synthetic-sensitive-export-detail"); },
  } } as unknown as Env;
  const response = await worker.fetch(new Request(url, { headers: { Authorization: `Bearer ${token}` } }), env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.doesNotMatch(await response.text(), /synthetic-sensitive-export-detail/);
  assert.equal(rows.size, 1);
  const recovered = await worker.fetch(new Request(url, { headers: { Authorization: `Bearer ${token}` } }), { ...env, DB: database });
  assert.equal(recovered.status, 200);
});

test("manual collection requires POST and the separate admin secret before invoking collector", async () => {
  let collections = 0;
  const handler = createHandler(async (_env, scheduledTime) => {
    collections++;
    return { scheduledAt: new Date(scheduledTime).toISOString(), alreadyRecorded: false };
  });
  const env = { DOWNLOAD_TOKEN: token, ADMIN_TOKEN: adminToken } as Env;
  const path = "https://example.invalid/admin/collect";
  for (const bearer of [undefined, token, `${adminToken}wrong`]) {
    const response = await handler.fetch(new Request(path, {
      method: "POST", headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    }), env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
  const missingSecret = await handler.fetch(new Request(path, {
    method: "POST", headers: { Authorization: `Bearer ${adminToken}` },
  }), { ...env, ADMIN_TOKEN: "" });
  assert.equal(missingSecret.status, 401);
  const wrongMethod = await handler.fetch(new Request(path, {
    headers: { Authorization: `Bearer ${adminToken}` },
  }), env);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("Allow"), "POST");
  assert.equal(collections, 0);
  const authorized = await handler.fetch(new Request(path, {
    method: "POST", headers: { Authorization: `Bearer ${adminToken}` },
  }), env);
  assert.equal(authorized.status, 200);
  assert.equal(collections, 1);
});

test("manual response awaits collection and reports the actual invocation timestamp", async () => {
  let releaseCollection!: () => void;
  const holdCollection = new Promise<void>(resolve => { releaseCollection = resolve; });
  let enterCollector!: () => void;
  const collectorEntered = new Promise<void>(resolve => { enterCollector = resolve; });
  let receivedTime = 0;
  const env = { DOWNLOAD_TOKEN: token, ADMIN_TOKEN: adminToken } as Env;
  const handler = createHandler(async (actualEnv, scheduledTime) => {
    assert.equal(actualEnv, env);
    receivedTime = scheduledTime;
    enterCollector();
    await holdCollection;
    return { scheduledAt: new Date(scheduledTime).toISOString(), alreadyRecorded: false };
  });
  const before = Date.now();
  let responseResolved = false;
  const pendingResponse = handler.fetch(new Request("https://example.invalid/admin/collect", {
    method: "POST", headers: { Authorization: `Bearer ${adminToken}` },
  }), env).then(response => { responseResolved = true; return response; });
  await collectorEntered;
  assert.equal(responseResolved, false, "response must remain pending until collection completes");
  assert.ok(receivedTime >= before && receivedTime <= Date.now());
  releaseCollection();
  const response = await pendingResponse;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    ok: true, trigger: "manual", scheduledAt: new Date(receivedTime).toISOString(), alreadyRecorded: false,
  });
});

test("manual collection failure returns sanitized 502 with its attempted timestamp", async () => {
  const detail = "synthetic-sensitive-upstream-detail";
  let receivedTime = 0;
  const handler = createHandler(async (_env, scheduledTime) => {
    receivedTime = scheduledTime;
    throw new Error(detail);
  });
  const response = await handler.fetch(new Request("https://example.invalid/admin/collect", {
    method: "POST", headers: { Authorization: `Bearer ${adminToken}` },
  }), { DOWNLOAD_TOKEN: token, ADMIN_TOKEN: adminToken } as Env);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json() as { ok: boolean; error: string; scheduledAt: string };
  assert.equal(body.ok, false);
  assert.equal(body.scheduledAt, new Date(receivedTime).toISOString());
  assert.match(body.error, /Check Workers Logs/);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(detail));
});

test("JSON history requires the download secret and rejects an admin token before accessing D1", async () => {
  let reads = 0;
  const env = {
    DOWNLOAD_TOKEN: token, ADMIN_TOKEN: adminToken,
    DB: { prepare() { reads++; throw new Error("Storage must not be read"); } },
  } as unknown as Env;
  for (const bearer of [undefined, adminToken]) {
    const response = await worker.fetch(new Request("https://example.invalid/data.json", {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    }), env);
    assert.equal(response.status, 401);
  }
  const queryToken = await worker.fetch(new Request(`https://example.invalid/data.json?token=${token}`), env);
  assert.equal(queryToken.status, 401);
  assert.equal(reads, 0);
});

test("JSON history retains numeric totals and picks latest by observation time rather than schedule order", async () => {
  const { database, store } = syntheticD1Store();
  const observedLatest = {
    ...syntheticSnapshot(), scheduledAt: new Date(NOW).toISOString(), observedAt: "2026-09-29T00:01:00.000Z",
  };
  const scheduledLatest = {
    ...syntheticSnapshot(), scheduledAt: new Date(NOW + 12 * 60 * 60 * 1000).toISOString(), observedAt: "2026-09-29T00:00:20.000Z",
  };
  await store.insert(observedLatest);
  await store.insert(scheduledLatest);
  const before = Date.now();
  const response = await worker.fetch(new Request("https://example.invalid/data.json", {
    headers: { Authorization: `Bearer ${token}` },
  }), { DOWNLOAD_TOKEN: token, ADMIN_TOKEN: adminToken, DB: database } as Env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const body = await response.json() as Record<string, any>;
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.source, "https://evolv.com/");
  assert.deepEqual(body.scheduleUtc, ["00:00", "12:00"]);
  assert.equal(body.count, 2);
  assert.deepEqual(body.latest, observedLatest);
  assert.deepEqual(body.snapshots, [observedLatest, scheduledLatest]);
  assert.equal(typeof body.latest.peopleScreened, "number");
  assert.ok(Date.parse(body.generatedAt) >= before && Date.parse(body.generatedAt) <= Date.now());
});

test("empty JSON history is explicit and failed reads return sanitized 503", async () => {
  const { database } = syntheticD1Store();
  const request = () => new Request("https://example.invalid/data.json", { headers: { Authorization: `Bearer ${token}` } });
  const empty = await worker.fetch(request(), { DOWNLOAD_TOKEN: token, ADMIN_TOKEN: adminToken, DB: database } as Env);
  const body = await empty.json() as Record<string, any>;
  assert.equal(empty.status, 200);
  assert.equal(body.count, 0);
  assert.equal(body.latest, null);
  assert.deepEqual(body.snapshots, []);
  const failure = await worker.fetch(request(), {
    DOWNLOAD_TOKEN: token, ADMIN_TOKEN: adminToken,
    DB: { prepare() { throw new Error("synthetic-sensitive-database-detail"); } },
  } as unknown as Env);
  assert.equal(failure.status, 503);
  assert.equal(failure.headers.get("Cache-Control"), "no-store");
  const errorBody = await failure.json() as Record<string, any>;
  assert.equal(errorBody.ok, false);
  assert.match(errorBody.error, /temporarily unavailable/);
  assert.doesNotMatch(JSON.stringify(errorBody), /synthetic-sensitive-database-detail/);
});
