#!/usr/bin/env node
// Compares Node's wire recording (node-wire-capture.mjs) with the Rust core's (the `MIXDOG_WIRE_RUST_OUT` file written by
// the `wire_parity_tests` test of mixdog-core), scenario by scenario and entry by entry, in order: the kind of every
// transport event, the url, every header handed to the transport (credentials and content-encoding included) and the
// body as sent (encoding, length, sha256, text) or the websocket frame. Header names are case-insensitive and header order
// carries no meaning; nothing else is normalised or filtered. Every difference is listed; exit 1 when there is any.
// Usage: node wire-compare.mjs <node-recording.json> <rust-recording.json> [provider]
import { readFileSync } from 'node:fs';

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const headers = (list) => (list || []).map(([name, value]) => [String(name).toLowerCase(), String(value)]).sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
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

/** Every difference between two traffic lists, as lines. */
export function compareTraffic(id, node, rust) {
  const out = [];
  const kinds = (list) => list.map((entry) => entry.kind);
  if (JSON.stringify(kinds(node)) !== JSON.stringify(kinds(rust))) return [`${id}: the transports saw ${kinds(node)} in Node, ${kinds(rust)} in Rust`];
  node.forEach((n, index) => {
    const r = rust[index];
    const at = `${id}[${index}] ${n.kind}`;
    if (n.kind === 'ws-frame') {
      if (n.text !== r.text) out.push(`${at}: ${firstDifference(n.text, r.text)}`);
      return;
    }
    for (const key of ['method', 'url']) if (n[key] !== r[key]) out.push(`${at}: ${key} ${short(n[key])} in Node, ${short(r[key])} in Rust`);
    if (JSON.stringify(headers(n.headers)) !== JSON.stringify(headers(r.headers))) {
      const have = (list) => new Set(headers(list).map((h) => JSON.stringify(h)));
      const [a, b] = [have(n.headers), have(r.headers)];
      for (const h of a) if (!b.has(h)) out.push(`${at}: header only in Node ${h}`);
      for (const h of b) if (!a.has(h)) out.push(`${at}: header only in Rust ${h}`);
    }
    if (n.kind === 'http') {
      for (const key of ['encoding', 'bytes', 'sha256']) if (n.body[key] !== r.body[key]) out.push(`${at}: body ${key} ${short(n.body[key])} in Node, ${short(r.body[key])} in Rust`);
      if (n.body.text !== r.body.text) out.push(`${at}: body text ${firstDifference(n.body.text || '', r.body.text || '')}`);
    }
  });
  return out;
}

export function compareRecordings(node, rust, provider) {
  const out = [];
  for (const scenario of node.scenarios.filter((s) => !provider || s.provider === provider)) {
    const other = rust.scenarios.find((s) => s.id === scenario.id);
    out.push(...(other ? compareTraffic(scenario.id, scenario.traffic, other.traffic) : [`${scenario.id}: Rust did not run it`]));
  }
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())) {
  const differences = compareRecordings(read(process.argv[2]), read(process.argv[3]), process.argv[4]);
  for (const line of differences) console.log(line);
  console.log(`${differences.length} differences`);
  process.exitCode = differences.length ? 1 : 0;
}
