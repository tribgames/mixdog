// The daemon intake is the single send point for the desktop composer and for
// paired phones: whichever device sends, the message metadata records the
// attachments by content hash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-turns-'));
const { createSessionTurnCalls } = await import('./session-turns.mjs');

const b64 = (text) => Buffer.from(text).toString('base64');

function harness(session = null) {
  const submitted = [];
  const runtime = {
    provider: 'anthropic',
    session,
    submitAsync: async (prompt, options) => {
      submitted.push({ prompt, options });
      return true;
    },
  };
  const entry = { runtime };
  const calls = createSessionTurnCalls({
    log: () => {},
    readStoredGoal: () => null,
    listStoredActiveGoalSessionIds: () => [],
    hasAgentSession: () => false,
    sessionResult: (_entry, _step, _base, extra) => extra,
    advanceForCaller: () => ({}),
    retention: { retainUnwatched: () => {} },
    entries: { entryForSession: async () => entry },
  });
  return { calls, submitted, runtime };
}

const send = (calls, options = {}) =>
  calls.submitSession({
    sessionId: 's1',
    prompt: [
      { type: 'text', text: 'look [Pasted text #1 +3 lines]' },
      { type: 'image', data: b64('png bytes'), mimeType: 'image/png' },
      { type: 'file', data: b64('docx bytes'), mimeType: 'application/octet-stream', filename: 'plan.docx' },
    ],
    options: {
      pastedImages: {
        2: { id: 2, type: 'image', mediaType: 'image/png', filename: 'shot.png', content: b64('png bytes') },
      },
      pastedTexts: {
        1: { id: 1, text: 'pasted '.repeat(200), source: 'paste', filename: 'Pasted text #1', mimeType: 'text/plain' },
      },
      ...options,
    },
  });

test('a desktop send and a paired-device send both record their attachments in the message metadata', async () => {
  const { calls, submitted } = harness();
  await send(calls, { transcriptMeta: { messageId: 'msg_desktop', device: 'This PC' } });
  await send(calls, { transcriptMeta: { messageId: 'msg_phone', device: 'Pixel 8' } });
  assert.equal(submitted.length, 2);
  for (const { options } of submitted) {
    const names = options.transcriptMeta.attachments.map((entry) => entry.name).sort();
    assert.deepEqual(names, ['Pasted text #1', 'plan.docx', 'shot.png']);
    for (const entry of options.transcriptMeta.attachments) assert.equal(entry.id, entry.attachmentRef);
  }
  // The sender's own metadata survives next to them.
  assert.equal(submitted[1].options.transcriptMeta.device, 'Pixel 8');
  // Identical bytes from either device are the same ids (one blob).
  assert.deepEqual(
    submitted[0].options.transcriptMeta.attachments.map((entry) => entry.id),
    submitted[1].options.transcriptMeta.attachments.map((entry) => entry.id)
  );
});

test('a bot room runs only /compact and /clear: any other leading slash is message text', async () => {
  const { calls, submitted } = harness({ id: 'sess_home_gh', sessionMode: 'agent' });
  for (const prompt of ['/model gpt-5', '/new', '/Users/example/python-learn 봐줘', '/compact', ' /CLEAR now']) {
    await calls.submitSession({ sessionId: 'sess_home_gh', prompt, options: {} });
  }
  assert.deepEqual(
    submitted.map(({ options }) => options.skipSlashCommands === true),
    [true, true, true, false, false]
  );
});

test('a coding session leaves the slash decision to the queue', async () => {
  const { calls, submitted } = harness({ id: 's1', sessionMode: 'coding' });
  await calls.submitSession({ sessionId: 's1', prompt: '/model gpt-5', options: {} });
  assert.equal('skipSlashCommands' in submitted[0].options, false);
});

const OLE_XLS_PROMPT = [
  { type: 'text', text: 'read it' },
  {
    type: 'file',
    data: Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from('x')]).toString(
      'base64'
    ),
    mimeType: 'application/vnd.ms-excel',
    filename: 'sheet.xls',
  },
];

test('a send whose caller signal is already aborted is rejected before any conversion runs', async () => {
  const { calls, submitted } = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    calls.submitSession({ sessionId: 's1', prompt: OLE_XLS_PROMPT, options: {}, signal: controller.signal }),
    { name: 'AbortError' }
  );
  assert.equal(submitted.length, 0);
});

test('aborting a session cancels its attachment conversion in flight', async () => {
  const { calls, submitted, runtime } = harness();
  runtime.abort = async () => true;
  // The provider is read while the intake is registered: abort the session right there.
  const aborting = [];
  Object.defineProperty(runtime, 'provider', {
    get() {
      aborting.push(calls.abortSession({ sessionId: 's1' }));
      return 'anthropic';
    },
  });
  await assert.rejects(calls.submitSession({ sessionId: 's1', prompt: OLE_XLS_PROMPT, options: {} }), {
    name: 'AbortError',
  });
  await Promise.all(aborting);
  assert.equal(submitted.length, 0);
});

test('a prompt without attachments adds no attachment metadata', async () => {
  const { calls, submitted } = harness();
  await calls.submitSession({ sessionId: 's1', prompt: 'plain', options: { transcriptMeta: { messageId: 'm' } } });
  assert.equal('attachments' in submitted[0].options.transcriptMeta, false);
});

test('a cancel that lands after preparation, before the send, submits nothing', async () => {
  const { calls, submitted, runtime } = harness();
  runtime.abort = async () => true;
  const aborting = [];
  // A prompt with no legacy file never checks the signal itself: only the send gate can notice.
  Object.defineProperty(runtime, 'provider', {
    get() {
      aborting.push(calls.abortSession({ sessionId: 's1' }));
      return 'anthropic';
    },
  });
  await assert.rejects(calls.submitSession({ sessionId: 's1', prompt: 'plain text', options: {} }), {
    name: 'AbortError',
  });
  await Promise.all(aborting);
  assert.equal(submitted.length, 0);
});
