import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import React from 'react';
import { Text, render } from 'ink';
import { useSelectionPaint } from './use-selection-paint.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a failing selection-text capture never becomes an unhandled rejection', async (context) => {
  const stdout = new PassThrough();
  stdout.columns = 40;
  stdout.rows = 10;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  context.after(() => process.off('unhandledRejection', onUnhandled));

  let paint = null;
  const props = {
    store: {
      setRenderSelection() {},
      getRenderSelectionText() {
        throw new Error('renderer went away');
      },
    },
    statuslineBandRows: 3,
    dragRef: { current: { region: 'transcript', rect: null, active: false } },
    frameRowsRef: { current: 24 },
    transcriptViewportRef: { current: { top: 0, bottom: 10 } },
    selectionTextRef: { current: '' },
    harvestStitchRowsSoon() {},
    clearStitchBuffer() {},
  };
  function Probe() {
    paint = useSelectionPaint(props);
    return React.createElement(Text, null, 'probe');
  }
  const view = render(React.createElement(Probe), {
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
  await tick();

  paint.applySelectionRect({ mode: 'linear', x1: 0, y1: 1, x2: 5, y2: 1 });
  for (let i = 0; i < 4; i += 1) await tick();

  assert.deepEqual(unhandled, []);
});
