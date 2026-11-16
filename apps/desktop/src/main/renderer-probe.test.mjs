import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PROBE_MAX_CHANNELS,
  PROBE_MAX_PENDING_LINES,
  PROBE_MAX_SCRIPTS,
  PROBE_MESSAGE_MAX_CHARS,
  PROBE_REDACTED,
  createRendererProbeLog,
  probeLocation,
  rendererProbeLine,
} from './renderer-probe.ts';

const at = new Date('2026-01-01T00:00:00Z');
const script = (overrides = {}) => ({
  invoker: 'DIV#root.onclick',
  invokerType: 'event-listener',
  sourceURL: 'file:///C:/Users/someone/AppData/Local/Programs/Mixdog/resources/app.asar/out/renderer/assets/index-abc.js',
  sourceFunctionName: 'publishAgentPool',
  sourceCharPosition: 120,
  duration: 61.25,
  forcedStyleAndLayoutDuration: 0,
  ...overrides,
});
const frame = (overrides = {}) =>
  JSON.stringify({
    kind: 'frame',
    entryType: 'long-animation-frame',
    duration: 80,
    blockingDuration: 30,
    styleAndLayoutDuration: 5,
    scripts: [script()],
    ...overrides,
  });

test('a location keeps only a file name and position, or a code name; anything else is redacted', () => {
  assert.equal(probeLocation('file:///C:/Users/someone/project/out/index-abc.js'), 'index-abc.js');
  assert.equal(probeLocation('https://localhost:5173/src/renderer/App.tsx?t=123&token=secret#frag'), 'App.tsx');
  assert.equal(probeLocation('https://host/a/b/chunk.js:12:7'), 'chunk.js:12:7');
  assert.equal(probeLocation('index-abc.js:40:2'), 'index-abc.js:40:2');
  assert.equal(probeLocation('Window.requestAnimationFrame'), 'Window.requestAnimationFrame');
  assert.equal(probeLocation('please fix the login bug in my repo'), PROBE_REDACTED);
  assert.equal(probeLocation('C:\\Users\\someone\\secret.txt'), PROBE_REDACTED);
  assert.equal(probeLocation('/home/someone/notes.md'), PROBE_REDACTED);
  assert.equal(probeLocation('https://host/path/'), PROBE_REDACTED);
});

test('a frame line carries the reduced locations and refuses non-finite numbers', () => {
  const line = JSON.parse(rendererProbeLine(frame({ prompt: 'secret' }), at));
  assert.deepEqual(line.scripts, [
    {
      invoker: 'DIV#root.onclick',
      invokerType: 'event-listener',
      sourceURL: 'index-abc.js',
      sourceFunctionName: 'publishAgentPool',
      sourceCharPosition: 120,
      duration: 61.3,
      forcedStyleAndLayoutDuration: 0,
    },
  ]);
  assert.equal('prompt' in line, false);
  assert.equal(JSON.parse(rendererProbeLine(frame({ scripts: [script({ invokerType: 'typed text' })] }), at)).scripts[0].invokerType, PROBE_REDACTED);
  assert.equal(rendererProbeLine(frame({ duration: '80' }), at), null);
  assert.equal(rendererProbeLine(frame({ scripts: [script({ duration: null })] }), at), null);
  assert.equal(rendererProbeLine(frame({ blockingDuration: 1e400 }), at), null, 'Infinity from JSON overflow');
});

test('a message over the size limit is refused without being parsed', () => {
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = (...args) => {
    parsed += 1;
    return parse(...args);
  };
  try {
    assert.equal(rendererProbeLine('x'.repeat(PROBE_MESSAGE_MAX_CHARS + 1), at), null);
    assert.equal(rendererProbeLine({ kind: 'frame' }, at), null, 'only text is accepted');
    assert.equal(parsed, 0);
  } finally {
    JSON.parse = parse;
  }
});

test('at most N scripts and N channels of one message are read', () => {
  const scripts = Array.from({ length: PROBE_MAX_SCRIPTS + 30 }, () => ({
    invoker: 'a',
    invokerType: 'user-callback',
    sourceURL: 'b.js',
    sourceFunctionName: 'c',
    sourceCharPosition: 1,
    duration: 1,
    forcedStyleAndLayoutDuration: 0,
  }));
  assert.equal(JSON.parse(rendererProbeLine(frame({ scripts }), at)).scripts.length, PROBE_MAX_SCRIPTS);
  const ipc = Object.fromEntries(Array.from({ length: PROBE_MAX_CHANNELS + 50 }, (_, index) => [`c${index}`, index]));
  const summary = JSON.stringify({ kind: 'summary', windowMs: 10_000, frames: 600, longFrames: 2, blockedMs: 40, ipc });
  assert.equal(Object.keys(JSON.parse(rendererProbeLine(summary, at)).ipc).length, PROBE_MAX_CHANNELS);
});

test('a slow disk drops lines beyond the queue bound and the next summary counts them', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-renderer-probe-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const log = createRendererProbeLog(() => dataDir);
  void log.write(frame());
  assert.equal(readFileExists(dataDir), false, 'nothing is written while the flag is absent');
  writeFileSync(join(dataDir, 'renderer-profile.on'), '');
  assert.equal(await log.enabled(), true);
  // All queued before the first append can finish.
  let queued;
  for (let index = 0; index < PROBE_MAX_PENDING_LINES + 25; index += 1) queued = log.write(frame());
  assert.equal(log.dropped(), 25);
  await queued;
  await log.write(JSON.stringify({ kind: 'summary', windowMs: 1, frames: 1, longFrames: 0, blockedMs: 0, ipc: {} }));
  const lines = readFileSync(join(dataDir, 'renderer-perf.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, PROBE_MAX_PENDING_LINES + 1);
  assert.equal(lines.at(-1).droppedLines, 25);
  assert.equal(log.dropped(), 0);
});

function readFileExists(dataDir) {
  try {
    readFileSync(join(dataDir, 'renderer-perf.jsonl'));
    return true;
  } catch {
    return false;
  }
}
