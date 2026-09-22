import {
  createHmac,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { activePlayerIds, notifyPlayers, pushConfigured } from "./push.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET;
const INITIAL_PASSCODE = String(process.env.INITIAL_ADMIN_PASSCODE || "").trim();
const SYDNEY = "Australia/Sydney";
const MEDIA_BUCKET = "tennis-media";
const MEDIA_MAX_BYTES = 50 * 1024 * 1024;
// Application-level gallery quota. Supabase Storage remains responsible for
// its own provider plan limits; this is the quota enforced by the API.
const MEDIA_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const SCORING_WINDOW_MS = 24 * 60 * 60 * 1000;
const PLAYERS_PER_COURT = 6;
const PLAYER_SERVER_IDLE_MS = 15 * 60 * 1000;
const ADMIN_SERVER_IDLE_MS = 10 * 60 * 1000;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
// Optional publishable key used only by the browser for low-latency sync. The
// service-role key is never returned to clients.
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "";
// The app currently has one shared admin passcode. Set ADMIN_DISPLAY_NAME in
// Netlify to identify the admin in the append-only activity history.
const ADMIN_DISPLAY_NAME = process.env.ADMIN_DISPLAY_NAME || "Rafeed Abrar";
const WEBAUTHN_RP_NAME = process.env.WEBAUTHN_RP_NAME || "Banglas Playing Tennis";
const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || "";
const WEBAUTHN_ORIGINS = (process.env.WEBAUTHN_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
const rateBuckets = new Map();
const signedMediaUrlCache = new Map();

const headers = { "content-type": "application/json; charset=utf-8" };
const reply = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...headers, ...extra } });

function requireConfiguration() {
  if (!SUPABASE_URL || !SERVICE_KEY || !SESSION_SECRET) {
    throw new Error("Server environment variables are not configured.");
  }
}

