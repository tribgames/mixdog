/**
 * What the browser host's modules share without owning: the Browser Use command
 * contract as the host sees it with the limits every module shares (the runtime
 * schema is the public authority; these types only describe what reaches the
 * host), the record the host keeps of one guest page (host-state.ts holds it),
 * and the host's own interface. Staying modules import these from here, never
 * from guest-state.ts, command.ts, host.ts or host-foundation.ts.
 */
import type { WebContents } from 'electron';

import {
  BROWSER_OBSERVATION_ACTIONS,
  BROWSER_POSTCONDITION_ACTIONS,
  BROWSER_SEQUENCE_STEP_ACTIONS,
} from '../../shared/core-src/runtime/browser-bridge/browser-action-contract.mjs';
import type { BrowserPostcondition, BrowserPostconditionInput } from './postcondition';
import type { BrowserRefSet } from './ref-recovery';
import type { BrowserTargetSpec } from './target-resolve';
import type { BrowserConsoleLedger } from './console';
import type { DismissedBrowserDialog, PendingBrowserDialog } from './dialog-report';
import type { BrowserDragData } from './input';
import type { BrowserNetworkLedger } from './network';
import type { ActiveBrowserPerformanceTrace } from './performance';
import type { PageActor, WindowOpenGesture } from './popup-focus';
import type { VisualGrounding } from './ref-points';
import type { AccessibilityRefSnapshot } from './snapshot-capture';

/** Must match the renderer BrowserPane's <webview partition>. */
export const BROWSER_PARTITION = 'persist:mixdog-browser';
export const OPEN_SURFACE_TIMEOUT_MS = 8_000;
export const NAVIGATE_SETTLE_TIMEOUT_MS = 20_000;
export const ACTION_SETTLE_QUIET_MS = 350;
export const ACTION_SETTLE_LOAD_TIMEOUT_MS = 8_000;
export const ACTION_SETTLE_DOM_TIMEOUT_MS = 1_500;
export const CDP_REQUEST_TIMEOUT_MS = 12_000;
export const COMMAND_TIMEOUT_MS = 42_000;
export const BACKGROUND_RECLAIM_INTERVAL_MS = 60_000;
export const SNAPSHOT_MAX_ELEMENTS = 160;
const SNAPSHOT_TEXT_CHARS = 2_400;
export const READ_DEFAULT_CHARS = 8_000;
export const READ_MAX_CHARS = 30_000;
export const EVALUATE_DEFAULT_CHARS = 12_000;
export const MAX_EVALUATE_SCRIPT_CHARS = 100_000;
export const DOWNLOAD_ATTACH_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_CHILD_CDP_SESSIONS = 64;
export const MAX_PRINTED_PDF_BYTES = 100 * 1024 * 1024;
export const SCREENSHOT_TIMEOUT_MS = 8_000;
export const SCREENSHOT_FALLBACK_TIMEOUT_MS = 2_000;
export const EXTRACT_DEFAULT_LIMIT = 50;
export const EXTRACT_MAX_LIMIT = 200;
export const EXTRACT_DEFAULT_CHARS = 12_000;
/** Custom dropdowns paint their popup from page scripts; poll for it instead
 *  of paying a fixed delay, since most menus are ready within a frame. */
export const CUSTOM_DROPDOWN_TIMEOUT_MS = 400;
export const CUSTOM_DROPDOWN_POLL_MS = 25;
export const POSTCONDITION_POLL_MS = 100;
/** Offscreen (background) page viewport. Fixed and generous so fixed-width
 *  desktop layouts render without a scrollbar the agent can't see. */
export const OFFSCREEN_VIEWPORT = { width: 1280, height: 900 } as const;
export const POSTCONDITION_ACTIONS: ReadonlySet<string> = new Set(BROWSER_POSTCONDITION_ACTIONS);
/** Pure observations can overlap. Snapshot-producing observations also write
 *  the ref/visual generation and therefore require the page's exclusive lane. */
export const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set(
  BROWSER_OBSERVATION_ACTIONS.filter((action) => !['snapshot', 'locate', 'wait'].includes(action))
);
/** Gestures a sequence may chain. The runtime schema is the authority; the
 *  host re-checks so a malformed bridge call can never drive an odd action. */
