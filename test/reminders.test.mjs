import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pushSource = await readFile(new URL("../netlify/functions/push-reminders.mjs", import.meta.url), "utf8");
const emailSource = await readFile(new URL("../netlify/functions/reminders.mjs", import.meta.url), "utf8");
const api = await readFile(new URL("../netlify/functions/api.mjs", import.meta.url), "utf8");
const now = Date.parse("2026-10-09T12:00:00Z");
class TestDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const event = (id, extra = {}) => ({ id, event_date: "2026-10-07", start_time: "19:30:00", end_time: "22:00:00", timezone: "Australia/Sydney", location: "Synthetic courts", suburb: "Test", court_fee: 54, ball_fee: 1, account_closed: false, cancellation_status: "scheduled", ...extra });

function pushFixture(events, { attendees = true, paidIds = [], bodyTemplate = "{date}: {amount} at {location}", nowMs = now } = {}) {
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [nowMs])); }
    static now() { return nowMs; }
  }
  const queries = [], notifications = [];
  const eois = attendees ? events.map(item => ({ event_id: item.id, player_id: "synthetic-player", status: "yes" })) : [];
  const db = async query => {
    queries.push(query);
    if (query.startsWith("events?")) return events;
    if (query.startsWith("eois?")) return eois;
    if (query.startsWith("payments?")) return paidIds.map(id => ({ event_id: id, player_id: "synthetic-player", paid: true }));
    if (query.startsWith("push_alert_schedules?")) return [{ code: "test-daily", notification_type: "payments", enabled: true, delay_minutes: 30, repeat_interval_minutes: 1440, title_template: "Payment due · {date}", body_template: bodyTemplate }];
    throw new Error(`Unexpected synthetic query: ${query}`);
  };
  const source = pushSource.replace(/^import[^\n]*\n/, "").replace("export default async () =>", "return async () =>").replace("export const config", "const config");
  const run = new Function("db", "activePlayerIds", "notifyPlayers", "pushConfigured", "RAFEED_PLAYER_ID", "Date", "fetch", source)(db, async () => ["synthetic-player"], async payload => notifications.push(payload), () => true, "rafeed-synthetic-id", FixtureDate, () => assert.fail("Weather must not be fetched for deleted/cancelled events"));
  return { run, queries, notifications };
}

test("push reminders ignore deleted, cancelled, closed and paid events but retain real unpaid sessions", async () => {
  const events = [event("deleted", { deleted_at: "2026-10-07T11:57:00Z" }), event("cancelled", { cancellation_status: "cancelled" }), event("closed", { account_closed: true }), event("unpaid"), event("paid")];
  const fixture = pushFixture(events, { paidIds: ["paid"] });
  assert.equal((await fixture.run()).status, 200);
  assert.match(fixture.queries[0], /deleted_at=is\.null/);
  assert.deepEqual(fixture.notifications.map(item => item.eventId), ["unpaid"]);
  assert.equal(fixture.notifications[0].notificationType, "payments");
  assert.match(fixture.notifications[0].title, /7 Oct/);
});

test("payment reminders render legacy escaped currency placeholders as one amount", async () => {
  const fixture = pushFixture([event("legacy-template", { court_fee: 9.43 })], {
    bodyTemplate: "{date}: $\\${amount} is due at {location}",
  });
  await fixture.run();
  assert.equal(fixture.notifications.length, 1);
  assert.match(fixture.notifications[0].body, /\$10\.43 is due/);
  assert.doesNotMatch(fixture.notifications[0].body, /\$\\\$|\$\$/);
});

test("court-booking reminder is sent to Rafeed five days before a scheduled session", async () => {
  const fixture = pushFixture([event("book-court", { event_date: "2026-10-14" })], {
    attendees: false,
    nowMs: Date.parse("2026-10-09T08:30:00Z"),
  });
  await fixture.run();
  const reminder = fixture.notifications.find(item => item.notificationKey === "court-booking-5d:book-court");
  assert.ok(reminder);
  assert.deepEqual(reminder.playerIds, ["rafeed-synthetic-id"]);
  assert.match(reminder.body, /Please book the court/);
});

