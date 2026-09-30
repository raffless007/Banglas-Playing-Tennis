import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";

const apiSource = await readFile(new URL("../netlify/functions/api.mjs", import.meta.url), "utf8");
const index = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const secret = "isolated-latency-test-secret";
const playerId = "test-player";
const sessionId = "test-session";

function token(type) {
  const payload = Buffer.from(JSON.stringify({ type, sub: playerId, sid: sessionId, iat: Date.now(), exp: Date.now() + 3600000 })).toString("base64url");
  return `${payload}.${crypto.createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

// Execute the actual handler with synthetic external boundaries. This never
// reads production credentials, sends network requests, or writes a database.
function fixture(source = apiSource, delay = 0) {
  const calls = [];
  const state = { revoked: false, active: true, pinUpdatedAt: null, lastSeen: new Date().toISOString() };
  const events = Array.from({ length: 40 }, (_, offset) => {
    const day = new Date(); day.setUTCDate(day.getUTCDate() + offset);
    return { id: `week-${offset}`, event_date: day.toISOString().slice(0, 10), start_time: "20:00:00", end_time: "22:00:00", timezone: "Australia/Sydney", court_fee: 54, location: "Synthetic court", suburb: "Test" };
  });
  const fetch = async (input, options = {}) => {
    const url = new URL(input);
    const table = url.pathname.split("/").at(-1);
    const method = options.method || "GET";
    calls.push({ table, method, query: url.searchParams.toString(), started: performance.now() });
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (method !== "GET") return new Response("");
    let rows = [];
    if (table === "players") rows = state.active ? [{ id: playerId, name: "Synthetic player", active: true, pin_hash: "configured", pin_updated_at: state.pinUpdatedAt }] : [];
    if (["admin_sessions", "player_sessions"].includes(table)) rows = state.revoked ? [] : [{ session_id: sessionId, last_seen_at: state.lastSeen }];
    if (table === "events") rows = events;
    return new Response(JSON.stringify(rows));
  };
  const body = source.replace(/^import[\s\S]*?;\n/gm, "").replace(/^export \{[^}]*\};/gm, "").replace("export default async (req) =>", "return async (req) =>");
  const handler = new Function("deps", `const {createHmac,pbkdf2Sync,randomBytes,randomUUID,timingSafeEqual,fetch,process}=deps;\n${body}`)({
    ...crypto, fetch,
    process: { env: { SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic", ADMIN_SESSION_SECRET: secret } },
  });
  function request(action, type, method = "GET", body) {
    const headers = { "content-type": "application/json" };
    if (type === "admin") headers.authorization = `Bearer ${token(type)}`;
    if (type === "player") headers["x-player-session"] = token(type);
    return handler(new Request(`https://app.invalid/?action=${action}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }));
  }
  return { request, calls, state };
}

test("admin state validates and touches its session once per request", async () => {
  const app = fixture();
  const response = await app.request("state", "admin");
  assert.equal(response.status, 200);
  assert.ok((await response.json()).events.length);
  assert.deepEqual(app.calls.filter(call => call.table === "admin_sessions").map(call => call.method), ["GET", "PATCH"]);
  app.state.revoked = true;
  const revoked = await app.request("admin-state", "admin");
  assert.equal(revoked.status, 401, "A new request must observe revocation");
});

test("player validation overlaps independent reads and rejects PIN changes and expired sessions", async () => {
  const app = fixture(apiSource, 15);
  assert.equal((await app.request("notification-read-all", "player", "POST", { playerId })).status, 200);
  const sessionRead = app.calls.find(call => call.table === "player_sessions" && call.method === "GET");
  const playerRead = app.calls.find(call => call.table === "players" && call.method === "GET");
  assert.ok(Math.abs(sessionRead.started - playerRead.started) < 10, "Independent checks should start together");
  app.state.pinUpdatedAt = new Date(Date.now() + 60000).toISOString();
  assert.equal((await app.request("notification-read-all", "player", "POST", { playerId })).status, 401);
  app.state.pinUpdatedAt = null;
  app.state.lastSeen = new Date(Date.now() - 48 * 3600000).toISOString();
  assert.equal((await app.request("notification-read-all", "player", "POST", { playerId })).status, 401);
});

test("badge sync does not repeat player validation inside a request", async () => {
  const app = fixture();
  assert.equal((await app.request("badge-sync", "player", "POST", { playerId, badges: [] })).status, 200);
  assert.deepEqual(app.calls.filter(call => call.table === "player_sessions").map(call => call.method), ["GET", "PATCH"]);
});

