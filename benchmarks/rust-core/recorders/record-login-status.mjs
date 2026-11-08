#!/usr/bin/env node
// Records what Node's sign-in flows answer when their status is read, step by step: the MCP OAuth logins
// (src/session-runtime/mcp-oauth-login.mjs `createMcpOAuthLogins`) and the provider OAuth flows
// (src/tui/session/oauth-flows.mjs `createSessionOAuthFlowRegistry`), both the real modules. Node's desktop polled
// these answers; the Rust core publishes the same answers on the flow's scoped feed `login:<flowId>` (desktop-services.md
// §5.4). Each case lists its steps and, per step, the status read after it (the first status is read once the flow
// started). A flow id is `<flow>`. The deadline and expiry cases run on mock timers: no wall clock decides a recording.
//
//   node benchmarks/rust-core/recorders/record-login-status.mjs --tree <git clone at b6f10295a with node_modules>
//
// Output: native/core/fixtures/login-status/golden.json (+ MANIFEST.json).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'login-status-')));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const { FIXTURES_ROOT, REPO_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const NODE_COMMIT = execFileSync('git', ['rev-parse', 'b6f10295a2f698afc85332467192de28500bd146^{commit}'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const finalDir = join(FIXTURES_ROOT, 'login-status');
const stage = stageSet(finalDir);
const { createMcpOAuthLogins } = await importFrom(tree, 'src/session-runtime/mcp-oauth-login.mjs');
const { createSessionOAuthFlowRegistry } = await importFrom(tree, 'src/tui/session/oauth-flows.mjs');

const SERVER = 'remote';
const AUTH_URL = 'https://auth.example/authorize?state=s&code_challenge_method=S256';
const DEADLINE_MS = 5 * 60_000 - 10_000;
const plain = (value) => JSON.parse(JSON.stringify(value));
const unflow = (value, flowId) => JSON.parse(JSON.stringify(value).split(flowId).join('<flow>'));

// ---- MCP: the connect callback is driven step by step ------------------------------------------------------------
async function recordMcp(name, steps, { stored = false, timers = false } = {}) {
  if (timers) mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const connected = Promise.withResolvers();
    let launch;
    let finish;
    const logins = createMcpOAuthLogins({
      connect: (_server, given) => {
        launch = given;
        connected.resolve();
        if (stored) return Promise.resolve({ connected: true });
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      cancel: () => finish({ connected: false, error: 'cancelled' }),
      openBrowser: () => {},
      loginTimeoutMs: DEADLINE_MS,
    });
    const began = logins.begin(SERVER, { openBrowser: false });
    let started = null;
    let version = null;
    const statuses = [];
    for (const step of steps) {
      switch (step.do) {
        case 'launch':
          await connected.promise;
          await launch(AUTH_URL);
          started = await began;
          break;
        case 'callback':
          launch.onCallback();
          break;
        case 'authorized':
          launch.onAuthorized();
          break;
        case 'resolve':
          finish(step.outcome);
          break;
        case 'cancel':
          await logins.cancel(started.flowId);
          break;
        case 'deadline':
          mock.timers.tick(DEADLINE_MS);
          break;
        case 'settled':
          started = await began;
          break;
        default:
          throw new Error(`unknown step ${step.do}`);
      }
      // A status read that asks for what follows `version` answers at once when the flow moved, else on its next change.
      const view = version === null ? logins.status(started.flowId) : await logins.status(started.flowId, { since: version, waitMs: 60_000 });
      statuses.push(view);
      version = `${view.state}:${view.step}`;
    }
    const { flowId } = started;
    return { name, steps, started: unflow(plain(started), flowId), statuses: statuses.map((view) => unflow(plain(view), flowId)) };
  } finally {
    if (timers) mock.timers.reset();
  }
}

const mcp = [
  await recordMcp('complete', [{ do: 'launch' }, { do: 'callback' }, { do: 'authorized' }, { do: 'resolve', outcome: { connected: true } }]),
  await recordMcp('failed', [{ do: 'launch' }, { do: 'resolve', outcome: { connected: false, error: 'access_denied' } }]),
  await recordMcp('cancelled', [{ do: 'launch' }, { do: 'cancel' }]),
  await recordMcp('timeout', [{ do: 'launch' }, { do: 'deadline' }], { timers: true }),
  await recordMcp('stored-credentials', [{ do: 'settled' }], { stored: true }),
];

// ---- provider: the registry is given the provider's live promises -------------------------------------------------
async function recordProvider(name, start, steps, { ttlMs = 600_000, timers = false } = {}) {
  if (timers) mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const registry = createSessionOAuthFlowRegistry({ ttlMs });
    const callback = Promise.withResolvers();
    const live = (callbackPromise) => ({
      provider: 'openai-oauth',
      ...start,
      waitForCallback: callbackPromise.promise,
      cancel: () => callbackPromise.resolve(null),
      ...(start.manualUrl ? { completeCode: async () => true } : {}),
    });
    const first = registry.register(live(callback));
    const flowId = first.flowId;
    const statuses = [];
    for (const step of steps) {
      switch (step.do) {
        case 'callback':
          callback.resolve(step.result);
          break;
        case 'reject':
          callback.reject(new Error(step.message));
          break;
        case 'cancel':
          await registry.cancel(flowId);
          break;
        case 'supersede':
          registry.register(live(Promise.withResolvers()));
          break;
        case 'expire':
          mock.timers.tick(ttlMs);
          break;
        case 'code':
          await registry.complete(flowId, step.code);
          break;
        default:
          throw new Error(`unknown step ${step.do}`);
      }
      // The registry settles a flow in promise reactions: one turn of the event loop lets them all run.
      await new Promise((resolve) => setImmediate(resolve));
      statuses.push(registry.status(flowId));
    }
    registry.cancelAll();
    return { name, start, steps, started: unflow(plain(first), flowId), statuses: statuses.map((view) => unflow(plain(view), flowId)) };
  } finally {
    if (timers) mock.timers.reset();
  }
}

const URLS = { url: 'https://auth.example/authorize?x=1' };
const provider = [
  await recordProvider('callback-complete', URLS, [{ do: 'callback', result: true }]),
  await recordProvider('callback-without-result', URLS, [{ do: 'callback', result: null }]),
  await recordProvider('callback-rejected', URLS, [{ do: 'reject', message: 'token exchange rejected' }]),
  await recordProvider('cancelled', URLS, [{ do: 'cancel' }]),
  await recordProvider('superseded', URLS, [{ do: 'supersede' }]),
  await recordProvider('expired', URLS, [{ do: 'expire' }], { ttlMs: 600_000, timers: true }),
  await recordProvider('pasted-code', { ...URLS, manualUrl: 'https://auth.example/manual' }, [{ do: 'code', code: 'abc' }]),
  await recordProvider('device-code', { url: 'https://auth.example/device', userCode: 'ABCD-1234' }, [{ do: 'callback', result: true }]),
];

writeJson(join(stage, 'golden.json'), {
  domain: 'login-status',
  recorder: 'benchmarks/rust-core/recorders/record-login-status.mjs',
  authUrl: AUTH_URL,
  mcp,
  provider,
});
writeSetManifest(stage, {
  set: 'login-status',
  recorder: 'benchmarks/rust-core/recorders/record-login-status.mjs',
  command: 'node benchmarks/rust-core/recorders/record-login-status.mjs --tree <tree>',
  identityTree: tree,
  identityRef: NODE_COMMIT,
});
commitStage(stage, finalDir);
console.log(`recorded ${mcp.length} MCP and ${provider.length} provider sign-in cases`);
