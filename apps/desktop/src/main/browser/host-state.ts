import type { WebContents } from 'electron';

import { BrowserConsoleLedger } from './console';
import { BRIDGED_DIALOG_TYPES } from './dialog-bridge';
import type { DismissedBrowserDialog, PendingBrowserDialog } from './dialog-report';
import type {
  BrowserGuestState,
  GuestChangeReason,
  GuestSlot,
  GuestStateEvent,
  GuestStateListener,
  OptionalKeys,
} from './host-types';
import { BrowserNetworkLedger, InflightRequestTypes } from './network';
import { redactBrowserKnownSecrets, redactBrowserText } from './redaction';

/** The console ledger of a guest: the browser's own faults also reach the observer. */
class GuestConsoleLedger extends BrowserConsoleLedger {
  constructor(
    sanitize: (value: string) => string,
    private readonly onInternal: (text: string) => void
  ) {
    super(sanitize);
  }

  override recordInternal(text: unknown): void {
    super.recordInternal(text);
    this.onInternal(String(text || ''));
  }
}

export class BrowserGuestStateStore {
  private readonly states = new WeakMap<WebContents, BrowserGuestState>();
  private lastIssued = 0;
  private readonly listeners = new Set<GuestStateListener>();
  private nextPageId = 0;

  /** `rendererPeers`: the other live pages sharing a guest's renderer process. */
  constructor(private readonly rendererPeers: (guest: WebContents) => WebContents[] = () => []) {}

