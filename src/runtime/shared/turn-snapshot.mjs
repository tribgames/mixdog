// Turn-scoped review registry.
//
// The public function names retain the original shadow-snapshot API so desktop
// capability callers stay compatible. The tracked data now follows Codex's
// attribution rule instead: only successful apply_patch UI diffs are recorded,
// each worker keeps its own review, and a Lead turn may read its child reviews
// without reassigning them to the Lead.
//
// Lead patches already live in the Lead transcript. Worker patches are
// delivered through agentLoop.onToolResult and frozen here against the owning
// Lead turn generation. Shell/background/external-editor writes are excluded.

const DISABLED = /^(0|false|off)$/i.test(String(process.env.MIXDOG_TURN_SNAPSHOT || ''));
const TURN_CACHE_MAX = 32;
const MAX_PATCH_BYTES = 2_000_000;

const _turnsBySession = new Map();
let _agentTurnSeq = 0;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function trimTurnCache() {
  while (_turnsBySession.size > TURN_CACHE_MAX) {
    const oldest = _turnsBySession.keys().next().value;
    if (oldest === undefined) break;
    _turnsBySession.delete(oldest);
  }
}

function mergePatches(values) {
  let merged = '';
  for (const value of Array.isArray(values) ? values : [values]) {
    const patch = typeof value === 'string' ? value.trim() : '';
    if (!patch) continue;
    const next = merged ? `${merged}\n${patch}` : patch;
    if (next.length > MAX_PATCH_BYTES) break;
    merged = next;
  }
  return merged;
}

function publicAgentReviews(sessionId) {
  const turn = _turnsBySession.get(clean(sessionId));
  if (!turn) return [];
  return [...turn.agents.values()].map((review) => ({ ...review }));
}

/** Start a new user turn and invalidate the prior turn's child review group. */
export async function beginTurnSnapshot(_worktree, sessionId) {
  const ownerSessionId = clean(sessionId);
  if (DISABLED || !ownerSessionId) return;
  const generation = (_turnsBySession.get(ownerSessionId)?.generation || 0) + 1;
  _turnsBySession.delete(ownerSessionId);
  _turnsBySession.set(ownerSessionId, {
    generation,
    agents: new Map(),
  });
  trimTurnCache();
}

/** Bind one worker execution to the Lead turn that launched it. */
export function beginAgentTurnReview(ownerSessionId, childSessionId, meta = {}) {
  if (DISABLED) return null;
  const owner = clean(ownerSessionId);
  const child = clean(childSessionId);
  const turn = _turnsBySession.get(owner);
  if (!owner || !child || !turn) return null;
  _agentTurnSeq += 1;
  return {
    id: `agent-review-${_agentTurnSeq}`,
    ownerSessionId: owner,
    generation: turn.generation,
    sessionId: child,
    agent: clean(meta.agent) || null,
    tag: clean(meta.tag) || null,
    completed: false,
  };
}

/** Freeze successful worker apply_patch diffs into their owning Lead turn. */
export function completeAgentTurnReview(handle, patches = []) {
  if (!handle || handle.completed === true) return false;
  handle.completed = true;
  const turn = _turnsBySession.get(clean(handle.ownerSessionId));
  if (!turn || turn.generation !== handle.generation) return false;
  const patch = mergePatches(patches);
  if (!patch) return false;
  const key = clean(handle.sessionId) || handle.id;
  const prior = turn.agents.get(key);
  turn.agents.set(key, {
    sessionId: key,
    agent: handle.agent || prior?.agent || null,
    tag: handle.tag || prior?.tag || null,
    patch: mergePatches([prior?.patch, patch]),
  });
  return true;
}

/** Return only attributed child reviews; Lead review is transcript-derived. */
export async function getTurnReviewDiff(_worktree, sessionId) {
  if (DISABLED) return { supported: false, files: [], patch: '', agents: [] };
  const ownerSessionId = clean(sessionId);
  const turn = _turnsBySession.get(ownerSessionId);
  return {
    supported: true,
    files: [],
    patch: '',
    agents: publicAgentReviews(ownerSessionId),
    ...(turn ? { generation: turn.generation } : { reason: 'no-turn' }),
  };
}

export function _resetTurnSnapshotForTest() {
  _turnsBySession.clear();
  _agentTurnSeq = 0;
}
