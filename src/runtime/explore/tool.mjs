// The explore tool: one read-only explorer loop per query (explorer.mjs), all
// in parallel, merged into one bounded answer within the same tool call.
import { resolveMaintenanceRoute } from '../agent/orchestrator/agent-runtime/maintenance-route.mjs';
import { loadConfig } from '../agent/orchestrator/config.mjs';
import { getProvider, initProviders } from '../agent/orchestrator/providers/registry.mjs';
import { EXPLORE_MAX_QUERIES } from './tool-defs.mjs';
import { runExplorer } from './explorer.mjs';

// Hidden ids are reserved from user agents, so this one keeps the `-agent`
// suffix: a plain `explorer` would hide a user's own Explorer agent.
export const EXPLORER_AGENT = 'explore-agent';
export const EXPLORE_TIMEOUT_MS = 120_000;
export const EXPLORE_OUTPUT_CAP = 24_000;
const TRUNCATED = '\n[explore: answer truncated]';

function result(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

export function normalizeExploreQueries(raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((q) => (typeof q === 'string' ? q.trim() : '')).filter(Boolean);
}

function capped(text, budget) {
  return text.length <= budget ? text : text.slice(0, Math.max(0, budget - TRUNCATED.length)) + TRUNCATED;
}

// Headings and error lines are labels, not answers: the truncation marker
// would tell the caller that evidence was lost when none was.
function shortened(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * @param {{ query: string|string[] }} args
 * @param {{ cwd?: string, signal?: AbortSignal, callerSessionId?: string }} ctx
 * @param {object} [deps] injectable for tests
 */
export async function runExplore(args = {}, ctx = {}, deps = {}) {
  const {
    load = () => loadConfig({ secrets: false }),
    initialize = initProviders,
    providerFor = getProvider,
    timeoutMs = EXPLORE_TIMEOUT_MS,
  } = deps;
  const queries = normalizeExploreQueries(args.query);
  if (!queries.length) return result('[explore error] query is required', true);
  if (queries.length > EXPLORE_MAX_QUERIES) {
    return result(`[explore error] at most ${EXPLORE_MAX_QUERIES} queries per call`, true);
  }
  const config = load();
  const route = resolveMaintenanceRoute({ agent: EXPLORER_AGENT, config, includeDefault: false });
  if (!route || typeof route !== 'object') {
    return result('[explore error] Explore has no model; pick one under Workflows → Built-in agents → Explore', true);
  }

  // One controller per call: caller cancellation and the deadline both abort
  // every explorer, and the call waits for each loop to settle.
  const controller = new AbortController();
  const parent = ctx.signal;
  const onParentAbort = () => controller.abort(parent.reason);
  if (parent?.aborted) return result('[explore error] cancelled', true);
  parent?.addEventListener('abort', onParentAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    const reason = new Error(`explore timed out after ${Math.round(timeoutMs / 1000)}s`);
    // Lets an explorer return the answer text it already wrote.
    reason.salvagePartial = true;
    controller.abort(reason);
  }, timeoutMs);

  try {
    await initialize(config.providers || {}, { signal: controller.signal });
    const provider = providerFor(route.provider);
    if (!provider || typeof provider.send !== 'function') {
      return result(`[explore error] provider "${route.provider}" is not ready`, true);
    }
    const settled = await Promise.all(
      queries.map((query) =>
        runExplorer({
          query,
          route,
          provider,
          cwd: ctx.cwd || null,
          signal: controller.signal,
          ownerSessionId: ctx.callerSessionId || null,
        }).then(
          (text) => {
            const answer = String(text || '').trim();
            return { ok: Boolean(answer), text: answer, late: timedOut };
          },
          (error) => ({ ok: false, error, late: timedOut })
        )
      )
    );
    if (parent?.aborted) return result('[explore error] cancelled', true);
    const budget = Math.floor(EXPLORE_OUTPUT_CAP / queries.length);
    const bodies = settled.map((entry) => {
      if (entry.ok) return capped(entry.late ? `${entry.text}\n[explore: partial, timed out]` : entry.text, budget);
      if (entry.late) return `[explore error] timed out after ${Math.round(timeoutMs / 1000)}s with no answer`;
      if (entry.error) return `[explore error] ${shortened(String(entry.error?.message || entry.error), 500)}`;
      return '[explore error] explorer returned no answer';
    });
    const text =
      queries.length === 1
        ? bodies[0]
        : bodies
            .map((body, i) => `## Q${i + 1}: ${shortened(queries[i].replace(/\s+/g, ' '), 100)}\n${body}`)
            .join('\n\n');
    return result(
      text,
      settled.every((entry) => !entry.ok)
    );
  } catch (error) {
    if (parent?.aborted) return result('[explore error] cancelled', true);
    return result(`[explore error] ${error?.message || error}`, true);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
  }
}