function consumeRateLimit(req, bucket, limit = 20, windowMs = 60_000) {
  const forwarded = req.headers.get("x-forwarded-for") || req.headers.get("x-nf-client-connection-ip") || "unknown";
  const key = `${bucket}:${forwarded.split(",")[0].trim()}`;
  const now = Date.now();
  const recent = (rateBuckets.get(key) || []).filter(timestamp => now - timestamp < windowMs);
  if (recent.length >= limit) return false;
  recent.push(now);
  rateBuckets.set(key, recent);
  if (rateBuckets.size > 5000) {
    for (const [storedKey, timestamps] of rateBuckets) if (!timestamps.some(timestamp => now - timestamp < windowMs)) rateBuckets.delete(storedKey);
  }
  return true;
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

function eventPlayerCap(event) {
  const override = Number(event?.max_players || 0);
  return override > 0 ? override : PLAYERS_PER_COURT * (event?.court_2_enabled ? 2 : 1);
}

async function createPlayerNotifications(rows) {
  const valid = (rows || []).filter(row => row?.player_id && row?.dedupe_key && row?.title && row?.body);
  if (!valid.length) return;
  const payload = valid.map(row => ({
    player_id: row.player_id, event_id: row.event_id || null, notification_type: row.notification_type || "session", group_key: row.group_key || row.dedupe_key?.split(":").slice(0, 2).join(":") || null,
    title: String(row.title).slice(0, 120), body: String(row.body).slice(0, 500), url: row.url || "/?page=play", dedupe_key: row.dedupe_key,
  }));
  const options = {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(payload),
  };
  try {
    await db("player_notifications?on_conflict=player_id,dedupe_key", options);
  } catch (error) {
    // Migration 036 adds grouping, but notification delivery must continue
    // during a rolling deploy where the API is newer than the database.
    if (!/group_key|column|schema cache/i.test(error?.message || "")) throw error;
    await db("player_notifications?on_conflict=player_id,dedupe_key", {
      ...options,
      body: JSON.stringify(payload.map(({ group_key, ...row }) => row)),
    });
  }
}

async function notifyAdminWaitlist(event, player, position) {
  try {
    const admins = await db(`players?name=eq.${encodeURIComponent(ADMIN_DISPLAY_NAME)}&active=eq.true&select=id`);
    const playerIds = (admins || []).map(row => row.id);
    if (!playerIds.length) return;
    const title = `Waitlist action needed · ${eventLabel(event)}`;
    const body = `${player.name} is #${position} on the waitlist for ${eventLabel(event)} at ${event.location}, ${event.suburb}. Add a second court or reject the waitlist.`;
    await createPlayerNotifications(playerIds.map(player_id => ({ player_id, event_id: event.id, notification_type: "session", title, body, url: `/?page=admin&event=${encodeURIComponent(event.id)}`, dedupe_key: `waitlist-admin:${event.id}:${player.id}:${position}` })));
    await notifyPlayers({ playerIds, notificationType: "session", notificationKey: `waitlist-admin:${event.id}:${player.id}:${position}`, eventId: event.id, title, body, url: `/?page=admin&event=${encodeURIComponent(event.id)}`, audience: "selected" });
  } catch (error) { console.error("Waitlist admin notification failed", error); }
}

async function promoteWaitlistForEvent(event) {
  const [inRows, waiting] = await Promise.all([
    db(`eois?event_id=eq.${encodeURIComponent(event.id)}&status=eq.yes&waitlist_position=is.null&select=player_id`),
    db(`eois?event_id=eq.${encodeURIComponent(event.id)}&status=eq.yes&waitlist_position=not.is.null&select=player_id,waitlist_position&order=waitlist_position.asc`),
  ]);
  const slots = Math.max(0, eventPlayerCap(event) - (inRows || []).length);
  const promoted = (waiting || []).slice(0, slots);
  if (!promoted.length) return;
  const now = new Date().toISOString();
  for (const row of promoted) {
    await db(`eois?event_id=eq.${encodeURIComponent(event.id)}&player_id=eq.${encodeURIComponent(row.player_id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ waitlist_position: null, updated_at: now }) });
    await ensurePaymentRow(event.id, row.player_id).catch(() => {});
  }
  const label = eventLabel(event);
  const title = `You’re in · ${label}`;
  const body = `A second court was added for ${label} at ${event.location}, ${event.suburb}. You have been moved from the waitlist into the session.`;
  await createPlayerNotifications(promoted.map(row => ({ player_id: row.player_id, event_id: event.id, notification_type: "session", title, body, url: `/?page=play&event=${encodeURIComponent(event.id)}`, dedupe_key: `waitlist-promoted:${event.id}:${row.player_id}` })));
  try { await notifyPlayers({ playerIds: promoted.map(row => row.player_id), notificationType: "session", notificationKey: `waitlist-promoted:${event.id}:${now}`, eventId: event.id, title, body, url: `/?page=play&event=${encodeURIComponent(event.id)}`, audience: "selected" }); } catch (error) { console.error("Waitlist promotion push failed", error); }
}

function eventLabel(event) {
  return new Intl.DateTimeFormat("en-AU", { timeZone: SYDNEY, weekday: "short", day: "numeric", month: "short" }).format(new Date(`${event.event_date}T12:00:00Z`));
}

function eventDetails(event) {
  const courtTwo = event.court_2_enabled ? ` · ${event.court_2_name || "Court 2"} ${event.court_2_start_time.slice(0, 5)}–${event.court_2_end_time.slice(0, 5)}` : "";
  return `${event.location}, ${event.suburb} · ${event.court_1_name || "Court 1"} ${event.start_time.slice(0, 5)}–${event.end_time.slice(0, 5)}${courtTwo}`;
}

async function eventClosureNotification(event) {
  const [attending, payments] = await Promise.all([
    db(`eois?event_id=eq.${encodeURIComponent(event.id)}&status=eq.yes&waitlist_position=is.null&select=player_id`),
    db(`payments?event_id=eq.${encodeURIComponent(event.id)}&select=player_id,paid`),
  ]);
  const paidPlayers = new Set((payments || []).filter(row => row.paid).map(row => row.player_id));
  const players = attending || [];
  const allPaymentsComplete = players.length > 0 && players.every(row => paidPlayers.has(row.player_id));
  const label = eventLabel(event);
  const venue = `${event.location}, ${event.suburb}`;
  if (allPaymentsComplete) {
    return {
      title: `Payments complete · ${label}`,
      body: `All payments for ${label} at ${venue} are complete. This week is now closed.`,
      notificationType: "payments",
      notificationKey: `payments-complete:${event.id}:${event.updated_at}`,
    };
  }
  return {
    title: `Tennis session closed · ${label}`,
    body: `${label} at ${venue} is now closed. Payment tracking is still incomplete.`,
    notificationType: "session",
    notificationKey: `session-closed:${event.id}:${event.updated_at}`,
  };
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

async function mediaUrl(path) {
  const cached = signedMediaUrlCache.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const { data, error } = await storageClient().storage.from(MEDIA_BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) return null;
  // Avatars are included in the main state response for every signed-in user.
  // Reuse each signed URL for most of its lifetime instead of making one
  // Storage request per avatar on every state refresh.
  signedMediaUrlCache.set(path, { url: data.signedUrl, expiresAt: Date.now() + 50 * 60 * 1000 });
  if (signedMediaUrlCache.size > 200) {
    const oldest = signedMediaUrlCache.keys().next().value;
    if (oldest) signedMediaUrlCache.delete(oldest);
  }
  return data.signedUrl;
}

async function auditActor(req) {
  if (await isAdminSession(req)) return { actor_type: "admin", actor_player_id: null, actor_name: ADMIN_DISPLAY_NAME };
  const playerId = playerSessionSubject(req);
  if (!playerId) return { actor_type: "anonymous", actor_player_id: null, actor_name: "Anonymous visitor" };
  let actorName = null;
  try {
    const rows = await db(`players?id=eq.${encodeURIComponent(playerId)}&select=name`);
    actorName = rows?.[0]?.name || null;
  } catch { /* Keep the audit write working even if the roster lookup fails. */ }
  return { actor_type: "player", actor_player_id: playerId, actor_name: actorName || "Unknown player" };
}

function auditSafe(value) {
  if (!value || typeof value !== "object") return value;
  const copy = Array.isArray(value) ? value.slice(0, 100) : { ...value };
  for (const key of Object.keys(copy)) {
    if (/passcode|pin|token|secret|signedurl|filedata/i.test(key)) delete copy[key];
    else if (typeof copy[key] === "string") copy[key] = copy[key].slice(0, 500);
  }
  return copy;
}

async function writeAudit(req, action, body, outcome = "success", beforeState = null, afterState = null) {
  try {
    const actor = await auditActor(req);
    const payload = {
      ...actor, action, target_type: body?.eventId ? "event" : body?.playerId ? "player" : body?.mediaId ? "media" : body?.scoreId ? "score" : body?.badgeId || (body?.id && ["admin-save-badge", "admin-delete-badge"].includes(action)) ? "badge" : null,
      target_id: body?.eventId || body?.playerId || body?.mediaId || body?.scoreId || body?.badgeId || (body?.id && ["admin-save-badge", "admin-delete-badge"].includes(action) ? body.id : null), outcome,
      details: auditSafe(body || {}), before_state: auditSafe(beforeState), after_state: auditSafe(afterState),
    };
    try {
      await db("audit_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(payload) });
    } catch (error) {
      // Keep logging working during the brief window before migration 020 is applied.
      if (!Object.prototype.hasOwnProperty.call(payload, "actor_name")) throw error;
      delete payload.actor_name;
      await db("audit_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(payload) });
    }
  } catch (error) { console.error("Audit log failed", error); }
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

let upcomingEnsuredAt = 0;
let upcomingEnsurePromise = null;
async function ensureUpcomingEvents() {
  if (upcomingEnsurePromise) return upcomingEnsurePromise;
  // This is maintenance work, not per-request data. Keeping the warm-instance
  // cache at five minutes avoids repeating three database calls during bursts
  // of logins and refreshes while still healing newly-created weekly events.
  if (Date.now() - upcomingEnsuredAt < 5 * 60_000) return;
  upcomingEnsurePromise = (async () => {
    const deletedDates = new Set((await db("deleted_event_dates?select=event_date")).map(row => row.event_date));
    const events = upcomingWednesdays().filter(event_date => !deletedDates.has(event_date)).map(event_date => ({ event_date }));
    const now = datePartsInSydney();
    const today = `${now.year}-${String(now.month).padStart(2, "0")}-${String(now.day).padStart(2, "0")}`;
    const maintenance = [];
    if (events.length) maintenance.push(db("events?on_conflict=event_date", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(events),
      }));
    // Migrate only legacy upcoming rows that still carry the old default. An
    // explicitly edited fee is never overwritten because this targets 52 only.
    maintenance.push(db(`events?event_date=gte.${today}&court_fee=eq.52`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ court_fee: 54, updated_at: new Date().toISOString() }),
    }));
    await Promise.all(maintenance);
    upcomingEnsuredAt = Date.now();
  })().finally(() => { upcomingEnsurePromise = null; });
  return upcomingEnsurePromise;
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

function signSession(sessionId = null) {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ type: "admin", sid: sessionId || undefined, iat: now, exp: now + 8 * 60 * 60 * 1000 })).toString("base64url");
  const signature = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function signPlayerSession(playerId, sessionId = null) {
  const payload = Buffer.from(JSON.stringify({ type: "player", sub: playerId, sid: sessionId || undefined, iat: Date.now(), exp: Date.now() + 30 * 24 * 60 * 60 * 1000 })).toString("base64url");
  const signature = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

async function issuePlayerSession(playerId, deviceLabel = null) {
  const sessionId = randomUUID();
  try {
    await db("player_sessions", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ player_id: playerId, session_id: sessionId, device_label: deviceLabel }) });
    return signPlayerSession(playerId, sessionId);
  } catch (error) {
    // Keep existing installations usable until migration 035 is applied.
    console.error("Player session tracking unavailable", error?.message || error);
    return signPlayerSession(playerId);
  }
}

function playerSessionSubject(req) {
  const token = req.headers.get("x-player-session") || "";
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString());
    return session.type === "player" && session.sub && session.exp > Date.now() ? session.sub : null;
  } catch {
    return null;
  }
}

function adminTokenPayload(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString());
    // Accept legacy signed admin tokens while browsers migrate to tracked
    // sessions. This prevents a deployment from logging every admin out.
    return value.exp > Date.now() && (!value.type || value.type === "admin") ? value : null;
  } catch { return null; }
}

function isAdmin(req) {
  return Boolean(adminTokenPayload(req));
}

async function isAdminSession(req) {
  const payload = adminTokenPayload(req);
  if (!payload) return false;
  // Legacy tokens have no server-side session id and remain valid until their
  // signed expiry. New tokens are tracked when the table is available.
  if (!payload.sid) return true;
  try {
    const rows = await db(`admin_sessions?session_id=eq.${encodeURIComponent(payload.sid)}&revoked_at=is.null&select=session_id,last_seen_at`);
    const row = rows?.[0];
    if (!row) return false;
    const lastSeen = Date.parse(row.last_seen_at || "");
    if (Number.isFinite(lastSeen) && Date.now() - lastSeen > ADMIN_SERVER_IDLE_MS) {
      await db(`admin_sessions?session_id=eq.${encodeURIComponent(payload.sid)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ revoked_at: new Date().toISOString() }) }).catch(() => {});
      return false;
    }
    await db(`admin_sessions?session_id=eq.${encodeURIComponent(payload.sid)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_seen_at: new Date().toISOString() }) }).catch(() => {});
    return true;
  } catch {
    // Migration 036 is additive. Keep the signed token usable if an older
    // database is briefly ahead/behind the function deployment.
    return true;
  }
}

async function createAdminSession() {
  const sessionId = randomUUID();
  await db("admin_sessions", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ session_id: sessionId, label: "Admin browser" }) }).catch(error => console.error("Admin session tracking unavailable", error?.message || error));
  return signSession(sessionId);
}

async function isPlayer(req, playerId) {
  const token = req.headers.get("x-player-session") || "";
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (session.type !== "player" || session.sub !== playerId || session.exp <= Date.now()) return false;
    if (session.sid) {
      const active = await db(`player_sessions?session_id=eq.${encodeURIComponent(session.sid)}&player_id=eq.${encodeURIComponent(playerId)}&revoked_at=is.null&select=session_id,last_seen_at`);
      if (!active?.length) return false;
      const lastSeen = Date.parse(active[0].last_seen_at || "");
      if (Number.isFinite(lastSeen) && Date.now() - lastSeen > PLAYER_SERVER_IDLE_MS) {
        await db(`player_sessions?session_id=eq.${encodeURIComponent(session.sid)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ revoked_at: new Date().toISOString() }) }).catch(() => {});
        return false;
      }
      await db(`player_sessions?session_id=eq.${encodeURIComponent(session.sid)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_seen_at: new Date().toISOString() }) }).catch(() => {});
    }
    const rows = await db(`players?id=eq.${encodeURIComponent(playerId)}&active=eq.true&select=pin_updated_at`);
    const pinUpdatedAt = Date.parse(rows?.[0]?.pin_updated_at || "");
    return !!rows?.length && (!Number.isFinite(pinUpdatedAt) || pinUpdatedAt <= Number(session.iat || 0));
  } catch { return false; }
}

async function revokePlayerSessions(body) {
  if (!body.playerId) return reply({ error: "Choose a player profile first." }, 400);
  await db(`player_sessions?player_id=eq.${encodeURIComponent(body.playerId)}&revoked_at=is.null`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ revoked_at: new Date().toISOString() }),
  });
  return reply({ ok: true });
}

async function getEvent(eventId) {
  const rows = await db(`events?id=eq.${encodeURIComponent(eventId)}&select=*`);
  return rows?.[0];
}

async function listVisibleEvents() {
  try {
    return await db("events?deleted_at=is.null&select=*&order=event_date.asc");
  } catch {
    // Keep the app compatible during the short window before the migration is
    // applied to an existing Supabase project.
    return db("events?select=*&order=event_date.asc");
  }
}

async function getPasscodeSetting() {
  const rows = await db("app_settings?key=eq.admin_passcode_hash&select=value");
  return rows?.[0]?.value || null;
}

async function savePasscode(passcode) {
  await db("app_settings?on_conflict=key", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ key: "admin_passcode_hash", value: passcodeHash(passcode), updated_at: new Date().toISOString() }),
  });
}

async function appState(req) {
  // Keep weekly-event maintenance off the critical path. Existing events are
  // already enough to render the clubhouse; only wait and re-read if the
  // response genuinely has no current upcoming Wednesday to show.
  const ensurePromise = ensureUpcomingEvents().catch(error => {
    console.error("Upcoming event maintenance failed", error?.message || error);
    return null;
  });
  let [playerRows, events, eois, payments, scores, liveMatches, notes, badges] = await Promise.all([
    db("players?select=id,name,active,is_guest,guest_event_id,guest_of_player_id,email,mobile,address,avatar_path,pin_hash&order=name.asc"),
    listVisibleEvents(),
    db("eois?select=event_id,player_id,status,updated_at,waitlist_position,attendance_status,checked_in_at"),
    db("payments?select=event_id,player_id,amount,paid,paid_at"),
    db("match_scores?select=*&order=created_at.asc"),
    db("live_matches?select=*&order=updated_at.desc"),
    db("event_notes?select=*"),
    db("badges?enabled=eq.true&select=*&order=sort_order.asc,name.asc").catch(() => []),
  ]);
  const expectedUpcoming = new Set(upcomingWednesdays());
  if (!(events || []).some(event => expectedUpcoming.has(event.event_date))) {
    await ensurePromise;
    events = await listVisibleEvents();
  }
  const admin = await isAdminSession(req);
  const hasPlayerToken = Boolean(req.headers.get("x-player-session"));
  const candidatePlayerId = admin ? null : playerSessionSubject(req);
  const playerId = candidatePlayerId && await isPlayer(req, candidatePlayerId) ? candidatePlayerId : null;
  const players = await Promise.all((playerRows || []).map(async player => ({
    id: player.id,
    name: player.name,
    active: player.active,
    is_guest: player.is_guest,
    guest_event_id: player.guest_event_id,
    guest_of_player_id: player.guest_of_player_id,
    pin_configured: Boolean(player.pin_hash),
    email: player.email || "",
    mobile: player.mobile || "",
    avatar_url: player.avatar_path ? await mediaUrl(player.avatar_path) : null,
    ...(admin || player.id === playerId ? { address: player.address || "" } : {}),
  })));
  const visiblePayments = payments.map(payment => {
    if (admin || payment.player_id === playerId) return payment;
    return { event_id: payment.event_id, player_id: payment.player_id, paid: !!payment.paid };
  });
  if (playerId) {
    const pending = [];
    for (const event of events) {
      if (new Date(localDateTimeToUtc(event.event_date, eventEndTime(event), event.timezone)) > new Date()) continue;
      const inThisWeek = eois.some(row => row.event_id === event.id && row.player_id === playerId && row.status === "yes" && row.waitlist_position == null);
      const paid = payments.some(row => row.event_id === event.id && row.player_id === playerId && row.paid);
      if (inThisWeek && !paid) pending.push({ player_id: playerId, event_id: event.id, notification_type: "payments", title: `Payment due · ${eventLabel(event)}`, body: `${eventLabel(event)} at ${event.location}, ${event.suburb}: payment is due. PayID 0420451170.`, url: `/?page=payments&event=${encodeURIComponent(event.id)}`, dedupe_key: `payment-pending:${event.id}` });
    }
    await createPlayerNotifications(pending).catch(() => {});
  }
  const notifications = playerId ? await db(`player_notifications?player_id=eq.${encodeURIComponent(playerId)}&select=id,event_id,notification_type,title,body,url,group_key,read_at,created_at&order=read_at.asc.nullsfirst,created_at.desc&limit=100`).catch(() => []) : [];
  const authenticated = admin || Boolean(playerId);
  return { players, events: authenticated ? events : [], eois: authenticated ? eois : [], payments: authenticated ? visiblePayments : [], scores: authenticated ? scores : [], liveMatches: authenticated ? liveMatches : [], notes: authenticated ? notes : [], badges: authenticated ? badges : [], notifications, sessionPlayerId: playerId, sessionExpired: hasPlayerToken && !playerId && !admin, mediaLimit: MEDIA_TOTAL_BYTES, serverNow: new Date().toISOString() };
}

async function mediaState(req) {
  const admin = await isAdminSession(req);
  const candidatePlayerId = admin ? null : playerSessionSubject(req);
  const playerId = candidatePlayerId && await isPlayer(req, candidatePlayerId) ? candidatePlayerId : null;
  if (!admin && !playerId) return reply({ media: [], mediaUsage: 0, mediaLimit: MEDIA_TOTAL_BYTES, serverNow: new Date().toISOString() });
  const rows = await db("media_items?select=*&order=captured_at.desc,created_at.desc");
  const favouriteRows = playerId
    ? await db(`media_favourites?player_id=eq.${encodeURIComponent(playerId)}&select=media_id`).catch(() => [])
    : [];
  const favouriteIds = new Set((favouriteRows || []).map(row => row.media_id));
  const media = (await Promise.all(rows.map(async item => ({ ...item, is_favorite: favouriteIds.has(item.id), public_url: await mediaUrl(item.storage_path) })))).filter(item => item.public_url);
  const mediaUsage = media.reduce((sum, item) => sum + Number(item.file_size || 0), 0);
  return reply({ media, mediaUsage, mediaLimit: MEDIA_TOTAL_BYTES, serverNow: new Date().toISOString() });
}

async function liveState() {
  const liveMatches = await db("live_matches?select=*&order=updated_at.desc");
  return reply({ liveMatches, serverNow: new Date().toISOString() });
}

async function eoiState() {
  const eois = await db("eois?select=event_id,player_id,status,updated_at,waitlist_position,attendance_status,checked_in_at");
  return reply({ eois, serverNow: new Date().toISOString() });
}

async function adminState() {
  const [players, subscriptions, badges, guestHistory] = await Promise.all([
    db("players?select=id,name,active,email,is_guest,guest_event_id,guest_of_player_id,pin_hash,pin_failed_attempts,pin_locked_at&order=name.asc"),
    db("push_subscriptions?select=id,player_id,endpoint,active,updated_at,created_at&active=eq.true"),
    db("badges?select=*&order=sort_order.asc,name.asc").catch(() => []),
    db("guest_history?select=*&order=assigned_at.desc").catch(() => []),
  ]);
  const pushEnabled = new Set((subscriptions || []).map(subscription => subscription.player_id));
  const pushDevices = (subscriptions || []).reduce((map, subscription) => {
    const list = map.get(subscription.player_id) || [];
    list.push({ id: subscription.id, endpoint: subscription.endpoint, updated_at: subscription.updated_at, created_at: subscription.created_at });
    map.set(subscription.player_id, list);
    return map;
  }, new Map());
  return { players: players.map(({ pin_hash, ...player }) => ({ ...player, pin_configured: !!pin_hash, push_enabled: pushEnabled.has(player.id), push_devices: pushDevices.get(player.id) || [] })), guestHistory, badges };
}

async function syncVersion() {
  try {
    const rows = await db("app_sync_state?id=eq.clubhouse&select=version,updated_at");
    return reply({ version: rows?.[0]?.version || 0, updatedAt: rows?.[0]?.updated_at || null, serverNow: new Date().toISOString() });
  } catch {
    // Before migration 034 is applied, let the client keep using its existing
    // polling loops instead of turning a missing optional table into an error.
    return reply({ version: 0, updatedAt: null, serverNow: new Date().toISOString(), fallback: true });
  }
}

async function adminBackup(req) {
  if (!await isAdminSession(req)) return reply({ error: "Admin session expired." }, 401);
  const tables = {
    // Explicit projections prevent PIN hashes, invite tokens and other
    // authentication material from ever entering an exported backup.
    players: "players?select=id,name,email,mobile,address,avatar_path,is_guest,guest_event_id,guest_of_player_id,active,created_at,pin_updated_at&order=name.asc",
    events: "events?select=id,event_date,start_time,end_time,timezone,court_1_name,location,suburb,court_fee,court_2_enabled,court_2_name,court_2_start_time,court_2_end_time,court_2_fee,ball_fee,account_closed,max_players,cancellation_status,cancellation_reason,recap_notes,award_player_id,template_name,deleted_at,created_at,updated_at&order=event_date.asc",
    eois: "eois?select=*",
    payments: "payments?select=*",
    scores: "match_scores?select=*&order=created_at.asc",
    liveMatches: "live_matches?select=*",
    media: "media_items?select=*&order=created_at.asc",
    auditLog: "audit_log?select=*&order=created_at.asc",
    badges: "badges?select=*&order=sort_order.asc",
  };
  const entries = await Promise.all(Object.entries(tables).map(async ([key, query]) => [key, await db(query)]));
  const payload = Object.fromEntries(entries);
  await db("admin_backup_runs", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ requested_by: ADMIN_DISPLAY_NAME, table_counts: Object.fromEntries(Object.entries(payload).map(([key, rows]) => [key, Array.isArray(rows) ? rows.length : 0])) }),
  }).catch(() => {});
  return reply({ generatedAt: new Date().toISOString(), schemaVersion: "034", tables: payload });
}

function badgePayload(body) {
  const name = String(body.name || "").trim();
  if (name.length < 2 || name.length > 60) return { error: "Badge names must be 2–60 characters." };
  const description = String(body.description || "").trim();
  if (description.length > 200) return { error: "Badge descriptions must be 200 characters or fewer." };
  const integer = (value, label, min = 0) => {
    if (value === "" || value === null || value === undefined) return null;
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > 100000) throw new Error(`${label} must be a whole number.`);
    return number;
  };
  const decimal = (value, label) => {
    if (value === "" || value === null || value === undefined) return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 100) throw new Error(`${label} must be between 0 and 100.`);
    return number;
  };
  let minPlayed, minWins, minAttendance, minPointDiff, minWinPct, minPaidRate;
  try {
    minPlayed = integer(body.minPlayed, "Minimum matches played");
    minWins = integer(body.minWins, "Minimum wins");
    minAttendance = integer(body.minAttendance, "Minimum sessions attended");
    minPointDiff = body.minPointDiff === "" || body.minPointDiff === null || body.minPointDiff === undefined ? null : Number(body.minPointDiff);
    if (minPointDiff !== null && (!Number.isInteger(minPointDiff) || minPointDiff < -100000 || minPointDiff > 100000)) throw new Error("Minimum point differential must be a whole number.");
    minWinPct = decimal(body.minWinPct, "Minimum win percentage");
    minPaidRate = decimal(body.minPaidRate, "Minimum payment completion percentage");
  } catch (error) { return { error: error.message }; }
  const fallbackType = ["played", "no_played"].includes(body.fallbackType) ? body.fallbackType : null;
  const sortOrder = Number.isInteger(Number(body.sortOrder)) ? Math.max(0, Math.min(10000, Number(body.sortOrder))) : 100;
  return { value: { name, description: description || null, min_played: minPlayed, min_wins: minWins, min_win_pct: minWinPct, min_attendance: minAttendance, min_point_diff: minPointDiff, min_paid_rate: minPaidRate, fallback_type: fallbackType, enabled: body.enabled !== false, sort_order: sortOrder, updated_at: new Date().toISOString() } };
}

async function saveBadge(body) {
  const parsed = badgePayload(body);
  if (parsed.error) return reply({ error: parsed.error }, 400);
  const payload = parsed.value;
  try {
    if (body.id) {
      const rows = await db(`badges?id=eq.${encodeURIComponent(body.id)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(payload) });
      if (!rows?.length) return reply({ error: "Badge not found." }, 404);
      return reply({ ok: true, badge: rows[0] });
    }
    const rows = await db("badges", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(payload) });
    return reply({ ok: true, badge: rows?.[0] || null });
  } catch (error) {
    if (String(error.message).includes("duplicate key")) return reply({ error: "A badge with that name already exists." }, 409);
    throw error;
  }
}

