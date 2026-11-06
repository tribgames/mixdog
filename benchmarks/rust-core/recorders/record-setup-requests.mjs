#!/usr/bin/env node
// Golden twin of the desktop-host setup requests: what Node's real `createSetupUiRequests`
// (setup-tool/ui-requests.mjs) answers to scripted sequences of request / claim / isActive /
// complete / abort / wait / dispose calls from two sessions, with a short or a long claim and
// execution window. After every step the settled outcome of every request is recorded.
//
//   node benchmarks/rust-core/recorders/record-setup-requests.mjs --tree <dir>
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { createSetupUiRequests } = await importFrom(tree, 'src/session-runtime/setup-tool/ui-requests.mjs');

let seed = 0x5e7a9;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;

// owners sticky per world are not needed: claims pick from a small set.
const SESSIONS = ['s1', 's1', 's2', ''];
const OWNERS = ['desk', 'desk', 'other', ' ', '', 'win 2'];
const RECEIPTS = [
  { result: { saved: true } },
  { result: null },
  { result: 7 },
  {},
  { error: 'Desktop storage failed' },
  { error: 'x', result: 1 },
  { error: 0, result: 'kept' },
  { error: 5 },
  { error: { a: 1 } },
  { error: true },
  { error: '' },
  [],
  [1],
  null,
  'text',
  42,
  true,
];
const ARGS = [{ action: 'set_desktop_settings' }, { action: 'set_appearance', n: 1 }, {}];

const settle = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stateOf(request) {
  if (!request.settled) return 'pending';
  if (request.settled.err !== undefined) {
    if (request.settled.err.startsWith('setup: cancelled')) return 'cancelled';
    return { err: request.settled.err, code: request.settled.code ?? null };
  }
  return { ok: request.settled.ok === undefined ? null : request.settled.ok };
}

const worlds = [];
for (let w = 0; w < 160; w += 1) {
  const claimMs = chance(0.15) ? 5 : 60_000;
  const execMs = chance(0.15) ? 5 : 60_000;
  let current = '';
  const requests = [];
  const broker = createSetupUiRequests({
    notifySessionUi: (_session, _title, meta) => {
      const request = requests.find((r) => r.id === undefined && r.pendingMeta);
      request.id = meta.id;
      return request.attach;
    },
    getSessionId: () => current,
    claimTimeoutMs: claimMs,
    executionTimeoutMs: execMs,
  });
  const steps = [];
  const length = 4 + Math.floor(rnd() * 10);
  for (let s = 0; s < length; s += 1) {
    const kind = requests.length === 0 ? 'request' : pick(['request', 'claim', 'claim', 'claim', 'active', 'active', 'complete', 'complete', 'complete', 'complete', 'abort', 'wait', 'dispose']);
    const step = { op: kind };
    let result;
    if (kind === 'request') {
      step.session = pick(['s1', 's1', 's2']);
      step.attach = chance(0.85);
      step.args = pick(ARGS);
      current = step.session;
      const controller = new AbortController();
      const request = { session: step.session, attach: step.attach, pendingMeta: true, controller, settled: null };
      requests.push(request);
      request.promise = broker.request(step.args, { signal: controller.signal }).then(
        (ok) => (request.settled = { ok }),
        (error) => (request.settled = { err: error.message, code: error.code }),
      );
      request.pendingMeta = false;
    } else if (kind === 'wait') {
      step.ms = 20;
      await sleep(step.ms);
    } else if (kind === 'dispose') {
      broker.dispose();
    } else {
      step.target = chance(0.6) ? requests.length - 1 : Math.floor(rnd() * requests.length);
      const request = requests[step.target];
      step.session = chance(0.7) ? request.session : pick(SESSIONS);
      current = step.session;
      step.owner = chance(0.7) ? pick(['desk', 'win 2']) : pick(OWNERS);
      if (kind === 'claim') result = broker.claimSetupRequest(request.id, step.owner);
      else if (kind === 'active') result = broker.isSetupRequestActive(request.id, step.owner);
      else if (kind === 'complete') {
        step.receipt = pick(RECEIPTS);
        try {
          result = broker.completeSetupRequest(request.id, step.owner, step.receipt);
        } catch (error) {
          result = { throws: error.message };
        }
      } else request.controller.abort();
    }
    await settle();
    await settle();
    steps.push({ ...step, result: result === undefined ? null : result, states: requests.map(stateOf) });
  }
  broker.dispose();
  await settle();
  worlds.push({ claimMs, execMs, steps, final: requests.map(stateOf) });
}

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'setup-requests-twin.json'), {
  domain: 'setup-requests-twin',
  recorder: 'benchmarks/rust-core/recorders/record-setup-requests.mjs',
  worlds,
});
console.log(`recorded ${worlds.length} worlds, ${worlds.reduce((n, w) => n + w.steps.length, 0)} steps`);
