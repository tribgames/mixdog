/**
 * The thread titles Codex itself stores, by thread id (read-only):
 *
 *   state_<N>.sqlite   `threads.title`, overridden by `threads.name` (a rename)
 *   session_index.jsonl  append-only `{ id, thread_name }`; the latest
 *                        non-empty name of an id wins and overrides the DB
 *
 * Anything unreadable is skipped: a missing or locked store simply leaves the
 * conversation to the title derived from its messages.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { titleFromText } from '../../runtime/agent/orchestrator/session/conversation-import/turns.mjs';

const STATE_DB_RE = /^state_(\d+)\.sqlite$/i;

async function newestStateDb(home) {
  let newest = null;
  for (const name of await readdir(home).catch(() => [])) {
    const version = STATE_DB_RE.exec(name)?.[1];
    if (version !== undefined && (!newest || Number(version) > newest.version)) {
      newest = { name, version: Number(version) };
    }
  }
  return newest ? join(home, newest.name) : null;
}

function readStateRows(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const columns = new Set(
      db
        .prepare('PRAGMA table_info(threads)')
        .all()
        .map((column) => column.name)
    );
    const wanted = ['title', 'name'].filter((column) => columns.has(column));
    if (!wanted.length) return [];
    return db.prepare(`SELECT id, ${wanted.join(', ')} FROM threads`).all();
  } finally {
    db.close();
  }
}

async function readStateTitles(home, titles) {
  try {
    const path = await newestStateDb(home);
    if (!path) return;
    const rows = readStateRows(path);
    for (const column of ['title', 'name']) {
      for (const row of rows) {
        const title = titleFromText(row[column]);
        if (title && typeof row.id === 'string') titles.set(row.id, title);
      }
    }
  } catch {
    /* unreadable store: fall back to the session index and derived titles */
  }
}

async function readIndexTitles(home, titles) {
  let text;
  try {
    text = await readFile(join(home, 'session_index.jsonl'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const title = titleFromText(entry?.thread_name);
    if (title && typeof entry.id === 'string') titles.set(entry.id, title);
  }
}

/** Map of Codex thread id → its stored title (whitespace-normalized, ≤100 chars). */
export async function loadCodexThreadTitles(home) {
  const titles = new Map();
  await readStateTitles(home, titles);
  await readIndexTitles(home, titles);
  return titles;
}
