/**
 * Everything the host remembers about one guest page, in one place. Refs,
 * visual grounding, dialogs, console and network ledgers, crash state and the
 * remote-frame cache share a single record per WebContents, which keeps their
 * lifetimes aligned and makes "forget what this page looked like" a one-line
 * operation.
 */
import type { WebContents } from 'electron';

import { BrowserConsoleLedger } from './console';
import { BRIDGED_DIALOG_TYPES } from './dialog-bridge';
import type { DismissedBrowserDialog, PendingBrowserDialog } from './dialog-report';
import type { BrowserDragData } from './input';
import { BrowserNetworkLedger } from './network';
import type { ActiveBrowserPerformanceTrace } from './performance';
import { redactBrowserKnownSecrets, redactBrowserText } from './redaction';
import type { VisualGrounding } from './ref-points';
import type { BrowserRefSet } from './ref-recovery';
import type { AccessibilityRefSnapshot } from './snapshot-capture';

interface CdpTargetSession {
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
interface BrowserDiagnostics {
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

interface BrowserGuestState extends BrowserDiagnostics {
  readonly pageId: string;
  snapshotGeneration: number;
  documentGeneration: number;
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

type OptionalKeys = {
  [K in keyof BrowserGuestState]-?: undefined extends BrowserGuestState[K] ? K : never;
}[keyof BrowserGuestState];

export class BrowserGuestStateStore {
  private readonly states = new WeakMap<WebContents, BrowserGuestState>();
  private nextPageId = 0;

  /** `rendererPeers`: the other live pages sharing a guest's renderer process. */
  constructor(private readonly rendererPeers: (guest: WebContents) => WebContents[] = () => []) {}

  /** The record for a guest, created on first touch. */
  for(guest: WebContents): BrowserGuestState {
    const existing = this.states.get(guest);
    if (existing) return existing;
    const created: BrowserGuestState = {
      pageId: `p${++this.nextPageId}`,
      snapshotGeneration: 0,
      documentGeneration: 0,
      // Downloads are shared by the session, so a page that opens with this at
      // zero announces every file the session ever saved — including ones saved
      // before it existed. A new page has already heard about all of them.
      downloadsReportedAt: Date.now(),
      openedPopups: [],
      crashed: false,
      userInput: false,
      pendingDialog: null,
      dismissedDialog: null,
      pendingFileChooser: null,
      console: new BrowserConsoleLedger((value) => this.redactText(guest, value)),
      networkFailures: [],
      reportedNetworkFailures: new Set(),
      refusedRequests: new Map(),
      network: new BrowserNetworkLedger(),
      cdpSessions: new Map(),
      browserComponentContexts: new Set(),
      consoleReplay: { seen: new Map(), floor: new Map() },
      fault: '',
    };
    this.states.set(guest, created);
    return created;
  }

  peek(guest: WebContents): BrowserGuestState | undefined {
    return this.states.get(guest);
  }

  /** The request policy's reason for refusing a URL this page asked for. */
  recordRefusedRequest(guest: WebContents, url: string, reason: string): void {
    const refused = this.states.get(guest)?.refusedRequests;
    if (!refused) return;
    refused.delete(url);
    refused.set(url, reason.slice(0, 300));
    if (refused.size > 50) refused.delete(refused.keys().next().value as string);
  }

  pageId(guest: WebContents): string {
    return this.for(guest).pageId;
  }

  nextSnapshotId(guest: WebContents): string {
    const state = this.for(guest);
    state.snapshotGeneration += 1;
    return `${state.pageId}-s${state.snapshotGeneration}`;
  }

  /** Forget everything bound to the current document: refs, image grounding
   *  and the remote frame. Called whenever the page may have changed. */
  invalidateInteraction(guest: WebContents): void {
    const state = this.states.get(guest);
    if (!state) return;
    state.accessibilityRefs = undefined;
    state.refSet = undefined;
    state.visualGrounding = undefined;
  }

  markCrashed(guest: WebContents, fault: string): void {
    const state = this.for(guest);
    state.fault = fault;
    state.crashed = true;
    // The dead renderer's prompts went with it; answering them reaches nothing.
    state.pendingDialog = null;
    state.pendingFileChooser = null;
    this.invalidateInteraction(guest);
  }

  /** CDP sessions ended: one child target, or, with no id, the debugger and
   *  every session under it. Nothing can answer the prompts they held any
   *  more, so those prompts are settled as dismissed instead of left pending. */
  endTargetSession(guest: WebContents, sessionId?: string): void {
    const state = this.states.get(guest);
    if (!state) return;
    const ended = (owner: string | undefined) => sessionId === undefined || owner === sessionId;
    if (sessionId === undefined) {
      state.cdpSessions.clear();
      state.browserComponentContexts.clear();
    } else {
      state.cdpSessions.delete(sessionId);
      for (const key of state.browserComponentContexts) {
        if (key.startsWith(`${sessionId}:`)) state.browserComponentContexts.delete(key);
      }
    }
    if (state.pendingDialog && ended(state.pendingDialog.sessionId)) state.pendingDialog = null;
    if (state.pendingFileChooser && ended(state.pendingFileChooser.sessionId)) state.pendingFileChooser = null;
  }

