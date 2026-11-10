#!/usr/bin/env node
// The error Node's WebSocket stream makes of a close that ends a response before its terminal frame
// (`socket-handlers.mjs` `onClose` → `wsClosedError(code, reasonText)`, `openai-ws-terminal.mjs`): its message, close
// code and the status the code or the reason's words stand for (`_httpStatusFromWsClose`).
// Usage: node ws-close-error-capture.mjs <node-tree> --node-commit <sha> --out <file>
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tree = resolve(process.argv[2]);
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const { wsClosedError } = await import(pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/providers/openai-ws-terminal.mjs')).href);

const CLOSES = [
  [1000, 'bye'],
  [1005, ''],
  [1006, ''],
  [1009, ''],
  [4000, ''],
  [4401, ''],
  [4403, 'x'],
  [4429, ''],
  [1008, 'Token expired'],
  [1008, 'authentication failed'],
  [1008, 'author'],
  [1011, 'POLICY violation'],
  [1011, 'permission denied'],
  [1013, 'Rate limit reached'],
  [1013, 'quota'],
  [1013, 'quotas'],
  [1000, 'unauthorized and rate limit'],
];

const cases = CLOSES.map(([code, reason]) => {
  const error = wsClosedError(code, reason);
  return { code, reason, message: error.message, wsCloseCode: error.wsCloseCode, httpStatus: error.httpStatus ?? null };
});
const self = fileURLToPath(import.meta.url);
const manifest = { exact: true, nodeCommit: arg('--node-commit'), node: process.version, harness: { 'ws-close-error-capture.mjs': crypto.createHash('sha256').update(readFileSync(self)).digest('hex') } };
writeFileSync(resolve(arg('--out')), `${JSON.stringify({ manifest, cases }, null, 1)}\n`);
console.log(cases.map((c) => JSON.stringify(c)).join('\n'));
