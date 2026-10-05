import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeRemoteBrowserControl,
  normalizeRemoteBrowserStreamOptions,
  remoteBrowserImagePoint,
} from './remote-browser.ts';

test('remote browser controls admit only bounded navigation and document-bound human input', () => {
  const documentId = 'p2:17';
  assert.deepEqual(normalizeRemoteBrowserControl({ type: 'reload', extra: 1 }), { type: 'reload' });
  assert.deepEqual(
    normalizeRemoteBrowserControl({
      type: 'pointer',
      documentId,
      phase: 'mousePressed',
      x: 120.5,
      y: 44,
      button: 'left',
      buttons: 1,
      modifiers: 0,
      clickCount: 1,
      ignored: 'not forwarded',
    }),
    {
      type: 'pointer',
      documentId,
      phase: 'mousePressed',
      x: 120.5,
      y: 44,
      button: 'left',
      buttons: 1,
      modifiers: 0,
      clickCount: 1,
    }
  );
  assert.deepEqual(normalizeRemoteBrowserControl({ type: 'wheel', documentId, x: 1, y: 2, deltaX: 0, deltaY: -40 }), {
    type: 'wheel',
    documentId,
    x: 1,
    y: 2,
    deltaX: 0,
    deltaY: -40,
  });
  assert.deepEqual(normalizeRemoteBrowserControl({ type: 'composition-end', documentId, text: '' }), {
    type: 'composition-end',
    documentId,
    text: '',
  });
  for (const command of [
    { type: 'text', text: 'hello' },
    { type: 'key', key: 'Backspace' },
    { type: 'composition', text: 'ab', selectionStart: 1, selectionEnd: 2 },
  ]) {
    assert.deepEqual(normalizeRemoteBrowserControl({ ...command, documentId }), { ...command, documentId });
    for (const bad of [undefined, '', 'p0:1', 'p2', 'p2:17\n', 17, null, `p2:${'1'.repeat(64)}`]) {
      assert.throws(
        () => normalizeRemoteBrowserControl({ ...command, documentId: bad }),
        /document id is invalid/
      );
    }
  }
  assert.throws(
    () => normalizeRemoteBrowserControl({ type: 'text', documentId, text: 'x'.repeat(2_001) }),
    /text is invalid/
  );
  assert.throws(() => normalizeRemoteBrowserControl({ type: 'key', documentId, key: 'k'.repeat(65) }), /key is invalid/);
  for (const bad of [
    { x: -1, y: 0 },
    { x: Number.NaN, y: 0 },
    { x: 0, y: 100_001 },
    { phase: 'mouseDragged' },
    { button: 'back' },
    { clickCount: 4 },
  ]) {
    assert.throws(() =>
      normalizeRemoteBrowserControl({
        type: 'pointer',
        documentId,
        phase: 'mouseMoved',
        x: 0,
        y: 0,
        button: 'none',
        buttons: 0,
        modifiers: 0,
        clickCount: 0,
        ...bad,
      })
    );
  }
  assert.throws(
    () => normalizeRemoteBrowserControl({ type: 'wheel', documentId, x: 0, y: 0, deltaX: 0, deltaY: 20_001 }),
    /deltaY is invalid/
  );
  assert.throws(
    () => normalizeRemoteBrowserControl({ type: 'evaluate', script: 'document.cookie' }),
    /unknown remote browser control/
  );
});

test('stream options are bounded and rounded', () => {
  assert.deepEqual(normalizeRemoteBrowserStreamOptions({ maxWidth: 800.4, maxHeight: 600 }), {
    maxWidth: 800,
    maxHeight: 600,
  });
  for (const bad of [null, {}, { maxWidth: 10, maxHeight: 600 }, { maxWidth: 800, maxHeight: 5_000 }, { maxWidth: '800', maxHeight: 600 }]) {
    assert.throws(() => normalizeRemoteBrowserStreamOptions(bad), /stream max/);
  }
});

test('remote browser taps map through contain sizing and ignore letterbox space', () => {
  assert.deepEqual(
    remoteBrowserImagePoint(
      { left: 0, top: 0, width: 400, height: 400 },
      { width: 800, height: 400 },
      { x: 200, y: 200 }
    ),
    { x: 400, y: 200 }
  );
  assert.equal(
    remoteBrowserImagePoint(
      { left: 0, top: 0, width: 400, height: 400 },
      { width: 800, height: 400 },
      { x: 200, y: 50 }
    ),
    null
  );
});
