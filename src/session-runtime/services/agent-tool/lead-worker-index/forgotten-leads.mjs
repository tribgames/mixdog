// Ids of deleted Leads, shared by every lead-index instance of the process that
// uses one data dir. The delete runs in the control runtime while the deleted
// session's own (still loaded) runtime keeps settling turns through ITS index
// instance; a per-instance set never sees the delete, so that late idle upsert
// wrote the row back. The store's write fence (explicit deletes) is consulted
// as well, so a fenced id can never be added whichever instance asks.
import { resolve } from 'node:path';
import { isSessionWriteFenced } from '../../../../runtime/agent/orchestrator/session/store/live-state.mjs';

const FORGOTTEN_LEADS_MAX = 1024;
const registries = new Map(); // resolved data dir -> Set<sessionId>

export function createForgottenLeads(dataDir) {
  const key = dataDir ? resolve(dataDir) : '';
  let ids = registries.get(key);
  if (!ids) {
    ids = new Set();
    registries.set(key, ids);
  }
  return {
    /** A deleted Lead must never be written to the index again. */
    forget(sessionId) {
      ids.delete(sessionId);
      ids.add(sessionId);
      if (ids.size > FORGOTTEN_LEADS_MAX) ids.delete(ids.values().next().value);
    },
    isForgotten: (sessionId) => ids.has(sessionId) || isSessionWriteFenced(sessionId),
  };
}
