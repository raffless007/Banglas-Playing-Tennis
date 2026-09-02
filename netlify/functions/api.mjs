import {
  createHmac,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET;
const INITIAL_PASSCODE = process.env.INITIAL_ADMIN_PASSCODE || "1234";
const SYDNEY = "Australia/Sydney";
const MEDIA_BUCKET = "tennis-media";
const MEDIA_MAX_BYTES = 50 * 1024 * 1024;
const MEDIA_TOTAL_BYTES = 1024 * 1024 * 1024;
const SCORING_WINDOW_MS = 24 * 60 * 60 * 1000;

const headers = { "content-type": "application/json; charset=utf-8" };
const reply = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...headers, ...extra } });

function requireConfiguration() {
  if (!SUPABASE_URL || !SERVICE_KEY || !SESSION_SECRET) {
    throw new Error("Server environment variables are not configured.");
  }
}

function storageClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

function eventStartTime(event) {
  return event.court_2_enabled && event.court_2_start_time < event.start_time ? event.court_2_start_time : event.start_time;
}

function eventEndTime(event) {
  return event.court_2_enabled && event.court_2_end_time > event.end_time ? event.court_2_end_time : event.end_time;
}

function totalCourtFee(event) {
  return Number(event.court_fee) + (event.court_2_enabled ? Number(event.court_2_fee || 0) : 0);
}

function scoringWindow(event) {
  const opens = localDateTimeToUtc(event.event_date, eventStartTime(event));
  const closes = new Date(localDateTimeToUtc(event.event_date, eventEndTime(event)).getTime() + SCORING_WINDOW_MS);
  return { opens, closes };
}

function scoringWindowError(event) {
  const now = new Date();
  const { opens, closes } = scoringWindow(event);
  if (now < opens) return "Scoring opens when this week’s session starts.";
  if (now > closes) return "Scoring has closed for this week. It stays open for 24 hours after the session ends.";
  return "";
}

function publicMediaUrl(path) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${SUPABASE_URL}/storage/v1/object/public/${MEDIA_BUCKET}/${encoded}`;
}

async function mediaUsageBytes() {
  const rows = await db("media_items?select=file_size");
  return rows.reduce((sum, item) => sum + Number(item.file_size || 0), 0);
}

async function db(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`Database request failed: ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function datePartsInSydney(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: SYDNEY,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
}

function dateString(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function upcomingWednesdays() {
  const now = datePartsInSydney();
  const local = new Date(Date.UTC(now.year, now.month - 1, now.day));
  let delta = (3 - local.getUTCDay() + 7) % 7;
  if (delta === 0 && now.hour >= 22) delta = 7;
  local.setUTCDate(local.getUTCDate() + delta);
  return Array.from({ length: 4 }, (_, index) => {
    const d = new Date(local);
    d.setUTCDate(d.getUTCDate() + index * 7);
    return dateString(d);
  });
}

async function ensureUpcomingEvents() {
  const deletedDates = new Set((await db("deleted_event_dates?select=event_date")).map(row => row.event_date));
  const events = upcomingWednesdays().filter(event_date => !deletedDates.has(event_date)).map(event_date => ({ event_date }));
  if (events.length) {
    await db("events?on_conflict=event_date", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(events),
    });
  }
  const now = datePartsInSydney();
  const today = `${now.year}-${String(now.month).padStart(2, "0")}-${String(now.day).padStart(2, "0")}`;
  await db(`events?event_date=gte.${today}&court_fee=eq.52`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ court_fee: 54, updated_at: new Date().toISOString() }),
  });
}

function timezoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
  return Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second) - date.getTime();
}

function localDateTimeToUtc(dateText, timeText, timeZone = SYDNEY) {
  const [year, month, day] = dateText.split("-").map(Number);
  const [hour, minute, second = 0] = timeText.split(":").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return new Date(guess.getTime() - timezoneOffsetMs(guess, timeZone));
}

function passcodeHash(passcode, salt = randomBytes(16).toString("hex")) {
  const hash = pbkdf2Sync(passcode, salt, 150000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPasscode(passcode, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, expected] = stored.split(":");
  const actual = pbkdf2Sync(passcode, salt, 150000, 32, "sha256");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function signSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 8 * 60 * 60 * 1000 })).toString("base64url");
  const signature = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function isAdmin(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now(); }
  catch { return false; }
}

async function getEvent(eventId) {
  const rows = await db(`events?id=eq.${encodeURIComponent(eventId)}&select=*`);
  return rows?.[0];
}

async function getPasscodeSetting() {
  const rows = await db("app_settings?key=eq.admin_passcode_hash&select=value");
  return rows?.[0]?.value || null;
}

