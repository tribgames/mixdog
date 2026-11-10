#!/usr/bin/env node
// What Node's WebSocket stream takes as a response's `x-codex-turn-state` from one frame: each raw frame is parsed as
// `socket-handlers.mjs` parses it (`JSON.parse` of the message text) and handed to `_captureTurnStateFromEvent`
// (`openai-ws-stream/turn-state-headers.mjs`) with an entry that has no scope, so the token it takes is the entry's.
// Usage: node turn-state-capture.mjs <node-tree> --node-commit <sha> --out <file>
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tree = resolve(process.argv[2]);
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const { _captureTurnStateFromEvent } = await import(pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/providers/openai-ws-stream/turn-state-headers.mjs')).href);

const FRAMES = [
  '{"type":"response.created","headers":{"x-codex-turn-state":"ts-plain"}}',
  '{"type":"response.created","headers":{"x-codex-turn-\\u0073tate":"ts-escaped-name"}}',
  '{"type":"response.created","headers":{"X-Codex-Turn-State":"ts-letter-case"}}',
  '{"type":"response.created","headers":{"x-codex-turn-state":"ts-\\u00e9scaped-value"}}',
  '{"type":"response.created","response":{"headers":{"x-codex-turn-state":"ts-response"}}}',
  '{"type":"response.created","response":{"metadata":{"headers":{"x-codex-turn-state":"ts-response-metadata"}}}}',
  '{"type":"response.metadata","metadata":{"headers":{"x-codex-turn-state":"ts-event-metadata"}}}',
  '{"type":"response.created","headers":{"x-codex-turn-state":42}}',
  '{"type":"response.created","headers":{"x-codex-turn-state":["","ts-list"]}}',
  '{"type":"response.created","headers":{"x-codex-turn-state":""},"response":{"headers":{"x-codex-turn-state":"ts-second-carrier"}}}',
  '{"type":"response.output_text.delta","delta":"x-codex-turn-state"}',
  '{"type":"response.output_text.delta","delta":"line\\nbreak"}',
];

const cases = FRAMES.map((frame) => {
  const entry = { turnState: null, turnStateScope: null, turnStateTurnId: null };
  _captureTurnStateFromEvent(entry, JSON.parse(frame));
  return { frame, turnState: entry.turnState };
});
const self = fileURLToPath(import.meta.url);
const manifest = { exact: true, nodeCommit: arg('--node-commit'), node: process.version, harness: { 'turn-state-capture.mjs': crypto.createHash('sha256').update(readFileSync(self)).digest('hex') } };
writeFileSync(resolve(arg('--out')), `${JSON.stringify({ manifest, cases }, null, 1)}\n`);
console.log(cases.map((c) => `${c.turnState}  ${c.frame}`).join('\n'));
