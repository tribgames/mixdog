// Host file downloads for a paired device (GitHub #40 item 1; the wire
// contract is shared/file-downloads.ts). A paired device is the user's own,
// so it may download whatever the desktop can open: a file of the session's
// project, a path a link or the session names (relative ones under the
// session's folder), a folder as a zip, a media asset, an attachment, an
// export. Only the desktop's own project boundary applies: a project path may
// not leave its project through a symlink or junction.
//
// Files are canonicalized by real filesystem identity: realpath, regular files
// only (no directories, devices, FIFOs, network/UNC paths). Those checks name
// a resolved path, so once the file is open the open file itself must be
// shown to live at that path (opened-file-path.ts): an ancestor swapped for a
// junction between resolving and opening is refused. The file is opened ONCE
// at authorize time and that same handle serves every byte of the transfer,
// so what was authorized is what is read. Its identity, size and modification
// time form the version every read is checked against, together with its
// location.
//
// Unpair, session deletion and close bump revocation generations; an
// authorize or begin re-checks them after its filesystem work, so a
// revocation that ran meanwhile leaves no grant or lease behind.
import { createHash, randomUUID } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { type FileHandle, mkdtemp, open, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type { DesktopSessionSummary } from '../shared/contract';
import {
  FILE_DOWNLOAD_GRANT_TTL_MS,
  FILE_DOWNLOAD_LEASE_IDLE_MS,
  FILE_DOWNLOAD_LEASE_MAX_MS,
  FILE_DOWNLOAD_MAX_BYTES,
  FILE_DOWNLOAD_MEDIA_VARIANT,
  FILE_DOWNLOAD_PURPOSES,
  FILE_DOWNLOAD_RANGE_MAX_BYTES,
  FILE_DOWNLOAD_REMOTE_METHODS,
  FOLDER_ZIP_MAX_BYTES,
  FOLDER_ZIP_MAX_FILES,
  FileDownloadError,
  folderTooLargeMessage,
  type FolderLeftOut,
  type FileDownloadChunk,
  type FileDownloadFinished,
  type FileDownloadGrant,
  type FileDownloadMediaLease,
  type FileDownloadPurpose,
  type FileDownloadRequest,
  type FileDownloadSource,
  type FileDownloadTransfer,
} from '../shared/file-downloads';
import { localFileMimeTypeForPath } from '../shared/local-files';
import type { DesktopService } from './desktop-service-contract';
import { requiredSessionId } from './desktop-state';
import { requiredString, sanitizedFileName } from './ipc-validation';
import { comparablePath, insideRoot } from './opened-file-authorization';
import { openedFilePath } from './opened-file-path';
import { projectEntryPathIn } from './project-files';
import { NETWORK_PATH, requestedLinkPath, resolveLinkedPath } from './transcript-file-links';
import { FolderMovedError, FolderTooLargeError, zipFolder } from './zip-folder';
import { attachmentViewName, readSessionAttachment, requiredAttachmentId } from './session-attachments';

/** Unredeemed grants one device may hold; the oldest is dropped first. */
const MAX_GRANTS_PER_DEVICE = 8;
/** Concurrent transfers per device; more is refused as `busy`. */
const MAX_LEASES_PER_DEVICE = 4;
const SWEEP_INTERVAL_MS = 15_000;
// O_NONBLOCK keeps a FIFO swapped in after the type check from blocking the
// open; O_NOFOLLOW refuses a final component swapped to a symlink. Neither
// exists on Windows, where the identity check after opening covers both.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** Test seams: `afterResolve` runs between resolving a path and opening it,
 *  `opened` with every handle as soon as it is open. */
export const fileDownloadTestHooks: {
  afterResolve?: (canonical: string) => Promise<void> | void;
  opened?: (handle: FileHandle) => void;
} = {};

export interface FileDownloadRequester {
  /** The paired device (relay credential) asking; a per-connection id when the
   *  relay did not name the credential. Taken from the connection, never from
   *  a request field. */
  deviceId: string;
}

export type FileDownloadHost = Pick<
  DesktopService,
  'listSessions' | 'projectDirectory' | 'invokeCapability' | 'readSessionTranscript' | 'readAttachmentImage'
>;

/** Streaming hook for the encrypted media lane (remote-relay-media.ts, later
 *  scope): the lane resolves a `/media/<assetId>?variant=download` request to
 *  the live lease it was minted for, and reads through the lease's own opened
 *  file. A null answer is a 404. */
export interface FileDownloadMediaTarget {
  size: number;
  mime: string;
  version: string;
  /** Exactly `length` bytes at `offset`; rejects `changed` when the file
   *  differs from the leased version and `expired` once the lease ended.
   *  Counts as lease activity. */
  read(offset: number, length: number): Promise<Buffer>;
}

export interface FileDownloadMediaSource {
  /** `deviceId` is the device the requesting media session belongs to. */
  resolveMedia(assetId: string, variant: string, deviceId: string): FileDownloadMediaTarget | null;
}

export interface FileDownloadService extends FileDownloadMediaSource {
  authorize(requester: FileDownloadRequester, request: FileDownloadRequest): Promise<FileDownloadGrant>;
  /** Consumes the grant (one-time) into one transfer lease. */
  begin(requester: FileDownloadRequester, grantId: string): Promise<FileDownloadTransfer>;
  readRange(
    requester: FileDownloadRequester,
    transferId: string,
    offset: number,
    length: number,
    version: string
  ): Promise<FileDownloadChunk>;
  finish(requester: FileDownloadRequester, transferId: string): Promise<FileDownloadFinished>;
  /** Releases a lease or an unredeemed grant of this device. */
  abort(requester: FileDownloadRequester, id: string): Promise<boolean>;
  /** A visualize export rendered for `requester` (a file in its own
   *  `mixdog-visualize-export-*` temp folder): the download source only that
   *  device may authorize, for a while. The folder is removed once the export
   *  expires and nothing holds it, or when the device or everything is revoked. */
  registerExport(
    requester: FileDownloadRequester,
    file: { sessionId: string; path: string; mime: string; pages?: { included: number; total: number } }
  ): Promise<{ source: { kind: 'export'; sessionId: string; exportId: string }; name: string }>;
  /** The host's current session catalog: every grant and lease of a session
   *  that left it (deleted) ends. */
  retainSessions(sessionIds: Iterable<string>): void;
  /** A session this service saw in a catalog that the latest one lacks. */
  sessionRemoved(sessionId: string): boolean;
  /** Unpair: everything the device holds ends. */
  revokeDevice(deviceId: string): void;
  /** Relay closed or this host unpaired every device. */
  revokeAll(): void;
}

export interface FileDownloadServiceOptions {
  host: FileDownloadHost;
  /** Mint media-lane leases on `begin`. Off until the media lane serves them. */
  mediaLane?: boolean;
  now?: () => number;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

interface OpenedFile {
  handle: FileHandle;
  /** The canonical path every check ran on; the open file must live there. */
  location: string;
  identity: FileIdentity;
  inflight: number;
  released: boolean;
  closed: boolean;
}

interface Authorized {
  deviceId: string;
  sessionId: string;
  purpose: FileDownloadPurpose;
  file: OpenedFile;
  name: string;
  mime: string;
  size: number;
  version: string;
  /** A folder zip only: what it left out. */
  leftOut?: FolderLeftOut;
}

interface Grant extends Authorized {
  grantId: string;
  expiresAt: number;
}

interface Lease extends Authorized {
  transferId: string;
  expiresAt: number;
  idleUntil: number;
  media?: FileDownloadMediaLease;
}

const identityOf = (info: BigIntStats): FileIdentity => ({
  dev: info.dev,
  ino: info.ino,
  size: info.size,
  mtimeNs: info.mtimeNs,
});

const sameFile = (left: FileIdentity, right: FileIdentity): boolean => left.dev === right.dev && left.ino === right.ino;

const sameVersion = (left: FileIdentity, right: FileIdentity): boolean =>
  sameFile(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs;

function versionOf(identity: FileIdentity): string {
  return createHash('sha256')
    .update(`${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeNs}`)
    .digest('base64url');
}

const changed = (): FileDownloadError => new FileDownloadError('changed', 'The file changed on the host.');
const expired = (): FileDownloadError => new FileDownloadError('expired', 'This download is no longer available.');
const tooLarge = (): FileDownloadError =>
  new FileDownloadError('too-large', 'Files larger than 256 MB cannot be downloaded.');
const notLocal = (): FileDownloadError =>
  new FileDownloadError('not-a-file', 'Only files on this PC can be downloaded.');

function missing(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new FileDownloadError('not-found', 'The file no longer exists.');
  throw error;
}

function closeWhenIdle(file: OpenedFile): void {
  if (!file.released || file.inflight > 0 || file.closed) return;
  file.closed = true;
  void file.handle.close().catch(() => undefined);
}

function release(file: OpenedFile): void {
  file.released = true;
  closeWhenIdle(file);
}

/** Rejects `changed` unless the open file itself lives at its `location`. */
async function verifyLocation(file: OpenedFile): Promise<void> {
  const at = await openedFilePath(file.handle, file.location, file.identity).catch(() => null);
  if (at === null || comparablePath(at) !== comparablePath(file.location)) throw changed();
}

/** Opens a regular file by its canonical path and proves, from the open file,
 *  that it is the file at that path: every check the caller makes on
 *  `canonical` then holds for the bytes the handle reads. */
async function openRegularFile(path: string): Promise<{ canonical: string; file: OpenedFile }> {
  if (NETWORK_PATH.test(path)) throw notLocal();
  const canonical = await realpath(path).catch(missing);
  if (NETWORK_PATH.test(canonical)) throw notLocal();
  if (!(await stat(canonical).catch(missing)).isFile()) throw notLocal();
  await fileDownloadTestHooks.afterResolve?.(canonical);
  const handle = await open(canonical, OPEN_FLAGS).catch(missing);
  fileDownloadTestHooks.opened?.(handle);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw notLocal();
    const file = {
      handle,
      location: canonical,
      identity: identityOf(info),
      inflight: 0,
      released: false,
      closed: false,
    };
    await verifyLocation(file);
    if (info.size > BigInt(FILE_DOWNLOAD_MAX_BYTES)) throw tooLarge();
    return { canonical, file };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** Rejects `changed` once the opened file differs from its authorized version
 *  or no longer lives where it was authorized. */
async function verifyUnchanged(file: OpenedFile): Promise<void> {
  if (!sameVersion(identityOf(await file.handle.stat({ bigint: true })), file.identity)) throw changed();
  await verifyLocation(file);
}

async function readExact(file: OpenedFile, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await file.handle.read(buffer, filled, length - filled, offset + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  if (filled !== length) throw changed();
  return buffer;
}

async function sessionRow(host: FileDownloadHost, sessionId: string): Promise<DesktopSessionSummary> {
  const row = (await host.listSessions()).find((entry) => entry.id === sessionId);
  if (!row) throw new FileDownloadError('unavailable', 'This conversation is not available.');
  return row;
}

/** The session's registered project, canonical; null for a task session or a
 *  project that is no longer registered. */
async function projectRoot(host: FileDownloadHost, row: DesktopSessionSummary): Promise<string | null> {
  if (row.classification !== 'project' || !row.projectPath) return null;
  return host.projectDirectory(row.projectPath).catch(() => null);
}

/** Closes `file` when `check` throws, then rethrows. */
async function guarded<T>(file: OpenedFile, check: () => Promise<T> | T): Promise<T> {
  try {
    return await check();
  } catch (error) {
    release(file);
    throw error;
  }
}

async function authorizeProjectFile(
  host: FileDownloadHost,
  row: DesktopSessionSummary,
  relPath: string
): Promise<{ file: OpenedFile; name: string; mime: string }> {
  const outside = (): FileDownloadError =>
    new FileDownloadError('outside-project', "The file is outside the conversation's project.");
  const root = await projectRoot(host, row);
  if (!root) throw outside();
  let lexical: string;
  try {
    lexical = projectEntryPathIn(root, relPath);
  } catch {
    throw outside();
  }
  const { canonical, file } = await openRegularFile(lexical);
  return guarded(file, async () => {
    if (!insideRoot(root, canonical)) throw outside();
    const name = basename(lexical);
    return { file, name, mime: localFileMimeTypeForPath(name) };
  });
}

/** The host path a request names (absolute, or relative to the session's
 *  folder); a path that names nothing on this PC (a web link, a network
 *  share, a relative path with no session folder) is refused. */
function requestedPath(path: string | null): string {
  if (!path) throw notLocal();
  return path;
}

/** A file a link in the session names, decoded the way the device decodes
 *  it (`:line`/`#L` dropped). */
function authorizeLinkedFile(
  host: FileDownloadHost,
  row: DesktopSessionSummary,
  href: string
): Promise<{ file: OpenedFile; name: string; mime: string }> {
  return openSessionPath(host, row, requestedPath(requestedLinkPath(href, row.cwd)));
}

/** A file the session shows, named by the path the device saw. */
function authorizeSessionFile(
  host: FileDownloadHost,
  row: DesktopSessionSummary,
  path: string
): Promise<{ file: OpenedFile; name: string; mime: string }> {
  return openSessionPath(host, row, requestedPath(resolveLinkedPath(path, row.cwd)));
}

/** Opens `requested` (a host path the session names) as a download: inside
 *  the session's project it may not leave it through a link. */
async function openSessionPath(
  host: FileDownloadHost,
  row: DesktopSessionSummary,
  requested: string
): Promise<{ file: OpenedFile; name: string; mime: string }> {
  const root = await projectRoot(host, row);
  const lexicalInProject =
    root !== null && (insideRoot(root, requested) || insideRoot(resolve(String(row.projectPath)), requested));
  const { canonical, file } = await openRegularFile(requested);
  return guarded(file, async () => {
    // A project path may not leave the project through a symlink/junction.
    if (lexicalInProject && !(root !== null && insideRoot(root, canonical))) {
      throw new FileDownloadError('outside-project', "The link resolves outside the conversation's project.");
    }
    const name = basename(requested);
    return { file, name, mime: localFileMimeTypeForPath(name) };
  });
}

/** A media asset by its id. */
async function authorizeMediaAsset(
  host: FileDownloadHost,
  assetId: string
): Promise<{ file: OpenedFile; name: string; mime: string }> {
  const result = await host.invokeCapability('resolveMediaFile', [assetId, { variant: 'original', generate: false }]);
  const media = (result as { value?: unknown } | null)?.value as {
    path?: unknown;
    mime?: unknown;
    available?: unknown;
  } | null;
  if (!media || media.available === false || typeof media.path !== 'string' || !isAbsolute(media.path)) {
    throw new FileDownloadError('not-found', 'This media file is not available.');
  }
  const { canonical, file } = await openRegularFile(media.path);
  const name = basename(media.path);
  const mime = typeof media.mime === 'string' && media.mime ? media.mime : localFileMimeTypeForPath(canonical);
  return { file, name, mime };
}

/** A visualize export's temp folder (main's `exportForDevice`): the only
 *  folder `registerExport` accepts, and removes once the export ends. */
const EXPORT_FOLDER = /^mixdog-visualize-export-[A-Za-z0-9]+$/;
/** How long a device may (re)start the download of one export. */
const EXPORT_TTL_MS = 10 * 60_000;
const MAX_EXPORTS_PER_DEVICE = 8;

interface ExportRecord {
  exportId: string;
  deviceId: string;
  sessionId: string;
  /** Canonical file; its folder is the export's own temp folder. */
  path: string;
  name: string;
  mime: string;
  expiresAt: number;
  /** A long document's PNG stacks only its first pages: the download says so. */
  pages?: { included: number; total: number };
  /** Set while the service is still writing and opening the record's file. */
  staging?: boolean;
}

type AuthorizedSource = { file: OpenedFile; name: string; mime: string; leftOut?: FolderLeftOut };

/** Revocation generations and the host's session catalog: what an authorize
 *  or begin re-checks after its awaited work. */
function createRevocations() {
  const seenSessions = new Set<string>();
  let catalog: Set<string> | null = null;
  // Revocation generations. Each only grows, so their sum for a device and
  // session changes exactly when anything revoked either one, or everything.
  let globalGeneration = 0;
  const deviceGenerations = new Map<string, number>();
  const sessionGenerations = new Map<string, number>();
  const generation = (deviceId: string, sessionId: string): number =>
    globalGeneration + (deviceGenerations.get(deviceId) ?? 0) + (sessionGenerations.get(sessionId) ?? 0);
  const bump = (generations: Map<string, number>, key: string): void => {
    generations.set(key, (generations.get(key) ?? 0) + 1);
  };
  const sessionRemoved = (sessionId: string): boolean =>
    catalog !== null && seenSessions.has(sessionId) && !catalog.has(sessionId);
  /** After awaited work: rejects, releasing `file`, when the session is gone
   *  or anything revoked the device or session since `mark`. */
  const stillAuthorized = (deviceId: string, sessionId: string, mark: number, file: OpenedFile): void => {
    if (sessionRemoved(sessionId)) {
      release(file);
      throw new FileDownloadError('unavailable', 'This conversation is not available.');
    }
    if (generation(deviceId, sessionId) !== mark) {
      release(file);
      throw expired();
    }
  };
  return {
    generation,
    sessionRemoved,
    stillAuthorized,
    /** The host's current catalog: a session that left it is revoked. */
    retainCatalog(sessionIds: Iterable<string>): void {
      const next = new Set(sessionIds);
      for (const id of catalog ?? []) if (!next.has(id)) bump(sessionGenerations, id);
      catalog = next;
      for (const id of catalog) seenSessions.add(id);
    },
    revokeDevice(deviceId: string): void {
      bump(deviceGenerations, deviceId);
    },
    revokeAll(): void {
      globalGeneration += 1;
    },
  };
}

/** The grants, leases and temp records a service holds, and the sweeper that
 *  ends them once expired, even when no device calls again. */
function createDownloadTables(now: () => number) {
  const grants = new Map<string, Grant>();
  const leases = new Map<string, Lease>();
  const exportRecords = new Map<string, ExportRecord>();
  const mediaLeases = new Map<string, string>();
  let sweeper: NodeJS.Timeout | null = null;

  const dropGrant = (grant: Grant): void => {
    if (grants.get(grant.grantId) === grant) grants.delete(grant.grantId);
    release(grant.file);
  };
  const dropLease = (lease: Lease): void => {
    if (leases.get(lease.transferId) === lease) leases.delete(lease.transferId);
    if (lease.media) mediaLeases.delete(lease.media.assetId);
    release(lease.file);
  };
  /** Forgets an export and removes its temp folder (best effort: a handle
   *  still closing on Windows is retried by `rm`). */
  const dropExport = (record: ExportRecord): void => {
    if (exportRecords.get(record.exportId) === record) exportRecords.delete(record.exportId);
    void rm(dirname(record.path), { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  };
  const readsRecord = (entry: Authorized, record: ExportRecord): boolean =>
    !entry.file.released && comparablePath(entry.file.location) === comparablePath(record.path);
  /** An export some grant or lease still reads (or one still being staged). */
  const exportHeld = (record: ExportRecord): boolean =>
    record.staging === true || [...grants.values(), ...leases.values()].some((entry) => readsRecord(entry, record));
  /** Keeps a device within MAX_EXPORTS_PER_DEVICE records once one more is
   *  added: the oldest go first, with the unredeemed grants reading them. A
   *  record being staged or read by a live transfer is never dropped, so no
   *  download in flight breaks. */
  const makeRoomForRecord = (deviceId: string): void => {
    const held = [...exportRecords.values()].filter((entry) => entry.deviceId === deviceId);
    let excess = held.length - MAX_EXPORTS_PER_DEVICE + 1;
    for (const stale of held) {
      if (excess <= 0) break;
      if (stale.staging || [...leases.values()].some((lease) => readsRecord(lease, stale))) continue;
      for (const grant of [...grants.values()]) if (readsRecord(grant, stale)) dropGrant(grant);
      dropExport(stale);
      excess -= 1;
    }
  };
  const stopSweeperWhenIdle = (): void => {
    if (sweeper && !grants.size && !leases.size && !exportRecords.size) {
      clearInterval(sweeper);
      sweeper = null;
    }
  };
  const sweep = (): void => {
    const at = now();
    for (const grant of [...grants.values()]) if (grant.expiresAt <= at) dropGrant(grant);
    for (const lease of [...leases.values()]) if (lease.expiresAt <= at || lease.idleUntil <= at) dropLease(lease);
    for (const record of [...exportRecords.values()])
      if (record.expiresAt <= at && !exportHeld(record)) dropExport(record);
    stopSweeperWhenIdle();
  };
  // Expired handles close even when no device calls again.
  const ensureSweeper = (): void => {
    if (sweeper) return;
    sweeper = setInterval(sweep, SWEEP_INTERVAL_MS);
    sweeper.unref?.();
  };
  const owned = <T extends { deviceId: string }>(entry: T | undefined, deviceId: string): T | undefined =>
    entry && entry.deviceId === deviceId ? entry : undefined;

  return {
    sweep,
    stopSweeperWhenIdle,
    dropGrant,
    dropLease,
    dropExport,
    grantOf: (deviceId: string, grantId: string): Grant | undefined => owned(grants.get(grantId), deviceId),
    leaseOf: (deviceId: string, transferId: string): Lease | undefined => owned(leases.get(transferId), deviceId),
    /** The lease a media-lane asset id was minted for. */
    mediaLease: (assetId: string): Lease | undefined => leases.get(mediaLeases.get(assetId) ?? ''),
    isLive: (lease: Lease): boolean => leases.get(lease.transferId) === lease,
    exportRecord: (exportId: string): ExportRecord | undefined => exportRecords.get(exportId),
    deviceLeaseCount: (deviceId: string): number =>
      [...leases.values()].filter((lease) => lease.deviceId === deviceId).length,
    /** One-time: out of the grant table, revocation can no longer reach it. */
    consumeGrant(grant: Grant): void {
      grants.delete(grant.grantId);
    },
    /** Adds a grant; the device's oldest go first past MAX_GRANTS_PER_DEVICE. */
    addGrant(grant: Grant): void {
      const held = [...grants.values()].filter((entry) => entry.deviceId === grant.deviceId);
      for (const stale of held.slice(0, Math.max(0, held.length - MAX_GRANTS_PER_DEVICE + 1))) dropGrant(stale);
      grants.set(grant.grantId, grant);
      ensureSweeper();
    },
    addLease(lease: Lease): void {
      if (lease.media) mediaLeases.set(lease.media.assetId, lease.transferId);
      leases.set(lease.transferId, lease);
      ensureSweeper();
    },
    /** Adds an export or staged temp record, making room for it first. */
    addRecord(record: ExportRecord): void {
      makeRoomForRecord(record.deviceId);
      exportRecords.set(record.exportId, record);
      ensureSweeper();
    },
    /** Ends every grant, lease and record `match` names. */
    dropMatching(match: (entry: { deviceId: string; sessionId: string }) => boolean): void {
      for (const grant of [...grants.values()]) if (match(grant)) dropGrant(grant);
      for (const lease of [...leases.values()]) if (match(lease)) dropLease(lease);
      for (const record of [...exportRecords.values()]) if (match(record)) dropExport(record);
      stopSweeperWhenIdle();
    },
  };
}

type DownloadTables = ReturnType<typeof createDownloadTables>;

/** Serving a lease's bytes: the lease a device names, and reads through its
 *  own opened file. */
function createLeaseReader(tables: DownloadTables, now: () => number) {
  const liveLease = (requester: FileDownloadRequester, transferId: string): Lease => {
    tables.sweep();
    const lease = tables.leaseOf(requester.deviceId, transferId);
    if (!lease) throw expired();
    return lease;
  };
  const readLease = async (lease: Lease, offset: number, length: number): Promise<Buffer> => {
    if (offset + length > lease.size) throw new TypeError('The range is past the end of the file.');
    lease.file.inflight += 1;
    try {
      if (lease.file.released) throw expired();
      await verifyUnchanged(lease.file);
      const bytes = length ? await readExact(lease.file, offset, length) : Buffer.alloc(0);
      // Revoked while reading: nothing more leaves the lease.
      if (lease.file.released) throw expired();
      lease.idleUntil = now() + FILE_DOWNLOAD_LEASE_IDLE_MS;
      return bytes;
    } catch (error) {
      if (error instanceof FileDownloadError && error.reason === 'changed') tables.dropLease(lease);
      throw error;
    } finally {
      lease.file.inflight -= 1;
      closeWhenIdle(lease.file);
    }
  };
  return { liveLease, readLease };
}

/** Opens what a download source names as the file a grant reads. */
function createSourceAuthorizer(host: FileDownloadHost, now: () => number, tables: DownloadTables) {
  /** A folder the session names (absolute, or relative to its folder),
   *  zipped into the service's own temp record (removed like an export once
   *  nothing holds it) and opened as the download. */
  const authorizeFolderZip = async (
    requester: FileDownloadRequester,
    row: DesktopSessionSummary,
    path: string
  ): Promise<{ file: OpenedFile; name: string; mime: string; leftOut: FolderLeftOut }> => {
    const requested = requestedPath(resolveLinkedPath(path, row.cwd));
    if (!(await stat(requested).catch(missing)).isDirectory()) {
      throw new FileDownloadError('not-a-file', 'Only a folder can be downloaded as a zip.');
    }
    const canonical = await realpath(requested).catch(missing);
    if (NETWORK_PATH.test(canonical)) {
      throw new FileDownloadError('not-a-file', 'Only folders on this PC can be downloaded.');
    }
    // Same rule as openSessionPath: inside the project the canonical path may
    // not leave it.
    const root = await projectRoot(host, row);
    const lexicalInProject =
      root !== null && (insideRoot(root, requested) || insideRoot(resolve(String(row.projectPath)), requested));
    if (lexicalInProject && !(root !== null && insideRoot(root, canonical))) {
      throw new FileDownloadError('outside-project', "The link resolves outside the conversation's project.");
    }
    let zipped: Awaited<ReturnType<typeof zipFolder>>;
    try {
      zipped = await zipFolder(canonical, { maxBytes: FOLDER_ZIP_MAX_BYTES, maxFiles: FOLDER_ZIP_MAX_FILES });
    } catch (error) {
      if (error instanceof FolderMovedError) throw changed();
      if (error instanceof FolderTooLargeError) {
        throw new FileDownloadError('folder-too-large', folderTooLargeMessage(error.files, error.bytes));
      }
      throw error;
    }
    const staged = await stageTemporaryDownload(
      requester,
      row,
      `${basename(canonical) || 'folder'}.zip`,
      'application/zip',
      zipped.archive
    );
    return { ...staged, leftOut: { ignored: zipped.ignored, secret: 0 } };
  };

  /** Bytes the host built (a folder's zip, an attachment from the store) as a
   *  file in the service's own temp record: opened as the download, removed
   *  like an export once nothing holds it. */
  const stageTemporaryDownload = async (
    requester: FileDownloadRequester,
    row: DesktopSessionSummary,
    name: string,
    mime: string,
    bytes: Buffer
  ): Promise<{ file: OpenedFile; name: string; mime: string }> => {
    const folder = await realpath(await mkdtemp(join(tmpdir(), 'mixdog-download-')));
    const path = join(folder, 'payload');
    const record: ExportRecord = {
      exportId: randomUUID(),
      deviceId: requester.deviceId,
      sessionId: row.id,
      path,
      name,
      mime,
      expiresAt: now() + EXPORT_TTL_MS,
      staging: true,
    };
    tables.addRecord(record);
    try {
      await writeFile(path, bytes, { mode: 0o600 });
      const opened = await openRegularFile(path);
      return { file: opened.file, name, mime };
    } catch (error) {
      tables.dropExport(record);
      throw error;
    } finally {
      record.staging = false;
    }
  };

  /** An attachment of the session's messages, read from the content-addressed
   *  store by an id this session's transcript names. */
  const authorizeAttachment = async (
    requester: FileDownloadRequester,
    row: DesktopSessionSummary,
    attachmentId: string
  ): Promise<{ file: OpenedFile; name: string; mime: string }> => {
    const { meta, bytes } = await readSessionAttachment(host, row.id, attachmentId);
    if (bytes.length > FILE_DOWNLOAD_MAX_BYTES) throw tooLarge();
    return stageTemporaryDownload(requester, row, attachmentViewName(meta), meta.mimeType, bytes);
  };

  /** A visualize export this device registered (`registerExport`), still the
   *  file at its recorded path. */
  const authorizeExport = async (
    requester: FileDownloadRequester,
    row: DesktopSessionSummary,
    exportId: string
  ): Promise<AuthorizedSource> => {
    const record = tables.exportRecord(exportId);
    if (!record || record.deviceId !== requester.deviceId || record.sessionId !== row.id) throw expired();
    // A record kept alive only by a grant or lease must not be renewed past its deadline.
    if (record.expiresAt <= now()) throw expired();
    const { canonical, file } = await openRegularFile(record.path);
    if (comparablePath(canonical) !== comparablePath(record.path)) {
      release(file);
      throw changed();
    }
    return {
      file,
      name: record.name,
      mime: record.mime,
      ...(record.pages ? { leftOut: { ignored: 0, secret: 0, pages: record.pages } } : {}),
    };
  };

  const authorizeSource = (
    requester: FileDownloadRequester,
    row: DesktopSessionSummary,
    source: FileDownloadSource
  ): Promise<AuthorizedSource> => {
    switch (source.kind) {
      case 'project':
        return authorizeProjectFile(host, row, source.relPath);
      case 'link':
        return authorizeLinkedFile(host, row, source.href);
      case 'session':
        return authorizeSessionFile(host, row, source.path);
      case 'media':
        return authorizeMediaAsset(host, source.assetId);
      case 'folder':
        return authorizeFolderZip(requester, row, source.path);
      case 'attachment':
        return authorizeAttachment(requester, row, source.attachmentId);
      case 'export':
        return authorizeExport(requester, row, source.exportId);
    }
  };
  return authorizeSource;
}

export function createFileDownloadService({
  host,
  mediaLane = false,
  now = Date.now,
}: FileDownloadServiceOptions): FileDownloadService {
  const revocations = createRevocations();
  const tables = createDownloadTables(now);
  const { liveLease, readLease } = createLeaseReader(tables, now);
  const authorizeSource = createSourceAuthorizer(host, now, tables);

  return {
    async authorize(requester, request) {
      tables.sweep();
      const { sessionId } = request.source;
      const mark = revocations.generation(requester.deviceId, sessionId);
      const row = await sessionRow(host, sessionId);
      const authorized = await authorizeSource(requester, row, request.source);
      revocations.stillAuthorized(requester.deviceId, sessionId, mark, authorized.file);
      const size = Number(authorized.file.identity.size);
      const grant: Grant = {
        ...authorized,
        name: sanitizedFileName(authorized.name),
        deviceId: requester.deviceId,
        sessionId,
        purpose: request.purpose,
        size,
        version: versionOf(authorized.file.identity),
        grantId: randomUUID(),
        expiresAt: now() + FILE_DOWNLOAD_GRANT_TTL_MS,
      };
      tables.addGrant(grant);
      const { grantId, name, mime, version, expiresAt, leftOut } = grant;
      return { grantId, name, size, mime, version, expiresAt, ...(leftOut ? { leftOut } : {}) };
    },

    async begin(requester, grantId) {
      tables.sweep();
      const grant = tables.grantOf(requester.deviceId, grantId);
      if (!grant) throw expired();
      // One-time: consumed before anything can interleave.
      tables.consumeGrant(grant);
      // Out of the grant table, revocation can no longer reach it.
      const mark = revocations.generation(grant.deviceId, grant.sessionId);
      await guarded(grant.file, () => verifyUnchanged(grant.file));
      revocations.stillAuthorized(grant.deviceId, grant.sessionId, mark, grant.file);
      if (tables.deviceLeaseCount(requester.deviceId) >= MAX_LEASES_PER_DEVICE) {
        release(grant.file);
        throw new FileDownloadError('busy', 'Too many downloads are in progress on this device.');
      }
      const at = now();
      const lease: Lease = {
        deviceId: grant.deviceId,
        sessionId: grant.sessionId,
        purpose: grant.purpose,
        file: grant.file,
        name: grant.name,
        mime: grant.mime,
        size: grant.size,
        version: grant.version,
        transferId: randomUUID(),
        expiresAt: at + FILE_DOWNLOAD_LEASE_MAX_MS,
        idleUntil: at + FILE_DOWNLOAD_LEASE_IDLE_MS,
      };
      if (mediaLane) {
        lease.media = { assetId: randomUUID(), variant: FILE_DOWNLOAD_MEDIA_VARIANT, expiresAt: lease.expiresAt };
      }
      tables.addLease(lease);
      return {
        transferId: lease.transferId,
        name: lease.name,
        size: lease.size,
        mime: lease.mime,
        version: lease.version,
        expiresAt: lease.expiresAt,
        rangeMaxBytes: FILE_DOWNLOAD_RANGE_MAX_BYTES,
        ...(lease.media ? { media: lease.media } : {}),
      };
    },

    async readRange(requester, transferId, offset, length, version) {
      const lease = liveLease(requester, transferId);
      if (version !== lease.version) throw changed();
      if (offset > lease.size) throw new TypeError('offset is past the end of the file.');
      const count = Math.min(length, lease.size - offset);
      const bytes = await readLease(lease, offset, count);
      return {
        transferId,
        offset,
        length: count,
        data: bytes.toString('base64'),
        version: lease.version,
        eof: offset + count >= lease.size,
      };
    },

    async finish(requester, transferId) {
      const lease = liveLease(requester, transferId);
      // The lease ends either way; a changed file fails the sink's commit.
      lease.file.inflight += 1;
      try {
        await verifyUnchanged(lease.file);
      } finally {
        lease.file.inflight -= 1;
        tables.dropLease(lease);
      }
      return { transferId, size: lease.size, version: lease.version };
    },

    async abort(requester, id) {
      tables.sweep();
      const lease = tables.leaseOf(requester.deviceId, id);
      if (lease) {
        tables.dropLease(lease);
        tables.stopSweeperWhenIdle();
        return true;
      }
      const grant = tables.grantOf(requester.deviceId, id);
      if (grant) {
        tables.dropGrant(grant);
        tables.stopSweeperWhenIdle();
        return true;
      }
      return false;
    },

    retainSessions(sessionIds) {
      revocations.retainCatalog(sessionIds);
      tables.dropMatching((entry) => revocations.sessionRemoved(entry.sessionId));
    },

    sessionRemoved: revocations.sessionRemoved,

    revokeDevice(deviceId) {
      revocations.revokeDevice(deviceId);
      tables.dropMatching((entry) => entry.deviceId === deviceId);
    },

    revokeAll() {
      revocations.revokeAll();
      tables.dropMatching(() => true);
    },

    async registerExport(requester, { sessionId, path, mime, pages }) {
      tables.sweep();
      const canonical = await realpath(path).catch(missing);
      if (!EXPORT_FOLDER.test(basename(dirname(canonical)))) {
        throw new FileDownloadError('not-a-file', 'Only a visualize export can be offered this way.');
      }
      const record: ExportRecord = {
        exportId: randomUUID(),
        deviceId: requester.deviceId,
        sessionId: requiredSessionId(sessionId),
        path: canonical,
        name: sanitizedFileName(basename(canonical)),
        mime,
        expiresAt: now() + EXPORT_TTL_MS,
        ...(pages ? { pages } : {}),
      };
      tables.addRecord(record);
      return { source: { kind: 'export', sessionId: record.sessionId, exportId: record.exportId }, name: record.name };
    },

    resolveMedia(assetId, variant, deviceId) {
      if (variant !== FILE_DOWNLOAD_MEDIA_VARIANT) return null;
      tables.sweep();
      const lease = tables.mediaLease(assetId);
      if (!lease || lease.deviceId !== deviceId) return null;
      return {
        size: lease.size,
        mime: lease.mime,
        version: lease.version,
        read: (offset, length) => {
          if (!tables.isLive(lease)) return Promise.reject(expired());
          return readLease(lease, offset, length);
        },
      };
    },
  };
}

// ── Remote method arguments (ipc-validation.ts grammar) ─────────────────────

const DOWNLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOWNLOAD_VERSION = /^[A-Za-z0-9_-]{43}$/;
const MEDIA_ASSET_ID = /^[A-Za-z0-9_-]{1,128}$/;

function plainRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} is invalid.`);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, name: string, maximum: number): string {
  const text = requiredString(value, name, maximum);
  if (text.includes('\0')) throw new TypeError(`${name} is invalid.`);
  return text;
}

export function requiredFileDownloadRequest(value: unknown): FileDownloadRequest {
  const request = plainRecord(value, 'download request');
  const source = plainRecord(request.source, 'download source');
  const purpose = request.purpose as FileDownloadPurpose;
  if (!FILE_DOWNLOAD_PURPOSES.includes(purpose)) throw new TypeError('download purpose is invalid.');
  const sessionId = requiredSessionId(source.sessionId);
  if (source.kind === 'project') {
    const relPath = requiredText(source.relPath, 'relPath', 4_096);
    if (isAbsolute(relPath)) throw new TypeError('relPath must be project-relative.');
    return { source: { kind: 'project', sessionId, relPath }, purpose };
  }
  if (source.kind === 'link') {
    return {
      source: {
        kind: 'link',
        sessionId,
        itemId: requiredText(source.itemId, 'item id', 256),
        href: requiredText(source.href, 'href', 4_096),
      },
      purpose,
    };
  }
  if (source.kind === 'attachment') {
    return {
      source: { kind: 'attachment', sessionId, attachmentId: requiredAttachmentId(source.attachmentId) },
      purpose,
    };
  }
  if (source.kind === 'session' || source.kind === 'folder') {
    const path = requiredText(source.path, 'path', 4_096);
    return { source: { kind: source.kind, sessionId, path }, purpose };
  }
  if (source.kind === 'media') {
    const assetId = requiredText(source.assetId, 'asset id', 128);
    if (!MEDIA_ASSET_ID.test(assetId)) throw new TypeError('asset id is invalid.');
    return { source: { kind: 'media', sessionId, assetId }, purpose };
  }
  if (source.kind === 'export') {
    return {
      source: { kind: 'export', sessionId, exportId: requiredFileDownloadId(source.exportId, 'export id') },
      purpose,
    };
  }
  throw new TypeError('download source is invalid.');
}

function requiredFileDownloadId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !DOWNLOAD_ID.test(value)) throw new TypeError(`${name} is invalid.`);
  return value;
}

function requiredFileDownloadVersion(value: unknown): string {
  if (typeof value !== 'string' || !DOWNLOAD_VERSION.test(value)) throw new TypeError('version is invalid.');
  return value;
}

function requiredFileDownloadRange(offset: unknown, length: unknown): { offset: number; length: number } {
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > FILE_DOWNLOAD_MAX_BYTES) {
    throw new TypeError('offset is invalid.');
  }
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > FILE_DOWNLOAD_RANGE_MAX_BYTES
  ) {
    throw new TypeError('length is invalid.');
  }
  return { offset, length };
}

/** The download lane of one remote connection's method table. `requester`
 *  names the connection's paired device. */
export function fileDownloadRemoteMethods(
  service: FileDownloadService,
  requester: () => FileDownloadRequester
): Record<string, (params: unknown[]) => unknown> {
  const names = FILE_DOWNLOAD_REMOTE_METHODS;
  return {
    [names.authorize]: async ([request]) => {
      const valid = requiredFileDownloadRequest(request);
      return service.authorize(requester(), valid);
    },
    [names.begin]: async ([grantId]) => {
      const id = requiredFileDownloadId(grantId, 'grant id');
      return service.begin(requester(), id);
    },
    [names.range]: async ([transferId, offset, length, version]) => {
      const id = requiredFileDownloadId(transferId, 'transfer id');
      const window = requiredFileDownloadRange(offset, length);
      const expected = requiredFileDownloadVersion(version);
      return service.readRange(requester(), id, window.offset, window.length, expected);
    },
    [names.finish]: async ([transferId]) => {
      const id = requiredFileDownloadId(transferId, 'transfer id');
      return service.finish(requester(), id);
    },
    [names.abort]: async ([id]) => {
      const valid = requiredFileDownloadId(id, 'download id');
      return service.abort(requester(), valid);
    },
  };
}
