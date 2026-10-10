import { normalizeBrowserPageControl } from './browser-page-control';
import { MAIN_BROWSER_PAGE_PREFIX } from './contract-browser';
import type {
  DesktopBrowserImportRequest,
  DesktopRemoteBrowserControl,
  DesktopRemoteBrowserPageInput,
  DesktopRemoteBrowserStreamOptions,
} from './contract';

/** Encrypted relay push carrying a DesktopRemoteBrowserStreamFrame. */
export const REMOTE_BROWSER_FRAME_EVENT = 'browserRemoteFrame';
/** Encrypted relay push carrying a DesktopBrowserOpenRequest for an agent
 * handoff (explicit reveal) or hide, so paired clients open the same surface. */
export const REMOTE_BROWSER_OPEN_EVENT = 'browserOpenRequested';

/** Encrypted relay push carrying the full DesktopRemoteBrowserTab[] list. */
export const REMOTE_BROWSER_TABS_EVENT = 'browserRemoteTabs';
/** Encrypted relay push carrying a DesktopBrowserImportProgress. */
export const REMOTE_BROWSER_IMPORT_PROGRESS_EVENT = 'browserProfileImportProgress';
/** Relay-handshake flag: the host serves the remote browser pane's tabs,
 * history, saved-login fill and profile import. */
export const REMOTE_BROWSER_PARITY_FLAG = 'browserParity';

/** Desktop-service event carrying a DesktopBrowserOpenRequest to the relay,
 * which forwards it to paired clients as REMOTE_BROWSER_OPEN_EVENT. */
export const BROWSER_OPEN_REQUESTED_DESKTOP_EVENT = 'browser-open-requested';

const MAX_REMOTE_BROWSER_TEXT = 2_000;
const MAX_STREAM_DIMENSION = 4_096;

/** Live-view size a client asks for, in device pixels. */
export function normalizeRemoteBrowserStreamOptions(value: unknown): DesktopRemoteBrowserStreamOptions {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const dimension = (name: 'maxWidth' | 'maxHeight'): number => {
    const number = input[name];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 64 || number > MAX_STREAM_DIMENSION) {
      throw new TypeError(`remote browser stream ${name} is invalid.`);
    }
    return Math.round(number);
  };
  return { maxWidth: dimension('maxWidth'), maxHeight: dimension('maxHeight') };
}

export function normalizeRemoteBrowserControl(value: unknown): DesktopRemoteBrowserControl {
  if (!value || typeof value !== 'object') {
    throw new TypeError('remote browser control is invalid.');
  }
  const input = value as Record<string, unknown>;
  const type = String(input.type || '');
  if (type === 'navigate') {
    if (typeof input.url !== 'string' || input.url.length < 1 || input.url.length > 4_096) {
      throw new TypeError('remote browser url is invalid.');
    }
    return { type, url: input.url };
  }
  if (type === 'back' || type === 'forward' || type === 'reload' || type === 'stop') {
    return { type };
  }
  if (
    type === 'pointer' ||
    type === 'wheel' ||
    type === 'text' ||
    type === 'key' ||
    type === 'composition' ||
    type === 'composition-end'
  ) {
    if (
      typeof input.documentId !== 'string' ||
      input.documentId.length > 64 ||
      !/^p[1-9]\d*:\d+$/u.test(input.documentId)
    ) {
      throw new TypeError('remote browser document id is invalid.');
    }
    if (
      (type === 'text' || type === 'composition' || type === 'composition-end') &&
      (typeof input.text !== 'string' || input.text.length > MAX_REMOTE_BROWSER_TEXT)
    ) {
      throw new TypeError('remote browser text is invalid.');
    }
    // The local pane's validator owns phases, buttons, modifiers, click counts
    // and bounded coordinates/deltas, so both surfaces admit the same input.
    return normalizeBrowserPageControl(input) as DesktopRemoteBrowserPageInput;
  }
  throw new TypeError(`unknown remote browser control "${type || '(none)'}".`);
}

/** A main-workspace browser page id: the only pages a client may list, open or close. */
export function normalizeRemoteBrowserTabId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith(MAIN_BROWSER_PAGE_PREFIX) ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new TypeError('Browser page is not a main tab page.');
  }
  return value;
}

export function normalizeBrowserHistoryQuery(value: unknown): string {
  if (typeof value !== 'string' || value.length > 500) {
    throw new TypeError('Browser history query is invalid.');
  }
  return value;
}

export function normalizeBrowserCredentialId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) {
    throw new TypeError('Stored browser credential id is invalid.');
  }
  return value;
}

export function normalizeBrowserImportRequest(value: unknown): DesktopBrowserImportRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Browser import request must be an object.');
  }
  const request = value as Record<string, unknown>;
  const jobId = String(request.jobId || '');
  const sourceId = String(request.sourceId || '');
  const profileId = String(request.profileId || '');
  const items = Array.isArray(request.items) ? request.items.map((item) => String(item)) : [];
  if (!/^[a-zA-Z0-9_-]{8,120}$/.test(jobId)) throw new TypeError('Browser import job id is invalid.');
  if (!sourceId || sourceId.length > 100) throw new TypeError('Browser import source id is invalid.');
  if (!profileId || profileId.length > 200) throw new TypeError('Browser import profile id is invalid.');
  if (
    !items.length ||
    items.length > 3 ||
    items.some((item) => !['passwords', 'cookies', 'history'].includes(item))
  ) {
    throw new TypeError('Browser import items are invalid.');
  }
  return {
    jobId,
    sourceId,
    profileId,
    items: items as DesktopBrowserImportRequest['items'],
    administratorApproved: request.administratorApproved === true,
  };
}

interface RemoteBrowserImageBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Map a pointer through an object-fit:contain image, rejecting letterbox taps. */
export function remoteBrowserImagePoint(
  bounds: RemoteBrowserImageBounds,
  source: { width: number; height: number },
  client: { x: number; y: number }
): { x: number; y: number } | null {
  if (bounds.width <= 0 || bounds.height <= 0 || source.width <= 0 || source.height <= 0) {
    return null;
  }
  const scale = Math.min(bounds.width / source.width, bounds.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  const left = bounds.left + (bounds.width - width) / 2;
  const top = bounds.top + (bounds.height - height) / 2;
  if (client.x < left || client.x > left + width || client.y < top || client.y > top + height) {
    return null;
  }
  return {
    x: Math.min(source.width, Math.max(0, (client.x - left) / scale)),
    y: Math.min(source.height, Math.max(0, (client.y - top) / scale)),
  };
}
