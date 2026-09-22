import { activePlayerIds, db, notifyPlayers, pushConfigured } from "./push.mjs";

const SYDNEY = "Australia/Sydney";

function timezoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const values = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  return Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second) - date.getTime();
}

function localDateTimeToUtc(dateText, timeText, timeZone = SYDNEY) {
  const [year, month, day] = dateText.split("-").map(Number);
  const [hour, minute, second = 0] = timeText.split(":").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return new Date(guess.getTime() - timezoneOffsetMs(guess, timeZone));
}

function startTime(event) {
  return event.court_2_enabled && event.court_2_start_time < event.start_time ? event.court_2_start_time : event.start_time;
}

function endTime(event) {
  return event.court_2_enabled && event.court_2_end_time > event.end_time ? event.court_2_end_time : event.end_time;
}

function displayDate(event) {
  return new Intl.DateTimeFormat("en-AU", { timeZone: SYDNEY, weekday: "short", day: "numeric", month: "short" }).format(new Date(`${event.event_date}T12:00:00Z`));
}

function eventDetails(event) {
  const courtOne = `${event.court_1_name || "Court 1"} ${String(event.start_time).slice(0, 5)}–${String(event.end_time).slice(0, 5)}`;
  const courtTwo = event.court_2_enabled ? ` · ${event.court_2_name || "Court 2"} ${String(event.court_2_start_time).slice(0, 5)}–${String(event.court_2_end_time).slice(0, 5)}` : "";
  return `${event.location}, ${event.suburb} · ${courtOne}${courtTwo}`;
}

function deadlineLabel(deadline, timeZone = SYDNEY) {
  return new Intl.DateTimeFormat("en-AU", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(deadline));
}

function paymentShare(event, attendingCount) {
  return Number(((Number(event.court_fee) + (event.court_2_enabled ? Number(event.court_2_fee || 0) : 0)) / attendingCount + Number(event.ball_fee || 0)).toFixed(2));
}

const DEFAULT_PAYMENT_SCHEDULES = [
  { code: "payment-30m", name: "30 minutes after session completion", notification_type: "payments", delay_minutes: 30, repeat_interval_minutes: null, title_template: "Payment due · {date}", body_template: "{date}: ${amount} is due at {location}. PayID {payid}.", enabled: true, sort_order: 10 },
  { code: "payment-12h", name: "12 hours after session completion", notification_type: "payments", delay_minutes: 720, repeat_interval_minutes: null, title_template: "Payment overdue · {date}", body_template: "{date}: ${amount} is still outstanding at {location}. PayID {payid}.", enabled: true, sort_order: 20 },
  { code: "payment-36h", name: "36 hours after session completion", notification_type: "payments", delay_minutes: 2160, repeat_interval_minutes: null, title_template: "Payment overdue · {date}", body_template: "{date}: ${amount} is still outstanding at {location}. PayID {payid}.", enabled: true, sort_order: 30 },
  { code: "payment-daily", name: "Every 24 hours until paid", notification_type: "payments", delay_minutes: 3600, repeat_interval_minutes: 1440, title_template: "Payment overdue · {date}", body_template: "{date}: ${amount} is still outstanding at {location}. PayID {payid}.", enabled: true, sort_order: 40 },
];

async function paymentSchedules() {
  try {
    const rows = await db("push_alert_schedules?notification_type=eq.payments&select=*&order=sort_order.asc,name.asc");
    return rows?.length ? rows : DEFAULT_PAYMENT_SCHEDULES;
  } catch (error) {
    console.error("Alert schedule lookup failed; using defaults", error);
    return DEFAULT_PAYMENT_SCHEDULES;
  }
}

function scheduleText(template, values) {
  return String(template || "")
    .replaceAll("{player}", values.player)
    .replaceAll("{date}", values.date)
    .replaceAll("${amount}", values.amount)
    .replaceAll("{amount}", values.amount)
    .replaceAll("{payid}", "0420451170")
    .replaceAll("{location}", values.location);
}

