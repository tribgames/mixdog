/**
 * Refs that went stale between the snapshot and the command. A read-only
 * operation or an input preflight may retry once against a fresh snapshot
 * when the same element can be found again — never across a navigation, and
 * never for a mutation, whose replay could act twice. The reply says which
 * refs were swapped so the swap is visible, not silent.
 */
import type { WebContents } from 'electron';

import type { BrowserCommandResult } from './command';
import { type BrowserRefSet, isBrowserStaleRefError, recoverBrowserRef } from './ref-recovery';
import type { BrowserReplyHost } from './reply';
import type { formatSnapshot } from './snapshot-format';

/** Refs a command may address, and which of them were transparently swapped
 *  for a fresh equivalent before dispatch. */
export interface BrowserRefRecoveryContext {
  source?: BrowserRefSet;
  replacements: Map<string, string>;
  attempted: Set<string>;
  notes: string[];
  /** Snapshot-free targets the host resolved to refs for this command. */
  resolvedTargets: string[];
}

export type RefRecoveryHost = Pick<BrowserReplyHost, 'state' | 'captureSnapshotPayload'>;

export interface RefRecoveryReplies {
  dialogResult(guest: WebContents, dispatched?: boolean): BrowserCommandResult | null;
  reportSnapshot(
    guest: WebContents,
    payload: Parameters<typeof formatSnapshot>[0],
    briefAgainst?: BrowserRefSet
  ): string;
}

export function refRecoveryFor(state: BrowserReplyHost['state'], guest: WebContents): BrowserRefRecoveryContext {
  return {
    source: state.peek(guest)?.refSet,
    replacements: new Map(),
    attempted: new Set(),
    notes: [],
    resolvedTargets: [],
  };
}

export function decorateRecovery(
  result: BrowserCommandResult,
  context: BrowserRefRecoveryContext
): BrowserCommandResult {
  const prefix = [
    context.resolvedTargets.length && `Target resolved before input dispatch: ${context.resolvedTargets.join(', ')}`,
    context.notes.length &&
      `Automatic ref recovery before input dispatch (no action replay): ${context.notes.join(', ')}`,
  ].filter(Boolean);
  if (!prefix.length) return result;
  return {
    ...result,
    text: `${prefix.join('\n')}\n\n${result.text}`,
  };
}

export function createRefRecovery(host: RefRecoveryHost, replies: RefRecoveryReplies) {
  const { state, captureSnapshotPayload } = host;

  /** Recover a ref for a read-only operation or input preflight. Mutations and
   *  their post-dispatch verification must execute outside this callback. */
  async function withRefRecovery<T>(
    guest: WebContents,
    context: BrowserRefRecoveryContext,
    sourceRef: string,
    operation: (ref: string) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const source = context.source?.refs.get(sourceRef);
    if (!source) {
      throw new Error(`ref ${sourceRef} is not from the latest snapshot; take a fresh snapshot first`);
    }
    const effectiveRef = context.replacements.get(sourceRef) || sourceRef;
    try {
      return await operation(effectiveRef);
    } catch (error) {
      if (!isBrowserStaleRefError(error) || context.attempted.has(sourceRef)) throw error;
      context.attempted.add(sourceRef);
      if (guest.getURL() !== source.url) {
        throw new Error(`ref ${sourceRef} became stale after navigation; automatic recovery will not cross URLs`);
      }
      // Recovery runs before the gesture is dispatched.
      const dialog = replies.dialogResult(guest, false);
      if (dialog) throw new Error(dialog.text);
      const freshPayload = await captureSnapshotPayload(guest, { action: 'snapshot', maxElements: 500 }, signal);
      const fresh = state.peek(guest)?.refSet;
      if (!fresh) throw error;
      for (const [originalRef, fingerprint] of context.source?.refs || []) {
        const recovered = recoverBrowserRef(fingerprint, fresh);
        if (recovered.ref) context.replacements.set(originalRef, recovered.ref);
      }
      const recovered = recoverBrowserRef(source, fresh);
      if (!recovered.ref) {
        throw new Error(
          `ref ${sourceRef} became stale; automatic recovery stopped because ${recovered.reason}.\n\n` +
            replies.reportSnapshot(guest, freshPayload)
        );
      }
      context.replacements.set(sourceRef, recovered.ref);
      context.notes.push(`${sourceRef} -> ${recovered.ref}`);
      return await operation(recovered.ref);
    }
  }

  return { withRefRecovery };
}
