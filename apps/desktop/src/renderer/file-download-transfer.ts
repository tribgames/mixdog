// Phone side of host file downloads (GitHub #40; the wire contract is
// shared/file-downloads.ts): authorize → begin → move bytes → finish/abort,
// into the best destination this device has. In order: the phone app's native
// save sink (shared/native-file-save.ts) fed range by range with acks, the
// encrypted media lane the service worker streams to a browser download (only
// after the worker answered a probe for the lease), and last a Blob of RPC
// range reads for small files only. Memory stays bounded:
// the native path holds one chunk at a time and no Blob ever exceeds
// BLOB_FALLBACK_MAX_BYTES.
import {
  FileDownloadError,
  fileDownloadErrorReason,
  FOLDER_ZIP_MAX_BYTES,
  FOLDER_ZIP_MAX_FILES,
  folderTooLargeCounts,
  type FileDownloadApi,
  type FileDownloadChunk,
  type FileDownloadErrorReason,
  type FileDownloadPurpose,
  type FileDownloadSource,
  type FileDownloadTransfer,
  type FolderLeftOut,
} from '../shared/file-downloads';
import { nativeAppInfo } from '../shared/native-app';
import {
  NATIVE_FILE_SAVE_MAX_CHUNK_BYTES,
  type NativeFileSaveCalls,
  type NativeFileSaveErrorCode,
} from '../shared/native-file-save';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { fileDownloadLaneUrl } from './remote-media-lane';
import { base64Bytes } from './studio-pane-support';

/** Largest file the browser fallback assembles in memory. */
export const BLOB_FALLBACK_MAX_BYTES = 32 * 1024 * 1024;
/** Largest lane download the page itself reads into a Blob (Range windows
 *  through the worker); a larger one is handed to the browser as the lane URL. */
export const LANE_BLOB_MAX_BYTES = 128 * 1024 * 1024;
/** One Range request of the page's own lane read. */
export const LANE_WINDOW_BYTES = 4 * 1024 * 1024;

type NativeSaveMethod = Exclude<keyof NativeFileSaveCalls, 'getNativeCapabilities'>;
/** The shell's bridge narrowed to the save calls. */
export type NativeSaveCall = <M extends NativeSaveMethod>(
  method: M,
  args: NativeFileSaveCalls[M][0]
) => Promise<NativeFileSaveCalls[M][1]>;

/** Where this device can put a downloaded file. */
export type FileSaveSink = { kind: 'native'; call: NativeSaveCall } | { kind: 'browser' } | { kind: 'none' };

export type LaneProbe = 'ok' | 'changed' | 'unavailable';

/** What a browser did with the file it was handed. */
export type BrowserDelivery = 'saved' | 'shared' | 'dismissed';

export interface FileDownloadEnvironment {
  api: FileDownloadApi | undefined;
  /** Resolved once per page: the shell does not change under it. */
  sink(): Promise<FileSaveSink>;
  /** The lease's media-lane URL, or null when the lane cannot serve it. */
  laneUrl(transfer: FileDownloadTransfer): string | null;
  /** Confirms the lane serves `url` before the browser is sent there:
   *  `changed` when the worker reports the file moved on (412). */
  probeLane(url: string): Promise<LaneProbe>;
  /** Bytes `offset..offset+length` of a lane URL (a Range request the worker
   *  answers); rejects `changed` when the worker reports the file moved on. */
  readLane(url: string, offset: number, length: number, signal: AbortSignal): Promise<ArrayBuffer>;
  /** Hands a lane URL or an assembled file to the browser. */
  deliver(target: { url: string } | { blob: Blob }, transfer: FileDownloadTransfer): Promise<BrowserDelivery>;
  /** The share sheet for an assembled file, offered again from the download
   *  row (a fresh tap, after a long read lost the user activation); null when
   *  this browser cannot share files. */
  shareLater?(blob: Blob, transfer: FileDownloadTransfer): (() => Promise<NativeShareResult>) | null;
}

