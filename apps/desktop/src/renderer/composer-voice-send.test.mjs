import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { mountConversation } from './test-support/conversation-mount.mjs';

const WORDS = 'first words of the take';

/** A microphone whose recorder captures one chunk at start and hands it over when stopped. */
function installMicrophone(t, window) {
  const track = { muted: false, stop() {}, addEventListener() {}, removeEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => stream },
  });
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    mimeType = 'audio/webm;codecs=opus';
    state = 'inactive';
    start() {
      this.state = 'recording';
      this.ondataavailable({ data: new window.Blob(['speech']) });
      queueMicrotask(() => this.onstart());
    }
    stop() {
      this.state = 'inactive';
      this.onstop();
    }
  }
  for (const [key, value] of Object.entries({ MediaRecorder: Recorder, Blob: window.Blob, FileReader: window.FileReader })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => (previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]));
  }
}

/** A pane with voice transcription on; every commit records what the composer field holds, whether the transcript
 *  shows the sent message, whether the recording overlay is up, and how many attachment chips the composer holds. */
async function mountVoicePane(t) {
  const commits = [];
  const asked = { transcriptions: 0 };
  let pane;
  const record = () => {
    if (!pane) return;
    const { document, input } = pane;
    commits.push({
      field: input()?.value ?? '',
      row: (document.querySelector('.transcript')?.textContent ?? '').includes(WORDS),
      overlay: Boolean(document.querySelector('.composer-dictation-overlay')),
      chips: document.querySelectorAll('.composer-attachments > *').length,
    });
  };
  pane = await mountConversation(t, {
    rows: true,
    onCommit: record,
    capability: (request) => {
      if (request.capability === 'getVoiceStatus') return { installed: true, enabled: true };
      if (request.capability === 'transcribeAudio') {
        asked.transcriptions += 1;
        return WORDS;
      }
      return undefined;
    },
  });
  installMicrophone(t, pane.window);
  const settle = async (done) => {
    for (let round = 0; round < 50 && !done(); round += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      await pane.frame();
    }
  };
  /** Records, then presses the send disc that finishes the take and sends it. */
  const speakAndSend = async () => {
    await pane.click(pane.document.querySelector('button.composer-mic'));
    await settle(() => pane.document.querySelector('button.composer-mic.is-recording'));
    assert.ok(pane.document.querySelector('button.composer-mic.is-recording'), 'the take records');
    commits.length = 0;
    await pane.click(pane.document.querySelector('button.send-button'));
    await settle(() => !pane.document.querySelector('.composer-dictation-overlay'));
    for (let frames = 0; frames < 5; frames += 1) await pane.frame();
  };
  return { ...pane, commits, asked, settle, speakAndSend };
}

test('a voice send never shows its words in the field: the draft clears with the user row and the overlay’s end', async (t) => {
  const pane = await mountVoicePane(t);
  const { show, frame, type, input, document, submits, commits, speakAndSend } = pane;
  await show({ shown: 'sess_v1', selected: 'sess_v1' });
  for (let frames = 0; frames < 5; frames += 1) await frame();
  await type('Please');
  await speakAndSend();
  assert.deepEqual(
    submits.map((entry) => [entry.to, entry.text]),
    [['sess_v1', `Please ${WORDS}`]],
    'the words go out joined to the draft'
  );
  assert.ok(commits.length > 0, 'the send committed');
  assert.deepEqual(
    commits.filter((commit) => commit.field.includes(WORDS) && !commit.row),
    [],
    'no commit shows the words in the field without their row'
  );
  const ended = commits.find((commit) => !commit.overlay);
  assert.deepEqual(
    ended,
    { field: '', row: true, overlay: false, chips: 0 },
    'the overlay ends in the commit that sends'
  );
  assert.equal(input().value, '');
  assert.ok(document.querySelector('.transcript').textContent.includes(`Please ${WORDS}`));
});

/** In `session`, `Please` and a pasted-text chip, then a take sent by voice whose send waits on the chip's digest (still
 *  being worked out when the words come back), with the overlay up. */
async function sendWaitingOnChipDigest(t, pane, session) {
  const { window, show, frame, type, input, document, submits, commits, asked, settle, click } = pane;
  const subtle = globalThis.crypto.subtle;
  const digest = subtle.digest.bind(subtle);
  let releaseDigest;
  const digested = new Promise((resolve) => (releaseDigest = resolve));
  Object.defineProperty(subtle, 'digest', {
    configurable: true,
    value: (...args) => digested.then(() => digest(...args)),
  });
  t.after(() => delete subtle.digest);
  await show({ shown: session, selected: session });
  for (let frames = 0; frames < 5; frames += 1) await frame();
  await type('Please');
  const pasted = 'row of a spreadsheet\n'.repeat(60);
  await act(async () => {
    const event = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
        files: [],
        types: ['text/plain'],
        getData: (type) => (type === 'text/plain' ? pasted : ''),
      },
    });
    input().dispatchEvent(event);
  });
  assert.equal(document.querySelectorAll('.composer-attachments > *').length, 1, 'the paste is a chip');
  const overlay = () => document.querySelector('.composer-dictation-overlay');
  await click(document.querySelector('button.composer-mic'));
  await settle(() => document.querySelector('button.composer-mic.is-recording'));
  commits.length = 0;
  await click(document.querySelector('button.send-button'));
  await settle(() => asked.transcriptions > 0);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.deepEqual(submits, [], 'the send waits on the digest');
  assert.equal(input().value, 'Please', 'with the words out of the field');
  assert.ok(overlay(), 'and the overlay up');
  return { releaseDigest, overlay };
}