async function savePasscode(passcode) {
  await db("app_settings?on_conflict=key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: "admin_passcode_hash", value: passcodeHash(passcode), updated_at: new Date().toISOString() }),
  });
}

async function appState() {
  await ensureUpcomingEvents();
  const [players, events, eois, payments, scores, liveMatches, notes, mediaRows] = await Promise.all([
    db("players?select=id,name,active&order=name.asc"),
    db("events?select=*&order=event_date.asc"),
    db("eois?select=event_id,player_id,status,updated_at"),
    db("payments?select=event_id,player_id,amount,paid,paid_at"),
    db("match_scores?select=*&order=created_at.asc"),
    db("live_matches?select=*&order=updated_at.desc"),
    db("event_notes?select=*"),
    db("media_items?select=*&order=captured_at.desc,created_at.desc"),
  ]);
  const media = mediaRows.map(item => ({ ...item, public_url: publicMediaUrl(item.storage_path) }));
  const mediaUsage = media.reduce((sum, item) => sum + Number(item.file_size || 0), 0);
  return { players, events, eois, payments, scores, liveMatches, notes, media, mediaUsage, mediaLimit: MEDIA_TOTAL_BYTES, serverNow: new Date().toISOString() };
}

async function adminState() {
  return { players: await db("players?select=id,name,active&order=name.asc") };
}

async function submitEoi(body) {
  if (!body.playerId || !body.eventId || !["yes", "no"].includes(body.status)) return reply({ error: "Invalid EOI." }, 400);
  const event = await getEvent(body.eventId);
  if (!event) return reply({ error: "Event not found." }, 404);
  const closesAt = new Date(localDateTimeToUtc(event.event_date, eventStartTime(event), event.timezone).getTime() - 6 * 60 * 60 * 1000);
  if (new Date() >= closesAt) return reply({ error: "The EOI deadline has passed." }, 409);
  await db("eois?on_conflict=event_id,player_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ event_id: body.eventId, player_id: body.playerId, status: body.status, updated_at: new Date().toISOString() }),
  });
  return reply({ ok: true });
}

