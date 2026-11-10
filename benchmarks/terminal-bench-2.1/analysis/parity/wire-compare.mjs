#!/usr/bin/env node
// Compares Node's wire recording (node-wire-capture.mjs) with the Rust core's (the `MIXDOG_WIRE_RUST_OUT` file written by
// the `wire_parity_tests` test of mixdog-core), whole and in order: both are lists of scenarios, each a list of what a
// loopback server received (request lines, headers with their values in the order sent, bodies, frames). Nothing is
// sorted, lower-cased, deduplicated or skipped: a header list is an array of pairs, so its order, its duplicates and the
// case of its names are compared with the rest; a scenario, event or field one side lacks is a difference. Every
// difference is listed; exit 1 when there is any. The manifest of the Node recording is verified first.
// Usage: node wire-compare.mjs <node-recording.json> <rust-recording.json> [provider]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_COMMIT = 'b6f10295a';
const here = dirname(fileURLToPath(import.meta.url));
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const short = (value) => {
  const text = JSON.stringify(value);
  return text === undefined ? 'undefined' : text.length > 200 ? `${text.slice(0, 197)}...` : text;
};

/** Where two texts first differ, with the text around it. */
function firstDifference(node, rust) {
  let at = 0;
  while (at < node.length && at < rust.length && node[at] === rust[at]) at += 1;
  const around = (s) => s.slice(Math.max(0, at - 40), at + 80);
  return `differ at char ${at} (node ${node.length}, rust ${rust.length})\n   node: ${around(node)}\n   rust: ${around(rust)}`;
}

/** Every difference between two values of the same recording, as lines, appended to `out`. */
export function diff(path, node, rust, out = []) {
  if (Array.isArray(node) && Array.isArray(rust)) {
    if (node.length !== rust.length) out.push(`${path}: ${node.length} entries in Node, ${rust.length} in Rust`);
    for (let index = 0; index < Math.min(node.length, rust.length); index += 1) diff(`${path}[${index}]`, node[index], rust[index], out);
  } else if (node && rust && typeof node === 'object' && typeof rust === 'object' && !Array.isArray(node) && !Array.isArray(rust)) {
    for (const key of Object.keys(node)) {
      if (key in rust) diff(`${path}.${key}`, node[key], rust[key], out);
      else out.push(`${path}.${key}: only in Node`);
    }
    for (const key of Object.keys(rust)) if (!(key in node)) out.push(`${path}.${key}: only in Rust`);
  } else if (typeof node === 'string' && typeof rust === 'string') {
    if (node !== rust) out.push(`${path}: ${firstDifference(node, rust)}`);
  } else if (JSON.stringify(node) !== JSON.stringify(rust)) {
    out.push(`${path}: ${short(node)} in Node, ${short(rust)} in Rust`);
  }
  return out;
}

/** The scenarios of `provider` (all of them without one) of both recordings, compared whole. */
export function compareRecordings(node, rust, provider) {
  const of = (recording) => recording.scenarios.filter((s) => !provider || s.provider === provider);
  return diff('scenarios', of(node), of(rust));
}

/** The manifest says what the Node recording is a function of; every part is checked against the files committed beside it. */
export function verifyManifest(manifest, dir = here) {
  const out = [];
  const expect = (what, have, want) => { if (have !== want) out.push(`manifest ${what}: ${short(have)}, expected ${short(want)}`); };
  expect('exact', manifest.exact, true);
  expect('nodeCommit', manifest.nodeCommit, NODE_COMMIT);
  expect('sessionSha256', manifest.sessionSha256, sha256(join(dir, 'fixtures/session.json')));
  expect('scenariosSha256', manifest.scenariosSha256, sha256(join(dir, 'scenarios.json')));
  const files = ['node-wire-capture.mjs', 'wire-server.mjs'];
  expect('harness files', JSON.stringify(Object.keys(manifest.harness || {}).sort()), JSON.stringify(files));
  for (const file of files) expect(`harness ${file}`, manifest.harness?.[file], sha256(join(dir, file)));
  expect('replaced', JSON.stringify(manifest.replaced?.map((r) => [r.kind, r.header, r.value])), JSON.stringify([['ws-upgrade', 'Sec-WebSocket-Key', '<random>']]));
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())) {
  const node = read(process.argv[2]);
  const differences = [...verifyManifest(node.manifest), ...compareRecordings(node, read(process.argv[3]), process.argv[4])];
  for (const line of differences) console.log(line);
  console.log(`${differences.length} differences`);
  process.exitCode = differences.length ? 1 : 0;
}
