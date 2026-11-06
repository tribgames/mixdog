#!/usr/bin/env node
// The delegated-approval host (`runtime/shared/delegated-approval-host.mjs`): which chats hand a session
// work, the copies of its requests those chats show, and when each copy is offered or withdrawn. Each
// scenario drives the real module through a list of steps; after every step the recording holds what
// the call returned, the fake queues' offers/withdrawals since the last step (in order), the hand-off
// chats, and the copies each chat holds.
//
//   node benchmarks/rust-core/recorders/record-delegated-host.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/delegated-host/golden.json
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'delegated-host-'));
process.env.MIXDOG_DATA_DIR = sandbox;
process.env.MIXDOG_HOME = sandbox;
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }));
const tree = resolveTree(parseArgs());

const host = await importFrom(tree, 'src/runtime/shared/delegated-approval-host.mjs');
const KEY = Symbol.for('mixdog.delegatedApprovalHost.v1');

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const shape = (delegated) => ({ id: delegated.id, sessionId: delegated.sessionId, request: delegated.request, answer: delegated.answer?.label ?? null });

/** One scenario: `setup` names the queues and the opener; steps run in order. */
async function scenario(name, spec) {
  globalThis[KEY] = undefined;
  const events = [];
  const queues = {};
  const live = new Map();
  const make = (queueName, sessionId) => {
    const state = { sessionId, disposed: false };
    const queue = {
      sessionId: () => state.sessionId,
      disposed: () => state.disposed,
      offer: (delegated) => events.push({ queue: queueName, call: 'offer', delegated: shape(delegated) }),
      withdraw: (id, result) => events.push({ queue: queueName, call: 'withdraw', id, result }),
    };
    queues[queueName] = { state, queue };
    return queue;
  };
  const openers = { calls: [], mode: 'ok', onOpen: null };
  const tools = {
    register: (queueName, sessionId) => {
      const off = host.registerApprovalQueue(make(queueName, sessionId));
      live.set(queueName, off);
      return null;
    },
    unregister: (queueName) => live.get(queueName)(),
    dispose: (queueName) => {
      queues[queueName].state.disposed = true;
      return null;
    },
    opener: (mode) => {
      openers.mode = mode;
      host.registerDelegatedApprovalOpener(async (sessionId) => {
        openers.calls.push(sessionId);
        events.push({ opener: sessionId });
        openers.onOpen?.(sessionId);
        if (openers.mode === 'reject') throw new Error('cannot open');
      });
      return null;
    },
    // The chat's queue appears while the opener runs.
    registerOnOpen: (queueName, sessionId) => {
      openers.onOpen = () => tools.register(queueName, sessionId);
      return null;
    },
    // The request is withdrawn while the opener runs.
    withdrawOnOpen: (id) => {
      openers.onOpen = () => host.withdrawDelegatedApproval(id);
      return null;
    },
    note: (watch) => host.noteHandoff(watch) ?? null,
    end: (runId) => host.endHandoff(runId) ?? null,
    chats: (sessionId) => [...host.handoffChatsOf(sessionId)],
    toHandoffs: (asked) => host.delegateToHandoffs({ ...asked, answer: Object.assign(() => true, { label: asked.answer }), copyFor: (chat, { title }) => ({ ...asked.request, surfaceSessionId: chat, handoff: { title } }) }) ?? null,
    approval: (delegated) => host.delegateApproval({ ...delegated, answer: Object.assign(() => true, { label: delegated.answer }) }) ?? null,
    withdraw: (id, result) => (result === undefined ? host.withdrawDelegatedApproval(id) : host.withdrawDelegatedApproval(id, result)) ?? null,
    open: (sessionId) => host.delegatedApprovalsFor(sessionId).map(shape),
  };
  const steps = [];
  for (const step of spec) {
    const [fn, ...args] = step;
    events.length = 0;
    const returned = tools[fn](...args);
    await settle();
    steps.push({ call: step, returned, events: [...events] });
  }
  return { name, steps };
}

const watch = (runId, taskSessionId, homeSessionId, title) => ({ runId, taskSessionId, homeSessionId, title });
const ask = (id, sessionId, answer = 'a') => ({ id, sessionId, request: { id, kind: 'approval', sessionId }, answer });
const question = (id, sessionId) => ({ id, sessionId, request: { id, kind: 'question', sessionId }, answer: 'q' });

