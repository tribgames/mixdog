import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeComputerTool } from './client.mjs';

async function withBridge(respond, run) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-computer-stale-recapture-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = directory;
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      const command = JSON.parse(raw || '{}');
      requests.push(command);
      const payload = JSON.stringify(respond(command, requests.length));
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      response.end(payload);
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    await writeFile(
      join(directory, 'computer-bridge.json'),
      `${JSON.stringify({ version: 1, port: server.address().port, token: 'stale-recapture-token' })}\n`
    );
    await run(requests);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  }
}

const staleAct = {
  action: 'act',
  input: { window_id: 'hwnd:0x1', actions: [{ type: 'click', ref: 's1:e1' }] },
};

test('a stale-target refusal returns a fresh capture of the exact window with it', async () => {
  await withBridge(
    (command, index) =>
      index === 1
        ? { ok: false, error: 'stale_target: act targets hwnd:0x1, but the latest observation is hwnd:0x2' }
        : {
            ok: true,
            value: {
              text: JSON.stringify({ ok: true, action: 'capture', window_id: command.window_id, frame_id: 'frame:9' }),
              image: { mimeType: 'image/png', data: 'aGVsbG8=' },
            },
          },
    async (requests) => {
      const result = await executeComputerTool(staleAct);
      assert.equal(result.isError, true);
      assert.equal(requests.length, 2);
      assert.equal(requests[1].window_id, 'hwnd:0x1');
      assert.match(result.content[0].text, /stale_target/);
      assert.match(result.content[0].text, /no input was sent; window hwnd:0x1 was captured again below/);
      assert.equal(JSON.parse(result.content[1].text).frame_id, 'frame:9');
      assert.equal(result.content[2].type, 'image');
    }
  );
});

test('a failed recapture leaves the original refusal and its recovery unchanged', async () => {
  await withBridge(
    (_command, index) =>
      index === 1
        ? { ok: false, error: 'stale_target|background input window is stale' }
        : { ok: false, error: 'window_target_not_found: hwnd:0x1 is closed' },
    async (requests) => {
      const result = await executeComputerTool(staleAct);
      assert.equal(requests.length, 2);
      assert.equal(result.content.length, 1);
      assert.match(result.content[0].text, /Recovery: Capture window hwnd:0x1 again/);
    }
  );
});

test('other refusals and read-only actions never trigger a recapture', async () => {
  await withBridge(
    () => ({ ok: false, error: 'foreground_unavailable: could not focus target' }),
    async (requests) => {
      await executeComputerTool(staleAct);
      assert.equal(requests.length, 1);
    }
  );
  await withBridge(
    () => ({ ok: false, error: 'stale_frame: unknown frame_id frame:1' }),
    async (requests) => {
      await executeComputerTool({ action: 'capture', input: { window_id: 'hwnd:0x1' } });
      assert.equal(requests.length, 1);
    }
  );
});