async function deleteBadge(body) {
  if (!body.id) return reply({ error: "Choose a badge to delete." }, 400);
  await db(`badges?id=eq.${encodeURIComponent(body.id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  return reply({ ok: true });
}

async function playerPinStatus(body) {
  const rows = await db(`players?id=eq.${encodeURIComponent(body.playerId || "")}&active=eq.true&select=id,pin_hash`);
  const player = rows?.[0];
  if (!player) return reply({ error: "Choose an active player." }, 404);
  return reply({ ok: true, pinConfigured: !!player.pin_hash });
}

async function createPlayerPin(body) {
  const pin = String(body.pin || "");
  if (!body.playerId || !/^\d{4,8}$/.test(pin)) return reply({ error: "Use a PIN with 4–8 numbers." }, 400);
  const now = new Date().toISOString();
  const updated = await db(`players?id=eq.${encodeURIComponent(body.playerId)}&active=eq.true&pin_hash=is.null&select=id`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ pin_hash: passcodeHash(pin), pin_updated_at: now }),
  });
  if (!updated?.length) return reply({ error: "This player already has a PIN. Enter it to continue, or ask the admin to reset it." }, 409);
  return reply({ ok: true, token: await issuePlayerSession(body.playerId, "PIN setup") });
}

async function playerLogin(body) {
  const pin = String(body.pin || "");
  const rows = await db(`players?id=eq.${encodeURIComponent(body.playerId || "")}&active=eq.true&select=id,pin_hash,pin_failed_attempts,pin_locked_at`);
  const player = rows?.[0];
  if (!player || !player.pin_hash) return reply({ error: "Incorrect PIN." }, 401);
  if (player.pin_locked_at) return reply({ error: "This player account is locked after 5 failed attempts. Please contact the admin to reset it." }, 423);
  if (!verifyPasscode(pin, player.pin_hash)) {
    const failures = await db("rpc/record_player_pin_failure", {
      method: "POST",
      body: JSON.stringify({ target_player_id: player.id }),
    });
    const count = Number(failures?.[0]?.failed_attempts || 0);
    if (count >= 5) return reply({ error: "This player account is now locked after 5 failed attempts. Please contact the admin to reset it." }, 423);
    return reply({ error: `Incorrect PIN. ${5 - count} attempt${5 - count === 1 ? "" : "s"} remaining.` }, 401);
  }
  await db(`players?id=eq.${encodeURIComponent(player.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ pin_failed_attempts: 0, pin_locked_at: null }),
  });
  return reply({ ok: true, token: await issuePlayerSession(player.id, "PIN login") });
}

function webauthnContext(req) {
  const requestUrl = new URL(req.url);
  const rpID = WEBAUTHN_RP_ID || requestUrl.hostname;
  const origins = WEBAUTHN_ORIGINS.length ? WEBAUTHN_ORIGINS : [requestUrl.origin];
  return { rpID, origins };
}

async function saveWebAuthnChallenge({ playerId = null, challengeType, challenge }) {
  await db(`webauthn_challenges?expires_at=lt.${encodeURIComponent(new Date().toISOString())}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  }).catch(() => {});
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const rows = await db("webauthn_challenges", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ player_id: playerId, challenge_type: challengeType, challenge, expires_at: expiresAt }),
  });
  return { id: rows?.[0]?.id, expiresAt };
}

async function consumeWebAuthnChallenge(id, challengeType, playerId = null) {
  if (!id) return null;
  const query = `id=eq.${encodeURIComponent(id)}&challenge_type=eq.${encodeURIComponent(challengeType)}&consumed_at=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}`;
  const rows = await db(`webauthn_challenges?${query}&select=*`);
  const challenge = rows?.[0];
  if (!challenge || (playerId && challenge.player_id !== playerId)) return null;
  const updated = await db(`webauthn_challenges?id=eq.${encodeURIComponent(id)}&consumed_at=is.null&select=id`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ consumed_at: new Date().toISOString() }),
  });
  return updated?.length ? challenge : null;
}

function credentialForVerification(row) {
  return {
    id: row.credential_id,
    publicKey: new Uint8Array(Buffer.from(row.public_key, "base64url")),
    counter: Number(row.counter || 0),
    transports: Array.isArray(row.transports) ? row.transports : [],
  };
}

async function passkeyRegistrationOptions(req, body) {
  const playerId = String(body.playerId || "");
  const players = await db(`players?id=eq.${encodeURIComponent(playerId)}&active=eq.true&is_guest=eq.false&select=id,name,email`);
  const player = players?.[0];
  if (!player) return reply({ error: "Choose an active player profile first." }, 404);
  const { rpID } = webauthnContext(req);
  const existing = await db(`passkeys?player_id=eq.${encodeURIComponent(playerId)}&select=credential_id,transports`);
  const options = await generateRegistrationOptions({
    rpName: WEBAUTHN_RP_NAME,
    rpID,
    userID: Buffer.from(playerId),
    userName: player.email || `player-${playerId.slice(0, 8)}`,
    userDisplayName: player.name,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: (existing || []).map(row => ({ id: row.credential_id, transports: row.transports || [] })),
  });
  const challenge = await saveWebAuthnChallenge({ playerId, challengeType: "registration", challenge: options.challenge });
  return reply({ ok: true, challengeId: challenge.id, options });
}

async function passkeyRegistrationVerify(req, body) {
  const playerId = String(body.playerId || "");
  const challenge = await consumeWebAuthnChallenge(body.challengeId, "registration", playerId);
  if (!challenge) return reply({ error: "This passkey setup request expired. Start again." }, 409);
  const { rpID, origins } = webauthnContext(req);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.credential,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch (error) {
    console.error("Passkey registration verification failed", error);
    return reply({ error: "The passkey could not be verified. Please try again." }, 400);
  }
  if (!verification.verified || !verification.registrationInfo) return reply({ error: "The passkey could not be verified." }, 400);
  const info = verification.registrationInfo;
  const credential = info.credential;
  const friendlyName = String(body.friendlyName || "This device").trim().slice(0, 120) || "This device";
  try {
    await db("passkeys", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      player_id: playerId,
      credential_id: credential.id,
      public_key: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter || 0,
      transports: credential.transports || [],
      friendly_name: friendlyName,
      device_type: info.credentialDeviceType,
      backed_up: !!info.credentialBackedUp,
    }),
    });
  } catch (error) {
    if (/duplicate|unique/i.test(error?.message || "")) return reply({ error: "That passkey is already registered. Use a different device passkey." }, 409);
    throw error;
  }
  return reply({ ok: true, passkey: { friendlyName, deviceType: info.credentialDeviceType } });
}

async function passkeyAuthenticationOptions(req) {
  const { rpID } = webauthnContext(req);
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
  const challenge = await saveWebAuthnChallenge({ challengeType: "authentication", challenge: options.challenge });
  return reply({ ok: true, challengeId: challenge.id, options });
}

async function passkeyAuthenticationVerify(req, body) {
  const challenge = await consumeWebAuthnChallenge(body.challengeId, "authentication");
  if (!challenge) return reply({ error: "This passkey sign-in request expired. Start again." }, 409);
  const credentialId = String(body.credential?.id || "");
  const rows = await db(`passkeys?credential_id=eq.${encodeURIComponent(credentialId)}&select=*`);
  const stored = rows?.[0];
  if (!stored) return reply({ error: "That passkey is not registered for this club." }, 401);
  const owners = await db(`players?id=eq.${encodeURIComponent(stored.player_id)}&active=eq.true&is_guest=eq.false&select=id`);
  if (!owners?.length) return reply({ error: "This player profile is no longer active. Please contact the admin." }, 403);
  const { rpID, origins } = webauthnContext(req);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.credential,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      credential: credentialForVerification(stored),
      requireUserVerification: true,
    });
  } catch (error) {
    console.error("Passkey authentication verification failed", error);
    return reply({ error: "Passkey sign-in failed. Try again or use your PIN." }, 401);
  }
  if (!verification.verified) return reply({ error: "Passkey sign-in failed. Try again or use your PIN." }, 401);
  await db(`passkeys?id=eq.${encodeURIComponent(stored.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ counter: verification.authenticationInfo.newCounter, last_used_at: new Date().toISOString() }),
  });
  return reply({ ok: true, playerId: stored.player_id, token: await issuePlayerSession(stored.player_id, "Passkey login") });
}

