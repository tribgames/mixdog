import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const CLIENT_URL = new URL('./session-runtime-agent-control-client.mjs', import.meta.url).href;

test('runtime shard Agent client sends serializable context and receives the routed result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-agent-control-client-'));
  const entry = join(dir, 'client.mjs');
  await writeFile(entry, `
process.env.MIXDOG_SESSION_RUNTIME_WORKER_PID = String(process.pid);
const client = await import(${JSON.stringify(CLIENT_URL)});
const value = await client.executeRemoteAgentControl(
  { type: 'spawn', tag: 'routed', agent: 'worker', prompt: 'run' },
  {
    callerCwd: 'C:/Project/test',
    invocationSource: 'model-tool',
    callerSessionId: 'sess_lead',
    clientHostPid: 4242,
  },
);
process.send({ type: 'report', value });
`, 'utf8');

  try {
    const observed = await new Promise((resolve, reject) => {
      const child = fork(entry, [], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env },
      });
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        reject(new Error('agent control client test timed out'));
      }, 10_000);
      child.on('message', (message) => {
        if (message?.type === 'agent-control') {
          assert.deepEqual(message.args, {
            type: 'spawn',
            tag: 'routed',
            agent: 'worker',
            prompt: 'run',
          });
          assert.deepEqual(message.context, {
            callerCwd: 'C:/Project/test',
            invocationSource: 'model-tool',
            callerSessionId: 'sess_lead',
            clientHostPid: 4242,
          });
          child.send({
            type: 'agent-control-result',
            controlId: message.controlId,
            ok: true,
            value: 'agent task: task_routed',
          });
          return;
        }
        if (message?.type !== 'report') return;
        clearTimeout(timer);
        try { child.kill(); } catch {}
        resolve(message.value);
      });
      child.on('error', reject);
    });
    assert.equal(observed, 'agent task: task_routed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
