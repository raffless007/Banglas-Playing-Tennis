self.addEventListener("push", event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || "Banglas Playing Tennis";
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "There is an update from the tennis club.",
    icon: data.icon || "/assets/tennis-app-icon.png",
    badge: data.badge || "/assets/tennis-app-icon.png",
    tag: data.tag || "bpt-update",
    renotify: false,
    data: { url: data.url || "/" },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(windows => {
    const openWindow = windows.find(client => client.url.startsWith(self.location.origin));
    return openWindow ? openWindow.focus() : clients.openWindow(destination);
  }));
});

