import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

test('real Monaco shares a pane surface, retains undo and view state, and releases closed documents', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const bundle = await build({
    stdin: {
      resolveDir, loader: 'tsx',
      contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { flushSync } from 'react-dom';
        import { monaco } from './monaco-setup';
        import SharedEditorSurface from './SharedEditorSurface';
        import { bindEditorCommand } from './editor-command-binding';
        const refs = new Map(['a', 'b', 'mirror'].map(id => [id, { current: null }]));
        const views = new Map();
        const bindings = new Map();
        const saves = [];
        let mounted = null;
        const changes = [];
        function Fixture() {
          const [active, setActive] = useState('a');
          const [tabs, setTabs] = useState(['a', 'b']);
          window.fixture = {
            select(id) { flushSync(() => setActive(id)); },
            split() { flushSync(() => setTabs(values => [...values, 'mirror'])); },
            focus() { mounted.focus(); },
            close(id) { flushSync(() => setTabs(values => values.filter(value => value !== id))); },
            state() {
              return {
                editors: monaco.editor.getEditors().length,
                models: monaco.editor.getModels().length,
                text: refs.get('a').current?.getValue(),
                mirrorText: refs.get('mirror').current?.getValue(),
                position: mounted?.getPosition(),
                changes, saves,
              };
            },
            edit() {
              mounted.pushUndoStop();
              mounted.executeEdits('fixture', [{ range: new monaco.Range(1, 1, 1, 1), text: 'unsaved ' }]);
              mounted.pushUndoStop();
              mounted.setPosition({ lineNumber: 1, column: 5 });
            },
            undo() { mounted.trigger('fixture', 'undo', null); },
          };
          return tabs.map(id => <div key={id} style={{ height: 300, width: 600, display: active === id || id === 'mirror' ? 'block' : 'none' }}>
            <SharedEditorSurface
              surfaceKey={id === 'mirror' ? 'right' : 'pane'}
              active={active === id || id === 'mirror'} path={'file:///' + (id === 'mirror' ? 'a' : id) + '.txt'}
              modelRef={refs.get(id)} defaultValue={'saved ' + id} defaultLanguage="plaintext"
              theme="vs-dark" options={{ automaticLayout: false, minimap: { enabled: false } }}
              onMount={editor => {
                mounted = editor;
                changes.push(editor.getId());
                bindings.set(id, bindEditorCommand(editor, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saves.push(id)));
                if (views.has(id)) editor.restoreViewState(views.get(id));
                editor.layout({ width: 600, height: 300 });
              }}
              onRelease={editor => {
                views.set(id, editor.saveViewState());
                bindings.get(id)?.dispose();
                mounted = null;
              }}
            />
          </div>);
        }
        flushSync(() => createRoot(document.getElementById('root')).render(<Fixture />));
      `,
    },
    bundle: true, jsx: 'automatic', write: false, format: 'iife',
    outfile: 'fixture.js', loader: { '.ttf': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'isolated-monaco',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/monaco-setup$/ }, () => ({ path: 'monaco', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: 'export * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";',
          resolveDir, loader: 'js',
        }));
      },
    }],
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const saveShortcut = async () => {
    await page.keyboard.down('Control');
    try {
      await page.keyboard.press('s');
    } finally {
      await page.keyboard.up('Control');
    }
  };
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setContent('<html><body><div id="root"></div></body></html>');
  for (const file of bundle.outputFiles) {
    if (file.path.endsWith('.css')) await page.addStyleTag({ content: file.text });
  }
  await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
  await page.waitForFunction(() => window.fixture?.state().editors === 1);
  assert.equal(await page.evaluate(() => window.fixture.state().models), 1, 'unvisited tabs do not create models');
  await page.evaluate(() => window.fixture.focus());
  await saveShortcut();
  await page.evaluate(() => { window.fixture.edit(); window.fixture.select('b'); });
  assert.equal(await page.evaluate(() => window.fixture.state().editors), 1);
  await page.evaluate(() => window.fixture.focus());
  await saveShortcut();
  await page.evaluate(() => window.fixture.select('a'));
  await page.evaluate(() => window.fixture.focus());
  await saveShortcut();
  let state = await page.evaluate(() => window.fixture.state());
  assert.equal(state.text, 'unsaved saved a');
  assert.equal(state.position.column, 5);
  assert.equal(new Set(state.changes).size, 1, 'tab switches reuse the same visual editor');
  assert.deepEqual(state.saves, ['a', 'b', 'a']);
  await page.evaluate(() => window.fixture.undo());
  await page.waitForFunction(() => window.fixture.state().text === 'saved a');
  await page.evaluate(() => window.fixture.select(null));
  await page.waitForFunction(() => window.fixture.state().editors === 0);
  assert.equal(await page.evaluate(() => window.fixture.state().models), 2);
  await page.evaluate(() => window.fixture.select('a'));
  await page.waitForFunction(() => window.fixture.state().editors === 1);
  assert.equal(await page.evaluate(() => window.fixture.state().text), 'saved a');
  await page.evaluate(() => window.fixture.split());
  assert.equal(await page.evaluate(() => window.fixture.state().editors), 2);
  assert.equal(await page.evaluate(() => window.fixture.state().models), 2);
  await page.evaluate(() => { window.fixture.close('a'); window.fixture.close('b'); });
  await page.waitForFunction(() => window.fixture.state().editors === 1);
  assert.equal(await page.evaluate(() => window.fixture.state().mirrorText), 'saved a');
  assert.equal(await page.evaluate(() => window.fixture.state().models), 1);
  await page.evaluate(() => window.fixture.close('mirror'));
  await page.waitForFunction(() => window.fixture.state().editors === 0 && window.fixture.state().models === 0);
  assert.deepEqual(errors, []);
});
