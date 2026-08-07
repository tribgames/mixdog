// One transcript contract for every renderer snapshot source.
//
// The focused mixdog:state stream and background mixdog:session-state lanes
// used to decorate different shapes: only the focused stream carried failure
// turn keys and stable row identities. Focus therefore changed visible rows
// ("failed" ↔ "Failed · Retry") even though PaneConversation itself stayed
// mounted. Both pipelines now pass through this same bounded decorator.
import type { SessionSnapshot } from "../shared/contract";
import { type Snapshot, type TranscriptItem, EMPTY_SNAPSHOT } from "./desktop-types";
import { createTranscriptIdentityReconciler } from "./transcript-identity";
import { reconcileTurnFailures } from "./renderer-logic.mjs";
import type { TurnFailureModel } from "./renderer-logic.mjs";

const DECORATED_SCOPE_LIMIT = 12;

interface FailureScope {
  items: TranscriptItem[] | undefined;
  model: TurnFailureModel;
}

export interface TranscriptSnapshotDecorator {
  decorate(snapshot: SessionSnapshot | null): Snapshot;
  clear(): void;
}

export function createTranscriptSnapshotDecorator(): TranscriptSnapshotDecorator {
  let identity = createTranscriptIdentityReconciler();
  const scopes = new Map<string, FailureScope>();
  return {
    decorate(next) {
      const raw = next && typeof next === "object" ? next as Snapshot : EMPTY_SNAPSHOT;
      if (raw === EMPTY_SNAPSHOT) return raw;
      const state = identity.reconcile(raw);
      const scope = `${String(state.currentProject || state.project || state.cwd || "")}\n${String(state.sessionId || "")}`;
      let failure = scopes.get(scope);
      if (!failure || failure.items !== state.items) {
        failure = {
          items: state.items,
          model: reconcileTurnFailures(failure?.model, state.items, state.toasts, scope),
        };
      }
      // LRU touch: split workspaces can keep several live sessions, but old
      // closed lanes must not retain transcript arrays forever.
      scopes.delete(scope);
      scopes.set(scope, failure);
      while (scopes.size > DECORATED_SCOPE_LIMIT) {
        const oldest = scopes.keys().next().value;
        if (oldest === undefined) break;
        scopes.delete(oldest);
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