  /** Another page sharing this guest's renderer process whose dialog is open.
   *  A JavaScript dialog pauses the whole process, so that dialog blocks
   *  this page as well. */
  dialogOwner(guest: WebContents): WebContents | null {
    return this.rendererPeers(guest).find((peer) => this.states.get(peer)?.pendingDialog) ?? null;
  }

  /** The dialog holding a guest: its own, else a renderer peer's. */
  blockingDialog(guest: WebContents): { owner: WebContents; dialog: PendingBrowserDialog } | null {
    const own = this.states.get(guest)?.pendingDialog;
    if (own) return { owner: guest, dialog: own };
    const owner = this.dialogOwner(guest);
    const dialog = owner && this.states.get(owner)?.pendingDialog;
    return owner && dialog ? { owner, dialog } : null;
  }

  /** Chromium closed a native dialog. Guests disable the page's own dialogs,
   *  so one that nobody here answered was dismissed by itself: it fired where
   *  the bridge was not yet installed, and is kept as a notice. */
  nativeDialogClosed(guest: WebContents, sessionId: string | undefined): void {
    const state = this.states.get(guest);
    const dialog = state?.pendingDialog;
    if (!state || !dialog || dialog.bridgeRequestId || dialog.sessionId !== sessionId) return;
    state.pendingDialog = null;
    if (!dialog.answering && BRIDGED_DIALOG_TYPES.has(dialog.type)) this.noteDismissedDialog(guest, dialog, 'early');
  }

  noteDismissedDialog(
    guest: WebContents,
    dialog: { type: string; message: string },
    reason: DismissedBrowserDialog['reason']
  ): void {
    this.for(guest).dismissedDialog = { type: dialog.type, message: dialog.message, reason };
  }

  /** Report and clear the crash flag in one step. */
  takeCrashed(guest: WebContents): boolean {
    const state = this.states.get(guest);
    if (!state?.crashed) return false;
    state.crashed = false;
    return true;
  }

  rememberSecret(guest: WebContents, secret: string): Set<string> {
    const state = this.for(guest);
    state.sensitiveValues ??= new Set();
    state.sensitiveValues.add(secret);
    return state.sensitiveValues;
  }

  forgetSecret(guest: WebContents, secret: string): void {
    const state = this.states.get(guest);
    if (!state?.sensitiveValues) return;
    state.sensitiveValues.delete(secret);
    if (!state.sensitiveValues.size) state.sensitiveValues = undefined;
  }

  /** Retire the old document's interaction state and picker. Known secrets
   *  remain redacted across redirects. */
  beginDocument(guest: WebContents, sameDocument = false): void {
    const state = this.states.get(guest);
    if (!state) return;
    state.documentGeneration += 1;
    this.invalidateInteraction(guest);
    // Secrets remain sensitive after redirects, including echoed form values.
    state.pendingFileChooser = null;
    // A fresh document answers for its own requests only. Carrying the last
    // page's failures forward reports them as faults of the page now loaded;
    // an in-document navigation keeps them, because nothing reloaded.
    if (!sameDocument) {
      state.networkFailures.length = 0;
      state.reportedNetworkFailures.clear();
      state.console.clearDocument();
    }
  }

  /** A new document replaced the old one (a navigation that merely started may
   *  still end as a download or be cancelled): the old document's dialogs and
   *  whatever a person entered there are gone with it. */
  commitDocument(guest: WebContents): void {
    const state = this.states.get(guest);
    if (!state) return;
    state.pendingDialog = null;
    state.dismissedDialog = null;
    state.userInput = false;
  }

  /** Text bound for the caller, minus the page's known secrets. */
  redactText(guest: WebContents, value: unknown): string {
    return redactBrowserKnownSecrets(redactBrowserText(value), this.states.get(guest)?.sensitiveValues || []);
  }

  slot<K extends OptionalKeys>(key: K): GuestSlot<NonNullable<BrowserGuestState[K]>> {
    return {
      get: (guest) => this.states.get(guest)?.[key] as NonNullable<BrowserGuestState[K]> | undefined,
      set: (guest, value) => {
        this.for(guest)[key] = value;
      },
      has: (guest) => this.states.get(guest)?.[key] !== undefined,
      delete: (guest) => {
        const state = this.states.get(guest);
        if (!state || state[key] === undefined) return false;
        state[key] = undefined;
        return true;
      },
    };
  }
}

/** The identity every input, display frame and approval binds itself to:
 *  which page, and which document generation inside that page. A reload or
 *  navigation retires it, so nothing observed before can act afterwards. */
export function browserDocumentId(state: Pick<BrowserGuestStateStore, 'pageId' | 'for'>, guest: WebContents): string {
  return `${state.pageId(guest)}:${state.for(guest).documentGeneration}`;
}

/** Append to a capped diagnostic list, redacting and trimming the entry. */
export function pushBounded(target: string[], value: string, max = 30): void {
  target.push(redactBrowserText(String(value).slice(0, 4_000)));
  if (target.length > max) target.splice(0, target.length - max);
}
