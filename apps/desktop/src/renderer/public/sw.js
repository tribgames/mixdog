const ASSET_CACHE = "mixdog-assets-v1";
// A few deploys' worth of chunks; the oldest entries are evicted first.
const MAX_ASSET_ENTRIES = 400;

// Build output under /assets/ carries a content hash, so a given URL can never
// change meaning. Those are the only responses served from the cache: the
// document, boot.js, the manifest and this worker stay on the network so a
// fresh deploy is picked up on the very next load and no stale application
// shell can strand the app. Live host traffic (/ws, /media, /client, /hook)
// never reaches this branch.
const HASHED_ASSET = /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.[^./]+$/;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== ASSET_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

async function trimCache(cache) {
  const keys = await cache.keys();
  for (let index = 0; index < keys.length - MAX_ASSET_ENTRIES; index += 1) {
    await cache.delete(keys[index]);
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  // ignoreVary: the relay varies on Accept-Encoding, which the page cannot
  // observe or reproduce; the decoded body it stores is the same either way.
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const response = await fetch(request);
  // Only a real same-origin success may be retained. A 401 from the pairing
  // gate or an opaque response would otherwise pin itself for the lifetime of
  // the installed app.
  if (response.ok && response.type === "basic") {
    await cache.put(request, response.clone());
    void trimCache(cache);
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!HASHED_ASSET.test(url.pathname)) {
    event.respondWith(fetch(request));
    return;
  }
  event.respondWith(cacheFirst(request).catch(() => fetch(request)));
});
