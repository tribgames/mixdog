#!/usr/bin/env node
// Goldens of the secret input the Rust core answers itself (WP-SESSION `wu-secret-input`:
// `approval/provideSecret`, the bound request -> fill flow and the redaction of filled values),
// each from the real Node code that answers them today:
//   slots.json       `createSecretRequests` of apps/desktop/src/main/secret-requests.ts: the one-shot
//                    slots, the page/window bindings, their deadlines and replacements
//   computer.json    `bindComputerSecret` and `typeComputerSecret` of secret-input.ts against a fake
//                    host that records every command it is sent
//   browser.json     `fillSecretInput` of browser/host-agent.ts against a fake page and fill
//   redaction.json   `redactSecrets` of secret-markers.ts and the `createSessionSecrets` registry
//   remote.json      a paired phone's `provideSecretInput` call through `createRemoteMethods`
//                    (remote-methods.ts) into the window process's registry, as index.ts hands it
//
// The modules are TypeScript, so run from apps/desktop with tsx:
//   (cd apps/desktop && node --import tsx ../../benchmarks/rust-core/recorders/record-secret-input.mjs --tree <tree>)
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, stageSet, commitStage, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { createSecretRequests } = await importFrom(tree, 'apps/desktop/src/main/secret-requests.ts');
const { bindComputerSecret, createSecretInputs, typeComputerSecret } = await importFrom(tree, 'apps/desktop/src/main/secret-input.ts');
const { fillSecretInput } = await importFrom(tree, 'apps/desktop/src/main/browser/host-agent.ts');
const { BrowserPageChangedError } = await importFrom(tree, 'apps/desktop/src/main/browser/credential-autofill.ts');
const { createSessionSecrets } = await importFrom(tree, 'apps/desktop/src/main/session-secrets.ts');
const { REDACTED_MARKER, redactSecrets } = await importFrom(tree, 'apps/desktop/src/main/secret-markers.ts');
const { createRemoteMethods } = await importFrom(tree, 'apps/desktop/src/main/remote-methods.ts');
const { SECRET_SAVE_SUFFIX, SECRET_USERNAME_SUFFIX } = await importFrom(tree, 'apps/desktop/src/shared/secret-slots.ts');

const outDir = join(FIXTURES_ROOT, 'secret-input');
const ID = 'secret_0123456789ab';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const thrown = (error) => ({ name: error?.name, message: String(error?.message) });

// ---- slots and bindings --------------------------------------------------------------------------
const browserBinding = (session) => ({ sessionId: session, pageId: 'page-1', origin: 'https://example.com', form: 'password', document: 'doc-1', targets: [{ node: 1, type: 'password' }] });
const stateOf = (registry, id) => ({
  held: registry.has(id),
  username: registry.has(id + SECRET_USERNAME_SUFFIX),
  save: registry.has(id + SECRET_SAVE_SUFFIX),
  browser: registry.binding(id)?.sessionId ?? null,
  computer: registry.computerBinding(id),
});

const provideCases = [];
{
  const longest = 'x'.repeat(4096);
  const provides = [
    ['runtime-minted id and a value', ID, 'hunter2'],
    ['value of exactly 4096', ID, longest],
    ['value over 4096', ID, `${longest}x`],
    ['astral characters count as two units', ID, '😀'.repeat(2049)],
    ['astral characters within the limit', ID, '😀'.repeat(2048)],
    ['empty value', ID, ''],
    ['id without the prefix', 'not-a-request', 'v'],
    ['id with a short tail', 'secret_short', 'v'],
    ['id with 80 characters', `secret_${'a'.repeat(80)}`, 'v'],
    ['id with 81 characters', `secret_${'a'.repeat(81)}`, 'v'],
    ['id with a forbidden character', 'secret_0123456789_b', 'v'],
    ['id with a trailing newline', `${ID}\n`, 'v'],
    ['the username slot of an id', ID + SECRET_USERNAME_SUFFIX, 'user'],
    ['the save slot of an id', ID + SECRET_SAVE_SUFFIX, '1'],
  ];
  for (const [name, requestId, value] of provides) {
    const registry = createSecretRequests({});
    const accepted = registry.provide(requestId, value);
    provideCases.push({ name, requestId, value, accepted, held: registry.has(requestId), taken: registry.take(requestId), takenAgain: registry.take(requestId) });
  }
}

