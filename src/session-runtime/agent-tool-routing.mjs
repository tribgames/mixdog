/**
 * src/session-runtime/agent-tool-routing.mjs - routes the lead's agent tool
 * through an injected agent-control executor and reads worker/job
 * status for the facade.
 */

import { clean } from '../runtime/shared/clean.mjs';

const lower = (value) => clean(value).toLowerCase();

// A pinned model named by its catalog display name ("GPT-6.1-Sol") is not a
// wire id. Canonicalize it only on an unambiguous EXACT match: the id itself,
// or a display name / label, case-insensitively, within the requested provider
// (or across providers when none is given and exactly one row matches).
// Anything else — no match, several matches, an empty or partial catalog —
// returns the args unchanged: the catalog never refuses a model and never
// substitutes a near one.
export function canonicalizePinnedModel(args, rows) {
  const model = clean(args?.model);
  if (!model || !Array.isArray(rows)) return args;
  const provider = lower(args.provider);
  const pool = rows.filter((row) => row && (!provider || lower(row.provider) === provider));
  const wanted = model.toLowerCase();
  const exactId = pool.filter((row) => row.id === model);
  // A partial catalog may lack the real id a display name collides with, so
  // only an exact id can pass there; aliases wait for a complete catalog.
  const partial = pool.some((row) => row.catalogPartial === true);
  const hits = exactId.length
    ? exactId
    : partial
      ? []
      : pool.filter((row) => lower(row.id) === wanted || lower(row.display) === wanted || lower(row.label) === wanted);
  const distinct = [...new Map(hits.map((row) => [`${row.provider}\n${row.id}`, row])).values()];
  if (distinct.length !== 1) return args;
  const [hit] = distinct;
  if (hit.id === model && hit.provider === args.provider) return args;
  return { ...args, provider: hit.provider, model: hit.id };
}

// `listProviderModels` is this runtime's provider catalog. The agent control
// behind `executeAgentControl` (the daemon's canonical agent) has none, so a
// display-name model is canonicalized here before it is forwarded. Only the
// cached/quick catalog is read, so a spawn never waits on provider listings.
export function createRoutedAgentTool({ rt, agentTool, executeAgentControl = null, listProviderModels = null }) {
  const routedAgentTool = {
    ...agentTool,
    async execute(args, context = {}) {
      if (typeof executeAgentControl !== 'function') return agentTool.execute(args, context);
      let routedArgs = args;
      if (typeof listProviderModels === 'function' && clean(args?.model) && (clean(args.type) || 'spawn') === 'spawn') {
        try {
          routedArgs = canonicalizePinnedModel(args, await listProviderModels({ quick: true }));
        } catch {
          routedArgs = args;
        }
      }
      return executeAgentControl(routedArgs, context);
    },
    closeAll(reason, scope = {}) {
      if (typeof executeAgentControl !== 'function') {
        return agentTool.closeAll(reason, scope);
      }
      // The promise is returned so teardown can wait for closing to finish
      // producing its final index writes before it drains them.
      return Promise.resolve(
        executeAgentControl(
          {
            type: '__close_all',
            reason: String(reason || 'agent owner closed'),
            ...(scope?.processExit === true ? { processExit: true } : {}),
          },
          {
            callerCwd: rt.currentCwd,
            invocationSource: 'runtime-lifecycle',
            callerSessionId: scope?.callerSessionId || rt.session?.id || null,
            clientHostPid: rt.session?.clientHostPid || process.pid,
          }
        )
      ).then(
        () => undefined,
        () => undefined
      );
    },
  };
  const agentStatusState = () => {
    try {
      const status =
        agentTool.getStatus?.({
          callerSessionId: rt.session?.id || null,
          clientHostPid: rt.session?.clientHostPid || process.pid,
        }) || {};
      return {
        agentWorkers: Array.isArray(status.workers) ? status.workers : [],
        agentJobs: Array.isArray(status.jobs) ? status.jobs : [],
        agentScope: status.scope || null,
      };
    } catch {
      return { agentWorkers: [], agentJobs: [], agentScope: null };
    }
  };
  return { routedAgentTool, agentStatusState };
}
