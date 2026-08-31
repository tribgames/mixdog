// v2 retires every v1 entry: those were stored with the relay's
// Content-Encoding header still attached to an ALREADY DECODED body, so
// replaying one made the browser try to brotli-decode plain JavaScript and the
// app failed to boot on its next visit (user: Importing a module script
// failed).
const ASSET_CACHE = "mixdog-assets-v2";
// The app shell document. It is served `no-cache` so a fresh deploy applies on
// the very next load, which over the relay costs a full round trip to another
// continent BEFORE any byte of the app moves — ~450ms on every launch of an
// otherwise fully cached app. Answering it from the last copy and refreshing
// behind the paint applies a deploy one launch later instead, which is the
// same bargain the content-hashed asset URLs already make. boot.js is inlined
// into this document by the build, so the shell is exactly one request.
const SHELL_CACHE = "mixdog-shell-v1";
// A deploy the refresh behind the paint discovered. The page owns the moment
// it is adopted; this worker only reports that the document changed.
const SHELL_UPDATE_MESSAGE = "mixdog:shell-updated";
// A few deploys' worth of chunks; the oldest entries are evicted first.
const MAX_ASSET_ENTRIES = 400;
// One page boot requests several hashed chunks together. Trimming after every
// cache.put repeated the full cache.keys() scan for the same burst.
const CACHE_TRIM_DEBOUNCE_MS = 50;
let cacheTrimMaintenance = null;

// Build output under /assets/ carries a content hash, so a given URL can never
// change meaning. Those are the only responses served from the cache: the
// document, boot.js, the manifest and this worker stay on the network so a
// fresh deploy is picked up on the very next load and no stale application
// shell can strand the app. Live host traffic (/ws, /media, /client, /hook)
// never reaches this branch.
const HASHED_ASSET = /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.[^./]+$/;

// Web Share Target. The share sheet POSTs the shared payload into this scope,
// and on a phone that is the ONLY way a screenshot reaches the app: mobile
// browsers do not deliver an inter-app DRAG to a web page (user: 스크린샷을
// 드래그해도 첨부되지 않는다). The payload is retained HERE, in the app's own
// cache, so a shared screenshot never travels to the relay — it enters the
// composer exactly like one attached inside the app.
const SHARE_CACHE = "mixdog-share-v1";
const SHARE_ENTRY_PREFIX = "/__mixdog-share__/";
const SHARE_INDEX_NAME = "index.json";
const MAX_SHARED_FILES = 8;
// A payload no intake ever claimed (share cancelled, app closed before it
// booted) expires instead of sitting in storage forever.
const SHARE_ENTRY_TTL_MS = 10 * 60 * 1000;
// The manifest's share_target action, under the bare scope and under a device
// route (/d/<deviceId>/share-target).
const SHARE_TARGET_PATH = /^\/(?:d\/[^/]+\/)?share-target$/;

// State this worker and the app read from each other. A worker has no
// localStorage, and the app cannot see what a tapped notification did while
// it was not running, so both meet in the app's own cache. The renderer half
// is push-notification-bridge.ts, which mirrors these names.
const APP_STATE_CACHE = "mixdog-app-state-v1";
const APP_SCOPE_ENTRY = "/__mixdog-app__/scope";
const UI_LANGUAGE_ENTRY = "/__mixdog-app__/ui-language";
const NOTIFICATION_CLICK_ENTRY = "/__mixdog-app__/notification-click";
// A tap the app never came back for stops meaning anything.
const NOTIFICATION_CLICK_TTL_MS = 10 * 60 * 1000;
const OPEN_SESSION_MESSAGE = "mixdog:open-session";

// The one sentence this worker composes itself. Everything else in a
// notification is the session's own text. The DEVICE showing it owns the
// language: the desktop that sent the push has a UI language of its own, and
// on a phone it is routinely not this one (user: 노티파이 다국어).
const TURN_FINISHED_TEXT = {
  de: "Arbeit abgeschlossen.",
  en: "Finished working.",
  es: "Trabajo terminado.",
  fr: "Travail terminé.",
  it: "Lavoro completato.",
  ja: "作業が完了しました。",
  ko: "작업을 마쳤습니다.",
  "pt-BR": "Trabalho concluído.",
  ru: "Работа завершена.",
  vi: "Đã hoàn tất công việc.",
  "zh-CN": "工作已完成。",
  "zh-TW": "工作已完成。",
};