async function markPaid(body) {
  const event = await getEvent(body.eventId);
  if (!event || !body.playerId) return reply({ error: "Event or player not found." }, 404);
  if (new Date() < localDateTimeToUtc(event.event_date, eventEndTime(event), event.timezone)) return reply({ error: "Payments open after the game finishes." }, 409);
  const attending = await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&status=eq.yes&select=player_id`);
  if (!attending.some(row => row.player_id === body.playerId)) return reply({ error: "Only players marked In can confirm payment." }, 403);
  const amount = Number((totalCourtFee(event) / attending.length + Number(event.ball_fee)).toFixed(2));
  await db("payments?on_conflict=event_id,player_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ event_id: body.eventId, player_id: body.playerId, amount, paid: true, paid_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
  });
  return reply({ ok: true, amount });
}

function validTennisScore(gamesA, gamesB, tiebreakA, tiebreakB) {
  if (![gamesA, gamesB].every(value => Number.isInteger(value) && value >= 0 && value <= 4)) return { valid: false };
  const regular = (gamesA === 4 && gamesB <= 2) || (gamesB === 4 && gamesA <= 2);
  if (regular) return { valid: true, tiebreakA: null, tiebreakB: null };
  const tiebreakSet = (gamesA === 4 && gamesB === 3) || (gamesB === 4 && gamesA === 3);
  if (!tiebreakSet || !Number.isInteger(tiebreakA) || !Number.isInteger(tiebreakB)) return { valid: false };
  const aWon = gamesA === 4;
  const winningPoints = aWon ? tiebreakA : tiebreakB;
  const losingPoints = aWon ? tiebreakB : tiebreakA;
  const valid = losingPoints >= 0 && winningPoints >= 5 && winningPoints - losingPoints >= 2;
  return { valid, tiebreakA, tiebreakB };
}

export { validTennisScore };

async function attendingSet(eventId, playerId) {
  const attendingRows = await db(`eois?event_id=eq.${encodeURIComponent(eventId)}&status=eq.yes&select=player_id`);
  const attending = new Set(attendingRows.map(row => row.player_id));
  if (playerId && !attending.has(playerId)) return null;
  return attending;
}

function liveSnapshot(match) {
  return {
    server_player_id: match.server_player_id,
    server_order: match.server_order || [],
    server_index: Number(match.server_index || 0),
    needs_server_choice: !!match.needs_server_choice,
    games_a: match.games_a,
    games_b: match.games_b,
    point_a: match.point_a,
    point_b: match.point_b,
    tiebreak_a: match.tiebreak_a,
    tiebreak_b: match.tiebreak_b,
    points_a: match.points_a,
    points_b: match.points_b,
    is_tiebreak: match.is_tiebreak,
    completed: match.completed,
  };
}

function liveHistory(match) {
  return Array.isArray(match.point_history) ? match.point_history : [];
}

function buildServerOrder(teamA, teamB, teamAServerId, teamBServerId) {
  const aFirst = teamA.includes(teamAServerId) ? teamAServerId : teamA[0];
  const bFirst = teamB.includes(teamBServerId) ? teamBServerId : teamB[0];
  return [aFirst, bFirst, teamA.find(id => id !== aFirst), teamB.find(id => id !== bFirst)].filter(Boolean);
}

function nextServer(match) {
  const order = match.server_order || [];
  if (!order.length) return { serverIndex: 0, serverId: match.server_player_id };
  const serverIndex = (Number(match.server_index || 0) + 1) % order.length;
  return { serverIndex, serverId: order[serverIndex] };
}

function liveAdvance(match, winner) {
  const next = { ...match };
  let gameFinished = false;
  if (next.completed) return next;
  if (winner === "a") next.points_a++;
  else next.points_b++;
  if (next.is_tiebreak) {
    if (winner === "a") next.tiebreak_a++;
    else next.tiebreak_b++;
    if (next.tiebreak_a >= 5 && next.tiebreak_a - next.tiebreak_b >= 2) {
      next.games_a = 4; next.completed = true;
    }
    if (next.tiebreak_b >= 5 && next.tiebreak_b - next.tiebreak_a >= 2) {
      next.games_b = 4; next.completed = true;
    }
    return next;
  }
  if (winner === "a") next.point_a++;
  else next.point_b++;
  if (next.point_a >= 4 && next.point_a - next.point_b >= 2) {
    next.games_a++; next.point_a = 0; next.point_b = 0; gameFinished = true;
  }
  if (next.point_b >= 4 && next.point_b - next.point_a >= 2) {
    next.games_b++; next.point_a = 0; next.point_b = 0; gameFinished = true;
  }
  if (next.games_a >= 4 && next.games_a - next.games_b >= 2) next.completed = true;
  if (next.games_b >= 4 && next.games_b - next.games_a >= 2) next.completed = true;
  if (gameFinished && !next.completed) {
    const server = nextServer(next);
    next.server_index = server.serverIndex;
    next.server_player_id = server.serverId;
  }
  if (next.games_a === 3 && next.games_b === 3) next.is_tiebreak = true;
  next.needs_server_choice = false;
  next.game_finished = gameFinished;
  return next;
}

async function startLiveMatch(body, adminOverride = false) {
  const event = await getEvent(body.eventId);
  if (!event || !body.playerId) return reply({ error: "Event or player not found." }, 404);
  const windowError = scoringWindowError(event);
  if (windowError && !adminOverride) return reply({ error: windowError }, 403);
  const attending = await attendingSet(body.eventId, body.playerId);
  if (!attending && !adminOverride) return reply({ error: "Only players marked In can control live scoring." }, 403);
  const active = await db(`live_matches?event_id=eq.${encodeURIComponent(body.eventId)}&select=id`);
  if (active.length) return reply({ error: "Finish or abandon the current live match first." }, 409);
  const teamA = Array.isArray(body.teamA) ? body.teamA.filter(Boolean) : [];
  const teamB = Array.isArray(body.teamB) ? body.teamB.filter(Boolean) : [];
  const allPlayers = [...teamA, ...teamB];
  if (teamA.length !== 2 || teamB.length !== 2 || new Set(allPlayers).size !== 4 || (!adminOverride && allPlayers.some(id => !attending.has(id)))) {
    return reply({ error: "Choose four different players from this week’s In list." }, 400);
  }
  const teamAServerId = body.teamAServerId || body.serverPlayerId;
  const teamBServerId = body.teamBServerId;
  if (!teamA.includes(teamAServerId)) return reply({ error: "Choose Team 1’s first server." }, 400);
  if (!teamB.includes(teamBServerId)) return reply({ error: "Choose Team 2’s first server." }, 400);
  const serverOrder = buildServerOrder(teamA, teamB, teamAServerId, teamBServerId);
  const created = await db("live_matches?select=*", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ event_id: body.eventId, team_a_player_ids: teamA, team_b_player_ids: teamB, server_player_id: serverOrder[0], server_order: serverOrder, server_index: 0, created_by: body.playerId }),
  });
  return reply({ ok: true, match: created?.[0] || null });
}

async function updateLiveServer(body, adminOverride = false) {
  const rows = await db(`live_matches?id=eq.${encodeURIComponent(body.matchId || "")}&completed=eq.false&select=*`);
  const match = rows?.[0];
  if (!match || !body.playerId) return reply({ error: "Live match not found." }, 404);
  const event = await getEvent(match.event_id);
  const windowError = event ? scoringWindowError(event) : "Event not found.";
  if (windowError && !adminOverride) return reply({ error: windowError }, 403);
  const attending = await attendingSet(match.event_id, body.playerId);
  if (!attending && !adminOverride) return reply({ error: "Only players marked In can control live scoring." }, 403);
  const allPlayers = [...match.team_a_player_ids, ...match.team_b_player_ids];
  if (!allPlayers.includes(body.serverPlayerId)) return reply({ error: "Choose a server from this match." }, 400);
  const serverOrder = match.server_order || [];
  const serverIndex = serverOrder.includes(body.serverPlayerId) ? serverOrder.indexOf(body.serverPlayerId) : Number(match.server_index || 0);
  const updated = await db(`live_matches?id=eq.${encodeURIComponent(match.id)}&select=*`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ server_player_id: body.serverPlayerId, server_index: serverIndex, needs_server_choice: false, updated_at: new Date().toISOString() }),
  });
  return reply({ ok: true, match: updated?.[0] || { ...match, server_player_id: body.serverPlayerId, server_index: serverIndex, needs_server_choice: false } });
}

async function addLivePoint(body, adminOverride = false) {
  const rows = await db(`live_matches?id=eq.${encodeURIComponent(body.matchId || "")}&completed=eq.false&select=*`);
  const match = rows?.[0];
  if (!match || !body.playerId) return reply({ error: "Live match not found." }, 404);
  const event = await getEvent(match.event_id);
  const windowError = event ? scoringWindowError(event) : "Event not found.";
  if (windowError && !adminOverride) return reply({ error: windowError }, 403);
  const attending = await attendingSet(match.event_id, body.playerId);
  if (!attending && !adminOverride) return reply({ error: "Only players marked In can control live scoring." }, 403);
  if (!["a", "b"].includes(body.winner)) return reply({ error: "Choose who won the point." }, 400);
  const next = liveAdvance(match, body.winner);
  const history = [...liveHistory(match), liveSnapshot(match)].slice(-200);
  const gameFinished = !!next.game_finished;
  const patch = {
    server_player_id: next.server_player_id,
    games_a: next.games_a,
    games_b: next.games_b,
    point_a: next.point_a,
    point_b: next.point_b,
    tiebreak_a: next.tiebreak_a,
    tiebreak_b: next.tiebreak_b,
    points_a: next.points_a,
    points_b: next.points_b,
    is_tiebreak: next.is_tiebreak,
    completed: next.completed,
    server_index: next.server_index,
    needs_server_choice: next.needs_server_choice,
    point_history: history,
    updated_at: new Date().toISOString(),
  };
  const updated = await db(`live_matches?id=eq.${encodeURIComponent(match.id)}&select=*`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  return reply({ ok: true, completed: next.completed, gameFinished, nextServerId: next.server_player_id, matchId: match.id, match: updated?.[0] || { ...match, ...patch } });
}

async function undoLivePoint(body, adminOverride = false) {
  const rows = await db(`live_matches?id=eq.${encodeURIComponent(body.matchId || "")}&select=*`);
  const match = rows?.[0];
  if (!match || !body.playerId) return reply({ error: "Live match not found." }, 404);
  const event = await getEvent(match.event_id);
  const windowError = event ? scoringWindowError(event) : "Event not found.";
  if (windowError && !adminOverride) return reply({ error: windowError }, 403);
  const attending = await attendingSet(match.event_id, body.playerId);
  if (!attending && !adminOverride) return reply({ error: "Only players marked In can control live scoring." }, 403);
  const history = liveHistory(match);
  const previous = history.at(-1);
  if (!previous) return reply({ error: "There is no point to undo." }, 409);
  const patch = {
    ...previous,
    point_history: history.slice(0, -1),
    updated_at: new Date().toISOString(),
  };
  const updated = await db(`live_matches?id=eq.${encodeURIComponent(match.id)}&select=*`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  return reply({ ok: true, match: updated?.[0] || { ...match, ...patch } });
}

async function abandonLiveMatch(body, adminOverride = false) {
  const rows = await db(`live_matches?id=eq.${encodeURIComponent(body.matchId || "")}&select=*`);
  const match = rows?.[0];
  if (!match || !body.playerId) return reply({ error: "Live match not found." }, 404);
  const event = await getEvent(match.event_id);
  const windowError = event ? scoringWindowError(event) : "Event not found.";
  if (windowError && !adminOverride) return reply({ error: windowError }, 403);
  const attending = await attendingSet(match.event_id, body.playerId);
  if (!attending && !adminOverride) return reply({ error: "Only players marked In can control live scoring." }, 403);
  await db(`live_matches?id=eq.${encodeURIComponent(match.id)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  return reply({ ok: true, matchId: match.id });
}

async function finishLiveMatch(body, adminOverride = false) {
  const rows = await db(`live_matches?id=eq.${encodeURIComponent(body.matchId || "")}&select=*`);
  const match = rows?.[0];
  if (!match || !body.playerId) return reply({ error: "Live match not found." }, 404);
  const event = await getEvent(match.event_id);
  const windowError = event ? scoringWindowError(event) : "Event not found.";
  if (windowError && !adminOverride) return reply({ error: windowError }, 403);
  const attending = await attendingSet(match.event_id, body.playerId);
  if (!attending && !adminOverride) return reply({ error: "Only players marked In can control live scoring." }, 403);
  if (!match.completed) return reply({ error: "The live set is not finished yet." }, 409);
  await db("match_scores", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      event_id: match.event_id,
      team_a_player_ids: match.team_a_player_ids,
      team_b_player_ids: match.team_b_player_ids,
      games_a: match.games_a,
      games_b: match.games_b,
      tiebreak_a: match.is_tiebreak ? match.tiebreak_a : null,
      tiebreak_b: match.is_tiebreak ? match.tiebreak_b : null,
      points_a: match.points_a,
      points_b: match.points_b,
      submitted_by: body.playerId,
    }),
  });
  await db(`live_matches?id=eq.${encodeURIComponent(match.id)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  return reply({ ok: true });
}

async function submitScore(body) {
  const event = await getEvent(body.eventId);
  if (!event || !body.submittedBy) return reply({ error: "Event or player not found." }, 404);
  const windowError = scoringWindowError(event);
  if (windowError) return reply({ error: windowError }, 403);
  const attendingRows = await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&status=eq.yes&select=player_id`);
  const attending = new Set(attendingRows.map(row => row.player_id));
  if (!attending.has(body.submittedBy)) return reply({ error: "Only players marked In can enter scores." }, 403);
  const matches = Array.isArray(body.matches) ? body.matches : [body];
  if (!matches.length) return reply({ error: "Add at least one match." }, 400);
  const inserts = [];
  for (const match of matches) {
    const teamA = Array.isArray(match.teamA) ? match.teamA.filter(Boolean) : [];
    const teamB = Array.isArray(match.teamB) ? match.teamB.filter(Boolean) : [];
    const allPlayers = [...teamA, ...teamB];
    if (teamA.length !== 2 || teamB.length !== 2) return reply({ error: "Every doubles match requires exactly two players on each team." }, 400);
    if (new Set(allPlayers).size !== 4 || allPlayers.some(id => !attending.has(id))) {
      return reply({ error: "Each match must contain four different players from the final In list." }, 400);
    }
    const gamesA = Number(match.gamesA), gamesB = Number(match.gamesB);
    const tiebreakA = match.tiebreakA === "" || match.tiebreakA == null ? null : Number(match.tiebreakA);
    const tiebreakB = match.tiebreakB === "" || match.tiebreakB == null ? null : Number(match.tiebreakB);
    const checked = validTennisScore(gamesA, gamesB, tiebreakA, tiebreakB);
    if (!checked.valid) return reply({ error: "Every score must be 4–0, 4–1, 4–2, or 4–3 with a valid race-to-5 tie-break won by two points." }, 400);
    inserts.push({
      event_id: body.eventId,
      team_a_player_ids: teamA,
      team_b_player_ids: teamB,
      games_a: gamesA,
      games_b: gamesB,
      tiebreak_a: checked.tiebreakA,
      tiebreak_b: checked.tiebreakB,
      points_a: Number.isInteger(Number(match.pointsA)) ? Number(match.pointsA) : 0,
      points_b: Number.isInteger(Number(match.pointsB)) ? Number(match.pointsB) : 0,
      submitted_by: body.submittedBy,
    });
  }
  await db("match_scores", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(inserts),
  });
  return reply({ ok: true, saved: inserts.length });
}