async function listPasskeys(body) {
  const rows = await db(`passkeys?player_id=eq.${encodeURIComponent(body.playerId || "")}&select=id,friendly_name,device_type,backed_up,created_at,last_used_at&order=created_at.asc`);
  return reply({ ok: true, passkeys: rows || [] });
}

async function renamePasskey(body) {
  const name = String(body.friendlyName || "").trim();
  if (!body.passkeyId || !name || name.length > 120) return reply({ error: "Enter a passkey name up to 120 characters." }, 400);
  const rows = await db(`passkeys?id=eq.${encodeURIComponent(body.passkeyId)}&player_id=eq.${encodeURIComponent(body.playerId || "")}&select=id`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ friendly_name: name }) });
  if (!rows?.length) return reply({ error: "Passkey not found." }, 404);
  return reply({ ok: true });
}

async function deletePasskey(body) {
  if (!body.passkeyId) return reply({ error: "Choose a passkey." }, 400);
  const rows = await db(`passkeys?id=eq.${encodeURIComponent(body.passkeyId)}&player_id=eq.${encodeURIComponent(body.playerId || "")}&select=id`);
  if (!rows?.length) return reply({ error: "Passkey not found." }, 404);
  await db(`passkeys?id=eq.${encodeURIComponent(body.passkeyId)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  return reply({ ok: true });
}

function normalisePushPreferences(preferences = {}) {
  return {
    payments: preferences.payments !== false,
    eoi: preferences.eoi !== false,
    session: preferences.session !== false,
    matches: preferences.matches !== false,
  };
}

async function pushStatus(body) {
  if (!body.playerId) return reply({ error: "Choose your player profile first." }, 401);
  const subscriptions = await db(`push_subscriptions?player_id=eq.${encodeURIComponent(body.playerId)}&active=eq.true&select=preferences,updated_at&order=updated_at.desc&limit=1`);
  return reply({ configured: pushConfigured(), enabled: !!subscriptions?.length, preferences: normalisePushPreferences(subscriptions?.[0]?.preferences || {}) });
}

async function savePushSubscription(body) {
  const subscription = body.subscription || {};
  const endpoint = String(subscription.endpoint || "");
  const p256dh = String(subscription.keys?.p256dh || "");
  const auth = String(subscription.keys?.auth || "");
  if (!pushConfigured()) return reply({ error: "Push notifications are not configured yet." }, 503);
  if (!body.playerId || !/^https:\/\//.test(endpoint) || !p256dh || !auth) return reply({ error: "This device could not be registered for notifications." }, 400);
  await db("push_subscriptions?on_conflict=endpoint", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ player_id: body.playerId, endpoint, p256dh, auth, preferences: normalisePushPreferences(body.preferences), active: true, updated_at: new Date().toISOString() }),
  });
  return reply({ ok: true });
}

async function disablePushSubscription(body) {
  const endpoint = String(body.endpoint || "");
  if (!body.playerId || !endpoint) return reply({ error: "This device could not be removed." }, 400);
  await db(`push_subscriptions?player_id=eq.${encodeURIComponent(body.playerId)}&endpoint=eq.${encodeURIComponent(endpoint)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
  });
  return reply({ ok: true });
}

async function submitEoi(body) {
  if (!body.playerId || !body.eventId || !["yes", "no"].includes(body.status)) return reply({ error: "Invalid EOI." }, 400);
  const event = await getEvent(body.eventId);
  if (!event) return reply({ error: "Event not found." }, 404);
  const closesAt = new Date(localDateTimeToUtc(event.event_date, eventStartTime(event), event.timezone).getTime() - 6 * 60 * 60 * 1000);
  if (new Date() >= closesAt) return reply({ error: "The EOI deadline has passed." }, 409);
  let waitlistPosition = null;
  const existing = (await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}&select=status,waitlist_position`))?.[0] || null;
  if (body.status === "yes") {
    const current = await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&status=eq.yes&waitlist_position=is.null&select=player_id`);
    const alreadyIn = current.some(row => row.player_id === body.playerId);
    if (!alreadyIn && existing?.status === "yes" && existing.waitlist_position != null) {
      waitlistPosition = Number(existing.waitlist_position);
    } else if (!alreadyIn && current.length >= eventPlayerCap(event)) {
      const waiting = await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&waitlist_position=not.is.null&select=waitlist_position&order=waitlist_position.desc&limit=1`);
      waitlistPosition = Number(waiting?.[0]?.waitlist_position || 0) + 1;
    }
  }
  await db("eois?on_conflict=event_id,player_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ event_id: body.eventId, player_id: body.playerId, status: body.status, waitlist_position: body.status === "yes" ? waitlistPosition : null, updated_at: new Date().toISOString() }),
  });
  if (body.status === "yes" && Number.isInteger(waitlistPosition) && (!existing || existing.status !== "yes" || existing.waitlist_position == null)) {
    const player = (await db(`players?id=eq.${encodeURIComponent(body.playerId)}&select=name`))?.[0] || { name: "A player" };
    await notifyAdminWaitlist(event, player, waitlistPosition);
  }
  return reply({ ok: true, waitlisted: Number.isInteger(waitlistPosition) });
}

async function markPaid(body) {
  const event = await getEvent(body.eventId);
  if (!event || !body.playerId) return reply({ error: "Event or player not found." }, 404);
  if (new Date() < localDateTimeToUtc(event.event_date, eventEndTime(event), event.timezone)) return reply({ error: "Payments open after the game finishes." }, 409);
  const attending = await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&status=eq.yes&waitlist_position=is.null&select=player_id`);
  if (!attending.some(row => row.player_id === body.playerId)) return reply({ error: "Only players marked In can confirm payment." }, 403);
  const existingPayment = (await db(`payments?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}&select=amount`))?.[0] || null;
  const calculatedAmount = Number((totalCourtFee(event) / attending.length + Number(event.ball_fee)).toFixed(2));
  const amount = Number.isFinite(Number(existingPayment?.amount)) ? Number(existingPayment.amount) : calculatedAmount;
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
  const attendingRows = await db(`eois?event_id=eq.${encodeURIComponent(eventId)}&status=eq.yes&waitlist_position=is.null&select=player_id`);
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
    // Tie-break serving: the natural next server serves one point, then
    // serving changes every two points. The player shown is always the server
    // for the next point, including while the set is waiting to be saved.
    if (!next.completed) {
      const played = next.tiebreak_a + next.tiebreak_b;
      if (played === 1 || (played > 1 && played % 2 === 1)) {
        const server = nextServer(next);
        next.server_index = server.serverIndex;
        next.server_player_id = server.serverId;
      }
    }
    next.game_finished = false;
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
  const active = await db(`live_matches?event_id=eq.${encodeURIComponent(body.eventId)}&completed=eq.false&select=id`);
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
  let created;
  const createdPayload = { event_id: body.eventId, team_a_player_ids: teamA, team_b_player_ids: teamB, server_player_id: serverOrder[0], server_order: serverOrder, server_index: 0, created_by: body.playerId, active_scorer_id: body.playerId, scorer_lease_until: new Date(Date.now() + 5 * 60 * 1000).toISOString(), started_at: new Date().toISOString() };
  try {
    created = await db("live_matches?select=*", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(createdPayload),
    });
  } catch (error) {
    if (/active_scorer_id|scorer_lease_until|column/i.test(error?.message || "")) {
      const { active_scorer_id, scorer_lease_until, ...legacyPayload } = createdPayload;
      created = await db("live_matches?select=*", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(legacyPayload) });
    } else {
      if (/duplicate|unique/i.test(error?.message || "")) return reply({ error: "Finish or abandon the current live match first." }, 409);
      throw error;
    }
  }
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
  let serverOrder = match.server_order || [];
  // If the scorer corrects either of the two opening servers before the
  // rotation has moved beyond the opening pair, rebuild the four-player order
  // around those corrected first servers. Later servers then follow naturally.
  const gamesPlayed = Number(match.games_a || 0) + Number(match.games_b || 0);
  if (!match.is_tiebreak && gamesPlayed <= 1 && serverOrder.length === 4) {
    const teamA = match.team_a_player_ids || [], teamB = match.team_b_player_ids || [];
    if (teamA.includes(body.serverPlayerId)) {
      const bFirst = serverOrder.find(id => teamB.includes(id)) || teamB[0];
      serverOrder = buildServerOrder(teamA, teamB, body.serverPlayerId, bFirst);
    } else if (teamB.includes(body.serverPlayerId)) {
      const aFirst = serverOrder.find(id => teamA.includes(id)) || teamA[0];
      serverOrder = buildServerOrder(teamA, teamB, aFirst, body.serverPlayerId);
    }
  }
  const serverIndex = serverOrder.includes(body.serverPlayerId) ? serverOrder.indexOf(body.serverPlayerId) : Number(match.server_index || 0);
  const serverPatch = { server_player_id: body.serverPlayerId, server_order: serverOrder, server_index: serverIndex, needs_server_choice: false, active_scorer_id: body.playerId, scorer_lease_until: new Date(Date.now() + 5 * 60 * 1000).toISOString(), version: Number(match.version || 0) + 1, updated_at: new Date().toISOString() };
  let updated;
  try {
    updated = await db(`live_matches?id=eq.${encodeURIComponent(match.id)}&completed=eq.false&version=eq.${Number(match.version || 0)}&select=*`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(serverPatch) });
  } catch (error) {
    if (!/active_scorer_id|scorer_lease_until|column/i.test(error?.message || "")) throw error;
    const { active_scorer_id, scorer_lease_until, ...legacyPatch } = serverPatch;
    updated = await db(`live_matches?id=eq.${encodeURIComponent(match.id)}&completed=eq.false&version=eq.${Number(match.version || 0)}&select=*`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(legacyPatch) });
  }
  if (!updated?.length) return reply({ error: "This match changed on another device. Refresh and try again." }, 409);
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
  const actionId = String(body.actionId || "").trim();
  const validActionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actionId);
  if (validActionId) {
    try {
      const prior = await db(`live_point_actions?action_id=eq.${encodeURIComponent(actionId)}&live_match_id=eq.${encodeURIComponent(match.id)}&select=result`);
      if (prior?.[0]?.result) return reply(prior[0].result);
      await db("live_point_actions", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ action_id: actionId, live_match_id: match.id, winner: body.winner, status: "pending" }) });
    } catch (error) {
      if (/duplicate|unique/i.test(error?.message || "")) {
        const prior = await db(`live_point_actions?action_id=eq.${encodeURIComponent(actionId)}&select=result`);
        if (prior?.[0]?.result) return reply(prior[0].result);
        return reply({ error: "This point is already being synced. Refresh the match." }, 409);
      }
      if (!/live_point_actions|relation|column/i.test(error?.message || "")) throw error;
    }
  }
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
    version: Number(match.version || 0) + 1,
    updated_at: new Date().toISOString(),
    active_scorer_id: body.playerId,
    scorer_lease_until: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
  let updated;
  try {
    updated = await db(`live_matches?id=eq.${encodeURIComponent(match.id)}&completed=eq.false&version=eq.${Number(match.version || 0)}&select=*`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
  } catch (error) {
    if (!/active_scorer_id|scorer_lease_until|column/i.test(error?.message || "")) throw error;
    const { active_scorer_id, scorer_lease_until, ...legacyPatch } = patch;
    updated = await db(`live_matches?id=eq.${encodeURIComponent(match.id)}&completed=eq.false&version=eq.${Number(match.version || 0)}&select=*`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(legacyPatch) });
  }
  if (!updated?.length) {
    if (validActionId) await db(`live_point_actions?action_id=eq.${encodeURIComponent(actionId)}`, { method: "DELETE" }).catch(() => {});
    return reply({ error: "This score changed on another device. Refresh and try again." }, 409);
  }
  const result = { ok: true, completed: next.completed, gameFinished, nextServerId: next.server_player_id, matchId: match.id, match: updated?.[0] || { ...match, ...patch } };
  if (validActionId) await db(`live_point_actions?action_id=eq.${encodeURIComponent(actionId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "applied", result }) }).catch(() => {});
  return reply(result);
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
    version: Number(match.version || 0) + 1,
    updated_at: new Date().toISOString(),
  };
  const updated = await db(`live_matches?id=eq.${encodeURIComponent(match.id)}&version=eq.${Number(match.version || 0)}&select=*`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  if (!updated?.length) return reply({ error: "This match changed on another device. Refresh and try again." }, 409);
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

async function cleanupLiveMatch(matchId, scoreId = null) {
  try {
    await db(`live_matches?id=eq.${encodeURIComponent(matchId)}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
  } catch (error) {
    // Older databases may still have the original NO ACTION foreign key.
    // Detach the saved score, then retry cleanup so a completed match cannot
    // block the next match in the same event.
    if (!scoreId) throw error;
    await db(`match_scores?id=eq.${encodeURIComponent(scoreId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ live_match_id: null, updated_at: new Date().toISOString() }),
    });
    await db(`live_matches?id=eq.${encodeURIComponent(matchId)}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
  }
}

