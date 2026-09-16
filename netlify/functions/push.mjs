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
  return `push_subscriptions?player_id=in.(${quoted})&active=eq.true&preferences-%3E%3E${notificationType}=eq.true&select=id,player_id,endpoint,p256dh,auth`;
}

async function createAlert({ notificationKey, notificationType, audience, eventId, title, body, url, recipientCount }) {
  const rows = await db("push_alerts?on_conflict=notification_key", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify({ notification_key: notificationKey, notification_type: notificationType, audience: audience || null, event_id: eventId || null, title, body, url, recipient_count: recipientCount }) });
  return rows?.[0] || null;
}

async function updateAlert(notificationKey, fields) {
  await db(`push_alerts?notification_key=eq.${encodeURIComponent(notificationKey)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(fields) });
}

async function reserveDelivery(subscription, notificationKey, notificationType, eventId, title, body, url) {
  const inserted = await db("push_notification_log?on_conflict=subscription_id,notification_key", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ subscription_id: subscription.id, player_id: subscription.player_id || null, notification_key: notificationKey, notification_type: notificationType, event_id: eventId || null, title, body, url }),
  });
  return inserted?.[0] || null;
}

async function updateDelivery(logId, fields) {
  await db(`push_notification_log?id=eq.${encodeURIComponent(logId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(fields),
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
export async function notifyPlayers({ playerIds, notificationType, notificationKey, title, body, url = "/", eventId = null, audience = null }) {
  const recipientCount = asPlayerIds(playerIds).length;
  const alert = await createAlert({ notificationKey, notificationType, audience, eventId, title, body, url, recipientCount });
  if (!alert) return { skipped: true, sent: 0, duplicate: true };
  if (!pushConfigured() || !PUSH_TYPES.has(notificationType)) {
    await updateAlert(notificationKey, { status: "skipped", completed_at: new Date().toISOString() });
    return { skipped: true, sent: 0 };
  }
  const query = subscriptionQuery(playerIds, notificationType);
  if (!query) {
    await updateAlert(notificationKey, { status: "no_recipients", device_count: 0, completed_at: new Date().toISOString() });
    return { skipped: true, sent: 0 };
  }
  const subscriptions = await db(query);
  if (!subscriptions.length) {
    await updateAlert(notificationKey, { status: "no_recipients", device_count: 0, completed_at: new Date().toISOString() });
    return { sent: 0 };
  }
  await updateAlert(notificationKey, { device_count: subscriptions.length });

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const payload = JSON.stringify({ title, body, url, tag: notificationKey, icon: "/assets/tennis-app-icon.png", badge: "/assets/tennis-app-icon.png" });
  let sent = 0;
  for (const subscription of subscriptions) {
    const log = await reserveDelivery(subscription, notificationKey, notificationType, eventId, title, body, url);
    if (!log) continue;
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload, { TTL: 60 * 60 * 12, urgency: "high" });
      await updateDelivery(log.id, { status: "sent", delivered_at: new Date().toISOString() });
      sent++;
    } catch (error) {
      if (error?.statusCode === 404 || error?.statusCode === 410) await disableSubscription(subscription.id);
      await updateDelivery(log.id, { status: "failed", error_message: String(error?.message || error?.statusCode || "Push delivery failed").slice(0, 500) });
      console.error("Push delivery failed", error?.statusCode || error?.message || error);
    }
  }
  const failed = subscriptions.length - sent;
  await updateAlert(notificationKey, { sent_count: sent, failed_count: failed, status: sent === subscriptions.length ? "sent" : sent ? "partial" : "failed", completed_at: new Date().toISOString() });
  return { sent };
}

export async function activePlayerIds() {
  const players = await db("players?active=eq.true&select=id");
  return players.map(player => player.id);
}
