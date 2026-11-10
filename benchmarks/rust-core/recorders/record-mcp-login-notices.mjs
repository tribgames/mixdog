#!/usr/bin/env node
// The notices the session extensions API posts around an MCP sign-in and sign-out
// (src/tui/session/session-api/extensions.mjs `beginMcpOAuthLogin`, `signOutMcpServer`, and the
// OAuth methods that post nothing): the REAL `createSessionExtensionsApi` over the REAL notice
// surface (src/tui/session/notice-surface.mjs, whose toasts are what `pushNotice` shows), loaded from
// the tree under test, with a runtime that answers as each flow scripts it. Records, per flow, the
// order of the runtime call, the posted notice (text and tone before the surface polishes it), and
// the call's return, the toasts the session holds afterwards, and the reply or the rejection.
//
//   node benchmarks/rust-core/recorders/record-mcp-login-notices.mjs --tree <git archive of b6f10295a with node_modules>
//
// Output: native/core/fixtures/mcp-login-notices/golden.json.
process.env.TZ = 'UTC';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { FIXTURES_ROOT, REPO_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const NODE_COMMIT = execFileSync('git', ['rev-parse', 'b6f10295a^{commit}'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const finalDir = join(FIXTURES_ROOT, 'mcp-login-notices');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-mcp-login-notices.mjs';

const { createSessionExtensionsApi } = await importFrom(tree, 'src/tui/session/session-api/extensions.mjs');
const { createNoticeSurface } = await importFrom(tree, 'src/tui/session/notice-surface.mjs');

const PENDING = { flowId: 'mcp_oauth_1', state: 'pending', url: 'https://auth.example/authorize?state=abc' };
const COMPLETE = { flowId: 'mcp_oauth_2', state: 'complete' };
const SIGNED_OUT = { servers: [{ name: 'linear', status: 'connected' }], revoked: true };

// `runtime`: the one runtime method the flow reaches, answering `result` or throwing `throws`.
const FLOWS = [
  { name: 'a start that waits for the browser', method: 'beginMcpOAuthLogin', params: { name: 'linear' }, runtime: { result: PENDING } },
  { name: 'a start that waits for the browser, with options', method: 'beginMcpOAuthLogin', params: { name: 'linear', options: { openBrowser: false, mode: 'reauth' } }, runtime: { result: PENDING } },
  { name: 'a start whose name carries spaces', method: 'beginMcpOAuthLogin', params: { name: ' linear ' }, runtime: { result: PENDING } },
  { name: 'a start that stored tokens settled', method: 'beginMcpOAuthLogin', params: { name: 'linear' }, runtime: { result: COMPLETE } },
  { name: 'a start that failed', method: 'beginMcpOAuthLogin', params: { name: 'linear' }, runtime: { throws: 'MCP OAuth sign-in was not completed' } },
  { name: 'a sign-out', method: 'signOutMcpServer', params: { name: 'linear' }, runtime: { result: SIGNED_OUT } },
  { name: 'a sign-out whose name carries spaces', method: 'signOutMcpServer', params: { name: ' linear ' }, runtime: { result: SIGNED_OUT } },
  { name: 'a sign-out that failed', method: 'signOutMcpServer', params: { name: 'linear' }, runtime: { throws: 'keychain locked' } },
  { name: 'a login status read', method: 'getMcpOAuthLoginStatus', params: { flowId: 'mcp_oauth_1', options: { since: 'pending:browser', waitMs: 0 } }, runtime: { result: { flowId: 'mcp_oauth_1', state: 'pending', step: 'browser' } } },
  { name: 'a cancelled login', method: 'cancelMcpOAuthLogin', params: { flowId: 'mcp_oauth_1' }, runtime: { result: { flowId: 'mcp_oauth_1', state: 'cancelled' } } },
  { name: 'a login completed with the pasted address', method: 'completeMcpOAuthLogin', params: { flowId: 'mcp_oauth_1', callbackUrl: 'http://127.0.0.1/cb?code=1' }, runtime: { result: { flowId: 'mcp_oauth_1', state: 'complete' } } },
  { name: 'a login completed with a refused address', method: 'completeMcpOAuthLogin', params: { flowId: 'mcp_oauth_1', callbackUrl: 'nope' }, runtime: { throws: 'Invalid callback URL' } },
  { name: 'an auth probe', method: 'probeMcpServerAuth', params: { cfg: { type: 'http', url: 'https://x.example/mcp' } }, runtime: { result: { auth: 'oauth' } } },
];

const ARGS = {
  beginMcpOAuthLogin: (p) => [p.name, p.options],
  signOutMcpServer: (p) => [p.name],
  getMcpOAuthLoginStatus: (p) => [p.flowId, p.options],
  cancelMcpOAuthLogin: (p) => [p.flowId],
  completeMcpOAuthLogin: (p) => [p.flowId, p.callbackUrl],
  probeMcpServerAuth: (p) => [p.cfg],
};

const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

const flows = [];
for (const flow of FLOWS) {
  const state = { commandBusy: false, toasts: [], items: [], stats: {} };
  const events = [];
  const set = (patch) => Object.assign(state, patch);
  const surface = createNoticeSurface({ getState: () => state, set, isDisposed: () => false, pushItem: (item) => state.items.push(item), replaceItems: (items) => items });
  const runtime = {
    [flow.method]: async () => {
      events.push({ runtime: flow.method });
      if (flow.runtime.throws) throw new Error(flow.runtime.throws);
      return clone(flow.runtime.result);
    },
  };
  const api = createSessionExtensionsApi({
    runtime,
    getState: () => state,
    set,
    pushNotice: (text, tone) => {
      events.push({ notice: { text, tone } });
      return surface.pushNotice(text, tone);
    },
    resetStatsAndSyncContext: () => {},
    routeState: () => ({}),
  });
  const record = { name: flow.name, method: flow.method, params: flow.params };
  try {
    record.reply = clone(await api[flow.method](...ARGS[flow.method](flow.params)));
  } catch (error) {
    record.error = error.message;
  }
  events.push('return');
  record.runtime = flow.runtime;
  record.events = events;
  record.toasts = state.toasts.map(({ id, ...toast }) => toast);
  record.commandBusy = state.commandBusy;
  surface.clearToastTimers();
  flows.push(record);
}

writeJson(join(stage, 'golden.json'), { flows });
writeSetManifest(stage, { set: 'mcp-login-notices', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree, identityRef: NODE_COMMIT });
commitStage(stage, finalDir);
process.exit(0);
