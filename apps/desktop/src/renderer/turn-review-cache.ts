import { registerBudgetedCache, enforceRendererCacheBudget } from './renderer-cache-budget';
import { registerIdleReclaim } from './idle-reclaim';

export type TurnReviewFile = {
  path: string;
  oldPath?: string | null;
  status?: string;
  additions?: number | null;
  deletions?: number | null;
  binary?: boolean;
};
export type AgentTurnReview = {
  sessionId: string;
  agent: string | null;
  tag: string | null;
  patch: string;
};

const AGENT_REVIEW_CACHE_LIMIT = 32;
const AGENT_REVIEW_SCOPE_MAX_CHARS = 4 * 1024 * 1024;
const AGENT_REVIEW_CACHE_MAX_CHARS = 8 * 1024 * 1024;
export const agentReviewCache = new Map<string, AgentTurnReview[]>();
export const leadReviewCache = new Map<string, string | null>();
export const leadReviewFilesCache = new Map<string, TurnReviewFile[]>();
export const leadReviewSnapshotKindCache = new Map<string, string>();
export const leadReviewCheckpointIdCache = new Map<string, string>();
// Tag of the review held above, dropped with it: a tag that outlived its
// review got answered `unchanged` and left the bar on an empty review.
export const reviewTagCache = new Map<string, string>();
const sizes = new Map<string, number>();
let retainedChars = 0;

function drop(scope: string): void {
  retainedChars -= sizes.get(scope) || 0;
  sizes.delete(scope);
  agentReviewCache.delete(scope);
  leadReviewCache.delete(scope);
  leadReviewFilesCache.delete(scope);
  leadReviewSnapshotKindCache.delete(scope);
  leadReviewCheckpointIdCache.delete(scope);
  reviewTagCache.delete(scope);
}

function trim(target: number): void {
  while (agentReviewCache.size > AGENT_REVIEW_CACHE_LIMIT || retainedChars > target) {
    const oldest = agentReviewCache.keys().next();
    if (oldest.done) break;
    drop(oldest.value);
  }
}

registerBudgetedCache({ name: 'turn-review', chars: () => retainedChars, trim });
registerIdleReclaim(() => {
  for (const scope of agentReviewCache.keys()) drop(scope);
});

export function rememberAgentReviews(
  scopeKey: string,
  reviews: AgentTurnReview[],
  leadPatch: string | null,
  files: TurnReviewFile[],
  snapshotKind: string,
  checkpointId: string,
  etag = ''
): void {
  drop(scopeKey);
  let chars = JSON.stringify([scopeKey, reviews, leadPatch, files, snapshotKind, checkpointId]).length;
  // An oversized review keeps only what decides and draws the collapsed bar
  // (files, kind, checkpoint); its patch text is re-read on entry. Caching
  // nothing held every entry into such a session behind that read before its
  // transcript could reveal (user: 특정 세션은 다시 가도 매번 늦게 뜬다).
  // No tag: a patch-less entry must never be answered `unchanged`.
  const light = chars > AGENT_REVIEW_SCOPE_MAX_CHARS;
  if (light) {
    chars = JSON.stringify([scopeKey, files, snapshotKind, checkpointId]).length;
    if (chars > AGENT_REVIEW_SCOPE_MAX_CHARS) return;
  }
  agentReviewCache.set(scopeKey, light ? [] : reviews);
  leadReviewCache.set(scopeKey, light ? null : leadPatch);
  leadReviewFilesCache.set(scopeKey, files);
  leadReviewSnapshotKindCache.set(scopeKey, snapshotKind);
  leadReviewCheckpointIdCache.set(scopeKey, checkpointId);
  if (etag && !light) reviewTagCache.set(scopeKey, etag);
  sizes.set(scopeKey, chars);
  retainedChars += chars;
  trim(AGENT_REVIEW_CACHE_MAX_CHARS);
  enforceRendererCacheBudget();
}
