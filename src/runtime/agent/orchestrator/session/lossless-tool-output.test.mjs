import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  compactOffloadedToolResultText,
  maybeOffloadToolResult,
  persistToolResultArtifactSync,
  _internals,
} from './tool-result-offload.mjs';
import { normalizeToolEnvelope } from './tool-envelope.mjs';
import { pruneToolOutputsUnanchored } from './compact/budget.mjs';
import { executeBuiltinTool } from '../tools/builtin.mjs';

test('offload commits exact bytes before replacing provider-visible output', async () => {
  const originalDataDir = process.env.MIXDOG_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-lossless-output-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  try {
    const raw = `head\n${'payload\n'.repeat(8_000)}tail\n`;
    const result = await maybeOffloadToolResult('session-lossless-output', 'call-lossless-output', 'shell', raw);
    const path = result.match(/→ (.+?) \(/)?.[1];
    const sha256 = createHash('sha256').update(raw).digest('hex');
    assert.ok(path);
    assert.equal(readFileSync(path, 'utf8'), raw);
    assert.match(result, new RegExp(`sha256 ${sha256}`));
    assert.match(result, /preview middle omitted/);
    assert.match(result, /(?:^|\n)head\n/);
    assert.match(result, /tail\n/);
    assert.doesNotMatch(result, /use read/i);
    assert.ok(result.length < 1_024);
  } finally {
    if (originalDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('identical bytes share one session content-addressed artifact', async () => {
  const originalDataDir = process.env.MIXDOG_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-content-addressed-output-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  try {
    const raw = `same\n${'content\n'.repeat(5_000)}`;
    const first = await maybeOffloadToolResult('session-content-addressed', 'call-content-addressed-1', 'shell', raw);
    const second = await maybeOffloadToolResult('session-content-addressed', 'call-content-addressed-2', 'shell', raw);
    const firstPath = first.match(/→ (.+?) \(/)?.[1];
    const secondPath = second.match(/→ (.+?) \(/)?.[1];
    const sha256 = createHash('sha256').update(raw).digest('hex');
    assert.equal(firstPath, secondPath);
    assert.match(firstPath, new RegExp(`${sha256}\\.txt$`));
    assert.deepEqual(readdirSync(join(dataDir, 'tool-results', 'session-content-addressed')), [`${sha256}.txt`]);
    assert.equal(readFileSync(firstPath, 'utf8'), raw);
  } finally {
    if (originalDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('compaction shortens only artifact-backed previews', () => {
  const raw = 'raw evidence '.repeat(1_000);
  const messages = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_raw', name: 'read', arguments: {} }] },
    { role: 'tool', toolCallId: 'call_raw', toolKind: 'normal', content: raw },
  ];
  const pruned = pruneToolOutputsUnanchored(messages, 1, { maxToolOutputChars: 256 });
  assert.equal(pruned[2].content, raw);

  const offloaded = `[tool output offloaded: shell → C:/safe/result.txt (50 KB, 500 lines, sha256 ${'a'.repeat(64)})]\n\n${raw}`;
  assert.equal(
    compactOffloadedToolResultText(offloaded),
    `${offloaded.split('\n')[0]}\n[preview omitted; full output preserved at the artifact path above]`
  );
  assert.doesNotMatch(compactOffloadedToolResultText(offloaded), /use read/i);
});

test('artifact failure preserves the complete inline result', async () => {
  const originalDataDir = process.env.MIXDOG_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-lossless-fail-open-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  try {
    writeFileSync(join(dataDir, 'tool-results'), 'not a directory');
    const raw = 'x'.repeat(40_000);
    assert.equal(await maybeOffloadToolResult('session-fail-open', 'call-fail-open', 'shell', raw), raw);
  } finally {
    if (originalDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('completed shell output is not middle-truncated at 400 lines', async () => {
  const result = normalizeToolEnvelope(
    await executeBuiltinTool(
      'shell',
      { command: `node -e "for (let i=0;i<450;i++) console.log('line-'+i)"`, timeout_ms: 10_000 },
      process.cwd(),
      { sessionId: 'session-shell-lines', toolCallId: 'call-shell-lines' }
    )
  );
  assert.doesNotMatch(result.result, /lines omitted|tool-output truncated/);
  assert.match(result.result, /(?:^|\n)line-0\n/);
  assert.match(result.result, /(?:^|\n)line-449(?:\n|$)/);
});

test('preview excerpts never split a Unicode surrogate pair', () => {
  const cases = [
    {
      text: `${'a'.repeat(306)}😀${'b'.repeat(700)}`,
      head: 'a'.repeat(306),
      tail: 'b'.repeat(205),
    },
    {
      text: `${'a'.repeat(700)}😀${'z'.repeat(204)}`,
      head: 'a'.repeat(307),
      tail: 'z'.repeat(204),
    },
  ];
  for (const { text, head, tail } of cases) {
    const { preview, truncated } = _internals.buildPreview(text);
    assert.equal(truncated, true);
    assert.equal(Buffer.from(preview, 'utf8').toString('utf8'), preview);
    assert.ok(preview.startsWith(`${head}\n\n`));
    assert.ok(preview.endsWith(`\n\n${tail}`));
    assert.ok(text.startsWith(head));
    assert.ok(text.endsWith(tail));
  }
});

test('mismatched stored objects preserve inline evidence in sync and async paths', async () => {
  const originalDataDir = process.env.MIXDOG_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-artifact-shape-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  try {
    const content = 'original evidence\n'.repeat(3_000);
    const sha256 = createHash('sha256').update(content).digest('hex');
    for (const [kind, stored] of [
      ['larger', `${content}extra`],
      ['shorter', content.slice(1)],
      ['same-size-corruption', content.replace('original', 'modified')],
      ['directory', null],
    ]) {
      const sessionId = `session-artifact-${kind}`;
      const dir = join(dataDir, 'tool-results', sessionId);
      const artifactPath = join(dir, `${sha256}.txt`);
      mkdirSync(dir, { recursive: true });
      if (stored === null) mkdirSync(artifactPath);
      else writeFileSync(artifactPath, stored);
      assert.equal(await maybeOffloadToolResult(sessionId, `async-${kind}`, 'shell', content), content, kind);
      assert.equal(persistToolResultArtifactSync({ sessionId, toolCallId: `sync-${kind}`, content }), null, kind);
      if (stored !== null) assert.equal(readFileSync(artifactPath, 'utf8'), stored);
    }
  } finally {
    if (originalDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
