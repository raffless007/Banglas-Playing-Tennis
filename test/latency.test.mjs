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

test("server sessions survive reopening at 30 minutes and enforce the new idle limits", async () => {
  for (const [type, minutes, expected] of [
    ["player", 30, 200], ["player", 23 * 60 + 59, 200], ["player", 24 * 60, 401],
    ["admin", 30, 200], ["admin", 59, 200], ["admin", 60, 401],
  ]) {
    const app = fixture();
    app.state.lastSeen = new Date(Date.now() - minutes * 60000).toISOString();
    const response = type === "admin"
      ? await app.request("admin-state", type)
      : await app.request("notification-read-all", type, "POST", { playerId });
    assert.equal(response.status, expected, `${type} session idle for ${minutes} minutes`);
  }
  const revoked = fixture();
  revoked.state.revoked = true;
  assert.equal((await revoked.request("notification-read-all", "player", "POST", { playerId })).status, 401);
});

test("frontend and backend idle limits match, including expiry messages", () => {
  const server = new Function(`${apiSource.match(/const PLAYER_SERVER_IDLE_MS[^;]*;/)[0]}\n${apiSource.match(/const ADMIN_SERVER_IDLE_MS[^;]*;/)[0]}\nreturn [PLAYER_SERVER_IDLE_MS,ADMIN_SERVER_IDLE_MS];`)();
  const client = new Function(`${index.match(/const PLAYER_SESSION_IDLE_MS[^;]*;/)[0]}\nreturn [PLAYER_SESSION_IDLE_MS,ADMIN_SESSION_IDLE_MS];`)();
  assert.deepEqual(server, [24 * 3600000, 3600000]);
  assert.deepEqual(client, server);
  assert.doesNotMatch(index, /session expired after (15|10) minutes/);
});

function memoryStore() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
function adminStore(localStorage, sessionStorage) {
  const source = index.slice(index.indexOf("    const adminSessionStore="), index.indexOf("    let data="));
  return new Function("localStorage", "window", `${source};return adminSessionStore;`)(localStorage, { sessionStorage });
}

test("admin storage migrates legacy tabs and survives app close, then clears on lock", () => {
  const local = memoryStore(), legacy = memoryStore();
  legacy.setItem("bpt-admin-token", "synthetic-admin");
  legacy.setItem("bpt-admin-last-activity", "12345");
  const first = adminStore(local, legacy);
  assert.equal(first.getItem("bpt-admin-token"), "synthetic-admin");
  assert.equal(first.getItem("bpt-admin-last-activity"), "12345");
  assert.equal(legacy.getItem("bpt-admin-token"), null);
  const reopened = adminStore(local, memoryStore());
  assert.equal(reopened.getItem("bpt-admin-token"), "synthetic-admin");
  assert.equal(reopened.getItem("bpt-admin-last-activity"), "12345", "Reopening must not reset the idle clock");
  reopened.removeItem("bpt-admin-token");
  reopened.removeItem("bpt-admin-last-activity");
  assert.equal(adminStore(local, memoryStore()).getItem("bpt-admin-token"), null);
});

function timerFixture(minutes) {
  const now = Date.now(), local = memoryStore(), session = memoryStore(), messages = [];
  local.setItem("bpt-player-last-activity", now - minutes * 60000);
  local.setItem("bpt-admin-last-activity", now - minutes * 60000);
  local.setItem("bpt-admin-token", "admin");
  const context = { localStorage: local, adminSessionStore: adminStore(local, session),
    playerToken: "player", adminToken: "admin", adminDirty: false, adminPlayers: [], adminGuestHistory: [], loginPromptRun: false,
    Date: class extends Date { static now() { return now; } }, setInterval: () => 1, clearInterval() {},
    renderPlayerChooser() {}, renderAdmin() {}, renderMedia() {},
    $: () => ({ classList: { remove() {} } }), notify: message => messages.push(message) };
  const source = index.slice(index.indexOf("    const PLAYER_SESSION_IDLE_MS="), index.indexOf("    function notify("));
  const timer = new Function("context", `with(context){${source};return {resume:checkSessionOnResume,lock:lockAdminSession};}`)(context);
  return { context, timer, messages, local };
}

test("frontend resume and manual lock enforce the intended timers without misleading messages", () => {
  const halfHour = timerFixture(30);
  halfHour.timer.resume();
  assert.equal(halfHour.context.playerToken, "player");
  assert.equal(halfHour.context.adminToken, "admin");
  assert.deepEqual(halfHour.messages, []);
  const oneHour = timerFixture(60);
  oneHour.timer.resume();
  assert.equal(oneHour.context.playerToken, "player");
  assert.equal(oneHour.context.adminToken, null);
  assert.equal(oneHour.local.getItem("bpt-admin-token"), null);
  assert.match(oneHour.messages[0], /1 hour/);
  const day = timerFixture(24 * 60);
  day.timer.resume();
  assert.equal(day.context.playerToken, null);
  assert.match(day.messages[0], /24 hours/);
  halfHour.timer.lock();
  assert.equal(halfHour.context.adminToken, null);
  assert.deepEqual(halfHour.messages, ["Admin locked."]);
  assert.match(index, /function switchPlayerLogin\(\)\{if\(adminToken\)expireAdminSession\(false\)/);
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