/** Mirrors uiLanguageForLocale in i18n.ts: exact tag, Chinese script/region,
 *  then the bare language prefix. */
function uiLanguageForLocale(locale) {
  const lower = String(locale || "").trim().toLowerCase();
  if (!lower) return "";
  const tags = Object.keys(TURN_FINISHED_TEXT);
  const exact = tags.find((tag) => tag.toLowerCase() === lower);
  if (exact) return exact;
  const base = lower.split(/[-_]/)[0];
  if (base === "zh") return /hant|tw|hk|mo/.test(lower) ? "zh-TW" : "zh-CN";
  return tags.find((tag) => tag.toLowerCase().split("-")[0] === base) || "";
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== ASSET_CACHE && name !== SHELL_CACHE && name !== SHARE_CACHE
        && name !== APP_STATE_CACHE) {
        await caches.delete(name);
      }
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

function scheduleAssetCacheTrim(cache) {
  if (cacheTrimMaintenance) return cacheTrimMaintenance;
  cacheTrimMaintenance = new Promise((resolve) => {
    setTimeout(resolve, CACHE_TRIM_DEBOUNCE_MS);
  }).then(() => trimCache(cache)).finally(() => {
    cacheTrimMaintenance = null;
  });
  return cacheTrimMaintenance;
}

// A fetched Response hands over a DECODED body while keeping the transfer
// headers that described the encoded one. Storing that pair makes the next
// replay decode already-plain bytes, so the transfer description is dropped
// before the copy is retained. Preserve the clone's stream: arrayBuffer()
// buffered an entire Monaco-sized chunk before the browser could consume the
// original response.
function storableCopy(response) {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(response.clone().body, {
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
  if (hit) return { response: hit, maintenance: null };
  const response = await fetch(request);
  let maintenance = null;
  // Only a real same-origin success may be retained. A 401 from the pairing
  // gate or an opaque response would otherwise pin itself for the lifetime of
  // the installed app.
  if (response.ok && response.type === "basic") {
    // Return the original response immediately. The extending fetch event owns
    // the streamed clone until cache.put and one coalesced trim complete.
    maintenance = cache.put(request, storableCopy(response))
      .then(() => scheduleAssetCacheTrim(cache))
      .catch(() => undefined);
  }
  return { response, maintenance };
}

/** Every window of this app, including one still controlled by the worker a
 *  deploy replaced. */
async function announceShellUpdate() {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of windows) client.postMessage({ type: SHELL_UPDATE_MESSAGE });
}

/** The document: last copy now, fresh copy for the next launch. A cache miss
 *  falls through to the network, so the first launch after install is
 *  unchanged.
 *
 *  Serving the previous document also serves the previous BUNDLE: its asset
 *  URLs are the content-hashed ones from that deploy, so a launch right after
 *  a deploy is the old app end to end (user: 코드가 적용이 안 된 것 같다) and
 *  the new one appeared only on the launch after. The refresh therefore
 *  reports a document that actually changed, and the page reloads itself once
 *  that costs nothing — the deploy lands within the same launch while the
 *  first paint keeps its cached round trip. */
async function shellFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreVary: true });
  // Read the retained copy BEFORE it is handed out: the response answering the
  // navigation owns its own stream.
  const cached = hit ? hit.clone().text().catch(() => null) : null;
  const refresh = fetch(request).then(async (response) => {
    if (!response.ok || response.type !== "basic") return response;
    const copy = storableCopy(response);
    // The shell is a single small document, so the same bytes can be both
    // stored and compared; assets stay streamed.
    const body = await copy.text();
    await cache.put(request, new Response(body, {
      status: copy.status,
      statusText: copy.statusText,
      headers: copy.headers,
    }));
    if (cached !== null && (await cached) !== body) await announceShellUpdate();
    return response;
  });
  if (hit) return { response: hit, maintenance: refresh.catch(() => undefined) };
  return { response: await refresh, maintenance: null };
}

function sharedEntryUrl(token, name) {
  return `${SHARE_ENTRY_PREFIX}${token}/${name}`;
}

