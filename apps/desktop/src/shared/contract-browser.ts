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

export type DesktopVaultLoginSource = 'chat' | 'manual' | 'chrome' | 'csv';

/** A saved login as 설정 › 인증 관리 lists it: never a password or an
 *  authenticator key, only whether one is stored. */
export interface DesktopVaultLogin {
  id: string;
  origin: string;
  username: string;
  hasPassword: boolean;
  hasTotp: boolean;
  source: DesktopVaultLoginSource;
  note: string;
  /** False after the site was signed out here: auto sign-in skips it. */
  autoSignIn: boolean;
}

/** Add (no id) or edit (id) from 설정 › 인증 관리. A blank password keeps the
 *  saved one; a blank authenticator key removes it. Secrets flow in only. */
export interface DesktopVaultLoginInput {
  id?: string;
  origin: string;
  username: string;
  password?: string;
  totpSecret?: string;
  note?: string;
}

/** A site the Browser Use profile stays signed in to; no cookie data. */
export interface DesktopBrowserSignedInSite {
  site: string;
  cookies: number;
}

/** A login takeover's sign-in window (main/browser/login-popup.ts): idle (not
 *  opened yet), open, closed (closed without 완료, still pending), refused (the
 *  provider refused an embedded sign-in), done, or unavailable (no such login
 *  takeover on this PC). */
export interface DesktopBrowserLoginStatus {
  state: 'idle' | 'open' | 'closed' | 'refused' | 'done' | 'unavailable';
  /** refused: who refused (Google). */
  provider?: string;
}

export interface DesktopBrowserCredentialFillResult {
  usernameFilled: boolean;
  passwordFilled: boolean;
  /** page-changed: a login takeover's bound page moved before the fill. */
  reason?: 'no-password-field' | 'password-field-unavailable' | 'page-changed';
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
  /** Present when it changed: a streaming phone drives the page's viewport,
   *  so its size wins over the pane's until it stops. */
  driving?: boolean;
}

/** A session's shown page entered or left element fullscreen (a video's own
 *  button, `requestFullscreen()`): the pane fills the fullscreen window. */
export interface DesktopBrowserFullscreenChange {
  sessionId: string;
  active: boolean;
}

