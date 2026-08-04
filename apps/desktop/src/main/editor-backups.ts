import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export interface EditorBackup {
  content: string;
  expectedContent: string;
  updatedAt: number;
}

const MAX_BACKUP_CONTENT = 4_194_304;
const MAX_BACKUP_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_BACKUP_FILES = 100;
const prunedRoots = new Set<string>();

function backupDirectory(userDataPath: string): string {
  return join(resolve(userDataPath), 'editor-backups');
}

function backupPath(userDataPath: string, sourcePath: string): string {
  if (!userDataPath || !isAbsolute(sourcePath)) throw new TypeError('Editor backup path is invalid.');
  const source = process.platform === 'win32'
    ? resolve(sourcePath).toLocaleLowerCase()
    : resolve(sourcePath);
  const key = createHash('sha256').update(source).digest('hex');
  return join(backupDirectory(userDataPath), `${key}.json`);
}

function validBackup(value: unknown): value is EditorBackup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.content === 'string'
    && row.content.length <= MAX_BACKUP_CONTENT
    && typeof row.expectedContent === 'string'
    && row.expectedContent.length <= MAX_BACKUP_CONTENT
    && Number.isFinite(row.updatedAt)
    && Number(row.updatedAt) > 0;
}

async function pruneBackups(userDataPath: string): Promise<void> {
  const root = backupDirectory(userDataPath);
  if (prunedRoots.has(root)) return;
  prunedRoots.add(root);
  try {
    const now = Date.now();
    const rows = await Promise.all((await readdir(root))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map(async (name) => {
        const path = join(root, name);
        const info = await stat(path);
        return { path, mtimeMs: info.mtimeMs };
      }));
    rows.sort((left, right) => right.mtimeMs - left.mtimeMs);
    await Promise.all(rows
      .filter((row, index) => index >= MAX_BACKUP_FILES || now - row.mtimeMs > MAX_BACKUP_AGE_MS)
      .map((row) => rm(row.path, { force: true })));
  } catch {
    // A missing/corrupt convenience directory starts clean.
  }
}

export async function readEditorBackup(
  userDataPath: string,
  sourcePath: string,
): Promise<EditorBackup | null> {
  const path = backupPath(userDataPath, sourcePath);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!validBackup(parsed) || Date.now() - parsed.updatedAt > MAX_BACKUP_AGE_MS) {
      await rm(path, { force: true });
      return null;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    await rm(path, { force: true }).catch(() => {});
    return null;
  }
}

export async function writeEditorBackup(
  userDataPath: string,
  sourcePath: string,
  content: string,
  expectedContent: string,
): Promise<EditorBackup> {
  if (typeof content !== 'string' || content.length > MAX_BACKUP_CONTENT
    || typeof expectedContent !== 'string' || expectedContent.length > MAX_BACKUP_CONTENT) {
    throw new TypeError('Editor backup content is invalid.');
  }
  const path = backupPath(userDataPath, sourcePath);
  const backup = { content, expectedContent, updatedAt: Date.now() };
  const temp = `${path}.tmp-${process.pid}-${backup.updatedAt}`;
  await mkdir(backupDirectory(userDataPath), { recursive: true });
  await pruneBackups(userDataPath);
  try {
    await writeFile(temp, JSON.stringify(backup), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
  return backup;
}

export async function deleteEditorBackup(userDataPath: string, sourcePath: string): Promise<void> {
  await rm(backupPath(userDataPath, sourcePath), { force: true });
}
