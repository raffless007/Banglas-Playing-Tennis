import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const index = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const api = await readFile(new URL("../netlify/functions/api.mjs", import.meta.url), "utf8");
const pushReminders = await readFile(new URL("../netlify/functions/push-reminders.mjs", import.meta.url), "utf8");
const emailReminders = await readFile(new URL("../netlify/functions/reminders.mjs", import.meta.url), "utf8");
const reliabilityMigration = await readFile(new URL("../supabase/migrations/036_reliability_security.sql", import.meta.url), "utf8");
const notificationCopyMigration = await readFile(new URL("../supabase/migrations/037_specific_notification_copy.sql", import.meta.url), "utf8");
const schema = await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const serviceWorker = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");

test("security headers and app entry points are present", async () => {
  const netlify = await readFile(new URL("../netlify.toml", import.meta.url), "utf8");
  assert.match(netlify, /Content-Security-Policy/);
  assert.match(netlify, /X-Content-Type-Options/);
  assert.match(index, /serviceWorker\.register/);
});

test("player session protections remain wired", () => {
  assert.match(api, /player_sessions/);
  assert.match(api, /PLAYER_SERVER_IDLE_MS/);
  assert.match(api, /player-logout-all/);
  assert.match(api, /player-create-pin.*Too many PIN setup requests/s);
});

test("admin sessions are typed and server tracked", () => {
  assert.match(api, /type:\s*\"admin\"/);
  assert.match(api, /admin_sessions/);
  assert.match(api, /ADMIN_SERVER_IDLE_MS/);
  assert.match(api, /Admin passcode is not configured/);
  assert.doesNotMatch(api, /INITIAL_ADMIN_PASSCODE \|\| \"1234\"/);
});

test("live point retries carry an idempotency key", () => {
  assert.match(api, /live_point_actions/);
  assert.match(index, /actionId/);
  assert.match(index, /queued points?/);
});

test("reliability migration protects sessions and point replay", () => {
  assert.match(reliabilityMigration, /admin_sessions/);
  assert.match(reliabilityMigration, /live_point_actions/);
  assert.match(reliabilityMigration, /active_scorer_id/);
});

test("public state redacts private collections and contact details", () => {
  assert.match(api, /const authenticated = admin \|\| Boolean\(playerId\)/);
  assert.match(api, /email: admin \|\| player\.id === playerId \?/);
  assert.match(api, /if \(!admin && !playerId\) return reply\(\{ media: \[\]/);
});

test("service worker refreshes deployed helper assets", () => {
  assert.match(serviceWorker, /bpt-shell-v2/);
  assert.match(serviceWorker, /request\.destination/);
  assert.match(serviceWorker, /try \{ data = event\.data \? event\.data\.json\(\) : \{\}; \} catch \{ return; \}/);
});

test("high-risk production constants are not accidentally reduced", () => {
  assert.match(api, /MEDIA_TOTAL_BYTES\s*=\s*5\s*\*\s*1024\s*\*\s*1024\s*\*\s*1024/);
  assert.match(api, /SCORING_WINDOW_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.doesNotMatch(api, /events\?event_date=gte\.\$\{today\}&court_fee=eq\.52/);
});

test("historical payment amounts are preserved when payments are re-confirmed", () => {
  assert.match(api, /payments\?event_id=eq\.\$\{encodeURIComponent\(body\.eventId\)\}&player_id=eq\.\$\{encodeURIComponent\(body\.playerId\)\}&select=amount,paid/);
  assert.match(api, /Number\.isFinite\(Number\(existingPayment\?\.amount\)\)/);
  assert.match(api, /const calculatedAmount = Number\(\(totalCourtFee\(event\) \/ attending\.length/);
});

test("automated notifications include session context", () => {
  assert.match(api, /Payment due · \$\{eventLabel\(event\)\}/);
  assert.match(api, /Session updated · \$\{eventLabel\(updated\)\}/);
  assert.match(pushReminders, /EOI closes tomorrow · \$\{label\}/);
  assert.match(pushReminders, /Location: \$\{values\.location\}/);
  assert.match(notificationCopyMigration, /payment-30m/);
  assert.match(notificationCopyMigration, /\{location\}/);
  assert.match(schema, /Payment due · \{date\}/);
  assert.match(schema, /group_key text/);
  assert.match(schema, /create table if not exists public\.admin_sessions/);
  assert.match(schema, /create table if not exists public\.live_point_actions/);
});

test("deferred payment emails are opt-in and disabled by default", () => {
  assert.match(emailReminders, /ENABLE_EMAIL_REMINDERS === "true"/);
  assert.match(emailReminders, /Email reminders are disabled/);
});

test("the inline app script remains valid JavaScript", () => {
  const inlineScripts = [...index.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .filter((source) => source.trim());
  assert.ok(inlineScripts.length, "Expected an inline app script.");
  for (const source of inlineScripts) {
    assert.doesNotThrow(() => new Function(source));
  }
});