const scenarios = [
  await scenario('a hand-off needs a run, a task, a chat, and not itself', [
    ['note', watch('', 't1', 'h1', 'T')],
    ['note', watch('r1', '', 'h1', 'T')],
    ['note', watch('r1', 't1', '', 'T')],
    ['note', watch('r1', 't1', 't1', 'T')],
    ['chats', 't1'],
    ['note', watch('r1', 't1', 'h1', undefined)],
    ['chats', 't1'],
    ['note', { runId: 7, taskSessionId: 't1', homeSessionId: 'h2', title: 9 }],
    ['chats', 't1'],
  ]),
  await scenario('a chat is listed once with its latest title, last noted last', [
    ['note', watch('r1', 't1', 'h1', 'One')],
    ['note', watch('r2', 't1', 'h2', 'Two')],
    ['chats', 't1'],
    ['note', watch('r3', 't1', 'h1', 'Three')],
    ['chats', 't1'],
    ['note', watch('r1', 't1', 'h1', 'Again')],
    ['chats', 't1'],
    ['end', 'r3'],
    ['chats', 't1'],
    ['end', 'r1'],
    ['chats', 't1'],
    ['end', 'r2'],
    ['chats', 't1'],
    ['end', 'never-noted'],
  ]),
  await scenario('an ended hand-off is never noted again', [
    ['note', watch('r1', 't1', 'h1', 'One')],
    ['end', 'r1'],
    ['chats', 't1'],
    ['note', watch('r1', 't1', 'h1', 'One')],
    ['chats', 't1'],
    ['end', 'r9'],
    ['note', watch('r9', 't1', 'h1', 'Nine')],
    ['chats', 't1'],
  ]),
  await scenario('a request reaches every chat handing the session work, one copy each', [
    ['register', 'home', 'h1'],
    ['register', 'other', 'h2'],
    ['register', 'task', 't1'],
    ['note', watch('r1', 't1', 'h1', 'Fix login')],
    ['toHandoffs', ask('ap1', 't1')],
    ['open', 'h1'],
    ['open', 'h2'],
    ['note', watch('r2', 't1', 'h2', 'Fix login too')],
    ['open', 'h2'],
    ['note', watch('r3', 't1', 'h1', 'Third')],
    ['end', 'r1'],
    ['open', 'h1'],
    ['end', 'r3'],
    ['open', 'h1'],
    ['open', 'h2'],
    ['withdraw', 'ap1', { approved: true, device: 'DESKTOP-7' }],
    ['open', 'h2'],
    ['withdraw', 'ap1'],
  ]),
  await scenario('questions are copied the same way and settle with their record', [
    ['register', 'home', 'h1'],
    ['note', watch('r1', 't1', 'h1', 'Ask')],
    ['toHandoffs', question('q1', 't1')],
    ['toHandoffs', ask('ap2', 't2')],
    ['note', watch('r2', 't2', 'h1', 'Other task')],
    ['open', 'h1'],
    ['withdraw', 'q1', { approved: true, record: 'answered' }],
    ['open', 'h1'],
    ['end', 'r2'],
    ['open', 'h1'],
  ]),
  await scenario('a chat that is not loaded gets its copy once the opener has brought it up', [
    ['opener', 'ok'],
    ['registerOnOpen', 'home', 'h1'],
    ['note', watch('r1', 't1', 'h1', 'Late')],
    ['toHandoffs', ask('ap1', 't1')],
    ['open', 'h1'],
    ['withdraw', 'ap1'],
  ]),
  await scenario('an opener that fails leaves the copy undelivered', [
    ['opener', 'reject'],
    ['note', watch('r1', 't1', 'h1', 'Late')],
    ['toHandoffs', ask('ap1', 't1')],
    ['register', 'home', 'h1'],
    ['open', 'h1'],
  ]),
  await scenario('a request settled while the opener runs is not offered afterwards', [
    ['opener', 'ok'],
    ['registerOnOpen', 'home', 'h1'],
    ['withdrawOnOpen', 'ap1'],
    ['approval', ask('ap1', 'h1')],
    ['open', 'h1'],
  ]),
  await scenario('a sub-agent request is shown by the top-level chat only', [
    ['register', 'home', 'h1'],
    ['register', 'sub', 's1'],
    ['approval', ask('ap1', 'h1')],
    ['approval', ask('ap2', 'h2')],
    ['open', 'h1'],
    ['open', 'h2'],
    ['open', 's1'],
    ['withdraw', 'ap1', { approved: false, device: 'D' }],
    ['withdraw', 'ap1', { approved: false, device: 'D' }],
    ['open', 'h1'],
  ]),
  await scenario('a request delegated twice under one id keeps its place and the newest request', [
    ['register', 'home', 'h1'],
    ['approval', ask('ap1', 'h1', 'first')],
    ['approval', ask('ap2', 'h1', 'second')],
    ['approval', ask('ap1', 'h1', 'third')],
    ['open', 'h1'],
  ]),
  await scenario('queues that are disposed or unregistered are not offered', [
    ['register', 'a', 'h1'],
    ['register', 'b', 'h1'],
    ['dispose', 'a'],
    ['approval', ask('ap1', 'h1')],
    ['unregister', 'b'],
    ['approval', ask('ap2', 'h1')],
    ['open', 'h1'],
  ]),
  await scenario('two queues of one chat both get the copy', [
    ['register', 'a', 'h1'],
    ['register', 'b', 'h1'],
    ['note', watch('r1', 't1', 'h1', 'Both')],
    ['toHandoffs', ask('ap1', 't1')],
    ['withdraw', 'ap1'],
  ]),
];

const finalOut = join(FIXTURES_ROOT, 'delegated-host');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'what the real 1.4.5 delegated-approval-host.mjs does for each scripted step; `answer` is the label of the answer callback',
  scenarios,
});
writeSetManifest(out, {
  set: 'delegated-host',
  recorder: 'benchmarks/rust-core/recorders/record-delegated-host.mjs',
  command: 'node benchmarks/rust-core/recorders/record-delegated-host.mjs --tree <tree>',
  extra: { scenarios: scenarios.length },
});
commitStage(out, finalOut);
console.log(`scenarios=${scenarios.length}`);