async function matchRainChance(event) {
  const startsAt = localDateTimeToUtc(event.event_date, startTime(event), event.timezone || SYDNEY).getTime();
  const daysAhead = Math.ceil((startsAt - Date.now()) / (24 * 60 * 60 * 1000));
  if (daysAhead < 0 || daysAhead > 16) return null;
  const location = encodeURIComponent(`${event.suburb || event.location}, Australia`);
  const geoResponse = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${location}&count=1&language=en&format=json&countryCode=AU`);
  if (!geoResponse.ok) throw new Error("Weather geocoding failed");
  const geo = await geoResponse.json();
  const place = geo.results?.[0];
  if (!place) return null;
  const params = new URLSearchParams({
    latitude: place.latitude,
    longitude: place.longitude,
    timezone: event.timezone || SYDNEY,
    forecast_days: "16",
    hourly: "precipitation_probability",
  });
  const forecastResponse = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!forecastResponse.ok) throw new Error("Weather forecast failed");
  const forecast = await forecastResponse.json();
  const times = forecast.hourly?.time || [];
  const start = `${event.event_date}T${String(startTime(event)).slice(0, 5)}`;
  const end = `${event.event_date}T${String(endTime(event)).slice(0, 5)}`;
  const values = times.map((time, index) => ({ time, chance: forecast.hourly.precipitation_probability?.[index] }))
    .filter(row => row.time >= start && row.time <= end)
    .map(row => Number(row.chance))
    .filter(Number.isFinite);
  return values.length ? Math.round(Math.max(...values)) : null;
}

export default async () => {
  if (!pushConfigured()) return new Response("Push notifications are not configured.", { status: 200 });
  const [events, eois, payments, allPlayers, schedules] = await Promise.all([
    db("events?select=*&order=event_date.asc"),
    db("eois?select=event_id,player_id,status,waitlist_position"),
    db("payments?select=event_id,player_id,paid"),
    activePlayerIds(),
    paymentSchedules(),
  ]);
  const now = Date.now();
  for (const event of events) {
    const startsAt = localDateTimeToUtc(event.event_date, startTime(event), event.timezone || SYDNEY).getTime();
    const endsAt = localDateTimeToUtc(event.event_date, endTime(event), event.timezone || SYDNEY).getTime();
    const deadline = startsAt - 6 * 60 * 60 * 1000;
    const rows = eois.filter(row => row.event_id === event.id);
    const attending = rows.filter(row => row.status === "yes" && row.waitlist_position == null).map(row => row.player_id);
    const replied = new Set(rows.map(row => row.player_id));
    const pending = allPlayers.filter(playerId => !replied.has(playerId));
    const unpaid = attending.filter(playerId => !payments.some(payment => payment.event_id === event.id && payment.player_id === playerId && payment.paid));
    const label = displayDate(event);

    if (now >= deadline - 24 * 60 * 60 * 1000 && now < deadline) {
      await notifyPlayers({ playerIds: pending, notificationType: "eoi", notificationKey: `eoi-24h:${event.id}`, eventId: event.id, title: `EOI closes tomorrow · ${label}`, body: `${label} at ${event.location}, ${event.suburb}: reply by ${deadlineLabel(deadline, event.timezone || SYDNEY)} to confirm your spot.`, url: `/?page=play&event=${encodeURIComponent(event.id)}` });
    }
    if (now >= deadline - 60 * 60 * 1000 && now < deadline) {
      await notifyPlayers({ playerIds: pending, notificationType: "eoi", notificationKey: `eoi-1h:${event.id}`, eventId: event.id, title: `EOI closes in 1 hour · ${label}`, body: `${label} at ${event.location}, ${event.suburb}: reply by ${deadlineLabel(deadline, event.timezone || SYDNEY)} to confirm your spot.`, url: `/?page=play&event=${encodeURIComponent(event.id)}` });
    }
    if (attending.length && unpaid.length && now >= endsAt && !event.account_closed) {
      const amount = paymentShare(event, attending.length).toFixed(2);
      const values = { date: label, amount: `$${amount}`, location: `${event.location}, ${event.suburb}` };
      for (const schedule of schedules.filter(row => row.enabled && row.notification_type === "payments")) {
        const delayMs = Math.max(0, Number(schedule.delay_minutes || 0)) * 60 * 1000;
        const repeatMs = Number(schedule.repeat_interval_minutes || 0) * 60 * 1000;
        if (now - endsAt < delayMs) continue;
        const occurrence = repeatMs > 0 ? Math.floor((now - endsAt - delayMs) / repeatMs) : 0;
        const notificationKey = `payment-schedule:${schedule.code}:${event.id}:${occurrence}`;
        const renderedTitle = scheduleText(schedule.title_template, values);
        const renderedBody = scheduleText(schedule.body_template, values);
        const title = renderedTitle.includes(label) ? renderedTitle : `${renderedTitle} · ${label}`;
        const body = renderedBody.includes(values.location) ? renderedBody : `${renderedBody} Location: ${values.location}.`;
        await notifyPlayers({ playerIds: unpaid, notificationType: "payments", notificationKey, eventId: event.id, title, body, url: `/?page=payments&event=${encodeURIComponent(event.id)}`, audience: "attending" });
      }
    }
    if (attending.length && now < startsAt && event.cancellation_status !== "cancelled") {
      try {
        const rainChance = await matchRainChance(event);
        if (rainChance != null && rainChance > 50) {
          await notifyPlayers({ playerIds: attending, notificationType: "session", notificationKey: `weather-rain:${event.id}:${event.event_date}`, eventId: event.id, title: `Rain likely · ${label}`, body: `${label} at ${eventDetails(event)}: ${rainChance}% chance of rain during your session. Check the forecast before travelling.`, url: `/?page=play&event=${encodeURIComponent(event.id)}` });
        }
      } catch (error) {
        console.error("Weather alert check failed", event.id, error);
      }
    }
  }
  return new Response("Push reminder check complete.", { status: 200 });
};

export const config = { schedule: "0 * * * *" };