const sequenceCases = [];
{
  const registry = createSecretRequests({});
  registry.provide(ID, 'a');
  registry.provide(ID + SECRET_USERNAME_SUFFIX, 'user');
  registry.provide(ID + SECRET_SAVE_SUFFIX, '1');
  registry.bind(ID, browserBinding('S1'));
  const before = stateOf(registry, ID);
  registry.discard(ID);
  sequenceCases.push({ name: 'discard drops the value, username and save slots and the binding', before, after: stateOf(registry, ID) });

  const replaced = createSecretRequests({});
  replaced.provide(ID, 'first');
  replaced.provide(ID, 'second');
  sequenceCases.push({ name: 'a second value replaces the first', taken: replaced.take(ID) });

  const kinds = createSecretRequests({});
  const states = [];
  states.push({ step: 'browser bind', ok: kinds.bind(ID, browserBinding('S1')), ...stateOf(kinds, ID) });
  states.push({ step: 'computer bind replaces it', ok: kinds.bindComputer(ID, { sessionId: 'S1', windowId: 'w1', ref: 'e1' }), ...stateOf(kinds, ID) });
  states.push({ step: 'browser bind replaces it again', ok: kinds.bind(ID, browserBinding('S2')), ...stateOf(kinds, ID) });
  sequenceCases.push({ name: 'a request has one binding, of the kind bound last', states });

  const unbound = createSecretRequests({});
  sequenceCases.push({ name: 'a bind needs a runtime-minted id', bad: unbound.bind('not-a-request', browserBinding('S1')), badComputer: unbound.bindComputer('not-a-request', { sessionId: 'S1', windowId: 'w1', ref: 'e1' }), ...stateOf(unbound, 'not-a-request') });
}

const bindComputerCases = [];
for (const [name, requestId, sessionId, windowId, ref] of [
  ['valid', ID, 'S1', 'w1', 'e1'],
  ['window and ref with dots, colons, hash, at and dash', ID, 'S1', 'win:12.3#a@b-c_d', 'ref:1.2#3@4-5_6'],
  ['no session', ID, '', 'w1', 'e1'],
  ['id that is not runtime-minted', 'x', 'S1', 'w1', 'e1'],
  ['empty window', ID, 'S1', '', 'e1'],
  ['empty ref', ID, 'S1', 'w1', ''],
  ['space in the ref', ID, 'S1', 'w1', 'e 1'],
  ['window of 128 characters', ID, 'S1', 'w'.repeat(128), 'e1'],
  ['window of 129 characters', ID, 'S1', 'w'.repeat(129), 'e1'],
  ['ref of 64 characters', ID, 'S1', 'w1', 'e'.repeat(64)],
  ['ref of 65 characters', ID, 'S1', 'w1', 'e'.repeat(65)],
  ['non-ASCII word character', ID, 'S1', 'wé', 'e1'],
  ['trailing newline in the window', ID, 'S1', 'w1\n', 'e1'],
  ['slash in the ref', ID, 'S1', 'w1', 'a/b'],
]) {
  const registry = createSecretInputs();
  const answer = bindComputerSecret({ session_id: sessionId, request_id: requestId, window_id: windowId, ref }, registry);
  bindComputerCases.push({ name, sessionId, requestId, windowId, ref, text: answer.text, binding: registry.computerBinding(requestId) });
}