export const SEQUENCE_STEP_ACTIONS: ReadonlySet<string> = new Set(BROWSER_SEQUENCE_STEP_ACTIONS);
/** Bookkeeping actions that address a session, never a page. */
export const TABLESS_ACTIONS: ReadonlySet<string> = new Set(['list_tabs', 'downloads', 'close_tab', 'hide']);
/** Actions that may run while a JavaScript dialog blocks the page. Anything
 *  else would queue behind the dialog and fire after it closes, so the host
 *  refuses it up front instead of dispatching a ghost gesture. */
export const DIALOG_TOLERANT_ACTIONS: ReadonlySet<string> = new Set(['handle_dialog', 'status', 'console', 'network']);
/** Gestures whose reply says when the page did not react to them. Navigation
 *  and evaluation change the page by definition, so they are left out, and so
 *  is hover: a menu that opens on :hover leaves the document untouched, so
 *  "nothing happened" would be wrong far more often than right. */
export const EFFECT_REPORT_ACTIONS: ReadonlySet<string> = new Set([
  'click',
  'fill',
  'type',
  'select',
  'drag',
  'upload',
  'handle_dialog',
  'press',
  'scroll',
  'sequence',
]);

export interface BrowserCommand {
  action: string;
  url?: string;
  ref?: string;
  /** Snapshot-free element target; an alternative to ref. */
  target?: BrowserTargetSpec;
  targetRef?: string;
  /** Snapshot-free drag destination; an alternative to targetRef. */
  dropTarget?: BrowserTargetSpec;
  snapshotId?: string;
  x?: number;
  y?: number;
  targetX?: number;
  targetY?: number;
  mode?: string;
  pointer?: string;
  button?: string;
  modifiers?: string[];
  script?: string;
  requestId?: string;
  resourceTypes?: string[];
  limit?: number;
  frameLimit?: number;
  operation?: string;
  storageType?: string;
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expirationDate?: number;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  touch?: boolean;
  userAgent?: string;
  locale?: string;
  timezone?: string;
  colorScheme?: string;
  reducedMotion?: boolean;
  networkProfile?: string;
  cpuThrottlingRate?: number;
  orientation?: string;
  /** emulate: geolocation override. Latitude and longitude travel together. */
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  /** emulate: extra HTTP headers added to every request the page makes. */
  headers?: Record<string, string>;
  /** intercept: refuse the matched request instead of answering it. */
  abort?: boolean;
  /** intercept: payload that replaces the matched response body. */
  body?: string;
  /** intercept: rule handle from an intercept list. */
  ruleId?: string;
  /** init_script: registered script handle from an init_script list. */
  scriptId?: string;
  reset?: boolean;
  reload?: boolean;
  saveTrace?: boolean;
  wait?: boolean;
  attach?: boolean;
  downloadId?: string;
  text?: string;
  textGone?: string;
  submit?: boolean;
  /** fill: complete the sign-in form from a stored login (account or its
   *  masked label); the password stays inside the host. */
  savedAccount?: string;
  /** fill: the text is a code or secret, registered for redaction before
   *  the page sees it. */
  sensitive?: boolean;
  key?: string;
  dy?: number;
  dx?: number;
  maxChars?: number;
  offset?: number;
  query?: string;
  viewportOnly?: boolean;
  maxElements?: number;
  values?: string[];
  checked?: boolean;
  doubleClick?: boolean;
  fullPage?: boolean;
  format?: string;
  quality?: number;
  level?: string;
  accept?: boolean;
  promptText?: string;
  fields?: Array<{
    ref?: string;
    target?: BrowserTargetSpec;
    text?: string;
    value?: string;
    values?: string[];
    checked?: boolean;
  }>;
  paths?: string[];
  /** extract: CSS selector matching the repeated rows to collect. */
  selector?: string;
  /** extract: attribute names copied from every match. */
  attributes?: string[];
  /** sequence: 2-6 ref-based gestures performed in order on one page. */
  steps?: Array<{
    action?: string;
    ref?: string;
    target?: BrowserTargetSpec;
    text?: string;
    values?: string[];
    checked?: boolean;
    key?: string;
    submit?: boolean;
    savedAccount?: string;
    dx?: number;
    dy?: number;
    textGone?: string;
    url?: string;
    timeoutMs?: number;
  }>;
  /** Runtime-internal, never part of the public schema: one step of a running
   *  sequence. It skips the per-gesture snapshot because the sequence takes
   *  one observation after its steps finish. */
  internalStep?: boolean;
  /** wait ceiling in milliseconds (500–30000; default 10000). */
  timeoutMs?: number;
  /** Optional postcondition verified after one dispatch; failed actions are
   *  never replayed and return a fresh diagnostic snapshot. */
  expect?: BrowserPostconditionInput;
  /** Explicit delay before the final snapshot (0–5000ms). */
  settleMs?: number;
  /** Attach a screenshot bound to the final fresh snapshotId. */
  includeScreenshot?: boolean;
  /** Reply with only what changed since the previous observation. */
  brief?: boolean;
  /** inline keeps the screenshot in the reply; file writes it beside the run. */
  image_output?: string;
  /** Tab target: "v1"/"v2"… = visible tabs (list_tabs order); any other name
   *  = a named background page, created on demand with background:true. */
  tab?: string;
  /** Run against a hidden offscreen page instead of the visible tab. Shares
   *  the same partition, so cookies/logins carry over. */
  background?: boolean;
  /** Runtime-injected resource-budget identity; not part of the public schema. */
  session_id?: string;
  turn_id?: number;
  /** Runtime-set, never a tool argument: the command belongs to a schedule or
   *  webhook run, whose saved routine already granted submits, posts and
   *  uploads (a bot's `block` still applies). */
  unattended_run?: boolean;
  /** Runtime-set with `unattended_run`: the bot that owns the run ('' unknown). */
  unattended_agent?: string;
  /** Runtime-set, never a tool argument: the life the session is in (it changes
   *  when the session is cleared or replaced); "allow for this session" binds to it. */
  session_life?: string;
  /** Runtime-set, never a tool argument: navigate's `url` is a link of a mail
   *  the runtime read for this session, so it may carry a token (url-policy.ts). */
  mail_link?: import('./url-policy').BrowserMailLink;
}