export type FileDownloadPhase = 'preparing' | 'downloading' | 'saving' | 'sharing';

export interface FileDownloadProgress {
  phase: FileDownloadPhase;
  /** '' until the host named the file. */
  name: string;
  received: number;
  total: number;
}

/** One native share sheet: `expired` when the finished handle is gone. */
export type NativeShareResult = 'shared' | 'dismissed' | 'share-failed' | 'expired';

export interface FileDownloadOutcome {
  name: string;
  size: number;
  destination: 'native' | 'lane' | 'blob';
  /** `started`: the browser downloads from the lane on its own.
   *  `share-failed`: the native share sheet failed.
   *  `saved-before-cancel`: the user cancelled, but the native shell had
   *  already kept the file on the device (nothing was shared). */
  result: 'saved' | 'shared' | 'dismissed' | 'started' | 'share-failed' | 'saved-before-cancel';
  /** Native only: the file stays on the device without sharing it. */
  persisted?: boolean;
  /** Native only: the share sheet again, for the finished file. */
  shareAgain?: () => Promise<NativeShareResult>;
  /** A folder zip only: the files it left out. */
  leftOut?: FolderLeftOut;
}

/** Why this device could not save, as opposed to the host refusing. */
export type FileSaveFailureReason = 'no-sink' | 'browser-too-large' | 'storage' | 'permission' | 'device';

export class FileSaveError extends Error {
  readonly reason: FileSaveFailureReason;

  constructor(reason: FileSaveFailureReason, detail = '') {
    super(detail || reason);
    this.name = 'FileSaveError';
    this.reason = reason;
  }
}

/** The user cancelled (our cancel, or dismissing the save location UI). */
export class FileDownloadCancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'FileDownloadCancelledError';
  }
}

export type FileDownloadSupport =
  | { state: 'ready'; native: boolean }
  | { state: 'blocked'; reason: 'host-too-old' | 'no-sink' };

/** Whether a download can run here: the host must serve them and this device
 *  must have somewhere to put the bytes. */
export async function fileDownloadSupport(env: FileDownloadEnvironment): Promise<FileDownloadSupport> {
  if (!env.api?.available()) return { state: 'blocked', reason: 'host-too-old' };
  const sink = await env.sink();
  if (sink.kind === 'none') return { state: 'blocked', reason: 'no-sink' };
  return { state: 'ready', native: sink.kind === 'native' };
}

/** Translated message of a host refusal. */
export function fileDownloadReasonMessage(reason: FileDownloadErrorReason): string {
  switch (reason) {
    case 'not-linked':
      return t('Only files this conversation links can be downloaded.');
    case 'outside-project':
      return t("The file is outside the conversation's Project.");
    case 'sensitive':
      return t('This file can hold credentials or secrets and cannot be downloaded.');
    case 'too-large':
      return t('Files larger than 256 MB cannot be downloaded.');
    case 'folder-too-large':
      return t('This folder is too large to zip (up to 64 MB and 2,000 files). Download files from it one by one.');
    case 'changed':
      return t('The file changed on the PC during the download. Try again.');
    case 'expired':
      return t('The download expired. Try again.');
    case 'host-too-old':
      return t('Update Mixdog on the PC to download its files.');
    case 'not-found':
      return t('The file no longer exists on the PC.');
    case 'not-a-file':
      return t('Only files can be downloaded, not folders or devices.');
    case 'busy':
      return t('Too many downloads are running. Wait for one to finish.');
    case 'unavailable':
      return t('This conversation is not available on the PC.');
  }
}

/** Translated message of a device-side save failure. */
export function fileSaveFailureMessage(reason: FileSaveFailureReason): string {
  switch (reason) {
    case 'no-sink':
      return t('Update the Mixdog app on this device to save files from the PC.');
    case 'browser-too-large':
      return t(
        'This file is too large to download in this browser. Update Mixdog on the PC and on this device to download it.'
      );
    case 'storage':
      return t('This device ran out of space or could not write the file.');
    case 'permission':
      return t('This device did not allow saving the file there.');
    case 'device':
      return t('Saving the file on this device failed.');
  }
}