// Deadlines: every entry leaves memory at its own deadline, and an older timer never deletes a replacement.
const timelines = [];
async function timeline(name, options, steps) {
  const registry = createSecretRequests(options);
  const start = Date.now();
  const observed = [];
  for (const step of steps) {
    await sleep(Math.max(0, start + step.at - Date.now()));
    if (step.do === 'provide') registry.provide(ID, step.value);
    if (step.do === 'bind') registry.bind(ID, browserBinding(step.session));
    if (step.do === 'observe') {
      const row = { at: step.at, held: registry.has(ID) };
      if (step.take) row.take = registry.take(ID);
      row.browser = registry.binding(ID)?.sessionId ?? null;
      observed.push(row);
    }
  }
  timelines.push({ name, options, steps, observed });
}
await timeline('an older timer does not delete a replacement value', { timeoutMs: 300, bindingTimeoutMs: 450 }, [
  { at: 0, do: 'provide', value: 'first' },
  { at: 0, do: 'bind', session: 'S1' },
  { at: 150, do: 'provide', value: 'second' },
  { at: 380, do: 'observe', take: true },
  { at: 520, do: 'observe' },
]);
await timeline('an older timer does not delete a replacement binding', { timeoutMs: 300, bindingTimeoutMs: 450 }, [
  { at: 0, do: 'bind', session: 'S1' },
  { at: 200, do: 'bind', session: 'S2' },
  { at: 500, do: 'observe' },
  { at: 700, do: 'observe' },
]);
await timeline('a value expires at its deadline though nothing asks for it', { timeoutMs: 100, bindingTimeoutMs: 450 }, [
  { at: 0, do: 'provide', value: 'gone' },
  { at: 40, do: 'observe' },
  { at: 300, do: 'observe' },
]);
{
  const expected = {
    'an older timer does not delete a replacement value': [{ at: 380, held: true, take: 'second', browser: 'S1' }, { at: 520, held: false, browser: null }],
    'an older timer does not delete a replacement binding': [{ at: 500, held: false, browser: 'S2' }, { at: 700, held: false, browser: null }],
    'a value expires at its deadline though nothing asks for it': [{ at: 40, held: true, browser: null }, { at: 300, held: false, browser: null }],
  };
  for (const line of timelines) {
    if (JSON.stringify(line.observed) !== JSON.stringify(expected[line.name])) throw new Error(`timeline "${line.name}" ran off schedule: ${JSON.stringify(line.observed)}`);
  }
}