export interface BrowserCommandResult {
  text: string;
  /** Bridge diagnostics; never appended to the model's page content. */
  timing?: import('./timing').BrowserCommandTiming;
  outcome?: 'completed' | 'blocked' | 'inconclusive';
  image?: { mimeType: string; data: string };
  file?: { mimeType: string; data: string; name: string };
}

export interface BrowserSnapshotResultOptions {
  expected?: BrowserPostcondition | null;
  preexistingPostcondition?: boolean;
  settleAction?: boolean;
  includeScreenshot?: boolean;
  targetIsBackground?: boolean;
  /** The observation the gesture started from, for change reporting. */
  baseline?: BrowserRefSet;
  /** Report comparison before internal target resolution narrows the ref set. */
  reportBaseline?: BrowserRefSet;
}

export function normalizeBrowserAction(command: Pick<BrowserCommand, 'action'>): string {
  return String(command.action || '')
    .trim()
    .toLowerCase();
}

/** How much page text a snapshot may carry; evaluate replies keep it short
 *  because the script result already occupies the reply. */
export function snapshotTextLimit(command: BrowserCommand): number {
  if (normalizeBrowserAction(command) === 'evaluate') {
    return SNAPSHOT_TEXT_CHARS;
  }
  return boundedInteger(command.maxChars, SNAPSHOT_TEXT_CHARS, 1, READ_MAX_CHARS);
}

/** Clamp a caller-supplied integer into [min, max], falling back when absent. */
export function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? Math.trunc(value as number) : fallback));
}

/** A caller-supplied character budget capped at `max`; anything but a positive
 *  number takes the fallback instead of shrinking the reply to nothing. */
export function browserCharLimit(value: unknown, fallback: number, max: number): number {
  return Math.min(max, Number.isFinite(value) && (value as number) > 0 ? Math.trunc(value as number) : fallback);
}

/** What moved in a page's record, for whoever publishes the page's facts.
 *  `background`: the page joined or left the session's background pages, or
 *  changed what kind of page it is there (an agent's page a person took as
 *  a tab), so its `background` fact moved without a panel showing or hiding it. */
export type GuestChangeReason = 'document' | 'dialog' | 'chooser' | 'crash' | 'session' | 'popup' | 'background';

/** What the record tells an observer: a fact changed, or the host itself
 *  logged or refused something the core must see in order with the page's own
 *  events (`Mixdog.internalConsole`, `Mixdog.requestRefused`). */
export type GuestStateEvent =
  | { kind: 'changed'; reason: GuestChangeReason }
  | { kind: 'internalConsole'; text: string }
  | { kind: 'requestRefused'; url: string; reason: string };

export type GuestStateListener = (guest: WebContents, event: GuestStateEvent) => void;

export interface CdpTargetSession {
  type: string;
  url: string;
  frameId: string;
  parentSessionId?: string;
  ready: Promise<void>;
}

/** A native file picker the page asked for. Chromium hands it to the host
 *  instead of showing it, and `upload` answers it with the approved paths. */
