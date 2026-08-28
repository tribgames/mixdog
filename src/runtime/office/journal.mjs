import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function defaultOfficeDataDir() {
  return resolve(
    process.env.MIXDOG_DATA_DIR
      || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data'),
  );
}

export function officeJournalDirectory(dataDir = '') {
  return join(resolve(dataDir || defaultOfficeDataDir()), 'office-transactions');
}

function journalPath(id, dataDir) {
  return join(officeJournalDirectory(dataDir), `${String(id)}.json`);
}

export async function writeOfficeJournal(record, dataDir = '') {
  const directory = officeJournalDirectory(dataDir);
  await mkdir(directory, { recursive: true });
  const target = journalPath(record.id, dataDir);
  const temporary = join(directory, `.${record.id}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await rename(temporary, target);
  } catch {
    await rm(target, { force: true });
    await rename(temporary, target);
  }
  return target;
}

export async function removeOfficeJournal(id, dataDir = '') {
  await rm(journalPath(id, dataDir), { force: true });
}

export async function readOfficeJournal(id, dataDir = '') {
  try {
    return JSON.parse(await readFile(journalPath(id, dataDir), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function listOfficeJournals(dataDir = '', { cleanup = true } = {}) {
  const directory = officeJournalDirectory(dataDir);
  await mkdir(directory, { recursive: true });
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  const records = [];
  for (const name of names) {
    const path = join(directory, name);
    try {
      const record = JSON.parse(await readFile(path, 'utf8'));
      const updatedAt = Date.parse(record.updatedAt || record.startedAt || '') || (await stat(path)).mtimeMs;
      if (cleanup && Date.now() - updatedAt > RETENTION_MS) {
        if (record.checkpoint) await rm(record.checkpoint, { force: true }).catch(() => {});
        if (record.baselinePdf) await rm(record.baselinePdf, { force: true }).catch(() => {});
        await rm(path, { force: true });
        continue;
      }
      records.push(record);
    } catch {
      const info = await stat(path).catch(() => null);
      if (cleanup && info && Date.now() - info.mtimeMs > RETENTION_MS) await rm(path, { force: true });
    }
  }
  return records.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}