test("admin validation overlaps the state data fetches", async () => {
  const app = fixture(apiSource, 15);
  await app.request("state", "admin");
  const auth = app.calls.find(call => call.table === "admin_sessions");
  const history = app.calls.find(call => call.table === "match_scores");
  assert.ok(Math.abs(auth.started - history.started) < 10, "State queries must not wait behind auth round trips");
});

test("live realtime updates fetch only live state; durable changes still refresh", () => {
  const source = index.slice(index.indexOf("    function handleRealtimeChange("), index.indexOf("    function setupRealtimeSync("));
  const calls = [];
  const handle = new Function("pollLiveState", "scheduleRefresh", "adminDirty", "livePointPending", `${source};return handleRealtimeChange;`)(force => calls.push(["live", force]), () => calls.push(["state"]), false, new Map());
  handle({ event: "postgres_changes", payload: { data: { table: "live_matches" } } });
  assert.deepEqual(calls, [["live", true]]);
  handle({ event: "postgres_changes", payload: { data: { table: "match_scores" } } });
  assert.deepEqual(calls, [["live", true], ["state"]]);
  handle({ event: "phx_reply" });
  assert.equal(calls.length, 2);
});

test("hidden or signed-out pages do not issue live and EOI polls", async () => {
  const live = index.slice(index.indexOf("    async function pollLiveState("), index.indexOf("    setInterval(pollLiveState,"));
  const eoi = index.slice(index.indexOf("    async function pollEoiState("), index.indexOf("    setInterval(pollEoiState,"));
  for (const [visibility, playerToken] of [["hidden", "synthetic"], ["visible", null]]) {
    const context = { document: { visibilityState: visibility }, playerToken, adminToken: null,
      livePollInFlight: false, eoiPollInFlight: false, livePointPending: new Map(), eoiPending: new Set(),
      $: () => ({ classList: { contains: () => true } }), request: () => assert.fail("Background request must be skipped") };
    const polls = new Function("context", `with(context){${live}\n${eoi};return [pollLiveState,pollEoiState];}`)(context);
    for (const poll of polls) await poll();
  }
});

test("synthetic before/after latency comparison", async t => {
  let baseline;
  try {
    baseline = execFileSync("git", ["show", "f38dd07:netlify/functions/api.mjs"], { cwd: new URL("..", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    t.skip("Historical baseline is unavailable in this checkout");
    return;
  }
  for (const [action, type, body] of [["state", "admin"], ["badge-sync", "player", { playerId, badges: [] }]]) {
    const results = [];
    for (const [label, source] of [["baseline", baseline], ["candidate", apiSource]]) {
      const app = fixture(source, 30);
      const start = performance.now();
      assert.equal((await app.request(action, type, body ? "POST" : "GET", body)).status, 200);
      results.push({ label, ms: Math.round(performance.now() - start), sessionCalls: app.calls.filter(call => /_sessions$/.test(call.table)).length });
    }
    assert.ok(results[1].sessionCalls < results[0].sessionCalls);
    t.diagnostic(`${type}:${action} simulated 30ms database latency: ${JSON.stringify(results)}`);
  }
});

function mediaFixture() {
  const source = index.slice(index.indexOf("    async function loadMediaState("), index.indexOf("    async function pollLiveState("));
  const requests = [];
  const context = {
    currentPlayerId: "player-a", mediaLoaded: false, mediaLoadedAt: 0,
    mediaLoadedPlayerId: null, mediaLoadInFlight: null, data: { media: [] },
    request: () => new Promise(resolve => requests.push(resolve)),
    $: () => ({ classList: { contains: () => false } }),
    renderMedia() {}, enhanceMediaGallery() {}, go() {}, notify() {},
  };
  const functions = new Function("context", `with(context){${source};return {load:loadMediaState,go};}`)(context);
  return { context, functions, requests };
}

test("media navigation reuses a fresh gallery and does not leak a switched player's response", async () => {
  const { context, functions, requests } = mediaFixture();
  const first = functions.load();
  requests[0]({ media: [{ id: "photo-a", favorite: true }] });
  await first;
  functions.go("media");
  assert.equal(requests.length, 1, "Repeat navigation must not refetch a fresh gallery");
  const oldRequest = functions.load(true);
  context.currentPlayerId = "player-b";
  functions.go("media");
  assert.deepEqual(context.data.media, [], "Clear the previous player's favorites immediately");
  requests[1]({ media: [{ id: "private-a", favorite: true }] });
  await oldRequest;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 3, "Switching during a fetch must request the new player's gallery");
  requests[2]({ media: [{ id: "photo-b", favorite: false }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.data.media[0].id, "photo-b");
  assert.equal(context.mediaLoadedPlayerId, "player-b");
});