async function saveEventNote(body) {
  const event = await getEvent(body.eventId);
  if (!event || !body.playerId) return reply({ error: "Event or player not found." }, 404);
  const attending = await attendingSet(body.eventId, body.playerId);
  if (!attending) return reply({ error: "Only players marked In for this week can add notes." }, 403);
  const note = String(body.note || "").trim().slice(0, 600);
  await db("event_notes?on_conflict=event_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ event_id: body.eventId, note, updated_by: body.playerId, updated_at: new Date().toISOString() }),
  });
  return reply({ ok: true });
}

async function adminLogin(body) {
  if (!/^\d{4,8}$/.test(body.passcode || "")) return reply({ error: "Invalid passcode." }, 401);
  let stored = await getPasscodeSetting();
  if (!stored && body.passcode === INITIAL_PASSCODE) {
    await savePasscode(body.passcode);
    stored = await getPasscodeSetting();
  }
  if (!verifyPasscode(body.passcode, stored)) return reply({ error: "Incorrect passcode." }, 401);
  return reply({ ok: true, token: signSession() });
}

async function changePasscode(body) {
  const stored = await getPasscodeSetting();
  if (!verifyPasscode(body.currentPasscode || "", stored)) return reply({ error: "Current passcode is incorrect." }, 401);
  if (!/^\d{4,8}$/.test(body.newPasscode || "")) return reply({ error: "Use 4–8 numbers." }, 400);
  await savePasscode(body.newPasscode);
  return reply({ ok: true, token: signSession() });
}

