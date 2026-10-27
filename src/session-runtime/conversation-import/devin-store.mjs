/**
 * Devin CLI session store access for conversation import. Devin keeps its
 * sessions in a SQLite database (`~/.local/share/devin/cli/sessions.db`:
 * `sessions` rows plus `message_nodes`), locally or inside WSL — a file this
 * process cannot always open directly (a Windows build cannot read a WSL
 * filesystem DB), so a small Python reader runs on whichever side holds it
 * and prints JSONL. The snapshots materialized from it are what the import
 * machinery enumerates and converts. The store is only ever read (`mode=ro`);
 * snapshots are our own cache copies, never writes into Devin's data.
 */
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { resolvePluginData } from '../../runtime/shared/plugin-paths.mjs';

const READER_TIMEOUT_MS = 60_000;
const READER_MAX_BYTES = 512 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;

/**
 * One Python program answers both queries; argv after `-` is `<mode> [arg]`.
 * The DB path comes from DEVIN_CLI_DB or the user-default location resolved
 * through `pwd` (a WSL `$HOME` may point at the Windows profile). `list`
 * prints one `[id, cwd, title, created_at, last_activity_at]` JSON array per
 * visible session; `dump <id>` prints a `session_meta` line then `node`
 * lines in node_id order — the snapshot format devin.mjs reduces.
 */
const READER = String.raw`
import json, os, sqlite3, sys

mode = sys.argv[1]
db = os.environ.get('DEVIN_CLI_DB')
if not db:
    try:
        import pwd
        db = os.path.join(pwd.getpwuid(os.getuid()).pw_dir, '.local/share/devin/cli/sessions.db')
    except Exception:
        db = os.path.expanduser('~/.local/share/devin/cli/sessions.db')
con = sqlite3.connect('file:%s?mode=ro' % db, uri=True)
if mode == 'list':
    for row in con.execute(
        'select id, working_directory, title, created_at, last_activity_at'
        ' from sessions where ifnull(hidden, 0) = 0 order by last_activity_at desc'
    ):
        print(json.dumps(row))
elif mode == 'dump':
    sid = sys.argv[2]
    meta = con.execute(
        'select id, working_directory, title, created_at, last_activity_at'
        ' from sessions where id = ?', (sid,)).fetchone()
    if meta:
        print(json.dumps({'type': 'session_meta', 'payload': {
            'id': meta[0], 'cwd': meta[1], 'title': meta[2],
            'created_at': meta[3], 'last_activity_at': meta[4]}}))
    for nid, created, msg in con.execute(
        'select node_id, created_at, chat_message'
        ' from message_nodes where session_id = ? order by node_id', (sid,)):
        print(json.dumps({'type': 'node', 'payload': {
            'node_id': nid, 'created_at': created,
            'chat_message': json.loads(msg)}}))
`;

/** Snapshot files the import machinery sees: one <id>.jsonl per session. */
export function devinSnapshotDir() {
  return join(resolvePluginData(), 'import-cache', 'devin');
}

const sanitizeId = (id) => String(id || '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 120) || 'session';

function firstLine(path) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const text = buf.toString('utf8', 0, readSync(fd, buf, 0, HEAD_BYTES, 0));
    const end = text.indexOf('\n');
    return end < 0 ? text : text.slice(0, end);
  } catch {
    return null;
  } finally {
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      /* closed already */
    }
  }
}

function localDbCandidates(env) {
  const paths = [];
  const configured = typeof env.MIXDOG_DEVIN_CLI_DB === 'string' ? env.MIXDOG_DEVIN_CLI_DB.trim() : '';
  if (configured) paths.push(resolve(configured));
  const xdg = typeof env.XDG_DATA_HOME === 'string' ? env.XDG_DATA_HOME.trim() : '';
  if (xdg) paths.push(join(resolve(xdg), 'devin', 'cli', 'sessions.db'));
  paths.push(join(homedir(), '.local', 'share', 'devin', 'cli', 'sessions.db'));
  return paths;
}

/** Python on this host answers local DBs; WSL python3 answers its own side. */
function localReader(dbPath) {
  for (const command of ['python3', 'python', 'py']) {
    const probe = spawnSync(command, ['-c', 'import sqlite3'], { timeout: 10_000, windowsHide: true });
    if (!probe.error && probe.status === 0) return { kind: 'python', command, args: [], dbPath };
  }
  return { kind: 'node', dbPath };
}

function wslDistros(env) {
  const pinned = typeof env.MIXDOG_DEVIN_WSL_DISTRO === 'string' ? env.MIXDOG_DEVIN_WSL_DISTRO.trim() : '';
  if (pinned) return [pinned];
  const probe = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'utf16le', timeout: 10_000, windowsHide: true });
  if (probe.error || probe.status !== 0 || typeof probe.stdout !== 'string') return [null];
  const names = probe.stdout
    .split(/\r?\n/)
    .map((name) => name.replace(/\0/g, '').trim())
    .filter(Boolean);
  return names.length ? names : [null];
}

const wslReader = (distro) => ({
  kind: 'python',
  command: 'wsl.exe',
  args: distro ? ['-d', distro, '--exec', 'python3'] : ['--exec', 'python3'],
  dbPath: null,
});