export interface DesktopBrowserOpenRequest {
  sessionId: string;
  /** False creates or retains the surface without opening its session dock. */
  reveal?: boolean;
  /** Hide only: never create or release pages; overrides reveal. */
  hide?: boolean;
  /** A takeover hand-off: the user must act on the page, so the panel opens
   *  even where they closed it. Agent work alone never opens it. */
  handoff?: boolean;
  /** An agent's `open`: the page it showed (session-local id `p…`) and its title. */
  tabId?: string;
  title?: string;
  /** An agent's `open` that failed, and why: nothing is revealed for it. */
  error?: string;
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

/** Browser page ids of main-workspace browser tabs. They are user-only pages:
 *  never a conversation id, so agent automation can neither target nor close
 *  them. */
export const MAIN_BROWSER_PAGE_PREFIX = 'main-browser-';

/** A main-workspace browser tab as a paired client lists it: the page id is
 *  the stream/control key, the rest is display metadata. */
export interface DesktopRemoteBrowserTab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
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

/** What the in-app browser saw of a page: its title, its site icon and a
 *  208×132 screenshot, each as a data URL and each present only once known.
 *  A page never shown still answers its site's icon when the site was. */
export interface DesktopBrowserPageIdentity {
  url: string;
  title?: string;
  favicon?: string;
  thumbnail?: string;
}

/** A capture that lost a race against navigation or a resize owns no pixels for
 * the state that was asked about, and the page it would describe no longer
 * exists. Human browsing causes that race constantly, so the display answers
 * with this marker and asks again for whatever the page shows now, rather than
 * reporting an error for pixels it was always going to re-request. */
export interface DesktopBrowserPageResample {
  resample: true;
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
  /** The tab the session's agent last drove, and the turn that did; every
   *  pane showing the session follows it unless `paused` (the person picked a
   *  tab of their own during that turn). */
  agentPage?: { tabId: string; turn: number; paused: boolean };
  dialog?: DesktopBrowserPageDialog;
  fileChooser?: { id: string; multiple: boolean };
}

/** A page dialog waiting for a person: alert, confirm, prompt, or a leave
 *  confirmation (`beforeunload`, which carries no page text). An
 *  `answer-dialog` names it by `id`. */
export interface DesktopBrowserPageDialog {
  id: string;
  type: string;
  message: string;
  defaultPrompt?: string;
  /** A `permission` dialog names who asks and for what; the pane words it. */
  permission?: {
    /** The origin of the frame asking. */
    origin: string;
    /** The top-level site embedding it, when that is another site. */
    embedder?: string;
    /** What it asks for (`notifications`, `media:video`, `clipboard-read`, ...). */
    keys: string[];
  };
}

export type DesktopBrowserPageAction =
  | {
      type: 'answer-dialog';
      requestId: string;
      accept: boolean;
      promptText?: string;
      /** The prompt's default was accepted untouched (it may be longer than
       *  what the card showed and sent). */
      keepDefault?: boolean;
    }
  | { type: 'choose-files'; requestId: string; cancel?: boolean }
  /** `requestId`: the agent's open this tab is for; absent for a user's "+". */
  | { type: 'new-tab'; requestId?: string }
  | { type: 'select-tab'; tabId: string; follow?: 'agent' | 'resume' | 'view' }
  | { type: 'close-tab'; tabId: string }
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

/** Live view a paired client starts or renews: the largest image, in device
 * pixels, it can display. The desktop never encodes a larger frame. */
export interface DesktopRemoteBrowserStreamOptions {
  maxWidth: number;
  maxHeight: number;
}

/** One pushed live frame of a session's visible page. A client receives its
 * next frame only after acknowledging `seq` (or after the ack window lapses),
 * and that frame is always the newest one; superseded frames are dropped. */
export interface DesktopRemoteBrowserStreamFrame extends DesktopRemoteBrowserFrame {
  sessionId: string;
  /** Monotonic within one stream. */
  seq: number;
  documentId: string;
  /** CSS viewport the image depicts; pointer and wheel coordinates use it. */
  viewportWidth: number;
  viewportHeight: number;
  /** The session's tab strip, as the local pane shows it. Present on a host
   *  advertising `browserSessionTabs`. */
  tabs?: DesktopBrowserTab[];
  /** The page dialog the local pane offers; the client answers it with an
   *  `answer-dialog` control for this frame's document. */
  dialog?: DesktopBrowserPageDialog;
}

/** Human page input from a paired client: the local pane's own input set and
 * dialog answers, guarded by the document the client was showing when it was
 * produced. */
export type DesktopRemoteBrowserPageInput = Extract<
  DesktopBrowserPageAction,
  { type: 'pointer' | 'wheel' | 'text' | 'key' | 'composition' | 'composition-end' | 'answer-dialog' }
> & { documentId: string };

/** The phone pane's content box in CSS pixels and its device pixel ratio: a
 * host advertising `browserDrive` renders the streamed page at this size as a
 * mobile page while the client streams it. */
export interface DesktopRemoteBrowserViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

/** Reply to a `close-tab` control: the session's tabs left once the host finished closing. */
export interface DesktopBrowserTabControlResult {
  remainingTabs: number;
}

export type DesktopRemoteBrowserControl =
  | { type: 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'reload' | 'stop' }
  | ({ type: 'viewport' } & DesktopRemoteBrowserViewport)
  /** Tab chrome of the session's own browser; a host advertising `browserSessionTabs` takes these. */
  | { type: 'new-tab' }
  | { type: 'select-tab' | 'close-tab'; tabId: string }
  | DesktopRemoteBrowserPageInput;
