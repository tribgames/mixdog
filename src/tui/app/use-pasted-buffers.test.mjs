import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import React from 'react';
import { Text, render } from 'ink';
import { usePastedBuffers } from './use-pasted-buffers.mjs';
import { formatImageRef, formatPastedTextRef } from '../paste-attachments.mjs';

// The image and text buffer slices, mounted through the real hook: id minting,
// install/merge, and the snapshot clears a submit performs.
function Harness({ control }) {
  control.api = usePastedBuffers();
  return React.createElement(Text, null, 'ready');
}

function mount(context) {
  const control = {};
  const stdout = new PassThrough();
  stdout.columns = 40;
  stdout.rows = 10;
  stdout.on('data', () => {});
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const view = render(React.createElement(Harness, { control }), {
    stdout,
    stdin,
    stderr: stdout,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  context.after(() => {
    view.unmount();
    stdin.end();
    stdout.end();
  });
  return { control, settle: (ms = 20) => delay(ms) };
}

test('pasted images mint refs, install merges and advances the id, clears drop what a submit consumed', async (context) => {
  const { control, settle } = mount(context);
  await settle();
  const api = control.api;

  assert.equal(api.registerPastedImage({ type: 'text', content: 'x' }), '', 'only image payloads register');
  assert.equal(api.registerPastedImage({ type: 'image' }), '', 'an image without content registers nothing');
  assert.equal(api.registerPastedImage({ type: 'image', content: 'AA', filename: 'a.png' }), formatImageRef(1));
  assert.deepEqual(api.pastedImagesRef.current, { 1: { type: 'image', content: 'AA', filename: 'a.png', id: 1 } });

  api.installPastedImages(null);
  api.installPastedImages({});
  assert.deepEqual(Object.keys(api.pastedImagesRef.current), ['1'], 'empty installs are no-ops');

  const restored = { type: 'image', content: 'BB', id: 5 };
  api.installPastedImages({ 5: restored });
  assert.equal(api.nextPastedImageIdRef.current, 6, 'the next id clears the highest installed one');
  assert.equal(api.registerPastedImage({ type: 'image', content: 'CC' }), formatImageRef(6));

  api.clearPastedImagesSnapshot({ 5: restored, 1: { type: 'image', content: 'AA' } });
  assert.deepEqual(Object.keys(api.pastedImagesRef.current), ['1', '6'], 'only identical entries are dropped');

  api.installPastedImages({ 9: { type: 'image', content: 'DD' } }, { merge: false });
  assert.deepEqual(Object.keys(api.pastedImagesRef.current), ['9']);

  api.clearPastedImagesSnapshot();
  assert.deepEqual(api.pastedImagesRef.current, {});
  await settle();
});

test('pasted texts mint refs, install merges and advances the id, clears drop what a submit consumed', async (context) => {
  const { control, settle } = mount(context);
  await settle();
  const api = control.api;

  assert.equal(api.registerPastedText(''), '', 'an empty paste registers nothing');
  assert.equal(api.registerPastedText(null), '');
  assert.equal(api.registerPastedText('hello\nworld'), formatPastedTextRef(1, 'hello\nworld'));
  assert.deepEqual(api.pastedTextsRef.current, { 1: { id: 1, text: 'hello\nworld' } });

  api.installPastedTexts(null);
  api.installPastedTexts({});
  assert.deepEqual(Object.keys(api.pastedTextsRef.current), ['1'], 'empty installs are no-ops');

  const restored = { id: 4, text: 'restored' };
  api.installPastedTexts({ 4: restored });
  assert.equal(api.nextPastedTextIdRef.current, 5, 'the next id clears the highest installed one');
  assert.equal(api.registerPastedText('next'), formatPastedTextRef(5, 'next'));

  api.clearPastedTextsSnapshot({ 4: restored, 1: { id: 1, text: 'hello\nworld' } });
  assert.deepEqual(Object.keys(api.pastedTextsRef.current), ['1', '5'], 'only identical entries are dropped');

  api.installPastedTexts({ 8: { id: 8, text: 'only' } }, { merge: false });
  assert.deepEqual(Object.keys(api.pastedTextsRef.current), ['8']);

  api.clearPastedTextsSnapshot();
  assert.deepEqual(api.pastedTextsRef.current, {});
  await settle();
});
