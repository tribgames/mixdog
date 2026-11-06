#!/usr/bin/env node
// What a `handoff_user` secret handoff touches besides the card (Rust `run_host::handoff_env` and
// `mixdog_tools::state::secrets`), recorded from the real Node code: the window process's secret
// registry (`secret-requests.ts` through `createSecretInputs`: request-id and target validation,
// one-shot slots, expiry, the per-session redaction of `secret-markers.ts`), the one fill of a bound
// computer field (`typeComputerSecret`: outcomes and the exact helper commands), the audit line of
// an answered gate (`recordHumanDecision` + `agentIdForSession`) and the unattended port's
// `humanNeeded` (`failRunForHuman`). Fake values only.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-handoff-env.mjs [--tree <dir>]
//
// Output: native/core/fixtures/handoff-env/golden.json.
process.env.TZ = 'UTC';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'handoff-env');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-handoff-env.mjs';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'handoff-env-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { createSecretInputs, typeComputerSecret } = await importFrom(tree, 'apps/desktop/src/main/secret-input.ts');
const gate = await importFrom(tree, 'src/runtime/agent/orchestrator/session/human-gate/gate.mjs');
const held = await importFrom(tree, 'src/session-runtime/held-requests.mjs');
const rooms = await importFrom(tree, 'src/runtime/agent/orchestrator/session/agent-room.mjs');
const homes = await importFrom(tree, 'src/runtime/agent/orchestrator/session/agent-home.mjs');

const TIMEOUT = 40;
const BINDING_TIMEOUT = 90;
const registry = () => createSecretInputs({ timeoutMs: TIMEOUT, bindingTimeoutMs: BINDING_TIMEOUT });
const id = (tail) => `secret_${tail}`;

