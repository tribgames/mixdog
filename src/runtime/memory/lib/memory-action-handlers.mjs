// Memory action + tool-call handlers.
//
// The write/maintenance action cluster and the `memory`/`search_memories`/
// `recall` tool dispatch. Actions are grouped by responsibility under
// memory-action-handlers/: cycle-driven (cycle1/cycle2/flush/rebuild/
// backfill), maintenance (status/prune/purge), `manage` (generated-history
// roots) and `core` (user-curated entries). Live DB handle, config reader,
// cycle scheduler primitives, cycle-LLM adapters, query handlers, and the
// transcript ingest helpers are injected so the facade keeps ownership of
// `db`, the scheduler, and lifecycle state.

import { createToolCallHandler } from './tool-call-handler.mjs';
import { throwIfAborted } from './memory-cycle2-shared.mjs';
import { createCycleActions } from './memory-action-handlers/cycle-actions.mjs';
import { createMaintenanceActions } from './memory-action-handlers/maintenance-actions.mjs';
import { createManageActions } from './memory-action-handlers/manage-actions.mjs';
import { createCoreActions } from './memory-action-handlers/core-actions.mjs';

export function createMemoryActionHandlers(deps) {
  const { readMainConfig, ingestSessionMessages, handleSearch, dumpSessionRootChunks } = deps;
  const cycle = createCycleActions(deps);
  const maintenance = createMaintenanceActions(deps);
  const manage = createManageActions(deps);
  const core = createCoreActions(deps);

  // Every handler receives (args, config, signal); the ones that ignore a
  // trailing argument simply do not read it.
  const actions = {
    status: maintenance.status,
    cycle1: cycle.cycle1,
    cycle2: cycle.cycle2,
    sleep: cycle.cycle2,
    // Direct semantic-search surface for callers that want raw ranked rows
    // without going through the Lead-side recall synthesizer: the
    // handleSearch executor is exposed through the public `memory` tool
    // action `search` so callers can hit the hybrid CTE directly.
    search: (args, _config, signal) => handleSearch(args, signal),
    flush: cycle.flush,
    rebuild: cycle.rebuild,
    prune: maintenance.prune,
    backfill: cycle.backfill,
    ingest_session: (args) => ingestSessionMessages(args),
    dump_session_roots: (args) => dumpSessionRootChunks(args),
    manage,
    core,
    purge: maintenance.purge,
  };

  async function handleMemoryAction(args, signal) {
    // Cooperative abort check: surfaces caller-cancel (IPC cancel handler)
    // before any long DB work begins on the worker side.
    throwIfAborted(signal);
    const action = String(args.action ?? '');
    const config = readMainConfig();
    if (!Object.hasOwn(actions, action)) {
      return {
        text: `unknown memory action: ${action}; valid: core, status. Mutation verbs belong in op.`,
        isError: true,
      };
    }
    return actions[action](args, config, signal);
  }

  const handleToolCall = createToolCallHandler({ handleSearch, handleMemoryAction });

  return { handleMemoryAction, handleToolCall };
}
