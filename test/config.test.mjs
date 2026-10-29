import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const runtime = await readFile(new URL("../public/js/app.js", import.meta.url), "utf8");
const index = `${html}\n${runtime}`;
const api = await readFile(new URL("../netlify/functions/api.mjs", import.meta.url), "utf8");
const sw = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const schema = await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const badgePresets = await readFile(new URL("../supabase/migrations/045_badge_rule_presets.sql", import.meta.url), "utf8");
const freshLegsMigration = await readFile(new URL("../supabase/migrations/047_fresh_legs_max_matches.sql", import.meta.url), "utf8");
const badgeRangesMigration = await readFile(new URL("../supabase/migrations/048_badge_criteria_ranges.sql", import.meta.url), "utf8");
const mobile = await readFile(new URL("../public/js/mobile-first.js", import.meta.url), "utf8");
const mobileCss = await readFile(new URL("../public/css/mobile-first.css", import.meta.url), "utf8");
const reliabilityClient = await readFile(new URL("../public/js/scoring-reliability.js", import.meta.url), "utf8");

test("Scores defaults to the latest started session, otherwise the latest completed week", () => {
  const definition = runtime.match(/function defaultResultsEvent\(events\)\{[^\n]*\}/)?.[0];
  assert.ok(definition, "defaultResultsEvent should remain directly testable");
  let now = Date.parse("2026-10-28T09:59:00Z");
  class Clock extends Date { static now() { return now; } }
  const previous = { id: "previous", startAt: "2026-10-21T09:00:00Z", endAt: "2026-10-21T11:00:00Z" };
  const current = { id: "current", startAt: "2026-10-28T10:00:00Z", endAt: "2026-10-28T12:00:00Z" };
  const next = { id: "next", startAt: "2026-11-04T10:00:00Z", endAt: "2026-11-04T12:00:00Z" };
  const choose = new Function("Date", "eventMoment", "startTime", "latestCompleted", "eventEndTimestamp", `${definition}; return defaultResultsEvent;`)(
    Clock,
    event => new Date(event.startAt),
    () => "start",
    events => [...events].filter(event => Date.parse(event.endAt) <= Clock.now()).sort((a, b) => Date.parse(b.endAt) - Date.parse(a.endAt))[0],
    event => Date.parse(event.endAt),
  );
  assert.equal(choose([current, next, previous]).id, "previous", "before first serve, use the most recent completed session");
  now = Date.parse(current.startAt);
  assert.equal(choose([current, next, previous]).id, "current", "as soon as first serve time arrives, use that session");
  now = Date.parse(current.endAt) + 1;
  assert.equal(choose([current, next, previous]).id, "current", "after it ends, the same week is now the latest completed session");
  assert.match(runtime, /scoreEventManuallySelected=true;scoreDraftEventId=null/);
});

test("session selectors center the default with three future and four recent past weeks", () => {
  const defaultDefinition = runtime.match(/function defaultResultsEvent\(events\)\{[^\n]*\}/)?.[0];
  const groupsDefinition = runtime.match(/function sessionPickerGroups\(events,selectedId\)\{[^\n]*\}/)?.[0];
  assert.ok(defaultDefinition && groupsDefinition);
  const now = Date.parse("2026-10-28T10:00:00Z");
  class Clock extends Date { static now() { return now; } }
  const dates = ["2026-11-25", "2026-11-18", "2026-11-11", "2026-11-04", "2026-10-28", "2026-10-21", "2026-10-14", "2026-10-07", "2026-09-30", "2026-09-23"];
  const events = dates.map((date, index) => ({ id: `week-${index}`, event_date: date, start_time: "20:00:00", end_time: "22:00:00", startAt: `${date}T10:00:00Z`, endAt: `${date}T12:00:00Z` }));
  const functions = new Function("Date", "eventMoment", "startTime", "latestCompleted", "eventEndTimestamp", `${defaultDefinition};${groupsDefinition};return {defaultResultsEvent,sessionPickerGroups};`)(
    Clock,
    (event, time) => new Date(time === "start" ? event.startAt : event.endAt),
    () => "start",
    list => [...list].filter(event => Date.parse(event.endAt) <= Clock.now()).sort((a, b) => Date.parse(b.endAt) - Date.parse(a.endAt))[0],
    event => Date.parse(event.endAt),
  );
  const center = functions.defaultResultsEvent(events);
  assert.equal(center.id, "week-4");
  const groups = functions.sessionPickerGroups(events, center.id);
  assert.deepEqual(groups.map(group => group.label), ["Further future sessions", "Next 3 sessions", "Selected session", "Previous 4 sessions", "Earlier sessions"]);
  assert.equal(groups[0].events[0].event_date, "2026-11-25", "future weeks beyond the next three remain available above the current session");
  assert.deepEqual(groups[1].events.map(event => event.event_date), ["2026-11-18", "2026-11-11", "2026-11-04"]);
  assert.equal(groups[2].events[0].id, center.id);
  assert.deepEqual(groups[3].events.map(event => event.event_date), ["2026-10-21", "2026-10-14", "2026-10-07", "2026-09-30"]);
  assert.equal(groups[4].events[0].event_date, "2026-09-23");
});

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
  assert.match(sw, /bpt-shell-v6/);
  assert.match(sw, /\/js\/scoring-reliability\.js/);
  assert.match(sw, /\/css\/mobile-first\.css/);
});