// ---- the registry: binding, slots, expiry, redaction ---------------------------------------
const RUN = async (r, op) => {
  switch (op.op) {
    case 'bind': return r.bindComputer(op.id, { sessionId: op.session, windowId: op.window, ref: op.ref });
    case 'binding': return r.computerBinding(op.id);
    case 'provide': return r.provide(op.id, op.value);
    case 'has': return r.has(op.id);
    case 'take': return r.take(op.id);
    case 'discard': return r.discard(op.id) ?? null;
    case 'remember': return r.remember(op.session, op.value) ?? null;
    case 'redact': return r.redact(op.session, op.text);
    case 'forget': return r.forget(op.session) ?? null;
    case 'sleep': await sleep(op.ms); return null;
    default: throw new Error(`unknown op ${op.op}`);
  }
};
const ok = id('abcdefgh');
const bind = (over = {}) => ({ op: 'bind', id: ok, session: 's1', window: 'w1', ref: 'e1', ...over });
const REGISTRY_CASES = [
  { name: 'a plain bind is held', ops: [bind(), { op: 'binding', id: ok }] },
  { name: 'ids that are not request ids bind nothing', ops: [
    bind({ id: '' }), bind({ id: 'abcdefgh' }), bind({ id: 'secret_abcdefg' }), bind({ id: id('a'.repeat(80)) }), bind({ id: id('a'.repeat(81)) }),
    bind({ id: id('abcd_efgh') }), bind({ id: id('abcd-efgh') }), bind({ id: id('abcdéfgh') }), bind({ id: id('abcdefgh\n') }), bind({ id: 'Secret_abcdefgh' }),
  ] },
  { name: 'no session binds nothing', ops: [bind({ session: '' })] },
  { name: 'window ids and refs are plain tokens within their limits', ops: [
    bind({ window: '' }), bind({ window: 'a b' }), bind({ window: 'w'.repeat(128) }), bind({ window: 'w'.repeat(129) }), bind({ window: 'W_1.2:3#4@5-6' }), bind({ window: 'wé' }),
    bind({ ref: '' }), bind({ ref: 'r'.repeat(64) }), bind({ ref: 'r'.repeat(65) }), bind({ ref: 'e 1' }), bind({ ref: 'e/1' }),
  ] },
  { name: 'a later bind replaces the earlier one', ops: [bind(), bind({ window: 'w2', ref: 'e2' }), { op: 'binding', id: ok }] },
  { name: 'a refused bind keeps the earlier binding', ops: [bind(), bind({ window: 'a b' }), { op: 'binding', id: ok }] },
  { name: 'a value slot is one-shot', ops: [{ op: 'provide', id: ok, value: 'v1' }, { op: 'has', id: ok }, { op: 'take', id: ok }, { op: 'has', id: ok }, { op: 'take', id: ok }] },
  { name: 'values are bounded in UTF-16 units', ops: [
    { op: 'provide', id: ok, value: '' }, { op: 'provide', id: ok, value: 'x'.repeat(4096) }, { op: 'provide', id: ok, value: 'x'.repeat(4097) },
    { op: 'provide', id: ok, value: '😀'.repeat(2048) }, { op: 'provide', id: ok, value: '😀'.repeat(2049) }, { op: 'provide', id: 'nope', value: 'v' },
  ] },
  { name: 'a provided value again replaces the slot', ops: [{ op: 'provide', id: ok, value: 'one' }, { op: 'provide', id: ok, value: 'two' }, { op: 'take', id: ok }] },
  { name: 'discard drops the slot, its username and save slots and the binding', ops: [
    bind(), { op: 'provide', id: ok, value: 'v' }, { op: 'provide', id: `${ok}-username`, value: 'u' }, { op: 'provide', id: `${ok}-save`, value: 'y' },
    { op: 'discard', id: ok }, { op: 'has', id: ok }, { op: 'has', id: `${ok}-username` }, { op: 'has', id: `${ok}-save` }, { op: 'binding', id: ok },
  ] },
  { name: 'a slot expires on its own', ops: [{ op: 'provide', id: ok, value: 'v' }, { op: 'has', id: ok }, { op: 'sleep', ms: TIMEOUT + 60 }, { op: 'has', id: ok }, { op: 'take', id: ok }] },
  { name: 'a binding outlives the slot and then expires too', ops: [bind(), { op: 'sleep', ms: TIMEOUT + 25 }, { op: 'binding', id: ok }, { op: 'sleep', ms: BINDING_TIMEOUT }, { op: 'binding', id: ok }] },
  { name: 'redaction replaces every filled value of the session only', ops: [
    { op: 'remember', session: 's1', value: 'hunter2' }, { op: 'remember', session: 's2', value: 'other' },
    { op: 'redact', session: 's1', text: 'typed hunter2 then other, hunter2 again' }, { op: 'redact', session: 's3', text: 'hunter2' },
  ] },
  { name: 'an empty value or session registers nothing', ops: [{ op: 'remember', session: 's1', value: '' }, { op: 'remember', session: '', value: 'v' }, { op: 'redact', session: 's1', text: 'abc' }, { op: 'redact', session: '', text: 'v' }] },
  { name: 'the longest secret is replaced whole', ops: [
    { op: 'remember', session: 's1', value: 'pass' }, { op: 'remember', session: 's1', value: 'password1' }, { op: 'redact', session: 's1', text: 'my password1 and pass' },
  ] },
  { name: 'a secret never rewrites the letters of a marker', ops: [
    { op: 'remember', session: 's1', value: 'e' }, { op: 'redact', session: 's1', text: 'there is [redacted] here' }, { op: 'redact', session: 's1', text: 'a [saved login] e' },
  ] },
  { name: 'a secret that spans marker text is still replaced and redacting twice is redacting once', ops: [
    { op: 'remember', session: 's1', value: 'x[redacted]y' }, { op: 'redact', session: 's1', text: 'a x[redacted]y b' }, { op: 'redact', session: 's1', text: 'a x[redacted]y [redacted] x[redacted]y' },
    { op: 'redact', session: 's1', text: 'x[redacted][redacted]y' },
  ] },
  { name: 'a secret overlapping part of a marker takes the marker whole', ops: [
    { op: 'remember', session: 's1', value: 'ab[red' }, { op: 'redact', session: 's1', text: 'zab[redacted]z' }, { op: 'redact', session: 's1', text: 'ab[red' },
  ] },
  { name: 'a replacement can join a secret to the text before it', ops: [
    { op: 'remember', session: 's1', value: 'a[redacted]' }, { op: 'remember', session: 's1', value: 'q' }, { op: 'redact', session: 's1', text: 'aq a[redacted]' },
  ] },
  { name: 'non-ASCII secrets and repeated occurrences', ops: [
    { op: 'remember', session: 's1', value: '비밀😀' }, { op: 'redact', session: 's1', text: '비밀😀 와 비밀😀비밀😀 끝 비밀' },
  ] },
  { name: 'forget drops the session secrets', ops: [{ op: 'remember', session: 's1', value: 'v1' }, { op: 'forget', session: 's1' }, { op: 'redact', session: 's1', text: 'v1' }] },
];
const registryOut = [];
for (const spec of REGISTRY_CASES) {
  const r = registry();
  const results = [];
  for (const op of spec.ops) results.push(await RUN(r, op));
  registryOut.push({ ...spec, results });
}

