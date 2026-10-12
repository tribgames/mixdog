import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  actEnvironment: false,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(restore);

const store = await import('./editor-view-mode-store.ts');
const { editorViewModes } = await import('./editor-delimited.ts');
const { DEFAULT_DESKTOP_EDITOR_SETTINGS } = await import('../shared/editor-settings.ts');

test('default view: SVG opens rendered, tables source, Markdown follows the setting', () => {
  window.localStorage.clear();
  store.resetViewModeMemory();
  assert.equal(DEFAULT_DESKTOP_EDITOR_SETTINGS.markdownDefaultView, 'preview');
  assert.equal(store.initialViewMode('svg', 'C:/p/a.svg', 'source'), 'rendered');
  assert.equal(store.initialViewMode('table', 'C:/p/a.csv', 'rich'), 'source');
  assert.equal(store.initialViewMode(null, 'C:/p/a.ts', 'rich'), 'source');
  assert.equal(store.initialViewMode('markdown', 'C:/p/a.md', 'preview'), 'rendered');
  assert.equal(store.initialViewMode('markdown', 'C:/p/a.md', 'rich'), 'rich');
  assert.equal(store.initialViewMode('markdown', 'C:/p/a.md', 'source'), 'source');
  assert.deepEqual(editorViewModes('markdown'), ['rendered', 'rich', 'source']);
  assert.deepEqual(editorViewModes('svg'), ['rendered', 'source']);
  assert.deepEqual(editorViewModes('table'), ['rendered', 'source']);
});

test('a remembered mode beats the setting, survives a reload, and is bounded', () => {
  window.localStorage.clear();
  store.resetViewModeMemory();
  store.rememberViewMode('C:/p/a.md', 'source');
  assert.equal(store.initialViewMode('markdown', 'C:/p/a.md', 'rich'), 'source');
  assert.equal(store.initialViewMode('markdown', 'C:/p/b.md', 'rich'), 'rich');
  store.resetViewModeMemory();
  assert.equal(store.readRememberedViewMode('C:/p/a.md'), 'source', 'read back from storage');
  for (let index = 0; index < store.EDITOR_VIEW_MODE_LIMIT + 5; index += 1) {
    store.rememberViewMode(`C:/p/${index}.md`, 'rich');
  }
  store.resetViewModeMemory();
  assert.equal(store.readRememberedViewMode('C:/p/a.md'), null, 'the oldest path was forgotten');
  assert.equal(store.readRememberedViewMode('C:/p/0.md'), null);
  assert.equal(store.readRememberedViewMode(`C:/p/${store.EDITOR_VIEW_MODE_LIMIT + 4}.md`), 'rich');
  assert.equal(
    JSON.parse(window.localStorage.getItem('mixdog.desktop.editor-view-modes.v1')).length,
    store.EDITOR_VIEW_MODE_LIMIT
  );
});

