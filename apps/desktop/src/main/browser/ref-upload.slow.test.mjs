import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRefUpload } from './ref-upload.ts';

const dir = mkdtempSync(join(tmpdir(), 'ref-upload-'));
const file = join(dir, 'a.txt');
writeFileSync(file, 'x');
test.after(() => rmSync(dir, { recursive: true, force: true }));

/** A page of same-process sibling frames `a` and `b` (same URL, one CDP session `S1`)
 *  and a cross-origin frame `x` in its own session `S2`. `owner[backendNodeId]` is the
 *  document an element lives in; `r1` is node 5. */
function fixture({ fileInput = true, chooser = null } = {}) {
  const docs = {
    a: { sessionId: 'S1', frameId: 'FA', loaderId: 'L1', url: 'https://a.example/frame' },
    b: { sessionId: 'S1', frameId: 'FB', loaderId: 'L2', url: 'https://a.example/frame' },
    x: { sessionId: 'S2', frameId: 'FX', loaderId: 'L3', url: 'https://x.example/' },
  };
  const owner = { 5: 'a', 7: 'a' };
  // The observation world of every frame (frame id → execution context).
  const contexts = { FA: 11, FB: 12, FX: 13 };
  const log = { set: [], clicks: 0, drops: 0, aimed: [], guards: [], received: [], cancelled: 0 };
  // What each frame's drop guard reports when it is taken back.
  const outcome = { FA: { accepted: true, strayed: false } };
  // The browser-side hit test at the drop point, per CDP session ('' = top).
  // By default the top document's iframe of `a` (session S1) is hit, and in it
  // node 6, a child of the ref r1 (node 5).
  const sessions = new Map([
    ['S1', { frameId: 'FA' }],
    ['S2', { frameId: 'FX' }],
  ]);
  const nodes = {
    90: { nodeName: 'IFRAME', frameId: 'FA' },
    91: { nodeName: 'IFRAME', frameId: 'FX' },
    5: { nodeName: 'DIV' },
    6: { nodeName: 'SPAN' },
    8: { nodeName: 'DIV' },
    30: { nodeName: 'DIV' },
  };
  const parents = { 6: 5 };
  const hits = { '': { backendNodeId: 90, frameId: 'TOP' }, S1: { backendNodeId: 6, frameId: 'FA' } };
  const hooks = { dragOver: () => {} };
  // Which frame Chromium hands the drop to: the frame of the topmost node.
  const landing = () => {
    let key = '';
    for (;;) {
      const hit = hits[key];
      const node = nodes[hit.backendNodeId];
      if (node.nodeName !== 'IFRAME') return hit.frameId;
      key = [...sessions].find(([, frame]) => frame.frameId === node.frameId)[0];
    }
  };
  let pending = null;
  const doc = (objectId) => docs[owner[Number(objectId.slice(1))]];
  const host = {
    accessibilityRefs: () => ({ refs: new Map([['r1', { backendNodeId: 5, sessionId: docs[owner[5]].sessionId }]]) }),
    frames: () => sessions,
    frameOffsetForSession: async () => ({ x: 0, y: 0 }),
    cdp: {
      guestDebugger: async () => ({ sendCommand: async () => undefined }),
      call: async (_guest, method, params, _signal, options = {}) => {
        if (method === 'DOM.getNodeForLocation') {
          const hit = hits[options.sessionId || ''];
          if (!hit) throw new Error('No node found at given location');
          return hit;
        }
        if (method === 'DOM.describeNode' && params.backendNodeId !== undefined) {
          return { node: { backendNodeId: params.backendNodeId, ...nodes[params.backendNodeId] } };
        }
        if (method === 'Runtime.callFunctionOn' && params.functionDeclaration.includes('parentNode')) {
          // Containment, read in the approved frame's observation world.
          const id = (objectId) => Number(objectId.slice(1).split('@')[0]);
          const ref = id(params.objectId);
          for (let node = id(params.arguments[0].objectId); node; node = parents[node]) {
            if (node === ref) return { result: { value: true } };
          }
          return { result: { value: false } };
        }
        if (method === 'DOM.resolveNode' && params.executionContextId !== undefined) {
          return { object: { objectId: `w${params.backendNodeId}@${params.executionContextId}` } };
        }
        if (method === 'DOM.resolveNode') return { object: { objectId: `n${params.backendNodeId}` } };
        if (method === 'Runtime.callFunctionOn' && params.functionDeclaration.includes('__mixdogDropGuard')) {
          log.aimed.push([params.objectId, options.sessionId]);
          return { result: { value: true } };
        }
        if (method === 'Runtime.callFunctionOn') {
          if (params.returnByValue === false) {
            const name = owner[Number(params.objectId.slice(1))];
            return { result: { objectId: `d:${name}` } };
          }
          if (params.functionDeclaration.includes('tagName')) return { result: { value: { valid: fileInput } } };
          return { result: { value: { url: doc(params.objectId).url } } };
        }
        if (method === 'DOM.describeNode') {
          // Electron 41 shape (captured): the #document carries no frameId; only
          // its root element, returned with depth >= 1, does.
          const d = docs[params.objectId.slice(2)];
          const node = { nodeName: '#document', nodeType: 9, backendNodeId: 2 };
          return { node: params.depth >= 1 ? { ...node, children: [{ nodeName: 'HTML', frameId: d.frameId }] } : node };
        }
        if (method === 'Page.getFrameTree') {
          const inSession = Object.values(docs).filter((d) => d.sessionId === options.sessionId);
          const [root, ...rest] = inSession;
          const node = (d) => ({ frame: { id: d.frameId, loaderId: d.loaderId, url: d.url } });
          return { frameTree: { ...node(root), childFrames: rest.map(node) } };
        }
        if (method === 'DOM.setFileInputFiles') log.set.push(params.files);
        return {};
      },
    },
    resolveRefPoint: async () => ({ x: 1, y: 1 }),
    input: {
      clickAt: async () => {
        log.clicks++;
        pending = chooser;
      },
      // As the driver does: the check runs before the payload is announced and
      // right before the drop; a late refusal cancels the drag.
      dropFilesAt: async (_guest, _point, _paths, _signal, check) => {
        await check?.();
        hooks.dragOver();
        try {
          await check?.();
        } catch (error) {
          log.cancelled++;
          throw error;
        }
        log.drops++;
        // Every listener of the frame Chromium hands the drop to — a page's
        // own window capture listener included — sees the files.
        log.received.push(landing());
      },
    },
    pause: async () => undefined,
    pendingFileChooser: () => pending,
    clearFileChooser: () => {
      pending = null;
    },
    evaluateInFrames: async () => [true],
    evaluateInFramesByFrame: async (_guest, expression) => {
      const frames = Object.entries(contexts);
      if (expression.includes('remove()')) {
        log.guards.push('take');
        return frames.map(([frameId, context]) => [
          frameId,
          outcome[frameId] ?? { accepted: false, strayed: false },
          context,
        ]);
      }
      log.guards.push('install');
      return frames.map(([frameId, context]) => [frameId, true, context]);
    },
  };
  return {
    docs,
    owner,
    contexts,
    outcome,
    log,
    hits,
    hooks,
    upload: createRefUpload(host),
    open: (next) => (pending = next),
  };
}
const chooserIn = (sessionId = 'S1') => ({ mode: 'selectMultiple', backendNodeId: 7, sessionId, openedAt: 0 });
const CHANGED = /upload target changed; nothing was dispatched/;

