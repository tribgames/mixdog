#!/usr/bin/env node
// What Rust `run_host::agent_send_world` (the production `SendWorld`) answers as Node's agent
// surface does, recorded from `createAgentTree` (session-service/agent-tree.mjs): the errors
// `setRoute` and `enqueueTurn` throw, and the queue depth `enqueueTurn` answers.
//
//   node benchmarks/rust-core/recorders/record-agent-send.mjs --tree <tree>
//
// Output: native/core/fixtures/agent-send/golden.json.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

// Nothing Mixdog imports may reach the user's real directories (import-time sweeps delete data).
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[name] = mkdtempSync(join(tmpdir(), `agent-send-${name.toLowerCase()}-`));
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'agent-send');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-agent-send.mjs';
const { createAgentTree } = await importFrom(tree, 'src/standalone/session-service/agent-tree.mjs');

const submitted = [];
let accept = true;
let queued = 0;
const runtime = {
  getState: () => ({ busy: true, queued: Array.from({ length: queued }) }),
  submitAsync: async (content, options) => {
    submitted.push({ content, mode: options.mode, priority: options.priority });
    queued += 1;
    return accept;
  },
  setRoute: async (route) => ({ provider: route.provider, model: route.model }),
};
const agentTree = createAgentTree({
  sessionOwner: (id) => (id === 'sess_idle' ? { runtime: { getState: () => ({ busy: false, queued: [] }) } } : { runtime }),
  stateBusy: (state) => state?.busy === true || (Array.isArray(state?.queued) && state.queued.length > 0),
  entryForSession: async () => ({ runtime }),
  retainUnwatched: () => {},
  createSession: async () => ({}),
});
const link = (id, closed = false) =>
  agentTree.linkAgentDescriptor({ id, parentSessionId: 'sess_parent', ownerSessionId: 'sess_parent', owner: 'agent', visibility: 'agent-only', agent: 'worker', cwd: '/w', provider: 'p', model: 'm', status: 'idle', closed });
link('sess_busy');
link('sess_idle');
link('sess_closed', true);

const attempt = async (call) => {
  try {
    return { ok: await call() };
  } catch (error) {
    return { error: error.message };
  }
};
const surface = agentTree.agentSurface;
const cases = {
  enqueueUnknown: await attempt(() => surface.enqueueTurn({ session: { id: 'sess_unknown' }, prompt: 'x' })),
  setRouteUnknown: await attempt(() => surface.setRoute({ session: { id: 'sess_unknown' }, route: { provider: 'p', model: 'm' } })),
  enqueueClosed: await attempt(() => surface.enqueueTurn({ session: { id: 'sess_closed' }, prompt: 'x' })),
  setRouteClosed: await attempt(() => surface.setRoute({ session: { id: 'sess_closed' }, route: { provider: 'p', model: 'm' } })),
  enqueueIdle: await attempt(() => surface.enqueueTurn({ session: { id: 'sess_idle' }, prompt: 'x' })),
  enqueueBusy: await attempt(() => surface.enqueueTurn({ session: { id: 'sess_busy' }, prompt: 'next', context: null })),
};
accept = false;
cases.enqueueRefused = await attempt(() => surface.enqueueTurn({ session: { id: 'sess_busy' }, prompt: 'again' }));

writeJson(join(stage, 'golden.json'), { cases, submitted });
writeSetManifest(stage, { set: 'agent-send', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