function nodeQuery(dbPath, mode, arg) {
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const lines = [];
      if (mode === 'list') {
        const rows = db
          .prepare(
            'select id, working_directory, title, created_at, last_activity_at' +
              ' from sessions where ifnull(hidden, 0) = 0 order by last_activity_at desc'
          )
          .all();
        for (const row of rows) {
          lines.push(
            JSON.stringify([row.id, row.working_directory, row.title, row.created_at, row.last_activity_at])
          );
        }
      } else {
        const meta = db
          .prepare('select id, working_directory, title, created_at, last_activity_at from sessions where id = ?')
          .get(arg);
        if (meta) {
          lines.push(
            JSON.stringify({
              type: 'session_meta',
              payload: {
                id: meta.id,
                cwd: meta.working_directory,
                title: meta.title,
                created_at: meta.created_at,
                last_activity_at: meta.last_activity_at,
              },
            })
          );
        }
        const nodes = db
          .prepare('select node_id, created_at, chat_message from message_nodes where session_id = ? order by node_id')
          .all(arg);
        for (const row of nodes) {
          lines.push(
            JSON.stringify({
              type: 'node',
              payload: {
                node_id: row.node_id,
                created_at: row.created_at,
                chat_message: JSON.parse(row.chat_message),
              },
            })
          );
        }
      }
      return lines.length ? `${lines.join('\n')}\n` : '';
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Run one READER query. Returns the JSONL body, or null on any failure. */
function queryDevin(reader, mode, arg) {
  if (reader.kind === 'node') return nodeQuery(reader.dbPath, mode, arg);
  const argv = arg === undefined ? [mode] : [mode, arg];
  const result = spawnSync(reader.command, [...reader.args, '-', ...argv], {
    input: READER,
    env: { ...process.env, ...(reader.dbPath ? { DEVIN_CLI_DB: reader.dbPath } : {}) },
    encoding: 'utf8',
    maxBuffer: READER_MAX_BYTES,
    timeout: READER_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout;
}

const storeCache = new Map();

/** Test seam: forget the resolved store so the next probe runs again. */
export function resetDevinStoreCache() {
  storeCache.clear();
}

/**
 * The reachable Devin store `{ reader, displayRoot }`, or null. Local DB
 * files first (MIXDOG_DEVIN_CLI_DB, XDG, the default path), then on Windows
 * each WSL distro (MIXDOG_DEVIN_WSL_DISTRO pins one).
 */
export function resolveDevinStore(env = process.env) {
  const key = `${env.MIXDOG_DEVIN_CLI_DB || ''}${env.MIXDOG_DEVIN_WSL_DISTRO || ''}`;
  if (storeCache.has(key)) return storeCache.get(key);
  let store = null;
  for (const dbPath of localDbCandidates(env)) {
    if (!existsSync(dbPath)) continue;
    const reader = localReader(dbPath);
    if (queryDevin(reader, 'list') !== null) {
      store = { reader, displayRoot: dirname(dbPath) };
      break;
    }
  }
  if (!store && process.platform === 'win32') {
    for (const distro of wslDistros(env)) {
      const reader = wslReader(distro);
      if (queryDevin(reader, 'list') !== null) {
        store = {
          reader,
          displayRoot: distro ? `wsl:${distro} ~/.local/share/devin/cli` : 'wsl ~/.local/share/devin/cli',
        };
        break;
      }
    }
  }
  storeCache.set(key, store);
  return store;
}

const snapshotSessionIds = new Map();

/**
 * Refresh the snapshot cache from the store: every listed session gets a
 * header-only `<id>.jsonl` whose `session_meta` line carries the list data
 * (the full conversation is materialized at import time). Unchanged
 * `last_activity_at` stamps keep their file; files of sessions the store no
 * longer lists are pruned. Returns `{ store, dir }`, or null unreachable.
 */
export function refreshDevinSnapshots(env = process.env) {
  const store = resolveDevinStore(env);
  if (!store) return null;
  const out = queryDevin(store.reader, 'list');
  if (out === null) return null;
  const dir = devinSnapshotDir();
  mkdirSync(dir, { recursive: true });
  const keep = new Set();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(row)) continue;
    const [id, cwd, title, createdAt, lastActivityAt] = row;
    if (typeof id !== 'string' || !id) continue;
    const file = join(dir, `${sanitizeId(id)}.jsonl`);
    keep.add(file);
    snapshotSessionIds.set(file, id);
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: {
        id,
        cwd: cwd || null,
        title: title || null,
        created_at: createdAt ?? null,
        last_activity_at: lastActivityAt ?? null,
      },
    });
    if (firstLine(file) === meta) continue;
    writeFileSync(file, `${meta}\n`, 'utf8');
    // List order follows the session's own last activity, not the refresh time.
    const at = typeof lastActivityAt === 'number' && lastActivityAt > 0 ? lastActivityAt * 1000 : Date.now();
    try {
      utimesSync(file, new Date(at), new Date(at));
    } catch {
      /* display ordering only */
    }
  }
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (keep.has(file)) continue;
    snapshotSessionIds.delete(file);
    try {
      unlinkSync(file);
    } catch {
      /* a snapshot mid-import is left alone */
    }
  }
  return { store, dir };
}

/**
 * Replace a managed snapshot's header with the session's full dump, so an
 * import always converts the live conversation rather than the listing's
 * stale text. Returns false when the store or session is unreachable.
 */
export function materializeDevinSnapshot(path, env = process.env) {
  const store = resolveDevinStore(env);
  const sessionId = snapshotSessionIds.get(path) || basename(path, '.jsonl');
  const body = store && queryDevin(store.reader, 'dump', sessionId);
  if (typeof body !== 'string' || !body.includes('"session_meta"')) return false;
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, path);
  try {
    const meta = JSON.parse(firstLine(path) || '{}').payload;
    const at = typeof meta?.last_activity_at === 'number' && meta.last_activity_at > 0 ? meta.last_activity_at * 1000 : Date.now();
    utimesSync(path, new Date(at), new Date(at));
  } catch {
    /* display ordering only */
  }
  return true;
}
