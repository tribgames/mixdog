/**
 * What the host tells the core about a page: `PageFacts`, built from the
 * guest and its state record, and `host/browser/page/facts` sent whenever one
 * of them changes (the document, the load state, a dialog, a file chooser, a
 * crash, a popup, visibility). A notification is sent only when the facts
 * differ from the last ones sent, takes the page's next `seq`, and leaves
 * after the events the page has queued, so the core reads them in the order
 * they happened. Facts in a response carry the current `seq` without taking a
 * new one.
 */
import type { WebContents } from 'electron';

import type {
  BrowserPendingDialog,
  HostBrowserPageFactsParams,
  PageFacts,
} from '../../../../../../packages/protocol/src/index.ts';
import { type BrowserGuestStateStore, browserDocumentId } from '../../browser/guest-state';
import { redactBrowserUrl } from '../../browser/redaction';
import type { HostConnection } from '../connection';
import { type EngineEvents, pushInternalConsole, pushRequestRefused } from './events';
import { receiverKeyOf } from './precondition';

export const HOST_BROWSER_PAGE_FACTS = 'host/browser/page/facts';

/** What the facts need that the guest and its record do not hold. */
export interface FactsSource {
  /** The page is one of the agent's offscreen pages. */
  background(guest: WebContents): boolean;
  /** The page is shown to the person. */
  visible(guest: WebContents): boolean;
  /** The page id a popup name stands for; absent, the name itself is reported. */
  popupPageId?(guest: WebContents, name: string): string;
}

export interface PageFactsOptions {
  connection: HostConnection;
  state: BrowserGuestStateStore;
  source: FactsSource;
  /** Sends the events the page has queued (the events module's `flush`). */
  flushEvents(pageId: string): void;
  now?(): number;
}

export interface PageFactsPublisher {
  /** The page's facts now, with the current `seq`. */
  facts(guest: WebContents): PageFacts;
  /** Something about the page may have changed: sends the facts if they differ from the last ones sent. */
  changed(guest: WebContents): void;
  /** Follows the guest's own load, title, zoom and renderer events; returns the function that stops following. */
  attach(guest: WebContents): () => void;
  /** Forgets what was last sent for the page (it closed). */
  forget(guest: WebContents): void;
}

const LOAD_EVENTS = [
  'did-start-loading',
  'did-stop-loading',
  'did-start-navigation',
  'did-navigate',
  'did-navigate-in-page',
  'did-fail-load',
  'page-title-updated',
  'zoom-changed',
  'render-process-gone',
  'destroyed',
] as const;

/** `facts` without the number that rises with every notification. */
function stable(facts: PageFacts): string {
  const { seq: _seq, ...rest } = facts;
  return JSON.stringify(rest);
}

export function createPageFacts(options: PageFactsOptions): PageFactsPublisher {
  const { connection, state, source } = options;
  const now = options.now ?? Date.now;
  const sent = new WeakMap<WebContents, string>();

  function facts(guest: WebContents): PageFacts {
    const record = state.for(guest);
    const known = (text: string) => state.redactText(guest, text);
    const destroyed = guest.isDestroyed();
    if (record.userInput && record.userInputAt === undefined) record.userInputAt = now();
    const dialog = record.pendingDialog;
    const pendingDialog: BrowserPendingDialog | undefined = dialog
      ? {
          type: dialog.type,
          message: known(dialog.message),
          ...(dialog.defaultPrompt ? { defaultPrompt: known(dialog.defaultPrompt) } : {}),
          openedAt: dialog.openedAt,
          ...(dialog.sessionId ? { sessionId: dialog.sessionId } : {}),
          bridge: Boolean(dialog.bridgeRequestId),
        }
      : undefined;
    const dismissed = record.dismissedDialog;
    const chooser = record.pendingFileChooser;
    const refused = [...record.refusedRequests].map(([url, reason]) => ({ url: redactBrowserUrl(url), reason }));
    return {
      pageId: record.pageId,
      seq: record.seq,
      documentId: browserDocumentId(state, guest),
      loadId: `${record.pageId}:${record.loadGeneration}`,
      url: destroyed ? '' : known(redactBrowserUrl(guest.getURL())),
      title: destroyed ? '' : known(guest.getTitle()),
      loading: !destroyed && guest.isLoading(),
      mainFrameLoading: !destroyed && guest.isLoadingMainFrame(),
      alive: !destroyed,
      crashed: record.crashed,
      ...(record.fault ? { fault: known(record.fault) } : {}),
      background: source.background(guest),
      visible: source.visible(guest),
      zoom: destroyed ? 1 : guest.getZoomFactor(),
      ...(pendingDialog ? { pendingDialog } : {}),
      ...(dismissed
        ? {
            dismissedDialog: {
              type: dismissed.type,
              message: known(dismissed.message),
              at: record.dismissedDialogAt ?? 0,
            },
          }
        : {}),
      ...(chooser
        ? {
            pendingFileChooser: {
              mode: chooser.mode,
              openedAt: chooser.openedAt,
              receiverKey: receiverKeyOf(chooser),
            },
          }
        : {}),
      ...(record.actor ? { actor: record.actor } : {}),
      ...(record.userInputAt !== undefined ? { userInputAt: record.userInputAt } : {}),
      childSessions: [...record.cdpSessions].map(([sessionId, session]) => ({
        sessionId,
        frameId: session.frameId,
        url: known(redactBrowserUrl(session.url)),
      })),
      openedPopups: record.openedPopups.map((name) => source.popupPageId?.(guest, name) ?? name),
      ...(refused.length ? { refusedRequests: refused } : {}),
    };
  }

  function changed(guest: WebContents): void {
    const pageId = state.pageId(guest);
    const current = facts(guest);
    const key = stable(current);
    if (sent.get(guest) === key) return;
    sent.set(guest, key);
    // The events queued so far happened before this change.
    options.flushEvents(pageId);
    const params: HostBrowserPageFactsParams = {
      pageId,
      seq: state.nextSeq(guest),
      facts: { ...current, seq: state.for(guest).seq },
    };
    try {
      connection.notify(HOST_BROWSER_PAGE_FACTS, params);
    } catch {
      // The connection is closing; the next claim starts from a clean slate.
    }
  }

  function attach(guest: WebContents): () => void {
    const handler = () => changed(guest);
    const emitter = guest as unknown as {
      on(event: string, listener: () => void): unknown;
      removeListener(event: string, listener: () => void): unknown;
    };
    for (const event of LOAD_EVENTS) emitter.on(event, handler);
    return () => {
      for (const event of LOAD_EVENTS) emitter.removeListener(event, handler);
    };
  }

  return {
    facts,
    changed,
    attach,
    forget: (guest) => {
      sent.delete(guest);
    },
  };
}

/**
 * Connects a guest-state store to the engine lane while `isEngineMode()`:
 * a change in a page's record sends its facts, and what the host itself logged
 * or refused joins the page's event stream.
 */
export function bindGuestState(
  state: BrowserGuestStateStore,
  publisher: Pick<PageFactsPublisher, 'changed'>,
  events: Pick<EngineEvents, 'push'>,
  isEngineMode: () => boolean
): () => void {
  return state.onChange((guest, event) => {
    if (!isEngineMode()) return;
    if (event.kind === 'changed') publisher.changed(guest);
    else if (event.kind === 'internalConsole') pushInternalConsole(events, state.pageId(guest), event.text);
    else pushRequestRefused(events, state.pageId(guest), event.url, event.reason);
  });
}
