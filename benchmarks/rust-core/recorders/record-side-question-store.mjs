#!/usr/bin/env node
// What Node keeps of a session's side-question state: the real `captureSideQuestionRequest`,
// `retireCompactionFork`, `forgetSideQuestion`, `beginSideQuestion` and `cancelSideQuestion`
// (session/side-question-store.mjs) driven through scripted scenarios, the state read back after every
// step with the real `sideQuestionRequest` and `compactionForkRequest`, nothing masked. Rust
// `mixdog-core` `run_host::side_wiring` (`SideRequests` capture/settle/discard, `SideQuestionService`
// begin/cancel/forget and the compaction retire) must reach the same state at every step.
//
//   node benchmarks/rust-core/recorders/record-side-question-store.mjs [--tree <dir>]
//
// Output: native/core/fixtures/side-question-store/golden.json.
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'side-question-store');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-side-question-store.mjs';
const at = (path) => importFrom(tree, path);
const store = await at('src/runtime/agent/orchestrator/session/side-question-store.mjs');

// A step: capture{as,session,messages,owner?} settle{as} discard{as} retire{session}
// forget{session,cancel} begin{as,session} end{as} cancel{session}.
const scenarios = [
  { name: 'a sent request is kept unsettled, settles, and is forkable', steps: [
    { op: 'capture', as: 'a', session: 's', messages: 1 },
    { op: 'settle', as: 'a' },
  ] },
  { name: 'a failed send puts the previous request back', steps: [
    { op: 'capture', as: 'a', session: 's', messages: 1 },
    { op: 'settle', as: 'a' },
    { op: 'capture', as: 'b', session: 's', messages: 2 },
    { op: 'discard', as: 'b' },
  ] },
  { name: 'a failed first send leaves nothing', steps: [
    { op: 'capture', as: 'a', session: 's', messages: 1 },
    { op: 'discard', as: 'a' },
  ] },
  { name: 'a settle reaches a request a later send displaced, which comes back if that send fails', steps: [
    { op: 'capture', as: 'a', session: 's', messages: 1 },
    { op: 'capture', as: 'b', session: 's', messages: 2 },
    { op: 'settle', as: 'a' },
    { op: 'discard', as: 'b' },
  ] },
  { name: 'a failed send that is no longer the latest changes nothing', steps: [
    { op: 'capture', as: 'a', session: 's', messages: 1 },
    { op: 'settle', as: 'a' },
    { op: 'capture', as: 'b', session: 's', messages: 2 },
    { op: 'capture', as: 'c', session: 's', messages: 3 },
    { op: 'discard', as: 'b' },
    { op: 'settle', as: 'c' },
  ] },
  { name: 'an agent session keeps nothing, however its owner is spelled', steps: [
    { op: 'capture', as: 'a', session: 's', messages: 1 },
    { op: 'settle', as: 'a' },
    { op: 'capture', as: 'g', session: 's', messages: 5, owner: ' Agent ' },
    { op: 'settle', as: 'g' },
    { op: 'capture', as: 'h', session: 's', messages: 6, owner: 'agent' },
    { op: 'discard', as: 'h' },
    { op: 'capture', as: 'i', session: 's', messages: 7, owner: 'agents' },
  ] },
  { name: 'a compaction retires the fork, a side question still forks it, the next request replaces it', steps: [
    { op: 'capture', as: 'a', session: 's', messages: 1 },
    { op: 'retire', session: 's' },
    { op: 'settle', as: 'a' },
    { op: 'retire', session: 's' },
    { op: 'capture', as: 'b', session: 's', messages: 2 },
    { op: 'settle', as: 'b' },
  ] },
  { name: 'retiring a session with no request changes nothing', steps: [
    { op: 'retire', session: 's' },
    { op: 'forget', session: 's', cancel: false },
  ] },
  { name: 'clear and rewind forget the request and leave the question in flight; a close cancels it', steps: [
    { op: 'capture', as: 'a', session: 's', messages: 1 },
    { op: 'settle', as: 'a' },
    { op: 'begin', as: 'q1', session: 's' },
    { op: 'forget', session: 's', cancel: false },
    { op: 'capture', as: 'b', session: 's', messages: 2 },
    { op: 'settle', as: 'b' },
    { op: 'forget', session: 's', cancel: true },
    { op: 'cancel', session: 's' },
  ] },
  { name: 'one question per session: a new begin aborts the old one, whose end leaves the new alone', steps: [
    { op: 'begin', as: 'q1', session: 's' },
    { op: 'begin', as: 'q2', session: 's' },
    { op: 'end', as: 'q1' },
    { op: 'cancel', session: 's' },
    { op: 'cancel', session: 's' },
    { op: 'begin', as: 'q3', session: 's' },
    { op: 'end', as: 'q3' },
    { op: 'cancel', session: 's' },
  ] },
  { name: 'sessions are independent', steps: [
    { op: 'capture', as: 'a', session: 's', messages: 1 },
    { op: 'settle', as: 'a' },
    { op: 'capture', as: 'b', session: 't', messages: 2 },
    { op: 'begin', as: 'q1', session: 's' },
    { op: 'begin', as: 'q2', session: 't' },
    { op: 'forget', session: 's', cancel: true },
    { op: 'retire', session: 't' },
    { op: 'cancel', session: 't' },
  ] },
];

const sessions = ['s', 't'];
function observe(runs) {
  const state = {};
  for (const session of sessions) {
    const request = store.sideQuestionRequest(session);
    state[session] = {
      request: request ? { messages: request.messages.length, settled: request.response != null, compacted: request.compacted === true } : null,
      forkable: store.compactionForkRequest(session) != null,
    };
  }
  const aborted = {};
  for (const [name, run] of Object.entries(runs)) aborted[name] = run.signal.aborted;
  return { state, aborted };
}

const recorded = [];
for (const scenario of scenarios) {
  for (const session of sessions) store.forgetSideQuestion(session, { cancel: true });
  const handles = {};
  const runs = {};
  const steps = [];
  for (const step of scenario.steps) {
    let returned;
    if (step.op === 'capture') {
      handles[step.as] = store.captureSideQuestionRequest({
        sessionId: step.session,
        sessionRef: step.owner === undefined ? { owner: 'lead' } : { owner: step.owner },
        provider: {},
        model: 'm',
        messages: Array.from({ length: step.messages }, (_, i) => ({ role: 'user', content: String(i) })),
        tools: [],
        opts: {},
      });
    } else if (step.op === 'settle') handles[step.as].settle({ content: 'reply' });
    else if (step.op === 'discard') handles[step.as].discard();
    else if (step.op === 'retire') store.retireCompactionFork(step.session);
    else if (step.op === 'forget') store.forgetSideQuestion(step.session, { cancel: step.cancel });
    else if (step.op === 'begin') runs[step.as] = store.beginSideQuestion(step.session);
    else if (step.op === 'end') runs[step.as].end();
    else if (step.op === 'cancel') returned = store.cancelSideQuestion(step.session);
    else throw new Error(`unknown step ${step.op}`);
    steps.push({ step, ...(returned === undefined ? {} : { returned }), ...observe(runs) });
  }
  recorded.push({ name: scenario.name, steps });
}
writeJson(join(stage, 'golden.json'), { scenarios: recorded });
writeSetManifest(stage, { set: 'side-question-store', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
console.log(`side-question store: ${recorded.length} scenarios, ${recorded.reduce((n, s) => n + s.steps.length, 0)} steps`);
process.exit(0);