async function saveEvent(body) {
  const allowed = ["event_date", "start_time", "end_time", "location", "suburb", "court_1_name", "court_fee", "court_2_enabled", "court_2_name", "court_2_start_time", "court_2_end_time", "court_2_fee", "ball_fee", "account_closed"];
  const update = Object.fromEntries(Object.entries(body.changes || {}).filter(([key]) => allowed.includes(key)));
  if ("court_1_name" in update) update.court_1_name = String(update.court_1_name || "Court 1").trim() || "Court 1";
  if ("court_2_name" in update) update.court_2_name = String(update.court_2_name || "Court 2").trim() || "Court 2";
  update.updated_at = new Date().toISOString();
  await db(`events?id=eq.${encodeURIComponent(body.eventId)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(update),
  });
  return reply({ ok: true });
}

async function deleteEvent(body) {
  if (!body.eventId) return reply({ error: "Choose an event to delete." }, 400);
  const event = await getEvent(body.eventId);
  if (!event) return reply({ error: "Event not found." }, 404);
  await db("deleted_event_dates?on_conflict=event_date", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ event_date: event.event_date, deleted_at: new Date().toISOString() }),
  });
  await db(`events?id=eq.${encodeURIComponent(body.eventId)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  return reply({ ok: true });
}

async function addPlayer(body) {
  const name = String(body.name || "").trim();
  if (name.length < 2 || name.length > 80) return reply({ error: "Enter a valid player name." }, 400);
  await db("players?on_conflict=name", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ name, active: true }),
  });
  return reply({ ok: true });
}

