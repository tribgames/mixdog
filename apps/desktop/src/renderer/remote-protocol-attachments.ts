// The phone's attachment and local-file calls (list 1 unit D), answered over the protocol as Node's relay answered them (b6f10295a:
// remote-methods.ts `localFileRemoteMethods` :1040-1051 and `resolveLocalPathEntries` :595-660, `projectRecovery` :818-824,
// remote-session-methods.ts `readAttachmentThumbnail` :58-64 over attachment-thumbnail.ts, remote-attachments.ts `attachmentOpen`):
// the same answers and the same failures with the error's `code` (the files adapter's `failure`). The replay compares them with the
// recording (benchmarks/rust-core/recorders/record-phone-attachments.mjs).
import { requiredProjectRecoveryRequest } from '../shared/project-recovery';
import { requiredString } from '../shared/remote-arguments';
import { rpc } from './remote-protocol-files';
import type { PhoneProtocolAdapter, PhoneProtocolHost } from './remote-shim-protocol';

/** `LOCAL_PATH_CONCURRENCY` and `LOCAL_PATH_TIMEOUT_MS` (remote-methods.ts:646-647): paths are described a few at a time, each with its
 *  own deadline, so a path on a stalled network share fails alone. */
const LOCAL_PATH_CONCURRENCY = 4;
const LOCAL_PATH_TIMEOUT_MS = 15_000;

function withPathDeadline<T>(operation: Promise<T>, path: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = globalThis.setTimeout(() => reject(new Error(`Timed out after ${LOCAL_PATH_TIMEOUT_MS / 1000}s reading ${path}.`)), LOCAL_PATH_TIMEOUT_MS);
  });
  return Promise.race([operation, deadline]).finally(() => globalThis.clearTimeout(timer));
}

/** `absoluteLocalPath`'s type check (local-files.ts); the core checks the rest of the path. */
function localPath(path: unknown): string {
  if (typeof path !== 'string') throw new TypeError('path must be a string.');
  return path;
}

/** Each path as the PC describes it (`transfer/grant/mint`: owned by the deepest registered project that holds it, else named by a
 *  one-file grant of this device); the page's second argument (a conversation) narrows nothing, as in Node. */
async function resolveLocalPaths(host: PhoneProtocolHost, paths: unknown): Promise<unknown[]> {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) throw new TypeError('paths are invalid.');
  const rows = new Array<unknown>(paths.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const index = next++;
      rows[index] = await withPathDeadline(rpc(host, 'transfer/grant/mint', { path: localPath(paths[index]) }), String(paths[index]));
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOCAL_PATH_CONCURRENCY, paths.length) }, worker));
  return rows;
}

/** `ATTACHMENT_REF_PATTERN`, `REMOTE_ORIGINAL_MAX_BYTES` (attachment-thumbnail.ts): a relay thumbnail is the stored image itself. */
const ATTACHMENT_REF = /^[a-f0-9]{64}$/;
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
/** Raw bytes per page of a blob or a local file: a multiple of 3, so the pages' base64 joins into the file's, and 256 Ki characters
 *  on the wire, under a connection's 512 KiB per answer. */
const PAGE_BYTES = 196_608;

/** `sniffImageMime` (attachment-thumbnail.ts:21-36) over the bytes as a binary string. */
function imageMime(bytes: string): string | null {
  if (bytes.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (bytes.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (bytes.startsWith('GIF87a') || bytes.startsWith('GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const failureReason = (error: unknown): unknown => (error as { detail?: { data?: { reason?: unknown } } } | null)?.detail?.data?.reason;

/** The stored image of `ref` as a data URL, or null: no reference, no stored blob (gone or failing its content check), more than
 *  2 MiB (decided before the rest is read), or no image by its bytes. The blob is read a page at a time (`blob/read`). */
async function readAttachmentThumbnail(host: PhoneProtocolHost, ref: unknown): Promise<string | null> {
  if (typeof ref !== 'string' || !ATTACHMENT_REF.test(ref)) return null;
  let bytes = '';
  for (;;) {
    let page: string;
    try {
      const params = { digest: `sha256:${ref}`, offset: bytes.length, length: PAGE_BYTES };
      page = atob(((await host.client().call('blob/read' as never, params as never)) as { bytesB64: string }).bytesB64);
    } catch (error) {
      const reason = failureReason(error);
      if (reason === 'blobNotFound' || reason === 'blobCorrupt') return null;
      throw error;
    }
    if (!page) break;
    bytes += page;
    if (bytes.length > THUMBNAIL_MAX_BYTES) return null;
  }
  const mime = imageMime(bytes);
  return mime ? `data:${mime};base64,${btoa(bytes)}` : null;
}


/** `readLocalFileAbs` (local-files.ts): the core checks the file as Node did and holds it open; its bytes come a page at a time from
 *  that one open file, so the join is one version of it. */
async function readLocalFile(host: PhoneProtocolHost, path: unknown): Promise<unknown> {
  const { transferId, version, ...file } = (await rpc(host, 'projectFs/readLocal', { path: localPath(path), paged: true })) as { transferId: string; version: string };
  try {
    let data = '';
    for (let offset = 0; ; offset += PAGE_BYTES) {
      const page = (await rpc(host, 'transfer/readRange', { transferId, version, offset, length: PAGE_BYTES })) as { data: string; eof: boolean };
      data += page.data;
      if (page.eof) break;
    }
    return { ...file, data };
  } finally {
    await rpc(host, 'transfer/endRead', { transferId }).catch(() => undefined);
  }
}

export const adapter: PhoneProtocolAdapter = {
  group: 'attachments',
  calls: {
    resolveLocalPaths: ([paths], host) => resolveLocalPaths(host, paths),
    readLocalFile: ([path], host) => readLocalFile(host, path),
    readAttachmentThumbnail: ([ref], host) => readAttachmentThumbnail(host, ref),
    // The conversation's attachment staged in the PC's temp folder, with a one-file grant of that conversation.
    attachmentOpen: ([sessionId, attachmentId], host) => rpc(host, 'transfer/grant/mint', { sessionId, attachmentId }),
    // The request is checked first, then the project (Node's order); the core resolves the project's journal.
    projectRecovery: ([projectPath, input], host) => {
      const request = requiredProjectRecoveryRequest(input);
      return rpc(host, 'projectFs/recovery', { root: requiredString(projectPath, 'projectPath'), ...request });
    },
  },
};
