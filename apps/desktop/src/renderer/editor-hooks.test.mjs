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

const { useEditorMountSession } = await import('./use-editor-mount-session.ts');
const { useEditorFileSession } = await import('./use-editor-file-session.ts');

test('editor mount hook wires commands and model binding before publishing ready', async () => {
  const events = [];
  let onMount;
  const model = {
    getValue: () => 'edited',
  };
  const editor = {
    getDomNode: () => null,
    getModel: () => model,
    restoreViewState() {},
    focus: () => events.push('focus'),
  };
  function Harness() {
    const editorRef = useRef(null);
    const editorLayoutObserver = useRef(null);
    const editorLayoutSize = useRef(null);
    const activeRef = useRef(false);
    const focusedRef = useRef(false);
    const savedText = useRef('saved');
    onMount = useEditorMountSession({
      editorRef,
      editorLayoutObserver,
      editorLayoutSize,
      scheduleEditorLayout() {},
      armFonts() {},
      bindModel: (_editor, boundModel) => {
        assert.equal(boundModel, model);
        events.push('bind');
      },
      wireCommands: () => events.push('commands'),
      activeRef,
      focusedRef,
      savedText,
      projectPath: 'C:/Project/demo',
      relPath: 'src/App.tsx',
      viewStateKey: 'C:/Project/demo/src/App.tsx',
      readViewState: () => null,
      markDirty: (dirty) => events.push(`dirty:${dirty}`),
      renderAnsiOutput: (boundModel) => {
        assert.equal(boundModel, model);
        events.push('ansi');
      },
      notifyReady: () => events.push('ready'),
    });
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => onMount(editor));
    assert.deepEqual(events, ['commands', 'bind', 'dirty:true', 'ansi', 'ready']);
  } finally {
    await act(async () => root.unmount());
  }
});

test('a hidden file can format, save and back up its retained model without a mounted editor', async () => {
  const writes = [];
  const backups = [];
  let text = 'saved';
  const model = {
    getValue: () => text,
    setValue: (value) => {
      text = value;
    },
  };
  let session;
  let formats = 0;
  window.mixdogDesktop = {
    readProjectFile: async () => ({ content: 'saved', mtimeMs: 1, binary: false, tooLarge: false }),
    writeProjectFile: async (...args) => {
      writes.push(args);
      return { mtimeMs: 2 };
    },
    writeEditorBackup: async (...args) => {
      backups.push(args);
    },
    deleteEditorBackup: async () => {},
  };
  function Harness() {
    const editorRef = useRef(null);
    const modelRef = useRef(model);
    const syncLspRef = useRef(async () => true);
    session = useEditorFileSession({
      editorRef,
      modelRef,
      syncLspRef,
      projectPath: 'C:/Project/demo',
      relPath: 'a.txt',
      active: false,
      editorSettings: { formatOnSave: true },
      formatDocument: async () => {
        formats++;
        text = text.trim();
      },
      notifyReady() {},
      onDirty() {},
    });
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    text = ' edited ';
    await act(async () => session.onEditorChange(text));
    await act(async () => assert.equal(await session.save(), true));
    assert.equal(formats, 1);
    assert.deepEqual(writes[0].slice(0, 4), ['C:/Project/demo', 'a.txt', 'edited', 'saved']);
    text = 'unsaved after save';
    await act(async () => session.onEditorChange(text));
  } finally {
    await act(async () => root.unmount());
    delete window.mixdogDesktop;
  }
  assert.equal(backups.at(-1)[2], 'unsaved after save');
  assert.equal(backups.at(-1)[3], 'edited');
});

test('a tab whose file vanished explains it instead of printing ENOENT', async () => {
  let session;
  window.mixdogDesktop = {
    readProjectFile: async (_project, relPath) => {
      throw new Error(`ENOENT: no such file or directory, stat 'C:\\Project\\demo\\${relPath}'`);
    },
  };
  function Harness() {
    const editorRef = useRef(null);
    const syncLspRef = useRef(async () => true);
    session = useEditorFileSession({
      editorRef,
      syncLspRef,
      projectPath: 'C:/Project/demo',
      relPath: 'gone.md',
      active: false,
      editorSettings: { formatOnSave: false },
      notifyReady() {},
      onDirty() {},
    });
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    // A first read retries a missing file briefly (a just-created entry).
    await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
    assert.equal(session.load, null);
    assert.equal(session.error, 'File was deleted or renamed on disk.');
  } finally {
    await act(async () => root.unmount());
    delete window.mixdogDesktop;
  }
});

