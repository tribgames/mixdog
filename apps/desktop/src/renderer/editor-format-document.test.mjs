import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { documentFormatterAvailable, runFormatDocument } from './editor-format-document.ts';

const UNFORMATTED = 'export   function  f( a:number ){return a+1}';

/** Editor double that mirrors Monaco: `run()` resolves silently when the
 *  precondition fails, and applied edits bump the model version. */
function editorDouble({ supported = true, edits = null } = {}) {
  let text = UNFORMATTED;
  let version = 1;
  return {
    text: () => text,
    getModel: () => ({ getVersionId: () => version }),
    getAction: () => ({
      isSupported: () => supported,
      run: async () => {
        if (!supported || edits === null) return;
        text = edits;
        version += 1;
      },
    }),
  };
}

test('Format is offered only when capability and an installed provider both exist', () => {
  assert.equal(documentFormatterAvailable({ formatting: true }, true), true);
  // Stale ref: capabilities say yes but no provider was installed for the language.
  assert.equal(documentFormatterAvailable({ formatting: true }, false), false);
  // Provider claimed earlier, current file's server lacks formatting.
  assert.equal(documentFormatterAvailable({ formatting: false }, true), false);
  assert.equal(documentFormatterAvailable(null, true), false);
});

test('an unformatted file is formatted through the editor action', async () => {
  const editor = editorDouble({ edits: 'export function f(a: number) {\n  return a + 1;\n}\n' });
  assert.equal(await runFormatDocument(editor), 'formatted');
  assert.match(editor.text(), /return a \+ 1;/);
});

test('a formatter that returns no edits is reported as already formatted', async () => {
  assert.equal(await runFormatDocument(editorDouble({ edits: null })), 'unchanged');
});

test('an unsupported action (no provider / read-only) is reported, not silently ignored', async () => {
  assert.equal(await runFormatDocument(editorDouble({ supported: false })), 'unavailable');
  assert.equal(
    await runFormatDocument({ getAction: () => null, getModel: () => ({ getVersionId: () => 1 }) }),
    'unavailable'
  );
});

test('the pane gates Format on the provider claim, reruns on claim changes and toasts the outcome', () => {
  const pane = readFileSync(new URL('./EditorPane.lazy.tsx', import.meta.url), 'utf8');
  const session = readFileSync(new URL('./use-editor-lsp-session.ts', import.meta.url), 'utf8');
  assert.match(pane, /hasLspProviderFeature\(editorFormat\.languageId, 'formatting'\)/);
  const sideChrome = readFileSync(new URL('./use-editor-side-chrome.ts', import.meta.url), 'utf8');
  assert.match(sideChrome, /formattingAvailable && sideEditable \? formatDocument/);
  assert.match(pane, /Document is already formatted\./);
  assert.match(
    session,
    /documentFormatterAvailable\(state\.capabilities, hasLspProviderFeature\(languageId, 'formatting'\)\)/
  );
});
