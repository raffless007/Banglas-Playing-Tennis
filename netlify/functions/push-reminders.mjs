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

function paymentShare(event, attendingCount) {
  return Number(((Number(event.court_fee) + (event.court_2_enabled ? Number(event.court_2_fee || 0) : 0)) / attendingCount + Number(event.ball_fee || 0)).toFixed(2));
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
  const [events, eois, payments, allPlayers] = await Promise.all([
    db("events?select=*&order=event_date.asc"),
    db("eois?select=event_id,player_id,status,waitlist_position"),
    db("payments?select=event_id,player_id,paid"),
    activePlayerIds(),
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
      await notifyPlayers({ playerIds: pending, notificationType: "eoi", notificationKey: `eoi-24h:${event.id}`, eventId: event.id, title: "Tennis EOI closes tomorrow", body: `${label}: reply before ${event.start_time.slice(0, 5)} on Wednesday.`, url: `/?page=play&event=${encodeURIComponent(event.id)}` });
    }
    if (now >= deadline - 60 * 60 * 1000 && now < deadline) {
      await notifyPlayers({ playerIds: pending, notificationType: "eoi", notificationKey: `eoi-1h:${event.id}`, eventId: event.id, title: "EOI closing soon", body: `${label}: there is one hour left to confirm your spot.`, url: `/?page=play&event=${encodeURIComponent(event.id)}` });
    }
    if (attending.length && now >= endsAt && now < endsAt + 7 * 24 * 60 * 60 * 1000) {
      const amount = paymentShare(event, attending.length).toFixed(2);
      await notifyPlayers({ playerIds: unpaid, notificationType: "payments", notificationKey: `payment-open:${event.id}`, eventId: event.id, title: "Payment is now open", body: `${label}: $${amount} is due. PayID 0420451170.`, url: `/?page=payments&event=${encodeURIComponent(event.id)}` });
    }
    if (attending.length && now >= endsAt + 48 * 60 * 60 * 1000 && now < endsAt + 10 * 24 * 60 * 60 * 1000) {
      const amount = paymentShare(event, attending.length).toFixed(2);
      await notifyPlayers({ playerIds: unpaid, notificationType: "payments", notificationKey: `payment-48h:${event.id}`, eventId: event.id, title: "Payment reminder", body: `${label}: $${amount} is still outstanding. PayID 0420451170.`, url: `/?page=payments&event=${encodeURIComponent(event.id)}` });
    }
    if (attending.length && now < startsAt && event.cancellation_status !== "cancelled") {
      try {
        const rainChance = await matchRainChance(event);
        if (rainChance != null && rainChance > 50) {
          await notifyPlayers({ playerIds: attending, notificationType: "session", notificationKey: `weather-rain:${event.id}:${event.event_date}`, eventId: event.id, title: "Rain forecast for tennis", body: `${label}: ${rainChance}% chance of rain during your session at ${event.location}. Check the forecast before you travel.`, url: `/?page=play&event=${encodeURIComponent(event.id)}` });
        }
      } catch (error) {
        console.error("Weather alert check failed", event.id, error);
      }
    }
  }
  return new Response("Push reminder check complete.", { status: 200 });
};

export const config = { schedule: "0 * * * *" };