/** The message a failed download shows. */
export function fileDownloadFailureMessage(error: unknown): string {
  const reason = fileDownloadErrorReason(error);
  if (reason === 'folder-too-large') {
    // The host states what it counted; an older host's wording has no counts.
    const counts = folderTooLargeCounts(error instanceof Error ? error.message : '');
    if (counts) {
      return t(
        'This folder is too large to zip: {{files}} files and {{size}} after leaving out ignored files (limit {{maxFiles}} files and {{maxSize}}). Pick a subfolder to download instead.',
        {
          ...counts,
          maxFiles: FOLDER_ZIP_MAX_FILES.toLocaleString('en-US'),
          maxSize: `${FOLDER_ZIP_MAX_BYTES / (1024 * 1024)} MB`,
        }
      );
    }
  }
  if (reason) return fileDownloadReasonMessage(reason);
  if (error instanceof FileSaveError) return fileSaveFailureMessage(error.reason);
  return errorMessageText(error);
}

/** Bytes per second over the samples (oldest first), or null before two. */
export function transferRate(samples: readonly { at: number; bytes: number }[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const elapsed = last.at - first.at;
  return elapsed > 0 ? ((last.bytes - first.bytes) * 1000) / elapsed : null;
}

/** Milliseconds left at `rate`, or null without a usable rate. */
export function remainingMs(rate: number | null, received: number, total: number): number | null {
  if (!rate || rate <= 0 || total <= received) return null;
  return ((total - received) / rate) * 1000;
}

const noop = () => {};

/** `promise`, rejected as cancelled the moment `signal` aborts. A value that
 *  still arrives after the cancel goes to `release` (a grant or lease that
 *  must not outlive it). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal, release?: (value: T) => void): Promise<T> {
  if (signal.aborted) {
    if (release) promise.then(release, noop);
    return Promise.reject(new FileDownloadCancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    const cancel = () => {
      if (release) promise.then(release, noop);
      reject(new FileDownloadCancelledError());
    };
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', cancel);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', cancel);
        reject(error);
      }
    );
  });
}

function nativeFailure(code: NativeFileSaveErrorCode): Error {
  if (code === 'cancelled') return new FileDownloadCancelledError();
  if (code === 'too-large') return new FileDownloadError('too-large', 'The file is too large for this device.');
  if (code === 'storage' || code === 'permission') return new FileSaveError(code);
  return new FileSaveError('device', code);
}

/** One native save call; an absent answer means the shell lost the sink. */
async function nativeStep<M extends NativeSaveMethod>(
  call: NativeSaveCall,
  method: M,
  args: NativeFileSaveCalls[M][0]
): Promise<Extract<NonNullable<NativeFileSaveCalls[M][1]>, { ok: true }>> {
  const reply = await call(method, args);
  if (!reply) throw new FileSaveError('no-sink');
  if (!reply.ok) throw nativeFailure(reply.error);
  return reply as Extract<NonNullable<NativeFileSaveCalls[M][1]>, { ok: true }>;
}

interface RunState {
  transferId: string | null;
  handle: string | null;
}

/** The range at `offset`, checked against the leased version. */
async function readRange(
  api: FileDownloadApi,
  transfer: FileDownloadTransfer,
  offset: number,
  length: number,
  signal: AbortSignal
): Promise<FileDownloadChunk> {
  const chunk = await abortable(api.readRange(transfer.transferId, offset, length, transfer.version), signal);
  const short = chunk.length < length && offset + chunk.length < transfer.size;
  if (chunk.version !== transfer.version || chunk.offset !== offset || chunk.length <= 0 || short) {
    throw new FileDownloadError('changed', 'The file changed on the host.');
  }
  return chunk;
}

/** Native sink: one range in flight, written only after the previous ack. */
async function saveNatively(
  api: FileDownloadApi,
  call: NativeSaveCall,
  transfer: FileDownloadTransfer,
  purpose: FileDownloadPurpose,
  state: RunState,
  signal: AbortSignal,
  report: (progress: Omit<FileDownloadProgress, 'name' | 'total'>) => void
): Promise<Pick<FileDownloadOutcome, 'result' | 'persisted' | 'shareAgain'>> {
  const begun = await abortable(
    nativeStep(call, 'fileSaveBegin', { name: transfer.name, mime: transfer.mime, size: transfer.size, purpose }),
    signal,
    (value) => void call('fileSaveAbort', { handle: value.handle }).catch(noop)
  );
  state.handle = begun.handle;
  const step = Math.max(1, Math.min(transfer.rangeMaxBytes, NATIVE_FILE_SAVE_MAX_CHUNK_BYTES));
  let written = 0;
  while (written < transfer.size) {
    const chunk = await readRange(api, transfer, written, Math.min(step, transfer.size - written), signal);
    const ack = await abortable(
      nativeStep(call, 'fileSaveWrite', { handle: begun.handle, offset: written, data: chunk.data }),
      signal
    );
    if (ack.written !== written + chunk.length) throw new FileSaveError('device', 'offset-mismatch');
    written = ack.written;
    report({ phase: 'downloading', received: written });
  }
  report({ phase: 'saving', received: written });
  await abortable(api.finish(transfer.transferId), signal);
  state.transferId = null;
  // Not raced against the cancel: once the shell publishes, the file may be
  // on the device whatever was pressed meanwhile, so the cancel is honored
  // below, from what the shell answered.
  const finished = await nativeStep(call, 'fileSaveFinish', { handle: begun.handle, size: transfer.size });
  state.handle = null;
  // Older shells do not say, and they kept the file.
  const persisted = finished.persisted !== false;
  if (signal.aborted) {
    if (persisted) return { result: 'saved-before-cancel', persisted };
    throw new FileDownloadCancelledError();
  }
  report({ phase: 'sharing', received: written });
  const shared = await shareNatively(call, begun.handle);
  return {
    result: shared === 'expired' ? 'share-failed' : shared,
    persisted,
    shareAgain: () => shareNatively(call, begun.handle),
  };
}

/** The OS share sheet for a finished native file; a dismissed sheet is the
 *  user's choice, not a failure. */
async function shareNatively(call: NativeSaveCall, handle: string): Promise<NativeShareResult> {
  try {
    const shared = await nativeStep(call, 'fileSaveShare', { handle });
    return shared.shared ? 'shared' : 'dismissed';
  } catch (error) {
    if (error instanceof FileDownloadCancelledError) return 'dismissed';
    // nativeFailure keeps the shell's code as the message of a `device` failure.
    return error instanceof FileSaveError && error.message === 'unknown-handle' ? 'expired' : 'share-failed';
  }
}

/** Browser fallback: every range of a small file, then one Blob. */
async function readSmallFile(
  api: FileDownloadApi,
  transfer: FileDownloadTransfer,
  signal: AbortSignal,
  report: (progress: Omit<FileDownloadProgress, 'name' | 'total'>) => void
): Promise<Blob> {
  const parts: ArrayBuffer[] = [];
  const step = Math.max(1, transfer.rangeMaxBytes);
  let received = 0;
  while (received < transfer.size) {
    const chunk = await readRange(api, transfer, received, Math.min(step, transfer.size - received), signal);
    parts.push(base64Bytes(chunk.data));
    received += chunk.length;
    report({ phase: 'downloading', received });
  }
  return new Blob(parts, { type: transfer.mime });
}

/** Browser lane read: the file in LANE_WINDOW_BYTES Range windows, then one Blob. */
async function readLaneFile(
  env: FileDownloadEnvironment,
  url: string,
  transfer: FileDownloadTransfer,
  signal: AbortSignal,
  report: (progress: Omit<FileDownloadProgress, 'name' | 'total'>) => void
): Promise<Blob> {
  const parts: ArrayBuffer[] = [];
  let received = 0;
  while (received < transfer.size) {
    const length = Math.min(LANE_WINDOW_BYTES, transfer.size - received);
    const part = await abortable(env.readLane(url, received, length, signal), signal);
    if (part.byteLength !== length) throw new FileDownloadError('changed', 'The file changed on the host.');
    parts.push(part);
    received += length;
    report({ phase: 'downloading', received });
  }
  return new Blob(parts, { type: transfer.mime });
}

/** Downloads one host file to this device. Rejects FileDownloadCancelledError
 *  when the user cancelled; anything else is a failure to show. */
export async function runFileDownload(
  env: FileDownloadEnvironment,
  source: FileDownloadSource,
  options: { signal: AbortSignal; onProgress?: (progress: FileDownloadProgress) => void }
): Promise<FileDownloadOutcome> {
  const { signal, onProgress } = options;
  const api = env.api;
  if (!api?.available()) throw new FileDownloadError('host-too-old', 'The host does not serve downloads.');
  const sink = await abortable(env.sink(), signal);
  if (sink.kind === 'none') throw new FileSaveError('no-sink');
  const purpose: FileDownloadPurpose = sink.kind === 'native' ? 'share' : 'save';
  let name = '';
  let total = 0;
  const report = (progress: Omit<FileDownloadProgress, 'name' | 'total'>) => onProgress?.({ ...progress, name, total });
  report({ phase: 'preparing', received: 0 });
  const state: RunState = { transferId: null, handle: null };
  try {
    const grant = await abortable(
      api.authorize({ source, purpose }),
      signal,
      (value) => void api.abort(value.grantId).catch(noop)
    );
    name = grant.name;
    total = grant.size;
    report({ phase: 'preparing', received: 0 });
    const transfer = await abortable(
      api.begin(grant.grantId),
      signal,
      (value) => void api.abort(value.transferId).catch(noop)
    );
    state.transferId = transfer.transferId;
    name = transfer.name;
    total = transfer.size;
    const outcome = (destination: FileDownloadOutcome['destination'], result: FileDownloadOutcome['result']) => ({
      name,
      size: total,
      destination,
      result,
      ...(grant.leftOut ? { leftOut: grant.leftOut } : {}),
    });
    if (sink.kind === 'native') {
      const saved = await saveNatively(api, sink.call, transfer, purpose, state, signal, report);
      return { ...outcome('native', saved.result), ...saved };
    }
    // The lane is used only once the worker answered for this lease (an older
    // relay, an ended lease or a failed stream answer 404/502); otherwise the
    // same lease is read over RPC below.
    const url = transfer.size > 0 ? env.laneUrl(transfer) : null;
    const probe = url ? await abortable(env.probeLane(url), signal) : 'unavailable';
    if (probe === 'changed') throw new FileDownloadError('changed', 'The file changed on the host.');
    let blob: Blob;
    if (url && probe === 'ok') {
      // The lease now belongs to the lane (the worker reads it).
      state.transferId = null;
      if (transfer.size > LANE_BLOB_MAX_BYTES) {
        // Too large to hold: the browser downloads the lane URL on its own.
        report({ phase: 'saving', received: 0 });
        await env.deliver({ url }, transfer);
        return outcome('lane', 'started');
      }
      // Read by the page itself, so progress, errors and the share sheet stay
      // here instead of depending on how the browser treats a worker download.
      blob = await readLaneFile(env, url, transfer, signal, report);
    } else {
      if (transfer.size > BLOB_FALLBACK_MAX_BYTES) throw new FileSaveError('browser-too-large');
      blob = await readSmallFile(api, transfer, signal, report);
      await abortable(api.finish(transfer.transferId), signal);
      state.transferId = null;
    }
    report({ phase: 'saving', received: total });
    const delivered = await env.deliver({ blob }, transfer);
    const shareAgain = delivered === 'shared' ? null : (env.shareLater?.(blob, transfer) ?? null);
    return { ...outcome('blob', delivered), ...(shareAgain ? { shareAgain } : {}) };
  } catch (error) {
    const call = sink.kind === 'native' ? sink.call : null;
    if (state.handle && call) void call('fileSaveAbort', { handle: state.handle }).catch(noop);
    if (state.transferId) void api.abort(state.transferId).catch(noop);
    throw signal.aborted ? new FileDownloadCancelledError() : error;
  }
}

function clickDownload(url: string, name: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

/** Browser hand-off: the share sheet where the device offers one for files
 *  (a dismissed sheet is the user's choice), else a download link. */
async function deliverInBrowser(
  target: { url: string } | { blob: Blob },
  transfer: Pick<FileDownloadTransfer, 'name' | 'mime'>
): Promise<BrowserDelivery> {
  if ('url' in target) {
    clickDownload(target.url, transfer.name);
    return 'saved';
  }
  const file = new File([target.blob], transfer.name, { type: transfer.mime });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return 'dismissed';
      // Lost user activation (a slow read) and the like: the link still works.
    }
  }
  const href = URL.createObjectURL(file);
  clickDownload(href, transfer.name);
  window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
  return 'saved';
}

