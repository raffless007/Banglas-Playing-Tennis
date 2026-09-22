// Bump the shell when the runtime changes so devices discard the failed
// release instead of reusing its HTML or helper assets.
const SHELL_CACHE = "bpt-shell-v3";
const SHELL_ASSETS = ["/", "/manifest.webmanifest", "/js/experience-utils.js", "/js/a11y-enhancements.js", "/assets/tennis-app-icon.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== SHELL_CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin || request.url.includes("/.netlify/functions/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(response => { const copy = response.clone(); caches.open(SHELL_CACHE).then(cache => cache.put("/", copy)); return response; }).catch(() => caches.match("/")));
    return;
  }
  // Keep helper scripts and styles fresh after a deploy while still falling
  // back to the cached copy when a device is offline.
  if (["script", "style"].includes(request.destination)) {
    event.respondWith(fetch(request).then(response => {
      const copy = response.clone();
      caches.open(SHELL_CACHE).then(cache => cache.put(request, copy));
      return response;
    }).catch(() => caches.match(request)));
    return;
  }
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => { const copy = response.clone(); caches.open(SHELL_CACHE).then(cache => cache.put(request, copy)); return response; })));
});

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { return; }
  const title = String(data.title || "").trim();
  const body = String(data.body || "").trim();
  if (!title || !body) return;
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: data.icon || "/assets/tennis-app-icon.png",
    badge: data.badge || "/assets/tennis-app-icon.png",
    tag: data.tag || "bpt-update",
    renotify: false,
    data: { url: data.url || "/" },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const requested = new URL(event.notification.data?.url || "/", self.location.origin);
  const destination = requested.origin === self.location.origin ? requested.href : `${self.location.origin}/`;
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(windows => {
    const openWindow = windows.find(client => {
      try { return new URL(client.url).origin === self.location.origin; } catch { return false; }
    });
    if (!openWindow) return clients.openWindow(destination);
    // Reuse the existing app window and route it to the page/event carried by
    // the notification instead of merely focusing whatever page was open.
    const alreadyThere = openWindow.url === destination;
    const navigation = alreadyThere || typeof openWindow.navigate !== "function"
      ? Promise.resolve(openWindow)
      : openWindow.navigate(destination).catch(() => openWindow);
    return navigation.then(client => client.focus());
  }));
});