async function removePlayer(body) {
  await db(`players?id=eq.${encodeURIComponent(body.playerId)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ active: false }),
  });
  return reply({ ok: true });
}

async function adminSetEoi(body) {
  if (!body.eventId || !body.playerId || !["yes", "no", "none"].includes(body.status)) {
    return reply({ error: "Choose a valid player and EOI status." }, 400);
  }
  if (body.status === "none") {
    await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}`, {
      method: "DELETE", headers: { Prefer: "return=minimal" },
    });
    await db(`payments?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}`, {
      method: "DELETE", headers: { Prefer: "return=minimal" },
    });
    return reply({ ok: true });
  }
  await db("eois?on_conflict=event_id,player_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      event_id: body.eventId,
      player_id: body.playerId,
      status: body.status,
      updated_at: new Date().toISOString(),
    }),
  });
  if (body.status === "no") {
    await db(`payments?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}`, {
      method: "DELETE", headers: { Prefer: "return=minimal" },
    });
  }
  return reply({ ok: true });
}

async function adminSetPayment(body) {
  if (!body.eventId || !body.playerId || typeof body.paid !== "boolean") {
    return reply({ error: "Choose a valid payment status." }, 400);
  }
  if (!body.paid) {
    await db(`payments?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}`, {
      method: "DELETE", headers: { Prefer: "return=minimal" },
    });
    return reply({ ok: true });
  }
  const event = await getEvent(body.eventId);
  if (!event) return reply({ error: "Event not found." }, 404);
  const attending = await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&status=eq.yes&select=player_id`);
  if (!attending.some(row => row.player_id === body.playerId)) {
    return reply({ error: "Only players marked In can have a payment recorded." }, 409);
  }
  const amount = Number((totalCourtFee(event) / attending.length + Number(event.ball_fee)).toFixed(2));
  await db("payments?on_conflict=event_id,player_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      event_id: body.eventId,
      player_id: body.playerId,
      amount,
      paid: true,
      paid_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
  return reply({ ok: true });
}

async function adminDeleteScore(body) {
  if (!body.scoreId) return reply({ error: "Score not found." }, 404);
  await db(`match_scores?id=eq.${encodeURIComponent(body.scoreId)}`, {
    method: "DELETE", headers: { Prefer: "return=minimal" },
  });
  return reply({ ok: true });
}

async function adminUpdateScore(body) {
  if (!body.scoreId) return reply({ error: "Score not found." }, 404);
  const rows = await db(`match_scores?id=eq.${encodeURIComponent(body.scoreId)}&select=id`);
  if (!rows?.length) return reply({ error: "Score not found." }, 404);
  const teamA = Array.isArray(body.teamA) ? body.teamA.filter(Boolean) : [];
  const teamB = Array.isArray(body.teamB) ? body.teamB.filter(Boolean) : [];
  const allPlayers = [...teamA, ...teamB];
  if (teamA.length !== 2 || teamB.length !== 2 || new Set(allPlayers).size !== 4) {
    return reply({ error: "Every doubles match needs four different players." }, 400);
  }
  const players = await db("players?select=id");
  const rosterIds = new Set(players.map(player => player.id));
  if (allPlayers.some(id => !rosterIds.has(id))) return reply({ error: "Choose players from the roster." }, 400);
  const gamesA = Number(body.gamesA), gamesB = Number(body.gamesB);
  const tiebreakA = body.tiebreakA === "" || body.tiebreakA == null ? null : Number(body.tiebreakA);
  const tiebreakB = body.tiebreakB === "" || body.tiebreakB == null ? null : Number(body.tiebreakB);
  const checked = validTennisScore(gamesA, gamesB, tiebreakA, tiebreakB);
  if (!checked.valid) return reply({ error: "Use a valid set score: 4–0, 4–1, 4–2, or 4–3 with a race-to-5 tie-break won by two." }, 400);
  const pointsA = Math.max(0, Math.trunc(Number(body.pointsA) || 0));
  const pointsB = Math.max(0, Math.trunc(Number(body.pointsB) || 0));
  const updated = await db(`match_scores?id=eq.${encodeURIComponent(body.scoreId)}&select=*`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      team_a_player_ids: teamA,
      team_b_player_ids: teamB,
      games_a: gamesA,
      games_b: gamesB,
      tiebreak_a: checked.tiebreakA,
      tiebreak_b: checked.tiebreakB,
      points_a: pointsA,
      points_b: pointsB,
    }),
  });
  return reply({ ok: true, score: updated?.[0] || null });
}

async function createMediaUpload(body) {
  const originalName = String(body.fileName || "").trim();
  const mimeType = String(body.mimeType || "").toLowerCase();
  const fileSize = Number(body.fileSize);
  if (!body.playerId || !originalName || !/^(image|video)\//.test(mimeType)) {
    return reply({ error: "Choose an image or video to upload." }, 400);
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MEDIA_MAX_BYTES) {
    return reply({ error: "Media files must be 50 MB or smaller." }, 400);
  }
  const used = await mediaUsageBytes();
  if (used + fileSize > MEDIA_TOTAL_BYTES) {
    const remainingMb = Math.max(0, Math.floor((MEDIA_TOTAL_BYTES - used) / 1024 / 1024));
    return reply({ error: `This upload would exceed the 1 GB gallery limit. Remaining space: about ${remainingMb} MB.` }, 409);
  }
  const players = await db(`players?id=eq.${encodeURIComponent(body.playerId)}&active=eq.true&select=id`);
  if (!players.length) return reply({ error: "Select an active player before uploading." }, 403);
  const extensionMatch = originalName.toLowerCase().match(/\.([a-z0-9]{1,10})$/);
  const extension = extensionMatch ? `.${extensionMatch[1]}` : "";
  const now = datePartsInSydney();
  const folder = `${now.year}/${String(now.month).padStart(2, "0")}`;
  const path = `${folder}/${randomUUID()}${extension}`;
  const { data, error } = await storageClient().storage.from(MEDIA_BUCKET).createSignedUploadUrl(path);
  if (error || !data?.signedUrl) throw error || new Error("Could not create the upload URL.");
  return reply({ ok: true, path, signedUrl: data.signedUrl });
}

async function finalizeMediaUpload(body) {
  const title = String(body.title || "").trim();
  const path = String(body.path || "");
  const originalName = String(body.originalName || "").trim();
  const mimeType = String(body.mimeType || "").toLowerCase();
  const fileSize = Number(body.fileSize);
  const capturedAt = String(body.capturedAt || "");
  if (!body.playerId || title.length < 1 || title.length > 120 || !/^\d{4}\/\d{2}\/[a-f0-9-]+(?:\.[a-z0-9]{1,10})?$/.test(path)) {
    return reply({ error: "Complete the media title and upload details." }, 400);
  }
  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MEDIA_MAX_BYTES) {
    return reply({ error: "Media files must be 50 MB or smaller." }, 400);
  }
  if (!/^(image|video)\//.test(mimeType) || !/^\d{4}-\d{2}-\d{2}$/.test(capturedAt)) {
    return reply({ error: "Invalid media type or date." }, 400);
  }
  const players = await db(`players?id=eq.${encodeURIComponent(body.playerId)}&active=eq.true&select=id`);
  if (!players.length) return reply({ error: "Select an active player before uploading." }, 403);
  const segments = path.split("/");
  const fileName = segments.pop();
  const folder = segments.join("/");
  const { data: stored, error } = await storageClient().storage.from(MEDIA_BUCKET).list(folder, { search: fileName, limit: 10 });
  const storedItem = stored?.find(item => item.name === fileName);
  if (error || !storedItem) {
    return reply({ error: "The uploaded file could not be verified." }, 409);
  }
  const storedSize = Number(storedItem.metadata?.size || fileSize);
  await db("media_items", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      player_id: body.playerId,
      title,
      media_type: mimeType.startsWith("image/") ? "image" : "video",
      storage_path: path,
      original_name: originalName.slice(0, 255),
      mime_type: mimeType,
      file_size: storedSize,
      captured_at: capturedAt,
    }),
  });
  return reply({ ok: true });
}

async function adminDeleteMedia(body) {
  const rows = await db(`media_items?id=eq.${encodeURIComponent(body.mediaId || "")}&select=id,storage_path`);
  const item = rows?.[0];
  if (!item) return reply({ error: "Media item not found." }, 404);
  const { error } = await storageClient().storage.from(MEDIA_BUCKET).remove([item.storage_path]);
  if (error) throw error;
  await db(`media_items?id=eq.${encodeURIComponent(item.id)}`, {
    method: "DELETE", headers: { Prefer: "return=minimal" },
  });
  return reply({ ok: true });
}

async function updatePlayer(body) {
  const update = {};
  if (typeof body.name === "string" && body.name.trim()) update.name = body.name.trim();
  if (!body.playerId || !Object.keys(update).length) return reply({ error: "Nothing to update." }, 400);
  await db(`players?id=eq.${encodeURIComponent(body.playerId)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(update),
  });
  return reply({ ok: true });
}