test('a Rich-held edit is what backups keep, including the final one on unmount', async () => {
  let text = 'saved';
  const model = { getValue: () => text, setValue: (value) => (text = value) };
  const backups = [];
  let deletes = 0;
  let session;
  window.mixdogDesktop = {
    readProjectFile: async () => ({ content: 'saved', mtimeMs: 1, binary: false, tooLarge: false }),
    writeProjectFile: async () => ({ mtimeMs: 2 }),
    writeEditorBackup: async (...args) => {
      backups.push(args[2]);
    },
    deleteEditorBackup: async () => {
      deletes++;
    },
  };
  function Harness() {
    const editorRef = useRef(null);
    const modelRef = useRef(model);
    const syncLspRef = useRef(async () => true);
    session = useEditorFileSession({
      editorRef,
      modelRef,
      syncLspRef,
      projectPath: 'C:/Project/demo',
      relPath: 'held.md',
      active: false,
      editorSettings: { formatOnSave: false },
      notifyReady() {},
      onDirty() {},
    });
    return null;
  }
  const wait = (ms) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  const root = createRoot(document.querySelector('main'));
  let heldText = 'saved https://example.com/$HOME$';
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await wait(50);
    // The model is unchanged (the edit is only in Rich), yet it is backed up.
    await act(async () => session.setRichHeld(true, () => heldText));
    await wait(600);
    assert.equal(backups.at(-1), 'saved https://example.com/$HOME$');
    // Typing on while held: the backup reads the latest held text.
    heldText = 'saved https://example.com/$HOME$ more';
    await act(async () => session.setRichHeld(true, () => heldText));
    await wait(600);
    assert.equal(backups.at(-1), heldText);
    // Released into the model: backups follow the model again.
    const deletesBefore = deletes;
    text = heldText;
    await act(async () => session.setRichHeld(false));
    await act(async () => session.onEditorChange(text));
    await wait(600);
    assert.equal(backups.at(-1), heldText);
    assert.equal(deletes, deletesBefore);
    // Held again, then the pane goes away before the debounce: the final
    // backup on unmount is the held text.
    heldText = `${text} and last`;
    await act(async () => session.setRichHeld(true, () => heldText));
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 20));
    delete window.mixdogDesktop;
  }
  assert.equal(backups.at(-1), heldText);
});

test('releasing a held edit with a clean model removes its backup', async () => {
  let text = 'saved';
  const model = { getValue: () => text, setValue: (value) => (text = value) };
  const log = [];
  let session;
  window.mixdogDesktop = {
    readProjectFile: async () => ({ content: 'saved', mtimeMs: 1, binary: false, tooLarge: false }),
    writeProjectFile: async () => ({ mtimeMs: 2 }),
    writeEditorBackup: async (...args) => log.push(`write:${args[2]}`),
    deleteEditorBackup: async () => log.push('delete'),
  };
  function Harness() {
    const editorRef = useRef(null);
    const modelRef = useRef(model);
    const syncLspRef = useRef(async () => true);
    session = useEditorFileSession({
      editorRef,
      modelRef,
      syncLspRef,
      projectPath: 'C:/Project/demo',
      relPath: 'held.md',
      active: false,
      editorSettings: { formatOnSave: false },
      notifyReady() {},
      onDirty() {},
    });
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    log.length = 0;
    await act(async () => session.setRichHeld(true, () => 'held'));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
    // Discarded in Rich: nothing unsaved remains.
    await act(async () => session.setRichHeld(false));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  } finally {
    await act(async () => root.unmount());
    delete window.mixdogDesktop;
  }
  assert.deepEqual(log, ['write:held', 'delete']);
});