test('a voice send with an attachment keeps the overlay up until the send clears the draft and chip with its row', async (t) => {
  const pane = await mountVoicePane(t);
  const { frame, submits, commits, settle } = pane;
  const { releaseDigest, overlay } = await sendWaitingOnChipDigest(t, pane, 'sess_v4');
  await act(async () => releaseDigest());
  await settle(() => !overlay());
  for (let frames = 0; frames < 5; frames += 1) await frame();
  assert.equal(submits.length, 1);
  assert.ok(submits[0].text.includes(`Please ${WORDS}`), 'the words go out joined to the draft');
  assert.deepEqual(
    commits.filter((commit) => commit.field.includes(WORDS) && !commit.row),
    [],
    'no commit shows the words in the field without their row'
  );
  assert.deepEqual(
    commits.find((commit) => !commit.overlay),
    { field: '', row: true, overlay: false, chips: 0 },
    'the overlay ends in the commit that sends'
  );
});

test('× on the overlay while a voice send waits cancels it: nothing goes out and the words land in the draft', async (t) => {
  const pane = await mountVoicePane(t);
  const { frame, input, document, submits, click, settle } = pane;
  const { releaseDigest, overlay } = await sendWaitingOnChipDigest(t, pane, 'sess_v7');
  await click(overlay().querySelector('button'));
  await act(async () => releaseDigest());
  await settle(() => input().value !== 'Please');
  for (let frames = 0; frames < 5; frames += 1) await frame();
  assert.deepEqual(submits, [], 'nothing is sent');
  assert.equal(input().value, `Please ${WORDS}`, 'the words land in the draft');
  assert.equal(document.querySelectorAll('.composer-attachments > *').length, 1, 'with the chip');
  assert.equal(overlay(), null);
});

test('a voice send blocked for want of a model leaves its words in the draft', async (t) => {
  const pane = await mountVoicePane(t);
  const { window, show, frame, type, input, document, submits, speakAndSend } = pane;
  const pickers = [];
  const claim = (event) => {
    pickers.push(event.type);
    event.preventDefault();
  };
  const customEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
  Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, writable: true, value: window.CustomEvent });
  window.addEventListener('mixdog:open-model-picker', claim);
  t.after(() => {
    window.removeEventListener('mixdog:open-model-picker', claim);
    Object.defineProperty(globalThis, 'CustomEvent', customEvent);
  });
  await show({ shown: 'sess_v5', selected: 'sess_v5', lane: { provider: '', model: '' } });
  for (let frames = 0; frames < 5; frames += 1) await frame();
  await type('Please');
  await speakAndSend();
  assert.deepEqual(submits, [], 'nothing goes out');
  assert.equal(pickers.length, 1, 'the model picker is asked for');
  assert.equal(input().value, `Please ${WORDS}`, 'nothing is lost');
  assert.equal(document.querySelector('.composer-dictation-overlay'), null);
});

test('a refused voice send leaves its words in the draft', async (t) => {
  const pane = await mountVoicePane(t);
  const { show, frame, type, input, host, submits, speakAndSend } = pane;
  await show({ shown: 'sess_v2', selected: 'sess_v2' });
  for (let frames = 0; frames < 5; frames += 1) await frame();
  host.submit = async () => false;
  await type('Please');
  await speakAndSend();
  assert.deepEqual(
    submits.map((entry) => entry.text),
    [`Please ${WORDS}`]
  );
  assert.equal(input().value, `Please ${WORDS}`, 'nothing is lost');
});

test('a voice send before the picked lane lands keeps its words in the draft and goes out on landing', async (t) => {
  const pane = await mountVoicePane(t);
  const { show, frame, input, submits, speakAndSend } = pane;
  await show({ shown: 'sess_v3', selected: 'sess_v3' });
  for (let frames = 0; frames < 5; frames += 1) await frame();
  await show({ shown: 'sess_v3', selected: 'sess_w3' });
  await speakAndSend();
  assert.deepEqual(submits, [], 'it waits for the lane');
  assert.equal(input().value, WORDS, 'with its words in the draft meanwhile');
  await show({ shown: 'sess_w3', selected: 'sess_w3' });
  await act(async () => {});
  assert.deepEqual(
    submits.map((entry) => [entry.to, entry.text]),
    [['sess_w3', WORDS]]
  );
  assert.equal(input().value, '');
});