// ---- the fill of a bound field ---------------------------------------------------------------
const field = (over = {}) => ({ ref: 'e9', value: 'a', bound_ref: true, is_password: false, ...over });
const FILL_CASES = [
  { name: 'a value nobody provided has expired', bind: true, command: {} },
  { name: 'a value for an unbound request has no field', provide: 'pw', command: {} },
  { name: 'another session is blocked', bind: true, provide: 'pw', command: { sessionId: 's2' } },
  { name: 'no session expires', bind: true, provide: 'pw', command: { sessionId: '' } },
  { name: 'another window is a page change', bind: true, provide: 'pw', command: { windowId: 'w2' } },
  { name: 'another ref is a page change', bind: true, provide: 'pw', command: { ref: 'e2' } },
  { name: 'the agent naming the bound target is the target', bind: true, provide: 'pw', command: { windowId: 'w1', ref: 'e1' }, replies: [{}, { elements: [] }] },
  { name: 'one character is entered by one write', bind: true, provide: 'p', replies: [{}] },
  { name: 'one code point of two code units is one character', bind: true, provide: '😀', replies: [{}] },
  { name: 'two code points are read back', bind: true, provide: '😀a', replies: [{}, { elements: [] }] },
  { name: 'no bound field read back leaves the write', bind: true, provide: 'pw12', replies: [{}, { elements: [{ ref: 'e8', value: 'p', is_password: false }] }] },
  { name: 'an element without a ref leaves the write', bind: true, provide: 'pw12', replies: [{}, { elements: [field({ ref: '' })] }] },
  { name: 'a password field leaves the write', bind: true, provide: 'pw12', replies: [{}, { elements: [field({ value: 'p', is_password: true })] }] },
  { name: 'a field that does not say is a password', bind: true, provide: 'pw12', replies: [{}, { elements: [{ ref: 'e9', value: 'p', bound_ref: true }] }] },
  { name: 'a box holding another value leaves the write', bind: true, provide: 'pw12', replies: [{}, { elements: [field({ value: 'x' })] }] },
  { name: 'a box without a value leaves the write', bind: true, provide: 'pw12', replies: [{}, { elements: [{ ref: 'e9', bound_ref: true, is_password: false }] }] },
  { name: 'a one-character box is typed box to box in the foreground', bind: true, provide: '1234', replies: [{}, { elements: [field({ value: '1' })] }, {}] },
  { name: 'the first bound element is the one used', bind: true, provide: '1234', replies: [{}, { elements: [field({ ref: 'e7', value: '1' }), field({ ref: 'e9', value: '1' })] }, {}] },
  { name: 'a read that fails leaves the write', bind: true, provide: 'pw12', replies: [{}, { error: 'find failed' }] },
  { name: 'a read without elements leaves the write', bind: true, provide: 'pw12', replies: [{}, {}] },
  { name: 'a failed write is blocked', bind: true, provide: 'pw12', replies: [{ error: 'boom' }] },
  { name: 'a stale target is a page change', bind: true, provide: 'pw12', replies: [{ error: 'Error: stale_target: window is gone' }] },
  { name: 'is stale reads as a page change', bind: true, provide: 'pw12', replies: [{ error: 'the ref is stale now' }] },
  { name: 'stale or invalid reads as a page change', bind: true, provide: 'pw12', replies: [{ error: 'Ref was stale or invalid' }] },
  { name: 'the match is case-insensitive', bind: true, provide: 'pw12', replies: [{ error: 'STALE_TARGET' }] },
  { name: 'an unrelated stale word is blocked', bind: true, provide: 'pw12', replies: [{ error: 'the instale thing' }] },
  { name: 'a failed foreground write is judged the same way', bind: true, provide: '1234', replies: [{}, { elements: [field({ value: '1' })] }, { error: 'stale_target' }] },
  { name: 'a failed foreground write that is no stale target is blocked', bind: true, provide: '1234', replies: [{}, { elements: [field({ value: '1' })] }, { error: 'denied' }] },
];
const fillOut = [];
for (const spec of FILL_CASES) {
  const r = registry();
  const requestId = id('fillfill1');
  if (spec.bind) r.bindComputer(requestId, { sessionId: 's1', windowId: 'w1', ref: 'e1' });
  if (spec.provide !== undefined) r.provide(requestId, spec.provide);
  const commands = [];
  const replies = [...(spec.replies ?? [])];
  const execute = async (command) => {
    commands.push(command);
    const reply = replies.shift() ?? {};
    if (reply.error) throw new Error(reply.error);
    return reply;
  };
  const command = { session_id: 's1', request_id: requestId, ...(spec.command?.windowId !== undefined ? { window_id: spec.command.windowId } : {}), ...(spec.command?.ref !== undefined ? { ref: spec.command.ref } : {}) };
  if (spec.command?.sessionId !== undefined) command.session_id = spec.command.sessionId;
  const reply = await typeComputerSecret(command, execute, r, () => {});
  fillOut.push({
    ...spec,
    outcome: reply.text,
    commands,
    after: { has: r.has(requestId), binding: r.computerBinding(requestId), focusArmed: r.focusArmed('s1'), redacted: r.redact('s1', `typed ${spec.provide ?? ''} here`) },
  });
}

