const NOTIFICATION_BODY = 'you win an iphone';

self.addEventListener('push', (event) => {
  const payload = readPayload(event);
  const title = payload.notification?.title || payload.data?.title || 'New message';
  const body = payload.notification?.body || payload.data?.body || NOTIFICATION_BODY;
  const url = payload.data?.url || '/';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: 'secure-chat-message',
      renotify: true,
      data: { url }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const existingClient = clients.find((client) => client.url === targetUrl);
        if (existingClient) {
          return existingClient.focus();
        }

        return self.clients.openWindow(targetUrl);
      })
  );
});

function readPayload(event) {
  if (!event.data) {
    return {};
  }

  try {
    return event.data.json();
  } catch {
    return {};
  }
}
