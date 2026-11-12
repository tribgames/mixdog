#!/usr/bin/env node
// Recording of apps/desktop/src/main/session-host-transport-read-set.test.mjs (the file is at origin/o1 d34d8a2ce, added after
// b6f10295a; it is run here against b6f10295a's product, which already holds SESSION_READ_ACTION_SET and
// SESSION_CONFIGURE_ACTION_SET): the desktop sends an action on `read` exactly when the daemon serves it on `session.read`. The real
// SessionHostTransport.invokeSession over a scripted daemon client records the lane (read / configure) of every action.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-session-host-transport-read-set-cases.mjs --tree <export of b6f10295a with node_modules> \
//        --patch benchmarks/rust-core/recorders/node-patches/node-fix-session-host-read-set.patch
// b6f10295a's SessionHostTransport kept a copy of the desktop's capability list as its read lane (READ_CAPABILITIES), so 12 actions the
// daemon serves on session.read (isSessionTerminal, agentDefinitionPresence, getChannelSettings, getChannelWorkerStatus, getSettingsSnapshot,
// searchLocalProviderModels, inspectHuggingFaceModel, getTurnLiveness, getSessionWorktreeWork, hooksStatus, listShellJobs,
// listStoppableShellJobs) went out as `configure`, which the daemon refuses: a user-visible bug. The recording is of b6f10295a with that
// one fix (the patch is d34d8a2ce's change, made against b6f10295a's text).
import { openSet } from './lib/case-set.mjs';

const set = openSet('session-host-transport-read-set-cases', import.meta.url);
const { SESSION_CONFIGURE_ACTION_SET, SESSION_READ_ACTION_SET } = await set.load('src/standalone/session-protocol.mjs');
const { SessionHostTransport } = await set.load('apps/desktop/src/main/session-host-transport.ts');

function transport() {
  const lanes = [];
  const answer = (lane) => async (params) => { lanes.push([lane, params.action]); return { sessionId: params.sessionId, revision: 1, full: {}, value: null }; };
  const client = { list: async () => ({}), create: async () => ({ sessionId: 'control-1', revision: 1, full: {} }), read: answer('read'), subscribe: async () => ({}), unsubscribe: async () => ({}), submit: async () => ({}), abort: async () => ({}), approve: async () => ({}), configure: answer('configure'), close: async () => {} };
  const owner = { isDisposed: () => false, taskWorkspace: async () => process.cwd(), openHints: () => ({}), transcriptWindow: () => ({}), projection: () => undefined, applySessionResult: () => ({}), heldTranscript: () => null, applyTranscriptPage: () => null, deleteProjection: () => {} };
  return { lanes, transport: new SessionHostTransport(client, owner) };
}

await set.run('every action the daemon serves on session.read is sent on read, and a configure action on configure', async () => {
  const { lanes, transport: t } = transport();
  const configure = [...SESSION_CONFIGURE_ACTION_SET][0];
  const readActions = [...SESSION_READ_ACTION_SET];
  for (const action of readActions) await t.invokeSession('sess_a1', action, []);
  await t.invokeSession('sess_a1', configure, []);
  return {
    readActions, configureActions: [...SESSION_CONFIGURE_ACTION_SET], configureActionSent: configure, lanes,
  };
});

await set.finish({
  entry: { runs: 'SessionHostTransport.invokeSession (apps/desktop/src/main/session-host-transport.ts) over a scripted daemon client; the action sets are the daemon protocol\'s own (src/standalone/session-protocol.mjs)', notRun: 'no daemon; the client only records the lane and action' },
  replay: { entry: 'mixdog-app-protocol method table: compare the recorded read action set and configure action set with the Rust method table, and the lane each action is sent on', normalised: {} },
});
process.exit(0);
