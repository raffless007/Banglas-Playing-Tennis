const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export default async () => {
  const checks = {
    database: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    sessionSigning: Boolean(process.env.ADMIN_SESSION_SECRET),
    push: Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
  };
  const healthy = checks.database && checks.sessionSigning;
  return new Response(JSON.stringify({ ok: healthy, checks, timestamp: new Date().toISOString() }), { status: healthy ? 200 : 503, headers });
};
