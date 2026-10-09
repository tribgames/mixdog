import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  actEnvironment: false,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { useEditorFileSession } = await import('./use-editor-file-session.ts');

async function mountSession(api, relPath, model) {
  window.mixdogDesktop = api;
  const session = { current: null };
  function Harness() {
    const editorRef = useRef(null);
    const modelRef = useRef(model);
    const syncLspRef = useRef(async () => false);
    session.current = useEditorFileSession({
      editorRef,
      modelRef,
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

function fakeModel(initial) {
  let value = initial;
  return {
    getValue: () => value,
    setValue: (next) => {
      value = next;
    },
  };
}

test('SVG loads its image preview and its text source together; edits survive the view switch', async () => {
  const model = fakeModel('<svg/>');
  const writes = [];
  const api = {
    previewProjectFile: async () => ({ kind: 'image', url: 'file:///a.svg', mtimeMs: 3, size: 6, mime: 'image/svg+xml' }),
    readProjectFile: async () => ({ content: '<svg/>', mtimeMs: 3, binary: false, tooLarge: false, encoding: 'utf8' }),
    readEditorBackup: async () => null,
    writeEditorBackup: async () => undefined,
    deleteEditorBackup: async () => undefined,
    writeProjectFile: async (...args) => {
      writes.push(args);
      return { mtimeMs: 4 };
    },
  };
  const { root, session } = await mountSession(api, 'art/logo.svg', model);
  try {
    assert.equal(session.current.preview.url, 'file:///a.svg');
    assert.equal(session.current.load.binary, false);
    assert.equal(session.current.load.content, '<svg/>');
    // Edit in source view; the model (kept mounted by the pane) holds the edit
    // while the preview is showing, and the session still saves it.
    model.setValue('<svg><g/></svg>');
    await act(async () => session.current.onEditorChange(model.getValue()));
    assert.equal(session.current.dirty, true);
    assert.equal(model.getValue(), '<svg><g/></svg>');
    let saved;
    await act(async () => {
      saved = await session.current.save();
    });
    assert.equal(saved, true);
    assert.equal(writes[0][2], '<svg><g/></svg>');
    assert.equal(session.current.dirty, false);
  } finally {
    await act(async () => root.unmount());
  }
});

test('a text file over 1 MB opens read-only and cannot be saved', async () => {
  const model = fakeModel('big');
  const writes = [];
  const api = {
    readProjectFile: async () => ({
      content: 'big',
      mtimeMs: 9,
      binary: false,
      tooLarge: false,
      readOnly: true,
      encoding: 'utf8',
    }),
    readEditorBackup: async () => ({ content: 'stale backup', expectedContent: 'big' }),
    writeEditorBackup: async () => undefined,
    deleteEditorBackup: async () => undefined,
    writeProjectFile: async (...args) => {
      writes.push(args);
      return { mtimeMs: 10 };
    },
  };
  const { root, session } = await mountSession(api, 'logs/huge.log', model);
  try {
    assert.equal(session.current.load.readOnly, true);
    assert.equal(session.current.load.content, 'big', 'a stale backup is not applied');
    assert.equal(session.current.recovery, null);
    let saved = true;
    await act(async () => {
      model.setValue('changed');
      saved = await session.current.save();
    });
    assert.equal(saved, false);
    assert.deepEqual(writes, []);
  } finally {
    await act(async () => root.unmount());
  }
});

test('a mixed-EOL read-only file is clean on mount and keeps its raw disk text', async () => {
  const raw = 'a\r\nb\nc\nd\n';
  const normalized = 'a\nb\nc\nd\n';
  const model = fakeModel(normalized);
  let reads = 0;
  const api = {
    readProjectFile: async () => ({
      content: raw,
      mtimeMs: 9,
      binary: false,
      tooLarge: false,
      readOnly: true,
      encoding: 'utf8',
    }),
    statProjectFile: async () => {
      reads += 1;
      return { mtimeMs: 9 };
    },
    readEditorBackup: async () => null,
    writeEditorBackup: async () => undefined,
    deleteEditorBackup: async () => undefined,
  };
  const { root, session } = await mountSession(api, 'logs/mixed.log', model);
  try {
    assert.equal(session.current.load.content, normalized);
    assert.equal(session.current.savedText.current, normalized);
    assert.equal(session.current.dirty, false);
    assert.equal(model.getValue(), normalized, 'model matches the baseline');
    assert.equal(reads, 0);
  } finally {
    await act(async () => root.unmount());
  }
});

test('revert after an edit bumps the content revision although the loaded text is unchanged', async () => {
  const model = fakeModel('A');
  const api = {
    readProjectFile: async () => ({ content: 'A', mtimeMs: 3, binary: false, tooLarge: false, encoding: 'utf8' }),
    readEditorBackup: async () => null,
    writeEditorBackup: async () => undefined,
    deleteEditorBackup: async () => undefined,
  };
  const { root, session } = await mountSession(api, 'notes/a.md', model);
  try {
    assert.equal(session.current.load.content, 'A');
    const before = session.current.contentRevision;
    model.setValue('B');
    await act(async () => {
      await session.current.revertFromDisk();
    });
    assert.equal(model.getValue(), 'A');
    assert.equal(session.current.load.content, 'A');
    assert.ok(session.current.contentRevision > before, 'a revert refreshes rendered previews');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a file over the 10 MB cap keeps the too-large fallback', async () => {
  const api = {
    readProjectFile: async () => ({ content: '', mtimeMs: 9, binary: false, tooLarge: true, encoding: 'utf8' }),
    readEditorBackup: async () => null,
  };
  const { root, session } = await mountSession(api, 'logs/enormous.log', fakeModel(''));
  try {
    assert.equal(session.current.load.tooLarge, true);
    assert.equal(session.current.load.readOnly, undefined);
  } finally {
    await act(async () => root.unmount());
  }
});