export interface PendingFileChooser {
  mode: string;
  backendNodeId?: number;
  frameId?: string;
  sessionId?: string;
  openedAt: number;
}

/** The page-health view every report reads: what blocks it, what it logged,
 *  and which CDP child sessions currently belong to it. */
export interface BrowserDiagnostics {
  pendingDialog: PendingBrowserDialog | null;
  /** The latest dialog this document opened that was dismissed unseen. */
  dismissedDialog: DismissedBrowserDialog | null;
  pendingFileChooser: PendingFileChooser | null;
  console: BrowserConsoleLedger;
  networkFailures: string[];
  /** Failures a reply has already carried: each is said once, like a console
   *  error, instead of riding every reply for the rest of the document. */
  reportedNetworkFailures: Set<string>;
  /** Why the request policy refused a URL, newest last and capped. Kept across
   *  documents: a navigation is refused before the next document begins. */
  refusedRequests: Map<string, string>;
  network: BrowserNetworkLedger;
  cdpSessions: Map<string, CdpTargetSession>;
  /** Execution contexts (`session:id`) running Chromium's own bundled
   *  components, such as the PDF viewer. Whatever they log is not page content. */
  browserComponentContexts: Set<string>;
  /** Console and log entries come up again whenever the driving domains are
   *  switched back on (see cdp-session-init). Per session and domain: the
   *  newest entry recorded, and while a switch is replaying, the newest one
   *  the replay may skip. */
  consoleReplay: { seen: Map<string, number>; floor: Map<string, number> };
  fault: string;
}

export interface BrowserGuestState extends BrowserDiagnostics {
  readonly pageId: string;
  /** Rises by one for every notification the host sends the core about this
   *  page (events batch or facts), so a gap on the core's side is a lost one. */
  seq: number;
  /** When `dismissedDialog` was set. */
  dismissedDialogAt?: number;
  /** When a person first touched this document (stamped when facts are built). */
  userInputAt?: number;
  snapshotGeneration: number;
  documentGeneration: number;
  /** Counts the loads of a document: an in-document navigation advances `documentGeneration` and leaves this. */
  loadGeneration: number;
  /** When a snapshot last told the caller about this page's downloads. */
  downloadsReportedAt: number;
  /** Names of pages this one opened that the caller has not been told about.
   *  A gesture that spawns a tab leaves this document untouched, so without
   *  this the reply would claim the gesture did nothing at all. */
  openedPopups: string[];
  /** Renderer death leaves a live WebContents whose document is gone: CDP
   *  calls and every ref bound to that document fail until the page reloads. */
  crashed: boolean;
  /** A person clicked or typed into this document. What they entered lives
   *  only in the document, so it must not be unloaded to save memory. */
  userInput: boolean;
  /** Who acted on this document last: a person's press, key or dialog
   *  answer, or an agent command. A window it opens is that actor's. */
  actor?: PageActor;
  /** When the person last answered one of this document's dialogs. */
  personDialogAnswerAt?: number;
  /** Chromium's recent Page.windowOpen reports: whether each window being
   *  opened had a user gesture (popup-focus). */
  windowOpens: WindowOpenGesture[];
  accessibilityRefs?: AccessibilityRefSnapshot;
  refSet?: BrowserRefSet;
  visualGrounding?: VisualGrounding;
  performanceTrace?: ActiveBrowserPerformanceTrace;
  /** Secrets typed into this document; redacted from every reply. */
  sensitiveValues?: Set<string>;
  /** The payload Chromium handed over instead of running the page's own
   *  HTML5 drag, so the driver can finish that gesture as drag events. */
  interceptedDrag?: BrowserDragData;
  /** Woken by the event carrying that payload, so a gesture never waits out
   *  a timeout Chromium has already answered. */
  notifyInterceptedDrag?: (data: BrowserDragData) => void;
}

/** A WeakMap-shaped window onto one field of every guest's state, so modules
 *  that only care about (say) the ref table keep a narrow dependency. */
export interface GuestSlot<T> {
  get(guest: WebContents): T | undefined;
  set(guest: WebContents, value: T): unknown;
  has(guest: WebContents): boolean;
  delete(guest: WebContents): boolean;
}

export type OptionalKeys = {
  [K in keyof BrowserGuestState]-?: undefined extends BrowserGuestState[K] ? K : never;
}[keyof BrowserGuestState];

export type { BrowserHost } from './host';
export type { BrowserHostFoundation } from './host-foundation';