/** One-byte range read of a lane URL through the service worker. */
async function probeLaneUrl(url: string): Promise<LaneProbe> {
  try {
    const response = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
    void response.body?.cancel().catch(noop);
    if (response.status === 412) return 'changed';
    return response.ok ? 'ok' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** One Range window of a lane URL through the service worker. */
async function readLaneWindow(url: string, offset: number, length: number, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
    cache: 'no-store',
    signal,
  });
  if (response.status === 412) throw new FileDownloadError('changed', 'The file changed on the host.');
  if (response.status === 404 || response.status === 410) {
    throw new FileDownloadError('expired', 'This download is no longer available.');
  }
  // A 200 would be the whole file again, not this window.
  if (response.status !== 206) throw new FileSaveError('device', `lane-${response.status}`);
  return response.arrayBuffer();
}

/** The browser share sheet for `blob`, when this browser shares files. */
function browserShareLater(blob: Blob, transfer: Pick<FileDownloadTransfer, 'name' | 'mime'>) {
  const file = new File([blob], transfer.name, { type: transfer.mime });
  if (!navigator.canShare?.({ files: [file] })) return null;
  return async (): Promise<NativeShareResult> => {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (reason) {
      return reason instanceof DOMException && reason.name === 'AbortError' ? 'dismissed' : 'share-failed';
    }
  };
}

