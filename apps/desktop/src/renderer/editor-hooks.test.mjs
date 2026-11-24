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
      autoFocusRef: { current: true },
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
  let loaded = () => {};
  const state = {
    session: null,
    dirty,
    setText: (value) => (text = value),
    // The first dirty report is the load's.
    loaded: new Promise((resolve) => (loaded = resolve)),
  };
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
      onDirty: (value) => {
        dirty.push(value);
        loaded();
      },
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
  // The core's file watch pushes `fs/changed` for the editor's own watch id; there is no stat poll.
  const watches = [];
  const listeners = new Set();
  const { state, Harness } = heldBackupHarness(
    {
      sections: {
        call: async (method, params) => void watches.push([method, params]),
        subscribeFsChanged: (listener) => {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
      },
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
    const watchId = watches.find(([method]) => method === 'fs/watch')?.[1].watchId;
    assert.ok(watchId, 'the open file is watched');
    await act(async () => {
      for (const listener of [...listeners]) listener({ watchId, changedPaths: ['C:/Project/demo/held.md'] });
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

test('an edit typed just before the page is hidden is backed up without waiting for the debounce', async () => {
  const log = [];
  let deleted = () => {};
  const deletion = new Promise((resolve) => (deleted = resolve));
  const { state, Harness } = heldBackupHarness({
    writeEditorBackup: async (...args) => log.push(`write:${args[2]}`),
    deleteEditorBackup: async () => {
      log.push('delete');
      deleted();
    },
  });
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(() => state.loaded);
    state.setText('typed before quit');
    await act(async () => state.session.onEditorChange('typed before quit'));
    await act(async () => window.dispatchEvent(new window.Event('pagehide')));
    // Discarding cancels a write still waiting for the debounce and queues
    // behind one already started: the order shows which the hide did.
    await act(async () => {
      state.session.discardPendingBackup();
      await deletion;
    });
    assert.deepEqual(log, ['write:typed before quit', 'delete']);
  } finally {
    await act(async () => root.unmount());
    delete window.mixdogDesktop;
  }
});

test("a quit's flush settles when the window's core link is not open instead of waiting on the write", async () => {
  const { watchLocalCoreLink } = await import('./local-core-link.ts');
  const { flushEditorBackups } = await import('./use-editor-backup.ts');
  // The store follows a window with a port bridge; the first use creates it.
  window.mixdogCorePort = {};
  const linkListeners = new Set();
  const connection = { status: 'ready', onState: (listener) => linkListeners.add(listener) };
  watchLocalCoreLink(connection);
  let writeStarted = () => {};
  const started = new Promise((resolve) => (writeStarted = resolve));
  const { state, Harness } = heldBackupHarness({
    // A server that died: the write never comes back.
    writeEditorBackup: () => {
      writeStarted();
      return new Promise(() => {});
    },
    deleteEditorBackup: async () => undefined,
  });
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(() => state.loaded);
    state.setText('typed');
    await act(async () => state.session.onEditorChange('typed'));
    const flushed = flushEditorBackups();
    await act(() => started);
    connection.status = 'reconnecting';
    for (const listener of linkListeners) listener();
    await flushed;
  } finally {
    connection.status = 'ready';
    for (const listener of linkListeners) listener();
    await act(async () => root.unmount());
    delete window.mixdogDesktop;
    delete window.mixdogCorePort;
  }
});

test('keeping the edits of a file deleted on disk saves them to its path again', async () => {
  let gone = false;
  const created = [];
  const writes = [];
  const { state, Harness } = heldBackupHarness({
    readProjectFile: async () => {
      if (gone) throw new Error("ENOENT: no such file or directory, open 'C:\\Project\\demo\\held.md'");
      return { content: 'saved', mtimeMs: 1, binary: false, tooLarge: false };
    },
    createProjectEntry: async (...args) => void created.push(args),
    statProjectFile: async () => ({ mtimeMs: 6, size: 0 }),
    writeProjectFile: async (...args) => {
      writes.push(args.slice(1, 4));
      return { mtimeMs: 7 };
    },
    writeEditorBackup: async () => undefined,
    deleteEditorBackup: async () => undefined,
  });
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(() => state.loaded);
    state.setText('edited');
    await act(async () => state.session.onEditorChange('edited'));
    gone = true;
    await act(async () => state.session.keepEdits());
    assert.deepEqual(created, [['C:/Project/demo', '', 'held.md', false]]);
    assert.deepEqual(writes, [['held.md', 'edited', '']]);
    assert.equal(state.session.diskChanged, false);
    assert.equal(state.session.saveError, '');
    assert.equal(state.dirty.at(-1), false);
  } finally {
    await act(async () => root.unmount());
    delete window.mixdogDesktop;
  }
});

/** A buffer of `held.md`, loaded as 'saved', whose file is deleted when `state.gone` is set. */
function goneFileHarness(log) {
  const gone = { value: false };
  const harness = heldBackupHarness({
    readProjectFile: async () => {
      if (gone.value) throw new Error("ENOENT: no such file or directory, open 'C:\\Project\\demo\\held.md'");
      return { content: 'saved', mtimeMs: 1, binary: false, tooLarge: false };
    },
    createProjectEntry: async () => void log.push('create'),
    statProjectFile: async () => {
      log.push('stat');
      return { mtimeMs: 9, size: 0 };
    },
    writeProjectFile: async (_project, _rel, content) => {
      log.push(`write:${content}`);
      return { mtimeMs: 9 };
    },
    writeEditorBackup: async (_project, _rel, content) => void log.push(`backup:${content}`),
    deleteEditorBackup: async () => void log.push('delete-backup'),
  });
  return { ...harness, gone };
}

test('a deleted file is not recreated while its save cannot happen, and its saved state stays', async () => {
  const log = [];
  const { state, Harness, gone } = goneFileHarness(log);
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(() => state.loaded);
    state.setText('edited');
    await act(async () => state.session.onEditorChange('edited'));
    await act(async () => state.session.setRichHeld(true, () => 'edited and held'));
    gone.value = true;
    log.length = 0;
    await act(() => state.session.keepEdits());
    assert.ok(!log.includes('create'), `nothing is created: ${log.join(', ')}`);
    assert.equal(state.session.savedText.current, 'saved');
    assert.equal(state.session.diskChanged, true);
    assert.match(state.session.saveError, /Rich/);
  } finally {
    await act(async () => root.unmount());
    delete window.mixdogDesktop;
  }
});

test('an emptied buffer of a deleted file is saved by creating the file, settled as after any save', async () => {
  const log = [];
  const { state, Harness, gone } = goneFileHarness(log);
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(() => state.loaded);
    state.setText('');
    await act(async () => state.session.onEditorChange(''));
    gone.value = true;
    log.length = 0;
    await act(() => state.session.keepEdits());
    assert.deepEqual(log, ['create', 'stat', 'delete-backup'], 'no write after the create; the backup goes');
    assert.equal(state.session.savedText.current, '');
    assert.equal(state.session.diskChanged, false);
    assert.equal(state.session.saveError, '');
    assert.equal(state.dirty.at(-1), false);
  } finally {
    await act(async () => root.unmount());
    delete window.mixdogDesktop;
  }
});

