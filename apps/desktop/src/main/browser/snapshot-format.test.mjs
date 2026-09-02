import assert from 'node:assert/strict';
import test from 'node:test';

import { unreportedDownloads } from './reply.ts';
import { formatSnapshot } from './snapshot-format.ts';

const payload = (overrides = {}) => ({
  snapshotId: 'p1-s1',
  title: 'Fixture',
  url: 'https://example.test/page',
  scrollY: 0,
  scrollHeight: 900,
  viewportHeight: 900,
  headings: [],
  elements: [],
  totalElements: 0,
  scanned: 0,
  ...overrides,
});

const diagnostics = (overrides = {}) => ({
  pendingDialog: null,
  pendingFileChooser: null,
  console: { recentErrors: () => [] },
  networkFailures: [],
  network: { documentStatus: () => null },
  ...overrides,
});

test('snapshot header names an error status for the document, never a success', () => {
  const failed = formatSnapshot(payload(), diagnostics({
    network: { documentStatus: () => ({ status: 404, statusText: 'Not Found' }) },
  }));
  assert.match(failed, /^Status: HTTP 404 Not Found/m);
  const ok = formatSnapshot(payload(), diagnostics({
    network: { documentStatus: () => ({ status: 200, statusText: 'OK' }) },
  }));
  assert.doesNotMatch(ok, /^Status:/m);
});

test('snapshot reports a pending file chooser and how to answer it', () => {
  const text = formatSnapshot(payload(), diagnostics({
    pendingFileChooser: { mode: 'selectMultiple' },
  }));
  assert.match(text, /Pending file chooser \(multiple files\)/);
  assert.match(text, /call upload with paths and confirm:true/);
  assert.doesNotMatch(formatSnapshot(payload(), diagnostics()), /file chooser/);
});

test('snapshot lists downloads handed to it and stays quiet otherwise', () => {
  const text = formatSnapshot(payload(), diagnostics(), {
    downloads: [{
      id: 'd1',
      file: 'report.pdf',
      state: 'completed',
      received: 2048,
      total: 2048,
      path: 'C:\\Users\\me\\Downloads\\report.pdf',
    }],
  });
  assert.match(text, /Downloads since last report:\n- \[d1\] report\.pdf — completed, 2 KB → C:\\Users\\me\\Downloads\\report\.pdf/);
  assert.doesNotMatch(formatSnapshot(payload(), diagnostics(), { downloads: [] }), /Downloads since/);
});

test('unreported downloads are those started or finished after the last report', () => {
  const downloads = [
    { id: 'd3', startedAt: 300, state: 'in_progress' },
    { id: 'd2', startedAt: 150, completedAt: 250, state: 'completed' },
    { id: 'd1', startedAt: 50, completedAt: 90, state: 'completed' },
  ];
  assert.deepEqual(unreportedDownloads(downloads, 200).map((entry) => entry.id), ['d3', 'd2']);
  assert.deepEqual(unreportedDownloads(downloads, 0).map((entry) => entry.id), ['d3', 'd2', 'd1']);
  assert.deepEqual(unreportedDownloads(downloads, 400), []);
});