let sinkProbe: Promise<FileSaveSink> | null = null;

function cachedSink(): Promise<FileSaveSink> {
  sinkProbe ??= probeSink();
  return sinkProbe;
}

/** The phone app's native sink when its shell implements one; inside the app
 *  without it nothing can save (its WebView drops browser downloads); a
 *  plain browser saves through links. */
function probeSink(): Promise<FileSaveSink> {
  const info = nativeAppInfo();
  if (!info) {
    return Promise.resolve(typeof URL.createObjectURL === 'function' ? { kind: 'browser' } : { kind: 'none' });
  }
  const call = info.call;
  if (!call) return Promise.resolve({ kind: 'none' });
  return call('getNativeCapabilities').then(
    (capabilities): FileSaveSink =>
      capabilities?.fileSave === 1 ? { kind: 'native', call: call as unknown as NativeSaveCall } : { kind: 'none' },
    (): FileSaveSink => ({ kind: 'none' })
  );
}

function bytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** What happened to bytes handed to this device: `saved` and `shared` are
 *  confirmed; `dismissed` is the user backing out of the sheet or dialog. */
export type DeviceSaveResult = BrowserDelivery;

/** Puts `blob` on this device through `sink`: the phone app's native save
 *  (chunked writes, then its share sheet), or a browser's share sheet / anchor
 *  download. Rejects when this device cannot save or the save failed. */
