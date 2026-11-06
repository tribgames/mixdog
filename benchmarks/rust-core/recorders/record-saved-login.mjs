#!/usr/bin/env node
// Goldens of the saved-login feature (WP-SESSION `wu-secret-input`), from the real desktop code:
//   registry.json  the turn-scoped part of `createSavedLoginRegistry` (saved-login-registry.ts): the passwords
//                  redacted for every session, the pixel guards, the admission and settlement of fills
//   fill.json      `fillSavedLogin` (computer/host/saved-login.ts) against a fake worker and vault: the requests
//                  the worker sees, the outcome, and what stays registered afterwards
//   pixels.json    `assertSavedLoginPixelsAllowed` over armed guards
// The owner/process protocol of the registry binds the separate runtime process to the desktop; the Rust core is
// that runtime, so it is not recorded and not ported (one owner is attached for every scenario here).
//
//   (cd apps/desktop && node --import tsx ../../benchmarks/rust-core/recorders/record-saved-login.mjs --tree <tree>)
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, stageSet, commitStage, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { createSavedLoginRegistry } = await importFrom(tree, 'apps/desktop/src/main/saved-login-registry.ts');
const { createSecretInputs } = await importFrom(tree, 'apps/desktop/src/main/secret-input.ts');
const { fillSavedLogin, assertSavedLoginPixelsAllowed } = await importFrom(tree, 'apps/desktop/src/main/computer/host/saved-login.ts');