export default async (req) => {
  try {
    requireConfiguration();
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "state";
    const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));

    if (req.method === "GET" && action === "state") return reply(await appState());
    if (req.method === "POST" && action === "eoi") return submitEoi(body);
    if (req.method === "POST" && action === "paid") return markPaid(body);
    if (req.method === "POST" && action === "score") return submitScore(body);
    if (req.method === "POST" && action === "live-start") return startLiveMatch(body, isAdmin(req));
    if (req.method === "POST" && action === "live-server") return updateLiveServer(body, isAdmin(req));
    if (req.method === "POST" && action === "live-point") return addLivePoint(body, isAdmin(req));
    if (req.method === "POST" && action === "live-undo") return undoLivePoint(body, isAdmin(req));
    if (req.method === "POST" && action === "live-abandon") return abandonLiveMatch(body, isAdmin(req));
    if (req.method === "POST" && action === "live-finish") return finishLiveMatch(body, isAdmin(req));
    if (req.method === "POST" && action === "event-note") return saveEventNote(body);
    if (req.method === "POST" && action === "media-upload-url") return createMediaUpload(body);
    if (req.method === "POST" && action === "media-finalize") return finalizeMediaUpload(body);
    if (req.method === "POST" && action === "admin-login") return adminLogin(body);
    if (req.method === "GET" && action === "admin-state") {
      if (!isAdmin(req)) return reply({ error: "Admin session expired." }, 401);
      return reply(await adminState());
    }

    if (!["admin-change-passcode", "admin-save-event", "admin-delete-event", "admin-add-player", "admin-update-player", "admin-remove-player", "admin-set-eoi", "admin-set-payment", "admin-update-score", "admin-delete-score", "admin-delete-media"].includes(action)) {
      return reply({ error: "Unknown action." }, 404);
    }
    if (!isAdmin(req)) return reply({ error: "Admin session expired." }, 401);
    if (action === "admin-change-passcode") return changePasscode(body);
    if (action === "admin-save-event") return saveEvent(body);
    if (action === "admin-delete-event") return deleteEvent(body);
    if (action === "admin-add-player") return addPlayer(body);
    if (action === "admin-update-player") return updatePlayer(body);
    if (action === "admin-remove-player") return removePlayer(body);
    if (action === "admin-set-eoi") return adminSetEoi(body);
    if (action === "admin-set-payment") return adminSetPayment(body);
    if (action === "admin-update-score") return adminUpdateScore(body);
    if (action === "admin-delete-score") return adminDeleteScore(body);
    if (action === "admin-delete-media") return adminDeleteMedia(body);
  } catch (error) {
    console.error(error);
    return reply({ error: "The server could not complete that request." }, 500);
  }
};
