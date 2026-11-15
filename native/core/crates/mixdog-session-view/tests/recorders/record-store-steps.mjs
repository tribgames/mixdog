#!/usr/bin/env node
// Records the states the TypeScript session state (packages/protocol-client/src/session-state.ts: `sessionReducer`,
// `desktopSessionState`) publishes over feeds a store is driven with: the golden the Rust store (src/store.rs) is compared with by
// tests/store_mock.rs. The store publishes a changed state once per terminal frame: every step of a feed marks the state changed and
// a tick publishes it, so a schedule of `tickEvery: n` publishes the state after every nth step (and the state after a snapshot,
// which the store publishes on opening). The feeds are the ones of tests/goldens/fold.json (the synthetic fold feeds: deltas,
// a Stop during tools, a history reset, approvals pending and resolved, every section), taken by name; the states are recomputed here
// by the TypeScript code, not copied from that file.
//
//   node record-store-steps.mjs --tree <tree root> [--out file | --check file]
//
// Without --out or --check the recording goes to stdout. --check writes nothing and exits 1 when the file differs.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
};
const tree = flag('--tree');
if (!tree) {
  console.error('record-store-steps: --tree <tree root> is required');
  process.exit(2);
}
const { sessionReducer, desktopSessionState } = await import(pathToFileURL(resolve(tree, 'packages/protocol-client/src/session-state.ts')).href);
const here = dirname(fileURLToPath(import.meta.url));
const fold = JSON.parse(readFileSync(resolve(here, '../goldens/fold.json'), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

const FEEDS = ['interleaved-deltas', 'stop-during-tools', 'history-reset', 'approvals', 'sections'];
const SCHEDULES = [1, 4];

function scenario(feedName, tickEvery) {
  const feed = fold.feeds.find((candidate) => candidate.name === feedName);
  if (!feed) throw new Error(`no feed ${feedName} in goldens/fold.json`);
  let state = null;
  let requests = [];
  let host;
  let dirty = false;
  const published = [];
  const publish = (after) => {
    published.push({ after, state: clone(desktopSessionState(state, requests, host)) });
    dirty = false;
  };
  feed.steps.forEach((step, at) => {
    if (step.requests !== undefined) requests = step.requests;
    if (step.hostShellJobs !== undefined) host = step.hostShellJobs;
    if (step.method === 'thread/snapshot') state = sessionReducer.initial(clone(step.params));
    else state = sessionReducer.apply(state, { jsonrpc: '2.0', method: step.method, params: clone(step.params) });
    dirty = true;
    if (at === 0) publish(at); // the store publishes the state it opens with
    else if (at % tickEvery === tickEvery - 1 && dirty) publish(at);
  });
  if (dirty) publish(feed.steps.length - 1); // a last tick
  return { name: `${feedName}/every-${tickEvery}`, feed: feedName, tickEvery, published };
}

const recording = { scenarios: FEEDS.flatMap((feed) => SCHEDULES.map((every) => scenario(feed, every))) };
const text = `${JSON.stringify(recording, null, 1)}\n`;

const check = flag('--check');
const out = flag('--out');
if (check) {
  const held = readFileSync(resolve(check), 'utf8');
  if (held !== text) {
    console.error(`record-store-steps: ${check} differs from the recording`);
    process.exit(1);
  }
} else if (out) {
  writeFileSync(resolve(out), text);
} else {
  process.stdout.write(text);
}