const outDir = join(FIXTURES_ROOT, 'saved-login');
const OWNER = '00000000-0000-4000-8000-000000000001';
const PROCESS = { pid: 4001, created: '133700000000000001' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const turnOf = (t) => ({ sessionId: t.session, turnId: t.turn, ownerId: OWNER });
const guardOut = (g) => ({ session: g.sessionId, turn: g.turnId, windowId: g.windowId, pid: g.pid });

// ---- registry ----
async function registryScenario(name, steps) {
  const registry = createSavedLoginRegistry();
  registry.attachSavedLoginOwner(OWNER, PROCESS);
  const fills = new Map();
  const settles = new Map();
  const results = [];
  for (const step of steps) {
    let out;
    switch (step.op) {
      case 'remember': out = registry.rememberSavedLogin(turnOf(step.turn), step.spellings); break;
      case 'redact': out = registry.redact(step.text); break;
      case 'arm': out = registry.armSavedLoginPixels({ ...turnOf(step.guard), windowId: step.guard.windowId, pid: step.guard.pid }); break;
      case 'guards': out = registry.savedLoginPixelGuards().map(guardOut); break;
      case 'admit': {
        const finish = registry.admitSavedLoginFill(turnOf(step.fill));
        if (typeof finish === 'string') out = finish;
        else {
          fills.set(step.name, finish);
          out = 'admitted';
        }
        break;
      }
      case 'admitted': out = registry.savedLoginFillAdmitted(turnOf(step.fill)); break;
      case 'finish': fills.get(step.name)(); out = null; break;
      case 'settle': {
        let done = false;
        const promise = registry.settleSavedLoginTurn(turnOf(step.turn)).then(() => { done = true; });
        settles.set(step.name ?? 'settle', promise);
        await sleep(5);
        out = { settledAtOnce: done };
        break;
      }
      case 'awaitSettle': await settles.get(step.name ?? 'settle'); out = null; break;
      case 'forget': registry.forget(step.session); await sleep(5); out = null; break;
      default: throw new Error(step.op);
    }
    results.push(out);
  }
  return { name, steps, results };
}
const T = (session, turn) => ({ session, turn });
const registryCases = [];
registryCases.push(await registryScenario('passwords are redacted for every session, longest first', [
  { op: 'remember', turn: T('s1', 1), spellings: ['pass', 'pass word', 'pa"ss', ''] },
  { op: 'redact', text: 'x pass word y pass z pa"ss' },
  { op: 'remember', turn: T('s1', 1), spellings: ['pass'] },
  { op: 'redact', text: 'again [saved login] pass' },
]));
registryCases.push(await registryScenario('an invalid fill or no spelling registers nothing', [
  { op: 'remember', turn: T('', 1), spellings: ['aaa'] },
  { op: 'remember', turn: T('s1', 0), spellings: ['aaa'] },
  { op: 'remember', turn: T('s1', 1.5), spellings: ['aaa'] },
  { op: 'remember', turn: T('s1', 1), spellings: [] },
  { op: 'remember', turn: T('s1', 1), spellings: [''] },
  { op: 'redact', text: 'aaa' },
]));
registryCases.push(await registryScenario('a marker already in the text is kept and a secret holding marker text is replaced whole', [
  { op: 'remember', turn: T('s1', 1), spellings: ['a[saved login]b', 'xyz'] },
  { op: 'redact', text: 'q a[saved login]b w [saved login] xyz' },
]));
registryCases.push(await registryScenario('pixel guards are armed once per fill, window and process', [
  { op: 'arm', guard: { session: 's1', turn: 1, windowId: '', pid: '4242' } },
  { op: 'arm', guard: { session: 's1', turn: 1, windowId: 'hwnd:0x1', pid: '' } },
  { op: 'arm', guard: { session: 's1', turn: 0, windowId: 'hwnd:0x1', pid: '4242' } },
  { op: 'arm', guard: { session: 's1', turn: 1, windowId: 'HWND:0x1', pid: '4242' } },
  { op: 'arm', guard: { session: 's1', turn: 1, windowId: 'hwnd:0x1', pid: '4242' } },
  { op: 'arm', guard: { session: 's2', turn: 3, windowId: 'hwnd:0x1', pid: '4242' } },
  { op: 'guards' },
]));
registryCases.push(await registryScenario('a fill is admitted until its turn settles', [
  { op: 'admit', fill: T('', 1), name: 'a' },
  { op: 'admit', fill: T('s1', 0), name: 'a' },
  { op: 'admit', fill: T('s1', 2), name: 'a' },
  { op: 'admitted', fill: T('s1', 2) },
  { op: 'admitted', fill: T('s1', 3) },
  { op: 'finish', name: 'a' },
  { op: 'admitted', fill: T('s1', 2) },
  { op: 'settle', turn: T('s1', 2) },
  { op: 'admit', fill: T('s1', 2), name: 'b' },
  { op: 'admit', fill: T('s1', 1), name: 'b' },
  { op: 'admit', fill: T('s1', 3), name: 'c' },
  { op: 'admit', fill: T('s2', 1), name: 'd' },
]));
registryCases.push(await registryScenario('settling a turn retires the passwords and guards of it and older turns of that session only', [
  { op: 'remember', turn: T('s1', 1), spellings: ['one-pass'] },
  { op: 'remember', turn: T('s1', 2), spellings: ['two-pass'] },
  { op: 'remember', turn: T('s2', 1), spellings: ['other-pass'] },
  { op: 'arm', guard: { session: 's1', turn: 1, windowId: 'w1', pid: '1' } },
  { op: 'arm', guard: { session: 's1', turn: 2, windowId: 'w2', pid: '2' } },
  { op: 'arm', guard: { session: 's2', turn: 1, windowId: 'w3', pid: '3' } },
  { op: 'settle', turn: T('s1', 1) },
  { op: 'redact', text: 'one-pass two-pass other-pass' },
  { op: 'guards' },
  { op: 'settle', turn: T('s1', 5) },
  { op: 'redact', text: 'one-pass two-pass other-pass' },
  { op: 'guards' },
]));
registryCases.push(await registryScenario('a settlement waits for the fills it covers that are still running', [
  { op: 'admit', fill: T('s1', 1), name: 'run' },
  { op: 'remember', turn: T('s1', 1), spellings: ['late-pass'] },
  { op: 'arm', guard: { session: 's1', turn: 1, windowId: 'w1', pid: '1' } },
  { op: 'settle', turn: T('s1', 1) },
  { op: 'redact', text: 'late-pass' },
  { op: 'guards' },
  { op: 'finish', name: 'run' },
  { op: 'awaitSettle' },
  { op: 'redact', text: 'late-pass' },
  { op: 'guards' },
]));
registryCases.push(await registryScenario('a session that ends is settled through its newest turn', [
  { op: 'remember', turn: T('s1', 2), spellings: ['gone-pass'] },
  { op: 'remember', turn: T('s2', 9), spellings: ['kept-pass'] },
  { op: 'arm', guard: { session: 's1', turn: 2, windowId: 'w1', pid: '1' } },
  { op: 'forget', session: 's1' },
  { op: 'redact', text: 'gone-pass kept-pass' },
  { op: 'guards' },
  { op: 'admit', fill: T('s1', 2), name: 'x' },
  { op: 'admit', fill: T('s1', 3), name: 'y' },
]));

// ---- fillSavedLogin ----
const PASSWORD = 'Pa55-"word"\\x';
const ORIGIN = 'https://login.example.com';
const LABEL = 'j•••e@example.com';
const SESSION = 'saved-login-session';
const TARGET = { window_id: 'hwnd:0x1', pid: '4242', start_time: '133700000000000001', origin: ORIGIN, document_id: '42.1.4.5.1.20', runtime_id: '42.1.4.5.1.77', field: 'password', value_length: 0 };
const sampleText = `a ${PASSWORD} b ${JSON.stringify(PASSWORD).slice(1, -1)} c jane.doe@example.com d`;
const TYPED_OK = { ok: true, result: { action: 'fill_saved_login', path: 'uia_setvalue', effect: 'confirmed' } };

async function fillScenario(spec) {
  const {
    name, field = 'password', command: extra = {}, enabled = true, enabledAfter = null, platform = 'win32', values = { password: PASSWORD, username: 'jane.doe@example.com' },
    vaultOrigin = ORIGIN, vaultThrow = null, check = { ok: true, result: { saved_login_target: TARGET } }, typed = null, admit = true, runnableFailsAt = 0,
  } = spec;
  const registry = createSecretInputs();
  const command = { action: 'fill_saved_login', session_id: SESSION, window_id: 'hwnd:0x1', saved_account: LABEL, field, delivery: 'foreground', turn_id: 7, runtime_id: OWNER, ...extra };
  registry.attachSavedLoginOwner(OWNER, PROCESS);
  let finish = () => {};
  if (admit) {
    const admitted = registry.admitSavedLoginFill({ sessionId: SESSION, turnId: 7, ownerId: OWNER });
    if (typeof admitted !== 'string') finish = admitted;
  }
  const requests = [];
  const lookups = [];
  let enabledReads = 0;
  const logins = {
    enabled: () => {
      enabledReads += 1;
      return enabledAfter && enabledReads > enabledAfter ? false : enabled;
    },
    vault: {
      async value(url, account, f) {
        lookups.push({ url, account, field: f });
        if (vaultThrow) throw new Error(vaultThrow);
        return { value: values[f], label: LABEL, origin: vaultOrigin };
      },
    },
  };
  const call = async (request, beforeSend) => {
    beforeSend?.();
    requests.push({ action: request.action, field: request.field, text: request.text ?? null, expected: request.expected ?? null });
    if (request.action === 'saved_login_check') {
      if (check?.throw) throw new Error(check.throw);
      return check;
    }
    if (typed?.throw) throw new Error(typed.throw);
    return typed ?? TYPED_OK;
  };
  let runnableCalls = 0;
  const assertRunnable = () => {
    runnableCalls += 1;
    if (runnableFailsAt && runnableCalls === runnableFailsAt) throw new Error('runnable refused');
  };
  let outcome;
  try {
    outcome = { ok: true, value: await fillSavedLogin(command, logins, call, { registry, platform, assertRunnable }) };
  } catch (error) {
    outcome = { ok: false, error: error.message };
  } finally {
    finish();
  }
  const after = { redacted: registry.redact(SESSION, sampleText), otherSession: registry.redact('another', sampleText), guards: registry.savedLoginPixelGuards().map(guardOut) };
  return { name, spec, command, requests, lookups, runnableCalls, outcome, after };
}
const fillCases = [];
const add = async (spec) => fillCases.push(await fillScenario(spec));
await add({ name: 'a password is looked up for the checked origin, registered and typed once' });
await add({ name: 'a username is typed and hidden from nothing', field: 'username' });
await add({ name: 'a password with a line break registers its spellings', values: { password: 'ab\r\ncd', username: 'u' } });
await add({ name: 'Auto login off sends nothing', enabled: false });
await add({ name: 'a platform other than Windows sends nothing', platform: 'linux' });
await add({ name: 'a field other than username or password is invalid', field: 'otp' });
await add({ name: 'a missing saved account is invalid', command: { saved_account: '  ' } });
await add({ name: 'a missing window id is refused', command: { window_id: ' ' } });
await add({ name: 'a request without a turn is refused', command: { turn_id: 0 } });
await add({ name: 'a request without a runtime is refused', command: { runtime_id: '' } });
await add({ name: 'a fill the bridge did not admit is refused', admit: false });
await add({ name: 'a refused check with its error', check: { ok: false, error: 'window is not Chrome' } });
await add({ name: 'a refused check without an error', check: { ok: false } });
await add({ name: 'a check that gives no target answers as this action', check: { ok: true, result: { code: 'activation_refused', saved_login_target: null, text: 'no foreground' } } });
await add({ name: 'a vault miss is unavailable and sends nothing', vaultThrow: 'no saved login for j•••e. choose among k•••m' });
await add({ name: 'an origin the vault does not match exactly is refused', vaultOrigin: 'https://other.example.com' });
await add({ name: 'the dispatch refused before the vault stops the fill', runnableFailsAt: 1 });
await add({ name: 'the dispatch refused after the vault stops the fill before the password is registered', runnableFailsAt: 2 });
await add({ name: 'the dispatch refused right before the write is not sent but the password stays registered', runnableFailsAt: 3 });
await add({ name: 'Auto login turned off during the vault lookup is unavailable', enabledAfter: 1 });
await add({ name: 'Auto login turned off after the vault lookup stops the fill before the password is registered', enabledAfter: 2 });
await add({ name: 'Auto login turned off right before the write is not sent but the password stays registered', enabledAfter: 3 });
await add({ name: 'a worker that fails after the value was sent is unconfirmed and redacted', typed: { throw: `uia broke near ${PASSWORD}.` } });
await add({ name: 'a worker error naming the password is redacted', typed: { ok: false, error: `field held ${PASSWORD}` } });
await add({ name: 'a worker error without text is unconfirmed', typed: { ok: false } });
await add({ name: 'a worker answer with a code is returned as this action', typed: { ok: true, result: { code: 'field_changed', text: 'moved', saved_login_target: TARGET } } });
await add({ name: 'a check that throws before anything was sent', check: { throw: 'worker crashed' } });

// ---- pixels ----
async function pixelScenario(name, guards, command, windowId, pids = {}) {
  const registry = createSecretInputs();
  registry.attachSavedLoginOwner(OWNER, PROCESS);
  for (const g of guards) registry.armSavedLoginPixels({ ...turnOf(g), windowId: g.windowId, pid: g.pid });
  let reads = 0;
  let outcome = 'allowed';
  try {
    await assertSavedLoginPixelsAllowed(command, windowId, async (id) => {
      reads += 1;
      if (pids[id] === 'throw') throw new Error('unreadable');
      return pids[id];
    }, registry);
  } catch (error) {
    outcome = error.message;
  }
  return { name, guards, command, windowId, pids, outcome, pidReads: reads };
}
const G = (windowId, pid, session = 's1', turn = 1) => ({ session, turn, windowId, pid });
const pixelCases = [];
pixelCases.push(await pixelScenario('no guard allows any capture', [], { mode: 'screen' }, 'w1'));
pixelCases.push(await pixelScenario('ax mode carries no pixels', [G('w1', '10')], { mode: 'ax' }, 'w1'));
pixelCases.push(await pixelScenario('the guarded window is withheld, case-insensitively', [G('HWND:0x1', '10')], { mode: 'screen' }, 'hwnd:0x1'));
pixelCases.push(await pixelScenario('another window of the guarded process is withheld', [G('w1', '10'), G('w2', '10', 's2', 4)], { mode: 'screen' }, 'w9', { w9: '10' }));
pixelCases.push(await pixelScenario('a window of another process is allowed', [G('w1', '10')], { mode: 'screen' }, 'w9', { w9: '11' }));
pixelCases.push(await pixelScenario('a window whose process cannot be read is withheld', [G('w1', '10')], { mode: 'screen' }, 'w9', { w9: 'throw' }));
pixelCases.push(await pixelScenario('a window with no process id is withheld', [G('w1', '10')], { mode: 'screen' }, 'w9', {}));
pixelCases.push(await pixelScenario('a full-screen capture is withheld by any guard', [G('w1', '10')], { mode: 'screen' }, ''));
pixelCases.push(await pixelScenario('every guard on the same window needs no process read', [G('w1', '10'), G('w1', '11', 's2', 2)], { mode: 'screen' }, 'w1'));

const stage = stageSet(outDir);
writeJson(join(stage, 'registry.json'), { cases: registryCases });
writeJson(join(stage, 'fill.json'), { session: SESSION, password: PASSWORD, sampleText, cases: fillCases });
writeJson(join(stage, 'pixels.json'), { cases: pixelCases });
commitStage(stage, outDir);
writeSetManifest(outDir, {
  set: 'saved-login',
  recorder: 'benchmarks/rust-core/recorders/record-saved-login.mjs',
  command: '(cd apps/desktop && node --import tsx ../../benchmarks/rust-core/recorders/record-saved-login.mjs --tree <tree>)',
  identityTree: tree,
});
console.log(`recorded ${registryCases.length} registry, ${fillCases.length} fill, ${pixelCases.length} pixel scenarios`);
process.exit(0);