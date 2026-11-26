import assert from 'node:assert/strict';
import test from 'node:test';

import { scopedSectionChanges } from './scoped-sections.ts';

test('explicit removed frames evict closed LSP status and diagnostics rows while preserving empty-diagnostics clear', () => {
  const route = { windows: new Set(), held: new Map() };
  const serverStatus = { projectPath: '/proj', languageId: 'rust', status: 'ready', available: true, server: 'ra' };
  scopedSectionChanges(route, 'lsp/status/updated', {
    section: 'lspStatus',
    key: 'rust',
    revision: 1,
    value: serverStatus,
  });

  let statusRev = 2;
  let diagRev = 1;
  for (let i = 0; i < 20; i += 1) {
    const rel = `src/f${i}.rs`;
    const uri = `file:///proj/${rel}`;
    const statusKey = `rust\0${rel}`;
    scopedSectionChanges(route, 'lsp/status/updated', {
      section: 'lspStatus',
      key: statusKey,
      revision: statusRev++,
      value: { ...serverStatus, relPath: rel },
    });
    scopedSectionChanges(route, 'lsp/diagnostics/updated', {
      section: 'lspDiagnostics',
      key: uri,
      revision: diagRev++,
      value: { projectPath: '/proj', relPath: rel, uri, server: 'ra', diagnostics: [{ message: 'err' }] },
    });

    const statusRemoved = scopedSectionChanges(route, 'lsp/status/updated', {
      section: 'lspStatus',
      key: statusKey,
      revision: statusRev++,
      removed: true,
    });
    assert.deepEqual(statusRemoved, [{ section: 'lspStatus', key: statusKey, entry: null }]);

    const diagCleared = scopedSectionChanges(route, 'lsp/diagnostics/updated', {
      section: 'lspDiagnostics',
      key: uri,
      revision: diagRev++,
      value: { projectPath: '/proj', relPath: rel, uri, server: 'ra', diagnostics: [] },
    });
    assert.equal(diagCleared.length, 1);
    assert.deepEqual(diagCleared[0].entry?.value?.diagnostics, []);

    const diagRemoved = scopedSectionChanges(route, 'lsp/diagnostics/updated', {
      section: 'lspDiagnostics',
      key: uri,
      revision: diagRev++,
      removed: true,
    });
    assert.deepEqual(diagRemoved, [{ section: 'lspDiagnostics', key: uri, entry: null }]);
  }

  assert.equal(route.held.size, 1, 'only the server-level status row remains held after open/close cycles');
  assert.ok(route.held.has('lspStatus\0rust'));
});

test('reconnect feed/snapshot for lsp:<root> evicts missed document closes and keeps open rows', () => {
  const route = { windows: new Set(), held: new Map() };
  const serverStatus = { projectPath: '/proj', languageId: 'rust', status: 'ready', available: true, server: 'ra' };
  const keepStatus = { ...serverStatus, relPath: 'src/keep.rs' };
  const closedStatus = { ...serverStatus, relPath: 'src/closed.rs' };
  const keepDiag = {
    projectPath: '/proj',
    relPath: 'src/keep.rs',
    uri: 'file:///proj/src/keep.rs',
    server: 'ra',
    diagnostics: [{ message: 'keep' }],
  };
  const closedDiag = {
    projectPath: '/proj',
    relPath: 'src/closed.rs',
    uri: 'file:///proj/src/closed.rs',
    server: 'ra',
    diagnostics: [{ message: 'closed' }],
  };

  scopedSectionChanges(route, 'lsp/status/updated', {
    section: 'lspStatus',
    key: 'rust',
    revision: 1,
    value: serverStatus,
  });
  scopedSectionChanges(route, 'lsp/status/updated', {
    section: 'lspStatus',
    key: 'rust\0src/keep.rs',
    revision: 2,
    value: keepStatus,
  });
  scopedSectionChanges(route, 'lsp/status/updated', {
    section: 'lspStatus',
    key: 'rust\0src/closed.rs',
    revision: 3,
    value: closedStatus,
  });
  scopedSectionChanges(route, 'lsp/diagnostics/updated', {
    section: 'lspDiagnostics',
    key: keepDiag.uri,
    revision: 1,
    value: keepDiag,
  });
  scopedSectionChanges(route, 'lsp/diagnostics/updated', {
    section: 'lspDiagnostics',
    key: closedDiag.uri,
    revision: 2,
    value: closedDiag,
  });

  // Document `src/closed.rs` was closed while disconnected; reconnect delivers LspProject's full state map.
  const changes = scopedSectionChanges(route, 'feed/snapshot', {
    feedId: 'lsp:/proj',
    state: {
      lspStatus: {
        rust: { revision: 1, value: serverStatus },
        'rust\0src/keep.rs': { revision: 2, value: keepStatus },
      },
      lspDiagnostics: {
        [keepDiag.uri]: { revision: 1, value: keepDiag },
      },
    },
  });

  const removed = changes.filter((c) => c.entry === null).map((c) => [c.section, c.key]);
  assert.deepEqual(removed, [
    ['lspStatus', 'rust\0src/closed.rs'],
    ['lspDiagnostics', closedDiag.uri],
  ]);
  assert.deepEqual(
    [...route.held.keys()].sort(),
    ['lspDiagnostics\0file:///proj/src/keep.rs', 'lspStatus\0rust', 'lspStatus\0rust\0src/keep.rs'],
    'held mirror matches the reconnect snapshot'
  );

  // An empty snapshot clears all held rows; a non-section snapshot does not touch held rows.
  scopedSectionChanges(route, 'feed/snapshot', { feedId: 'search:1', state: { query: 'x', files: [] } });
  assert.equal(route.held.size, 3);
  const cleared = scopedSectionChanges(route, 'feed/snapshot', { feedId: 'lsp:/proj', state: {} });
  assert.equal(cleared.filter((c) => c.entry === null).length, 3);
  assert.equal(route.held.size, 0);
});
