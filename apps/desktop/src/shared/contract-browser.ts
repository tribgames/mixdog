// Embedded/remote browser: imports, credentials, viewport, tabs, frames and controls.

export type DesktopBrowserImportItem = 'passwords' | 'cookies' | 'history';
export type DesktopBrowserImportItemState = 'running' | 'completed' | 'failed';

export interface DesktopBrowserImportProfile {
  id: string;
  name: string;
  accountEmail?: string;
}

export interface DesktopBrowserImportSource {
  id: string;
  name: string;
  profiles: DesktopBrowserImportProfile[];
  supports: Record<DesktopBrowserImportItem, boolean>;
  supportReasons?: Partial<Record<DesktopBrowserImportItem, string>>;
  passwordSupportReason?: string;
}

export interface DesktopBrowserImportRequest {
  jobId: string;
  sourceId: string;
  profileId: string;
  items: DesktopBrowserImportItem[];
  administratorApproved: boolean;
}

export interface DesktopBrowserImportProgress {
  jobId: string;
  item: DesktopBrowserImportItem;
  state: DesktopBrowserImportItemState;
  count?: number;
  error?: string;
}

export interface DesktopBrowserImportResult {
  jobId: string;
  counts: Record<DesktopBrowserImportItem, number>;
  errors: Partial<Record<DesktopBrowserImportItem, string>>;
}

export interface DesktopBrowserHistoryEntry {
  url: string;
  title: string;
  lastVisitAt: number;
  visitCount: number;
}

export interface DesktopBrowserCredentialSuggestion {
  id: string;
  label: string;
}

export interface DesktopBrowserCredentialFillResult {
  usernameFilled: boolean;
  passwordFilled: boolean;
  reason?: 'no-password-field' | 'password-field-unavailable';
}

export interface DesktopBrowserViewportConfig {
  width: number | null;
  height: number | null;
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
  userAgent: string | null;
}

export interface DesktopBrowserGuestViewportChange {
  sessionId: string;
  webContentsId?: number;
  viewport: { width: number; height: number } | null;
}

/** A paired phone is polling frames of this session's Browser Use guest. */
export interface DesktopBrowserRemoteViewerChange {
  sessionId: string;
  active: boolean;
}

export interface DesktopBrowserOpenRequest {
  sessionId: string;
  /** False creates or retains the surface without opening its session dock. */
  reveal?: boolean;
  /** Hide only: never create or release pages; overrides reveal. */
  hide?: boolean;
  /** Temporary automation reveal, scoped to one runtime turn. */
  temporaryTurnId?: number;
  /** Restore only the matching temporary reveal, never a user's selection. */
  restoreTurnId?: number;
  /** Human takeover commits a temporary surface without reopening it. */
  retainTurnId?: number;
}

export interface DesktopRemoteBrowserFrame {
  frameId: string;
  /** Stable across image updates; changes when the page/document is replaced.
   * Optional for compatibility with remote clients attached to older hosts. */
  documentId?: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  width: number;
  height: number;
  image?: {
    mimeType: 'image/jpeg' | 'image/png';
    data: string;
  };
}

/** Local display client. The document token is scoped to the session-owned
 * page, so queued human input cannot land in a replacement document. */
export interface DesktopBrowserTab {
  id: string;
  title: string;
  url: string;
  active: boolean;
  loading: boolean;
  kind: 'page' | 'popup' | 'background';
}

/** A capture that lost a race against navigation or a resize owns no pixels for
 * the state that was asked about, and the page it would describe no longer
 * exists. Human browsing causes that race constantly, so the display answers
 * with this marker and asks again for whatever the page shows now, rather than
 * reporting an error for pixels it was always going to re-request. */
export interface DesktopBrowserPageResample {
  resample: true;
}

/** Cache costs a page only a slower reload; site data drops what a page saved
 * locally; cookies end the sessions the user is signed in to. */
export type DesktopBrowserDataScope = 'cache' | 'siteData' | 'cookies';

export interface DesktopBrowserDataClearResult {
  cleared: DesktopBrowserDataScope[];
  errors: Partial<Record<DesktopBrowserDataScope, string>>;
}

export interface DesktopBrowserPageFrame extends DesktopRemoteBrowserFrame {
  /** Local-only GPU frame, received separately by the trusted preload. */
  textureId?: string;
  webContentsId: number;
  documentId: string;
  viewportWidth: number;
  viewportHeight: number;
  /** Native surface dimensions, separate from encoded HiDPI pixels. Optional
   * for clients that are still connected to an older desktop host. */
  surfaceWidth?: number;
  surfaceHeight?: number;
  fault?: string;
  tabs?: DesktopBrowserTab[];
  dialog?: { id: string; type: string; message: string; defaultPrompt?: string };
  fileChooser?: { id: string; multiple: boolean };
}

export type DesktopBrowserPageAction =
  | { type: 'answer-dialog'; requestId: string; accept: boolean; promptText?: string }
  | { type: 'choose-files'; requestId: string; cancel?: boolean }
  | { type: 'new-tab' }
  | { type: 'select-tab' | 'close-tab'; tabId: string }
  | { type: 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'reload' | 'stop' }
  | { type: 'resize'; width: number; height: number }
  | { type: 'zoom'; factor: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string }
  | { type: 'composition'; text: string; selectionStart: number; selectionEnd: number }
  | { type: 'composition-end'; text: string }
  | {
      type: 'pointer';
      phase: 'mouseMoved' | 'mousePressed' | 'mouseReleased';
      x: number;
      y: number;
      button: 'none' | 'left' | 'middle' | 'right';
      buttons: number;
      modifiers: number;
      clickCount: number;
    }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number };

export type DesktopBrowserPageControl = DesktopBrowserPageAction & { documentId: string };

export type DesktopRemoteBrowserControl =
  | { type: 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'reload' | 'stop' }
  | { type: 'tap'; frameId: string; x: number; y: number }
  | {
      type: 'swipe';
      frameId: string;
      from: { x: number; y: number };
      to: { x: number; y: number };
    }
  | {
      type: 'scroll';
      frameId: string;
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
    }
  | { type: 'text'; frameId: string; documentId?: string; text: string }
  | { type: 'key'; frameId: string; documentId?: string; key: string };