test('the receiver is the frame document: session, frame id, loader id and URL', async () => {
  const f = fixture();
  assert.deepEqual(await f.upload.receiver({}, 'r1'), {
    key: 'S1\nFA\nL1\nhttps://a.example/frame',
    url: 'https://a.example/frame',
  });
  f.open(chooserIn());
  assert.equal((await f.upload.receiver({}, undefined)).key, 'S1\nFA\nL1\nhttps://a.example/frame');
  await assert.rejects(fixture().upload.receiver({}, undefined), /requires ref/);
});

test('a cross-origin iframe input is identified by its own session, frame and origin', async () => {
  const f = fixture();
  f.owner[5] = 'x';
  assert.deepEqual(await f.upload.receiver({}, 'r1'), {
    key: 'S2\nFX\nL3\nhttps://x.example/',
    url: 'https://x.example/',
  });
});

test('a document with no frame id on any node cannot be identified: fail closed', async () => {
  const f = fixture();
  f.docs.a.frameId = undefined;
  await assert.rejects(f.upload.receiver({}, 'r1'), /could not be identified/);
});

test('a file input whose frame navigated or reloaded after approval gets no files', async () => {
  const f = fixture();
  const { key } = await f.upload.receiver({}, 'r1');
  await f.upload.uploadRef({}, 'r1', [file], undefined, undefined, key);
  assert.equal(f.log.set.length, 1, 'unchanged frame: the files move');
  f.docs.a.loaderId = 'L9'; // the same URL, loaded again
  await assert.rejects(f.upload.uploadRef({}, 'r1', [file], undefined, undefined, key), CHANGED);
  f.docs.a.loaderId = 'L1';
  f.docs.a.url = 'https://evil.example/';
  await assert.rejects(f.upload.uploadRef({}, 'r1', [file], undefined, undefined, key), CHANGED);
  assert.equal(f.log.set.length, 1, 'nothing was handed over');
  await f.upload.uploadRef({}, 'r1', [file]); // no approval bound (harness switch off): unchanged behaviour
  assert.equal(f.log.set.length, 2);
});