/** Cache keys are absolute; the stored index keeps the path so the app can
 *  look an entry up against its own origin. */
function sharedEntryRequest(path) {
  return new Request(new URL(path, self.location.origin).toString());
}

/** Cache keys are absolute, exactly as the app's own reads build them. */
function appStateRequest(entry) {
  return new Request(new URL(entry, self.location.origin).toString());
}

async function writeAppState(entry, value) {
  try {
    const cache = await caches.open(APP_STATE_CACHE);
    await cache.put(appStateRequest(entry), new Response(value, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }));
  } catch {
    // A container that refuses storage keeps the defaults below.
  }
}

async function readAppState(entry) {
  try {
    const cache = await caches.open(APP_STATE_CACHE);
    const stored = await cache.match(appStateRequest(entry));
    return stored ? (await stored.text()).trim() : "";
  } catch {
    return "";
  }
}

/** The path the app is actually installed at. An install started from a device
 *  route lives under /d/<deviceId>/, and the bare origin is a DIFFERENT
 *  container with no credential of its own (server.mjs parseDeviceRoute), so
 *  opening "/" from a notification lands on the pairing gate instead of the
 *  app (user: 눌러도 동작이 안 된다). */
function appScopePath(pathname) {
  const match = /^\/d\/[^/]+\//.exec(String(pathname || ""));
  return match ? match[0] : "/";
}

/** Which language this device says a notification should speak. The app's own
 *  choice wins; a phone that has not booted the app yet still gets its system
 *  language rather than English. */
async function notificationLanguage() {
  const stored = await readAppState(UI_LANGUAGE_ENTRY);
  const chosen = uiLanguageForLocale(stored);
  if (chosen) return chosen;
  const system = self.navigator ? self.navigator.language : "";
  return uiLanguageForLocale(system) || "en";
}

function shareToken() {
  const value = self.crypto && typeof self.crypto.randomUUID === "function"
    ? self.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return value.replace(/[^a-zA-Z0-9-]/g, "");
}

/** Retire payloads past their claim window before adding another. */
async function pruneSharedPayloads(cache) {
  const keys = await cache.keys();
  const expired = [];
  for (const key of keys) {
    const path = new URL(key.url).pathname;
    if (!path.startsWith(SHARE_ENTRY_PREFIX) || !path.endsWith(`/${SHARE_INDEX_NAME}`)) continue;
    let createdAt = 0;
    try {
      const stored = await cache.match(key);
      const index = stored ? await stored.json() : null;
      createdAt = Number(index && index.createdAt) || 0;
    } catch {
      createdAt = 0;
    }
    if (Date.now() - createdAt < SHARE_ENTRY_TTL_MS) continue;
    expired.push(path.slice(0, path.length - SHARE_INDEX_NAME.length));
  }
  if (!expired.length) return;
  for (const key of keys) {
    const path = new URL(key.url).pathname;
    if (expired.some((prefix) => path.startsWith(prefix))) await cache.delete(key);
  }
}

/** The share sheet's POST. It answers with a redirect to the app shell of the
 *  SAME route the app was installed from, carrying the claim token the running
 *  app trades for the files. */
