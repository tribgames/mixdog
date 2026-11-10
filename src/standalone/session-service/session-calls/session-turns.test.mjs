// The daemon intake is the single send point for the desktop composer and for
// paired phones: whichever device sends, the message metadata records the
// attachments by content hash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDirSync } from '../../../../scripts/lib/scoped-temp.mjs';
import { makePdf } from '../../../runtime/agent/orchestrator/tools/builtin/pdf-test-fixtures.mjs';

process.env.MIXDOG_DATA_DIR = makeTempDirSync('turns');
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

test('a phone-sent photo and document reach the PC as named files whose paths the model is given', async () => {
  const { existsSync, readFileSync } = await import('node:fs');
  const { basename } = await import('node:path');
  const { calls, submitted } = harness();
  const jpeg = Buffer.from('\xff\xd8\xff\xe0 jpeg bytes', 'latin1');
  await calls.submitSession({
    sessionId: 's1',
    prompt: [
      { type: 'text', text: 'upload these [Pasted text #1 +3 lines]' },
      { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
      { type: 'file', data: makePdf(1).toString('base64'), mimeType: 'application/pdf', filename: 'lease.pdf' },
    ],
    options: {
      pastedImages: {
        2: {
          id: 2,
          type: 'image',
          mediaType: 'image/jpeg',
          filename: 'KakaoTalk_20261103_195007703.jpg',
          content: jpeg.toString('base64'),
        },
      },
      pastedTexts: {
        1: { id: 1, text: 'pasted '.repeat(200), source: 'paste', filename: 'Pasted text #1', mimeType: 'text/plain' },
      },
      transcriptMeta: { messageId: 'msg_phone', device: 'Pixel 8' },
    },
  });
  const prompt = submitted[0].prompt;
  const note = prompt.at(-1);
  assert.equal(note.type, 'text');
  const files = note.attachmentReference.files;
  assert.deepEqual(files.map((file) => basename(file.path)).sort(), ['KakaoTalk_20261103_195007703.jpg', 'lease.pdf']);
  for (const file of files) {
    assert.ok(note.text.includes(file.path), 'the model is told the path');
    assert.ok(existsSync(file.path));
  }
  const photo = files.find((file) => file.name.endsWith('.jpg'));
  assert.deepEqual(readFileSync(photo.path), jpeg);
  assert.equal(note.text.includes('Pasted text'), false, 'a paste is not a file');
});

// A send never waits for the staging lock: the claim is one synchronous
// try-lock, so a contended lock only costs the original (the resized copy
// stands) and cancellation and ordering behave as without staging.
async function stagedOriginalFixture() {
  const { stageOriginalAttachment } = await import('../../../runtime/attachments/staged-originals.mjs');
  const { holdStagedLock } = await import('../../../runtime/attachments/staged-lock-test-support.mjs');
  const { attachmentRef } = await stageOriginalAttachment(Buffer.from(`the picked original bytes ${Math.random()}`));
  const holder = await holdStagedLock(process.env.MIXDOG_DATA_DIR, 20000);
  const jpeg = Buffer.from('\xff\xd8\xff\xe0 resized', 'latin1').toString('base64');
  const prompt = (text) => [
    { type: 'text', text },
    { type: 'image', data: jpeg, mimeType: 'image/jpeg' },
  ];
  const options = {
    pastedImages: {
      1: { id: 1, type: 'image', mediaType: 'image/jpeg', filename: 'p.heic', originalRef: attachmentRef },
    },
  };
  return { holder, prompt, options };
}

test('with the staging lock held elsewhere, sends keep their order and carry the resized copy only', async () => {
  const { holder, prompt, options } = await stagedOriginalFixture();
  const { calls, submitted } = harness();
  try {
    const first = calls.submitSession({ sessionId: 's1', prompt: prompt('FIRST'), options });
    const second = calls.submitSession({ sessionId: 's1', prompt: prompt('SECOND'), options: {} });
    await Promise.all([first, second]);
    assert.deepEqual(
      submitted.map(({ prompt: sent }) => sent[0].text),
      ['FIRST', 'SECOND']
    );
    const [record] = submitted[0].options.transcriptMeta.attachments;
    assert.equal('original' in record, false);
  } finally {
    await holder.release();
  }
});

test('cancelling a send while the staging lock is held stops it', async () => {
  const { holder, prompt, options } = await stagedOriginalFixture();
  const { calls, submitted, runtime } = harness();
  runtime.abort = async () => true;
  const aborting = [];
  Object.defineProperty(runtime, 'provider', {
    get() {
      aborting.push(calls.abortSession({ sessionId: 's1' }));
      return 'anthropic';
    },
  });
  try {
    await assert.rejects(calls.submitSession({ sessionId: 's1', prompt: prompt('CANCELLED'), options }), {
      name: 'AbortError',
    });
    await Promise.all(aborting);
    assert.equal(submitted.length, 0);
  } finally {
    await holder.release();
  }
});

test('a lock left behind by a dead process does not block claims for good', async () => {
  const { stageOriginalAttachment, claimStagedOriginals } = await import(
    '../../../runtime/attachments/staged-originals.mjs'
  );
  const { holdStagedLock } = await import('../../../runtime/attachments/staged-lock-test-support.mjs');
  const { attachmentRef } = await stageOriginalAttachment(Buffer.from(`left behind ${Math.random()}`));
  const holder = await holdStagedLock(process.env.MIXDOG_DATA_DIR, 60000);
  await holder.release(); // killed while holding: its lock file stays
  assert.deepEqual([...claimStagedOriginals([attachmentRef])], [attachmentRef]);
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

test('a turn start (scheduled fire, routine or channel turn) waits out an update hold instead of starting or dropping', async () => {
  const { daemonWorkGate } = await import('../../daemon-work-gate.mjs');
  const { calls, submitted } = harness();
  assert.equal(daemonWorkGate.hold().held, true);
  try {
    const fired = calls.submitSession({ sessionId: 's1', prompt: 'scheduled', options: { kickoff: true } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(submitted.length, 0, 'nothing started during the hold');
    daemonWorkGate.release();
    await fired;
    assert.equal(submitted.length, 1, 'the deferred start ran once the hold ended');
  } finally {
    daemonWorkGate.release();
  }
});