async function finishLiveMatch(body, adminOverride = false) {
  const rows = await db(`live_matches?id=eq.${encodeURIComponent(body.matchId || "")}&select=*`);
  const match = rows?.[0];
  if (!match || !body.playerId) {
    const alreadySaved = await db(`match_scores?live_match_id=eq.${encodeURIComponent(body.matchId || "")}&select=id`);
    if (alreadySaved?.length) return reply({ ok: true, alreadySaved: true });
    return reply({ error: "Live match not found." }, 404);
  }
  const event = await getEvent(match.event_id);
  const windowError = event ? scoringWindowError(event) : "Event not found.";
  if (windowError && !adminOverride) return reply({ error: windowError }, 403);
  const attending = await attendingSet(match.event_id, body.playerId);
  if (!attending && !adminOverride) return reply({ error: "Only players marked In can control live scoring." }, 403);
  if (!match.completed) return reply({ error: "The live set is not finished yet." }, 409);
  const existingSaved = await db(`match_scores?live_match_id=eq.${encodeURIComponent(match.id)}&select=id`);
  if (existingSaved?.length) {
    await cleanupLiveMatch(match.id, existingSaved[0].id);
    return reply({ ok: true, alreadySaved: true });
  }
  const endedAt = new Date().toISOString();
  const durationSeconds = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(match.started_at || match.created_at).getTime()) / 1000));
  await db(`live_matches?id=eq.${encodeURIComponent(match.id)}&completed=eq.true`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ended_at: endedAt, duration_seconds: durationSeconds, updated_at: endedAt }),
  });
  let savedRows = null;
  try {
    savedRows = await db("match_scores", {
      method: "POST",
      headers: { Prefer: "return=representation" },
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
        live_match_id: match.id,
        started_at: match.started_at || match.created_at,
        ended_at: endedAt,
        duration_seconds: durationSeconds,
      }),
    });
  } catch (error) {
    if (!/duplicate|unique/i.test(error?.message || "")) throw error;
    savedRows = await db(`match_scores?live_match_id=eq.${encodeURIComponent(match.id)}&select=id`);
  }
  const scoreId = savedRows?.[0]?.id || null;
  await cleanupLiveMatch(match.id, scoreId);
  return reply({ ok: true, alreadySaved: !scoreId });
}

async function submitScore(body) {
  const event = await getEvent(body.eventId);
  if (!event || !body.submittedBy) return reply({ error: "Event or player not found." }, 404);
  const windowError = scoringWindowError(event);
  if (windowError) return reply({ error: windowError }, 403);
  const attendingRows = await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&status=eq.yes&waitlist_position=is.null&select=player_id`);
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
  if (!stored && !/^\d{4,8}$/.test(INITIAL_PASSCODE)) return reply({ error: "Admin passcode is not configured. Set INITIAL_ADMIN_PASSCODE before first login." }, 503);
  if (!stored && body.passcode === INITIAL_PASSCODE) {
    await savePasscode(body.passcode);
    stored = await getPasscodeSetting();
  }
  if (!verifyPasscode(body.passcode, stored)) return reply({ error: "Incorrect passcode." }, 401);
  return reply({ ok: true, token: await createAdminSession() });
}

async function changePasscode(body) {
  const stored = await getPasscodeSetting();
  if (!verifyPasscode(body.currentPasscode || "", stored)) return reply({ error: "Current passcode is incorrect." }, 401);
  if (!/^\d{4,8}$/.test(body.newPasscode || "")) return reply({ error: "Use 4–8 numbers." }, 400);
  await savePasscode(body.newPasscode);
  return reply({ ok: true, token: await createAdminSession() });
}

async function saveEvent(body) {
  const allowed = ["event_date", "start_time", "end_time", "location", "suburb", "court_1_name", "court_fee", "court_2_enabled", "court_2_name", "court_2_start_time", "court_2_end_time", "court_2_fee", "ball_fee", "account_closed", "max_players", "cancellation_status", "cancellation_reason", "recap_notes", "award_player_id", "template_name"];
  const update = Object.fromEntries(Object.entries(body.changes || {}).filter(([key]) => allowed.includes(key)));
  if ("court_1_name" in update) update.court_1_name = String(update.court_1_name || "Court 1").trim() || "Court 1";
  if ("court_2_name" in update) update.court_2_name = String(update.court_2_name || "Court 2").trim() || "Court 2";
  const before = await getEvent(body.eventId);
  if (!before) return reply({ error: "Event not found." }, 404);
  const addingSecondCourt = !before.court_2_enabled && update.court_2_enabled === true;
  const meaningful = Object.keys(update).some(key => String(update[key]) !== String(before[key]));
  update.updated_at = new Date().toISOString();
  await db(`events?id=eq.${encodeURIComponent(body.eventId)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(update),
  });
  if (meaningful) {
    const updated = { ...before, ...update };
    if (addingSecondCourt) await promoteWaitlistForEvent(updated).catch(error => console.error("Waitlist promotion failed", error));
    const playerIds = await activePlayerIds();
    const closingWeek = update.account_closed === true && before.account_closed !== true;
    const closure = closingWeek ? await eventClosureNotification(updated).catch(error => {
      console.error("Event closure payment check failed", error);
      return null;
    }) : null;
    const title = closure?.title || `Session updated · ${eventLabel(updated)}`;
    const body = closure?.body || `${eventLabel(updated)} at ${eventDetails(updated)} was updated. Check the session details in the app.`;
    const notificationType = closure?.notificationType || "session";
    const notificationKey = closure?.notificationKey || `session-change:${updated.id}:${update.updated_at}`;
    await createPlayerNotifications(playerIds.map(player_id => ({ player_id, event_id: updated.id, notification_type: notificationType, title, body, url: `/?page=play&event=${encodeURIComponent(updated.id)}`, dedupe_key: notificationKey }))).catch(() => {});
    try {
      await notifyPlayers({ playerIds, notificationType, notificationKey, eventId: updated.id, title, body, url: `/?page=play&event=${encodeURIComponent(updated.id)}` });
    } catch (error) { console.error("Session push failed", error); }
  }
  return reply({ ok: true });
}

async function adminRejectWaitlist(body) {
  if (!body.eventId || !body.playerId) return reply({ error: "Choose a waitlisted player." }, 400);
  const event = await getEvent(body.eventId);
  if (!event) return reply({ error: "Event not found." }, 404);
  const rows = await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}&status=eq.yes&waitlist_position=not.is.null&select=player_id`);
  if (!rows?.length) return reply({ error: "That player is no longer waitlisted." }, 409);
  await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "no", waitlist_position: null, updated_at: new Date().toISOString() }) });
  const player = (await db(`players?id=eq.${encodeURIComponent(body.playerId)}&select=name`))?.[0] || { name: "Player" };
  const title = `EOI full · ${eventLabel(event)}`;
  const message = `${eventLabel(event)} at ${event.location}, ${event.suburb} is full this week. Your waitlist request was not accepted; please try again next week.`;
  await createPlayerNotifications([{ player_id: body.playerId, event_id: event.id, notification_type: "eoi", title, body: message, url: `/?page=play&event=${encodeURIComponent(event.id)}`, dedupe_key: `waitlist-rejected:${event.id}:${body.playerId}` }]).catch(() => {});
  try { await notifyPlayers({ playerIds: [body.playerId], notificationType: "eoi", notificationKey: `waitlist-rejected:${event.id}:${body.playerId}`, eventId: event.id, title, body: message, url: `/?page=play&event=${encodeURIComponent(event.id)}`, audience: "selected" }); } catch (error) { console.error("Waitlist rejection push failed", error); }
  return reply({ ok: true, player: player.name });
}

async function markNotificationRead(body, all = false) {
  if (!body.playerId) return reply({ error: "Choose your player profile first." }, 400);
  const filter = all ? `player_id=eq.${encodeURIComponent(body.playerId)}&read_at=is.null` : `player_id=eq.${encodeURIComponent(body.playerId)}&id=eq.${encodeURIComponent(body.notificationId || "")}`;
  await db(`player_notifications?${filter}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ read_at: new Date().toISOString() }) });
  return reply({ ok: true });
}

async function deleteEvent(body) {
  if (!body.eventId) return reply({ error: "Choose an event to delete." }, 400);
  const event = await getEvent(body.eventId);
  if (!event) return reply({ error: "Event not found." }, 404);
  const playerIds = await activePlayerIds();
  await db("deleted_event_dates?on_conflict=event_date", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ event_date: event.event_date, deleted_at: new Date().toISOString() }),
  });
  try {
    await db(`events?id=eq.${encodeURIComponent(body.eventId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    });
  } catch {
    // Legacy projects without deleted_at retain the historical hard-delete
    // behaviour; deleted_event_dates still prevents regeneration.
    await db(`events?id=eq.${encodeURIComponent(body.eventId)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  }
  try {
    const title = `Session cancelled · ${eventLabel(event)}`;
    const body = `${eventLabel(event)} at ${eventDetails(event)} has been cancelled.`;
    await createPlayerNotifications(playerIds.map(player_id => ({ player_id, event_id: event.id, notification_type: "session", title, body, url: `/?page=play&event=${encodeURIComponent(event.id)}`, dedupe_key: `session-cancelled:${event.id}` })));
    await notifyPlayers({ playerIds, notificationType: "session", notificationKey: `session-cancelled:${event.id}`, eventId: event.id, title, body, url: `/?page=play&event=${encodeURIComponent(event.id)}` });
  } catch (error) { console.error("Cancellation push failed", error); }
  return reply({ ok: true });
}

async function adminSendPush(body) {
  const event = body.eventId ? await getEvent(body.eventId) : null;
  if (body.eventId && !event) return reply({ error: "Choose a valid event." }, 404);
  const rawTitle = String(body.title || "Match update").trim().slice(0, 80);
  const rawMessage = String(body.message || "").trim().slice(0, 240);
  if (!rawMessage) return reply({ error: "Write the update first." }, 400);
  const label = event ? eventLabel(event) : "";
  const title = event && !rawTitle.includes(label) ? `${rawTitle} · ${label}` : rawTitle;
  const context = event ? `${label} at ${eventDetails(event)}` : "";
  const message = event && (!rawMessage.includes(label) || !rawMessage.includes(event.location)) ? `${context}. ${rawMessage}` : rawMessage;
  const audience = ["all", "attending", "selected"].includes(body.audience) ? body.audience : "all";
  let playerIds;
  if (audience === "attending") {
    if (!event) return reply({ error: "Choose a week when sending to players marked In." }, 400);
    playerIds = (await db(`eois?event_id=eq.${encodeURIComponent(event.id)}&status=eq.yes&select=player_id`)).map(row => row.player_id);
  } else if (audience === "selected") {
    const requested = Array.isArray(body.playerIds) ? body.playerIds : [];
    const ids = [...new Set(requested.map(id => String(id).trim()).filter(id => /^[0-9a-f-]{36}$/i.test(id)))];
    if (!ids.length) return reply({ error: "Choose at least one player." }, 400);
    const quoted = ids.map(id => `"${id}"`).join(",");
    playerIds = (await db(`players?id=in.(${quoted})&active=eq.true&select=id`)).map(row => row.id);
  } else {
    playerIds = await activePlayerIds();
  }
  const targetUrl = event ? `/?page=scores&event=${encodeURIComponent(event.id)}` : "/?page=play";
  const notificationKey = `admin-manual:${Date.now()}`;
  await createPlayerNotifications(playerIds.map(player_id => ({ player_id, event_id: event?.id || null, notification_type: "matches", title, body: message, url: targetUrl, dedupe_key: notificationKey }))).catch(() => {});
  const result = await notifyPlayers({ playerIds, notificationType: "matches", notificationKey, eventId: event?.id || null, title, body: message, url: targetUrl, audience });
  return reply({ ok: true, sent: result.sent || 0 });
}

async function adminAlertLog() {
  const [alerts, logs, subscriptions, players, events] = await Promise.all([
    db("push_alerts?select=*&order=created_at.desc&limit=300"),
    db("push_notification_log?select=*&order=sent_at.asc&limit=2000"),
    db("push_subscriptions?select=id,player_id"),
    db("players?select=id,name,is_guest"),
    db("events?select=id,event_date,location,suburb"),
  ]);
  const eventById = new Map((events || []).map(event => [event.id, event]));
  const playerById = new Map((players || []).map(player => [player.id, player]));
  const subscriptionPlayerById = new Map((subscriptions || []).map(subscription => [subscription.id, subscription.player_id]));
  const logsByKey = new Map();
  for (const log of logs || []) {
    const keyLogs = logsByKey.get(log.notification_key) || [];
    keyLogs.push(log);
    logsByKey.set(log.notification_key, keyLogs);
  }
  const rows = (alerts || []).map(alert => {
    const alertLogs = logsByKey.get(alert.notification_key) || [];
    const fallbackIds = [...new Set(alertLogs.map(log => log.player_id || subscriptionPlayerById.get(log.subscription_id)).filter(Boolean))];
    const recipientIds = Array.isArray(alert.recipient_ids) && alert.recipient_ids.length ? alert.recipient_ids.filter(Boolean) : fallbackIds;
    const deliveries = recipientIds.map(playerId => {
      const player = playerById.get(playerId);
      const playerLogs = alertLogs.filter(log => (log.player_id || subscriptionPlayerById.get(log.subscription_id)) === playerId);
      const statuses = playerLogs.map(log => log.status);
      const status = statuses.includes("sent") ? (statuses.includes("failed") ? "partial" : "sent") : statuses.includes("failed") ? "failed" : playerLogs.length ? "pending" : "not_sent";
      const failure = playerLogs.find(log => log.error_message);
      const delivered = playerLogs.find(log => log.status === "sent" && (log.delivered_at || log.sent_at));
      return { player_id: playerId, player_name: player?.name || "Unknown player", is_guest: Boolean(player?.is_guest), status, error_message: failure?.error_message || null, delivered_at: delivered?.delivered_at || null };
    });
    return { ...alert, event: alert.event_id ? eventById.get(alert.event_id) || null : null, deliveries };
  });
  return reply({ rows });
}

async function adminAlertSchedules() {
  const rows = await db("push_alert_schedules?select=*&order=sort_order.asc,name.asc");
  return reply({ rows });
}

function alertScheduleFields(body, code) {
  const name = String(body.name || "").trim().slice(0, 120);
  const notificationType = ["payments", "eoi", "session", "matches"].includes(body.notificationType) ? body.notificationType : "payments";
  const delayMinutes = Number(body.delayMinutes);
  const repeatValue = body.repeatIntervalMinutes === "" || body.repeatIntervalMinutes == null ? null : Number(body.repeatIntervalMinutes);
  const titleTemplate = String(body.titleTemplate || "Payment overdue · {date}").trim().slice(0, 120);
  const bodyTemplate = String(body.bodyTemplate || "{date}: ${amount} is still outstanding at {location}. PayID {payid}.").trim().slice(0, 500);
  const sortOrder = Number.isFinite(Number(body.sortOrder)) ? Math.max(0, Math.min(9999, Number(body.sortOrder))) : 100;
  if (name.length < 2) return { error: "Give this scheduled alert a name." };
  if (!Number.isFinite(delayMinutes) || delayMinutes < 0 || delayMinutes > 525600) return { error: "Delay must be between 0 minutes and 1 year." };
  if (repeatValue !== null && (!Number.isFinite(repeatValue) || repeatValue <= 0 || repeatValue > 525600)) return { error: "Repeat interval must be blank or between 1 minute and 1 year." };
  if (!titleTemplate || !bodyTemplate) return { error: "Add a notification title and message." };
  return { code, name, notification_type: notificationType, delay_minutes: Math.round(delayMinutes), repeat_interval_minutes: repeatValue === null ? null : Math.round(repeatValue), title_template: titleTemplate, body_template: bodyTemplate, enabled: body.enabled !== false, sort_order: Math.round(sortOrder), updated_at: new Date().toISOString() };
}

async function adminSaveAlertSchedule(body) {
  const id = String(body.id || "").trim();
  if (id && !/^[0-9a-f-]{36}$/i.test(id)) return reply({ error: "Choose a valid scheduled alert." }, 400);
  let code = String(body.code || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  if (!code) code = `custom-${randomUUID()}`;
  const fields = alertScheduleFields(body, code);
  if (fields.error) return reply({ error: fields.error }, 400);
  if (id) {
    const updated = await db(`push_alert_schedules?id=eq.${encodeURIComponent(id)}&select=*`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(fields) });
    if (!updated?.length) return reply({ error: "Scheduled alert was not found." }, 404);
    return reply({ ok: true, row: updated[0] });
  }
  const inserted = await db("push_alert_schedules", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(fields) });
  return reply({ ok: true, row: inserted?.[0] || null });
}

