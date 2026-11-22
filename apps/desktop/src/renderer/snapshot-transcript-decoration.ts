import type { SessionSnapshot } from '../shared/contract';
import { withStreamingPartial } from '../shared/streaming-partial';
import { type Snapshot, type TranscriptItem, EMPTY_SNAPSHOT } from './desktop-types';
import { createTranscriptIdentityReconciler, type TranscriptLaneFacts } from './transcript-identity';
import { turnFailuresOf, type TurnFailures } from './turn-failures';
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
  model: TurnFailures;
}

export interface TranscriptSnapshotDecorator {
  decorate(snapshot: SessionSnapshot | null, lane?: TranscriptLaneFacts): Snapshot;
  clear(): void;
  /** Drop every per-session record for a session that ended or was forgotten. */
  forget?(sessionId: string): void;
}

const scopeChars = (failure: FailureScope): number => failure.model.chars;

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
    decorate(next, lane) {
      const raw = next && typeof next === 'object' ? (next as Snapshot) : EMPTY_SNAPSHOT;
      if (raw === EMPTY_SNAPSHOT) return raw;
      // The live row paints the unfinished streamed line too, so every reader
      // downstream (rows, reveal, metrics) sees one growing text.
      const state = identity.reconcile(withStreamingPartial(raw), lane);
      const sessionId = String(state.sessionId || '');
      const scope = `${String(state.currentProject || state.project || state.cwd || '')}\n${sessionId}`;
      const items = Array.isArray(state.items) ? state.items : null;
      let failure = scopes.get(sessionId);
      const unchanged =
        failure && failure.scope === scope && (items ? failure.items?.deref() === items : failure.items === null);
      if (!failure || !unchanged) {
        // The lane's own list, row for row, carried on from the one it handed over last: the rows it says are held are
        // the rows the turns were read from.
        const held =
          lane?.held && items === raw.items && failure?.scope === scope && failure.items?.deref() === lane.held.rows
            ? lane.held.count
            : undefined;
        failure = {
          scope,
          items: items ? new WeakRef(items) : null,
          model: turnFailuresOf(failure?.scope === scope ? failure.model : undefined, items ?? undefined, held),
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

export const sharedTranscriptSnapshotDecorator = createTranscriptSnapshotDecorator();
