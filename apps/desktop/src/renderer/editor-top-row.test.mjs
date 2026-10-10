import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import React from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  globals: { navigator: { userAgent: 'Electron/41.0' } },
});
after(restore);
// Breadcrumbs do not need Monaco's browser-only providers (same isolation as editor-external-opening).
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === './editor-monaco-providers' ||
      specifier === './monaco-setup' ||
      specifier === './lazy-widgets' ||
      specifier.endsWith('.css')
    ) {
      return next(new URL('./test-fixtures/editor-opening-deps.mjs', import.meta.url).href, context);
    }
    return next(specifier, context);
  },
});
after(() => hooks.deregister());

test('main tab: breadcrumbs + Save (dirty only) + ⋯ on top; toggle/status/problems moved to the shared footer', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');
  const editor = await read('./EditorPane.lazy.tsx');
  assert.doesNotMatch(editor, /<footer|editor-statusbar|editorStatusBar/);
  assert.doesNotMatch(await read('./desktop/26-editor.css'), /\.editor-statusbar/);
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { EditorBreadcrumbs } = await import('./editor-breadcrumbs.tsx');
  const base = {
    projectPath: '/p',
    relPath: 'src/a.ts',
    preview: null,
    saving: false,
    reverting: false,
    cursorLine: 2,
    outline: [],
    onSave() {},
    onRevert() {},
    onOpenAt() {},
    onFocusEditor() {},
    onRevealSymbol() {},
    load: { content: '', binary: false, tooLarge: false, readOnly: false },
  };
  const dirty = renderToStaticMarkup(React.createElement(EditorBreadcrumbs, { ...base, dirty: true }));
  assert.ok(dirty.includes('aria-label="Save"'));
  assert.ok(dirty.includes('dock-header-more'));
  assert.ok(dirty.indexOf('aria-label="Save"') < dirty.indexOf('dock-header-more'));
  for (const gone of [
    'editor-view-toggle',
    'editor-status-position',
    'editor-status-language',
    'editor-problems-action',
    'Reveal in Explorer"',
  ])
    assert.equal(dirty.includes(gone), false, gone);
  const clean = renderToStaticMarkup(React.createElement(EditorBreadcrumbs, { ...base, dirty: false }));
  assert.equal(clean.includes('aria-label="Save"'), false, 'Save only while dirty');
  // The removed controls' CSS is gone too.
  const css = await read('./desktop/26-editor.css');
  assert.doesNotMatch(
    css,
    /\.editor-view-toggle|\.editor-status-position|\.editor-status-language|\.editor-problems-action/
  );
  assert.match(css, /\.editor-problems-count b \{[^}]*min-width: 2ch;[^}]*tabular-nums/);
  // The main footer is the SHARED component, fed by the same chrome, last row, text editors only.
  assert.match(editor, /import \{ SideFileStatusRow, sideFileHasFooter \} from '\.\/side-file-status-row'/);
  assert.match(editor, /const mainFooter = !onSideChrome && active && sideFileHasFooter\(fileChrome\)/);
  assert.match(editor, /createPortal\(footer, footerSlot\)/);
  const workspace = await read('./PaneWorkspace.tsx');
  assert.ok(workspace.indexOf('renderProblems?.(leaf, focused)') < workspace.indexOf('pane-footer-slot'));
  assert.ok(workspace.indexOf('pane-footer-slot') < workspace.indexOf('renderSideDock?.(leaf, focused)'));
  const { SideFileStatusRow, sideFileHasFooter } = await import('./side-file-status-row.tsx');
  const chrome = {
    editable: true,
    dirty: false,
    saving: false,
    viewToggle: { value: 'source', renderedLabel: 'Preview', onChange() {} },
    problems: { errors: 3, warnings: 1, onToggle() {} },
    cursor: { label: 'Ln 2, Col 1', short: '2:1', onGoto() {} },
    language: 'TypeScript',
  };
  const footer = renderToStaticMarkup(React.createElement(SideFileStatusRow, { chrome }));
  for (const part of [
    'side-file-view-toggle',
    'side-file-status-problems',
    '>3<',
    '>2:1<',
    'TypeScript',
    'aria-label="Go to Line/Column"',
  ])
    assert.ok(footer.includes(part), part);
  assert.equal(
    sideFileHasFooter({ editable: false, dirty: false, saving: false }),
    false,
    'previews and binaries have no footer'
  );
  assert.equal(sideFileHasFooter(chrome), true);
  const cell = await read('./pane-layout.css');
  assert.match(cell, /\.pane-cell > \.pane-footer-slot:empty \{\s*display: none;/);
});

test('main ⋯ menu holds Reveal, Revert (dirty) and the extra actions; previews add Open in default app', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { EditorBreadcrumbs } = await import('./editor-breadcrumbs.tsx');
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const picks = [];
  window.mixdogDesktop = { revealFile: async (...args) => picks.push(['reveal', ...args]) };
  await act(async () =>
    root.render(
      React.createElement(EditorBreadcrumbs, {
        projectPath: '/p',
        relPath: 'src/a.ts',
        preview: null,
        dirty: true,
        saving: false,
        reverting: false,
        cursorLine: 1,
        outline: [],
        load: { content: '', binary: false, tooLarge: false, readOnly: false },
        menuActions: [{ id: 'format', label: 'Format Document', onSelect: () => picks.push('format') }],
        onSave() {},
        onRevert: () => picks.push('revert'),
        onOpenAt() {},
        onFocusEditor() {},
        onRevealSymbol() {},
      })
    )
  );
  await act(async () => host.querySelector('.dock-header-more').click());
  // The ⋯ menu is portalled to the document body.
  const menuItems = () => [...host.ownerDocument.querySelectorAll('.dock-header-menu [role="menuitem"]')];
  const items = menuItems().map((node) => node.textContent);
  assert.deepEqual(items, ['Reveal in Explorer', 'Revert File', 'Format Document']);
  await act(async () => menuItems()[2].click());
  assert.deepEqual(picks, ['format']);
  await act(async () => root.unmount());
  host.remove();
  const none = renderToStaticMarkup(
    React.createElement(EditorBreadcrumbs, {
      projectPath: '/p',
      relPath: 'a.ts',
      load: null,
      preview: null,
      dirty: false,
      saving: false,
      reverting: false,
      cursorLine: 1,
      outline: [],
      onSave() {},
      onRevert() {},
      onOpenAt() {},
      onFocusEditor() {},
      onRevealSymbol() {},
    })
  );
  assert.ok(none.includes('dock-header-more'));
});
