/**
 * The Browser Use command contract as the host sees it, plus the limits every
 * module shares. The runtime schema is the public authority; these types only
 * describe what reaches the host over the bridge.
 */
import {
  BROWSER_OBSERVATION_ACTIONS,
  BROWSER_POSTCONDITION_ACTIONS,
  BROWSER_SEQUENCE_STEP_ACTIONS,
} from '../../../../../src/runtime/browser-bridge/browser-action-contract.mjs';
import type { BrowserPostcondition, BrowserPostconditionInput } from './postcondition';

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
export const SNAPSHOT_TEXT_CHARS = 2_400;
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
/** Commands that only observe the page. They may overlap each other, while
 *  anything that can change the page still runs alone. */
export const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set(BROWSER_OBSERVATION_ACTIONS);
/** Gestures a sequence may chain. The runtime schema is the authority; the
 *  host re-checks so a malformed bridge call can never drive an odd action. */
export const SEQUENCE_STEP_ACTIONS: ReadonlySet<string> = new Set(BROWSER_SEQUENCE_STEP_ACTIONS);
/** Bookkeeping actions that address a session, never a page. */
export const TABLESS_ACTIONS: ReadonlySet<string> = new Set(['list_tabs', 'downloads', 'close_tab']);
/** Actions that may run while a JavaScript dialog blocks the page. Anything
 *  else would queue behind the dialog and fire after it closes, so the host
 *  refuses it up front instead of dispatching a ghost gesture. */
export const DIALOG_TOLERANT_ACTIONS: ReadonlySet<string> = new Set([
  'handle_dialog', 'status', 'console', 'network',
]);

export interface BrowserCommand {
  action: string;
  url?: string;
  ref?: string;
  targetRef?: string;
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
  wait?: boolean;
  attach?: boolean;
  downloadId?: string;
  text?: string;
  textGone?: string;
  submit?: boolean;
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
    text?: string;
    value?: string;
    values?: string[];
    checked?: boolean;
  }>;
  paths?: string[];
  confirm?: boolean;
  /** extract: CSS selector matching the repeated rows to collect. */
  selector?: string;
  /** extract: attribute names copied from every match. */
  attributes?: string[];
  /** sequence: 2-6 ref-based gestures performed in order on one page. */
  steps?: Array<{
    action?: string;
    ref?: string;
    text?: string;
    values?: string[];
    checked?: boolean;
    key?: string;
    submit?: boolean;
    dx?: number;
    dy?: number;
    textGone?: string;
    url?: string;
    timeoutMs?: number;
  }>;
  /** Runtime-internal, never part of the public schema: one step of a running
   *  sequence. It skips the per-gesture snapshot and the per-turn budget
   *  because the sequence itself already paid both. */
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
}

export interface BrowserCommandResult {
  text: string;
  image?: { mimeType: string; data: string };
  file?: { mimeType: string; data: string; name: string };
}

export interface BrowserSnapshotResultOptions {
  expected?: BrowserPostcondition | null;
  preexistingPostcondition?: boolean;
  settleAction?: boolean;
  includeScreenshot?: boolean;
  targetIsBackground?: boolean;
}

export function normalizeBrowserAction(command: Pick<BrowserCommand, 'action'>): string {
  return String(command.action || '').trim().toLowerCase();
}

/** How much page text a snapshot may carry; evaluate replies keep it short
 *  because the script result already occupies the reply. */
export function snapshotTextLimit(command: BrowserCommand): number {
  if (normalizeBrowserAction(command) === 'evaluate') {
    return SNAPSHOT_TEXT_CHARS;
  }
  return Math.min(
    READ_MAX_CHARS,
    Math.max(
      1,
      Number.isFinite(command.maxChars)
        ? Math.trunc(command.maxChars as number)
        : SNAPSHOT_TEXT_CHARS,
    ),
  );
}

/** Clamp a caller-supplied integer into [min, max], falling back when absent. */
export function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? Math.trunc(value as number) : fallback));
}