function diskWatchHarness(api, { active = true } = {}) {
  let text = 'v1';
  let replaced = () => {};
  const model = {
    getValue: () => text,
    setValue: (value) => {
      text = value;
      replaced();
    },
  };
  const watches = [];
  const listeners = new Set();
  let loaded = () => {};
  const state = {
    session: null,
    setActive: null,
    text: () => text,
    type: (value) => (text = value),
    // The first dirty report is the load's.
    loaded: new Promise((resolve) => (loaded = resolve)),
    /** Settles when a reload next replaces the model text. */
    nextReplace: () => new Promise((resolve) => (replaced = resolve)),
    // One pushed `fs/changed` for the live watch.
    changed: () =>
      act(async () => {
        const watchId = watches.filter(([method]) => method === 'fs/watch').at(-1)?.[1].watchId;
        for (const listener of [...listeners]) listener({ watchId, changedPaths: [] });
      }),
  };
  window.mixdogDesktop = {
    sections: {
      call: async (method, params) => void watches.push([method, params]),
      subscribeFsChanged: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
    writeEditorBackup: async () => undefined,
    deleteEditorBackup: async () => undefined,
    ...api,
  };
  function Harness() {
    const [isActive, setActive] = React.useState(active);
    state.setActive = setActive;
    const editorRef = useRef(null);
    const modelRef = useRef(model);
    const syncLspRef = useRef(async () => true);
    state.session = useEditorFileSession({
      editorRef,
      modelRef,
      syncLspRef,
      projectPath: 'C:/Project/demo',
      relPath: 'watched.md',
      active: isActive,
      editorSettings: { formatOnSave: false },
      notifyReady() {},
      onDirty: () => loaded(),
    });
    return null;
  }
  return { state, Harness };
}

const textFile = (content, mtimeMs) => ({ content, mtimeMs, binary: false, tooLarge: false, encoding: 'utf8' });

test('a reload from disk neither lets an older read win nor overwrites an edit typed while it reads', async () => {
  const reads = [];
  let mtime = 1;
  let readStarted = () => {};
  let statted = () => {};
  const nextRead = () => new Promise((resolve) => (readStarted = resolve));
  const nextStat = () => new Promise((resolve) => (statted = resolve));
  const { state, Harness } = diskWatchHarness({
    readProjectFile: () =>
      new Promise((resolve) => {
        reads.push(resolve);
        readStarted();
      }),
    statProjectFile: async () => {
      const info = { mtimeMs: mtime };
      statted();
      return info;
    },
  });
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    // The watch that starts with the load checks the file once.
    let checked = nextStat();
    await act(async () => reads.shift()(textFile('v1', 1)));
    await act(() => Promise.all([state.loaded, checked]));
    // Two quick writes: two reloads in flight, and the newer read answers first.
    for (const written of [2, 3]) {
      mtime = written;
      const started = nextRead();
      await state.changed();
      await act(() => started);
    }
    assert.equal(reads.length, 2);
    const [older, newer] = reads.splice(0);
    const replaced = state.nextReplace();
    checked = nextStat();
    await act(async () => newer(textFile('v3', 3)));
    await act(() => Promise.all([replaced, checked]));
    await act(async () => older(textFile('v2', 2)));
    assert.equal(state.text(), 'v3');
    // Another write, and the user types while its read is in flight.
    mtime = 4;
    const started = nextRead();
    await state.changed();
    await act(() => started);
    assert.equal(reads.length, 1);
    state.type('v3 typed');
    await act(async () => state.session.onEditorChange('v3 typed'));
    await act(async () => reads.shift()(textFile('v4', 4)));
    assert.equal(state.text(), 'v3 typed');
    assert.equal(state.session.dirty, true);
    assert.equal(state.session.diskChanged, true);
  } finally {
    await act(async () => root.unmount());
    delete window.mixdogDesktop;
  }
});

test('a tab made active again reloads a change made on disk while it was inactive', async () => {
  let disk = textFile('v1', 1);
  const { state, Harness } = diskWatchHarness(
    {
      readProjectFile: async () => disk,
      statProjectFile: async () => ({ mtimeMs: disk.mtimeMs }),
    },
    { active: false }
  );
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(() => state.loaded);
    disk = textFile('v2', 2);
    const replaced = state.nextReplace();
    await act(async () => state.setActive(true));
    await act(() => replaced);
    assert.equal(state.text(), 'v2');
    assert.equal(state.session.dirty, false);
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
    writeProjectFile: async (...args) => {
      writes.push(args);
      return { mtimeMs: 2 };
    },
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