async function adminDeleteAlertSchedule(body) {
  const id = String(body.id || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return reply({ error: "Choose a valid scheduled alert." }, 400);
  await db(`push_alert_schedules?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  return reply({ ok: true });
}

async function addPlayer(body) {
  const name = String(body.name || "").trim();
  if (name.length < 2 || name.length > 80 || !/^[\p{L}\p{N} .'-]+$/u.test(name)) return reply({ error: "Use letters, numbers, spaces, apostrophes or hyphens only for player names." }, 400);
  await db("players?on_conflict=name", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ name, active: true }),
  });
  return reply({ ok: true });
}

function validGuestName(name) {
  return name.length >= 2 && name.length <= 80 && /^[\p{L}\p{N} .'-]+$/u.test(name);
}

async function resolveGuestOf(guestOfPlayerId) {
  const id = String(guestOfPlayerId || "").trim();
  if (!id) return { id: null, name: null };
  const rows = await db(`players?id=eq.${encodeURIComponent(id)}&active=eq.true&is_guest=eq.false&select=id,name`);
  if (!rows?.[0]) return { error: "Choose an active permanent member for Guest of." };
  return { id: rows[0].id, name: rows[0].name };
}

async function createGuestParticipant({ eventId, name, email = null, status = "yes", guestOfPlayerId = undefined }) {
  const guestOf = guestOfPlayerId === undefined ? undefined : await resolveGuestOf(guestOfPlayerId);
  if (guestOf?.error) return { error: guestOf.error };
  const existingRows = await db(`players?name=eq.${encodeURIComponent(name)}&select=id,name,email,active,is_guest,guest_event_id,guest_of_player_id`);
  let player = existingRows?.[0] || null;
  if (player) {
    if (!player.is_guest || player.guest_event_id !== eventId) {
      return { error: "That name is already on the main roster. Use a different guest name." };
    }
    const update = {};
    if (email && email !== player.email) update.email = email;
    if (guestOfPlayerId !== undefined) update.guest_of_player_id = guestOf.id;
    if (Object.keys(update).length) {
      const updated = await db(`players?id=eq.${encodeURIComponent(player.id)}&select=id,name,email,active,is_guest,guest_event_id`, {
        method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(update),
      });
      player = updated?.[0] || player;
    }
  } else {
    const created = await db("players", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ name, email: email || null, active: true, is_guest: true, guest_event_id: eventId, guest_of_player_id: guestOfPlayerId === undefined ? null : guestOf.id }),
    });
    player = created?.[0] || null;
  }
  if (!player) return { error: "The guest could not be added." };
  await db("eois?on_conflict=event_id,player_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ event_id: eventId, player_id: player.id, status: status === "no" ? "no" : "yes", waitlist_position: null, updated_at: new Date().toISOString() }),
  });
  await recordGuestHistory(player, eventId, guestOf);
  return { player };
}

async function recordGuestHistory(player, eventId, guestOf = undefined) {
  try {
    await db("guest_history?on_conflict=event_id,guest_player_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        guest_player_id: player.id,
        event_id: eventId,
        guest_name: player.name,
        guest_email: player.email || null,
        ...(guestOf === undefined ? {} : { guest_of_player_id: guestOf.id || null, guest_of_name: guestOf.name || null }),
        assigned_at: new Date().toISOString(),
      }),
    });
  } catch {
    // Keep guest RSVP usable while an older deployment is waiting for the
    // guest archive migration. The migration backfill captures existing rows.
  }
}

async function addGuest(body) {
  if (!body.eventId) return reply({ error: "Choose a week for the guest." }, 400);
  const event = await getEvent(body.eventId);
  if (!event) return reply({ error: "Event not found." }, 404);
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim() || null;
  if (!validGuestName(name)) return reply({ error: "Use a guest name with 2–80 letters, numbers, spaces, apostrophes or hyphens." }, 400);
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return reply({ error: "Enter a valid email address, or leave it blank." }, 400);
  const guestOfPlayerId = Object.prototype.hasOwnProperty.call(body, "guestOfPlayerId") ? body.guestOfPlayerId : undefined;
  const result = await createGuestParticipant({ eventId: event.id, name, email, status: "yes", guestOfPlayerId });
  if (result.error) return reply({ error: result.error }, 409);
  return reply({ ok: true, player: result.player });
}

async function createGuestInvite(body) {
  if (!body.eventId) return reply({ error: "Choose a week for the invite." }, 400);
  const event = await getEvent(body.eventId);
  if (!event) return reply({ error: "Event not found." }, 404);
  let token = event.guest_invite_token;
  if (!token) {
    token = randomBytes(24).toString("base64url");
    await db(`events?id=eq.${encodeURIComponent(event.id)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ guest_invite_token: token }),
    });
  }
  const origin = String(process.env.APP_URL || "https://banglasplayingtennis.netlify.app").replace(/\/$/, "");
  return reply({ ok: true, eventId: event.id, token, url: `${origin}/?guest=${encodeURIComponent(event.id)}&invite=${encodeURIComponent(token)}` });
}

async function guestInviteInfo(body) {
  if (!body.eventId || !body.token) return reply({ error: "This guest invite is incomplete." }, 400);
  const event = await getEvent(body.eventId);
  if (!event || event.guest_invite_token !== body.token) return reply({ error: "This guest invite is invalid or expired." }, 404);
  return reply({ ok: true, event: {
    id: event.id, event_date: event.event_date, start_time: event.start_time, end_time: event.end_time,
    location: event.location, suburb: event.suburb, court_1_name: event.court_1_name,
    court_2_enabled: event.court_2_enabled, court_2_name: event.court_2_name,
    court_2_start_time: event.court_2_start_time, court_2_end_time: event.court_2_end_time,
  } });
}

async function guestRsvp(body) {
  if (!body.eventId || !body.token) return reply({ error: "This guest invite is incomplete." }, 400);
  const event = await getEvent(body.eventId);
  if (!event || event.guest_invite_token !== body.token) return reply({ error: "This guest invite is invalid or expired." }, 404);
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim() || null;
  if (!validGuestName(name)) return reply({ error: "Use a guest name with 2–80 letters, numbers, spaces, apostrophes or hyphens." }, 400);
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return reply({ error: "Enter a valid email address, or leave it blank." }, 400);
  const result = await createGuestParticipant({ eventId: event.id, name, email, status: body.status === "no" ? "no" : "yes" });
  if (result.error) return reply({ error: result.error }, 409);
  return reply({ ok: true, name: result.player.name, status: body.status === "no" ? "no" : "yes" });
}

