import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandTransport } from './core-transport.ts';

const calls = [];
const transport = (answers) =>
  createCommandTransport(async (method, params) => {
    calls.push({ method, params });
    const answer = answers[method];
    return typeof answer === 'function' ? answer(params) : answer;
  });

test('a command is one dev/computer/run call with the bridge wait and answers its text', async () => {
  calls.length = 0;
  const run = transport({ 'dev/computer/run': { ok: true, text: '{"ok":true}', helperPid: 4242 } });
  const result = await run.runCommand({ action: 'list_windows' }, 'session-a');
  assert.deepEqual(result, { text: '{"ok":true}' });
  assert.deepEqual(calls[0], {
    method: 'dev/computer/run',
    params: { sessionThreadId: 'session-a', command: { action: 'list_windows' }, timeoutMs: 45_000 },
  });
  assert.equal(run.helperPid('session-a'), 4242);
});

test('the helper pid follows the last answer of the session and is gone when the answer names none', async () => {
  let pid = 7;
  const run = transport({ 'dev/computer/run': () => ({ ok: true, text: '', ...(pid ? { helperPid: pid } : {}) }) });
  await run.runCommand({ action: 'wait' }, 's');
  assert.equal(run.helperPid('s'), 7);
  pid = 0;
  await run.runCommand({ action: 'session_release' }, 's');
  assert.equal(run.helperPid('s'), undefined);
});

test('an image comes back as base64 read from the blob a page at a time', async () => {
  calls.length = 0;
  const bytes = Buffer.alloc(768 * 1024 + 5, 9);
  const run = transport({
    'dev/computer/run': { ok: true, text: 'shot', imageBlob: { digest: 'sha256:ab', byteLength: bytes.length, mimeType: 'image/jpeg' } },
    'blob/read': ({ offset, length }) => ({ bytesB64: bytes.subarray(offset, offset + length).toString('base64') }),
  });
  const result = await run.runCommand({ action: 'capture' }, 's');
  assert.equal(result.image.mimeType, 'image/jpeg');
  assert.equal(Buffer.from(result.image.data, 'base64').equals(bytes), true);
  assert.deepEqual(
    calls.filter((call) => call.method === 'blob/read').map((call) => [call.params.offset, call.params.length]),
    [
      [0, 768 * 1024],
      [768 * 1024, 5],
    ]
  );
});

test('a failed command throws code: message, once, whether or not the message carries the code', async () => {
  const run = transport({
    'dev/computer/run': ({ command }) => ({
      ok: false,
      error:
        command.action === 'click'
          ? { code: 'stale_frame', message: 'stale_frame: unknown frame_id' }
          : { code: 'denied', message: 'PC access is not approved' },
    }),
  });
  await assert.rejects(run.runCommand({ action: 'click' }, 's'), { message: 'stale_frame: unknown frame_id' });
  await assert.rejects(run.runCommand({ action: 'type' }, 's'), { message: 'denied: PC access is not approved' });
});

test('a core without the hook says how to start one', async () => {
  const run = createCommandTransport(async () => {
    throw Object.assign(new Error('x'), { detail: { data: { reason: 'methodNotFound' } } });
  });
  await assert.rejects(run.runCommand({ action: 'wait' }, 's'), /MIXDOGD_TEST_HOOKS=1/);
});
