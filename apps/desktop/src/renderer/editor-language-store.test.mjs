import assert from 'node:assert/strict';
import test from 'node:test';

// No desktop bridge: the store must learn the server state from the editor.
globalThis.window = {};
const {
  acceptEditorLspState,
  acquireEditorDocument,
  bindEditorModelLanguageStore,
  getEditorCommandCapabilities,
  getEditorLanguageSnapshot,
  isLspMarkerOwner,
  lspMarkerOwner,
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

test('a released document and a stopped server leave no LSP diagnostics', () => {
  let diagnostics;
  let status;
  globalThis.window.mixdogDesktop = {
    subscribeLspDiagnostics: (listener) => {
      diagnostics = listener;
      return () => {};
    },
    subscribeLspStatus: (listener) => {
      status = listener;
      return () => {};
    },
  };
  const project = 'C:\\lsp';
  const report = (uri, server, relPath = uri) =>
    diagnostics({
      projectPath: project,
      relPath,
      uri,
      server,
      diagnostics: [{ message: 'm', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
    });
  const held = (uri) => getEditorLanguageSnapshot().problems.filter((problem) => problem.uri === uri).length;
  getEditorLanguageSnapshot();
  acquireEditorDocument(project, 'src\\a.ts', 'C:%5C%5Clsp%5Csrc%5Ca.ts');
  report('file:///lsp/a.ts', 'ts', 'src/a.ts');
  assert.equal(held('file:///lsp/a.ts'), 1);
  releaseEditorDocument('C:%5C%5Clsp%5Csrc%5Ca.ts');
  assert.equal(held('file:///lsp/a.ts'), 0);

  report('file:///lsp/b.ts', 'ts');
  report('file:///lsp/c.ts', 'other');
  status({ projectPath: project, languageId: 'typescript', available: false, status: 'stopped', server: 'ts' });
  assert.equal(held('file:///lsp/b.ts'), 0);
  assert.equal(held('file:///lsp/c.ts'), 1);
});

test('case-sensitive POSIX paths keep Foo.rs and foo.rs status and diagnostics distinct while Windows paths fold case', () => {
  let diagnostics;
  globalThis.window.mixdogDesktop = {
    subscribeLspDiagnostics: (listener) => {
      diagnostics = listener;
      return () => {};
    },
    subscribeLspStatus: () => () => {},
  };
  getEditorLanguageSnapshot();

  const linuxProj = '/linux-case';
  const upperUri = 'file:///linux-case/src/Foo.rs';
  const lowerUri = 'file:///linux-case/src/foo.rs';
  acquireEditorDocument(linuxProj, 'src/Foo.rs', upperUri);
  acquireEditorDocument(linuxProj, 'src/foo.rs', lowerUri);
  acceptEditorLspState(linuxProj, 'src/Foo.rs', 'rust', {
    available: true,
    status: 'ready',
    server: 'rust-analyzer',
    capabilities: { definition: true },
  });
  acceptEditorLspState(linuxProj, 'src/foo.rs', 'rust', {
    available: true,
    status: 'ready',
    server: 'rust-analyzer',
    capabilities: { definition: false, formatting: true },
  });
  diagnostics({
    projectPath: linuxProj,
    relPath: 'src/Foo.rs',
    uri: upperUri,
    server: 'rust-analyzer',
    diagnostics: [{ message: 'upper', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
  });
  diagnostics({
    projectPath: linuxProj,
    relPath: 'src/foo.rs',
    uri: lowerUri,
    server: 'rust-analyzer',
    diagnostics: [{ message: 'lower', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
  });

  const before = getEditorLanguageSnapshot();
  assert.equal(before.statuses.filter((s) => s.projectPath === linuxProj).length, 2);
  assert.equal(before.problems.filter((p) => p.projectPath === linuxProj).length, 2);

  releaseEditorDocument(upperUri);
  const after = getEditorLanguageSnapshot();
  assert.deepEqual(
    after.statuses.filter((s) => s.projectPath === linuxProj).map((s) => s.relPath),
    ['src/foo.rs']
  );
  assert.deepEqual(
    after.problems.filter((p) => p.projectPath === linuxProj).map((p) => p.uri),
    [lowerUri]
  );
  setActiveEditorDocument({ projectPath: linuxProj, relPath: 'src/foo.rs', uri: lowerUri, languageId: 'rust' });
  assert.equal(getEditorCommandCapabilities().formatting, true);
  assert.equal(getEditorCommandCapabilities().definition, false);
  releaseEditorDocument(lowerUri);

  // Windows paths remain case-insensitive.
  const winProj = 'C:\\win-case';
  const winUri = 'file:///c%3A/win-case/src/Foo.rs';
  acquireEditorDocument(winProj, 'src\\Foo.rs', winUri);
  acceptEditorLspState(winProj, 'src/foo.rs', 'rust', {
    available: true,
    status: 'ready',
    server: 'rust-analyzer',
    capabilities: { definition: true },
  });
  setActiveEditorDocument({ projectPath: winProj, relPath: 'src/Foo.rs', uri: winUri, languageId: 'rust' });
  assert.equal(getEditorCommandCapabilities().definition, true);
  releaseEditorDocument(winUri);
  assert.equal(getEditorLanguageSnapshot().statuses.filter((s) => s.projectPath === winProj).length, 0);
});

test('empty LSP diagnostic clear removes stale problems without redundant publishes', () => {
  let diagnostics;
  globalThis.window.mixdogDesktop = {
    subscribeLspDiagnostics: (listener) => {
      diagnostics = listener;
      return () => {};
    },
    subscribeLspStatus: () => () => {},
  };
  let notified = 0;
  const unsubscribe = subscribeEditorLanguageStore(() => {
    notified += 1;
  });
  const project = '/clear-diag';
  const uri = 'file:///clear-diag/src/a.rs';
  diagnostics({
    projectPath: project,
    relPath: 'src/a.rs',
    uri,
    server: 'rust-analyzer',
    diagnostics: [{ message: 'stale', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
  });
  assert.equal(getEditorLanguageSnapshot().problems.filter((p) => p.uri === uri).length, 1);

  const beforeClear = notified;
  diagnostics({ projectPath: project, relPath: 'src/a.rs', uri, server: 'rust-analyzer', diagnostics: [] });
  assert.equal(getEditorLanguageSnapshot().problems.filter((p) => p.uri === uri).length, 0);
  assert.equal(notified, beforeClear + 1);

  diagnostics({ projectPath: project, relPath: 'src/a.rs', uri, server: 'rust-analyzer', diagnostics: [] });
  assert.equal(notified, beforeClear + 1, 'clearing an already-empty URI does not republish');
  unsubscribe();
});

test('POSIX paths stay case-sensitive regardless of renderer OS and forward-slash UNC paths fold case', () => {
  let diagnostics;
  const previousHost = globalThis.window.mixdogDesktopHost;
  globalThis.window.mixdogDesktopHost = { platform: 'darwin' };
  globalThis.window.mixdogDesktop = {
    subscribeLspDiagnostics: (listener) => {
      diagnostics = listener;
      return () => {};
    },
    subscribeLspStatus: () => () => {},
  };
  try {
    getEditorLanguageSnapshot();

    // Even when renderer OS reports macOS (darwin), POSIX /repo/src/Foo.rs and /repo/src/foo.rs stay distinct.
    const posixProj = '/repo';
    const upperUri = 'file:///repo/src/Foo.rs';
    const lowerUri = 'file:///repo/src/foo.rs';
    acquireEditorDocument(posixProj, 'src/Foo.rs', upperUri);
    acquireEditorDocument(posixProj, 'src/foo.rs', lowerUri);
    diagnostics({
      projectPath: posixProj,
      relPath: 'src/Foo.rs',
      uri: upperUri,
      server: 'rust-analyzer',
      diagnostics: [{ message: 'upper', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
    });
    diagnostics({
      projectPath: posixProj,
      relPath: 'src/foo.rs',
      uri: lowerUri,
      server: 'rust-analyzer',
      diagnostics: [{ message: 'lower', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
    });

    releaseEditorDocument(upperUri);
    assert.deepEqual(
      getEditorLanguageSnapshot()
        .problems.filter((p) => p.projectPath === posixProj)
        .map((p) => p.uri),
      [lowerUri],
      'closing /repo/src/Foo.rs must not clear /repo/src/foo.rs Problems'
    );
    releaseEditorDocument(lowerUri);

    // Forward-slash UNC paths (//server/share/Foo vs //server/share/foo) fold case like Windows paths.
    const uncUpper = '//server/share/Foo';
    const uncLower = '//server/share/foo';
    const uncUri = 'file://server/share/Foo/src/Main.rs';
    acquireEditorDocument(uncUpper, 'src/Main.rs', uncUri);
    acceptEditorLspState(uncLower, 'src/main.rs', 'rust', {
      available: true,
      status: 'ready',
      server: 'rust-analyzer',
      capabilities: { definition: true },
    });
    diagnostics({
      projectPath: uncLower,
      relPath: 'src/main.rs',
      uri: uncUri,
      server: 'rust-analyzer',
      diagnostics: [
        { message: 'unc err', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
      ],
    });
    setActiveEditorDocument({ projectPath: uncUpper, relPath: 'src/Main.rs', uri: uncUri, languageId: 'rust' });
    assert.equal(getEditorCommandCapabilities().definition, true);
    assert.equal(getEditorLanguageSnapshot().problems.filter((p) => p.uri === uncUri).length, 1);

    releaseEditorDocument(uncUri);
    assert.equal(getEditorLanguageSnapshot().problems.filter((p) => p.uri === uncUri).length, 0);
    assert.equal(
      getEditorLanguageSnapshot().statuses.filter((s) => s.projectPath.toLowerCase() === uncLower).length,
      0
    );
  } finally {
    if (previousHost === undefined) delete globalThis.window.mixdogDesktopHost;
    else globalThis.window.mixdogDesktopHost = previousHost;
  }
});

test('unchanged non-empty LSP diagnostics do not trigger redundant store publishes', () => {
  let diagnostics;
  globalThis.window.mixdogDesktop = {
    subscribeLspDiagnostics: (listener) => {
      diagnostics = listener;
      return () => {};
    },
    subscribeLspStatus: () => () => {},
  };
  let notified = 0;
  const unsubscribe = subscribeEditorLanguageStore(() => {
    notified += 1;
  });

  const project = '/dedupe-diag';
  const uri = 'file:///dedupe-diag/src/lib.rs';
  const payload = () => ({
    projectPath: project,
    relPath: 'src/lib.rs',
    uri,
    server: 'rust-analyzer',
    diagnostics: [
      {
        message: 'unused var',
        severity: 2,
        code: 'W001',
        source: 'rustc',
        range: { start: { line: 3, character: 4 }, end: { line: 3, character: 9 } },
      },
    ],
  });

  const startCount = notified;
  diagnostics(payload());
  assert.equal(notified, startCount + 1);

  // Snapshot replay delivering the exact same diagnostics must not republish.
  diagnostics(payload());
  assert.equal(notified, startCount + 1, 'identical non-empty diagnostics must not trigger a redundant publish');

  // Changing diagnostic content does publish.
  const updated = payload();
  updated.diagnostics[0].message = 'updated error';
  diagnostics(updated);
  assert.equal(notified, startCount + 2);

  diagnostics({ projectPath: project, relPath: 'src/lib.rs', uri, server: 'rust-analyzer', diagnostics: [] });
  unsubscribe();
});

test('dropping a nested project feed does not clear parent project diagnostics in either publish order', () => {
  let diagnostics;
  globalThis.window.mixdogDesktop = {
    subscribeLspDiagnostics: (listener) => {
      diagnostics = listener;
      return () => {};
    },
    subscribeLspStatus: () => () => {},
  };
  getEditorLanguageSnapshot();

  const parent = '/monorepo';
  const nested = '/monorepo/packages/app';
  const sharedUri = 'file:///monorepo/packages/app/src/index.ts';
  const emitParent = (message) =>
    diagnostics({
      projectPath: parent,
      relPath: 'packages/app/src/index.ts',
      uri: sharedUri,
      server: 'ts',
      diagnostics: message
        ? [{ message, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } }]
        : [],
    });
  const emitNested = (message) =>
    diagnostics({
      projectPath: nested,
      relPath: 'src/index.ts',
      uri: sharedUri,
      server: 'ts',
      diagnostics: message
        ? [{ message, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
        : [],
    });

  // (a) parent publishes -> nested publishes -> nested drops -> parent's diagnostics remain visible.
  emitParent('parent err A');
  emitNested('nested err A');
  emitNested(null);
  const afterOrderA = getEditorLanguageSnapshot().problems.filter((p) => p.uri === sharedUri);
  assert.equal(afterOrderA.length, 1);
  assert.equal(afterOrderA[0].projectPath, parent);
  assert.equal(afterOrderA[0].message, 'parent err A');
  emitParent(null);
  assert.equal(getEditorLanguageSnapshot().problems.filter((p) => p.uri === sharedUri).length, 0);

  // (b) nested publishes -> parent publishes -> nested drops -> parent's diagnostics remain visible.
  emitNested('nested err B');
  emitParent('parent err B');
  emitNested(null);
  const afterOrderB = getEditorLanguageSnapshot().problems.filter((p) => p.uri === sharedUri);
  assert.equal(afterOrderB.length, 1);
  assert.equal(afterOrderB[0].projectPath, parent);
  assert.equal(afterOrderB[0].message, 'parent err B');

  // Releasing a nested document handle only clears the nested project's diagnostics, not the parent's.
  emitNested('nested err C');
  acquireEditorDocument(nested, 'src/index.ts', 'nested-doc-uri');
  releaseEditorDocument('nested-doc-uri');
  const afterNestedRelease = getEditorLanguageSnapshot().problems.filter((p) => p.uri === sharedUri);
  assert.equal(afterNestedRelease.length, 1);
  assert.equal(afterNestedRelease[0].projectPath, parent);

  emitParent(null);
  assert.equal(getEditorLanguageSnapshot().problems.filter((p) => p.uri === sharedUri).length, 0);
});

test('split panes sharing one model URI across parent and nested projects release each project independently', () => {
  let diagnostics;
  globalThis.window.mixdogDesktop = {
    subscribeLspDiagnostics: (listener) => {
      diagnostics = listener;
      return () => {};
    },
    subscribeLspStatus: () => () => {},
  };
  getEditorLanguageSnapshot();

  const parent = '/split-monorepo';
  const nested = '/split-monorepo/packages/app';
  const parentRel = 'packages/app/src/shared.ts';
  const nestedRel = 'src/shared.ts';
  const sharedUri = 'file:///split-monorepo/packages/app/src/shared.ts';

  acquireEditorDocument(parent, parentRel, sharedUri);
  acquireEditorDocument(nested, nestedRel, sharedUri);

  acceptEditorLspState(parent, parentRel, 'typescript', {
    available: true,
    status: 'ready',
    server: 'ts',
    capabilities: { definition: true },
  });
  acceptEditorLspState(nested, nestedRel, 'typescript', {
    available: true,
    status: 'ready',
    server: 'ts',
    capabilities: { definition: true, formatting: true },
  });
  diagnostics({
    projectPath: parent,
    relPath: parentRel,
    uri: sharedUri,
    server: 'ts',
    diagnostics: [
      { message: 'parent diag', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    ],
  });
  diagnostics({
    projectPath: nested,
    relPath: nestedRel,
    uri: sharedUri,
    server: 'ts',
    diagnostics: [
      { message: 'nested diag', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } },
    ],
  });

  // Closing the nested pane first cleans up nested's status and diagnostics while keeping parent's intact.
  releaseEditorDocument(sharedUri, nested);
  const afterNested = getEditorLanguageSnapshot();
  assert.deepEqual(
    afterNested.problems.filter((p) => p.uri === sharedUri).map((p) => [p.projectPath, p.message]),
    [[parent, 'parent diag']],
    'releasing nested handle clears nested diagnostics and preserves parent diagnostics'
  );
  assert.deepEqual(
    afterNested.statuses
      .filter((s) => s.projectPath === parent || s.projectPath === nested)
      .map((s) => [s.projectPath, s.relPath]),
    [[parent, parentRel]],
    'releasing nested handle clears nested status and preserves parent status'
  );

  // Closing the parent pane cleans up the remaining status and diagnostics completely.
  releaseEditorDocument(sharedUri, parent);
  const afterParent = getEditorLanguageSnapshot();
  assert.equal(afterParent.problems.filter((p) => p.uri === sharedUri).length, 0);
  assert.equal(afterParent.statuses.filter((s) => s.projectPath === parent || s.projectPath === nested).length, 0);
});

test('split-pane model binding teardown preserves parent markers and does not recreate closed document status', () => {
  let diagnostics;
  let status;
  globalThis.window.mixdogDesktop = {
    subscribeLspDiagnostics: (listener) => {
      diagnostics = listener;
      return () => {};
    },
    subscribeLspStatus: (listener) => {
      status = listener;
      return () => {};
    },
  };
  getEditorLanguageSnapshot();

  const parent = '/bind-monorepo';
  const nested = '/bind-monorepo/packages/app';
  const parentRel = 'packages/app/src/shared.ts';
  const nestedRel = 'src/shared.ts';
  const sharedUri = 'file:///bind-monorepo/packages/app/src/shared.ts';
  const parentOwner = lspMarkerOwner(parent);
  const nestedOwner = lspMarkerOwner(nested);
  assert.equal(isLspMarkerOwner('mixdog-lsp'), true);
  assert.equal(isLspMarkerOwner(parentOwner), true);
  assert.equal(isLspMarkerOwner(nestedOwner), true);
  assert.equal(isLspMarkerOwner('typescript'), false);
  assert.notEqual(parentOwner, nestedOwner);

  // Publish project-wide ready statuses (no relPath) for both parent and nested projects.
  status({
    projectPath: parent,
    languageId: 'typescript',
    available: true,
    status: 'ready',
    server: 'ts',
    capabilities: { definition: true },
  });
  status({
    projectPath: nested,
    languageId: 'typescript',
    available: true,
    status: 'ready',
    server: 'ts',
    capabilities: { definition: true },
  });

  // Simulated shared Monaco model marker map keyed by marker owner.
  const markersByOwner = new Map();
  const bindPane = (projectPath, relPath) =>
    bindEditorModelLanguageStore({
      projectPath,
      relPath,
      uri: sharedUri,
      getLanguageId: () => 'typescript',
      isDisposed: () => false,
      acceptLspState: (state, languageId) => acceptEditorLspState(projectPath, relPath, languageId, state),
      lspMarkerSignature: { current: '' },
      setMarkers: (owner, problems) => markersByOwner.set(owner, problems),
    });

  const parentPane1 = bindPane(parent, parentRel);
  const parentPane2 = bindPane(parent, parentRel);
  const nestedPane = bindPane(nested, nestedRel);

  diagnostics({
    projectPath: parent,
    relPath: parentRel,
    uri: sharedUri,
    server: 'ts',
    diagnostics: [
      { message: 'parent err', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    ],
  });
  diagnostics({
    projectPath: nested,
    relPath: nestedRel,
    uri: sharedUri,
    server: 'ts',
    diagnostics: [
      { message: 'nested err', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } } },
    ],
  });

  assert.deepEqual(
    markersByOwner.get(parentOwner)?.map((m) => m.message),
    ['parent err']
  );
  assert.deepEqual(
    markersByOwner.get(nestedOwner)?.map((m) => m.message),
    ['nested err']
  );

  // Disposing the nested pane must NOT recreate nested document status from project-wide ready status,
  // and must clear ONLY nested markers while preserving parent markers.
  nestedPane.dispose();
  assert.deepEqual(markersByOwner.get(nestedOwner), [], 'closing nested pane clears nested marker owner');
  assert.deepEqual(
    markersByOwner.get(parentOwner)?.map((m) => m.message),
    ['parent err'],
    'closing nested pane preserves parent inline markers'
  );
  assert.equal(
    getEditorLanguageSnapshot().statuses.some((s) => s.projectPath === nested && s.relPath === nestedRel),
    false,
    'closing nested pane must not recreate document status via project-wide fallback'
  );

  // Disposing one of two split panes in the same parent project keeps parent markers and status alive.
  parentPane2.dispose();
  assert.deepEqual(
    markersByOwner.get(parentOwner)?.map((m) => m.message),
    ['parent err'],
    'closing second pane in same project preserves markers while first pane remains open'
  );
  assert.equal(
    getEditorLanguageSnapshot().statuses.some((s) => s.projectPath === parent && s.relPath === parentRel),
    true
  );

  // Disposing the last parent pane clears parent markers and document status.
  parentPane1.dispose();
  assert.deepEqual(markersByOwner.get(parentOwner), [], 'closing last parent pane clears parent markers');
  assert.equal(
    getEditorLanguageSnapshot().statuses.some((s) => s.projectPath === parent && s.relPath === parentRel),
    false
  );
  assert.equal(getEditorLanguageSnapshot().problems.filter((p) => p.uri === sharedUri).length, 0);
});