/** Holds every transcription until `held.release()` answers the latest one with `text`. */
function holdTranscription(pane, text = WORDS) {
  const transcribe = pane.window.mixdogDesktop.invokeCapability;
  const held = { release: null, capabilities: [] };
  pane.window.mixdogDesktop.invokeCapability = (request) => {
    held.capabilities.push(request.capability);
    return request.capability === 'transcribeAudio'
      ? new Promise((resolve) => (held.release = () => resolve({ value: text })))
      : transcribe(request);
  };
  return held;
}

const pause = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

test('a take left recording by a session switch transcribes for its own session while the picked one dictates freely', async (t) => {
  const pane = await mountVoicePane(t);
  const { window, document, show, frame, input, click, settle, submits } = pane;
  await show({ shown: 'sess_d6', selected: 'sess_d6' });
  for (let frames = 0; frames < 5; frames += 1) await frame();
  const held = holdTranscription(pane);
  const mic = () => document.querySelector('button.composer-mic');
  await click(mic());
  await settle(() => mic().classList.contains('is-recording'));
  assert.ok(mic().classList.contains('is-recording'), 'the take records in the outgoing session');

  await show({ shown: 'sess_d6', selected: 'sess_e6' });
  await settle(() => held.release);
  assert.ok(held.release, 'the outgoing take is being transcribed');
  assert.equal(document.querySelector('.composer-dictation-overlay'), null, 'no overlay in the picked composer');
  assert.ok(!mic().classList.contains('is-recording'));

  await click(mic());
  await settle(() => mic().classList.contains('is-recording'));
  assert.ok(mic().classList.contains('is-recording'), 'the picked session dictates while the other transcribes');
  const picked = held.release;
  await act(async () => picked());
  await pause();
  assert.ok(mic().classList.contains('is-recording'), 'the outgoing words leave the picked take alone');
  assert.equal(input().value, '', 'and never reach the picked draft');
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  assert.equal(document.querySelector('.composer-dictation-overlay'), null);

  await show({ shown: 'sess_d6', selected: 'sess_d6' });
  assert.equal(input().value, WORDS, 'the words wait in the draft of the session they were spoken in');
  assert.deepEqual(submits, [], 'nothing is sent');
});

test('a take switched away from and back to while its send waits on a digest sends nothing; its words land in the draft', async (t) => {
  const pane = await mountVoicePane(t);
  const { show, input, document, submits } = pane;
  const { releaseDigest, overlay } = await sendWaitingOnChipDigest(t, pane, 'sess_v8');
  await show({ shown: 'sess_v8', selected: 'sess_x8' });
  await show({ shown: 'sess_v8', selected: 'sess_v8' });
  await act(async () => releaseDigest());
  await pause();
  assert.deepEqual(submits, [], 'nothing is sent');
  assert.equal(input().value, `Please ${WORDS}`, 'the words land in the draft');
  assert.equal(document.querySelectorAll('.composer-attachments > *').length, 1, 'with the chip');
  assert.equal(overlay(), null);
});

test('a pane closed while a voice send waits on a digest sends nothing; the words wait in its stored draft', async (t) => {
  const pane = await mountVoicePane(t);
  const { show, close, input, document, submits } = pane;
  const { releaseDigest } = await sendWaitingOnChipDigest(t, pane, 'sess_v9');
  await close();
  await act(async () => releaseDigest());
  await pause();
  assert.deepEqual(submits, [], 'nothing is sent');
  await show({ shown: 'sess_v9', selected: 'sess_v9' });
  assert.equal(input().value, `Please ${WORDS}`, 'the words wait in the draft');
  assert.equal(document.querySelectorAll('.composer-attachments > *').length, 1, 'with the chip');
});

for (const [index, spoken] of [WORDS, '/compact'].entries()) {
  test(`a pane closed while a voice send transcribes runs nothing; ${spoken} waits in its stored draft`, async (t) => {
    const pane = await mountVoicePane(t);
    const { show, close, frame, input, click, document, settle, submits } = pane;
    const session = `sess_c${index}`;
    await show({ shown: session, selected: session });
    for (let frames = 0; frames < 5; frames += 1) await frame();
    const held = holdTranscription(pane, spoken);
    await click(document.querySelector('button.composer-mic'));
    await settle(() => document.querySelector('button.composer-mic.is-recording'));
    await click(document.querySelector('button.send-button'));
    await settle(() => held.release);
    assert.ok(held.release, 'the take is being transcribed');
    await close();
    await act(async () => held.release());
    await pause();
    assert.deepEqual(submits, [], 'nothing is sent');
    assert.ok(!held.capabilities.includes('compact'), 'no command runs');
    await show({ shown: session, selected: session });
    assert.equal(input().value, spoken, 'the words wait in the draft');
  });
}
