// One transcript contract for every renderer snapshot source.
//
// The focused mixdog:state stream and background mixdog:session-state lanes
// used to decorate different shapes: only the focused stream carried failure
// turn keys and stable row identities. Focus therefore changed visible rows
// ("failed" ↔ "Failed · Retry") even though PaneConversation itself stayed
// mounted. Both pipelines now pass through this same bounded decorator.
import type { SessionSnapshot } from '../shared/contract';
import { withStreamingPartial } from '../shared/streaming-partial';
import { type Snapshot, type TranscriptItem, EMPTY_SNAPSHOT } from './desktop-types';
import { createTranscriptIdentityReconciler } from './transcript-identity';
import { reconcileTurnFailures, type TurnFailureModel } from './renderer-logic.mjs';
import { RendererLruCache } from './renderer-lru-cache';
import { registerIdleReclaim } from './idle-reclaim';

const DECORATED_SCOPE_LIMIT = 12;
const DECORATED_SCOPE_MAX_CHARS = 4 * 1024 * 1024;

/** The failure model of one session's last decorated transcript. The items
 *  array is held WEAKLY (it only answers "same array as last frame?"), so the
 *  scope retains the derived turn keys, never the transcript itself. */
interface FailureScope {
  scope: string;
  items: WeakRef<TranscriptItem[]> | null;
  model: TurnFailureModel;
}

export interface TranscriptSnapshotDecorator {
  decorate(snapshot: SessionSnapshot | null): Snapshot;
  clear(): void;
  /** Drop every per-session record for a session that ended or was forgotten. */
  forget?(sessionId: string): void;
}

const scopeChars = (failure: FailureScope): number =>
  failure.model.turnKeys.reduce((sum: number, key: string) => sum + key.length, 0) +
  failure.model.failedTurnKeys.reduce((sum: number, key: string) => sum + key.length, 0);

export function createTranscriptSnapshotDecorator({ register = true } = {}): TranscriptSnapshotDecorator {
  let identity = createTranscriptIdentityReconciler();
  // Keyed by session: the project only labels the scope. Weighted LRU on the
  // shared renderer budget; the models are recomputable from the transcript,
  // so idle reclaim may drop them too.
  const scopes = new RendererLruCache<string, FailureScope>({
    name: 'transcript-failure-scopes',
    maxEntries: DECORATED_SCOPE_LIMIT,
    maxChars: DECORATED_SCOPE_MAX_CHARS,
    measure: scopeChars,
    register,
  });
  if (register) registerIdleReclaim(() => scopes.clear());
  return {
    decorate(next) {
      const raw = next && typeof next === 'object' ? (next as Snapshot) : EMPTY_SNAPSHOT;
      if (raw === EMPTY_SNAPSHOT) return raw;
      // The live row paints the unfinished streamed line too, so every reader
      // downstream (rows, pacer, metrics) sees one growing text.
      const state = identity.reconcile(withStreamingPartial(raw));
      const sessionId = String(state.sessionId || '');
      const scope = `${String(state.currentProject || state.project || state.cwd || '')}\n${sessionId}`;
      const items = Array.isArray(state.items) ? state.items : null;
      let failure = scopes.get(sessionId);
      const unchanged =
        failure && failure.scope === scope && (items ? failure.items?.deref() === items : failure.items === null);
      if (!failure || !unchanged) {
        failure = {
          scope,
          items: items ? new WeakRef(items) : null,
          model: reconcileTurnFailures(failure?.model, state.items, state.toasts, scope),
        };
        scopes.set(sessionId, failure);
      }
      return {
        ...state,
        failedTurnKeys: failure.model.failedTurnKeys,
        transcriptTurnKeys: failure.model.turnKeys,
      };
    },
    clear() {
      scopes.clear();
      identity = createTranscriptIdentityReconciler();
    },
    forget(sessionId) {
      scopes.delete(sessionId);
      identity.forget(sessionId);
    },
  };
}

// ONE process-wide instance. Instantiating a decorator per pipeline (focused
// mixdog:state vs session lanes) meant each converged on ITS OWN first-seen
// row ids for the same session, so a pane focus swap still crossed id
// namespaces: rows remounted, the virtualizer dropped measured heights, and
// the transcript + TurnReviewBar visibly jumped on every focus move (user
// report, CDP-attributed). Sharing the instance gives every source one
// per-session identity baseline.
export const sharedTranscriptSnapshotDecorator = createTranscriptSnapshotDecorator();