async function removePlayer(body) {
  await db(`players?id=eq.${encodeURIComponent(body.playerId)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ active: false }),
  });
  return reply({ ok: true });
}

async function resetPlayerPin(body) {
  if (!body.playerId) return reply({ error: "Choose a player." }, 400);
  await db(`players?id=eq.${encodeURIComponent(body.playerId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ pin_hash: null, pin_updated_at: new Date().toISOString(), pin_failed_attempts: 0, pin_locked_at: null }),
  });
  // Resetting a PIN is an identity recovery action; revoke existing passkeys
  // so the player can re-enrol only after setting the new PIN.
  await db(`passkeys?player_id=eq.${encodeURIComponent(body.playerId)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => {});
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
      waitlist_position: null,
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
  const existingPayment = (await db(`payments?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}&select=amount`))?.[0] || null;
  const calculatedAmount = Number((totalCourtFee(event) / attending.length + Number(event.ball_fee)).toFixed(2));
  const amount = Number.isFinite(Number(existingPayment?.amount)) ? Number(existingPayment.amount) : calculatedAmount;
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
    return reply({ error: `This upload would exceed the 5 GB gallery limit. Remaining space: about ${remainingMb} MB.` }, 409);
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

async function createPlayerAvatarUpload(body) {
  const originalName = String(body.fileName || "").trim();
  const mimeType = String(body.mimeType || "").toLowerCase();
  const fileSize = Number(body.fileSize);
  if (!body.playerId || !originalName || !/^image\//.test(mimeType)) return reply({ error: "Choose an image for your display picture." }, 400);
  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > AVATAR_MAX_BYTES) return reply({ error: "Display pictures must be 5 MB or smaller." }, 400);
  const players = await db(`players?id=eq.${encodeURIComponent(body.playerId)}&active=eq.true&select=id`);
  if (!players.length) return reply({ error: "Select an active player before uploading." }, 403);
  const mimeExtensions = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/heic": ".heic", "image/heif": ".heif" };
  const extensionMatch = originalName.toLowerCase().match(/\.([a-z0-9]{1,10})$/);
  const extension = extensionMatch ? `.${extensionMatch[1]}` : (mimeExtensions[mimeType] || ".img");
  const path = `avatars/${body.playerId}/${randomUUID()}${extension}`;
  const { data, error } = await storageClient().storage.from(MEDIA_BUCKET).createSignedUploadUrl(path);
  if (error || !data?.signedUrl) throw error || new Error("Could not create the avatar upload URL.");
  return reply({ ok: true, path, signedUrl: data.signedUrl });
}

async function updatePlayerProfile(body) {
  const playerId = String(body.playerId || "");
  if (!playerId) return reply({ error: "Choose your player profile first." }, 400);
  const rows = await db(`players?id=eq.${encodeURIComponent(playerId)}&active=eq.true&select=id,name,email,mobile,address,avatar_path`);
  const existing = rows?.[0];
  if (!existing) return reply({ error: "Active player profile not found." }, 404);
  const update = {};
  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (name.length < 2 || name.length > 80 || !/^[\p{L}\p{N} .'-]+$/u.test(name)) return reply({ error: "Use 2–80 letters, numbers, spaces, apostrophes or hyphens for your name." }, 400);
    update.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(body, "email")) {
    const email = String(body.email || "").trim();
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return reply({ error: "Enter a valid email address, or leave it blank." }, 400);
    update.email = email || null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "mobile")) {
    const mobile = String(body.mobile || "").trim();
    if (mobile && !/^[0-9+() .-]{6,24}$/.test(mobile)) return reply({ error: "Enter a valid mobile number, or leave it blank." }, 400);
    update.mobile = mobile || null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "address")) {
    const address = String(body.address || "").trim();
    if (address.length > 200) return reply({ error: "Address must be 200 characters or fewer." }, 400);
    update.address = address || null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "avatarPath")) {
    const path = String(body.avatarPath || "").trim();
    const avatarPrefix = `avatars/${playerId}/`;
    if (path && (!path.startsWith(avatarPrefix) || !/^[a-f0-9-]+\.[a-z0-9]{1,10}$/i.test(path.slice(avatarPrefix.length)))) return reply({ error: "That display picture upload is invalid." }, 400);
    if (path) {
      const segments = path.split("/");
      const fileName = segments.pop();
      const folder = segments.join("/");
      const { data: stored, error } = await storageClient().storage.from(MEDIA_BUCKET).list(folder, { search: fileName, limit: 10 });
      if (error || !stored?.some(item => item.name === fileName)) return reply({ error: "The uploaded display picture could not be verified." }, 409);
    }
    update.avatar_path = path || null;
  }
  if (!Object.keys(update).length) return reply({ error: "Nothing to update." }, 400);
  if (update.name && update.name !== existing.name) {
    const conflicts = await db(`players?name=eq.${encodeURIComponent(update.name)}&id=neq.${encodeURIComponent(playerId)}&select=id`);
    if (conflicts?.length) return reply({ error: "That player name is already in use. Choose another name." }, 409);
  }
  await db(`players?id=eq.${encodeURIComponent(playerId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(update) });
  if (update.avatar_path && existing.avatar_path && update.avatar_path !== existing.avatar_path) {
    await storageClient().storage.from(MEDIA_BUCKET).remove([existing.avatar_path]).catch(() => {});
  }
  const player = { ...existing, ...update, avatar_url: update.avatar_path ? await mediaUrl(update.avatar_path) : null };
  return reply({ ok: true, player });
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
  if (body.consentConfirmed !== true) return reply({ error: "Please confirm that everyone shown has consented to this upload." }, 400);
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
      album: String(body.album || "General").trim().slice(0, 80) || "General",
      tags: Array.isArray(body.tags) ? body.tags.map(tag => String(tag).trim().slice(0, 30)).filter(Boolean).slice(0, 12) : [],
      consent_confirmed: true,
    }),
  });
  return reply({ ok: true });
}

async function reportMedia(body) {
  const rows = await db(`media_items?id=eq.${encodeURIComponent(body.mediaId || "")}&select=id`);
  if (!rows?.length) return reply({ error: "Media item not found." }, 404);
  await db(`media_items?id=eq.${encodeURIComponent(body.mediaId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ reported_at: new Date().toISOString(), report_reason: String(body.reason || "Reported by player").slice(0, 240) }) });
  return reply({ ok: true });
}

async function favoriteMedia(body) {
  if (!body.mediaId || typeof body.favorite !== "boolean") return reply({ error: "Choose a media item." }, 400);
  const rows = await db(`media_items?id=eq.${encodeURIComponent(body.mediaId)}&select=id`);
  if (!rows?.length) return reply({ error: "Media item not found." }, 404);
  try {
    if (body.favorite) {
      await db("media_favourites", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify({ player_id: body.playerId, media_id: body.mediaId }),
      });
    } else {
      await db(`media_favourites?player_id=eq.${encodeURIComponent(body.playerId)}&media_id=eq.${encodeURIComponent(body.mediaId)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    }
  } catch {
    return reply({ error: "Favorites are not ready yet. Apply 032_media_favourites.sql in Supabase." }, 503);
  }
  return reply({ ok: true });
}

async function deleteOwnMedia(body) {
  const rows = await db(`media_items?id=eq.${encodeURIComponent(body.mediaId || "")}&player_id=eq.${encodeURIComponent(body.playerId || "")}&select=id,storage_path`);
  const item = rows?.[0];
  if (!item) return reply({ error: "You can only delete media that you uploaded." }, 403);
  await storageClient().storage.from(MEDIA_BUCKET).remove([item.storage_path]);
  await db(`media_items?id=eq.${encodeURIComponent(item.id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
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
  if (typeof body.name === "string" && body.name.trim()) {
    const name = body.name.trim();
    if (name.length > 80 || !/^[\p{L}\p{N} .'-]+$/u.test(name)) return reply({ error: "Use letters, numbers, spaces, apostrophes or hyphens only for player names." }, 400);
    update.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(body, "email")) {
    const email = String(body.email || "").trim();
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return reply({ error: "Enter a valid email address, or leave it blank." }, 400);
    update.email = email || null;
  }
  if (!body.playerId || !Object.keys(update).length) return reply({ error: "Nothing to update." }, 400);
  await db(`players?id=eq.${encodeURIComponent(body.playerId)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(update),
  });
  return reply({ ok: true });
}

async function updateGuest(body) {
  if (!body.playerId) return reply({ error: "Choose a guest." }, 400);
  const guestRows = await db(`players?id=eq.${encodeURIComponent(body.playerId)}&is_guest=eq.true&select=id,name,is_guest,guest_of_player_id`);
  if (!guestRows?.length) return reply({ error: "That player is not in the guest archive." }, 404);
  const update = {};
  if (typeof body.name === "string" && body.name.trim()) {
    const name = body.name.trim();
    if (name.length > 80 || !/^[\p{L}\p{N} .'-]+$/u.test(name)) return reply({ error: "Use letters, numbers, spaces, apostrophes or hyphens only for guest names." }, 400);
    update.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(body, "email")) {
    const email = String(body.email || "").trim();
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return reply({ error: "Enter a valid email address, or leave it blank." }, 400);
    update.email = email || null;
  }
  let guestOf;
  if (Object.prototype.hasOwnProperty.call(body, "guestOfPlayerId")) {
    guestOf = await resolveGuestOf(body.guestOfPlayerId);
    if (guestOf.error) return reply({ error: guestOf.error }, 400);
    update.guest_of_player_id = guestOf.id;
  }
  if (!Object.keys(update).length) return reply({ error: "Nothing to update." }, 400);
  const updatedRows = await db(`players?id=eq.${encodeURIComponent(body.playerId)}&select=id,name,active,is_guest,guest_event_id,guest_of_player_id`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(update),
  });
  const updated = updatedRows?.[0] || { ...guestRows[0], ...update };
  // Keep the reusable archive's historical snapshots aligned with the guest
  // record after a rename or Guest-of change. Older deployments may not have
  // the archive table yet, so this must never block the player update.
  const historyUpdate = {};
  if (Object.prototype.hasOwnProperty.call(update, "name")) historyUpdate.guest_name = update.name;
  if (Object.prototype.hasOwnProperty.call(update, "guest_of_player_id")) {
    historyUpdate.guest_of_player_id = update.guest_of_player_id;
    historyUpdate.guest_of_name = guestOf?.name || null;
  }
  if (Object.keys(historyUpdate).length) {
    await db(`guest_history?guest_player_id=eq.${encodeURIComponent(body.playerId)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(historyUpdate),
    }).catch(() => {});
  }
  return reply({ ok: true, player: updated });
}

async function promoteGuest(body) {
  if (!body.playerId) return reply({ error: "Choose a guest." }, 400);
  const guests = await db(`players?id=eq.${encodeURIComponent(body.playerId)}&is_guest=eq.true&select=id,name,active`);
  const guest = guests?.[0];
  if (!guest) return reply({ error: "That player is not in the guest archive." }, 404);
  const conflicts = await db(`players?name=eq.${encodeURIComponent(guest.name)}&is_guest=eq.false&select=id`);
  if (conflicts?.length) return reply({ error: "A permanent roster player already has that name. Rename the guest first." }, 409);
  await db(`players?id=eq.${encodeURIComponent(guest.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ active: true, is_guest: false, guest_event_id: null, guest_of_player_id: null }),
  });
  return reply({ ok: true, playerId: guest.id, name: guest.name });
}

async function assignGuest(body) {
  if (!body.playerId || !body.eventId) return reply({ error: "Choose a guest and a week." }, 400);
  const event = await getEvent(body.eventId);
  if (!event) return reply({ error: "Event not found." }, 404);
  const guests = await db(`players?id=eq.${encodeURIComponent(body.playerId)}&is_guest=eq.true&select=id,name,email,active,is_guest,guest_event_id,guest_of_player_id`);
  const guest = guests?.[0];
  if (!guest) return reply({ error: "Choose a guest from the archive." }, 404);
  const guestOfPlayerId = Object.prototype.hasOwnProperty.call(body, "guestOfPlayerId") ? body.guestOfPlayerId : undefined;
  const guestOf = guestOfPlayerId === undefined ? undefined : await resolveGuestOf(guestOfPlayerId);
  if (guestOf?.error) return reply({ error: guestOf.error }, 400);
  const playerUpdate = { active: true, guest_event_id: event.id };
  if (guestOfPlayerId !== undefined) playerUpdate.guest_of_player_id = guestOf.id;
  await db(`players?id=eq.${encodeURIComponent(guest.id)}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(playerUpdate),
  });
  await db("eois?on_conflict=event_id,player_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ event_id: event.id, player_id: guest.id, status: "yes", waitlist_position: null, updated_at: new Date().toISOString() }),
  });
  await recordGuestHistory(guest, event.id, guestOf);
  return reply({ ok: true, playerId: guest.id, eventId: event.id });
}

async function adminAuditLog() {
  const rows = await db("audit_log?select=*&order=created_at.desc&limit=200");
  const [players, events, media, scores, badges] = await Promise.all([
    db("players?select=id,name"),
    db("events?select=id,event_date,location,suburb"),
    db("media_items?select=id,title"),
    db("match_scores?select=id,event_id"),
    db("badges?select=id,name").catch(() => []),
  ]);
  const playerNames = new Map((players || []).map(player => [player.id, player.name]));
  const eventNames = new Map((events || []).map(event => [event.id, `${event.event_date} · ${event.location}${event.suburb ? `, ${event.suburb}` : ""}`]));
  const mediaNames = new Map((media || []).map(item => [item.id, item.title]));
  const scoreEvents = new Map((scores || []).map(score => [score.id, eventNames.get(score.event_id) || "Saved match"]));
  const badgeNames = new Map((badges || []).map(badge => [badge.id, badge.name]));
  const enriched = (rows || []).map(row => {
    const details = row.details || {};
    const subjectId = details.playerId || details.player_id || details.submittedBy || details.submitted_by;
    const targetName = row.target_type === "event" ? eventNames.get(row.target_id)
      : row.target_type === "player" ? playerNames.get(row.target_id)
      : row.target_type === "media" ? mediaNames.get(row.target_id)
      : row.target_type === "score" ? scoreEvents.get(row.target_id)
      : row.target_type === "badge" ? badgeNames.get(row.target_id)
      : null;
    return {
      ...row,
      actor_name: row.actor_name || (row.actor_player_id ? playerNames.get(row.actor_player_id) : null) || (row.actor_type === "admin" ? ADMIN_DISPLAY_NAME : "Anonymous visitor"),
      target_name: targetName || null,
      subject_name: subjectId ? (playerNames.get(subjectId) || "Unknown player") : null,
    };
  });
  return reply({ ok: true, rows: enriched });
}

async function adminSetAttendance(body) {
  if (!body.eventId || !body.playerId || !["pending", "attended", "late", "no_show", "substitute"].includes(body.attendanceStatus)) return reply({ error: "Choose a valid attendance status." }, 400);
  await db(`eois?event_id=eq.${encodeURIComponent(body.eventId)}&player_id=eq.${encodeURIComponent(body.playerId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ attendance_status: body.attendanceStatus, checked_in_at: body.attendanceStatus === "pending" ? null : new Date().toISOString(), updated_at: new Date().toISOString() }) });
  return reply({ ok: true });
}

