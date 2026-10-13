// Paired-device downloads of host files (GitHub #40 item 1): the contract the
// host authorization service (main/file-downloads.ts), the remote shim
// (renderer/remote-shim-api.ts), the encrypted media lane and the native save
// sinks (shared/native-file-save.ts) all build against.
//
// Policy, enforced on the HOST from its own records, never from the request:
// a device may download (a) a file inside the session's registered project,
// (b) a file an assistant reply in that session links (outside the project
// too), or (c) a generated media asset of this host's media store. Nothing
// else on the host. At most FILE_DOWNLOAD_MAX_BYTES per file.
//
// Flow: `authorize` mints a one-time grant (short redemption TTL) bound to the
// calling paired device, the session, the canonical file and its version, and
// the purpose. `begin` consumes that grant into ONE transfer lease; within the
// lease the device reads ranges (retries allowed) until `finish` or `abort`.
// Leases end on idle, on their absolute lifetime, on unpair and when the
// session is deleted. Every read is checked against the version the grant
// recorded: a file that changes on disk fails the transfer as `changed`.

/** Largest downloadable file, inclusive: exactly 256 MiB is allowed. */
export const FILE_DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024;
/** Largest raw window one `fileDownloadRange` call returns (base64 on the wire). */
export const FILE_DOWNLOAD_RANGE_MAX_BYTES = 4 * 1024 * 1024;
/** An unredeemed grant expires this long after `authorize`. */
export const FILE_DOWNLOAD_GRANT_TTL_MS = 60_000;
/** A lease with no read for this long ends. */
export const FILE_DOWNLOAD_LEASE_IDLE_MS = 2 * 60_000;
/** A lease ends this long after `begin`, however active. */
export const FILE_DOWNLOAD_LEASE_MAX_MS = 30 * 60_000;

/** What the user means to do with the bytes; recorded on the grant and lease. */
export type FileDownloadPurpose = 'save' | 'share' | 'open';
export const FILE_DOWNLOAD_PURPOSES: readonly FileDownloadPurpose[] = ['save', 'share', 'open'];

/** Which file the device asks for. The device names records, never host
 *  paths: the host resolves each kind from its own state. */
export type FileDownloadSource =
  /** A file of the session's registered project, project-relative. */
  | { kind: 'project'; sessionId: string; relPath: string }
  /** A local link inside one settled assistant row of the session: `itemId`
   *  is the transcript row id, `href` the link target exactly as the row's
   *  markdown wrote it (an absolute path, a `file:` URL, or a path relative
   *  to the session's folder; a `:line`/`#L` suffix is ignored). */
  | { kind: 'link'; sessionId: string; itemId: string; href: string }
  /** A generated media asset (its original rendition) by gallery asset id. */
  | { kind: 'media'; sessionId: string; assetId: string };

export type FileDownloadSourceKind = FileDownloadSource['kind'];

export interface FileDownloadRequest {
  source: FileDownloadSource;
  purpose: FileDownloadPurpose;
}

/** `authorize` answer: what the device may begin, and until when. */
export interface FileDownloadGrant {
  grantId: string;
  /** File name to offer the user (sanitized; never a path). */
  name: string;
  size: number;
  mime: string;
  /** Opaque file version (identity, size and modification time). Echoed by
   *  every range read; a mismatch means the file changed. */
  version: string;
  /** Epoch ms after which `begin` refuses the grant (`expired`). */
  expiresAt: number;
}

/** Media-lane form of a transfer lease (streaming hook, later scope): the
 *  host serves the lease's bytes on the encrypted media lane
 *  (shared/remote-media-crypto.ts, renderer/public/sw-media.js) as
 *  `/media/<assetId>?variant=download&sid=<sid>&enc=e2ee1`. The asset id is a
 *  fresh random UUID per lease — never the transfer id or a path — so it
 *  matches the service worker's route grammar and names nothing else. The
 *  meta frame's size/mime are the lease's; the lane reads the lease's opened
 *  file and fails the stream when the file changed. Only the device that
 *  began the lease is served, and only while the lease lives. */
export const FILE_DOWNLOAD_MEDIA_VARIANT = 'download';
export interface FileDownloadMediaLease {
  assetId: string;
  variant: typeof FILE_DOWNLOAD_MEDIA_VARIANT;
  expiresAt: number;
}

