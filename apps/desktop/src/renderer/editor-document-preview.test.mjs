// Desktop documents use external apps; restored tabs stay inert, while
// remote surfaces keep their page viewer and its conversion-failure escape.
import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  actEnvironment: false,
});
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

test('desktop Office tabs render pages in-app without launching an OS app', async (t) => {
  surface(t, true);
  const requested = [];
  const launched = [];
  const api = {
    previewDocumentPages: async (_projectPath, _relPath, _accessToken, options) => {
      requested.push([...options.pages]);
      return { format: 'pptx', mtimeMs: 5, size: 10, pageCount: 2, pages: options.pages.map(renderedPage) };
    },
    openFilePath: async () => launched.push('launch'),
    openLocalFile: async () => launched.push('launch'),
  };
  const { root, session } = await mountSession(api, 'docs/deck.pptx');
  try {
    assert.deepEqual(requested, [[1]]);
    assert.deepEqual(launched, []);
    assert.equal(session.current.documentPreview.pageCount, 2);
    assert.equal(session.current.documentError, '');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a desktop Office conversion failure falls back to the binary notice without launching', async (t) => {
  surface(t, true);
  const launched = [];
  const api = {
    previewDocumentPages: async () => {
      throw new Error('converter missing');
    },
    openFilePath: async () => launched.push('launch'),
    readProjectFile: async () => ({ content: '', mtimeMs: 11, binary: true, tooLarge: false, encoding: 'utf8' }),
    readEditorBackup: async () => null,
  };
  const { root, session } = await mountSession(api, 'docs/deck.pptx');
  try {
    assert.match(session.current.documentError, /converter missing/);
    assert.equal(session.current.documentPreview, null);
    assert.equal(session.current.load.binary, true);
    assert.equal(session.current.error, '');
    assert.deepEqual(launched, []);
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

test('a PDF opens in the page viewer, never through the native preview', async (t) => {
  surface(t, true);
  const requested = [];
  const api = {
    previewProjectFile: async () => {
      throw new Error('the iframe preview must not be requested');
    },
    previewDocumentPages: async (_projectPath, _relPath, _accessToken, options) => {
      requested.push({ ...options });
      return { format: 'pdf', mtimeMs: 1, size: 2, pageCount: 2, pages: options.pages.map(renderedPage) };
    },
  };
  const { root, session } = await mountSession(api, 'docs/report.pdf');
  try {
    assert.deepEqual(
      requested.map((entry) => entry.pages),
      [[1]]
    );
    assert.equal(session.current.preview, null);
    assert.equal(session.current.documentPreview.format, 'pdf');
    await act(async () => session.current.loadDocumentPages([2], 2000));
    assert.equal(requested.at(-1).maxWidth, 2000, 'zoomed pages are requested at the wider resolution');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a PDF without the page API falls back to the binary notice, not an iframe', async (t) => {
  surface(t, true);
  const api = {
    previewProjectFile: async () => {
      throw new Error('the iframe preview must not be requested');
    },
    readProjectFile: async () => ({ content: '', mtimeMs: 11, binary: true, tooLarge: false, encoding: 'utf8' }),
    readEditorBackup: async () => null,
  };
  const { root, session } = await mountSession(api, 'docs/report.pdf');
  try {
    assert.equal(session.current.preview, null);
    assert.equal(session.current.documentPreview, null);
    assert.equal(session.current.load.binary, true);
  } finally {
    await act(async () => root.unmount());
  }
});

const revisionOf =
  (mtimeMs, size, pageCount = 3) =>
  (options) => ({
    format: 'docx',
    mtimeMs,
    size,
    pageCount,
    pages: options.pages.map(renderedPage),
  });

test('a page result of another revision replaces the preview instead of mixing with it', async (t) => {
  surface(t, true);
  let serve = revisionOf(1, 10);
  const api = { previewDocumentPages: async (_p, _r, _a, options) => serve(options) };
  const { root, session } = await mountSession(api, 'docs/report.docx');
  try {
    assert.deepEqual(
      session.current.documentPreview.pages.map((p) => p.page),
      [1]
    );
    serve = revisionOf(2, 10, 5);
    await act(async () => session.current.loadDocumentPages([2]));
    const preview = session.current.documentPreview;
    assert.equal(preview.mtimeMs, 2);
    assert.equal(preview.pageCount, 5);
    assert.deepEqual(
      preview.pages.map((p) => p.page),
      [2],
      'page 1 of the old revision is dropped'
    );
    serve = revisionOf(2, 11, 5);
    await act(async () => session.current.loadDocumentPages([3]));
    assert.equal(session.current.documentPreview.size, 11, 'a changed size is a new revision too');
    assert.deepEqual(
      session.current.documentPreview.pages.map((p) => p.page),
      [3]
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test('an edited document refreshes after the change is seen twice, keeping the viewer mounted', async (t) => {
  surface(t, true);
  const intervals = new Map();
  let nextId = 1;
  const original = [window.setInterval, window.clearInterval];
  window.setInterval = (callback, ms) => {
    if (ms !== 2500) return original[0].call(window, callback, ms);
    intervals.set(nextId, callback);
    return nextId++;
  };
  window.clearInterval = (id) => {
    if (!intervals.delete(id)) original[1].call(window, id);
  };
  t.after(() => {
    [window.setInterval, window.clearInterval] = original;
  });
  let disk = { mtimeMs: 1, size: 10 };
  const requests = [];
  const api = {
    statProjectFile: async () => ({ ...disk }),
    previewDocumentPages: async (_p, _r, _a, options) => {
      requests.push([...options.pages]);
      return revisionOf(disk.mtimeMs, disk.size)(options);
    },
  };
  const { root, session } = await mountSession(api, 'docs/report.docx');
  const poll = () => act(async () => Promise.all([...intervals.values()].map((tick) => tick())));
  try {
    await poll();
    assert.deepEqual(requests, [[1]], 'an unchanged file costs no page request');
    disk = { mtimeMs: 2, size: 12 };
    await poll();
    assert.deepEqual(requests, [[1]], 'the first sighting only waits (the file may still be written)');
    await poll();
    assert.deepEqual(requests, [[1], [1]]);
    assert.equal(session.current.documentPreview.mtimeMs, 2);
    assert.equal(session.current.documentPreview.size, 12);
    await poll();
    assert.equal(requests.length, 2, 'settled: no further requests');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a failed batch keeps the pages that arrived and Retry re-requests just that batch', async (t) => {
  surface(t, true);
  let fail = false;
  const requests = [];
  const api = {
    previewDocumentPages: async (_p, _r, _a, options) => {
      requests.push([...options.pages]);
      if (fail) throw new Error('rasterizer crashed');
      return revisionOf(1, 10)(options);
    },
  };
  const { root, session } = await mountSession(api, 'docs/report.docx');
  try {
    await act(async () => session.current.loadDocumentPages([2]));
    fail = true;
    await act(async () => session.current.loadDocumentPages([3, 4]));
    assert.deepEqual(
      session.current.documentPreview.pages.map((p) => p.page),
      [1, 2],
      'earlier pages stay'
    );
    assert.equal(session.current.documentError, '', 'a page failure is not a document failure');
    assert.deepEqual(Object.keys(session.current.documentPageErrors), ['3', '4']);
    assert.deepEqual(session.current.documentPageErrors[3].batch, [3, 4]);
    assert.match(session.current.documentPageErrors[3].message, /rasterizer crashed/);

    fail = false;
    const { batch } = session.current.documentPageErrors[3];
    await act(async () => session.current.loadDocumentPages(batch));
    assert.deepEqual(requests.at(-1), [3, 4]);
    assert.deepEqual(session.current.documentPageErrors, {});
    assert.deepEqual(
      session.current.documentPreview.pages.map((p) => p.page),
      [1, 2, 3, 4]
    );
  } finally {
    await act(async () => root.unmount());
  }
});