// ---- Computer Use ----------------------------------------------------------------------------------
const VALUE = 'Tr0ub4dor&3';
const computerCases = [];
async function computerCase(scenario) {
  const { name, command, provide = VALUE, bind = { session: 'S1', windowId: 'w1', ref: 'e1' }, gateHeld = false, script = [] } = scenario;
  const registry = createSecretInputs();
  if (provide !== null) registry.provide(ID, provide);
  if (bind) registry.bindComputer(ID, { sessionId: bind.session, windowId: bind.windowId, ref: bind.ref });
  const commands = [];
  const execute = async (sent) => {
    commands.push(structuredClone(sent));
    const step = script[commands.length - 1];
    if (step && 'throw' in step) throw step.throw === 'string' ? 'a thrown string stale_target' : new Error(step.throw);
    return step?.reply;
  };
  const answer = await typeComputerSecret(command, execute, registry, () => {
    if (gateHeld) throw new Error('Computer Use is blocked while a human-only approval is pending');
  });
  const session = command.session_id ?? '';
  computerCases.push({
    name, command, provide, bind, gateHeld, script, outcome: answer.text, commands,
    after: {
      held: registry.has(ID),
      computer: registry.computerBinding(ID),
      remembered: registry.secretsOf(session),
      focusArmed: registry.focusArmed(session),
      redacted: registry.redact(session, `pw=${provide ?? ''} and ${VALUE}!`),
    },
  });
}
const cmd = (extra = {}) => ({ session_id: 'S1', request_id: ID, ...extra });
const find = (elements) => ({ reply: { elements } });
await computerCase({ name: 'a single character is typed once and not read back', command: cmd(), provide: '7' });
await computerCase({ name: 'a single astral character is one character', command: cmd(), provide: '😀' });
await computerCase({ name: 'a value with no field read back is typed once', command: cmd() });
await computerCase({ name: 'a segmented code box holding the first character gets real keystrokes', command: cmd(), provide: '482190', script: [{}, find([{ ref: 'e2', value: '4', bound_ref: true, is_password: false }])] });
await computerCase({ name: 'a segmented read matches the first astral character', command: cmd(), provide: '😀😀', script: [{}, find([{ ref: 'e9', value: '😀', bound_ref: true, is_password: false }])] });
await computerCase({ name: 'a password field is never sent keystrokes', command: cmd(), script: [{}, find([{ ref: 'e2', value: VALUE[0], bound_ref: true, is_password: true }])] });
await computerCase({ name: 'a field that does not state it is no password is a password', command: cmd(), script: [{}, find([{ ref: 'e2', value: VALUE[0], bound_ref: true }])] });
await computerCase({ name: 'a field holding more than the first character gets no keystrokes', command: cmd(), script: [{}, find([{ ref: 'e2', value: VALUE.slice(0, 2), bound_ref: true, is_password: false }])] });
await computerCase({ name: 'a read with no bound element gets no keystrokes', command: cmd(), script: [{}, find([{ ref: 'e2', value: VALUE[0], is_password: false }])] });
await computerCase({ name: 'a bound element with no ref gets no keystrokes', command: cmd(), script: [{}, find([{ value: VALUE[0], bound_ref: true, is_password: false }])] });
await computerCase({ name: 'a bound element with an empty ref gets no keystrokes', command: cmd(), script: [{}, find([{ ref: '', value: VALUE[0], bound_ref: true, is_password: false }])] });
await computerCase({ name: 'the first bound element is the field', command: cmd(), script: [{}, find([{ ref: 'e2', value: 'q', bound_ref: true, is_password: false }, { ref: 'e3', value: VALUE[0], bound_ref: true, is_password: false }])] });
await computerCase({ name: 'a read that fails leaves the write as it was', command: cmd(), script: [{}, { throw: 'read failed' }] });
await computerCase({ name: 'a read with no elements leaves the write as it was', command: cmd(), script: [{}, { reply: {} }] });
await computerCase({ name: 'a read whose elements are no list leaves the write as it was', command: cmd(), script: [{}, { reply: { elements: { bound_ref: true } } }] });
await computerCase({ name: 'the keystrokes failing as stale answer page_changed', command: cmd(), provide: '482190', script: [{}, find([{ ref: 'e2', value: '4', bound_ref: true, is_password: false }]), { throw: 'the ref is stale' }] });
await computerCase({ name: 'the target going away on the write is page_changed', command: cmd(), script: [{ throw: 'stale_target: window gone' }] });
await computerCase({ name: 'is stale needs word boundaries', command: cmd(), script: [{ throw: 'this is stalemate' }] });
await computerCase({ name: 'stale or invalid is matched without case', command: cmd(), script: [{ throw: 'Ref is STALE OR INVALID' }] });
await computerCase({ name: 'a thrown string is matched like a message', command: cmd(), script: [{ throw: 'string' }] });
await computerCase({ name: 'another failure of the write is blocked', command: cmd(), script: [{ throw: 'input refused' }] });
await computerCase({ name: 'a request never provided is expired', command: cmd(), provide: null });
await computerCase({ name: 'a command with no session is expired', command: { request_id: ID } });
await computerCase({ name: 'a value with no binding is no_field', command: cmd(), bind: null });
await computerCase({ name: 'a binding of another session is blocked', command: cmd(), bind: { session: 'S2', windowId: 'w1', ref: 'e1' } });
await computerCase({ name: 'another window than the bound one is page_changed', command: cmd({ window_id: 'w2' }) });
await computerCase({ name: 'another ref than the bound one is page_changed', command: cmd({ ref: 'e2' }) });
await computerCase({ name: 'the bound window and ref named again are typed', command: cmd({ window_id: 'w1', ref: 'e1' }) });
await computerCase({ name: 'a held screen blocks before the value is taken', command: cmd(), gateHeld: true });

