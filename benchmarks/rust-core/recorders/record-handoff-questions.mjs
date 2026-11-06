#!/usr/bin/env node
// The handed-off question copies a chat's approval queue holds (`tui/session/tool-approval.mjs`
// `handoffQuestions` / `handoffRecords`): the real `createToolApproval` driven through the delegated
// host. After each step the recording holds what the step returned, what the queue published as
// `handoffQuestions` (null: never published), and the answers the owner's callback received.
//
//   node benchmarks/rust-core/recorders/record-handoff-questions.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/handoff-questions/golden.json
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'handoff-questions-'));
process.env.MIXDOG_DATA_DIR = sandbox;
process.env.MIXDOG_HOME = sandbox;
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }));
const tree = resolveTree(parseArgs());

const host = await importFrom(tree, 'src/runtime/shared/delegated-approval-host.mjs');
const { createToolApproval } = await importFrom(tree, 'src/tui/session/tool-approval.mjs');
const KEY = Symbol.for('mixdog.delegatedApprovalHost.v1');

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const plain = (value) => (value === undefined ? null : value);

async function scenario(name, spec) {
  globalThis[KEY] = undefined;
  let state = { sessionId: 'h1' };
  let disposed = false;
  let api = null;
  const calls = [];
  const answers = {
    yes: (...args) => (calls.push(args.map(plain)), true),
    no: (...args) => (calls.push(args.map(plain)), false),
    truthy: (...args) => (calls.push(args.map(plain)), 1),
    throws: (...args) => {
      calls.push(args.map(plain));
      throw new Error('owner gone');
    },
  };
  const asked = (id, sessionId, label = 'yes', extra = {}) => ({
    id,
    sessionId: 'h1',
    request: { id, kind: 'question', sessionId, ...extra },
    answer: answers[label],
  });
  const tools = {
    create: () => {
      api = createToolApproval({
        getState: () => state,
        set: (patch) => {
          state = { ...state, ...patch };
        },
        nextId: () => 'own-1',
        getDisposed: () => disposed,
        surfaceOf: () => null,
      });
      return null;
    },
    offer: (id, sessionId, label, extra) => host.delegateApproval(asked(id, sessionId, label, extra)) ?? null,
    offerTo: (id, to, sessionId) => host.delegateApproval({ ...asked(id, sessionId), sessionId: to }) ?? null,
    withdraw: (id, result) => (result === undefined ? host.withdrawDelegatedApproval(id) : host.withdrawDelegatedApproval(id, result)) ?? null,
    finish: (id, approved, reason, device, extraAnswers, reply, extra) => api.finishToolApproval(id, approved, reason, device, extraAnswers, reply, extra),
    finishBare: (id, approved) => api.finishToolApproval(id, approved),
    adopt: () => api.adoptDelegatedApprovals() ?? null,
    session: (id) => {
      state = { ...state, sessionId: id };
      return null;
    },
    dispose: () => {
      disposed = true;
      return api.denyAllToolApprovals('runtime closing') ?? null;
    },
  };
  const steps = [];
  for (const step of spec) {
    const [fn, ...args] = step;
    calls.length = 0;
    const returned = tools[fn](...args);
    await settle();
    steps.push({
      call: step,
      returned,
      published: 'handoffQuestions' in state ? state.handoffQuestions : null,
      answered: [...calls],
    });
  }
  return { name, steps };
}

const scenarios = [
  await scenario('questions queue up in order and a duplicate offer changes nothing', [
    ['create'],
    ['offer', 'q1', 't1'],
    ['offer', 'q2', 't2'],
    ['offer', 'q1', 't1'],
    ['offerTo', 'q9', 'elsewhere', 't9'],
  ]),
  await scenario('a settled question stays as an answered record until its session asks again', [
    ['create'],
    ['offer', 'q1', 't1'],
    ['offer', 'q2', 't2'],
    ['withdraw', 'q1', { approved: true, record: 'the answer' }],
    ['offer', 'q3', 't1'],
    ['withdraw', 'q2', { approved: true, record: 'second' }],
    ['withdraw', 'q3', { record: 'third' }],
    ['offer', 'q4', 't2'],
  ]),
  await scenario('a withdrawal without a string record leaves no record', [
    ['create'],
    ['offer', 'q1', 't1'],
    ['offer', 'q2', 't2'],
    ['withdraw', 'q1', { approved: true, record: 7 }],
    ['withdraw', 'q2', { approved: true }],
    ['withdraw', 'q2'],
    ['withdraw', 'unknown', { record: 'x' }],
  ]),
  await scenario('a record whose request names no session is dropped by the next such question', [
    ['create'],
    ['offer', 'q1', undefined],
    ['withdraw', 'q1', { record: 'a' }],
    ['offer', 'q2', ''],
    ['offer', 'q3', 't1'],
  ]),
  await scenario('answering a copy forwards the answer to the owner and removes the copy', [
    ['create'],
    ['offer', 'q1', 't1', 'yes'],
    ['offer', 'q2', 't2', 'no'],
    ['offer', 'q3', 't3', 'truthy'],
    ['offer', 'q4', 't4', 'throws'],
    ['finish', 'q1', true, 'because', 'DESKTOP-7', [['a']], 'reply text', { x: 1 }],
    ['finishBare', 'q2', false],
    ['finishBare', 'q3', true],
    ['finishBare', 'q4', true],
    ['finishBare', 'q1', true],
    ['finishBare', 'nothing', true],
  ]),
  await scenario('the owner settling an answered copy leaves no second record', [
    ['create'],
    ['offer', 'q1', 't1'],
    ['finishBare', 'q1', true],
    ['withdraw', 'q1', { approved: true, record: 'done' }],
    ['offer', 'q2', 't1'],
    ['withdraw', 'q2', { record: 'kept' }],
    ['finishBare', 'q2', true],
  ]),
  await scenario('a record is never answered here', [
    ['create'],
    ['offer', 'q1', 't1'],
    ['withdraw', 'q1', { record: 'kept' }],
    ['finishBare', 'q1', true],
  ]),
  await scenario('a copy of a session that reloads is adopted from the pending requests', [
    ['offer', 'q1', 't1'],
    ['offer', 'q2', 't2'],
    ['create'],
    ['adopt'],
    ['adopt'],
    ['session', 'h2'],
    ['offer', 'q3', 't3'],
  ]),
  await scenario('the copies follow the session id the runtime has now', [
    ['create'],
    ['session', 'h2'],
    ['offer', 'q1', 't1'],
    ['offerTo', 'q2', 'h2', 't2'],
    ['session', 'h1'],
    ['adopt'],
  ]),
  await scenario('closing drops every copy and record silently and refuses new ones', [
    ['create'],
    ['offer', 'q1', 't1'],
    ['offer', 'q2', 't2'],
    ['withdraw', 'q1', { record: 'kept' }],
    ['dispose'],
    ['offer', 'q3', 't3'],
    ['adopt'],
    ['finishBare', 'q2', true],
  ]),
];

const finalOut = join(FIXTURES_ROOT, 'handoff-questions');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'what the real 1.4.5 tool-approval.mjs queue publishes as handoffQuestions for each scripted step; `published: null` means it never published',
  scenarios,
});
writeSetManifest(out, {
  set: 'handoff-questions',
  recorder: 'benchmarks/rust-core/recorders/record-handoff-questions.mjs',
  command: 'node benchmarks/rust-core/recorders/record-handoff-questions.mjs --tree <tree>',
  extra: { scenarios: scenarios.length },
});
commitStage(out, finalOut);
console.log(`scenarios=${scenarios.length}`);
