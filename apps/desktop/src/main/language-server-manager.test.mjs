import assert from 'node:assert/strict';
import test from 'node:test';
import { SERVER_BY_LANGUAGE, lspDocumentLanguageId } from './language-server-manager.ts';
import { editorLanguageIdForPath } from '../shared/editor-languages.ts';

test('every default language server is keyed by a language id the editor actually reports', () => {
  // `objective_c` (underscore) never matched Monaco's `objective-c`, so .m
  // files silently stayed without clangd.
  const reported = new Set(
    ['a.ts', 'a.js', 'a.py', 'a.go', 'a.rs', 'a.c', 'a.cpp', 'a.m', 'a.mm', 'a.rb'].map((path) =>
      editorLanguageIdForPath(path)
    )
  );
  for (const languageId of Object.keys(SERVER_BY_LANGUAGE)) {
    assert.equal(reported.has(languageId), true, `${languageId} is not a reported language id`);
  }
  assert.equal(SERVER_BY_LANGUAGE[editorLanguageIdForPath('Foo.m')]?.id, 'clangd');
  assert.equal(SERVER_BY_LANGUAGE[editorLanguageIdForPath('Foo.mm')]?.id, 'clangd');
});

test('JSX documents open on the wire as their react languages, not as plain TypeScript/JavaScript', () => {
  // Monaco reports `typescript` for .tsx; typescript-language-server reads
  // that as a plain-TS script kind and reports every JSX element as a
  // syntax error (observed: 1,500+ problems on a clean UsageStatsSurface.tsx).
  assert.equal(lspDocumentLanguageId('src/renderer/UsageStatsSurface.tsx', 'typescript'), 'typescriptreact');
  assert.equal(lspDocumentLanguageId('src\\renderer\\App.TSX', 'typescript'), 'typescriptreact');
  assert.equal(lspDocumentLanguageId('src/widget.jsx', 'javascript'), 'javascriptreact');
  assert.equal(lspDocumentLanguageId('src/main/index.ts', 'typescript'), 'typescript');
  assert.equal(lspDocumentLanguageId('src/index.js', 'javascript'), 'javascript');
  // An explicit react id or another language is passed through untouched.
  assert.equal(lspDocumentLanguageId('src/App.tsx', 'typescriptreact'), 'typescriptreact');
  assert.equal(lspDocumentLanguageId('src/App.tsx', 'plaintext'), 'plaintext');
});
