const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  if (!response.ok) throw new Error(await response.text());
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function timezoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const v = Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
  return Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second) - date.getTime();
}

function localToUtc(dateText, timeText, timeZone) {
  const [year, month, day] = dateText.split("-").map(Number);
  const [hour, minute, second = 0] = timeText.split(":").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return new Date(guess.getTime() - timezoneOffsetMs(guess, timeZone));
}

async function email(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !process.env.REMINDER_FROM_EMAIL || !to) return false;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.REMINDER_FROM_EMAIL, to, subject, html }),
  });
  return response.ok;
}

async function alreadyLogged(eventId, playerId, type) {
  const playerFilter = playerId ? `&player_id=eq.${playerId}` : "&player_id=is.null";
  const rows = await db(`reminder_log?event_id=eq.${eventId}${playerFilter}&reminder_type=eq.${type}&select=id`);
  return rows.length > 0;
}

async function log(eventId, playerId, type) {
  await db("reminder_log", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ event_id: eventId, player_id: playerId || null, reminder_type: type }),
  });
}

export default async () => {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("Supabase environment variables are missing.");
  const now = Date.now();
  const [events, players, eois, payments] = await Promise.all([
    db("events?account_closed=eq.false&select=*"),
    db("players?active=eq.true&select=id,name,email"),
    db("eois?status=eq.yes&select=event_id,player_id"),
    db("payments?paid=eq.true&select=event_id,player_id"),
  ]);

  for (const event of events) {
    const ended = localToUtc(event.event_date, event.end_time, event.timezone).getTime();
    const hours = (now - ended) / 3600000;
    if (hours < 48) continue;

    const attendingIds = eois.filter(row => row.event_id === event.id).map(row => row.player_id);
    const paidIds = new Set(payments.filter(row => row.event_id === event.id).map(row => row.player_id));
    const outstanding = players.filter(player => attendingIds.includes(player.id) && !paidIds.has(player.id));

    if (hours >= 48) {
      for (const player of outstanding) {
        if (await alreadyLogged(event.id, player.id, "48_hour_player")) continue;
        await email(
          player.email,
          `Tennis payment reminder — ${event.event_date}`,
          `<p>Hi ${player.name},</p><p>Your tennis payment for ${event.event_date} is still outstanding.</p><p>Payment PayID: 0420451170</p>`,
        );
        await log(event.id, player.id, "48_hour_player");
      }
    }

    if (hours >= 72 && !(await alreadyLogged(event.id, null, "72_hour_admin"))) {
      const list = outstanding.length ? outstanding.map(player => player.name).join(", ") : "Everyone has paid";
      await email(
        process.env.ADMIN_EMAIL,
        `Tennis payment status — ${event.event_date}`,
        `<p>Payment status after 72 hours:</p><p>${list}</p>`,
      );
      await log(event.id, null, "72_hour_admin");
    }
  }

  return new Response("Reminder check complete", { status: 200 });
};