/** `begin` answer: one bounded transfer lease. */
export interface FileDownloadTransfer {
  transferId: string;
  name: string;
  size: number;
  mime: string;
  version: string;
  /** Epoch ms of the lease's absolute end. Idle leases end sooner. */
  expiresAt: number;
  /** Largest `length` a range read accepts. */
  rangeMaxBytes: number;
  /** Present only when the host streams leases on the encrypted media lane;
   *  otherwise the device reads ranges over RPC. */
  media?: FileDownloadMediaLease;
}

/** One `fileDownloadRange` answer: raw bytes as base64. */
export interface FileDownloadChunk {
  transferId: string;
  offset: number;
  /** Bytes in `data` (short only at end of file). */
  length: number;
  data: string;
  version: string;
  /** `offset + length` reached the file's size. */
  eof: boolean;
}

export interface FileDownloadFinished {
  transferId: string;
  size: number;
  version: string;
}

/** Remote method names on the encrypted RPC lane. */
export const FILE_DOWNLOAD_REMOTE_METHODS = {
  /** `[request: FileDownloadRequest]` → FileDownloadGrant */
  authorize: 'fileDownloadAuthorize',
  /** `[grantId]` → FileDownloadTransfer (consumes the grant) */
  begin: 'fileDownloadBegin',
  /** `[transferId, offset, length, version]` → FileDownloadChunk */
  range: 'fileDownloadRange',
  /** `[transferId]` → FileDownloadFinished (fails `changed` if the file moved on) */
  finish: 'fileDownloadFinish',
  /** `[transferOrGrantId]` → boolean (whether anything was released) */
  abort: 'fileDownloadAbort',
} as const;

/** Why a download was refused. The first six are the reasons a UI shows;
 *  the rest are transport/lookup outcomes. */
export type FileDownloadErrorReason =
  | 'not-linked'
  | 'outside-project'
  | 'too-large'
  | 'changed'
  | 'expired'
  | 'host-too-old'
  | 'not-found'
  | 'not-a-file'
  | 'busy'
  | 'unavailable';

export const FILE_DOWNLOAD_ERROR_REASONS: readonly FileDownloadErrorReason[] = [
  'not-linked',
  'outside-project',
  'too-large',
  'changed',
  'expired',
  'host-too-old',
  'not-found',
  'not-a-file',
  'busy',
  'unavailable',
];

const ERROR_CODE_PREFIX = 'file-download:';

/** The error `code` a refusal carries (lifted onto the remote frame as
 *  `errorCode`, restored as `error.code` by the remote shim). */
export function fileDownloadErrorCode(reason: FileDownloadErrorReason): string {
  return `${ERROR_CODE_PREFIX}${reason}`;
}

/** The reason behind an error from any download call, or null when the error
 *  is not a download refusal (argument validation, transport loss). */
export function fileDownloadErrorReason(error: unknown): FileDownloadErrorReason | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !code.startsWith(ERROR_CODE_PREFIX)) return null;
  const reason = code.slice(ERROR_CODE_PREFIX.length) as FileDownloadErrorReason;
  return FILE_DOWNLOAD_ERROR_REASONS.includes(reason) ? reason : null;
}

export class FileDownloadError extends Error {
  readonly code: string;
  readonly reason: FileDownloadErrorReason;

  constructor(reason: FileDownloadErrorReason, message: string) {
    super(message);
    this.name = 'FileDownloadError';
    this.reason = reason;
    this.code = fileDownloadErrorCode(reason);
  }
}

/** The renderer-facing download API of a remote surface
 *  (`DesktopApi.fileDownloads`). Every call rejects with `host-too-old` when
 *  the connected host did not advertise `fileDownloads`. */
export interface FileDownloadApi {
  /** The connected host serves downloads (read per call: a reconnect may
   *  reach another host). */
  available(): boolean;
  authorize(request: FileDownloadRequest): Promise<FileDownloadGrant>;
  begin(grantId: string): Promise<FileDownloadTransfer>;
  readRange(transferId: string, offset: number, length: number, version: string): Promise<FileDownloadChunk>;
  finish(transferId: string): Promise<FileDownloadFinished>;
  abort(transferOrGrantId: string): Promise<boolean>;
}
