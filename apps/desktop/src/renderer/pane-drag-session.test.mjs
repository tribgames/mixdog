import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { installTestDom } from './test-support/test-dom.mjs';
import { paneInnerDropZone, paneOuterDropZone } from './pane-drop-zone.ts';
import { resolvePaneDropIntent } from './PaneWorkspace.tsx';

async function dragHarness(t) {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><html><body><div class="app-shell"><div id="source"></div><div id="target"></div></div></body></html>',
    jsdom: { url: 'about:blank' },
    expose: ['Element'],
    actEnvironment: false,
  });
  const drag = await import('./pane-drag-session.ts');
  const source = document.getElementById('source');
  const target = document.getElementById('target');
  const frames = [];
  const unsubscribe = drag.subscribePaneDrag((frame) => frames.push(frame));
  t.after(() => {
    drag.finishPaneDrag();
    unsubscribe();
    restore();
  });
  const data = new Map();
  const dataTransfer = {
    effectAllowed: 'none',
    dropEffect: 'none',
    setData(type, value) {
      data.set(type, value);
    },
    getData(type) {
      return data.get(type) ?? '';
    },
    setDragImage() {},
  };
  const dragEvent = (x, y, eventTarget = target) => ({
    clientX: x,
    clientY: y,
    dataTransfer,
    target: eventTarget,
    preventDefault() {},
  });
  const session = {
    kind: 'tab',
    key: 'session:one',
    title: 'One',
    selection: { kind: 'session', id: 'one', title: 'One' },
    sourceLeafId: 'leaf-a',
  };
  const phases = () => frames.map((frame) => frame.phase);
  return { ...drag, source, target, frames, phases, dragEvent, session };
}

test('pane drag: an unfinished drag cancels', async (t) => {
  const { beginPaneDrag, currentPaneDrag, movePaneDrag, finishPaneDrag, phases, dragEvent, session, source } =
    await dragHarness(t);
  beginPaneDrag(dragEvent(10, 10, source), session, source);
  assert.equal(currentPaneDrag(), session);
  movePaneDrag(dragEvent(20, 40));
  finishPaneDrag();
  assert.deepEqual(phases(), ['move', 'cancel']);
});

test('pane drag: a drop commits once at the drop point and runs the source cleanup', async (t) => {
  const {
    beginPaneDrag,
    currentPaneDrag,
    dropPaneDrag,
    movePaneDrag,
    finishPaneDrag,
    frames,
    phases,
    dragEvent,
    session,
    source,
  } = await dragHarness(t);
  let sourceCleanupCount = 0;
  beginPaneDrag(dragEvent(10, 10, source), session, source, () => {
    sourceCleanupCount += 1;
  });
  movePaneDrag(dragEvent(30, 50));
  dropPaneDrag(dragEvent(15, 25, source));
  finishPaneDrag();
  assert.deepEqual(phases(), ['move', 'drop']);
  assert.deepEqual({ x: frames[1].x, y: frames[1].y, target: frames[1].target }, { x: 15, y: 25, target: source });
  assert.equal(sourceCleanupCount, 1);
  assert.equal(currentPaneDrag(), null);
});

test('pane drag: a drop that reports the source takes the last move position and target', async (t) => {
  const {
    beginPaneDrag,
    currentPaneDrag,
    dropPaneDrag,
    movePaneDrag,
    finishPaneDrag,
    frames,
    phases,
    dragEvent,
    session,
    source,
    target,
  } = await dragHarness(t);
  beginPaneDrag(dragEvent(10, 10, source), session, source);
  movePaneDrag(dragEvent(30, 50));
  movePaneDrag(dragEvent(0, 0, source));
  assert.equal(frames.length, 1);
  dropPaneDrag(dragEvent(0, 0, source));
  finishPaneDrag();
  assert.deepEqual(phases(), ['move', 'drop']);
  assert.equal(frames[1].target, target);
  assert.deepEqual({ x: frames[1].x, y: frames[1].y }, { x: 30, y: 50 });
  assert.equal(currentPaneDrag(), null);
});

test('pane drag: cancelling the preview twice still accepts the drag and ends in cancel', async (t) => {
  const {
    acceptPaneDrag,
    beginPaneDrag,
    cancelPaneDragPreview,
    movePaneDrag,
    finishPaneDrag,
    phases,
    dragEvent,
    session,
    source,
  } = await dragHarness(t);
  beginPaneDrag(dragEvent(10, 10, source), session, source);
  movePaneDrag(dragEvent(30, 50));
  cancelPaneDragPreview();
  cancelPaneDragPreview();
  assert.equal(acceptPaneDrag(), true);
  finishPaneDrag();
  assert.deepEqual(phases(), ['move', 'cancel']);
});