test("30-hour court reminder asks Rafeed to confirm or cancel the booking", async () => {
  const fixture = pushFixture([event("confirm-court", { event_date: "2026-10-14" })], {
    attendees: false,
    nowMs: Date.parse("2026-10-13T02:30:00Z"),
  });
  await fixture.run();
  const reminder = fixture.notifications.find(item => item.notificationKey === "court-confirm-30h:confirm-court");
  assert.ok(reminder);
  assert.deepEqual(reminder.playerIds, ["rafeed-synthetic-id"]);
  assert.match(reminder.body, /Confirm the booking, or cancel it/);
});

test("deleted and cancelled future sessions cannot send EOI or weather alerts", async () => {
  // At 23:00 Sydney, the next-day 05:30 session has an EOI deadline in 30 min.
  const extra = { event_date: "2026-10-10", start_time: "05:30:00", end_time: "07:30:00" };
  const events = [event("deleted-future", { ...extra, deleted_at: "2026-10-09T00:00:00Z" }), event("cancelled-future", { ...extra, cancellation_status: "cancelled" })];
  for (const attendees of [true, false]) {
    const fixture = pushFixture(events, { attendees });
    await fixture.run();
    assert.deepEqual(fixture.notifications, []);
  }
  const active = pushFixture([event("real-future", extra)], { attendees: false });
  await active.run();
  assert.equal(active.notifications.length, 2, "Existing 24h and 1h EOI reminders must remain active");
});

test("legacy opt-in email reminders also ignore deleted/cancelled sessions", async () => {
  const events = [event("deleted", { deleted_at: "2026-10-07T11:57:00Z" }), event("cancelled", { cancellation_status: "cancelled" }), event("closed", { account_closed: true }), event("real-unpaid")];
  const deliveries = [], queries = [];
  const fetch = async (input, options = {}) => {
    if (input === "https://api.resend.com/emails") {
      deliveries.push(JSON.parse(options.body));
      return new Response("{}", { status: 200 });
    }
    const url = new URL(input), table = url.pathname.split("/").at(-1);
    queries.push(url.search);
    if (options.method === "POST") return new Response("");
    const rows = table === "events" ? events : table === "players" ? [{ id: "synthetic-player", name: "Synthetic Player", email: "synthetic@example.invalid" }] : table === "eois" ? events.map(item => ({ event_id: item.id, player_id: "synthetic-player" })) : [];
    return new Response(JSON.stringify(rows));
  };
  const source = emailSource.replace("export default async () =>", "return async () =>");
  const run = new Function("process", "fetch", "Date", source)({ env: { SUPABASE_URL: "https://synthetic.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic", ENABLE_EMAIL_REMINDERS: "true", RESEND_API_KEY: "synthetic", REMINDER_FROM_EMAIL: "synthetic@example.invalid" } }, fetch, TestDate);
  await run();
  assert.equal(deliveries.length, 1);
  assert.match(queries[0], /deleted_at=is\.null/);
});

test("deleting an event closes reminder eligibility without altering payment records", () => {
  const source = api.slice(api.indexOf("async function deleteEvent("), api.indexOf("async function ", api.indexOf("async function deleteEvent(") + 30));
  assert.match(source, /deleted_at: new Date\(\)\.toISOString\(\), cancellation_status: "cancelled", account_closed: true/);
  assert.doesNotMatch(source, /db\(["'`]payments/);
  const state = api.slice(api.indexOf("async function appState("), api.indexOf("async function playerNotificationState("));
  assert.match(state, /event\.deleted_at \|\| event\.cancellation_status === "cancelled" \|\| event\.account_closed\) continue/);
});