  /** Calls `listener` after every change of a page's facts and for every
   *  host-made console or refusal entry. Returns the function that stops it. */
  onChange(listener: GuestStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A fact of the page changed in a way only the caller can see (a dialog or
   *  file chooser it recorded straight into the record). */
  changed(guest: WebContents, reason: GuestChangeReason): void {
    this.emit(guest, { kind: 'changed', reason });
  }

  /** The next notification number of the page. */
  nextSeq(guest: WebContents): number {
    return ++this.for(guest).seq;
  }

  private emit(guest: WebContents, event: GuestStateEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(guest, event);
      } catch {
        // An observer's failure never reaches the page's own bookkeeping.
      }
    }
  }

  /** The record for a guest, created on first touch. */
  for(guest: WebContents): BrowserGuestState {
    const existing = this.states.get(guest);
    if (existing) return existing;
    const created: BrowserGuestState = {
      pageId: `p${++this.nextPageId}`,
      seq: 0,
      snapshotGeneration: 0,
      documentGeneration: this.issue(),
      loadGeneration: this.issue(),
      // Downloads are shared by the session, so a page that opens with this at
      // zero announces every file the session ever saved — including ones saved
      // before it existed. A new page has already heard about all of them.
      downloadsReportedAt: Date.now(),
      openedPopups: [],
      windowOpens: [],
      crashed: false,
      userInput: false,
      userEdits: false,
      agentEdits: false,
      documentCommits: 0,
      pendingDialog: null,
      dismissedDialog: null,
      pendingFileChooser: null,
      console: new GuestConsoleLedger(
        (value) => this.redactText(guest, value),
        (text) => this.emit(guest, { kind: 'internalConsole', text })
      ),
      networkFailures: [],
      reportedNetworkFailures: new Set(),
      refusedRequests: new Map(),
      network: new BrowserNetworkLedger(),
      requestTypes: new InflightRequestTypes(),
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
    this.emit(guest, { kind: 'requestRefused', url, reason: reason.slice(0, 300) });
  }

  pageId(guest: WebContents): string {
    return this.for(guest).pageId;
  }

  /** A page recreated by a session restore takes the tab id its unloaded
   *  predecessor had, so every holder of that id (chips, takeover cards, a
   *  borrowed tab, a paired client) still addresses it. Ids are never reused,
   *  and the predecessor is gone, so the id is free. */
  adoptPage(guest: WebContents, pageId: string): void {
    // The guest's numbers were issued globally when its record was made, so
    // none was ever used under any tab id: only the id changes.
    (this.for(guest) as { pageId: string }).pageId = pageId;
  }

  private issue(): number {
    return ++this.lastIssued;
  }

  nextSnapshotId(guest: WebContents): string {
    const state = this.for(guest);
    state.snapshotGeneration = this.issue();
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
    // The dead renderer's prompts and edits went with it; answering them reaches nothing.
    state.pendingDialog = null;
    state.pendingFileChooser = null;
    state.userEdits = false;
    state.agentEdits = false;
    state.documentCommits += 1;
    this.invalidateInteraction(guest);
    this.changed(guest, 'crash');
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
      state.consoleReplay.seen.clear();
      state.consoleReplay.floor.clear();
    } else {
      state.cdpSessions.delete(sessionId);
      for (const channel of ['runtime', 'log']) {
        state.consoleReplay.seen.delete(`${sessionId}|${channel}`);
        state.consoleReplay.floor.delete(`${sessionId}|${channel}`);
      }
      for (const key of state.browserComponentContexts) {
        if (key.startsWith(`${sessionId}:`)) state.browserComponentContexts.delete(key);
      }
    }
    if (state.pendingDialog && ended(state.pendingDialog.sessionId)) state.pendingDialog = null;
    if (state.pendingFileChooser && ended(state.pendingFileChooser.sessionId)) state.pendingFileChooser = null;
    this.changed(guest, 'session');
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
    else this.changed(guest, 'dialog');
  }

  noteDismissedDialog(
    guest: WebContents,
    dialog: { type: string; message: string },
    reason: DismissedBrowserDialog['reason']
  ): void {
    const state = this.for(guest);
    state.dismissedDialog = { type: dialog.type, message: dialog.message, reason };
    state.dismissedDialogAt = Date.now();
    this.changed(guest, 'dialog');
  }

  /** Report and clear the crash flag in one step. */
  takeCrashed(guest: WebContents): boolean {
    const state = this.states.get(guest);
    if (!state?.crashed) return false;
    state.crashed = false;
    this.changed(guest, 'crash');
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
    state.documentGeneration = this.issue();
    this.invalidateInteraction(guest);
    // Secrets remain sensitive after redirects, including echoed form values.
    state.pendingFileChooser = null;
    // A fresh document answers for its own requests only. Carrying the last
    // page's failures forward reports them as faults of the page now loaded;
    // an in-document navigation keeps them, because nothing reloaded.
    if (!sameDocument) {
      state.loadGeneration = this.issue();
      state.networkFailures.length = 0;
      state.reportedNetworkFailures.clear();
      state.console.clearDocument();
    }
    this.changed(guest, 'document');
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
    state.userEdits = false;
    state.agentEdits = false;
    state.actor = undefined;
    state.personDialogAnswerAt = undefined;
    state.dismissedDialogAt = undefined;
    state.userInputAt = undefined;
    state.windowOpens = [];
    state.documentCommits += 1;
    this.changed(guest, 'document');
  }

  /** What reclaiming the page would lose because only its live document has
   *  it: a person's edits, a dialog or file chooser waiting for an answer, a
   *  secret typed for a sign-in, and while `turnLive` (its session's turn is
   *  running or waiting on the user) the agent's own edits. Every idle
   *  reclaim keeps such a page. */
  holdsUnfinishedWork(guest: WebContents, turnLive: boolean): boolean {
    const state = this.states.get(guest);
    return Boolean(
      state &&
        (state.userEdits ||
          (turnLive && state.agentEdits) ||
          state.pendingDialog ||
          state.pendingFileChooser ||
          state.sensitiveValues?.size)
    );
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

/** An edit about to reach the page `record` describes, a person's
 *  (`userEdits`) or the agent's (`agentEdits`). Call the returned function
 *  once the page has taken it: the document then holds it, unless a new
 *  document committed meanwhile and the edit went with the old one. */
export function beginEdit(
  record: Pick<BrowserGuestState, 'documentCommits' | 'userEdits' | 'agentEdits'>,
  by: 'userEdits' | 'agentEdits'
): () => void {
  const commits = record.documentCommits;
  return () => {
    if (record.documentCommits === commits) record[by] = true;
  };
}

/** Append to a capped diagnostic list, redacting and trimming the entry. */
export function pushBounded(target: string[], value: string, max = 30): void {
  target.push(redactBrowserText(String(value).slice(0, 4_000)));
  if (target.length > max) target.splice(0, target.length - max);
}
