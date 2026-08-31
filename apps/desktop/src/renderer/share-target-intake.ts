// The share sheet's half of composer attachment. A phone cannot drag a
// screenshot into a web app — mobile browsers do not deliver an inter-app drag
// to a page — so Android shares it instead: the service worker (public/sw.js)
// parks the payload in the app's own cache and reopens the shell carrying a
// claim token. This module trades that token for real File objects and holds
// them until the composer on screen takes them.
import { useEffect, useRef } from "react";

/** Mirrors public/sw.js. A worker is a standalone script that cannot import
 *  renderer modules, so both carry these names and a test asserts they agree. */
export const SHARE_CACHE_NAME = "mixdog-share-v1";
export const SHARE_ENTRY_PREFIX = "/__mixdog-share__/";
export const SHARE_INDEX_NAME = "index.json";
export const SHARE_CLAIM_PARAM = "shared";
export const MAX_SHARED_FILES = 8;

export type SharedIntake = { files: File[]; text: string };

type SharedIndexEntry = { url?: unknown; name?: unknown; type?: unknown };
type SharedIndex = { text?: unknown; files?: unknown };

export type SharedIntakeEnvironment = {
  caches?: CacheStorage;
  href?: string;
  replaceUrl?: (next: string) => void;
};

function defaultReplaceUrl(next: string): void {
  try {
    window.history.replaceState(window.history.state, "", next);
  } catch {
    // A container that refuses the rewrite still gets its files; only the
    // spent token lingers in the address.
  }
}

async function fileFromEntry(cache: Cache, entry: SharedIndexEntry): Promise<File | null> {
  const url = typeof entry.url === "string" ? entry.url : "";
  if (!url.startsWith(SHARE_ENTRY_PREFIX)) return null;
  try {
    const stored = await cache.match(url);
    if (!stored) return null;
    const blob = await stored.blob();
    if (!blob.size) return null;
    const type = typeof entry.type === "string" && entry.type ? entry.type : blob.type;
    const name = typeof entry.name === "string" && entry.name ? entry.name : "shared";
    return new File([blob], name, { type });
  } catch {
    return null;
  }
}

async function dropPayload(cache: Cache, token: string): Promise<void> {
  const prefix = `${SHARE_ENTRY_PREFIX}${token}/`;
  try {
    for (const key of await cache.keys()) {
      if (new URL(key.url).pathname.startsWith(prefix)) await cache.delete(key);
    }
  } catch {
    // Storage that refuses the cleanup still expires the payload on its own
    // (see SHARE_ENTRY_TTL_MS in the worker).
  }
}

/** Claim the payload named by the current address, exactly once. */
export async function readSharedIntake(
  environment: SharedIntakeEnvironment = {},
): Promise<SharedIntake | null> {
  const storage = environment.caches
    ?? (typeof caches !== "undefined" ? caches : undefined);
  const href = environment.href
    ?? (typeof window !== "undefined" ? window.location.href : "");
  if (!storage || !href) return null;
  let address: URL;
  try {
    address = new URL(href);
  } catch {
    return null;
  }
  const token = (address.searchParams.get(SHARE_CLAIM_PARAM) || "")
    .replace(/[^a-zA-Z0-9-]/g, "");
  if (!token) return null;
  // Single use: a reload must not re-attach what the composer already holds.
  address.searchParams.delete(SHARE_CLAIM_PARAM);
  (environment.replaceUrl ?? defaultReplaceUrl)(
    `${address.pathname}${address.search}${address.hash}`,
  );
  let cache: Cache;
  try {
    cache = await storage.open(SHARE_CACHE_NAME);
  } catch {
    return null;
  }
  let index: SharedIndex | null = null;
  try {
    const stored = await cache.match(`${SHARE_ENTRY_PREFIX}${token}/${SHARE_INDEX_NAME}`);
    index = stored ? (await stored.json()) as SharedIndex : null;
  } catch {
    index = null;
  }
  if (!index) return null;
  const entries = Array.isArray(index.files)
    ? (index.files as SharedIndexEntry[]).slice(0, MAX_SHARED_FILES)
    : [];
  const files: File[] = [];
  for (const entry of entries) {
    const file = await fileFromEntry(cache, entry);
    if (file) files.push(file);
  }
  await dropPayload(cache, token);
  const text = typeof index.text === "string" ? index.text.trim() : "";
  if (!files.length && !text) return null;
  return { files, text };
}

// One pending payload, one consumer. The app boots, publishes what it claimed,
// and the composer that is actually on screen takes it — a payload that
// arrives before any composer mounts simply waits here.
let pending: SharedIntake | null = null;
const listeners = new Set<() => void>();

export function publishSharedIntake(intake: SharedIntake | null): void {
  if (!intake || (!intake.files.length && !intake.text)) return;
  pending = intake;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One composer's fault must not strand the payload for the others.
    }
  }
}

export function claimSharedIntake(): SharedIntake | null {
  const intake = pending;
  pending = null;
  return intake;
}

export function subscribeSharedIntake(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drop the module-level payload and subscribers. */
export function resetSharedIntake(): void {
  pending = null;
  listeners.clear();
}

/** App boot: claim whatever the share sheet left behind, once per launch. */
export function useSharedIntakeBoot(): void {
  const claimed = useRef(false);
  useEffect(() => {
    if (claimed.current) return;
    claimed.current = true;
    void readSharedIntake()
      .then(publishSharedIntake)
      .catch(() => undefined);
  }, []);
}
