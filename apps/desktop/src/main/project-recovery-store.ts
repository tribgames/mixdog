// Host-private byte journals. Publication precedes the first target mutation.
// This module never restores project files; approval and target revalidation
// belong to the project writer. Do not put this store inside the project tree.
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  RECOVERY_ID_PATTERN,
  ProjectRecoveryError,
  recoveryStorageError,
  type ProjectRecoverySummary,
  type ProjectRecoveryDetail,
} from '../shared/project-recovery';
import { createKeyedSerialQueue } from '../../../../src/runtime/shared/keyed-serial-queue.mjs';

export const RECOVERY_MAX_BYTES = 16 * 1024 * 1024;
export const RECOVERY_MAX_RECORDS = 20;
const INSTANCE = randomUUID();
const active = new Set<string>();
const preparations = createKeyedSerialQueue();
const SHA = /^[a-f0-9]{64}$/;
export type RecoveryIdentity = { dev: string; ino: string };
export type RecoveryPreparedFile = {
  relPath: string;
  destination: string;
  parent: RecoveryIdentity;
  mode: number;
  before: Buffer;
  after: Buffer;
};
type ByteRef = { size: number; sha256: string };
export type RecoveryFile = Omit<RecoveryPreparedFile, 'before' | 'after'> & { before: ByteRef; after: ByteRef };
export type RecoveryManifest = {
  version: 1;
  id: string;
  createdAt: number;
  root: string;
  rootIdentity: RecoveryIdentity;
  files: RecoveryFile[];
};
export type RecoveryState = {
  phase: 'failed' | 'recovered' | 'complete' | 'restoring';
  message: string;
  restored: string[];
};
const SETTLED_PHASES: Partial<Record<RecoveryState['phase'], 'completed' | 'failed' | 'recovered'>> = {
  complete: 'completed',
  failed: 'failed',
  recovered: 'recovered',
};
export function recoverySettledPhase(
  state: RecoveryState | null | undefined
): 'completed' | 'failed' | 'recovered' | 'interrupted' {
  return (state && SETTLED_PHASES[state.phase]) || 'interrupted';
}
export const recoveryDigest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function recoveryIdentity(path: string): RecoveryIdentity {
  const value = statSync(path, { bigint: true });
  return { dev: String(value.dev), ino: String(value.ino) };
}
export function sameRecoveryIdentity(left: RecoveryIdentity, right: RecoveryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function identity(value: unknown): value is RecoveryIdentity {
  const item = value as RecoveryIdentity | null;
  return (
    !!item &&
    typeof item.dev === 'string' &&
    /^\d{1,30}$/.test(item.dev) &&
    typeof item.ino === 'string' &&
    /^\d{1,30}$/.test(item.ino)
  );
}
function byteRef(value: unknown): value is ByteRef {
  const item = value as ByteRef | null;
  return (
    !!item &&
    Number.isSafeInteger(item.size) &&
    item.size >= 0 &&
    item.size <= RECOVERY_MAX_BYTES &&
    typeof item.sha256 === 'string' &&
    SHA.test(item.sha256)
  );
}
function validManifest(value: unknown, id: string): value is RecoveryManifest {
  const item = value as RecoveryManifest | null;
  if (
    item?.version !== 1 ||
    item.id !== id ||
    !Number.isSafeInteger(item.createdAt) ||
    item.createdAt < 1 ||
    item.createdAt > 8.64e15 ||
    typeof item.root !== 'string' ||
    !isAbsolute(item.root) ||
    !identity(item.rootIdentity) ||
    !Array.isArray(item.files) ||
    !item.files.length ||
    item.files.length > 100
  )
    return false;
  let bytes = 0;
  const paths = new Set<string>();
  for (const file of item.files) {
    if (
      !file ||
      typeof file.relPath !== 'string' ||
      !file.relPath ||
      file.relPath.length > 4096 ||
      isAbsolute(file.relPath) ||
      file.relPath.includes('\0') ||
      typeof file.destination !== 'string' ||
      !isAbsolute(file.destination) ||
      !identity(file.parent) ||
      !Number.isInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o177777 ||
      !byteRef(file.before) ||
      !byteRef(file.after) ||
      paths.has(file.relPath)
    )
      return false;
    paths.add(file.relPath);
    bytes += file.before.size + file.after.size;
  }
  return bytes <= RECOVERY_MAX_BYTES;
}
function locationName(name: string): { id: string; retired: boolean; pid?: number; instance?: string } | undefined {
  const retired = name.startsWith('retired-');
  const parts = (retired ? name.slice(8) : name).split('--');
  if (!RECOVERY_ID_PATTERN.test(parts[0])) return undefined;
  if (parts.length === 1) return { id: parts[0], retired };
  if (
    parts.length !== 4 ||
    !/^\d{1,10}$/.test(parts[1]) ||
    Number(parts[1]) < 1 ||
    !RECOVERY_ID_PATTERN.test(parts[2]) ||
    !RECOVERY_ID_PATTERN.test(parts[3])
  )
    return undefined;
  return { id: parts[0], retired, pid: Number(parts[1]), instance: parts[2] };
}
function ownedName(id: string): string {
  return `${id}--${process.pid}--${INSTANCE}--${randomUUID()}`;
}
export function recoveryIsRetired(directory: string): boolean {
  return locationName(basename(directory))?.retired === true;
}

// Retirement lives in the directory name, outside the files being removed.
// A partial recursive deletion can never make a completed/discarded batch
// restorable again. Retain failed cleanup for an explicit later discard.
export async function retireRecoveryDirectory(directory: string): Promise<string> {
  await validateRecoveryDirectory(directory);
  if (recoveryIsRetired(directory)) return directory;
  const retired = join(dirname(directory), `retired-${basename(directory)}`);
  await rename(directory, retired);
  active.delete(directory);
  active.add(retired);
  return retired;
}
export async function removeRecoveryDirectory(directory: string): Promise<void> {
  if (!recoveryIsRetired(directory)) throw new Error('Recovery record must be retired before removal.');
  await validateRecoveryDirectory(directory);
  await syncDirectory(dirname(directory));
  await rm(directory, { recursive: true });
}

// The bounded inventory of a record's flat store: regular files only. Every
// revision covers it, so an explicit discard (recursive removal) never deletes
// an entry added, replaced or retyped after the user's inspection.
export async function recoveryStorageInventory(directory: string): Promise<Array<[string, string, string]>> {
  await validateRecoveryDirectory(directory);
  const entries: Array<[string, string, string]> = [];
  for await (const entry of await opendir(directory)) {
    if (entries.length >= 300)
      throw new ProjectRecoveryError('RECOVERY_STORAGE', 'Recovery record has too many entries for automatic removal.');
    const file = join(directory, entry.name);
    const info = await lstat(file);
    if (info.isDirectory())
      throw new ProjectRecoveryError('RECOVERY_STORAGE', 'Recovery record contains an unexpected directory.');
    if (!info.isFile() || info.isSymbolicLink())
      throw new ProjectRecoveryError(
        'RECOVERY_STORAGE',
        'Recovery record contains an entry that is not a regular file.'
      );
    const digest =
      info.size <= 131072 && ['manifest.json', 'state.json'].includes(entry.name)
        ? recoveryDigest(await recoveryReadBytes(file, 131072))
        : '';
    entries.push([entry.name, fileStamp(info), digest]);
  }
  await validateRecoveryDirectory(directory);
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

// Invalid/retired records grant only deletion of their host-owned flat store,
// never restoration of any path mentioned by an unreadable manifest. Hash a
// bounded inventory so a replaced record or repaired manifest needs approval
// again. Directory rename during leasing must not invalidate that inventory.
export async function inspectRecoveryStorage(directory: string, leased = false): Promise<ProjectRecoveryDetail> {
  await validateRecoveryDirectory(directory);
  const owner = locationName(basename(directory))!;
  const identityBefore = recoveryIdentity(directory);
  const entries = await recoveryStorageInventory(directory);
  if (!sameRecoveryIdentity(identityBefore, recoveryIdentity(directory))) throw new Error('Recovery record changed.');
  const busy = !leased && recoveryIsActive(directory);
  let phase: ProjectRecoveryDetail['phase'] = 'invalid';
  if (busy) phase = 'active';
  else if (owner.retired) phase = 'retired';
  return {
    id: owner.id,
    createdAt: 0,
    fileCount: 0,
    active: busy,
    phase,
    files: [],
    revision: recoveryDigest(JSON.stringify([owner.id, owner.retired, identityBefore, entries])),
  };
}
export function recoveryIsActive(directory: string): boolean {
  const owner = locationName(basename(directory));
  if (!owner?.pid) return false;
  if (owner.instance === INSTANCE) return active.has(directory);
  // Signal zero is a liveness probe, not a termination request. Permission
  // errors and PID reuse conservatively retain ownership rather than stealing it.
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
export function projectRecoveryStorePath(userDataPath: string, root: string): string {
  if (!isAbsolute(userDataPath)) throw new Error('Recovery requires a host-owned data directory.');
  return join(realpathSync(userDataPath), 'editor-recovery', recoveryDigest(resolve(root)));
}
async function requireDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== resolve(path)) {
    throw new ProjectRecoveryError('RECOVERY_STORAGE', 'Recovery storage is not a regular private directory.');
  }
}
export async function validateRecoveryDirectory(directory: string): Promise<void> {
  await requireDirectory(dirname(dirname(directory)));
  await requireDirectory(dirname(directory));
  await requireDirectory(directory);
}
export async function recoveryLocations(userDataPath: string, root: string): Promise<string[]> {
  const parent = projectRecoveryStorePath(userDataPath, root);
  try {
    await requireDirectory(dirname(parent));
    await requireDirectory(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result: string[] = [];
  let seen = 0;
  for await (const entry of await opendir(parent)) {
    if (++seen > RECOVERY_MAX_RECORDS * 3)
      throw new ProjectRecoveryError('RECOVERY_STORAGE', 'Recovery storage needs manual inspection: too many entries.');
    if (!locationName(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
      throw new ProjectRecoveryError(
        'RECOVERY_MANUAL_INSPECTION',
        'Recovery storage contains unrecognized entries. Inspect the host recovery folder manually.'
      );
    result.push(join(parent, entry.name));
  }
  return result;
}
export async function recoveryLocation(userDataPath: string, root: string, id: string): Promise<string> {
  if (!RECOVERY_ID_PATTERN.test(id)) throw new TypeError('Invalid recovery ID.');
  const matches = (await recoveryLocations(userDataPath, root)).filter(
    (path) => locationName(basename(path))?.id === id
  );
  if (matches.length !== 1)
    throw new ProjectRecoveryError(
      'RECOVERY_UNAVAILABLE',
      'Recovery record moved or is unavailable. Refresh the list.'
    );
  return matches[0];
}
function fileStamp(value: Awaited<ReturnType<typeof lstat>>): string {
  return [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs, value.mode].join(':');
}
export class RecoveryReadLimitError extends Error {}
export async function recoveryReadBytes(file: string, maxBytes: number): Promise<Buffer> {
  const first = await lstat(file);
  if (!first.isFile() || first.isSymbolicLink()) throw new Error('Recovery file is invalid.');
  if (first.size > maxBytes) throw new RecoveryReadLimitError('Recovery file is oversized.');
  const handle = await open(file, 'r');
  try {
    if (fileStamp(await handle.stat()) !== fileStamp(first)) throw new Error('Recovery file changed while opening.');
    const buffer = Buffer.alloc(first.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const last = await lstat(file);
    if (
      size !== first.size ||
      !last.isFile() ||
      last.isSymbolicLink() ||
      fileStamp(last) !== fileStamp(first) ||
      fileStamp(await handle.stat()) !== fileStamp(first)
    )
      throw new Error('Recovery file changed while reading.');
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}
async function privateFile(file: string, bytes: Buffer, onCreated?: () => void): Promise<void> {
  const handle = await open(file, 'wx', 0o600);
  try {
    onCreated?.();
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function syncDirectory(path: string): Promise<void> {
  // Process-crash recovery, not a universal power-loss/Windows directory-fsync guarantee.
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function writeRecoveryState(directory: string, state: RecoveryState): Promise<void> {
  await validateRecoveryDirectory(directory);
  const temp = join(directory, `state-${randomUUID()}.tmp`);
  let owned = false;
  try {
    await privateFile(temp, Buffer.from(JSON.stringify({ ...state, message: state.message.slice(0, 8000) })), () => {
      // Own the temp as soon as exclusive creation succeeds, including failed
      // writes, syncs and closes. A failed open must never authorize deletion.
      owned = true;
    });
    await validateRecoveryDirectory(directory);
    await rename(temp, join(directory, 'state.json'));
    owned = false;
    await syncDirectory(directory);
  } finally {
    if (owned) await rm(temp, { force: true });
  }
}
export async function readRecoveryRecord(directory: string) {
  await validateRecoveryDirectory(directory);
  const id = locationName(basename(directory))?.id;
  if (!id) throw new Error('Recovery location is invalid.');
  const raw = await recoveryReadBytes(join(directory, 'manifest.json'), 131072);
  const manifest: unknown = JSON.parse(raw.toString('utf8'));
  if (!validManifest(manifest, id)) throw new Error('Recovery manifest is invalid. No file will be restored.');
  let stateBytes: Buffer = Buffer.alloc(0);
  try {
    stateBytes = await recoveryReadBytes(join(directory, 'state.json'), 65536);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let state: RecoveryState | undefined;
  if (stateBytes.length) {
    const candidate = JSON.parse(stateBytes.toString('utf8')) as RecoveryState;
    if (
      !candidate ||
      !['failed', 'recovered', 'complete', 'restoring'].includes(candidate.phase) ||
      typeof candidate.message !== 'string' ||
      candidate.message.length > 8000 ||
      !Array.isArray(candidate.restored) ||
      candidate.restored.length > manifest.files.length ||
      candidate.restored.some((rel) => !manifest.files.some((file) => file.relPath === rel))
    ) {
      throw new Error('Recovery state is invalid. No file will be restored.');
    }
    state = candidate;
  }
  return { manifest, state, fingerprint: recoveryDigest(Buffer.concat([raw, stateBytes])) };
}
export async function readRecoveryPayload(
  directory: string,
  file: RecoveryFile,
  index: number,
  side: 'before' | 'after'
): Promise<Buffer> {
  await validateRecoveryDirectory(directory);
  const bytes = await recoveryReadBytes(join(directory, `${index}.${side}`), file[side].size);
  if (bytes.length !== file[side].size || recoveryDigest(bytes) !== file[side].sha256)
    throw new Error('Recovery backup failed its integrity check.');
  return bytes;
}
export async function listRecoveryRecords(userDataPath: string, root: string): Promise<ProjectRecoverySummary[]> {
  const records: ProjectRecoverySummary[] = [];
  for (const directory of await recoveryLocations(userDataPath, root)) {
    const id = locationName(basename(directory))!.id;
    const busy = recoveryIsActive(directory);
    if (recoveryIsRetired(directory)) {
      records.push({ id, createdAt: 0, fileCount: 0, phase: busy ? 'active' : 'retired' });
      continue;
    }
    try {
      const { manifest, state } = await readRecoveryRecord(directory);
      records.push({
        id,
        createdAt: manifest.createdAt,
        fileCount: manifest.files.length,
        payloadBytes: manifest.files.reduce((sum, file) => sum + file.before.size + file.after.size, 0),
        phase: busy ? 'active' : recoverySettledPhase(state),
      });
    } catch {
      records.push({ id, createdAt: 0, fileCount: 0, phase: busy ? 'active' : 'invalid' });
    }
  }
  return records.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
export async function claimRecoveryDirectory(directory: string): Promise<string> {
  await validateRecoveryDirectory(directory);
  if (recoveryIsActive(directory))
    throw new ProjectRecoveryError('RECOVERY_BUSY', 'Recovery record is still owned by a running operation.');
  const owner = locationName(basename(directory))!;
  const owned = join(dirname(directory), `${owner.retired ? 'retired-' : ''}${ownedName(owner.id)}`);
  await rename(directory, owned);
  active.add(owned);
  return owned;
}
export async function releaseRecoveryDirectory(directory: string): Promise<void> {
  active.delete(directory);
  const owner = locationName(basename(directory))!;
  const target = join(dirname(directory), `${owner.retired ? 'retired-' : ''}${owner.id}`);
  try {
    await rename(directory, target);
    await syncDirectory(dirname(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Recovery data was retained but could not be published.', { cause: error });
    }
  }
}
export async function beginProjectRecovery(userDataPath: string, root: string, files: RecoveryPreparedFile[]) {
  // Concurrent disjoint batches may prepare together, but must reserve record
  // capacity serially in this host. They retain independent mutation claims.
  return preparations(projectRecoveryStorePath(userDataPath, root), () =>
    prepareRecovery(userDataPath, root, files)
  ).catch((error) => {
    throw recoveryStorageError(error);
  });
}
async function prepareRecovery(userDataPath: string, root: string, files: RecoveryPreparedFile[]) {
  const total = files.reduce((sum, file) => sum + file.before.length + file.after.length, 0);
  if (!files.length || files.length > 100 || total > RECOVERY_MAX_BYTES) {
    throw new ProjectRecoveryError(
      'RECOVERY_BATCH_LIMIT',
      'Workspace edit exceeds the recovery budget. Split the edit into smaller batches.'
    );
  }
  const parent = projectRecoveryStorePath(userDataPath, root);
  await mkdir(dirname(parent), { recursive: true, mode: 0o700 });
  await requireDirectory(dirname(parent));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await requireDirectory(parent);
  if ((await recoveryLocations(userDataPath, root)).length >= RECOVERY_MAX_RECORDS) {
    throw new ProjectRecoveryError(
      'RECOVERY_CAPACITY',
      'Recovery storage is full. Inspect and explicitly discard records before another workspace edit.'
    );
  }
  const id = randomUUID();
  const directory = join(parent, ownedName(id));
  await mkdir(directory, { mode: 0o700 });
  active.add(directory);
  try {
    const manifest: RecoveryManifest = {
      version: 1,
      id,
      createdAt: Date.now(),
      root: realpathSync(root),
      rootIdentity: recoveryIdentity(root),
      files: files.map(({ before, after, ...file }) => ({
        ...file,
        before: { size: before.length, sha256: recoveryDigest(before) },
        after: { size: after.length, sha256: recoveryDigest(after) },
      })),
    };
    if (!validManifest(manifest, id)) throw new Error('Recovery input is invalid.');
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    if (manifestBytes.length > 131072) throw new Error('Recovery manifest exceeds its size limit.');
    for (let index = 0; index < files.length; index++) {
      await validateRecoveryDirectory(directory);
      await privateFile(join(directory, `${index}.before`), files[index].before);
      await privateFile(join(directory, `${index}.after`), files[index].after);
    }
    await privateFile(join(directory, 'manifest.json'), manifestBytes);
    await syncDirectory(directory);
    await syncDirectory(parent);
    return { id, directory, manifest };
  } catch (error) {
    active.delete(directory);
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Recovery preparation failed; no target was written.');
    }
    throw error;
  }
}