test('General control writes the user setting that the editor reads back', async () => {
  const { readMarkdownDefaultView, writeMarkdownDefaultView, readScopedEditorSettings } = await import(
    '../main/workspace-config.ts'
  );
  const root = await mkdtemp(join(tmpdir(), 'mixdog-md-write-'));
  try {
    assert.equal(await readMarkdownDefaultView(root), 'preview', 'no file: the default');
    await writeMarkdownDefaultView(root, 'rich');
    assert.equal(await readMarkdownDefaultView(root), 'rich');
    const file = join(root, 'User', 'settings.json');
    await writeFile(file, '{\n  // keep me\n  "editor.tabSize": 4,\n}\n');
    await writeMarkdownDefaultView(root, 'source');
    const text = await readFile(file, 'utf8');
    assert.ok(text.includes('// keep me') && text.includes('"editor.tabSize": 4'));
    assert.equal((await readScopedEditorSettings(root, root, 'a.md')).markdownDefaultView, 'source');
    await writeMarkdownDefaultView(root, 'preview');
    assert.equal(await readMarkdownDefaultView(root), 'preview');
    assert.equal((await readFile(file, 'utf8')).match(/defaultView/g).length, 1, 'updated in place');
    // A { in a leading comment and a commented-out key must not be mistaken for structure.
    await writeFile(file, '// { example\n// "mixdog.markdown.defaultView": "rich"\n{}\n');
    await writeMarkdownDefaultView(root, 'source');
    const commented = await readFile(file, 'utf8');
    assert.ok(commented.startsWith('// { example\n// "mixdog.markdown.defaultView": "rich"\n'));
    assert.equal(await readMarkdownDefaultView(root), 'source');
    // Nested settings syntax resolves like the editor does.
    await writeFile(file, '{ "mixdog": { "markdown": { "defaultView": "rich" } } }');
    assert.equal(await readMarkdownDefaultView(root), 'rich');
    assert.equal((await readScopedEditorSettings(root, root, 'a.md')).markdownDefaultView, 'rich');
    await writeMarkdownDefaultView(root, 'source');
    assert.equal(await readMarkdownDefaultView(root), 'source');
    assert.equal((await readScopedEditorSettings(root, root, 'a.md')).markdownDefaultView, 'source');
    await writeFile(file, 'not json');
    await assert.rejects(writeMarkdownDefaultView(root, 'rich'));
    assert.equal(await readFile(file, 'utf8'), 'not json', 'an unparsable file is left alone');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('markdownDefaultView normalization: preview unless the setting names rich or source', async () => {
  const { readScopedEditorSettings } = await import('../main/workspace-config.ts');
  const root = await mkdtemp(join(tmpdir(), 'mixdog-md-view-'));
  try {
    const read = async (value) => {
      const userData = join(root, `u-${String(value)}`);
      await mkdir(join(userData, 'User'), { recursive: true });
      await writeFile(
        join(userData, 'User', 'settings.json'),
        JSON.stringify(value === undefined ? {} : { 'mixdog.markdown.defaultView': value })
      );
      return (await readScopedEditorSettings(userData, root, 'a.md')).markdownDefaultView;
    };
    assert.equal(await read(undefined), 'preview');
    assert.equal(await read('rich'), 'rich');
    assert.equal(await read('source'), 'source');
    assert.equal(await read('preview'), 'preview');
    assert.equal(await read('wysiwyg'), 'preview');
    assert.equal(await read(3), 'preview');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('outline: heading slugs, dedupe, anchor lookup, and ids assigned for #links', async () => {
  const { slugifyHeading, readHeadings, headingForAnchor } = await import('./editor-markdown-outline.tsx');
  assert.equal(slugifyHeading(' Hello, World! '), 'hello-world');
  assert.equal(slugifyHeading('한글 제목'), '한글-제목');
  const root = document.createElement('div');
  root.innerHTML = '<h1>Intro</h1><p>x</p><h2>Setup</h2><h2>Setup</h2><h3 id="given">Keep</h3><h4> </h4>';
  const headings = readHeadings(root, true);
  assert.deepEqual(
    headings.map((heading) => [heading.level, heading.id, heading.text]),
    [
      [1, 'intro', 'Intro'],
      [2, 'setup', 'Setup'],
      [2, 'setup-1', 'Setup'],
      [3, 'given', 'Keep'],
    ]
  );
  assert.equal(root.querySelector('h1').id, 'intro');
  assert.equal(headingForAnchor(headings, 'setup-1').text, 'Setup');
  assert.equal(headingForAnchor(headings, 'Intro').id, 'intro', 'case-insensitive through the slug');
  assert.equal(headingForAnchor(headings, 'missing'), null);
  const rich = document.createElement('div');
  rich.innerHTML = '<h2>Owned by the editor</h2>';
  assert.equal(readHeadings(rich, false)[0].id, 'owned-by-the-editor');
  assert.equal(rich.querySelector('h2').id, '', 'the Rich editor DOM is left untouched');
});

test('a side preview tab is flagged, pinned and never a preview tab', async () => {
  const { planSideFileOpen } = await import('./side-file-tabs.ts');
  const plan = planSideFileOpen({ files: [], active: null }, { project: 'C:/p', rel: 'a.md' }, 1, {
    preview: false,
    sidePreview: true,
    now: 5,
  });
  assert.equal(plan.files[0].sidePreview, true);
  assert.equal(plan.files[0].preview, undefined);
  const again = planSideFileOpen({ files: plan.files, active: plan.active }, { project: 'C:/p', rel: 'a.md' }, 2);
  assert.equal(again.files[0].sidePreview, true, 'activating keeps the flag');
  const { createSideFileGuard } = await import('./side-file-guard.ts');
  const opened = [];
  const guard = createSideFileGuard({
    sideFiles: () => [{ leafId: 'l', file: plan.files[0] }],
    mainTabKeys: () => new Set(),
    isDirty: () => false,
    clearDirty() {},
    confirm() {},
    dockOpenFile: (...args) => opened.push(args),
    dockCloseFile() {},
    openMainTab: (...args) => opened.push(['main', ...args]),
  });
  guard.openPreviewToSide('l', 'C:/p', 'a.md');
  assert.deepEqual(opened[0], [
    'l',
    'C:/p',
    'a.md',
    undefined,
    undefined,
    undefined,
    { preview: false, sidePreview: true },
  ]);
  guard.openFileTab('C:/p', 'a.md');
  assert.deepEqual(opened[1].slice(0, 3), ['main', 'C:/p', 'a.md'], 'a side preview never takes the file over');
});

test('useEditorViewMode: remembered mode, setting default, per-file choice, Rich fallback', async () => {
  const { useEditorViewMode } = await import('./use-editor-view-mode.ts');
  window.localStorage.clear();
  store.resetViewModeMemory();
  const model = { getValue: () => '# Title\n', onDidChangeContent: () => ({ dispose() {} }) };
  const modelRef = { current: model };
  const hook = { current: null };
  function Harness({ modeKey, defaultView = 'preview', readOnly = false, viewKind = 'markdown' }) {
    hook.current = useEditorViewMode({
      viewKind,
      modelRef,
      loadedContent: '# Title\n',
      contentRevision: 0,
      modeKey,
      markdownDefaultView: defaultView,
      readOnly,
    });
    return null;
  }
  const host = document.createElement('div');
  document.querySelector('main').append(host);
  const root = createRoot(host);
  const render = (props) => act(async () => root.render(React.createElement(Harness, props)));
  try {
    await render({ modeKey: 'C:/p/a.md' });
    assert.equal(hook.current.viewMode, 'rendered');
    await render({ modeKey: 'C:/p/a.md', defaultView: 'source' });
    assert.equal(hook.current.viewMode, 'source', 'the setting loading after mount applies until a choice is made');
    await render({ modeKey: 'C:/p/a.md', defaultView: 'preview' });
    await act(async () => hook.current.changeViewMode('rich'));
    assert.equal(hook.current.viewMode, 'rich');
    assert.equal(hook.current.richNotice, '');
    assert.equal(store.readRememberedViewMode('C:/p/a.md'), 'rich');
    // Another file starts from the setting, not from this file's choice.
    await render({ modeKey: 'C:/p/b.md', defaultView: 'source' });
    assert.equal(hook.current.viewMode, 'source');
    // A file remembered as Rich that is read-only shows Preview with the reason.
    await render({ modeKey: 'C:/p/a.md', readOnly: true });
    assert.equal(hook.current.viewMode, 'rendered');
    assert.ok(hook.current.richNotice.length > 0);
    await render({ modeKey: 'C:/p/a.md' });
    await act(async () => hook.current.reportRichUnsupported('Contains unsupported syntax'));
    assert.equal(hook.current.viewMode, 'rendered');
    assert.equal(hook.current.richNotice, 'Contains unsupported syntax');
    await act(async () => hook.current.changeViewMode('source'));
    assert.equal(hook.current.viewMode, 'source');
    assert.equal(hook.current.richNotice, '');
    assert.equal(store.readRememberedViewMode('C:/p/a.md'), 'source');
    // SVG and tables keep their own defaults and remember nothing.
    await render({ modeKey: 'C:/p/a.svg', viewKind: 'svg' });
    assert.equal(hook.current.viewMode, 'rendered');
    await act(async () => hook.current.changeViewMode('source'));
    assert.equal(store.readRememberedViewMode('C:/p/a.svg'), null);
    await render({ modeKey: 'C:/p/a.csv', viewKind: 'table', defaultView: 'rich' });
    assert.equal(hook.current.viewMode, 'source');
  } finally {
    await act(async () => root.unmount());
  }
});

test('useEditorViewMode: Preview after a Rich fallback shows the current model text, not the loaded text', async () => {
  const { useEditorViewMode } = await import('./use-editor-view-mode.ts');
  window.localStorage.clear();
  store.resetViewModeMemory();
  const listeners = new Set();
  const model = {
    value: '# Title\n',
    getValue() {
      return this.value;
    },
    onDidChangeContent(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  const modelRef = { current: model };
  const hook = { current: null };
  function Harness({ readOnly = false, defaultView = 'rich', modeKey = 'C:/p/fix.md' }) {
    hook.current = useEditorViewMode({
      viewKind: 'markdown',
      modelRef,
      loadedContent: '# Title\n',
      contentRevision: 0,
      modeKey,
      markdownDefaultView: defaultView,
      readOnly,
    });
    return null;
  }
  const host = document.createElement('div');
  document.querySelector('main').append(host);
  const root = createRoot(host);
  const render = (props = {}) => act(async () => root.render(React.createElement(Harness, props)));
  const edit = (value) =>
    act(async () => {
      model.value = value;
      for (const listener of [...listeners]) listener();
    });
  try {
    await render();
    assert.equal(hook.current.viewMode, 'rich', 'Rich opened directly');
    model.value = '# Edited in Monaco\n';
    await act(async () => hook.current.reportRichUnsupported('Nope'));
    assert.equal(hook.current.viewMode, 'rendered');
    assert.equal(hook.current.viewSnapshot, '# Edited in Monaco\n', 'current model text, not the loaded text');
    // The rejection belongs to the text it was reported for.
    await edit('# Fixed\n');
    assert.equal(hook.current.viewMode, 'rich', 'changed content invalidates the rejection');
    assert.equal(hook.current.richNotice, '');
    // An explicit click on Rich retries while the fallback is showing.
    await act(async () => hook.current.reportRichUnsupported('Still no'));
    assert.equal(hook.current.viewMode, 'rendered');
    await act(async () => hook.current.changeViewMode('rich'));
    assert.equal(hook.current.viewMode, 'rich');
    // Read-only files open in Preview even with a Source default or memory.
    window.localStorage.clear();
    store.resetViewModeMemory();
    await render({ readOnly: true, defaultView: 'source', modeKey: 'C:/p/ro.md' });
    assert.equal(hook.current.viewMode, 'rendered');
    store.rememberViewMode('C:/p/ro2.md', 'source');
    await render({ readOnly: true, defaultView: 'preview', modeKey: 'C:/p/ro2.md' });
    assert.equal(hook.current.viewMode, 'rendered');
    await act(async () => hook.current.changeViewMode('source'));
    assert.equal(hook.current.viewMode, 'source', 'a manual switch still works');
  } finally {
    await act(async () => root.unmount());
  }
});

test('outline: generated ids are regenerated after edits; authored ids are kept and reserved', async () => {
  const { readHeadings } = await import('./editor-markdown-outline.tsx');
  const root = document.createElement('div');
  root.innerHTML = '<h1>A</h1><h2>B</h2>';
  assert.deepEqual(
    readHeadings(root, true).map((heading) => heading.id),
    ['a', 'b']
  );
  root.querySelector('h2').textContent = 'A';
  const edited = readHeadings(root, true);
  assert.deepEqual(
    edited.map((heading) => heading.id),
    ['a', 'a-1']
  );
  assert.equal(root.querySelectorAll('h2')[0].id, 'a-1');
  const authored = document.createElement('div');
  authored.innerHTML = '<h1>x</h1><h2 id="x">Authored</h2>';
  assert.deepEqual(
    readHeadings(authored, true).map((heading) => heading.id),
    ['x-1', 'x']
  );
});

test('EditorViewSwitch: roving tabindex and arrow/Home/End selection', async () => {
  const { EditorViewSwitch, nextViewSwitchMode } = await import('./editor-view-switch.tsx');
  const modes = ['rendered', 'rich', 'source'];
  assert.equal(nextViewSwitchMode(modes, 'source', 'ArrowRight'), 'rendered');
  assert.equal(nextViewSwitchMode(modes, 'rendered', 'ArrowLeft'), 'source');
  assert.equal(nextViewSwitchMode(modes, 'rich', 'ArrowDown'), 'source');
  assert.equal(nextViewSwitchMode(modes, 'rich', 'ArrowUp'), 'rendered');
  assert.equal(nextViewSwitchMode(modes, 'rich', 'Home'), 'rendered');
  assert.equal(nextViewSwitchMode(modes, 'rich', 'End'), 'source');
  assert.equal(nextViewSwitchMode(modes, 'rich', 'a'), null);
  const changes = [];
  const host = document.createElement('div');
  document.querySelector('main').append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        React.createElement(EditorViewSwitch, {
          toggle: { value: 'rich', renderedLabel: 'Preview', modes, onChange: (mode) => changes.push(mode) },
        })
      )
    );
    const radios = [...host.querySelectorAll('[role="radio"]')];
    assert.deepEqual(
      radios.map((radio) => radio.tabIndex),
      [-1, 0, -1]
    );
    await act(async () => {
      radios[1].dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      );
    });
    await act(async () => {
      radios[1].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    });
    assert.deepEqual(changes, ['source', 'rendered']);
  } finally {
    await act(async () => root.unmount());
  }
});

test('suggest menu: options have ids and the editor points at the list and active option while open', async () => {
  const { RichMarkdownSuggestMenu } = await import('./rich-markdown/RichMarkdownOverlays.tsx');
  const { RICH_MARKDOWN_BLOCK_COMMANDS } = await import('./rich-markdown/rich-markdown-commands.ts');
  const items = RICH_MARKDOWN_BLOCK_COMMANDS.slice(0, 3).map((command) => ({ kind: 'command', command }));
  function Canvas({ open, selected }) {
    return React.createElement(
      'div',
      { className: 'rich-markdown-canvas' },
      React.createElement('div', { contentEditable: 'true', className: 'ProseMirror' }),
      open
        ? React.createElement(RichMarkdownSuggestMenu, {
            items,
            selected,
            point: { top: 0, left: 0 },
            onPick() {},
            onHover() {},
          })
        : null
    );
  }
  const host = document.createElement('div');
  document.querySelector('main').append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Canvas, { open: true, selected: 1 })));
    const editor = host.querySelector('.ProseMirror');
    const list = host.querySelector('[role="listbox"]');
    const options = [...host.querySelectorAll('[role="option"]')];
    assert.ok(list.id);
    assert.equal(new Set(options.map((option) => option.id)).size, 3);
    assert.equal(editor.getAttribute('aria-controls'), list.id);
    assert.equal(editor.getAttribute('aria-expanded'), 'true');
    assert.equal(editor.getAttribute('aria-activedescendant'), options[1].id);
    await act(async () => root.render(React.createElement(Canvas, { open: true, selected: 2 })));
    assert.equal(editor.getAttribute('aria-activedescendant'), options[2].id);
    await act(async () => root.render(React.createElement(Canvas, { open: false, selected: 0 })));
    for (const name of ['aria-controls', 'aria-expanded', 'aria-activedescendant']) {
      assert.equal(editor.hasAttribute(name), false, `${name} cleared when closed`);
    }
  } finally {
    await act(async () => root.unmount());
  }
});

