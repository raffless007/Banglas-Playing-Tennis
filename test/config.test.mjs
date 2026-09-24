import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const index = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const api = await readFile(new URL("../netlify/functions/api.mjs", import.meta.url), "utf8");
const sw = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const schema = await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const badgePresets = await readFile(new URL("../supabase/migrations/045_badge_rule_presets.sql", import.meta.url), "utf8");

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
});

test("admin sessions remain backward-compatible and fail closed", () => {
  assert.match(api, /ADMIN_SERVER_IDLE_MS/);
  assert.match(api, /admin_sessions/);
  assert.match(api, /Legacy tokens have no server-side session id/);
  assert.match(api, /Admin passcode is not configured/);
  assert.doesNotMatch(api, /INITIAL_ADMIN_PASSCODE \|\| ["']1234/);
});

test("live point retries are idempotent and schema-backed", () => {
  assert.match(api, /live_point_actions/);
  assert.match(api, /validActionId/);
  assert.match(index, /actionId/);
  assert.match(schema, /create table if not exists public\.live_point_actions/);
  assert.match(schema, /active_scorer_id/);
});

test("startup failures cannot leave the loading overlay covering the app", () => {
  assert.match(index, /catch\(error\).*loading.*classList\.add\('hidden'\)/s);
  assert.match(index, /setInterval\(pollSyncVersion,300000\)/);
  assert.match(sw, /bpt-shell-v3/);
});

test("high-risk production constants are not accidentally reduced", () => {
  assert.match(api, /MEDIA_TOTAL_BYTES\s*=\s*5\s*\*\s*1024\s*\*\s*1024\s*\*\s*1024/);
  assert.match(api, /SCORING_WINDOW_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
});

test("badge rules support recent samples, payment deadlines, and editable maximum wins", () => {
  assert.match(index, /matchWindow\?m\.recentMatches\.slice\(0,matchWindow\):m\.recentMatches/);
  assert.match(index, /attendanceWindow\?m\.completedEvents\.slice\(0,attendanceWindow\):m\.attendanceEvents/);
  assert.match(index, /paymentRateWithin\(def\.payment_within_hours\)/);
  assert.match(index, /name="maxWins"/);
  assert.match(index, /MATCH SAMPLE — MOST RECENT N/);
  assert.match(index, /SESSION SAMPLE — MOST RECENT N/);
  assert.match(api, /max_wins: maxWins/);
  assert.match(api, /payment_within_hours: paymentWithinHours/);
  assert.match(badgePresets, /where name = 'Form King';/);
  assert.match(badgePresets, /where name = 'Disgrace';/);
  assert.match(badgePresets, /match_window = 5/);
  assert.match(badgePresets, /payment_within_hours = 24/);
});

test("badge notifications only announce assignments and removals", () => {
  assert.match(api, /New badge earned/);
  assert.match(api, /Badge removed/);
  assert.doesNotMatch(api, /Badge criteria updated/);
  assert.doesNotMatch(api, /badge-edited:/);
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
