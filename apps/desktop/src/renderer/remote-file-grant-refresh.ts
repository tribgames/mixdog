// A linked file outside every project opens with a one-file grant token from
// `resolveLocalPaths`. Surfaces keep that token (file tabs, cached links,
// previews) while the host's grant can end under them: it expires, is evicted
// or is gone after the host restarts. This wraps the relay call so such a
// refusal asks the host for the file's grant again, through the same
// `resolveLocalPaths` policy, and retries the call once. The host restarting
// (its grants are gone), a long sleep (they expired) and a client reload (the
// records are kept in per-device storage) all recover the same way.

import { fileErrorCode, SELECTED_FILE_GRANT_UNAVAILABLE } from '../shared/file-error-codes';

type Call = <T = unknown>(method: string, params?: unknown[]) => Promise<T>;

export interface GrantSource {
  path: string;
  sessionId?: string;
}

/** token -> the linked path (and conversation) it was granted for. */
export interface GrantSourceStore {
  get(token: string): GrantSource | undefined;
  set(token: string, source: GrantSource): void;
}

const TRACKED_LIMIT = 256;
const MAX_TOKEN_LENGTH = 128;
const MAX_PATH_LENGTH = 4096;

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > TRACKED_LIMIT) {
    const oldest = map.keys().next().value as K;
    map.delete(oldest);
  }
}

/** The host's answer when a token names no live grant: its structured code,
 *  never the message text (which can carry a file name). */
function grantRefused(error: unknown): boolean {
  return fileErrorCode(error) === SELECTED_FILE_GRANT_UNAVAILABLE;
}

/** Records kept for this page only. */
export function memoryGrantSources(): GrantSourceStore {
  const sources = new Map<string, GrantSource>();
  return { get: (token) => sources.get(token), set: (token, source) => remember(sources, token, source) };
}

function parseStoredSources(raw: string | null): Map<string, GrantSource> {
  const sources = new Map<string, GrantSource>();
  if (!raw) return sources;
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    return sources;
  }
  if (!Array.isArray(rows)) return sources;
  for (const row of rows.slice(-TRACKED_LIMIT)) {
    if (!Array.isArray(row)) continue;
    const [token, path, sessionId] = row as unknown[];
    if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) continue;
    if (typeof path !== 'string' || !path || path.length > MAX_PATH_LENGTH) continue;
    remember(sources, token, typeof sessionId === 'string' && sessionId ? { path, sessionId } : { path });
  }
  return sources;
}

/** Records kept in this browser's per-device remote storage under `key`, so
 *  a token a restored tab or cached link still holds after a reload is
 *  granted again too. Only the linked path and conversation id are stored,
 *  newest last, at most TRACKED_LIMIT; the pairing reset removes the key with
 *  the rest of the device's pairing state. Read through on every lookup, so a
 *  reset (or another tab) is seen at once. */
export function storedGrantSources(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string): GrantSourceStore {
  let lastRaw: string | null = null;
  let parsed = new Map<string, GrantSource>();
  const read = (): Map<string, GrantSource> => {
    let raw: string | null = null;
    try {
      raw = storage.getItem(key);
    } catch {
      /* private storage: nothing kept */
    }
    if (raw !== lastRaw) {
      lastRaw = raw;
      parsed = parseStoredSources(raw);
    }
    return parsed;
  };
  return {
    get: (token) => read().get(token),
    set: (token, source) => {
      if (token.length > MAX_TOKEN_LENGTH || source.path.length > MAX_PATH_LENGTH) return;
      const sources = new Map(read());
      remember(sources, token, source);
      const raw = JSON.stringify(
        [...sources].map(([held, entry]) =>
          entry.sessionId ? [held, entry.path, entry.sessionId] : [held, entry.path]
        )
      );
      try {
        storage.setItem(key, raw);
        lastRaw = raw;
        parsed = sources;
      } catch {
        /* quota or private storage: this page still remembers it */
        parsed = sources;
      }
    },
  };
}

/** How a refused token's file is reached now: a fresh grant token, or (its
 *  folder became a registered project) the project address, with no token. */
type FileRoute = { token: string } | { projectPath: string; relPath: string };