test('slash menu heading labels use the Heading {{level}} catalog key', async () => {
  const { RICH_MARKDOWN_BLOCK_COMMANDS, filterBlockCommands } = await import(
    './rich-markdown/rich-markdown-commands.ts'
  );
  const h3 = RICH_MARKDOWN_BLOCK_COMMANDS.find((command) => command.id === 'heading3');
  assert.equal(h3.label, 'Heading {{level}}');
  assert.deepEqual(h3.labelParams, { level: 3 });
  assert.equal(filterBlockCommands('heading 3')[0].id, 'heading3');
});

test('EditorViewSwitch: arrows walk all three radios while Rich falls back to Preview', async () => {
  const { EditorViewSwitch } = await import('./editor-view-switch.tsx');
  const modes = ['rendered', 'rich', 'source'];
  const changes = [];
  const host = document.createElement('div');
  document.querySelector('main').append(host);
  const root = createRoot(host);
  try {
    // Preview stays selected: Rich was requested but falls back.
    await act(async () =>
      root.render(
        React.createElement(EditorViewSwitch, {
          toggle: { value: 'rendered', renderedLabel: 'Preview', modes, onChange: (mode) => changes.push(mode) },
        })
      )
    );
    const radios = [...host.querySelectorAll('[role="radio"]')];
    assert.deepEqual(
      radios.map((radio) => radio.getAttribute('aria-checked')),
      ['true', 'false', 'false']
    );
    assert.deepEqual(
      radios.map((radio) => radio.tabIndex),
      [0, -1, -1]
    );
    const press = (radio, key) =>
      act(async () => {
        radio.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
    await press(radios[0], 'ArrowRight');
    assert.equal(document.activeElement, radios[1]);
    await press(radios[1], 'ArrowRight');
    assert.equal(document.activeElement, radios[2]);
    assert.deepEqual(changes, ['rich', 'source']);
  } finally {
    await act(async () => root.unmount());
  }
});
