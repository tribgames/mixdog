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
    previewProjectFile: async () => ({
      kind: 'image',
      url: 'file:///a.svg',
      mtimeMs: 3,
      size: 6,
      mime: 'image/svg+xml',
    }),
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

test('invalidly encoded text is read-only, cannot restore a backup or save even via conversion', async (t) => {
  const fs = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readProjectTextFileIn, writeProjectTextFileIn } = await import('../main/project-files.ts');
  const folder = await fs.mkdtemp(join(tmpdir(), 'mixdog-editor-encoding-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const bytes = Buffer.from([0x61, 0x80, 0x62]);
  await fs.writeFile(join(folder, 'bad.txt'), bytes);
  const opened = await readProjectTextFileIn(folder, 'bad.txt');
  const model = fakeModel('a\uFFFDb');
  let writes = 0;
  const api = {
    readProjectFile: async () => opened,
    readEditorBackup: async () => ({ content: 'stale backup', expectedContent: 'a\uFFFDb' }),
    writeEditorBackup: async () => undefined,
    deleteEditorBackup: async () => undefined,
    writeProjectFile: async (_project, _rel, content, expected, _token, encoding) => {
      writes++;
      return writeProjectTextFileIn(folder, 'bad.txt', content, expected, encoding);
    },
  };
  const { root, session } = await mountSession(api, 'bad.txt', model);
  try {
    assert.equal(session.current.load.readOnly, true);
    assert.equal(session.current.load.readOnlyReason, 'encoding');
    assert.equal(session.current.load.content, 'a\uFFFDb');
    assert.equal(session.current.recovery, null);
    await act(async () => {
      model.setValue('edited');
      assert.equal(await session.current.save(), false);
      assert.equal(await session.current.save('utf8'), false);
    });
    assert.equal(writes, 0);
    assert.deepEqual(await fs.readFile(join(folder, 'bad.txt')), bytes);
  } finally {
    await act(async () => root.unmount());
  }
});

test('the read-only notice distinguishes encoding failures from the legacy size cap', async () => {
  const { EditorPaneReadOnlyNotice } = await import('./editor-pane-surfaces.tsx');
  const element = document.createElement('div');
  const root = createRoot(element);
  try {
    await act(async () => root.render(React.createElement(EditorPaneReadOnlyNotice, { reason: 'encoding' })));
    assert.match(element.querySelector('[role="status"]').textContent, /invalid text encoding/);
    assert.match(element.textContent, /external editor/);
    assert.doesNotMatch(element.textContent, /1 MB/);
    await act(async () => root.render(React.createElement(EditorPaneReadOnlyNotice)));
    assert.match(element.querySelector('[role="status"]').textContent, /over 1 MB/);
  } finally {
    await act(async () => root.unmount());
  }
});

for (const action of ['keepEdits', 'revertFromDisk']) {
  for (const reason of ['encoding', 'size']) {
    test(`${action} refuses a newly ${reason}-read-only disk without discarding edits or changing the save baseline`, async (t) => {
      const fs = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { readProjectTextFileIn, writeProjectTextFileIn } = await import('../main/project-files.ts');
      const folder = await fs.mkdtemp(join(tmpdir(), 'mixdog-editor-conflict-'));
      t.after(() => fs.rm(folder, { recursive: true, force: true }));
      const file = join(folder, 'a.txt');
      await fs.writeFile(file, 'original');
      let disk = await readProjectTextFileIn(folder, 'a.txt');
      const model = fakeModel('original');
      const writes = [];
      let backupDeletes = 0;
      const api = {
        readProjectFile: async () => disk,
        readEditorBackup: async () => null,
        writeEditorBackup: async () => undefined,
        deleteEditorBackup: async () => {
          backupDeletes++;
        },
        writeProjectFile: async (_project, _rel, content, expected) => {
          writes.push({ content, expected });
          return writeProjectTextFileIn(folder, 'a.txt', content, expected);
        },
      };
      const { root, session } = await mountSession(api, 'a.txt', model);
      try {
        await act(async () => {
          model.setValue('retained edits');
          session.current.onEditorChange('retained edits');
        });
        const unsafe = reason === 'encoding' ? Buffer.from([0x61, 0x80, 0x62]) : Buffer.alloc(1_048_577, 0x61);
        await fs.writeFile(file, unsafe);
        disk = await readProjectTextFileIn(folder, 'a.txt');
        assert.equal(disk.readOnly, true);
        const deletesBefore = backupDeletes;
        await act(async () => {
          const result = await session.current[action]();
          if (action === 'revertFromDisk') assert.equal(result, false);
        });
        assert.equal(session.current.diskChanged, true);
        assert.equal(session.current.dirty, true);
        assert.equal(model.getValue(), 'retained edits');
        assert.equal(session.current.load.content, 'original');
        const message = action === 'keepEdits' ? session.current.saveError : session.current.revertError;
        assert.match(message, /no longer be safely edited/);
        assert.equal(backupDeletes, deletesBefore);
        assert.deepEqual(writes, []);
        assert.deepEqual(await fs.readFile(file), unsafe);
        // Once the disk is repaired, the retained edits still save against the
        // original exact baseline. The rejected action never rebased them onto
        // replacement-decoded or oversized content.
        await fs.writeFile(file, 'original');
        await act(async () => assert.equal(await session.current.save(), true));
        assert.deepEqual(writes, [{ content: 'retained edits', expected: 'original' }]);
        assert.equal(await fs.readFile(file, 'utf8'), 'retained edits');
      } finally {
        await act(async () => root.unmount());
      }
    });
  }
}
