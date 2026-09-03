import type { IpcMainInvokeEvent } from 'electron';
import {
  DESKTOP_IPC,
  type DesktopBrowserViewportConfig,
} from '../shared/contract';
import { requiredSessionId } from './desktop-state';
import type { BrowserHost } from './browser/host';

type Handle = (
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
) => void;

interface BrowserIpcOptions {
  handle: Handle;
  browserHost?: Pick<BrowserHost,
    'browserImportSources'
    | 'browserImport'
    | 'browserHistorySearch'
    | 'setGuestActive'
    | 'configureGuestViewport'
    | 'browserCredentialSuggestions'
    | 'browserCredentialFill'>;
}

export function registerBrowserIpc({ handle, browserHost }: BrowserIpcOptions): void {
  handle(DESKTOP_IPC.browserSetActiveGuest, (_event, sessionId, webContentsId, active) => {
    if (!browserHost) throw new Error('Browser Use is unavailable in this app surface.');
    const ownerSessionId = requiredSessionId(sessionId);
    if (!Number.isSafeInteger(webContentsId) || Number(webContentsId) <= 0) {
      throw new TypeError('Browser guest id is invalid.');
    }
    if (typeof active !== 'boolean') throw new TypeError('Browser guest activity is invalid.');
    browserHost.setGuestActive(ownerSessionId, Number(webContentsId), active);
  });
  handle(DESKTOP_IPC.browserConfigureGuestViewport, (
    _event,
    sessionId,
    webContentsId,
    value,
  ) => {
    if (!browserHost) throw new Error('Browser Use is unavailable in this app surface.');
    const ownerSessionId = requiredSessionId(sessionId);
    if (!Number.isSafeInteger(webContentsId) || Number(webContentsId) <= 0) {
      throw new TypeError('Browser guest id is invalid.');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Browser viewport config is invalid.');
    }
    const input = value as Record<string, unknown>;
    const { width, height } = input;
    const fixedViewport = width !== null && height !== null;
    if ((width === null) !== (height === null)
      || (fixedViewport && (
        !Number.isSafeInteger(width)
        || !Number.isSafeInteger(height)
        || Number(width) < 200
        || Number(width) > 3840
        || Number(height) < 200
        || Number(height) > 3840
      ))) {
      throw new TypeError('Browser viewport dimensions are invalid.');
    }
    const deviceScaleFactor = Number(input.deviceScaleFactor);
    if (!Number.isFinite(deviceScaleFactor)
      || deviceScaleFactor < 0.5
      || deviceScaleFactor > 4
      || typeof input.mobile !== 'boolean'
      || typeof input.touch !== 'boolean') {
      throw new TypeError('Browser viewport emulation is invalid.');
    }
    const userAgent = input.userAgent;
    if (userAgent !== null && (
      typeof userAgent !== 'string'
      || userAgent.length > 2048
      || /[\r\n]/.test(userAgent)
    )) {
      throw new TypeError('Browser viewport user agent is invalid.');
    }
    const config: DesktopBrowserViewportConfig = {
      width: width === null ? null : Number(width),
      height: height === null ? null : Number(height),
      deviceScaleFactor,
      mobile: input.mobile,
      touch: input.touch,
      userAgent,
    };
    return browserHost.configureGuestViewport(ownerSessionId, Number(webContentsId), config);
  });
  handle(DESKTOP_IPC.browserProfileImportSources, () => {
    if (!browserHost) throw new Error('Browser profile import is unavailable in this app surface.');
    return browserHost.browserImportSources();
  });
  handle(DESKTOP_IPC.browserProfileImportStart, (_event, value) => {
    if (!browserHost) throw new Error('Browser profile import is unavailable in this app surface.');
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Browser import request must be an object.');
    }
    const request = value as Record<string, unknown>;
    const jobId = String(request.jobId || '');
    const sourceId = String(request.sourceId || '');
    const profileId = String(request.profileId || '');
    const items = Array.isArray(request.items)
      ? request.items.map((item) => String(item))
      : [];
    if (!/^[a-zA-Z0-9_-]{8,120}$/.test(jobId)) throw new TypeError('Browser import job id is invalid.');
    if (!sourceId || sourceId.length > 100) throw new TypeError('Browser import source id is invalid.');
    if (!profileId || profileId.length > 200) throw new TypeError('Browser import profile id is invalid.');
    if (
      !items.length
      || items.length > 3
      || items.some((item) => !['passwords', 'cookies', 'history'].includes(item))
    ) {
      throw new TypeError('Browser import items are invalid.');
    }
    return browserHost.browserImport({
      jobId,
      sourceId,
      profileId,
      items: items as Array<'passwords' | 'cookies' | 'history'>,
      administratorApproved: request.administratorApproved === true,
    });
  });
  handle(DESKTOP_IPC.browserHistorySearch, (_event, query) => {
    if (!browserHost) throw new Error('Browser history is unavailable in this app surface.');
    if (typeof query !== 'string' || query.length > 500) {
      throw new TypeError('Browser history query is invalid.');
    }
    return browserHost.browserHistorySearch(query);
  });
  handle(DESKTOP_IPC.browserCredentialSuggestions, (_event, sessionId) => {
    if (!browserHost) throw new Error('Stored browser credentials are unavailable in this app surface.');
    return browserHost.browserCredentialSuggestions(requiredSessionId(sessionId));
  });
  handle(DESKTOP_IPC.browserCredentialFill, (_event, sessionId, credentialId) => {
    if (!browserHost) throw new Error('Stored browser credentials are unavailable in this app surface.');
    if (typeof credentialId !== 'string' || !/^[a-f0-9]{24}$/.test(credentialId)) {
      throw new TypeError('Stored browser credential id is invalid.');
    }
    return browserHost.browserCredentialFill(requiredSessionId(sessionId), credentialId);
  });
}