async function duplicateEvent(body) {
  const source = await getEvent(body.eventId);
  if (!source) return reply({ error: "Event not found." }, 404);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.newDate || "")) return reply({ error: "Choose a valid new date." }, 400);
  const copy = { ...source, event_date: body.newDate, id: undefined, created_at: undefined, updated_at: new Date().toISOString(), account_closed: false };
  delete copy.id; delete copy.created_at;
  const created = await db("events", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(copy) });
  return reply({ ok: true, event: created?.[0] || null });
}

async function runAudited(req, action, body, operation) {
  let beforeState = null;
  const highFrequency = ["eoi", "paid", "score"].includes(action);
  if (!highFrequency) {
    try {
      if (body?.eventId) beforeState = (await db(`events?id=eq.${encodeURIComponent(body.eventId)}&select=*`))?.[0] || null;
      else if (body?.scoreId) beforeState = (await db(`match_scores?id=eq.${encodeURIComponent(body.scoreId)}&select=*`))?.[0] || null;
      else if (body?.mediaId) beforeState = (await db(`media_items?id=eq.${encodeURIComponent(body.mediaId)}&select=*`))?.[0] || null;
      else if (body?.badgeId || (body?.id && ["admin-save-badge", "admin-delete-badge"].includes(action))) beforeState = (await db(`badges?id=eq.${encodeURIComponent(body.badgeId || body.id)}&select=*`))?.[0] || null;
      else if (body?.playerId) beforeState = (await db(`players?id=eq.${encodeURIComponent(body.playerId)}&select=id,name,active,email,mobile,address,avatar_path`))?.[0] || null;
    } catch { /* audit must never block the requested action */ }
  }
  const result = await operation();
  let afterState = body?.changes || null;
  if (!highFrequency) {
    try {
      if (body?.eventId) afterState = (await db(`events?id=eq.${encodeURIComponent(body.eventId)}&select=*`))?.[0] || afterState;
      else if (body?.scoreId) afterState = (await db(`match_scores?id=eq.${encodeURIComponent(body.scoreId)}&select=*`))?.[0] || afterState;
      else if (body?.mediaId) afterState = (await db(`media_items?id=eq.${encodeURIComponent(body.mediaId)}&select=*`))?.[0] || afterState;
      else if (body?.badgeId || (body?.id && ["admin-save-badge", "admin-delete-badge"].includes(action))) afterState = (await db(`badges?id=eq.${encodeURIComponent(body.badgeId || body.id)}&select=*`))?.[0] || afterState;
      else if (body?.playerId) afterState = (await db(`players?id=eq.${encodeURIComponent(body.playerId)}&select=id,name,active,email,mobile,address,avatar_path`))?.[0] || afterState;
    } catch { /* ignore */ }
  }
  await writeAudit(req, action, body, result.status >= 400 ? "failed" : "success", beforeState, afterState);
  return result;
}

export default async (req) => {
  try {
    requireConfiguration();
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "state";
    const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
    const adminSessionValid = await isAdminSession(req);

    if (req.method === "POST" && ["player-login", "admin-login", "passkey-auth-options", "passkey-auth-verify"].includes(action) && !consumeRateLimit(req, action, 20)) {
      return reply({ error: "Too many sign-in attempts. Please wait a minute and try again." }, 429, { "retry-after": "60" });
    }
    if (req.method === "POST" && ["player-pin-status", "player-create-pin"].includes(action) && !consumeRateLimit(req, `${action}:${body.playerId || "unknown"}`, 8, 15 * 60_000)) {
      return reply({ error: "Too many PIN setup requests for this player. Please try again later." }, 429, { "retry-after": "900" });
    }

    if (req.method === "GET" && action === "state") return reply(await appState(req));
    if (req.method === "GET" && action === "media-state") return mediaState(req);
    if (req.method === "GET" && action === "live-state") return liveState();
    if (req.method === "GET" && action === "eoi-state") return eoiState();
    if (req.method === "POST" && action === "player-pin-status") return playerPinStatus(body);
    if (req.method === "POST" && action === "player-create-pin") return createPlayerPin(body);
    if (req.method === "POST" && action === "player-login") return playerLogin(body);
    if (req.method === "POST" && action === "passkey-auth-options") return passkeyAuthenticationOptions(req);
    if (req.method === "POST" && action === "passkey-auth-verify") return passkeyAuthenticationVerify(req, body);
    if (req.method === "POST" && action === "guest-invite-info") return guestInviteInfo(body);
    if (req.method === "POST" && action === "guest-rsvp") return guestRsvp(body);

    if (req.method === "GET" && action === "push-public-key") return reply({ configured: pushConfigured(), publicKey: VAPID_PUBLIC_KEY || null });
    if (req.method === "GET" && action === "realtime-config") return reply({ configured: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY), url: SUPABASE_URL || null, anonKey: SUPABASE_ANON_KEY || null });
    if (req.method === "GET" && action === "sync-version") return syncVersion();

    const playerActions = ["eoi", "paid", "score", "live-start", "live-server", "live-point", "live-undo", "live-abandon", "live-finish", "event-note", "media-upload-url", "media-finalize", "media-report", "media-delete", "media-favorite", "push-status", "push-subscribe", "push-unsubscribe", "player-update-profile", "player-avatar-upload-url", "notification-read", "notification-read-all", "passkey-register-options", "passkey-register-verify", "passkey-list", "passkey-rename", "passkey-delete", "player-logout-all"];
    if (playerActions.includes(action)) {
      const playerId = body.playerId || body.submittedBy;
      if (!playerId) return reply({ error: "Choose your player profile first." }, 401);
      if (!adminSessionValid && !(await isPlayer(req, playerId))) {
        return reply({ error: "Your player session has expired. Please enter your PIN again." }, 401);
      }
    }
    if (req.method === "POST" && action === "eoi") return runAudited(req, action, body, () => submitEoi(body));
    if (req.method === "POST" && action === "paid") return runAudited(req, action, body, () => markPaid(body));
    if (req.method === "POST" && action === "score") return runAudited(req, action, body, () => submitScore(body));
    if (req.method === "POST" && action === "live-start") return startLiveMatch(body, adminSessionValid);
    if (req.method === "POST" && action === "live-server") return updateLiveServer(body, adminSessionValid);
    if (req.method === "POST" && action === "live-point") return addLivePoint(body, adminSessionValid);
    if (req.method === "POST" && action === "live-undo") return undoLivePoint(body, adminSessionValid);
    if (req.method === "POST" && action === "live-abandon") return abandonLiveMatch(body, adminSessionValid);
    if (req.method === "POST" && action === "live-finish") return finishLiveMatch(body, adminSessionValid);
    if (req.method === "POST" && action === "event-note") return saveEventNote(body);
    if (req.method === "POST" && action === "media-upload-url") return createMediaUpload(body);
    if (req.method === "POST" && action === "media-finalize") return finalizeMediaUpload(body);
    if (req.method === "POST" && action === "media-report") return runAudited(req, action, body, () => reportMedia(body));
    if (req.method === "POST" && action === "media-delete") return runAudited(req, action, body, () => deleteOwnMedia(body));
    if (req.method === "POST" && action === "media-favorite") return runAudited(req, action, body, () => favoriteMedia(body));
    if (req.method === "POST" && action === "push-status") return pushStatus(body);
    if (req.method === "POST" && action === "push-subscribe") return savePushSubscription(body);
    if (req.method === "POST" && action === "push-unsubscribe") return disablePushSubscription(body);
    if (req.method === "POST" && action === "player-avatar-upload-url") return createPlayerAvatarUpload(body);
    if (req.method === "POST" && action === "player-update-profile") return runAudited(req, action, body, () => updatePlayerProfile(body));
    if (req.method === "POST" && action === "passkey-register-options") return passkeyRegistrationOptions(req, body);
    if (req.method === "POST" && action === "passkey-register-verify") return passkeyRegistrationVerify(req, body);
    if (req.method === "POST" && action === "passkey-list") return listPasskeys(body);
    if (req.method === "POST" && action === "passkey-rename") return renamePasskey(body);
    if (req.method === "POST" && action === "passkey-delete") return deletePasskey(body);
    if (req.method === "POST" && action === "player-logout-all") return revokePlayerSessions(body);
    if (req.method === "POST" && action === "notification-read") return markNotificationRead(body);
    if (req.method === "POST" && action === "notification-read-all") return markNotificationRead(body, true);
    if (req.method === "POST" && action === "admin-login") return adminLogin(body);
    if (req.method === "GET" && action === "admin-state") {
      if (!adminSessionValid) return reply({ error: "Admin session expired." }, 401);
      return reply(await adminState());
    }
    if (req.method === "GET" && action === "admin-backup") return adminBackup(req);

    if (req.method === "GET" && action === "admin-audit-log") {
      if (!adminSessionValid) return reply({ error: "Admin session expired." }, 401);
      return adminAuditLog();
    }
    if (req.method === "GET" && action === "admin-alert-log") {
      if (!adminSessionValid) return reply({ error: "Admin session expired." }, 401);
      return adminAlertLog();
    }
    if (req.method === "GET" && action === "admin-alert-schedules") {
      if (!adminSessionValid) return reply({ error: "Admin session expired." }, 401);
      return adminAlertSchedules();
    }
    if (!["admin-change-passcode", "admin-save-event", "admin-delete-event", "admin-add-player", "admin-add-guest", "admin-create-guest-invite", "admin-update-player", "admin-update-guest", "admin-promote-guest", "admin-assign-guest", "admin-remove-player", "admin-reset-player-pin", "admin-set-eoi", "admin-reject-waitlist", "admin-set-attendance", "admin-set-payment", "admin-update-score", "admin-delete-score", "admin-delete-media", "admin-send-push", "admin-save-alert-schedule", "admin-delete-alert-schedule", "admin-save-badge", "admin-delete-badge", "admin-duplicate-event"].includes(action)) {
      return reply({ error: "Unknown action." }, 404);
    }
    if (!adminSessionValid) return reply({ error: "Admin session expired." }, 401);
    if (action === "admin-change-passcode") return changePasscode(body);
    if (action === "admin-save-event") return runAudited(req, action, body, () => saveEvent(body));
    if (action === "admin-delete-event") return runAudited(req, action, body, () => deleteEvent(body));
    if (action === "admin-add-player") return runAudited(req, action, body, () => addPlayer(body));
    if (action === "admin-add-guest") return runAudited(req, action, body, () => addGuest(body));
    if (action === "admin-create-guest-invite") return runAudited(req, action, body, () => createGuestInvite(body));
    if (action === "admin-update-player") return runAudited(req, action, body, () => updatePlayer(body));
    if (action === "admin-update-guest") return runAudited(req, action, body, () => updateGuest(body));
    if (action === "admin-promote-guest") return runAudited(req, action, body, () => promoteGuest(body));
    if (action === "admin-assign-guest") return runAudited(req, action, body, () => assignGuest(body));
    if (action === "admin-remove-player") return runAudited(req, action, body, () => removePlayer(body));
    if (action === "admin-reset-player-pin") return runAudited(req, action, body, () => resetPlayerPin(body));
    if (action === "admin-set-eoi") return runAudited(req, action, body, () => adminSetEoi(body));
    if (action === "admin-reject-waitlist") return runAudited(req, action, body, () => adminRejectWaitlist(body));
    if (action === "admin-set-attendance") return runAudited(req, action, body, () => adminSetAttendance(body));
    if (action === "admin-set-payment") return runAudited(req, action, body, () => adminSetPayment(body));
    if (action === "admin-update-score") return runAudited(req, action, body, () => adminUpdateScore(body));
    if (action === "admin-delete-score") return runAudited(req, action, body, () => adminDeleteScore(body));
    if (action === "admin-delete-media") return runAudited(req, action, body, () => adminDeleteMedia(body));
    if (action === "admin-send-push") return runAudited(req, action, body, () => adminSendPush(body));
    if (action === "admin-save-alert-schedule") return runAudited(req, action, body, () => adminSaveAlertSchedule(body));
    if (action === "admin-delete-alert-schedule") return runAudited(req, action, body, () => adminDeleteAlertSchedule(body));
    if (action === "admin-save-badge") return runAudited(req, action, body, () => saveBadge(body));
    if (action === "admin-delete-badge") return runAudited(req, action, body, () => deleteBadge(body));
    if (action === "admin-duplicate-event") return runAudited(req, action, body, () => duplicateEvent(body));
  } catch (error) {
    console.error(error);
    return reply({ error: "The server could not complete that request." }, 500);
  }
};