test('pane drop zones follow the current pointer geometry', () => {
  const rect = {
    left: 0,
    right: 400,
    top: 100,
    bottom: 500,
    width: 400,
    height: 400,
  };
  assert.equal(paneInnerDropZone(rect, 200, 110), 'top');
  assert.equal(paneInnerDropZone(rect, 200, 300), 'center');
  assert.equal(paneInnerDropZone(rect, 200, 490), 'bottom');
  assert.equal(paneOuterDropZone(rect, 200, 105), 'top');
  assert.equal(paneOuterDropZone(rect, 200, 495), 'bottom');
});

test('a foreign tab strip wins over overlapping workspace edge zones', () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="panel">
      <div id="source-pane" class="pane-leaf" data-pane-id="leaf-a" data-pane-path="0">
        <div class="workspace-tabs-shell"></div>
        <div id="source-editor"></div>
      </div>
      <div id="target-pane" class="pane-leaf" data-pane-id="leaf-b" data-pane-path="1">
        <div id="target-strip" class="workspace-tabs-shell"></div>
      </div>
    </div>
  </body></html>`);
  const panel = dom.window.document.getElementById('panel');
  const sourcePane = dom.window.document.getElementById('source-pane');
  const sourceEditor = dom.window.document.getElementById('source-editor');
  const targetPane = dom.window.document.getElementById('target-pane');
  const targetStrip = dom.window.document.getElementById('target-strip');
  const rect = (left, top, width, height) => ({
    left,
    right: left + width,
    top,
    bottom: top + height,
    width,
    height,
  });
  panel.getBoundingClientRect = () => rect(0, 0, 800, 600);
  sourcePane.getBoundingClientRect = () => rect(0, 0, 400, 600);
  sourceEditor.getBoundingClientRect = () => rect(0, 32, 400, 568);
  targetPane.getBoundingClientRect = () => rect(400, 0, 400, 600);
  targetStrip.getBoundingClientRect = () => rect(400, 0, 400, 32);

  const source = { kind: 'session', id: 'one', title: 'One' };
  const sourceSibling = { kind: 'session', id: 'two', title: 'Two' };
  const target = { kind: 'session', id: 'three', title: 'Three' };
  const current = {
    leaves: [
      {
        type: 'leaf',
        id: 'leaf-a',
        tabs: [source, sourceSibling],
        activeKey: 'session:one',
      },
      {
        type: 'leaf',
        id: 'leaf-b',
        tabs: [target],
        activeKey: 'session:three',
      },
    ],
  };
  const frame = {
    phase: 'move',
    kind: 'tab',
    key: 'session:one',
    title: 'One',
    selection: source,
    sourceLeafId: 'leaf-a',
    x: 790,
    y: 16,
    target: targetStrip,
  };

  const stripIntent = resolvePaneDropIntent(frame, current, panel);
  assert.deepEqual(stripIntent?.action, {
    type: 'move-tab',
    sourceLeafId: 'leaf-a',
    key: 'session:one',
    targetLeafId: 'leaf-b',
    insertIndex: 0,
  });
  assert.equal(resolvePaneDropIntent({ ...frame, x: 200, y: 300, target: sourceEditor }, current, panel), null);
  dom.window.close();
});

test('a single pane can split vertically at 700px content height', () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="panel">
      <div class="workspace-tabs-shell"></div>
      <div id="editor"></div>
    </div>
  </body></html>`);
  const panel = dom.window.document.getElementById('panel');
  const editor = dom.window.document.getElementById('editor');
  panel.getBoundingClientRect = () => ({
    left: 0,
    right: 800,
    top: 0,
    bottom: 700,
    width: 800,
    height: 700,
  });
  const source = { kind: 'session', id: 'one', title: 'One' };
  const leaf = {
    type: 'leaf',
    id: 'leaf-a',
    tabs: [source, { kind: 'session', id: 'two', title: 'Two' }],
    activeKey: 'session:one',
  };

  const intent = resolvePaneDropIntent(
    {
      phase: 'move',
      kind: 'tab',
      key: 'session:one',
      title: 'One',
      selection: source,
      sourceLeafId: 'leaf-a',
      x: 400,
      y: 5,
      target: editor,
    },
    {
      layout: leaf,
      leaves: [leaf],
    },
    panel
  );

  assert.deepEqual(intent?.action, {
    type: 'move-tab-to-node-edge',
    sourceLeafId: 'leaf-a',
    key: 'session:one',
    targetPath: '',
    zone: 'top',
  });
  dom.window.close();
});
