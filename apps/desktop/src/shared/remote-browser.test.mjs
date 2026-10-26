import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeRemoteBrowserControl,
  normalizeRemoteBrowserStreamOptions,
  remoteBrowserDriveViewport,
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
      assert.throws(() => normalizeRemoteBrowserControl({ ...command, documentId: bad }), /document id is invalid/);
    }
  }
  assert.throws(
    () => normalizeRemoteBrowserControl({ type: 'text', documentId, text: 'x'.repeat(2_001) }),
    /text is invalid/
  );
  assert.throws(
    () => normalizeRemoteBrowserControl({ type: 'key', documentId, key: 'k'.repeat(65) }),
    /key is invalid/
  );
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

test("a dialog answer is admitted for the shown document only, bounded like the pane's", () => {
  const documentId = 'p2:17';
  assert.deepEqual(
    normalizeRemoteBrowserControl({ type: 'answer-dialog', documentId, requestId: 'leave_3', accept: true, extra: 1 }),
    { type: 'answer-dialog', documentId, requestId: 'leave_3', accept: true, promptText: undefined }
  );
  assert.deepEqual(
    normalizeRemoteBrowserControl({
      type: 'answer-dialog',
      documentId,
      requestId: 'prompt_1',
      accept: true,
      promptText: 'name',
      keepDefault: true,
    }),
    { type: 'answer-dialog', documentId, requestId: 'prompt_1', accept: true, promptText: 'name', keepDefault: true }
  );
  for (const bad of [
    { documentId: undefined },
    { requestId: '' },
    { accept: 'yes' },
    { promptText: 'x'.repeat(2_001) },
  ]) {
    assert.throws(() =>
      normalizeRemoteBrowserControl({ type: 'answer-dialog', documentId, requestId: 'leave_3', accept: false, ...bad })
    );
  }
});

test('a viewport control carries only a bounded integer size and device scale', () => {
  assert.deepEqual(
    normalizeRemoteBrowserControl({ type: 'viewport', width: 390, height: 780, deviceScaleFactor: 2.625, extra: 1 }),
    { type: 'viewport', width: 390, height: 780, deviceScaleFactor: 2.625 }
  );
  for (const bad of [
    { width: 390.5, height: 780, deviceScaleFactor: 3 },
    { width: 199, height: 780, deviceScaleFactor: 3 },
    { width: 390, height: 3_841, deviceScaleFactor: 3 },
    { width: '390', height: 780, deviceScaleFactor: 3 },
    { height: 780, deviceScaleFactor: 3 },
  ]) {
    assert.throws(() => normalizeRemoteBrowserControl({ type: 'viewport', ...bad }), /viewport size is invalid/);
  }
  for (const deviceScaleFactor of [0.4, 4.1, Number.NaN, '3', undefined]) {
    assert.throws(
      () => normalizeRemoteBrowserControl({ type: 'viewport', width: 390, height: 780, deviceScaleFactor }),
      /viewport scale is invalid/
    );
  }
});

test('the phone asks for its content box, held inside the emulation bounds', () => {
  assert.deepEqual(remoteBrowserDriveViewport({ width: 390.4, height: 700.6 }, 3), {
    width: 390,
    height: 701,
    deviceScaleFactor: 3,
  });
  assert.deepEqual(remoteBrowserDriveViewport({ width: 120, height: 5_000 }, 9), {
    width: 200,
    height: 3_840,
    deviceScaleFactor: 4,
  });
  assert.equal(remoteBrowserDriveViewport({ width: 0, height: 700 }, 2), null);
  assert.equal(remoteBrowserDriveViewport(undefined, 2), null);
  assert.equal(remoteBrowserDriveViewport({ width: 400, height: 700 }, Number.NaN).deviceScaleFactor, 1);
  const viewport = remoteBrowserDriveViewport({ width: 412, height: 800 }, 2.625);
  assert.deepEqual(normalizeRemoteBrowserControl({ type: 'viewport', ...viewport }), { type: 'viewport', ...viewport });
});

test('tab controls: new-tab, select-tab and close-tab are accepted, bad tab ids refused', () => {
  assert.deepEqual(normalizeRemoteBrowserControl({ type: 'new-tab', extra: 1 }), { type: 'new-tab' });
  assert.deepEqual(normalizeRemoteBrowserControl({ type: 'select-tab', tabId: 'p3', x: 1 }), {
    type: 'select-tab',
    tabId: 'p3',
  });
  assert.deepEqual(normalizeRemoteBrowserControl({ type: 'close-tab', tabId: 'p12' }), {
    type: 'close-tab',
    tabId: 'p12',
  });
  // `follow` is the local pane's own marker; a paired client cannot send it.
  assert.deepEqual(normalizeRemoteBrowserControl({ type: 'select-tab', tabId: 'p3', follow: 'resume' }), {
    type: 'select-tab',
    tabId: 'p3',
  });
  assert.deepEqual(normalizeRemoteBrowserControl({ type: 'select-tab', tabId: 'p3', follow: 'agent' }), {
    type: 'select-tab',
    tabId: 'p3',
  });
  for (const type of ['select-tab', 'close-tab']) {
    for (const tabId of [undefined, 3, '', 'main-browser-a', 'p', 'p1x', 'x1', `p${'1'.repeat(80)}`]) {
      assert.throws(() => normalizeRemoteBrowserControl({ type, tabId }), TypeError, `${type} ${String(tabId)}`);
    }
  }
});

test('stream options are bounded and rounded', () => {
  assert.deepEqual(normalizeRemoteBrowserStreamOptions({ maxWidth: 800.4, maxHeight: 600 }), {
    maxWidth: 800,
    maxHeight: 600,
  });
  for (const bad of [
    null,
    {},
    { maxWidth: 10, maxHeight: 600 },
    { maxWidth: 800, maxHeight: 5_000 },
    { maxWidth: '800', maxHeight: 600 },
  ]) {
    assert.throws(() => normalizeRemoteBrowserStreamOptions(bad), /stream max/);
  }
  const fit = { width: 411, height: 782, deviceScaleFactor: 2.625 };
  assert.deepEqual(normalizeRemoteBrowserStreamOptions({ maxWidth: 1080, maxHeight: 2100, fit, extra: 1 }), {
    maxWidth: 1080,
    maxHeight: 2100,
    fit,
  });
  assert.deepEqual(normalizeRemoteBrowserStreamOptions({ maxWidth: 1080, maxHeight: 2100, fit: null }), {
    maxWidth: 1080,
    maxHeight: 2100,
    fit: null,
  });
  for (const bad of ['once', 1, { ...fit, width: 100 }, { ...fit, height: 411.5 }, { ...fit, deviceScaleFactor: 9 }]) {
    assert.throws(
      () => normalizeRemoteBrowserStreamOptions({ maxWidth: 1080, maxHeight: 2100, fit: bad }),
      /stream fit|viewport/
    );
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