test("high-risk production constants are not accidentally reduced", () => {
  assert.match(api, /MEDIA_TOTAL_BYTES\s*=\s*5\s*\*\s*1024\s*\*\s*1024\s*\*\s*1024/);
  assert.match(api, /SCORING_WINDOW_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
});

test("authenticated players can see payment timestamps for everyone", () => {
  assert.match(api, /paid_at: payment\.paid_at \|\| null/);
  assert.match(index, /paid\?paidStamp\(row\?\.paid_at\):'—'/);
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

test("Form King supersedes Building Form", () => {
  assert.match(index, /formKingQualified=qualified\.some\(def=>def\.name==='Form King'\)/);
  assert.match(index, /def\.name==='Building Form'/);
  assert.match(index, /description:'Won at least 40% of the most recent five completed matches.'/);
  assert.match(index, /min_win_pct:40,match_window:5/);
});

test("profiles expose every earned badge with lightweight graphics", () => {
  assert.match(index, /row\.allBadges=playerBadges\(row,true\)/);
  assert.match(index, /BADGE_GRAPHICS/);
  assert.match(index, /badgeCollectionMarkup\(m\)/);
  assert.match(index, /renderAllProfileBadges\(host,id\)/);
  assert.match(index, /renderAllProfileBadges\(\$\('modalContent'\),id\)/);
});

test("Fresh Legs is limited to one through five matches", () => {
  assert.match(index, /name:'Fresh Legs'.*min_played:1,max_played:5/s);
  assert.match(index, /def\.max_played!=null&&m\.played>Number\(def\.max_played\)/);
  assert.match(api, /max_played: maxPlayed/);
  assert.match(index, /name="maxPlayed"/);
  assert.match(freshLegsMigration, /add column if not exists max_played/);
  assert.match(freshLegsMigration, /max_played = 5/);
});

test("badge editor groups optional minimum and maximum ranges", () => {
  assert.match(index, /<legend>Matches<\/legend>/);
  assert.match(index, /<legend>Win rate<\/legend>/);
  assert.match(index, /<legend>Sessions<\/legend>/);
  assert.match(index, /<legend>Point differential<\/legend>/);
  assert.match(index, /'maxWinPct'/);
  assert.match(index, /'maxAttendance'/);
  assert.match(index, /'maxPointDiff'/);
  assert.match(index, /'maxPaidRate'/);
  assert.match(index, /sortOrder:'sort_order'.*minPlayed:'min_played'.*maxPaidRate:'max_paid_rate'/);
  assert.match(api, /max_win_pct: maxWinPct/);
  assert.match(api, /max_attendance: maxAttendance/);
  assert.match(api, /max_point_diff: maxPointDiff/);
  assert.match(api, /max_paid_rate: maxPaidRate/);
  assert.match(badgeRangesMigration, /add column if not exists max_win_pct/);
});

test("badge notifications only announce assignments and removals", () => {
  assert.match(api, /New badge earned/);
  assert.match(api, /Badge removed/);
  assert.doesNotMatch(api, /Badge criteria updated/);
  assert.doesNotMatch(api, /badge-edited:/);
});

test("payment-timed badges wait for the full deadline before evaluating", () => {
  assert.match(index, /paymentWindowPending/);
  assert.match(index, /persisted[\s\S]*badge state untouched/);
  assert.match(index, /paymentRateWithin=hours=>[\s\S]*row\.paymentWindowPending\(cutoff\)\)return null/);
});

test("the extracted app script remains valid and loads before the presentation layer", () => {
  assert.match(html, /<script src="\/js\/app\.js"><\/script>\s*<script src="\/js\/scoring-reliability\.js"><\/script>\s*<script src="\/js\/mobile-first\.js"><\/script>/);
  assert.ok(html.length < 25000, "The HTML shell should not carry the full app runtime");
  assert.doesNotThrow(() => new Function(runtime));
});

test("mobile UI polish preserves navigation and supports payment undo and linked venues", () => {
  assert.match(mobile, /className = 'event-utilities'/);
  assert.doesNotMatch(mobile, /\['scores', 'live', 'Live scoring'/);
  assert.match(mobileCss, /#profilesBoard tbody\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(mobile, /data-undo-payment/);
  assert.match(mobile, /markPaid = async function\(eventId, paid = true\)/);
  assert.match(api, /if \(body\.paid === false\)[\s\S]*method: "DELETE"/);
  assert.match(mobile, /civicDefault/);
  assert.match(reliabilityClient, /Add New Score/);
  assert.match(mobile, /option\.textContent = `\$\{date\} · \$\{sessionStatus\(event\)\}/);
});

test("live scoring uses a stacked session picker and a compact, accessible score card", () => {
  assert.match(mobileCss, /#scoreWeeks\.weeks,#paymentWeeks\.weeks\{display:grid;grid-template-columns:minmax\(0,1fr\);[^}]*overflow:visible/);
  assert.match(mobileCss, /#scoreWeeks select\.session-picker,#paymentWeeks select\.session-picker\{width:100%;min-width:0/);
  assert.doesNotMatch(runtime, /<span class="live-resume-dot"/);
  assert.match(runtime, /data-swap-courts=/);
  assert.match(runtime, /aria-label="Swap the teams’ court sides"/);
  assert.match(runtime, /function liveTeamLabel\(ids,serverId\)/);
  assert.match(runtime, /server-pointer/);
  assert.doesNotMatch(runtime.match(/liveMatchCard=function\(m\)\{[\s\S]*?\n    const originalRenderAdminEvents/)?.[0] || "", /Standard doubles serving order:/);
  assert.match(runtime, /Result saved\. Start another match or finish for now\./);
  assert.match(runtime, /liveSavedNoticeEventId=null;const type=\$\('liveMatchType'\)\.value/);
});
