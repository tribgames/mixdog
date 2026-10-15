import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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

test('setup results offload at the setup output budget, not the 50k default', async () => {
  const { _internals } = await import('./tool-result-offload.mjs');
  const { SETUP_OUTPUT_MAX_BYTES } = await import('../../../shared/tool-output-limit.mjs');
  assert.equal(_internals.getOffloadThreshold('setup'), SETUP_OUTPUT_MAX_BYTES);
  assert.ok(SETUP_OUTPUT_MAX_BYTES < _internals.TOOL_RESULT_OFFLOAD_THRESHOLD_CHARS);
  const originalDataDir = process.env.MIXDOG_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-offload-setup-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  try {
    const inline = '{"a":"' + 'x'.repeat(SETUP_OUTPUT_MAX_BYTES - 20) + '"}';
    assert.equal(await maybeOffloadToolResult('session-setup', 'call-1', 'setup', inline), inline);
    const big = '{"a":"' + 'x'.repeat(SETUP_OUTPUT_MAX_BYTES + 100) + '"}';
    const offloaded = await maybeOffloadToolResult('session-setup', 'call-2', 'setup', big);
    assert.match(offloaded, /^\[tool output offloaded: setup/);
  } finally {
    if (originalDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = originalDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('terminal results offload at the shell threshold', async () => {
  const { _internals } = await import('./tool-result-offload.mjs');
  assert.equal(_internals.getOffloadThreshold('terminal'), _internals.TOOL_RESULT_SHELL_THRESHOLD_CHARS);
  assert.equal(_internals.getOffloadThreshold('terminal'), _internals.getOffloadThreshold('shell'));
});