async function receiveSharedPayload(request) {
  const url = new URL(request.url);
  const shell = new URL(url.pathname.replace(/share-target$/, ""), url.origin);
  try {
    const form = await request.formData();
    const files = form.getAll("files")
      .filter((entry) => entry && typeof entry === "object"
        && typeof entry.arrayBuffer === "function" && entry.size > 0)
      .slice(0, MAX_SHARED_FILES);
    // A shared link or note carries its own meaning; it becomes composer text.
    const text = ["title", "text", "url"]
      .map((field) => form.get(field))
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean)
      .join(" ")
      .trim();
    if (files.length || text) {
      const cache = await caches.open(SHARE_CACHE);
      await pruneSharedPayloads(cache);
      const token = shareToken();
      const entries = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const entry = sharedEntryUrl(token, String(index));
        await cache.put(sharedEntryRequest(entry), new Response(file, {
          headers: { "Content-Type": file.type || "application/octet-stream" },
        }));
        entries.push({
          url: entry,
          name: file.name || `shared-${index + 1}`,
          type: file.type || "",
        });
      }
      await cache.put(
        sharedEntryRequest(sharedEntryUrl(token, SHARE_INDEX_NAME)),
        new Response(JSON.stringify({ createdAt: Date.now(), text, files: entries }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      shell.searchParams.set("shared", token);
    }
  } catch {
    // A share this worker cannot read still opens the app rather than an
    // error page; nothing is attached.
  }
  return Response.redirect(shell.toString(), 303);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (request.method === "POST" && SHARE_TARGET_PATH.test(url.pathname)) {
    const shell = new URL(url.pathname.replace(/share-target$/, ""), url.origin).toString();
    event.respondWith(receiveSharedPayload(request)
      .catch(() => Response.redirect(shell, 303)));
    return;
  }
  if (request.method !== "GET") return;
  if (request.mode === "navigate") {
    const operation = shellFirst(request);
    event.respondWith(operation.then((result) => result.response).catch(() => fetch(request)));
    // Every launch re-states where the app lives, so a notification opened
    // months later still targets the route this install was made from.
    event.waitUntil(Promise.all([
      operation.then((result) => result.maintenance).catch(() => undefined),
      writeAppState(APP_SCOPE_ENTRY, appScopePath(url.pathname)),
    ]));
    return;
  }
  if (!HASHED_ASSET.test(url.pathname)) {
    event.respondWith(fetch(request));
    return;
  }
  const operation = cacheFirst(request);
  event.respondWith(operation
    .then((result) => result.response)
    .catch(() => fetch(request)));
  event.waitUntil(operation
    .then((result) => result.maintenance)
    .catch(() => undefined));
});

// Web Push. This is the ONLY path that reaches an installed web app whose
// relay socket is gone: the OS wakes this worker even when the app was swiped
// away. The desktop that owns the session encrypts the payload for this
// subscription alone, so the push service delivering it cannot read a word.
self.addEventListener("push", (event) => {
  // userVisibleOnly is enforced by the browser: every delivery MUST end in a
  // visible notification, so a malformed payload still shows something rather
  // than costing the app its push permission.
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  const title = (payload && typeof payload.title === "string" && payload.title.trim())
    || "Mixdog";
  const supplied = payload && typeof payload.body === "string" ? payload.body.trim() : "";
  const sessionId = payload && payload.data && typeof payload.data.sessionId === "string"
    ? payload.data.sessionId
    : "";
  event.waitUntil((async () => {
    // What the session actually said travels verbatim; only the stand-in for
    // a turn that produced no text is spoken in this device's language.
    const body = supplied
      || TURN_FINISHED_TEXT[await notificationLanguage()]
      || TURN_FINISHED_TEXT.en;
    await self.registration.showNotification(title, {
      body,
      icon: "/mixdog-192.png",
      badge: "/mixdog-192.png",
      // One session collapses onto one notification instead of stacking a row
      // per finished turn, and the replacement re-alerts.
      tag: sessionId ? `session:${sessionId}` : "mixdog",
      renotify: Boolean(sessionId),
      data: { sessionId },
    });
  })());
});

// Tapping the notification opens the session it came from. An app that is
// still resident is focused and told where to go; a closed one is launched.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data && typeof event.notification.data.sessionId === "string"
    ? event.notification.data.sessionId
    : "";
  event.waitUntil((async () => {
    // Park it FIRST. focus() can hand the tap to a document the phone
    // discarded while the app sat in the background: that document is still
    // rebuilding when the message below arrives, has no listener yet, and the
    // tap does nothing at all (user: 눌러도 동작이 안 되냐). The app claims
    // this on boot, the same way a shared payload travels.
    if (sessionId) {
      await writeAppState(
        NOTIFICATION_CLICK_ENTRY,
        JSON.stringify({ sessionId, createdAt: Date.now() }),
      );
    }
    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    for (const client of windows) {
      if (!client.url.startsWith(self.location.origin)) continue;
      await client.focus().catch(() => undefined);
      client.postMessage({ type: OPEN_SESSION_MESSAGE, sessionId: sessionId || null });
      return;
    }
    // The route this install was made from, never the bare origin.
    const scope = (await readAppState(APP_SCOPE_ENTRY)) || "/";
    await self.clients.openWindow(sessionId
      ? `${scope}?session=${encodeURIComponent(sessionId)}`
      : scope);
  })());
});