test('an open chooser is answered only in the approved document: not a same-URL sibling frame, not a reload', async () => {
  const f = fixture();
  f.open(chooserIn());
  const { key } = await f.upload.receiver({}, undefined);
  f.owner[7] = 'b'; // same process, same session, same URL, a different frame
  await assert.rejects(f.upload.uploadRef({}, undefined, [file], undefined, undefined, key), CHANGED);
  f.owner[7] = 'a';
  f.docs.a.loaderId = 'L7'; // same frame reloaded to the same URL
  await assert.rejects(f.upload.uploadRef({}, undefined, [file], undefined, undefined, key), CHANGED);
  assert.equal(f.log.set.length, 0);
  f.docs.a.loaderId = 'L1';
  await f.upload.uploadRef({}, undefined, [file], undefined, undefined, key);
  assert.equal(f.log.set.length, 1);
});

test('a button that opens a chooser: the button frame is checked before the click, the chooser document before the answer', async () => {
  const moved = fixture({ fileInput: false, chooser: chooserIn() });
  const { key } = await moved.upload.receiver({}, 'r1');
  moved.docs.a.loaderId = 'L9';
  await assert.rejects(moved.upload.uploadRef({}, 'r1', [file], undefined, undefined, key), CHANGED);
  assert.equal(moved.log.clicks, 0, 'not even clicked');
  const sibling = fixture({ fileInput: false, chooser: chooserIn() });
  sibling.owner[7] = 'b';
  await assert.rejects(
    sibling.upload.uploadRef({}, 'r1', [file], undefined, undefined, (await sibling.upload.receiver({}, 'r1')).key),
    CHANGED,
    'the chooser input sits in a sibling frame of the approved button'
  );
  const ok = fixture({ fileInput: false, chooser: chooserIn() });
  await ok.upload.uploadRef({}, 'r1', [file], undefined, undefined, (await ok.upload.receiver({}, 'r1')).key);
  assert.equal(ok.log.set.length, 1);
});

test(
  'a receiver-bound drop lands on the approved target in the approved frame; an unbound one drops as before',
  async () => {
    const bound = fixture({ fileInput: false });
    const key = (await bound.upload.receiver({}, 'r1')).key;
    await bound.upload.uploadRef({}, 'r1', [file], undefined, undefined, key);
    assert.equal(bound.log.drops, 1, 'a drag-and-drop-only zone takes approved files');
    // The guard is aimed at the ref itself, in its own frame's observation
    // world: only a drop on it gets through, every other frame refuses.
    assert.deepEqual(bound.log.aimed, [['w5@11', 'S1']]);
    assert.deepEqual(bound.log.guards, ['install', 'take']);
    const unbound = fixture({ fileInput: false });
    await unbound.upload.uploadRef({}, 'r1', [file]);
    assert.equal(unbound.log.drops, 1);
    assert.deepEqual(unbound.log.aimed, [], 'an unbound drop keeps the plain guard');
  },
  { timeout: 20_000 }
);

test(
  'a bound drop whose target frame changed, or cannot be told, is refused before anything is dropped',
  async () => {
    const moved = fixture({ fileInput: false });
    const key = (await moved.upload.receiver({}, 'r1')).key;
    moved.owner[5] = 'b'; // the ref now sits in a same-URL sibling frame
    await assert.rejects(moved.upload.uploadRef({}, 'r1', [file], undefined, undefined, key), CHANGED);
    assert.equal(moved.log.drops, 0);
    const unseen = fixture({ fileInput: false });
    const unseenKey = (await unseen.upload.receiver({}, 'r1')).key;
    delete unseen.contexts.FA; // the approved frame was never reached by the guard
    await assert.rejects(
      unseen.upload.uploadRef({}, 'r1', [file], undefined, undefined, unseenKey),
      /could not be identified/
    );
    assert.equal(unseen.log.drops, 0);
    assert.deepEqual(unseen.log.guards, ['install', 'take'], 'the installed guards are taken back');
  },
  { timeout: 20_000 }
);

