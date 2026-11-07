#!/usr/bin/env node
// Genuine 1.4.5 behaviour of the setup tool's desktop request notice: `setup-tool/ui-requests.mjs`
// `request` calls `notification-bus.mjs` `notifySessionUi(sessionId, 'Desktop settings request',
// { kind: 'setup-ui', id })`, which reaches only the listeners bound to that session and answers
// whether one took it. Two kinds of listener: a session store's (`tui/session/agent-job-feed`
// `createNotificationRouter`, which every daemon session runtime binds when it is created,
// `standalone/local-session-runtime.mjs:487`, whoever views it; it takes the notice and sets
// `setupUiRequest`) and `headless-exec.mjs`'s (`mixdog exec`'s own runtime; its listener returns
// nothing, so it never takes one). Each scenario records the call with its answer, the events
// every listener received, the store patches, the claim and the request's outcome. The Rust
// SessionSetupUi publishes the same event as `thread/notification` on the thread's feed.
//
//   node <repo>/benchmarks/rust-core/recorders/record-setup-ui.mjs --tree <tree>
// Output: native/core/fixtures/setup-ui/golden.json
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const home = mkdtempSync(join(tmpdir(), 'setup-ui-'));
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
// Before any Mixdog module loads: import-time sweeps act on the data dir.
process.env.MIXDOG_DATA_DIR = join(home, 'data');
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.APPDATA = join(home, 'AppData');
process.env.LOCALAPPDATA = join(home, 'LocalAppData');

const tree = resolveTree(parseArgs());
const { createNotificationBus } = await importFrom(tree, 'src/session-runtime/notification-bus.mjs');
const { createSetupUiRequests } = await importFrom(tree, 'src/session-runtime/setup-tool/ui-requests.mjs');
const { createNotificationRouter } = await importFrom(tree, 'src/tui/session/agent-job-feed/notification-router.mjs');

const SESSION = 'sess_setup';
const OWNER = 'desktop-window-1';
const ARGS = { action: 'connect', target: 'openai' };
const RECEIPT = { result: { ok: true } };
const NOW = 1_800_000_000_000;
Date.now = () => NOW;

// A session store's listener: the real router over a store that records its patches. Nothing
// but the `setup-ui` UI action is reached here; the other collaborators answer as idle.
function storeListener(patches) {
  return createNotificationRouter({
    set: (patch) => patches.push(JSON.parse(JSON.stringify(patch))),
    pushNotice: () => {},
    getDisposed: () => false,
    dedup: { promote: () => {} },
    statusRefresh: { refresh: () => {} },
    executionDelivery: { deliver: () => false },
    modelNotification: { enqueueNotification: () => false },
  });
}

// `headless-exec.mjs`'s listener: it reports the event to the run and returns nothing.
const execListener = () => () => undefined;

// A fresh bus with `surfaces` bound, and one desktop request from SESSION; an answered call is
// claimed and completed by OWNER.
async function scenario(name, surfaces) {
  const bus = createNotificationBus({ listeners: new Set(), mgr: {} });
  const received = [];
  const patches = [];
  for (const { session, listener } of surfaces) {
    const route = listener === 'store' ? storeListener(patches) : execListener();
    bus.subscribeRuntimeNotification(session, (event) => {
      received.push({ session, listener, event: JSON.parse(JSON.stringify(event)) });
      return route(event);
    });
  }
  const calls = [];
  const notifySessionUi = (sessionId, content, meta) => {
    const handled = bus.notifySessionUi(sessionId, content, meta);
    calls.push({ sessionId, content, meta: { ...meta }, handled });
    return handled;
  };
  const requests = createSetupUiRequests({ notifySessionUi, getSessionId: () => SESSION, claimTimeoutMs: 50 });
  const pending = requests.request(ARGS);
  let claim = null;
  if (calls[0]?.handled) {
    claim = requests.claimSetupRequest(calls[0].meta.id, OWNER);
    requests.completeSetupRequest(calls[0].meta.id, OWNER, RECEIPT);
  }
  const outcome = await pending.then(
    (value) => ({ value }),
    (error) => ({ error: error.message, code: error.code ?? null })
  );
  // The bindings are process-wide: the next scenario starts with none.
  bus.clearRuntimeNotifications();
  return { name, surfaces, calls, received, patches, claim, outcome };
}

const scenarios = [
  await scenario('attached', [{ session: SESSION, listener: 'store' }]),
  await scenario('none', []),
  await scenario('other-session', [{ session: 'sess_other', listener: 'store' }]),
  await scenario('exec-only', [{ session: SESSION, listener: 'exec' }]),
];

const setDir = join(FIXTURES_ROOT, 'setup-ui');
writeJson(join(setDir, 'golden.json'), {
  domain: 'setup-ui',
  recorder: 'benchmarks/rust-core/recorders/record-setup-ui.mjs',
  session: SESSION,
  owner: OWNER,
  args: ARGS,
  receipt: RECEIPT,
  now: NOW,
  scenarios,
});
const rel = 'benchmarks/rust-core/recorders/record-setup-ui.mjs';
const command = `node <repo>/${rel} --tree <tree>`;
writeSetManifest(setDir, { set: 'setup-ui', recorder: rel, command });
console.log(`recorded ${scenarios.length} scenarios`);
process.exit(0);
