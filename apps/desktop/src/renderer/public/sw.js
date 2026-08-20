// v2 retires every v1 entry: those were stored with the relay's
// Content-Encoding header still attached to an ALREADY DECODED body, so
// replaying one made the browser try to brotli-decode plain JavaScript and the
// app failed to boot on its next visit (user: Importing a module script
// failed).
const ASSET_CACHE = "mixdog-assets-v2";
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

// A fetched Response hands over a DECODED body while keeping the transfer
// headers that described the encoded one. Storing that pair makes the next
// replay decode already-plain bytes, so the transfer description is dropped
// before the copy is retained.
async function storableCopy(response) {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(await response.clone().arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
    try {
      await cache.put(request, await storableCopy(response));
      void trimCache(cache);
    } catch { /* a cache that cannot accept the copy still serves the network */ }
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
