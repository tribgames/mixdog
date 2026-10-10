import assert from 'node:assert/strict';
import test from 'node:test';

// No desktop bridge: the store must learn the server state from the editor.
globalThis.window = {};
const {
  acceptEditorLspState,
  acquireEditorDocument,
  getEditorCommandCapabilities,
  getEditorLanguageSnapshot,
  releaseEditorDocument,
  setActiveEditorDocument,
  setEditorOutline,
  setNativeEditorProblems,
  subscribeEditorLanguageStore,
} = await import('./editor-language-store.ts');

test('closed documents leave no statuses or native problems; shared documents survive one release', () => {
  const project = 'C:\\leak';
  const marker = { severity: 8, message: 'm', startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 };
  const state = { available: true, status: 'ready', server: 's', capabilities: {} };
  const baseline = getEditorLanguageSnapshot().statuses.length;
  for (let index = 0; index < 200; index += 1) {
    const rel = `src/f${index}.ts`;
    const uri = `file:///leak/${rel}`;
    acquireEditorDocument(project, rel, uri);
    acceptEditorLspState(project, rel, 'typescript', state);
    setNativeEditorProblems(project, rel, uri, [marker]);
    setEditorOutline(uri, [
      {
        key: 'k',
        projectPath: project,
        relPath: rel,
        uri,
        name: 'n',
        detail: '',
        kind: 'f',
        line: 1,
        column: 1,
        level: 0,
      },
    ]);
    releaseEditorDocument(uri);
  }
  const closed = getEditorLanguageSnapshot();
  assert.equal(closed.statuses.length, baseline);
  assert.equal(closed.problems.filter((problem) => problem.projectPath === project).length, 0);

  const rel = 'src/shared.ts';
  const uri = 'file:///leak/src/shared.ts';
  acquireEditorDocument(project, rel, uri);
  acquireEditorDocument(project, rel, uri);
  acceptEditorLspState(project, rel, 'typescript', state);
  setNativeEditorProblems(project, rel, uri, [marker]);
  releaseEditorDocument(uri);
  const held = getEditorLanguageSnapshot();
  assert.equal(held.statuses.length, baseline + 1);
  assert.equal(held.problems.filter((problem) => problem.uri === uri).length, 1);
  releaseEditorDocument(uri);
  const done = getEditorLanguageSnapshot();
  assert.equal(done.statuses.length, baseline);
  assert.equal(done.problems.filter((problem) => problem.uri === uri).length, 0);
});

test("a document's own LSP answer enables palette commands without a status broadcast", () => {
  let notified = 0;
  const unsubscribe = subscribeEditorLanguageStore(() => {
    notified += 1;
  });
  setActiveEditorDocument({
    projectPath: 'C:\\demo',
    relPath: 'src/a.ts',
    uri: 'file:///c%3A/demo/src/a.ts',
    languageId: 'typescript',
  });
  assert.equal(getEditorCommandCapabilities().definition, false);

  const state = {
    available: true,
    status: 'ready',
    server: 'TypeScript Language Server',
    capabilities: { definition: true, references: true, rename: true, formatting: true },
  };
  acceptEditorLspState('C:\\demo', 'src\\a.ts', 'typescript', state);
  assert.equal(getEditorCommandCapabilities().definition, true);
  assert.equal(getEditorCommandCapabilities().formatting, true);

  // Every sync repeats the answer; an unchanged state publishes nothing.
  const published = notified;
  acceptEditorLspState('C:\\demo', 'src/a.ts', 'typescript', { ...state, capabilities: { ...state.capabilities } });
  assert.equal(notified, published);

  acceptEditorLspState('C:\\demo', 'src/a.ts', 'typescript', { ...state, available: false, status: 'stopped' });
  assert.equal(getEditorCommandCapabilities().definition, false);
  unsubscribe();
});