export async function saveBlobWithSink(
  sink: FileSaveSink,
  blob: Blob,
  name: string,
  deliver: typeof deliverInBrowser = deliverInBrowser
): Promise<DeviceSaveResult> {
  const mime = blob.type || 'application/octet-stream';
  if (sink.kind === 'none') throw new FileSaveError('no-sink');
  if (sink.kind === 'browser') return deliver({ blob }, { name, mime });
  const call = sink.call;
  let handle = '';
  let persisted = true;
  try {
    handle = (await nativeStep(call, 'fileSaveBegin', { name, mime, size: blob.size, purpose: 'share' })).handle;
    let written = 0;
    while (written < blob.size) {
      const end = Math.min(written + NATIVE_FILE_SAVE_MAX_CHUNK_BYTES, blob.size);
      const data = bytesBase64(new Uint8Array(await blob.slice(written, end).arrayBuffer()));
      const ack = await nativeStep(call, 'fileSaveWrite', { handle, offset: written, data });
      if (ack.written !== end) throw new FileSaveError('device', 'offset-mismatch');
      written = end;
    }
    persisted = (await nativeStep(call, 'fileSaveFinish', { handle, size: blob.size })).persisted !== false;
  } catch (error) {
    if (handle) void call('fileSaveAbort', { handle }).catch(noop);
    if (error instanceof FileDownloadCancelledError) return 'dismissed';
    throw error;
  }
  const shared = await shareNatively(call, handle);
  if (shared === 'shared') return 'shared';
  if (persisted) return 'saved';
  if (shared === 'dismissed') return 'dismissed';
  throw new FileSaveError('device', 'share-failed');
}

