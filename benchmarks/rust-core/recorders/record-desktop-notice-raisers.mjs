#!/usr/bin/env node
// The raisers of the desktop notices other than the keychain's, driven through the REAL Node modules of
// the tree under test (all user dirs sandboxed):
//  - `provider-sign-in-expired`: tui/session/turn.mjs `failTurn` (an auth failure of a turn raises
//    `provider-sign-in:<provider>` named by `providerDisplayName`) and the display-name table;
//  - `connector-sign-in-expired`: mcp/oauth-request.mjs `createAuthorizedFetch` over a scripted
//    server (raise when a stored sign-in was refused and could not be renewed or was refused again,
//    clear when a request carrying its token succeeds);
//  - `conversation-save-failed`: session/store/live-state.mjs `_recordSaveFailure` (raised once per run).
//
//   node benchmarks/rust-core/recorders/record-desktop-notice-raisers.mjs [--tree <dir>]
//
// Output: native/core/fixtures/desktop-notice-raisers/golden.json.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'desktop-notice-raisers');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-desktop-notice-raisers.mjs';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'desktop-notice-raisers-'));
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'desktop-notice-raisers-home-'));

const REGISTRY = Symbol.for('mixdog.desktopNoticeHost.v1');
const load = (rel) => import(pathToFileURL(join(tree, rel)).href);
/** A fresh registry with one sink; `raised()` is the keys standing now. */
async function freshHost() {
  delete globalThis[REGISTRY];
  const host = await load('src/runtime/shared/desktop-notice-host.mjs');
  const delivered = [];
  host.registerDesktopNoticeSink((notice) => {
    delivered.push(notice);
    return true;
  });
  return { delivered, raised: () => [...globalThis[REGISTRY].raised].sort() };
}

// ---- display names
const { providerDisplayName } = await load('src/runtime/shared/provider-display-name.mjs');
const names = ['anthropic-oauth', 'ANTHROPIC-OAUTH', 'openai', 'gemini-api', 'mixdog-local', 'default', 'my-custom-gateway', '', undefined];
const displayNames = names.map((id) => ({ id: id ?? null, name: providerDisplayName(id) }));

// ---- provider sign-in (failTurn)
const turn = await load('src/tui/session/turn.mjs');
const failures = [
  ['401 auth', Object.assign(new Error('Unauthorized'), { status: 401 })],
  ['403 permission', Object.assign(new Error('Forbidden'), { status: 403 })],
  ['429 rate limit', Object.assign(new Error('Too many requests'), { status: 429 })],
  ['500 transient', Object.assign(new Error('Internal error'), { status: 500 })],
  ['plain', new Error('boom')],
];
const providerSteps = [];
for (const provider of ['anthropic-oauth', 'my-custom-gateway', '']) {
  for (const [name, error] of failures) {
    const { delivered, raised } = await freshHost();
    const stream = new Proxy({}, { get: (target, key) => (key in target ? target[key] : key === 'pendingBatches' ? [] : () => undefined) });
    const ctx = {
      turn: { routeMeta: { provider, model: 'm' } },
      stream,
      cards: { aggregates: { finalizeToolHeaders() {} } },
      pushNotice() {},
    };
    let threw = null;
    try {
      turn.failTurn(ctx, error);
    } catch (caught) {
      threw = String(caught?.message ?? caught);
    }
    providerSteps.push({ provider, failure: name, threw, delivered, raised: raised() });
  }
}

// ---- connector sign-in (createAuthorizedFetch)
const { createAuthorizedFetch } = await load('src/runtime/agent/orchestrator/mcp/oauth-request.mjs');
const shared = await load('src/runtime/agent/orchestrator/mcp/oauth-shared.mjs');
const URL_ = 'https://mcp.example.com/mcp';
/** One request through the real authorized fetch. `statuses`: the server's answers in order. */
async function connector({ stored, statuses, login, preRaised }) {
  const { delivered, raised } = await freshHost();
  const host = await load('src/runtime/shared/desktop-notice-host.mjs');
  if (preRaised) host.raiseDesktopNotice('connector-sign-in:acme', 'connector-sign-in-expired', { name: 'acme' });
  const before = delivered.length;
  const creds = { tokens: stored ? { access_token: 'old' } : undefined, loaded: undefined, observed: 'r1' };
  const cache = {
    creds,
    ready: async () => {},
    observeStoredRevision: async () => {},
    update: async (change) => change(),
  };
  const queue = [...statuses];
  const fetchImpl = async () =>
    new Response('', { status: queue.shift(), headers: { 'www-authenticate': 'Bearer realm="mcp"' } });
  const loginImpl = async () => {
    if (login === 'reauth') throw shared.reauthenticationRequired();
    creds.tokens = { access_token: 'new' };
  };
  const authorized = createAuthorizedFetch({
    url: URL_,
    cache,
    login: loginImpl,
    fetchImpl,
    lifetimeSignal: new AbortController().signal,
  });
  let outcome = 'ok';
  try {
    await authorized.fetch(URL_, {}, () => true, undefined, () => false, 'acme');
  } catch (error) {
    outcome = error?.code ?? String(error?.message ?? error);
  }
  return { delivered: delivered.slice(before), raised: raised(), outcome };
}
const connectorSteps = [];
for (const spec of [
  { name: 'stored token, 200', stored: true, statuses: [200], login: 'none' },
  { name: 'stored token, 200 clears a raised notice', stored: true, statuses: [200], login: 'none', preRaised: true },
  { name: 'no token, 200 clears nothing', stored: false, statuses: [200], login: 'none', preRaised: true },
  { name: 'stored token refused, login needs the user', stored: true, statuses: [401], login: 'reauth' },
  { name: 'no token, login needs the user', stored: false, statuses: [401], login: 'reauth' },
  { name: 'stored token refused, renewed, retry 200', stored: true, statuses: [401, 200], login: 'ok', preRaised: true },
  { name: 'stored token refused, renewed, retry refused again', stored: true, statuses: [401, 401], login: 'ok' },
  { name: 'no token, login ok, retry refused', stored: false, statuses: [401, 401], login: 'ok' },
  { name: 'no token, login ok, retry 200', stored: false, statuses: [401, 200], login: 'ok', preRaised: true },
  { name: 'stored token, 500 is no sign-in event', stored: true, statuses: [500], login: 'none', preRaised: true },
]) {
  connectorSteps.push({ ...spec, ...(await connector(spec)) });
}

// ---- conversation save
const live = await load('src/runtime/agent/orchestrator/session/store/live-state.mjs');
const saveSteps = [];
{
  const { delivered, raised } = await freshHost();
  for (const [name, id] of [['first failure', 's1'], ['second session', 's2'], ['no id', '']]) {
    const before = delivered.length;
    live._recordSaveFailure(id, new Error('disk full'));
    saveSteps.push({ step: name, delivered: delivered.slice(before), raised: raised() });
  }
}

writeJson(join(stage, 'golden.json'), { displayNames, providerSteps, connectorSteps, saveSteps });
writeSetManifest(stage, { set: 'desktop-notice-raisers', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
process.exit(0);