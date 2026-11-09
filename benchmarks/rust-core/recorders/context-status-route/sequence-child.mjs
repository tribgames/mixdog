// Child of record.mjs: Node's own functions run in this process on the second session as the daemon's seed turn left it, so the
// result is the live session's, with none of a daemon shutdown's writes (generation, detachedReason) in it:
//   updateSessionRoute (the route change the daemon's `setRoute` of an empty session makes, `updateSessionInPlace`), then the
//   two writes that can reach the session next, in both orders: the installation's compaction sync (`syncSessionCompaction`)
//   and a folder change (`session.cwd = <next>`, what `applyResolvedCwd` assigns). Node computes each synchronously on the live
//   session, so each order is the sequential result a write submitted while the route change is in flight must reach.
//   Also recorded: what a route change leaves when the session holds values its tool surface cannot be resolved from. Node's
//   pass reads the skill list synchronously (`collectPromptSkillsCached`), which swallows what it cannot read.
//   node --experimental-transform-types sequence-child.mjs <nodeTree> <scenario.json>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [nodeTree, scenarioFile] = process.argv.slice(2);
const { provider, model, providers, saved, movedTo, stored } = JSON.parse(readFileSync(scenarioFile, 'utf8'));
const sessionId = stored.id;
// The run's time is fixed so that a re-recording changes nothing but what Node's behaviour changed.
const NOW = 1_800_000_000_000;
Date.now = () => NOW;
const load = (rel) => import(pathToFileURL(join(nodeTree, rel)).href);
const o = 'src/runtime/agent/orchestrator/';
const { initProviders } = await load(`${o}providers/registry.mjs`);
const { updateSessionRoute } = await load(`${o}session/manager/session-lifecycle.mjs`);
const { syncSessionCompaction } = await load('src/session-runtime/session-compaction-sync.mjs');

await initProviders(providers);

// `updateSessionInPlace`'s fields for the route the session already runs on.
const fields = { provider, model, fast: false, autoEffort: true, effort: null, modelParameters: {}, contextTokens: null, selectedContextWindow: null };
// The session as a header holds it: the conversation's rows are the log's, only the system blocks they carry stay.
const headerOf = (session) => {
  const plain = JSON.parse(JSON.stringify(session));
  plain.messages = plain.messages.filter((row) => row.role === 'system');
  return plain;
};
const routed = () => {
  const session = structuredClone(stored);
  const updated = updateSessionRoute(sessionId, fields, { session });
  if (updated !== session) throw new Error('the route change answered another session');
  return session;
};

const out = { fields, saved, movedTo };
out.afterRoute = headerOf(routed());
for (const [name, order] of [['syncThenFolder', ['sync', 'folder']], ['folderThenSync', ['folder', 'sync']]]) {
  const session = routed();
  for (const write of order) {
    if (write === 'sync') syncSessionCompaction(session, { compaction: saved });
    else session.cwd = movedTo;
  }
  out[name] = headerOf(session);
}

// Another model (a route change, so the tool surface is prepared) on a session holding a value the surface is resolved from
// that is not what it should be. None makes the pass throw: nothing in it rejects, so a route change never fails half-way.
out.surfaceProbes = [];
for (const [key, value] of [['schemaAllowedTools', 5], ['mcpScopeId', {}], ['agent', {}], ['preset', {}], ['cwd', {}], ['disallowedTools', 5]]) {
  const session = structuredClone(stored);
  session[key] = value;
  let thrown = null;
  try {
    updateSessionRoute(sessionId, { ...fields, model: `${model}-other` }, { session });
  } catch (error) {
    thrown = String(error?.message || error);
  }
  out.surfaceProbes.push({ key, value, thrown, model: session.model });
}
process.stdout.write(`RESULT ${JSON.stringify(out)}\n`);
process.exit(0);