const bindThenType = [];
{
  const registry = createSecretInputs();
  registry.provide(ID, VALUE);
  bindThenType.push({ step: 'a browser binding is made', browser: registry.bind(ID, browserBinding('S1')) });
  const answer = await typeComputerSecret(cmd(), async () => undefined, registry, () => {});
  bindThenType.push({ step: 'typed with a browser binding', outcome: answer.text, held: registry.has(ID) });
}

// ---- browser ---------------------------------------------------------------------------------------
const browserCases = [];
const ORIGIN = 'https://example.com';
async function browserCase(scenario) {
  const { name, checkedBy, session = 'S1', provide = { value: VALUE }, bind = { session: 'S1', form: 'password', targets: true, document: true }, computerBind = false, gateHeld = false, page = 'at-origin', fill = { filled: true }, id = ID } = scenario;
  const registry = createSecretInputs();
  if (provide) {
    registry.provide(id, provide.value);
    if (provide.username !== undefined) registry.provide(id + SECRET_USERNAME_SUFFIX, provide.username);
    if (provide.save !== undefined) registry.provide(id + SECRET_SAVE_SUFFIX, provide.save);
  }
  if (bind) {
    registry.bind(id, { ...browserBinding(bind.session), origin: ORIGIN, form: bind.form, document: bind.document ? 'doc-1' : '', targets: bind.targets ? [{ node: 1, type: 'password' }] : [] });
  }
  if (computerBind) registry.bindComputer(id, { sessionId: session, windowId: 'w1', ref: 'e1' });
  let url = page === 'other-origin' ? 'https://evil.example/' : `${ORIGIN}/signin`;
  const guest = { isDestroyed: () => page === 'destroyed', getURL: () => url };
  let filled = null;
  let saved = null;
  const host = {
    pageById: () => (page === 'missing' ? null : guest),
    assertFree: () => {
      if (gateHeld) throw new Error('browser use is held by a takeover');
    },
    fill: async (_guest, args) => {
      filled = { form: args.form, value: args.value, username: args.username };
      if (fill.movesDuringFill) url = 'https://evil.example/';
      if (fill.throw === 'generic') throw new Error('fill failed');
      if (fill.throw === 'page_changed') throw new BrowserPageChangedError();
      return { filled: fill.filled === true };
    },
    saveLogin: async (login) => {
      saved = login;
    },
  };
  const answer = await fillSecretInput(host, session, id, undefined, registry);
  browserCases.push({
    name, checkedBy, session, provide, bind, computerBind, gateHeld, page, fill, outcome: answer.text, filled, saved,
    after: { ...stateOf(registry, id), redacted: registry.redact(session, `pw=${VALUE}!`) },
  });
}
await browserCase({ name: 'a password goes to the page it was bound to', checkedBy: 'host' });
await browserCase({ name: 'a login with a username and the save choice is saved', checkedBy: 'host', provide: { value: VALUE, username: 'alice', save: '1' }, bind: { session: 'S1', form: 'login', targets: true, document: true } });
await browserCase({ name: 'a login with a username and no save choice is not saved', checkedBy: 'host', provide: { value: VALUE, username: 'alice' }, bind: { session: 'S1', form: 'login', targets: true, document: true } });
await browserCase({ name: 'a login with a save choice other than 1 is not saved', checkedBy: 'host', provide: { value: VALUE, username: 'alice', save: '0' }, bind: { session: 'S1', form: 'login', targets: true, document: true } });
await browserCase({ name: 'a save choice with no username saves nothing', checkedBy: 'host', provide: { value: VALUE, save: '1' }, bind: { session: 'S1', form: 'login', targets: true, document: true } });
await browserCase({ name: 'a save choice on a password form saves nothing', checkedBy: 'host', provide: { value: VALUE, username: 'alice', save: '1' } });
await browserCase({ name: 'a one-time code form is filled', checkedBy: 'host', provide: { value: '482190' }, bind: { session: 'S1', form: 'otp', targets: true, document: true } });
await browserCase({ name: 'a request never provided is expired', checkedBy: 'core', provide: null });
await browserCase({ name: 'a request with no binding is blocked', checkedBy: 'core', bind: null });
await browserCase({ name: 'a binding of another session is blocked', checkedBy: 'core', bind: { session: 'S2', form: 'password', targets: true, document: true } });
await browserCase({ name: 'a computer binding is no page binding', checkedBy: 'core', bind: null, computerBind: true });
await browserCase({ name: 'a held takeover blocks before the value is taken', checkedBy: 'core', gateHeld: true });
await browserCase({ name: 'a page that is gone is page_changed', checkedBy: 'host', page: 'missing' });
await browserCase({ name: 'a destroyed page is page_changed', checkedBy: 'host', page: 'destroyed' });
await browserCase({ name: 'a page that left the origin is page_changed', checkedBy: 'host', page: 'other-origin' });
await browserCase({ name: 'a binding with no document is page_changed', checkedBy: 'host', bind: { session: 'S1', form: 'password', targets: true, document: false } });
await browserCase({ name: 'a binding with no elements is no_field', checkedBy: 'host', bind: { session: 'S1', form: 'password', targets: false, document: true } });
await browserCase({ name: 'a stale element is no_field', checkedBy: 'host', fill: { filled: false } });
await browserCase({ name: 'a fill failing on the page changing is page_changed', checkedBy: 'host', fill: { throw: 'page_changed' } });
await browserCase({ name: 'a fill failing after the page left the origin is page_changed', checkedBy: 'host', fill: { throw: 'generic', movesDuringFill: true } });
await browserCase({ name: 'another fill failure is blocked', checkedBy: 'host', fill: { throw: 'generic' } });
// A "core" case is one Node refuses with the value still in its slot, before any fill is attempted.
for (const row of browserCases) {
  const refusedBeforeAnyFill = row.filled === null && ['expired', 'blocked'].includes(row.outcome) && row.after.held === false;
  const hostRefusal = ['a page that is gone is page_changed', 'a destroyed page is page_changed', 'a page that left the origin is page_changed', 'a binding with no document is page_changed', 'a binding with no elements is no_field'].includes(row.name);
  if (row.checkedBy === 'core' && !refusedBeforeAnyFill) throw new Error(`browser case "${row.name}" is not a core refusal`);
  if (row.checkedBy === 'host' && refusedBeforeAnyFill && !hostRefusal) throw new Error(`browser case "${row.name}" is not a host refusal`);
}

