// The app's half of the push notification path.
//
// A tapped notification reaches the WORKER (public/sw.js), never this document
// directly. The worker parks what was tapped and the app claims it here, the
// same way a shared payload travels: that parking is what lets a tap survive a
// phone which discarded the document while the app sat in the background.
//
// The same channel carries the UI language outward. A worker has no
// localStorage, and the device showing a notification — not the desktop that
// sent it — is the one whose language it should speak.

/** Mirrors public/sw.js. A worker is a standalone script that cannot import
 *  renderer modules, so both carry these names and a test asserts they agree. */
export const APP_STATE_CACHE_NAME = "mixdog-app-state-v1";
export const UI_LANGUAGE_ENTRY = "/__mixdog-app__/ui-language";
export const NOTIFICATION_CLICK_ENTRY = "/__mixdog-app__/notification-click";
/** A tap the app never came back for stops meaning anything. */
export const NOTIFICATION_CLICK_TTL_MS = 10 * 60 * 1000;

export interface AppStateEnvironment {
  caches?: CacheStorage;
  now?: number;
}

function appStateStorage(environment: AppStateEnvironment): CacheStorage | undefined {
  return environment.caches ?? (typeof caches !== "undefined" ? caches : undefined);
}

/** Tell the worker which language to speak. Published on every launch, so a
 *  language changed in Settings (which reloads the window) reaches it too. */
export async function publishUiLanguage(
  language: string,
  environment: AppStateEnvironment = {},
): Promise<void> {
  const store = appStateStorage(environment);
  if (!store || !language) return;
  try {
    const cache = await store.open(APP_STATE_CACHE_NAME);
    await cache.put(UI_LANGUAGE_ENTRY, new Response(language, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }));
  } catch {
    // Without storage the worker falls back to the phone's system language,
    // which is still this device rather than the desktop's.
  }
}

/** Take the tap the worker parked, exactly once. */
export async function claimNotificationClick(
  environment: AppStateEnvironment = {},
): Promise<string> {
  const store = appStateStorage(environment);
  if (!store) return "";
  try {
    const cache = await store.open(APP_STATE_CACHE_NAME);
    const stored = await cache.match(NOTIFICATION_CLICK_ENTRY);
    if (!stored) return "";
    // Single use: a later reload must not reopen what was already handled.
    await cache.delete(NOTIFICATION_CLICK_ENTRY);
    const parked = (await stored.json()) as { sessionId?: unknown; createdAt?: unknown };
    const sessionId = typeof parked.sessionId === "string" ? parked.sessionId : "";
    const createdAt = Number(parked.createdAt) || 0;
    const now = environment.now ?? Date.now();
    // A tap from an hour ago is not a request to open anything now.
    if (!sessionId || now - createdAt > NOTIFICATION_CLICK_TTL_MS) return "";
    return sessionId;
  } catch {
    return "";
  }
}

/** The tap reached the running app directly; retire the parked copy so a later
 *  launch does not act on it a second time. */
export async function clearNotificationClick(
  environment: AppStateEnvironment = {},
): Promise<void> {
  const store = appStateStorage(environment);
  if (!store) return;
  try {
    const cache = await store.open(APP_STATE_CACHE_NAME);
    await cache.delete(NOTIFICATION_CLICK_ENTRY);
  } catch {
    // It expires on its own (NOTIFICATION_CLICK_TTL_MS).
  }
}
