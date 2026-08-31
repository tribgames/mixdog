// One loader for the service worker under test. public/sw.js is a standalone
// script that cannot be imported, so every worker test evaluates the REAL
// source in a VM holding the globals a worker would have.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./public/sw.js", import.meta.url), "utf8");

export const WORKER_ORIGIN = "https://relay.mixdog.test";

function cacheKeyUrl(request) {
  const raw = typeof request === "string" ? request : request.url;
  return new URL(raw, WORKER_ORIGIN).toString();
}

/** A Cache carrying the surface both the worker and the app's intake use. */
export function memoryCache() {
  const entries = new Map();
  return {
    async put(request, response) {
      entries.set(cacheKeyUrl(request), response);
    },
    async match(request) {
      const stored = entries.get(cacheKeyUrl(request));
      return stored ? stored.clone() : undefined;
    },
    async keys() {
      return [...entries.keys()].map((url) => ({ url }));
    },
    async delete(request) {
      return entries.delete(cacheKeyUrl(request));
    },
    get size() {
      return entries.size;
    },
  };
}

/** CacheStorage shared by the worker and the page, exactly as a real device
 *  shares it across both contexts. */
export function memoryCacheStorage() {
  const named = new Map();
  return {
    async open(name) {
      if (!named.has(name)) named.set(name, memoryCache());
      return named.get(name);
    },
    async keys() {
      return [...named.keys()];
    },
    async delete(name) {
      return named.delete(name);
    },
    async match() {
      return undefined;
    },
    peek(name) {
      return named.get(name);
    },
  };
}

export function loadWorker({
  cache,
  caches: cacheStorage,
  origin = WORKER_ORIGIN,
  /** Open app windows the worker may post to. */
  windows = [],
  /** What this device's browser reports when the app has published nothing. */
  systemLanguage = "en",
  fetchAsset = async () => {
    const response = new Response("asset");
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  },
} = {}) {
  const listeners = new Map();
  const opened = [];
  const shown = [];
  const context = {
    Blob,
    File,
    FormData,
    Headers,
    Promise,
    ReadableStream,
    Request,
    Response,
    URL,
    caches: cacheStorage ?? {
      keys: async () => [],
      open: async () => cache,
      delete: async () => true,
    },
    clearTimeout,
    fetch: fetchAsset,
    setTimeout,
    self: {
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      clients: {
        claim: async () => undefined,
        matchAll: async () => windows,
        openWindow: async (url) => { opened.push(url); },
      },
      location: { origin },
      navigator: { language: systemLanguage },
      registration: {
        showNotification: async (title, options) => { shown.push({ title, options }); },
      },
      skipWaiting() {},
    },
  };
  context.globalThis = context;
  vm.runInNewContext(
    `${source}\n;globalThis.__swTest = {`
    + " cacheFirst, pruneSharedPayloads, receiveSharedPayload, scheduleAssetCacheTrim,"
    + " shellFirst, storableCopy, SHELL_UPDATE_MESSAGE,"
    + " appScopePath, notificationLanguage, uiLanguageForLocale,"
    + " APP_STATE_CACHE, APP_SCOPE_ENTRY, NOTIFICATION_CLICK_ENTRY,"
    + " NOTIFICATION_CLICK_TTL_MS, OPEN_SESSION_MESSAGE, UI_LANGUAGE_ENTRY,"
    + " SHARE_CACHE, SHARE_ENTRY_PREFIX, SHARE_ENTRY_TTL_MS, SHARE_INDEX_NAME,"
    + " SHARE_TARGET_PATH };",
    context,
  );
  return { ...context.__swTest, listeners, opened, shown };
}
