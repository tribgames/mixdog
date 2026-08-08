const VERSION = "mixdog-web-v1";

self.addEventListener("install", () => {
  void VERSION;
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Mixdog requires a live host connection. Keep the worker network-only: its
// purpose is installability and standalone launch, not stale offline UI.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(request));
});
