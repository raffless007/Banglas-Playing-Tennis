#!/usr/bin/env node

// Read-only production smoke/performance harness. Authenticated measurements
// are opt-in through environment variables and never print credentials or
// response bodies. Do not use real production credentials without approval.
const base = (process.argv.find(arg => arg.startsWith('--base='))?.slice(7)
  || process.env.BPT_BASE_URL
  || 'http://localhost:8888').replace(/\/$/, '');
const actions = ['state', 'eoi-state', 'live-state', 'sync-version', 'realtime-config', 'media-state'];

async function measure(label, url, headers = {}) {
  const started = performance.now();
  try {
    const response = await fetch(url, { cache: 'no-store', headers });
    const body = await response.arrayBuffer();
    return { label, status: response.status, bytes: body.byteLength, ms: Math.round((performance.now() - started) * 100) / 100 };
  } catch (error) {
    return { label, error: String(error?.message || error), ms: Math.round((performance.now() - started) * 100) / 100 };
  }
}

const cacheBust = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const results = [];
results.push(await measure('html', `${base}/?perf=${cacheBust()}`));
for (const action of actions) {
  const repeats = action === 'state' ? 5 : 1;
  for (let index = 0; index < repeats; index += 1) {
    results.push(await measure(`${action}#${index + 1}`, `${base}/.netlify/functions/api?action=${action}&ts=${cacheBust()}`));
  }
}

const playerToken = process.env.BPT_PLAYER_TOKEN || '';
const adminToken = process.env.BPT_ADMIN_TOKEN || '';
if (playerToken) {
  const headers = { 'x-player-session': playerToken };
  for (const action of ['state', 'media-state', 'eoi-state', 'live-state']) {
    results.push(await measure(`player:${action}`, `${base}/.netlify/functions/api?action=${action}&ts=${cacheBust()}`, headers));
  }
}
if (adminToken) {
  const headers = { authorization: `Bearer ${adminToken}` };
  for (const action of ['state', 'admin-state', 'admin-audit-log', 'admin-alert-log', 'admin-alert-schedules']) {
    results.push(await measure(`admin:${action}`, `${base}/.netlify/functions/api?action=${action}&ts=${cacheBust()}`, headers));
  }
}

console.log(JSON.stringify({
  base,
  generatedAt: new Date().toISOString(),
  authenticated: Boolean(playerToken || adminToken),
  playerMeasurements: Boolean(playerToken),
  adminMeasurements: Boolean(adminToken),
  results,
}, null, 2));
