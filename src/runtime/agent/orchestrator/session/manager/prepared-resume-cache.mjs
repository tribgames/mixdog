// manager/prepared-resume-cache.mjs
// The prepared tool surface of recently touched sessions, and the two
// read-only entry points that warm it: desktop row hover (prefetchSession)
// and the pane projection (prepareSessionProjection). Nothing here claims
// ownership or persists anything — a miss simply re-prepares.
import { getProvider } from '../../providers/registry.mjs';
import { loadSession } from '../store.mjs';
import { resolveSessionContextMeta } from './context-meta.mjs';
import { _prepareResumeTools } from './session-tool-surface.mjs';

const PREPARED_RESUME_LIMIT = 8;
const _preparedResumes = new Map();

// The prepared tool surface is a CACHE, never a reason to keep a transcript
// resident. Holding `session` strongly pinned up to PREPARED_RESUME_LIMIT
// whole session objects for the process lifetime — hovering desktop session
// rows (prefetchSession) was enough to do it, and those objects were reachable
// from nothing else. The record therefore holds the session WEAKLY: a
// collected session simply misses and re-prepares.
function _rememberPreparedResume(sessionId, prepared) {
  _preparedResumes.delete(sessionId);
  const { session, ...rest } = prepared;
  _preparedResumes.set(sessionId, { ...rest, sessionRef: new WeakRef(session) });
  while (_preparedResumes.size > PREPARED_RESUME_LIMIT) {
    const oldest = _preparedResumes.keys().next().value;
    if (oldest === undefined) break;
    _preparedResumes.delete(oldest);
  }
}

// Rehydrate a stored record into the shape callers expect, dropping it when
// its session has already been collected.
export function _readPreparedResume(sessionId) {
  const entry = _preparedResumes.get(sessionId);
  if (!entry) return null;
  const session = entry.sessionRef?.deref();
  if (!session) {
    _preparedResumes.delete(sessionId);
    return null;
  }
  const { sessionRef, ...rest } = entry;
  return { ...rest, session };
}

/** Drop a session's prepared surface: a route change or a real resume has
 *  superseded it. */
export function _forgetPreparedResume(sessionId) {
  _preparedResumes.delete(sessionId);
}

/** A cached entry still matches only when it was prepared from THIS session
 *  object, for the same preset and MCP scope. */
export function _preparedResumeMatches(cached, session, preset) {
  return (
    cached?.session === session && cached?.preset === preset && cached?.mcpScopeId === (session.mcpScopeId || null)
  );
}

function _preparedResumeForSession(session, preset) {
  const cached = _readPreparedResume(session.id);
  if (_preparedResumeMatches(cached, session, preset)) return cached;
  const prepared = _prepareResumeTools(session, preset);
  prepared.mcpScopeId = session.mcpScopeId || null;
  _rememberPreparedResume(session.id, prepared);
  return prepared;
}

// Desktop session-row hover/idle prefetch. loadSession validates the atomic
// file signature before reusing its parsed object, so a later external write
// naturally misses this preparation and rebuilds from the new session object.
export function prefetchSession(sessionId, preset = 'full') {
  const session = loadSession(sessionId);
  if (!session || session.closed === true) return false;
  _preparedResumeForSession(session, preset);
  return true;
}

// Read-only desktop-pane projection. It shares the exact prepared tool surface
// that resumeSession will consume, but clones the session instead of claiming
// ownership or persisting refreshed metadata. This lets every visible pane run
// the live context-pressure calculation before it is ever focused.
export function prepareSessionProjection(session, preset = 'full') {
  if (!session?.id) return null;
  const prepared = _preparedResumeForSession(session, preset);
  // This read-only projection describes the last provider-visible session,
  // not the transient bootstrap bundle that resumeSession installs before
  // session-runtime reapplies deferred selections. Keeping the persisted
  // active surface preserves its provider baseline/tool signature while the
  // cached `prepared.tools` remains available for the real resume.
  const projectionTools = Array.isArray(session.tools) ? session.tools : prepared.tools;
  let contextMeta = null;
  try {
    const provider = session.provider ? getProvider(session.provider) : null;
    if (provider && session.model) {
      contextMeta = resolveSessionContextMeta(provider, session.model, session);
    }
  } catch {
    // A cold metadata/provider failure must not make the transcript vanish.
  }
  return {
    ...session,
    toolSpec: prepared.toolSpec,
    tools: projectionTools,
    ...(contextMeta
      ? {
          contextWindow: contextMeta.contextWindow,
          rawContextWindow: contextMeta.rawContextWindow,
          effectiveContextWindowPercent: contextMeta.effectiveContextWindowPercent,
          autoCompactTokenLimit: contextMeta.autoCompactTokenLimit,
          compactBoundaryTokens: contextMeta.compactBoundaryTokens,
          compaction: {
            ...(session.compaction || {}),
            boundaryTokens: contextMeta.compactBoundaryTokens,
            contextWindow: contextMeta.contextWindow,
            rawContextWindow: contextMeta.rawContextWindow,
            effectiveContextWindowPercent: contextMeta.effectiveContextWindowPercent,
            autoCompactTokenLimit: contextMeta.autoCompactTokenLimit,
          },
        }
      : {}),
  };
}