function heldBackupHarness(api, { active = false } = {}) {
  let text = 'saved';
  const model = { getValue: () => text, setValue: (value) => (text = value) };
  const dirty = [];
  const state = { session: null, dirty, setText: (value) => (text = value) };
  window.mixdogDesktop = {
    readProjectFile: async () => ({ content: 'saved', mtimeMs: 1, binary: false, tooLarge: false }),
    writeProjectFile: async () => ({ mtimeMs: 2 }),
    ...api,
  };
  function Harness() {
    const editorRef = useRef(null);
    const modelRef = useRef(model);
    const syncLspRef = useRef(async () => true);
    state.session = useEditorFileSession({
      editorRef,
      modelRef,
      syncLspRef,
      projectPath: 'C:/Project/demo',
      relPath: 'held.md',
      active,
      editorSettings: { formatOnSave: false },
      notifyReady() {},
      onDirty: (value) => dirty.push(value),
      onSaveHandle: (handle) => {
        if (handle) state.handle = handle;
      },
    });
    return null;
  }
  return { state, Harness };
}

test('a held backup keeps the disk text the held edit was based on, so recovery reports an outside change', async () => {
  const { resolveEditorBackup } = await import('./editor-file-loader.ts');
  const backups = [];
  let disk = 'saved';
  const { state, Harness } = heldBackupHarness({
    readProjectFile: async () => ({ content: disk, mtimeMs: disk === 'saved' ? 1 : 5, binary: false, tooLarge: false }),
    writeEditorBackup: async (_project, _rel, content, expectedContent) => backups.push({ content, expectedContent }),
    deleteEditorBackup: async () => backups.push(null),
  });
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    await act(async () => state.session.setRichHeld(true, () => 'saved plus held'));
    // Changed outside, then reverted to that version while the edit is held.
    disk = 'changed outside';
    await act(async () => assert.equal(await state.session.revertFromDisk(), true));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 20));
    delete window.mixdogDesktop;
  }
  const last = backups.at(-1);
  assert.deepEqual(last, { content: 'saved plus held', expectedContent: 'saved' });
  assert.ok(
    backups.every((backup) => backup === null || backup.expectedContent === 'saved'),
    'never relabelled against the newer disk text'
  );
  const resolved = resolveEditorBackup(disk, last);
  assert.equal(resolved.recovery?.diskChanged, true, 'recovery reports the conflict');
  assert.equal(resolved.content, 'changed outside', 'the outside edit is not replaced');
});

