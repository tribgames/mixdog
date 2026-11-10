import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { maybeOffloadToolResult, persistToolResultArtifactSync } from './tool-result-offload.mjs';

test('a forced offload renders only path, size, lines and the complete short preview', async () => {
  const originalDataDir = process.env.MIXDOG_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-offload-note-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  try {
    const raw = '[exit code: 1]\n\ncommand output\n';
    const sessionId = 'session-offload-note';
    const sha256 = createHash('sha256').update(raw).digest('hex');
    const artifactPath = join(dataDir, 'tool-results', sessionId, `${sha256}.txt`);
    const displayPath = artifactPath.replaceAll('\\', '/');
    assert.equal(await maybeOffloadToolResult(sessionId, 'inline-call', 'shell', raw), raw);
    const result = await maybeOffloadToolResult(sessionId, 'offload-call', 'shell', raw, { force: true });
    assert.equal(result, `[tool output offloaded: shell → ${displayPath} (1 KB, 4 lines)]\n\n${raw}`);
    assert.equal(readFileSync(artifactPath, 'utf8'), raw);
    assert.equal(await maybeOffloadToolResult(sessionId, 'replayed-call', 'shell', result), result);

    const artifact = persistToolResultArtifactSync({
      sessionId,
      toolCallId: 'sync-call',
      channel: 'stderr',
      content: raw,
    });
    assert.equal(artifact.sha256, sha256, 'the internal digest is preserved');
    assert.equal(artifact.path, artifactPath, 'sync and async offloads share the content-addressed artifact');
    assert.deepEqual(readdirSync(join(dataDir, 'tool-results', sessionId)), [`${sha256}.txt`]);
  } finally {
    if (originalDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a NUL or empty artifact is replaced whole; mismatched bytes and a directory there are never touched', async () => {
  const originalDataDir = process.env.MIXDOG_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-offload-damaged-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  try {
    const raw = 'artifact line\n'.repeat(20);
    const sessionId = 'session-offload-damaged';
    const input = (toolCallId) => ({ sessionId, toolCallId, channel: 'stdout', content: raw });
    const { path } = persistToolResultArtifactSync(input('first'));
    for (const damage of ['\0'.repeat(Buffer.byteLength(raw)), '']) {
      writeFileSync(path, damage);
      assert.equal(persistToolResultArtifactSync(input('again')).path, path);
      assert.equal(readFileSync(path, 'utf8'), raw);
    }
    // Bytes that are not the content and not data-free are evidence: preserved.
    writeFileSync(path, raw.slice(0, 40));
    assert.equal(persistToolResultArtifactSync(input('torn')), null);
    assert.equal(readFileSync(path, 'utf8'), raw.slice(0, 40));
    writeFileSync(path, '\0'.repeat(Buffer.byteLength(raw)));
    const offloaded = await maybeOffloadToolResult(sessionId, 'async', 'shell', raw, { force: true });
    assert.match(offloaded, /^\[tool output offloaded: shell/);
    assert.equal(readFileSync(path, 'utf8'), raw);
    // A directory (or link) at the path is not damage to heal: no artifact.
    rmSync(path);
    mkdirSync(path);
    assert.equal(persistToolResultArtifactSync(input('foreign')), null);
  } finally {
    if (originalDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('setup results offload at the setup output budget, not the 50k default', async () => {
  const { _internals } = await import('./tool-result-offload.mjs');
  const { SETUP_OUTPUT_MAX_BYTES } = await import('../../../shared/tool-output-limit.mjs');
  assert.equal(_internals.getOffloadThreshold('setup'), SETUP_OUTPUT_MAX_BYTES);
  assert.ok(SETUP_OUTPUT_MAX_BYTES < _internals.TOOL_RESULT_OFFLOAD_THRESHOLD_CHARS);
  const originalDataDir = process.env.MIXDOG_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-offload-setup-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  try {
    const inline = `{"a":"${'x'.repeat(SETUP_OUTPUT_MAX_BYTES - 20)}"}`;
    assert.equal(await maybeOffloadToolResult('session-setup', 'call-1', 'setup', inline), inline);
    const big = `{"a":"${'x'.repeat(SETUP_OUTPUT_MAX_BYTES + 100)}"}`;
    const offloaded = await maybeOffloadToolResult('session-setup', 'call-2', 'setup', big);
    assert.match(offloaded, /^\[tool output offloaded: setup/);
  } finally {
    if (originalDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('git offloads keep a large head+tail preview and name the full output path', async () => {
  const originalDataDir = process.env.MIXDOG_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-offload-git-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  try {
    const raw = `HEAD-MARK\n${'diff line\n'.repeat(8_000)}TAIL-MARK\n`;
    const git = await maybeOffloadToolResult('session-git', 'call-git', 'git', raw);
    const other = await maybeOffloadToolResult('session-git', 'call-glob', 'glob', raw);
    assert.match(git, /^\[tool output offloaded: git → /);
    assert.match(git, /HEAD-MARK/);
    assert.match(git, /TAIL-MARK/);
    assert.match(git, /\n\[output capped at 8000 chars; narrow: read it with offset\/limit; full output: [^\]]+\]$/);
    assert.ok(git.length > 8_000 && git.length < 8_800, String(git.length));
    assert.ok(other.length < 1_000, 'non-git tools keep the 512-char preview');
  } finally {
    if (originalDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('terminal results offload at the shell threshold', async () => {
  const { _internals } = await import('./tool-result-offload.mjs');
  assert.equal(_internals.getOffloadThreshold('terminal'), _internals.TOOL_RESULT_SHELL_THRESHOLD_CHARS);
});

test('shell and task results are never offloaded: the shell delivery already capped them', async () => {
  const { _internals, maybeOffloadToolResult, maybeOffloadToolResultBatch } = await import('./tool-result-offload.mjs');
  assert.equal(_internals.getOffloadThreshold('shell'), Infinity);
  assert.equal(_internals.getOffloadThreshold('task'), Infinity);
  const big = 'x'.repeat(_internals.TOOL_RESULT_MESSAGE_MAX_CHARS + 10);
  assert.equal(await maybeOffloadToolResult('sess-shell-inline', 'c1', 'shell', big), big);
  assert.equal(await maybeOffloadToolResult('sess-shell-inline', 'c2', 'task', big), big);
  const states = await maybeOffloadToolResultBatch('sess-shell-inline', [
    { toolCallId: 'c3', toolName: 'shell', result: big },
    { toolCallId: 'c4', toolName: 'task', result: big },
  ]);
  assert.ok(states.every((state) => state.result === big && !state.error));
});