export function withFileGrantRefresh(call: Call, sources: GrantSourceStore = memoryGrantSources()): Call {
  // refused token -> how the host reaches the same file now
  const renewed = new Map<string, FileRoute>();
  const refreshing = new Map<string, Promise<FileRoute>>();

  const current = (token: string): FileRoute => renewed.get(token) ?? { token };

  const noteGrants = (entries: unknown, sessionId: unknown): void => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries as Array<{ accessToken?: unknown; absolutePath?: unknown } | null>) {
      if (typeof entry?.accessToken !== 'string' || typeof entry.absolutePath !== 'string') continue;
      sources.set(entry.accessToken, {
        path: entry.absolutePath,
        ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}),
      });
    }
  };

  const refresh = (token: string, file: GrantSource, refusal: unknown): Promise<FileRoute> => {
    let pending = refreshing.get(token);
    if (pending) return pending;
    const source = sources.get(token) ?? file;
    // The conversation the link came from, when known; either way the host
    // may vouch for it from any conversation this device can open.
    const params = [[source.path], source.sessionId ?? null, { anyConversation: true }];
    pending = call<Array<{ accessToken?: unknown; projectPath?: unknown; relPath?: unknown }>>(
      'resolveLocalPaths',
      params
    )
      .then((entries) => {
        noteGrants(entries, source.sessionId);
        const entry = entries?.[0];
        let route: FileRoute;
        if (typeof entry?.accessToken === 'string' && entry.accessToken) {
          route = { token: entry.accessToken };
        } else if (typeof entry?.projectPath === 'string' && typeof entry.relPath === 'string' && entry.relPath) {
          route = { projectPath: entry.projectPath, relPath: entry.relPath };
        } else {
          throw refusal;
        }
        // Every stale token that led here now leads to the same route.
        for (const [stale, target] of renewed) {
          if ('token' in target && target.token === token) remember(renewed, stale, route);
        }
        if (!('token' in route) || route.token !== token) remember(renewed, token, route);
        return route;
      })
      .finally(() => refreshing.delete(token));
    refreshing.set(token, pending);
    return pending;
  };

  return async <T>(method: string, params: unknown[] = []): Promise<T> => {
    if (method === 'resolveLocalPaths') {
      const entries = await call<T>(method, params);
      noteGrants(entries, params[1]);
      return entries;
    }
    const at = TOKEN_PARAM[method];
    const held = at === undefined ? null : params[at];
    if (at === undefined || typeof held !== 'string' || !held) return call<T>(method, params);
    // A project route has no token to refuse, so it is sent as it is.
    const routed = (route: FileRoute): unknown[] =>
      params.map((param, index) => {
        if (index === at) return 'token' in route ? route.token : null;
        if ('token' in route) return param;
        if (index === 0) return route.projectPath;
        return index === 1 ? route.relPath : param;
      });
    const route = current(held);
    if (!('token' in route)) return call<T>(method, routed(route));
    const token = route.token;
    try {
      return await call<T>(method, routed(route));
    } catch (error) {
      if (!grantRefused(error)) throw error;
      // A concurrent call may have renewed this token while this one was in
      // flight: use that route rather than asking the host again.
      const latest = current(held);
      if (!('token' in latest) || latest.token !== token) return call<T>(method, routed(latest));
      // A token with no kept record (cleared storage, a layout restored from
      // another PC) still names its file: a grant addresses it as its folder
      // plus its name, so the path the call carries is asked for again.
      const file = grantedFilePath(params[0], params[1]);
      if (!sources.get(token) && !file) throw error;
      const fresh = await refresh(token, { path: file }, error);
      // One retry: a second refusal is the real answer.
      return call<T>(method, routed(fresh));
    }
  };
}

/** The same refresh around an API object (the desktop window's preload API):
 *  a copy whose token-carrying file methods and `resolveLocalPaths` share one
 *  refresh; every other member is kept as is. */
export function withApiFileGrantRefresh<A extends object>(api: A, sources?: GrantSourceStore): A {
  const methods = api as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const direct: Call = (method, params = []) => methods[method](...params) as Promise<never>;
  const call = withFileGrantRefresh(direct, sources);
  const wrapped = { ...api } as Record<string, unknown>;
  for (const method of ['resolveLocalPaths', ...Object.keys(TOKEN_PARAM)]) {
    if (typeof methods[method] === 'function') wrapped[method] = (...args: unknown[]) => call(method, args);
  }
  return wrapped as A;
}

/** Where each file call carries its access token. */
const TOKEN_PARAM: Readonly<Record<string, number>> = {
  readProjectFile: 2,
  statProjectFile: 2,
  previewProjectFile: 2,
  previewDocumentFile: 2,
  previewProjectFileRange: 2,
  previewDocumentPages: 2,
  captureFileSnapshot: 2,
  localPageUrl: 2,
  readEditorBackup: 2,
  deleteEditorBackup: 2,
  writeProjectFile: 4,
  writeEditorBackup: 4,
  openFilePath: 2,
  revealFile: 2,
  serverDownloadBegin: 2,
};

/** The absolute path a granted file's (folder, name) address names, or ''. */
function grantedFilePath(projectPath: unknown, relPath: unknown): string {
  if (typeof projectPath !== 'string' || typeof relPath !== 'string' || !projectPath || !relPath) return '';
  if (/[\\/]/.test(relPath) || relPath === '.' || relPath === '..') return '';
  const folder = projectPath.replace(/\\/g, '/');
  return folder.endsWith('/') ? `${folder}${relPath}` : `${folder}/${relPath}`;
}
