/**
 * The `expect` of a mutating engine request (`Precondition`): the page state
 * the core decided the call against. `checkPrecondition` is synchronous and
 * reads only the live WebContents and the guest state, so it can sit right
 * next to the CDP send it guards. Nothing may be awaited between the two:
 * a handler reaches the check through `guardedSend`, which makes the pair one
 * synchronous step.
 */
import type { PageFacts, Precondition } from '../../../../../../packages/protocol/src/index.ts';
import type { PendingFileChooser } from '../../browser/guest-state';
import type { EnginePage } from './context';
import { preconditionFailed } from './errors';

/** The identity of a document of a page (browser/guest-state.ts browserDocumentId, from the state alone). */
export function documentIdOf(state: EnginePage['state']): string {
  return `${state.pageId}:${state.documentGeneration}`;
}

/** What `pendingFileChooser.receiverKey` of the page facts carries: the frame and node that receive the files. */
export function receiverKeyOf(chooser: PendingFileChooser): string {
  return `${chooser.sessionId ?? ''}|${chooser.frameId ?? ''}|${chooser.backendNodeId ?? ''}`;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function sameSet(expected: readonly string[], live: Iterable<string>): boolean {
  const have = new Set(live);
  const want = new Set(expected);
  return have.size === want.size && [...want].every((id) => have.has(id));
}

/** Throws the -32010 error (with the page's facts) for the first part of `expect` that no longer holds. */
export function checkPrecondition(expect: Precondition, page: EnginePage, facts: () => PageFacts): void {
  const { guest, state } = page;
  const url = guest.getURL();
  if (expect.documentId !== documentIdOf(state)) throw preconditionFailed('document', facts());
  if (expect.origin !== undefined && expect.origin !== originOf(url)) throw preconditionFailed('origin', facts());
  if (expect.url !== undefined && expect.url !== url) throw preconditionFailed('url', facts());
  if (expect.childSessions !== undefined && !sameSet(expect.childSessions, state.cdpSessions.keys())) {
    throw preconditionFailed('childSession', facts());
  }
  if (expect.receiverKey !== undefined) {
    const chooser = state.pendingFileChooser;
    if (!chooser || receiverKeyOf(chooser) !== expect.receiverKey) throw preconditionFailed('receiver', facts());
  }
  if (expect.snapshotId !== undefined && state.accessibilityRefs?.snapshotId !== expect.snapshotId) {
    throw preconditionFailed('snapshot', facts());
  }
}

/**
 * Checks `expect` and starts `send` in the same synchronous step. `send` must
 * issue the CDP command before its own first await; a refused check rejects
 * without calling it. No `expect` means a call the core did not bind to a state.
 */
export function guardedSend<T>(
  page: EnginePage,
  facts: () => PageFacts,
  expect: Precondition | undefined,
  send: () => Promise<T>
): Promise<T> {
  if (expect) {
    try {
      checkPrecondition(expect, page, facts);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return send();
}
