#!/usr/bin/env node
// Compares, per provider route, the request Node's builders put on the wire (node-wire-capture.mjs) with the Rust core's
// `snapshot` (rust-capture.mjs): url, headers and the whole JSON body. Key order and whitespace are not differences (both
// sides are parsed); every other difference is listed with its JSON path and both values.
// Usage: node wire-compare.mjs <node-wire.json> <rust.json>
import { readFileSync } from 'node:fs';

const short = (value) => {
  const text = JSON.stringify(value);
  return text === undefined ? 'undefined' : text.length > 160 ? `${text.slice(0, 157)}...` : text;
};

/** Every path at which `a` and `b` differ (objects by key, arrays by index), in document order. */
export function diffs(a, b, path = '$') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    const rest = keys.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
    return rest.flatMap((key) => (key in a && key in b ? diffs(a[key], b[key], `${path}.${key}`) : [{ path: `${path}.${key}`, node: a[key], rust: b[key], only: key in a ? 'node' : 'rust' }]));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const out = [];
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (i >= a.length || i >= b.length) out.push({ path: `${path}[${i}]`, node: a[i], rust: b[i], only: i < a.length ? 'node' : 'rust' });
      else out.push(...diffs(a[i], b[i], `${path}[${i}]`));
    }
    return out;
  }
  return [{ path, node: a, rust: b }];
}

export function compareRoute(node, rust) {
  const request = node.captured.find((c) => /\/(responses|messages|v1\/messages)$|streamGenerateContent/.test(c.url));
  if (!request) return { error: 'Node captured no model request' };
  const headers = (list) => Object.fromEntries((Array.isArray(list) ? list : Object.entries(list)).map(([k, v]) => [String(k).toLowerCase(), v]));
  return {
    url: diffs(request.url, rust.snapshot.url, 'url'),
    headers: diffs(headers(request.headers), headers(rust.snapshot.headers), 'headers'),
    body: diffs(JSON.parse(request.body), rust.snapshot.body, 'body'),
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())) {
  const nodeRoutes = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const rustRoutes = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  for (const node of nodeRoutes) {
    const rust = rustRoutes.find((r) => r.provider === node.provider);
    console.log(`## ${node.provider}`);
    const result = compareRoute(node, rust);
    if (result.error) { console.log(result.error); continue; }
    for (const part of ['url', 'headers', 'body']) {
      for (const d of result[part]) console.log(`${d.path}${d.only ? ` (only ${d.only})` : ''}\n   node: ${short(d.node)}\n   rust: ${short(d.rust)}`);
    }
  }
}
