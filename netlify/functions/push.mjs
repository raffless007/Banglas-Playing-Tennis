import webpush from "web-push";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:rsiddiquey@gmail.com";

export const PUSH_TYPES = new Set(["payments", "eoi", "session", "matches"]);

export function pushConfigured() {
  return Boolean(SUPABASE_URL && SERVICE_KEY && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
}

export async function db(path, options = {}) {
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

function asPlayerIds(playerIds) {
  return [...new Set((playerIds || []).filter(Boolean))];
}

function subscriptionQuery(playerIds, notificationType) {
  const ids = asPlayerIds(playerIds);
  if (!ids.length) return null;
  const quoted = ids.map(id => `"${String(id).replaceAll('"', '')}"`).join(",");
  return `push_subscriptions?player_id=in.(${quoted})&active=eq.true&preferences-%3E%3E${notificationType}=eq.true&select=id,endpoint,p256dh,auth`;
}

async function reserveDelivery(subscriptionId, notificationKey, notificationType, eventId) {
  const inserted = await db("push_notification_log?on_conflict=subscription_id,notification_key", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ subscription_id: subscriptionId, notification_key: notificationKey, notification_type: notificationType, event_id: eventId || null }),
  });
  return inserted?.[0] || null;
}

async function clearReservation(logId) {
  await db(`push_notification_log?id=eq.${encodeURIComponent(logId)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

async function disableSubscription(subscriptionId) {
  await db(`push_subscriptions?id=eq.${encodeURIComponent(subscriptionId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ active: false, updated_at: new Date().toISOString() }),
  });
}

/**
 * Delivers one deduplicated notification to every opted-in device for a group
 * of players. A delivery record is reserved before sending so scheduled jobs
 * remain safe to retry.
 */
export async function notifyPlayers({ playerIds, notificationType, notificationKey, title, body, url = "/", eventId = null }) {
  if (!pushConfigured() || !PUSH_TYPES.has(notificationType)) return { skipped: true, sent: 0 };
  const query = subscriptionQuery(playerIds, notificationType);
  if (!query) return { skipped: true, sent: 0 };
  const subscriptions = await db(query);
  if (!subscriptions.length) return { sent: 0 };

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const payload = JSON.stringify({ title, body, url, tag: notificationKey, icon: "/assets/tennis-app-icon.png", badge: "/assets/tennis-app-icon.png" });
  let sent = 0;
  for (const subscription of subscriptions) {
    const log = await reserveDelivery(subscription.id, notificationKey, notificationType, eventId);
    if (!log) continue;
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload, { TTL: 60 * 60 * 12, urgency: "high" });
      sent++;
    } catch (error) {
      if (error?.statusCode === 404 || error?.statusCode === 410) await disableSubscription(subscription.id);
      else await clearReservation(log.id);
      console.error("Push delivery failed", error?.statusCode || error?.message || error);
    }
  }
  return { sent };
}

export async function activePlayerIds() {
  const players = await db("players?active=eq.true&select=id");
  return players.map(player => player.id);
}
