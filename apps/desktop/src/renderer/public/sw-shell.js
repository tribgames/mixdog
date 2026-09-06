// Document cache and release handoff. Kept outside the push/share worker so
// startup recovery has one owner and can be exercised without those features.
const SHELL_CACHE = "mixdog-shell-v1";
const SHELL_UPDATE_MESSAGE = "mixdog:shell-updated";
const SHELL_CHECK_MESSAGE = "mixdog:shell-check";
const MAX_SHELL_ENTRIES = 16;
const MAX_SHELL_BYTES = 4 * 1024 * 1024;
const MAX_SHELL_ENTRY_BYTES = 512 * 1024;
const SHELL_STORED_BYTES_HEADER = "x-mixdog-shell-bytes";
let shellWrites = Promise.resolve();

// Shared tokens and notification query parameters do not change the shell.
// Device routes stay distinct; unrelated navigations are not app documents.
function shellCacheKey(request) {
  const url = new URL(typeof request === "string" ? request : request.url);
  if (url.pathname !== "/" && !/^\/d\/[^/]+\/?$/.test(url.pathname)) return null;
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function storeShell(cache, key, response, body) {
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes > MAX_SHELL_ENTRY_BYTES) return Promise.resolve(false);
  const copy = storableCopy(response);
  copy.headers.set(SHELL_STORED_BYTES_HEADER, String(bytes));
  const write = shellWrites.then(async () => {
    await cache.put(key, copy);
    const keys = await cache.keys();
    let total = 0;
    const rows = [];
    for (const candidate of keys) {
      const stored = await cache.match(candidate, { ignoreVary: true });
      if (!stored) continue;
      const recorded = Number(stored.headers.get(SHELL_STORED_BYTES_HEADER));
      // Retire legacy URL variants/entries whose retained size is not known.
      if (shellCacheKey(candidate) !== candidate.url || !(recorded > 0)) {
        await cache.delete(candidate);
        continue;
      }
      total += recorded;
      rows.push({ key: candidate, bytes: recorded });
    }
    // Cache.put does not change insertion order when refreshing an entry.
    // Prefer the document this request just published over older routes.
    rows.sort((a, b) => Number(a.key.url === key) - Number(b.key.url === key));
    while (rows.length > MAX_SHELL_ENTRIES || total > MAX_SHELL_BYTES) {
      const oldest = rows.shift();
      if (!oldest) break;
      await cache.delete(oldest.key);
      total -= oldest.bytes;
    }
    return true;
  });
  shellWrites = write.catch(() => false);
  return write;
}

function shellMeta(body, name) {
  const match = new RegExp(`<meta name="${name}" content="([^"]*)">`).exec(body);
  return match ? match[1] : "";
}

async function announceShellUpdate(version = "") {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    client.postMessage({ type: SHELL_UPDATE_MESSAGE, version });
  }
}

async function shellAssetsReady(body) {
  const assets = shellMeta(body, "mixdog-shell-assets").split(",").filter(Boolean);
  // A pre-protocol document has no proof its bootstrap is still available.
  if (!shellMeta(body, "mixdog-shell-version") || assets.length === 0) return false;
  const cache = await caches.open(ASSET_CACHE);
  for (const asset of assets) {
    const url = new URL(asset, `${self.location.origin}/`);
    if (url.origin !== self.location.origin || !HASHED_ASSET.test(url.pathname)) return false;
    if (!await cache.match(url.toString(), { ignoreVary: true })) return false;
  }
  return true;
}

async function shellFirst(request) {
  const key = shellCacheKey(request);
  if (!key) return { response: await fetch(request), maintenance: null };
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(key, { ignoreVary: true });
  const cachedBody = hit ? await hit.clone().text() : null;
  const refresh = fetch(request).then(async (response) => {
    if (!response.ok || response.type !== "basic") return response;
    const body = await response.clone().text();
    // Storage failure must never discard a successful network response.
    let stored = false;
    try {
      stored = await storeShell(cache, key, response, body);
    } catch { /* quota/private mode */ }
    if (stored && cachedBody !== null && cachedBody !== body) {
      await announceShellUpdate(shellMeta(body, "mixdog-shell-version"));
    }
    return response;
  });
  // Observe rejection while CacheStorage checks are still in flight.
  const settled = refresh.then(
    (response) => ({ response }),
    (error) => ({ error }),
  );
  if (hit && await shellAssetsReady(cachedBody).catch(() => false)) {
    return { response: hit, maintenance: settled };
  }
  const result = await settled;
  if (result.response) return { response: result.response, maintenance: null };
  // Offline, a retained shell is still preferable to losing the whole app.
  if (hit) return { response: hit, maintenance: null };
  throw result.error;
}

/** The page may start listening after the refresh finished. Compare its
 *  release with the retained document instead of relying on a one-shot event. */
self.addEventListener("message", (event) => {
  if (event.data?.type !== SHELL_CHECK_MESSAGE || !event.source?.url) return;
  event.waitUntil((async () => {
    const url = new URL(event.source.url);
    if (url.origin !== self.location.origin) return;
    const cache = await caches.open(SHELL_CACHE);
    const key = shellCacheKey(url.toString());
    if (!key) return;
    const response = await cache.match(key, { ignoreVary: true });
    if (!response) return;
    const version = shellMeta(await response.text(), "mixdog-shell-version");
    if (version && version !== event.data.version) {
      event.source.postMessage({ type: SHELL_UPDATE_MESSAGE, version });
    }
  })().catch(() => undefined));
});

/** A missing lazy chunk after a release is not a reusable cache entry.
 *  Refresh the owner's shell and let the page choose a safe reload moment. */
async function recoverMissingAsset(clientId) {
  if (!clientId) return;
  const client = await self.clients.get(clientId);
  if (!client?.url) return;
  const url = new URL(client.url);
  if (url.origin !== self.location.origin) return;
  const key = shellCacheKey(url.toString());
  if (!key) return;
  const response = await fetch(new Request(url.toString(), { cache: "no-cache" }));
  if (!response.ok || response.type !== "basic") return;
  const body = await response.clone().text();
  const cache = await caches.open(SHELL_CACHE);
  try { if (!await storeShell(cache, key, response, body)) return; } catch { return; }
  const version = shellMeta(body, "mixdog-shell-version");
  if (version) client.postMessage({ type: SHELL_UPDATE_MESSAGE, version });
}