// ---- the audit line of an answered gate and the unattended port -------------------------------
const store = () => {
  const rows = [];
  return { rows, recordAudit: async (row) => { rows.push(row); }, grant: async () => false };
};
const member = rooms.roomMemberSessionId('abc123', 'ann');
const homeAnn = homes.agentHomeSessionId('ann');
held.markUnattendedRun('sess_run_ann', { kind: 'webhook', agentId: 'ann', name: 'Hook' });
const AUDIT_CASES = [
  { name: 'an attended session acts for Mixy', session: 'sess_plain', gate: { kind: 'secret', tool: 'handoff_user:browser', target: 'login' }, approval: { response: 'entered', device: 'dev1' } },
  { name: 'a home thread acts for its agent', session: homeAnn, gate: { kind: 'takeover', tool: 'handoff_user:computer', target: 'Settings' }, approval: { response: 'done', device: 'dev2' } },
  { name: 'a room member acts for its agent', session: member, gate: { kind: 'secret', tool: 'handoff_user:computer', target: 'pw' }, approval: { response: 'blocked' } },
  { name: 'a marked run acts for its owner', session: 'sess_run_ann', gate: { kind: 'takeover', tool: 'handoff_user:browser', target: '' }, approval: { response: 'user_skipped', device: 'phone' } },
  { name: 'a device that is no string is none', session: 'sess_plain', gate: { kind: 'secret', tool: 'handoff_user:browser', target: 'x' }, approval: { response: 'expired', device: 5 } },
];
const auditOut = [];
for (const spec of AUDIT_CASES) {
  const s = store();
  const agentId = gate.agentIdForSession(spec.session);
  await gate.recordHumanDecision({ agentId, ...spec.gate }, spec.approval, { store: s });
  auditOut.push({ ...spec, rows: s.rows });
}
const unmark = held.markUnattendedRun('sess_human', { kind: 'schedule', agentId: 'ann', name: 'Daily' });
const aborted = [];
const abortTurn = async (sessionId) => { aborted.push(sessionId); };
const humanOut = [];
for (const [name, session] of [['a marked run', 'sess_human'], ['an attended session', 'sess_plain'], ['a room member', member], ['an unmarked session', 'sess_gone']]) {
  const before = aborted.length;
  const result = await held.failRunForHuman(session, 'login_required', 'example.com', abortTurn);
  humanOut.push({ name, session, result, aborted: aborted.slice(before), humanNeeded: held.unattendedRunOf(session)?.humanNeeded ?? null });
}
unmark();
humanOut.push({ name: 'after the run ends', session: 'sess_human', humanNeeded: held.unattendedRunOf('sess_human')?.humanNeeded ?? null });

writeJson(join(stage, 'golden.json'), {
  timeoutMs: TIMEOUT,
  bindingTimeoutMs: BINDING_TIMEOUT,
  memberSession: member,
  homeSession: homeAnn,
  registry: registryOut,
  fill: fillOut,
  audit: auditOut,
  human: humanOut,
});
writeSetManifest(stage, { set: 'handoff-env', recorder, command: 'node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
process.exit(0);