test('disk watching treats a held edit as unsaved and does not reload over it', async () => {
  let reads = 0;
  let mtime = 1;
  const { state, Harness } = heldBackupHarness(
    {
      readProjectFile: async () => {
        reads++;
        return { content: 'saved', mtimeMs: mtime, binary: false, tooLarge: false };
      },
      statProjectFile: async () => ({ mtimeMs: mtime }),
      writeEditorBackup: async () => undefined,
      deleteEditorBackup: async () => undefined,
    },
    { active: true }
  );
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    await act(async () => state.session.setRichHeld(true, () => 'saved plus held'));
    const readsBefore = reads;
    mtime = 9;
    await act(async () => {
      window.dispatchEvent(new window.Event('pagehide'));
      window.dispatchEvent(new window.Event('pageshow'));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    assert.equal(reads, readsBefore, 'no automatic reload');
    assert.equal(state.session.diskChanged, true, 'flagged as changed on disk');
  } finally {
    await act(async () => root.unmount());
    delete window.mixdogDesktop;
  }
});

test('a save settling its backup after a held edit is discarded does not recreate the backup', async () => {
  const log = [];
  let openGate;
  const gate = new Promise((resolve) => (openGate = resolve));
  const { state, Harness } = heldBackupHarness({
    writeEditorBackup: async (...args) => log.push(`write:${args[2]}`),
    deleteEditorBackup: async () => {
      await gate;
      log.push('delete');
    },
  });
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    state.setText('edited');
    await act(async () => state.session.onEditorChange('edited'));
    let saved;
    await act(async () => {
      // The write completes; its backup deletion is paused at the gate.
      saved = state.session.save();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => state.session.setRichHeld(true, () => 'held'));
    let discarded;
    await act(async () => {
      discarded = state.handle.discard();
    });
    log.length = 0;
    await act(async () => {
      openGate();
      await saved;
      await discarded;
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 20));
    delete window.mixdogDesktop;
  }
  assert.ok(!log.some((entry) => entry.startsWith('write:')), `no backup after the discard: ${log.join(', ')}`);
  assert.equal(log.at(-1), 'delete');
});

test('an edit held while a save is writing keeps its backup and the save does not report success', async () => {
  const log = [];
  let finishWrite;
  const { state, Harness } = heldBackupHarness({
    writeProjectFile: () => new Promise((resolve) => (finishWrite = () => resolve({ mtimeMs: 2 }))),
    writeEditorBackup: async (...args) => log.push(`write:${args[2]}`),
    deleteEditorBackup: async () => log.push('delete'),
  });
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    state.setText('edited');
    await act(async () => state.session.onEditorChange('edited'));
    log.length = 0;
    let saved;
    await act(async () => {
      saved = state.session.save();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.ok(finishWrite, 'the write started');
    await act(async () => state.session.setRichHeld(true, () => 'edited and held'));
    let result;
    await act(async () => {
      finishWrite();
      result = await saved;
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
    assert.equal(result, false, 'the held edit is not in the file');
    assert.match(state.session.saveError, /Rich/);
    assert.equal(state.dirty.at(-1), true);
    assert.ok(!log.includes('delete'), `the held backup is never deleted: ${log.join(', ')}`);
    assert.equal(log.at(-1), 'write:edited and held');
  } finally {
    await act(async () => root.unmount());
    delete window.mixdogDesktop;
  }
});

test('reverting while an edit is held keeps the held backup', async () => {
  const log = [];
  const { state, Harness } = heldBackupHarness({
    writeEditorBackup: async (...args) => log.push(`write:${args[2]}`),
    deleteEditorBackup: async () => log.push('delete'),
  });
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    await act(async () => state.session.setRichHeld(true, () => 'held'));
    log.length = 0;
    await act(async () => assert.equal(await state.session.revertFromDisk(), true));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
    assert.equal(state.dirty.at(-1), true);
    assert.ok(!log.includes('delete'), `the held backup is never deleted: ${log.join(', ')}`);
    assert.equal(log.at(-1), 'write:held');
  } finally {
    await act(async () => root.unmount());
    delete window.mixdogDesktop;
  }
});

test('a Rich-held edit keeps the file dirty and refuses every save until it is resolved', async () => {
  let text = 'saved';
  const model = { getValue: () => text, setValue: (value) => (text = value) };
  const writes = [];
  const dirty = [];
  let session;
  window.mixdogDesktop = {
    readProjectFile: async () => ({ content: 'saved', mtimeMs: 1, binary: false, tooLarge: false }),
    writeProjectFile: async (...args) => (writes.push(args), { mtimeMs: 2 }),
    writeEditorBackup: async () => {},
    deleteEditorBackup: async () => {},
  };
  function Harness() {
    const editorRef = useRef(null);
    const modelRef = useRef(model);
    const syncLspRef = useRef(async () => true);
    session = useEditorFileSession({
      editorRef,
      modelRef,
      syncLspRef,
      projectPath: 'C:/Project/demo',
      relPath: 'held.md',
      active: false,
      editorSettings: { formatOnSave: false },
      notifyReady() {},
      onDirty: (value) => dirty.push(value),
    });
    return null;
  }
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => session.setRichHeld(true));
    assert.equal(dirty.at(-1), true, 'a held edit is unsaved work for the close guards');
    // Not even an unchanged model may "save": the held edit would be lost silently.
    await act(async () => assert.equal(await session.save(), false));
    assert.equal(writes.length, 0);
    assert.match(session.saveError, /Rich/);
    // Model edits while held still cannot clear the dirty flag.
    await act(async () => session.onEditorChange('saved'));
    assert.equal(dirty.at(-1), true);
    await act(async () => session.setRichHeld(false));
    assert.equal(dirty.at(-1), false, 'discarding the held edit leaves the file clean');
    await act(async () => assert.equal(await session.save(), true));
  } finally {
    await act(async () => root.unmount());
    delete window.mixdogDesktop;
  }
});
