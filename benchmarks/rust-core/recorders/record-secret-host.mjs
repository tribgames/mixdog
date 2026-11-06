#!/usr/bin/env node
// Goldens of what the desktop answers the core's two-phase secret fill (WP-SESSION `wu-secret-input`), from the
// real desktop code: each request is a `host/browser/command` params object as the core sends it, run through
// `toBrowserCommand` (host/browser-command.ts) and `createBrowserCommandRunner` (browser/agent-bridge.ts) into
// `precheckSecretFill` / `runSecretFill` (browser/host-agent.ts) over a fake page, and each reply is what comes back.
//   host-replies.json  every scenario: the requests, the replies, what the fill received and saved
//
// The code under test is the desktop of the checkout being changed, so pass it as the tree:
//   (cd apps/desktop && node --import tsx ../../benchmarks/rust-core/recorders/record-secret-host.mjs --tree <tree>)
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, stageSet, commitStage, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { createBrowserCommandRunner } = await importFrom(tree, 'apps/desktop/src/main/browser/agent-bridge.ts');
const { precheckSecretFill, runSecretFill } = await importFrom(tree, 'apps/desktop/src/main/browser/host-agent.ts');
const { BrowserPageChangedError } = await importFrom(tree, 'apps/desktop/src/main/browser/credential-autofill.ts');
const { toBrowserCommand } = await importFrom(tree, 'apps/desktop/src/main/host/browser-command.ts');
const { createSecretInputs } = await importFrom(tree, 'apps/desktop/src/main/secret-input.ts');

const outDir = join(FIXTURES_ROOT, 'secret-host');
const ID = 'secret_0123456789ab';
const HOST = 'host-A';
const ORIGIN = 'https://example.com';
const VALUE = 'Tr0ub4dor&3';

const cases = [];
async function scenario(scenario) {
  const { name, thread = 'S1', form = 'password', targets = true, document = true, boundSession = 'S1', bind = true, gateHeld = false, page = 'at-origin', movesBeforeFill = false, fill = { filled: true }, secret = { value: VALUE, username: '', save: false }, runFill = true } = scenario;
  const registry = createSecretInputs();
  if (bind) {
    registry.bind(ID, { sessionId: boundSession, pageId: 'page-1', origin: ORIGIN, form, document: document ? 'doc-1' : '', targets: targets ? [{ node: 1, type: 'password' }] : [] });
  }
  let url = page === 'other-origin' ? 'https://evil.example/' : `${ORIGIN}/signin`;
  const guest = { isDestroyed: () => page === 'destroyed', getURL: () => url };
  let received = null;
  let saved = null;
  const desk = {
    hostId: HOST,
    pageById: () => (page === 'missing' ? null : guest),
    assertFree: () => {
      if (gateHeld) throw new Error('browser use is held by a takeover');
    },
    fill: async (_guest, args) => {
      received = { form: args.form, value: args.value, username: args.username, targets: args.targets.length, document: args.document };
      if (fill.throw === 'generic') throw new Error('fill failed');
      if (fill.throw === 'page_changed') throw new BrowserPageChangedError();
      return { filled: fill.filled === true };
    },
    saveLogin: async (login) => {
      saved = login;
    },
  };
  const runner = createBrowserCommandRunner({
    chains: new Map(),
    pendingReads: new Map(),
    execute: async () => {
      throw new Error('a secret command must not reach the tool path');
    },
    finishTurn: () => 0,
    beginTurn: () => {},
    secretFill: {
      precheck: (sessionId, requestId) => precheckSecretFill(desk, sessionId, requestId, registry),
      fill: (sessionId, requestId, value, signal) => runSecretFill(desk, sessionId, requestId, value, signal, registry),
    },
    handoffPage: async () => ({}),
    visibleGuests: () => [],
    lifecycle: { attachDebuggerEagerly() {}, reclaimIdleBackgroundPages() {}, destroyAllBackgroundPages() {} },
    redactSecrets: (_session, text) => text,
  });
  const send = async (params) => runner.execute(toBrowserCommand(params), new AbortController().signal);
  const precheck = { params: { threadId: thread, action: 'secret_precheck', input: { request_id: ID } } };
  precheck.reply = await send(precheck.params);
  const row = { name, thread, precheck };
  if (precheck.reply.text === 'ready' && runFill) {
    if (movesBeforeFill) url = 'https://evil.example/';
    row.fill = { params: { threadId: thread, action: 'secret_fill', input: { request_id: ID, value: secret.value, username: secret.username, save: secret.save } } };
    row.fill.reply = await send(row.fill.params);
  }
  row.received = received;
  row.saved = saved;
  row.after = { binding: registry.binding(ID)?.sessionId ?? null };
  cases.push(row);
}
await scenario({ name: 'a bound page is filled' });
await scenario({ name: 'a login with a username and the save choice is saved', form: 'login', secret: { value: VALUE, username: 'alice', save: true } });
await scenario({ name: 'a login with a username and no save choice is not saved', form: 'login', secret: { value: VALUE, username: 'alice', save: false } });
await scenario({ name: 'a request with no binding is blocked', bind: false });
await scenario({ name: 'a binding of another session is blocked', boundSession: 'S2' });
await scenario({ name: 'a held takeover is blocked', gateHeld: true });
await scenario({ name: 'a page that is gone is page_changed', page: 'missing' });
await scenario({ name: 'a destroyed page is page_changed', page: 'destroyed' });
await scenario({ name: 'a page that left the origin is page_changed', page: 'other-origin' });
await scenario({ name: 'a binding with no document is page_changed', document: false });
await scenario({ name: 'a binding with no elements is no_field', targets: false });
await scenario({ name: 'a page that moved between the phases is page_changed', movesBeforeFill: true });
await scenario({ name: 'a stale element is no_field', fill: { filled: false } });
await scenario({ name: 'a fill failing on the page changing is page_changed', fill: { throw: 'page_changed' } });
await scenario({ name: 'another fill failure is blocked', fill: { throw: 'generic' } });
await scenario({ name: 'a fill with no value is blocked', secret: { value: '', username: '', save: false } });

const stage = stageSet(outDir);
writeJson(join(stage, 'host-replies.json'), { hostId: HOST, cases });
commitStage(stage, outDir);
writeSetManifest(outDir, {
  set: 'secret-host',
  recorder: 'benchmarks/rust-core/recorders/record-secret-host.mjs',
  command: '(cd apps/desktop && node --import tsx ../../benchmarks/rust-core/recorders/record-secret-host.mjs --tree <tree>)',
  identityTree: tree,
});
console.log(`recorded ${cases.length} host scenarios`);
process.exit(0);
