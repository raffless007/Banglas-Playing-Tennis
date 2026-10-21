// Local, bounded diagnostics. Do not collect URLs, headers, bodies, profile
// IDs, PINs or tokens. Nothing is sent to a telemetry service.
(() => {
  const entries = [], capacity = 60;
  const record = value => { entries.push(value); if (entries.length > capacity) entries.shift(); };
  const startedAt = Date.now();
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function(input, options) {
    let action = null;
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
      if (url.origin === location.origin && url.pathname === '/.netlify/functions/api') action = url.searchParams.get('action') || 'state';
    } catch { /* Non-API fetches remain untouched. */ }
    if (!action) return nativeFetch(input, options);
    const started = performance.now();
    try {
      const response = await nativeFetch(input, options);
      const serverTiming = [...(response.headers.get('Server-Timing') || '').matchAll(/(?:^|,\s*)([a-z_]+);dur=([\d.]+)/g)].map(match => ({ stage: match[1], ms: Number(match[2]) }));
      record({ type: 'request', action, method: options?.method || 'GET', ms: Math.round(performance.now() - started), status: response.status, ...(serverTiming.length ? { serverTiming } : {}) });
      return response;
    } catch (error) {
      record({ type: 'request', action, method: options?.method || 'GET', ms: Math.round(performance.now() - started), status: 'network-error' });
      throw error;
    }
  };
  window.BPTPerformance = Object.freeze({
    recordRender(page, ms) { record({ type: 'render', page, ms: Math.round(ms * 10) / 10 }); },
    snapshot() {
      const nav = performance.getEntriesByType('navigation')[0];
      return { capturedAt: new Date().toISOString(), sessionAgeSeconds: Math.round((Date.now() - startedAt) / 1000), viewport: { width: innerWidth, height: innerHeight }, ...(nav ? { shell: { responseMs: Math.round(nav.responseEnd - nav.requestStart), domReadyMs: Math.round(nav.domContentLoadedEventEnd) } } : {}), entries: entries.map(entry => ({ ...entry })) };
    },
  });
})();
