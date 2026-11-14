import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { receiverKeyOf } from './precondition.ts';
import { registerUpload } from './upload.ts';

/** The key `ref-upload.ts` reads for the document of the file input below. */
const DOCUMENT_KEY = '\nF1\nL1\nhttps://a.example/';

function harness({ onResolveNode } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-upload-'));
  const file = join(dir, 'a.txt');
  writeFileSync(file, 'x');
  const handlers = new Map();
  const connection = { handleRequest: (method, handler) => handlers.set(method, handler) };
  const guest = { getURL: () => 'https://a.example/', isDestroyed: () => false };
  const state = {
    pageId: 'p1',
    documentGeneration: 1,
    cdpSessions: new Map(),
    pendingFileChooser: null,
    accessibilityRefs: { snapshotId: 's1' },
  };
  const ctx = {
    page: (pageId) => (pageId === 'p1' ? { guest, state } : undefined),
    session: () => undefined,
    cdp: {},
    events: { flush: () => {}, facts: (pageId) => ({ pageId, seq: 1 }) },
    redactKnown: (_pageId, text) => text,
    isEngineMode: () => true,
  };
  const sent = [];
  const counts = { clicks: 0, drops: 0 };
  const files = { input: true, count: 1 };
  const cdp = {
    releaseObject: () => {},
    call: async (_guest, method, params, _signal, options) => {
      switch (method) {
        case 'DOM.resolveNode':
          onResolveNode?.();
          return { object: { objectId: 'o1' } };
        case 'Runtime.callFunctionOn': {
          const declaration = String(params.functionDeclaration);
          if (declaration.includes('valid:')) return { result: { value: { valid: files.input } } };
          if (declaration.includes('location.href')) return { result: { value: { url: 'https://a.example/' } } };
          if (declaration.includes('ownerDocument || this; }')) return { result: { objectId: 'doc' } };
          return {
            result: { value: { tag: 'input', type: 'file', accept: 'image/*', multiple: false, files: files.count } },
          };
        }
        case 'DOM.describeNode':
          return { node: { frameId: 'F1' } };
        case 'Page.getFrameTree':
          return { frameTree: { frame: { id: 'F1', loaderId: 'L1' } } };
        case 'DOM.setFileInputFiles':
          options?.beforeDispatch?.();
          sent.push({ params, options });
          return {};
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  const host = {
    cdp,
    accessibilityRefs: () => ({ refs: new Map([['e1', { backendNodeId: 5 }]]) }),
    resolveRefPoint: async () => {
      onResolveNode?.();
      return { x: 1, y: 2 };
    },
    input: {
      clickAt: async () => {
        counts.clicks += 1;
      },
      dropFilesAt: async () => {
        counts.drops += 1;
      },
    },
    pause: async () => {},
    pendingFileChooser: () => state.pendingFileChooser,
    clearFileChooser: () => {
      state.pendingFileChooser = null;
    },
  };
  const invalidated = [];
  registerUpload(connection, ctx, { host, invalidateInteractionState: (g) => invalidated.push(g) });
  const call = (params) => handlers.get('host/browser/upload')(params, new AbortController().signal);
  const receiver = (params) => handlers.get('host/browser/upload/receiver')(params, new AbortController().signal);
  return { call, receiver, state, sent, counts, files, invalidated, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const expectOf = (extra = {}) => ({ documentId: 'p1:1', ...extra });

test('the receiver of a ref is the frame document key an approval binds, and the same key the upload then compares', async () => {
  const h = harness();
  try {
    const answer = await h.receiver({ pageId: 'p1', snapshotId: 's1', ref: 'e1', expect: expectOf() });
    assert.deepEqual({ key: answer.key, url: answer.url }, { key: DOCUMENT_KEY, url: 'https://a.example/' });
    const out = await h.call({
      pageId: 'p1', route: 'fileInput', snapshotId: 's1', ref: 'e1', files: [h.file], receiverKey: answer.key, expect: expectOf(),
    });
    assert.equal(out.dispatched, true);
    await assert.rejects(h.receiver({ pageId: 'p1', snapshotId: 'old', ref: 'e1' }), { code: -32013 });
    await assert.rejects(h.receiver({ pageId: 'p1', ref: 'e1' }), { code: -32602 });
  } finally {
    h.cleanup();
  }
});

test('a file input ref takes the files once the receiver and the page state both hold, and the page is asked what it holds', async () => {
  const h = harness();
  try {
    const out = await h.call({
      pageId: 'p1',
      route: 'fileInput',
      snapshotId: 's1',
      ref: 'e1',
      files: [h.file],
      receiverKey: DOCUMENT_KEY,
      expect: expectOf(),
    });
    assert.equal(out.dispatched, true);
    assert.equal(out.verified, true);
    assert.deepEqual(out.receiver, { tag: 'input', accept: 'image/*', multiple: false });
    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.sent[0].params, { files: [h.file], objectId: 'o1' });
    assert.equal(h.invalidated.length, 1);
    assert.deepEqual(out.facts, { pageId: 'p1', seq: 1 });
  } finally {
    h.cleanup();
  }
});

test('the files are not sent when the page moved after the first check, or the snapshot is no longer the one decided on', async () => {
  const moved = harness({ onResolveNode: () => (moved.state.documentGeneration = 2) });
  try {
    await assert.rejects(
      moved.call({ pageId: 'p1', route: 'fileInput', ref: 'e1', files: [moved.file], receiverKey: DOCUMENT_KEY, expect: expectOf() }),
      (error) => error.code === -32010 && error.data.reason === 'document'
    );
    assert.equal(moved.sent.length, 0);
  } finally {
    moved.cleanup();
  }
  const stale = harness();
  try {
    await assert.rejects(
      stale.call({
        pageId: 'p1',
        route: 'fileInput',
        snapshotId: 's0',
        ref: 'e1',
        files: [stale.file],
        receiverKey: DOCUMENT_KEY,
        expect: expectOf(),
      }),
      (error) => error.code === -32010 && error.data.reason === 'snapshot'
    );
    assert.equal(stale.sent.length, 0);
  } finally {
    stale.cleanup();
  }
});

test('a receiver other than the approved one gets nothing; an empty key binds nothing', async () => {
  const h = harness();
  try {
    await assert.rejects(
      h.call({ pageId: 'p1', route: 'fileInput', ref: 'e1', files: [h.file], receiverKey: '\nF9\nL9\nhttps://evil.example/', expect: expectOf() }),
      /upload target changed; nothing was dispatched/
    );
    assert.equal(h.sent.length, 0);
    const open = await h.call({ pageId: 'p1', route: 'fileInput', ref: 'e1', files: [h.file], receiverKey: '', expect: expectOf() });
    assert.equal(open.dispatched, true);
    assert.equal(h.sent.length, 1);
  } finally {
    h.cleanup();
  }
});

test('the open chooser is answered only while it is the one the approval named', async () => {
  const h = harness();
  try {
    const chooser = { mode: 'selectFiles', backendNodeId: 7, frameId: 'F1', openedAt: 1 };
    h.state.pendingFileChooser = chooser;
    const key = receiverKeyOf(chooser);
    await assert.rejects(
      h.call({ pageId: 'p1', route: 'chooser', files: [h.file], receiverKey: 'other|F1|7', expect: expectOf() }),
      (error) => error.code === -32010 && error.data.reason === 'receiver'
    );
    assert.equal(h.sent.length, 0);
    assert.equal(h.state.pendingFileChooser, chooser);
    const out = await h.call({
      pageId: 'p1',
      route: 'chooser',
      files: [h.file],
      receiverKey: key,
      expect: expectOf({ receiverKey: key }),
    });
    assert.equal(out.verified, true);
    assert.deepEqual(h.sent[0].params, { files: [h.file], backendNodeId: 7 });
    assert.equal(h.state.pendingFileChooser, null);
    // The chooser is gone: a second answer is refused by the page state.
    await assert.rejects(
      h.call({ pageId: 'p1', route: 'chooser', files: [h.file], receiverKey: key, expect: expectOf({ receiverKey: key }) }),
      (error) => error.code === -32010 && error.data.reason === 'receiver'
    );
    assert.equal(h.sent.length, 1);
  } finally {
    h.cleanup();
  }
});

test('the click that opens a picker is held to the same check', async () => {
  const h = harness({ onResolveNode: () => (h.state.documentGeneration = 2) });
  try {
    h.files.input = false;
    await assert.rejects(
      h.call({ pageId: 'p1', route: 'pickerClick', ref: 'e1', files: [h.file], receiverKey: DOCUMENT_KEY, expect: expectOf() }),
      (error) => error.code === -32010 && error.data.reason === 'document'
    );
    assert.equal(h.counts.clicks, 0);
    assert.equal(h.sent.length, 0);
  } finally {
    h.cleanup();
  }
});

test('a request that does not name its route, files, receiver or state is refused as invalid params', async () => {
  const h = harness();
  try {
    const base = { pageId: 'p1', route: 'fileInput', ref: 'e1', files: [h.file], receiverKey: DOCUMENT_KEY, expect: expectOf() };
    for (const bad of [
      { ...base, route: 'paste' },
      { ...base, files: [] },
      { ...base, files: [3] },
      { ...base, receiverKey: undefined },
      { ...base, expect: undefined },
      { ...base, ref: undefined },
      { ...base, route: 'chooser' },
    ]) {
      await assert.rejects(h.call(bad), (error) => error.code === -32602);
    }
    assert.equal(h.sent.length, 0);
  } finally {
    h.cleanup();
  }
});

test('a file input that holds fewer files than were sent is not verified', async () => {
  const h = harness();
  try {
    h.files.count = 0;
    const out = await h.call({
      pageId: 'p1',
      route: 'fileInput',
      ref: 'e1',
      files: [h.file],
      receiverKey: DOCUMENT_KEY,
      expect: expectOf(),
    });
    assert.equal(out.dispatched, true);
    assert.equal(out.verified, false);
  } finally {
    h.cleanup();
  }
});

test('the route the approval named has to be what the ref is: a file input is not picked by click or drop, and a button is not a file input', async () => {
  const h = harness();
  try {
    const base = { pageId: 'p1', ref: 'e1', files: [h.file], receiverKey: DOCUMENT_KEY, expect: expectOf() };
    for (const route of ['pickerClick', 'drop']) {
      await assert.rejects(h.call({ ...base, route }), (error) => error.code === -32010 && error.data.reason === 'receiver');
    }
    h.files.input = false;
    await assert.rejects(h.call({ ...base, route: 'fileInput' }), (error) => error.code === -32010 && error.data.reason === 'receiver');
    assert.equal(h.sent.length, 0);
    assert.equal(h.counts.clicks + h.counts.drops, 0);
  } finally {
    h.cleanup();
  }
});
