import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { executeBuiltinTool } from '../src/runtime/agent/orchestrator/tools/builtin.mjs';
import {
  formatBinaryReadPreviewFromBuffer,
  inspectBinaryFile,
} from '../src/runtime/agent/orchestrator/tools/builtin/binary-file.mjs';

test('async binary inspection reuses its head bytes for a tail-null preview', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-tool-io-binary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'tail-null.bin');
  const body = Buffer.alloc(80 * 1024, 0x41);
  body[body.length - 2] = 0;
  await writeFile(file, body);

  const inspected = await inspectBinaryFile(file, body.length);
  assert.equal(inspected.isBinary, true);
  assert.equal(inspected.preview.length, 256);
  assert.equal(inspected.preview[0], 0x41);
  const rendered = formatBinaryReadPreviewFromBuffer(inspected.preview, file, body.length);
  assert.match(rendered.text, /41 41 41/);
});

test('32 concurrent reads preserve output while keeping the event loop responsive', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-tool-io-burst-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await Promise.all(Array.from({ length: 32 }, async (_, index) => {
    const path = join(root, `session-${index}.txt`);
    await writeFile(path, `session-${index}\n${'x'.repeat(64 * 1024)}\n`);
    return path;
  }));

  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let heartbeats = 0;
  const timer = setInterval(() => { heartbeats += 1; }, 5);
  try {
    const outputs = await Promise.all(paths.map((path, index) =>
      executeBuiltinTool('read', { path, offset: 0, limit: 1 }, root, {
        sessionId: `session-${index}`,
      })));
    for (let index = 0; index < outputs.length; index += 1) {
      assert.match(String(outputs[index]), new RegExp(`session-${index}`));
    }
  } finally {
    clearInterval(timer);
    delay.disable();
  }
  const p95Ms = delay.percentile(95) / 1e6;
  assert.ok(heartbeats > 0, 'read burst blocked every event-loop heartbeat');
  assert.ok(p95Ms < 200, `read burst event-loop p95 ${p95Ms.toFixed(1)}ms exceeded 200ms`);
});
