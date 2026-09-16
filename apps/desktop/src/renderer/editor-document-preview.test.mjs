// Desktop documents use external apps; restored tabs stay inert, while
// remote surfaces keep their page viewer and its conversion-failure escape.
import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
  url: 'https://mixdog.test/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.requestAnimationFrame = (callback) => {
  callback(0);
  return 1;
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { useEditorFileSession } = await import('./use-editor-file-session.ts');

async function mountSession(api, relPath) {
  window.mixdogDesktop = api;
  const session = { current: null };
  function Harness() {
    const editorRef = useRef(null);
    const syncLspRef = useRef(async () => false);
    session.current = useEditorFileSession({
      editorRef,
      projectPath: 'C:/Project/demo',
      relPath,
      active: true,
      editorSettings: {},
      notifyReady() {},
      onDirty() {},
      syncLspRef,
    });
    return null;
  }
  const host = document.createElement('div');
  document.querySelector('main').append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Harness)));
  return { root, session };
}

function surface(t, electron = false) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: electron ? 'Electron/41.0' : 'Mozilla/5.0' },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  });
}

const renderedPage = (page) => ({
  page,
  width: 1200,
  height: 1697,
  mime: 'image/png',
  base64: `page-${page}`,
});

test('a remote surface opens the document as pages and scrolls on', async (t) => {
  surface(t);
  const requested = [];
  const api = {
    previewDocumentPages: async (_projectPath, _relPath, _accessToken, options) => {
      requested.push([...options.pages]);
      return {
        format: 'docx',
        mtimeMs: 42,
        size: 4096,
        pageCount: 3,
        pages: options.pages.map(renderedPage),
      };
    },
  };
  const { root, session } = await mountSession(api, 'docs/report.docx');
  try {
    assert.deepEqual(requested, [[1]], 'opening costs exactly one page');
    assert.equal(session.current.documentPreview.pageCount, 3);
    assert.equal(session.current.preview, null, 'no PDF viewer is claimed here');
    assert.equal(session.current.load.binary, true, 'the text editor stays out of the way');

    // Pages arriving out of order still read top to bottom.
    await act(async () => session.current.loadDocumentPages([3, 2]));
    assert.deepEqual(
      session.current.documentPreview.pages.map((page) => page.page),
      [1, 2, 3]
    );
    assert.equal(session.current.documentError, '');
  } finally {
    await act(async () => root.unmount());
  }
});

test('restored desktop Office tabs offer a manual external open without conversion or auto-launch', async (t) => {
  surface(t, true);
  const unexpected = [];
  const api = {
    previewDocumentFile: async () => unexpected.push('pdf'),
    previewDocumentPages: async () => unexpected.push('pages'),
    openFilePath: async () => unexpected.push('launch'),
    readProjectFile: async () => ({
      content: '',
      mtimeMs: 11,
      binary: true,
      tooLarge: false,
      encoding: 'utf8',
    }),
    readEditorBackup: async () => null,
  };
  const { root, session } = await mountSession(api, 'docs/deck.pptx');
  try {
    assert.deepEqual(unexpected, []);
    assert.equal(session.current.preview, null);
    assert.equal(session.current.documentPreview, null);
    assert.equal(session.current.load.binary, true);
    assert.equal(session.current.documentError, '');
    assert.equal(session.current.error, '');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a remote document that cannot be converted keeps the binary notice', async (t) => {
  surface(t);
  const api = {
    previewDocumentPages: async () => {
      throw new Error('LibreOffice is not installed');
    },
    readProjectFile: async () => ({
      content: '',
      mtimeMs: 11,
      binary: true,
      tooLarge: false,
      encoding: 'utf8',
    }),
    readEditorBackup: async () => null,
  };
  const { root, session } = await mountSession(api, 'docs/budget.xlsx');
  try {
    assert.match(session.current.documentError, /LibreOffice/);
    assert.equal(session.current.preview, null);
    assert.equal(session.current.documentPreview, null);
    assert.equal(session.current.load.binary, true, 'the binary notice is what stays on screen');
    assert.equal(session.current.error, '', 'a missing viewer is not a load failure');
  } finally {
    await act(async () => root.unmount());
  }
});