// ---- redaction -------------------------------------------------------------------------------------
const redactCases = [
  ['a secret in text', 'my pw is hunter2.', ['hunter2']],
  ['every occurrence', 'a b a b a', ['a']],
  ['the longest secret first', 'abcd abc', ['abcd', 'abc']],
  ['a secret inside a marker is left', 'a[redacted]e', ['e']],
  ['a secret in the saved-login marker is left', 'pw [saved login] and s', ['saved', 's']],
  ['a secret holding marker text is replaced whole', 'xx[redacted]yy', ['x[redacted]y']],
  ['a secret partly overlapping a marker replaces the marker', 'pa[redacted] tail', ['pa[red']],
  ['a secret overlapping the end of a marker', 'head [redacted]ed tail', ['ed t']],
  ['astral characters', '😀 pw 😀😀', ['😀😀', '😀']],
  ['overlapping occurrences', 'aaa', ['aa']],
  ['a replacement joining a secret to its neighbour needs another pass', 'ba[redacted]', ['a[redacted]', 'b']],
  ['no secrets', 'nothing to hide', []],
  ['empty text', '', ['x']],
  ['markers only', '[redacted][saved login]', ['d', 'e', 'saved login']],
  ['adjacent secrets', 'abab', ['ab']],
].map(([name, text, secrets]) => ({ name, text, secrets, out: redactSecrets(text, secrets, REDACTED_MARKER) }));

