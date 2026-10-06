/* Private Space service worker.
 *
 * PRIVACY INVARIANT: every notification shows exactly one word — "Reminder".
 * The push payload is never read, so nothing the server (or an attacker who
 * could forge a push) sends can ever add a sender, message text, file name,
 * link or image to the notification.
 */
'use strict';

const NOTIFICATION_TITLE = 'Reminder';
const NOTIFICATION_OPTIONS = Object.freeze({
  tag: 'reminder', // collapse into a single notification
  renotify: true,
});

const CACHE = 'ps-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Private data is never cached by the service worker.
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  if (request.mode === 'navigate') {
    // Network first; offline falls back to the cached application shell.
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});

function showReminder() {
  return self.registration.showNotification(NOTIFICATION_TITLE, NOTIFICATION_OPTIONS);
}

self.addEventListener('push', (event) => {
  // event.data is deliberately ignored.
  event.waitUntil(showReminder());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});