/** The bytes behind a data: / blob: / http(s) URL. data: is decoded here (a
 *  page CSP may refuse fetch of it); the rest is fetched, and a failed fetch
 *  is an error rather than an empty file. */
export async function blobFromUrl(url: string): Promise<Blob> {
  const data = /^data:([^;,]*)((?:;[^;,]+)*),/i.exec(url);
  if (data) {
    const payload = url.slice(data[0].length);
    const mime = data[1] || 'application/octet-stream';
    if (/;base64/i.test(data[2])) return new Blob([base64Bytes(payload)], { type: mime });
    return new Blob([decodeURIComponent(payload)], { type: mime });
  }
  const response = await fetch(url);
  if (!response.ok) throw new FileSaveError('device', `fetch-${response.status}`);
  return response.blob();
}

/** Saves the bytes behind `url` as `name` on this device. */
export async function saveUrlOnDevice(url: string, name: string): Promise<DeviceSaveResult> {
  return saveBlobOnDevice(await blobFromUrl(url), name);
}

/** Saves `blob` as `name` on this device (see saveBlobWithSink). */
export function saveBlobOnDevice(blob: Blob, name: string): Promise<DeviceSaveResult> {
  return defaultFileDownloadEnvironment()
    .sink()
    .then((sink) => saveBlobWithSink(sink, blob, name));
}

/** Hands a finished Blob to the phone app's native save bridge when the shell
 *  has one (its WebView drops browser downloads, and the page CSP blocks
 *  fetching a blob: URL, so the bridge gets the Blob itself); otherwise the
 *  browser path. A lane URL has no Blob to hand over and stays with the browser. */
export async function deliverPreferNative(
  target: { url: string } | { blob: Blob },
  transfer: Pick<FileDownloadTransfer, 'name' | 'mime'>,
  deliver: typeof deliverInBrowser = deliverInBrowser
): Promise<BrowserDelivery> {
  if ('blob' in target) {
    const sink = await cachedSink();
    if (sink.kind === 'native') return saveBlobWithSink(sink, target.blob, transfer.name, deliver);
  }
  return deliver(target, transfer);
}

/** This page's download environment. */
export function defaultFileDownloadEnvironment(): FileDownloadEnvironment {
  return {
    api: window.mixdogDesktop?.fileDownloads,
    sink: cachedSink,
    laneUrl: fileDownloadLaneUrl,
    probeLane: probeLaneUrl,
    readLane: readLaneWindow,
    deliver: deliverPreferNative,
    shareLater: browserShareLater,
  };
}