const sessionCases = [];
{
  const sessions = createSessionSecrets();
  const snap = (step) => sessionCases.push({ step, s1: sessions.secretsOf('S1'), s2: sessions.secretsOf('S2'), redacted1: sessions.redact('S1', 'abcdef abc ab a'), redacted2: sessions.redact('S2', 'abcdef abc ab a'), focus1: sessions.focusArmed('S1'), focus2: sessions.focusArmed('S2') });
  sessions.remember('S1', 'ab');
  snap('one secret');
  sessions.remember('S1', 'abc');
  sessions.remember('S1', 'ab');
  snap('a longer one and a repeat');
  sessions.remember('S1', '');
  sessions.remember('', 'nope');
  sessions.remember('S2', 'a');
  snap('empties are not kept; sessions are separate');
  sessions.remember('S1', 'abcdef');
  snap('the longest is replaced first');
  sessions.armFocus('S1');
  snap('focus is armed');
  sessions.clearFocus('S1');
  snap('focus is cleared');
  sessions.armFocus('S1');
  sessions.armFocus('S2');
  sessions.forget('S1');
  snap('forget drops the secrets and the focus of one session');
}

// ---- a paired phone ---------------------------------------------------------------------------------
const remoteCases = [];
{
  const registry = createSecretInputs();
  const hostRequest = async (method, args) => {
    if (method !== 'provideSecretInput') throw new Error(`unexpected window request ${method}`);
    return registry.provide(String(args[0] || ''), typeof args[1] === 'string' ? args[1] : '');
  };
  const methods = createRemoteMethods({ host: {}, hostRequest });
  const run = async (name, params) => {
    registry.discard(ID);
    let result;
    try {
      result = { ok: await methods.provideSecretInput(params) };
    } catch (error) {
      result = { error: thrown(error) };
    }
    remoteCases.push({ name, params, result, held: registry.has(ID), taken: registry.take(ID) });
  };
  await run('the phone submits for a runtime-minted id', [ID, '482190']);
  await run('the id is trimmed', [` ${ID} `, '482190']);
  await run('an id that is not runtime-minted is refused', ['not-a-request', '482190']);
  await run('an empty value is refused', [ID, '']);
  await run('a value that is no string is refused', [ID, 42]);
  await run('a value over the limit is refused', [ID, 'x'.repeat(4097)]);
  await run('a number is no request id', [7, '482190']);
  await run('an empty id is invalid', ['', '482190']);
  await run('an id of 121 characters is invalid', ['x'.repeat(121), '482190']);
  // Nothing about the call ties the value to the connection or to the session: the id is the
  // whole address, and the fill checks the session and target the request was bound to.
  registry.bind(ID, browserBinding('S1'));
  await run('a submit does not need to name the session of the binding', [ID, '482190']);
}

const stage = stageSet(outDir);
writeJson(join(stage, 'slots.json'), { provide: provideCases, sequences: sequenceCases, bindComputer: bindComputerCases, timelines, suffixes: { username: SECRET_USERNAME_SUFFIX, save: SECRET_SAVE_SUFFIX } });
writeJson(join(stage, 'computer.json'), { type: computerCases, bindThenType });
writeJson(join(stage, 'browser.json'), browserCases);
writeJson(join(stage, 'redaction.json'), { redact: redactCases, sessions: sessionCases });
writeJson(join(stage, 'remote.json'), remoteCases);
commitStage(stage, outDir);
writeSetManifest(outDir, {
  set: 'secret-input',
  recorder: 'benchmarks/rust-core/recorders/record-secret-input.mjs',
  command: '(cd apps/desktop && node --import tsx ../../benchmarks/rust-core/recorders/record-secret-input.mjs --tree <tree>)',
  identityTree: tree,
});
console.log(`recorded ${provideCases.length} provide, ${sequenceCases.length} sequence, ${bindComputerCases.length} bind, ${timelines.length} timeline, ${computerCases.length} computer, ${browserCases.length} browser, ${redactCases.length} redact, ${sessionCases.length} session, ${remoteCases.length} remote cases`);
process.exit(0);
