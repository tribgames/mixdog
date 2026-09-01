import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeComputerTool } from './client.mjs';

test('semantic computer failure is an error while preserving its fresh observation image', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-computer-semantic-error-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = directory;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const text = JSON.stringify({
        ok: false,
        action: 'sequence',
        completed_steps: 0,
        total_steps: 2,
        steps: [
          {
            index: 1,
            action: 'invoke',
            ok: false,
            status: 'failed',
            code: 'foreground_unavailable',
          },
          {
            index: 2,
            action: 'type',
            status: 'skipped',
            reason: 'foreground_unavailable',
          },
        ],
        code: 'foreground_unavailable',
        capture_after: {
          ok: true,
          action: 'capture',
          frame_id: 'frame:2',
        },
      });
      const payload = JSON.stringify({
        ok: true,
        value: {
          text,
          image: { mimeType: 'image/png', data: 'aGVsbG8=' },
        },
      });
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await writeFile(join(directory, 'computer-bridge.json'), `${JSON.stringify({
      version: 1,
      port: address.port,
      token: 'semantic-error-token',
    })}\n`);

    const result = await executeComputerTool({
      action: 'act',
      input: {
        window_id: 'hwnd:0x1',
        actions: [
          { type: 'click', ref: 'ref:1' },
          { type: 'type', text: 'value' },
        ],
      },
    });
    assert.equal(result.isError, true);
    assert.equal(result.content[1].type, 'image');
    const value = JSON.parse(result.content[0].text);
    assert.equal(value.action, 'act');
    assert.equal(value.completed_actions, 0);
    assert.deepEqual(value.actions.map((row) => row.status), ['failed', 'skipped']);
    assert.equal(value.observation.frame_id, 'frame:2');
    assert.equal(value.recovery.next, 'foreground_pointer');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  }
});