test(
  'a cross-origin overlay frame covering the approved target is refused before any frame gets the drop',
  async () => {
    const f = fixture({ fileInput: false });
    const key = (await f.upload.receiver({}, 'r1')).key;
    f.hits[''] = { backendNodeId: 91, frameId: 'TOP' }; // x.example's iframe sits on top
    f.hits.S2 = { backendNodeId: 30, frameId: 'FX' };
    await assert.rejects(f.upload.uploadRef({}, 'r1', [file], undefined, undefined, key), CHANGED);
    assert.equal(f.log.drops, 0);
    assert.deepEqual(f.log.received, [], "the overlay's capture listener never sees the files");
  },
  { timeout: 20_000 }
);

test(
  "the approved frame's own listeners get the drop only when the topmost node is the approved target",
  async () => {
    const elsewhere = fixture({ fileInput: false });
    const key = (await elsewhere.upload.receiver({}, 'r1')).key;
    elsewhere.hits.S1 = { backendNodeId: 8, frameId: 'FA' }; // same frame, another element on top
    await assert.rejects(elsewhere.upload.uploadRef({}, 'r1', [file], undefined, undefined, key), CHANGED);
    assert.deepEqual(elsewhere.log.received, [], 'not even a window capture listener in the approved frame');
    const sibling = fixture({ fileInput: false });
    const siblingKey = (await sibling.upload.receiver({}, 'r1')).key;
    sibling.hits.S1 = { backendNodeId: 6, frameId: 'FB' }; // a same-process sibling frame's node
    await assert.rejects(sibling.upload.uploadRef({}, 'r1', [file], undefined, undefined, siblingKey), CHANGED);
    assert.deepEqual(sibling.log.received, []);
    const onTarget = fixture({ fileInput: false });
    await onTarget.upload.uploadRef(
      {},
      'r1',
      [file],
      undefined,
      undefined,
      (await onTarget.upload.receiver({}, 'r1')).key
    );
    assert.deepEqual(onTarget.log.received, ['FA'], 'a drop on the target (a child of it) reaches its frame');
  },
  { timeout: 20_000 }
);

test(
  'an overlay or reload the page brings in during the drag is caught right before the drop',
  async () => {
    const overlay = fixture({ fileInput: false });
    const key = (await overlay.upload.receiver({}, 'r1')).key;
    overlay.hooks.dragOver = () => {
      overlay.hits[''] = { backendNodeId: 91, frameId: 'TOP' };
      overlay.hits.S2 = { backendNodeId: 30, frameId: 'FX' };
    };
    await assert.rejects(overlay.upload.uploadRef({}, 'r1', [file], undefined, undefined, key), CHANGED);
    assert.deepEqual([overlay.log.drops, overlay.log.cancelled], [0, 1]);
    const reload = fixture({ fileInput: false });
    const reloadKey = (await reload.upload.receiver({}, 'r1')).key;
    reload.hooks.dragOver = () => {
      reload.docs.a.loaderId = 'L9';
    };
    await assert.rejects(reload.upload.uploadRef({}, 'r1', [file], undefined, undefined, reloadKey), CHANGED);
    assert.equal(reload.log.drops, 0);
    const nothing = fixture({ fileInput: false });
    const nothingKey = (await nothing.upload.receiver({}, 'r1')).key;
    delete nothing.hits[''];
    await assert.rejects(
      nothing.upload.uploadRef({}, 'r1', [file], undefined, undefined, nothingKey),
      CHANGED,
      'no node at the point: refused'
    );
    assert.equal(nothing.log.drops, 0);
  },
  { timeout: 20_000 }
);

test(
  'a bound drop that lands outside the approved target is reported as blocked, not as delivered',
  async () => {
    const strayed = fixture({ fileInput: false });
    const key = (await strayed.upload.receiver({}, 'r1')).key;
    strayed.outcome.FA = { accepted: false, strayed: false };
    strayed.outcome.FX = { accepted: false, strayed: true }; // an overlay frame took the point
    await assert.rejects(
      strayed.upload.uploadRef({}, 'r1', [file], undefined, undefined, key),
      /landed outside the approved upload target; it was blocked/
    );
    assert.equal(strayed.log.drops, 1);
  },
  { timeout: 20_000 }
);
