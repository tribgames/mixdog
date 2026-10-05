import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { makeTempEnvDir, writeBridgeDiscovery } from './bridge-env.test-support.mjs';
import { executeComputerTool } from './client.mjs';

test('a real bridge pause response during resumed capture returns to waiting and never repeats the mutation', async () => {
  const { directory, cleanup } = await makeTempEnvDir('MIXDOG_DATA_DIR', 'mixdog-pending-reentry-');
  const calls = [];
  let captures = 0;
  const pendingWork = { completed_steps: 1, uncertain_step: 2, pending_steps: [3] };
  const server = createServer((request, response) => {
    let source = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      source += chunk;
    });
    request.on('end', () => {
      const command = JSON.parse(source);
      calls.push(command.action);
      let result;
      if (command.action === 'sequence') {
        result = {
          status: 'paused',
          code: 'computer_user_intervention_pending',
          pending_work: pendingWork,
          completed_steps: 1,
          total_steps: 3,
          input_replayed: false,
        };
      } else if (command.action === 'wait_for_user') {
        result = { status: 'resumed', resumed: true };
      } else if (command.action === 'capture' && ++captures === 1) {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ ok: false, error: 'computer_user_control_active: user is operating the desktop' })
        );
        return;
      } else if (command.action === 'capture') {
        result = { ok: true, frame_id: 'fresh-after-second-resume' };
      } else {
        response.writeHead(500);
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, value: { text: JSON.stringify(result) } }));
    });
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    await writeBridgeDiscovery(directory, { port: server.address().port, token: 'fixture-token' });
    const result = await executeComputerTool({
      action: 'act',
      input: {
        window_id: 'hwnd:0x1',
        actions: [{ type: 'click', ref: 's1:e0' }],
      },
    });
    const body = JSON.parse(result.content[0].text);
    assert.deepEqual(calls, ['sequence', 'wait_for_user', 'capture', 'wait_for_user', 'capture']);
    assert.equal(body.status, 'resumed');
    assert.equal(body.observation.frame_id, 'fresh-after-second-resume');
    assert.deepEqual(body.pending_work, pendingWork);
    assert.equal(body.input_replayed, false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await cleanup();
  }
});
