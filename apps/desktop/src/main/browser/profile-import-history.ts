import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const HISTORY_LIMIT = 10_000;
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;

export interface BrowserHistoryEntry {
  url: string;
  title: string;
  lastVisitAt: number;
  visitCount: number;
}

async function snapshotSqlite(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(database, destination);
  } finally {
    database.close();
  }
}

function chromeTimeToUnixMilliseconds(value: unknown): number {
  if (typeof value === 'bigint') {
    if (value <= 0n) return 0;
    return Math.max(0, Number(value / 1_000n) - CHROME_EPOCH_OFFSET_MS);
  }
  const micros = Number(value);
  if (!Number.isFinite(micros) || micros <= 0) return 0;
  return Math.max(0, Math.trunc(micros / 1_000 - CHROME_EPOCH_OFFSET_MS));
}

function readChromeVisits(snapshot: string): BrowserHistoryEntry[] {
  const database = new DatabaseSync(snapshot, { readOnly: true });
  try {
    const statement = database.prepare(`
          SELECT url, title, last_visit_time, visit_count
          FROM urls
          WHERE hidden = 0 AND (url LIKE 'http://%' OR url LIKE 'https://%')
          ORDER BY last_visit_time DESC
          LIMIT ?
        `);
    statement.setReadBigInts(true);
    const rows = statement.all(BigInt(HISTORY_LIMIT)) as Array<Record<string, unknown>>;
    return rows
      .map((row) => ({
        url: String(row.url || ''),
        title: String(row.title || ''),
        lastVisitAt: chromeTimeToUnixMilliseconds(row.last_visit_time),
        visitCount: Math.max(0, Number(row.visit_count) || 0),
      }))
      .filter((entry) => Boolean(entry.url));
  } finally {
    database.close();
  }
}

async function mergeIntoHistoryFile(historyFile: string, imported: BrowserHistoryEntry[]): Promise<void> {
  let existing: BrowserHistoryEntry[] = [];
  try {
    existing = JSON.parse(await readFile(historyFile, 'utf8')) as BrowserHistoryEntry[];
  } catch {
    existing = [];
  }
  const merged = new Map<string, BrowserHistoryEntry>();
  for (const entry of [...imported, ...existing]) {
    const current = merged.get(entry.url);
    if (!current || entry.lastVisitAt > current.lastVisitAt) merged.set(entry.url, entry);
  }
  const history = [...merged.values()]
    .sort((left, right) => right.lastVisitAt - left.lastVisitAt)
    .slice(0, HISTORY_LIMIT);
  const temporary = `${historyFile}.tmp-${randomUUID()}`;
  await mkdir(dirname(historyFile), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(history)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, historyFile);
}

/** Copy a Chrome History database through a private snapshot and merge its
 *  visits into the imported-history file, newest first. Returns the number of
 *  entries read from Chrome. */
export async function importChromeHistory(
  sourceHistory: string,
  jobRoot: string,
  historyFile: string
): Promise<number> {
  const snapshot = join(jobRoot, 'History');
  try {
    await rm(jobRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await snapshotSqlite(sourceHistory, snapshot);
    const imported = readChromeVisits(snapshot);
    await mergeIntoHistoryFile(historyFile, imported);
    return imported.length;
  } finally {
    await rm(jobRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
}
