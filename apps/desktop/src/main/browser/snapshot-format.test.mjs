import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserRefSet } from './ref-recovery.ts';
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

test('an empty filter says what it filtered, and console errors are reported once when new', () => {
  const text = formatSnapshot(payload({ query: 'nothing', unfilteredElements: 42 }), diagnostics());
  assert.match(text, /No interactive element matched the filter; the page has 42 interactive element\(s\)/);
  assert.doesNotMatch(
    formatSnapshot(
      payload({ query: 'save', elements: [{ ref: 'p1-s1-e1', role: 'button', name: 'Save', tag: 'ax' }] }),
      diagnostics()
    ),
    /No interactive element/
  );
  const asked = [];
  const withNew = formatSnapshot(
    payload(),
    diagnostics({
      console: {
        recentErrors: () => ['old'],
        newErrors: (limit) => {
          asked.push(limit);
          return ['fresh'];
        },
      },
    })
  );
  assert.match(withNew, /New console errors: fresh/);
  assert.doesNotMatch(withNew, /Recent console errors|: old/);
  assert.deepEqual(asked, [3]);
});

test('a brief reply says when the observation it compares against saw only part of the page', () => {
  const element = (index, extra = {}) => ({
    ref: `p1-s1-e${index}`,
    role: 'link',
    name: `link ${index}`,
    tag: 'ax',
    ...extra,
  });
  const whole = Array.from({ length: 6 }, (_value, index) => element(index + 1));

  // The caller's last look was capped at two of six. One of those two changed;
  // the four it never reported are unseen, not elements this action created.
  const capped = formatSnapshot(
    payload({ elements: [element(1), element(2, { states: ['focused'] }), ...whole.slice(2)], totalElements: 6 }),
    diagnostics(),
    { briefAgainst: createBrowserRefSet(payload({ elements: whole.slice(0, 2), totalElements: 6 })) }
  );
  assert.match(capped, /1 changed element\(s\); 4 not previously reported; 1 unchanged omitted/);
  assert.match(capped, /previous observation reported only 2 of 6 element\(s\)/);
  assert.match(capped, /Changed elements[\s\S]*\[p1-s1-e2\] link "link 2" focused/);
  assert.match(capped, /Not previously reported[\s\S]*\[p1-s1-e3\] link "link 3"/);

  const filtered = formatSnapshot(payload({ elements: whole, totalElements: 6 }), diagnostics(), {
    briefAgainst: createBrowserRefSet(payload({ elements: whole.slice(0, 2), totalElements: 2, query: 'link' })),
  });
  assert.match(filtered, /previous observation reported only 2 of 2 element\(s\) matching "link"/);

  // A complete baseline still reports a plain change without the caveat.
  const complete = formatSnapshot(
    payload({ elements: [element(1), element(2, { states: ['focused'] })], totalElements: 2 }),
    diagnostics(),
    { briefAgainst: createBrowserRefSet(payload({ elements: whole.slice(0, 2), totalElements: 2 })) }
  );
  assert.match(complete, /1 changed or new element\(s\); 1 unchanged omitted/);
  assert.doesNotMatch(complete, /previous observation reported only/);
});

test('snapshot header names an error status for the document, never a success', () => {
  const failed = formatSnapshot(
    payload(),
    diagnostics({
      network: { documentStatus: () => ({ status: 404, statusText: 'Not Found' }) },
    })
  );
  assert.match(failed, /^Status: HTTP 404 Not Found/m);
  const ok = formatSnapshot(
    payload(),
    diagnostics({
      network: { documentStatus: () => ({ status: 200, statusText: 'OK' }) },
    })
  );
  assert.doesNotMatch(ok, /^Status:/m);
});

test('a capped diagnostic list says how much it left out', () => {
  const text = formatSnapshot(
    payload(),
    diagnostics({
      console: {
        recentErrors: () => [],
        newErrors: () => ['one', 'two', 'three'],
        pendingErrorCount: () => 12,
      },
      networkFailures: Array.from({ length: 7 }, (_, index) => `GET https://example.test/${index} — failed`),
    })
  );
  assert.match(text, /New console errors \(3 of 12; call console for the rest\)/);
  assert.match(text, /Recent network failures \(3 of 7; call network for the rest\)/);
  const small = formatSnapshot(
    payload(),
    diagnostics({
      console: { recentErrors: () => [], newErrors: () => ['only one'], pendingErrorCount: () => 1 },
      networkFailures: ['GET https://example.test/x — failed'],
    })
  );
  assert.match(small, /New console errors: only one/);
  assert.doesNotMatch(small, /of 1;/);
});

test('a clipped page excerpt says the page holds more', () => {
  const clipped = formatSnapshot({ ...payload(), text: 'first part of a long page', textClipped: true }, diagnostics());
  assert.match(clipped, /first 25 chars only — the page holds more/);
  const whole = formatSnapshot({ ...payload(), text: 'the entire page' }, diagnostics());
  assert.match(whole, /Visible text \(condensed, untrusted\):/);
  assert.doesNotMatch(whole, /the page holds more/);
});

test('snapshot names a PDF document instead of reporting an empty page', () => {
  const pdf = formatSnapshot(
    payload(),
    diagnostics({
      network: { documentStatus: () => ({ status: 200, mimeType: 'application/pdf' }) },
    })
  );
  assert.match(pdf, /This document is a PDF, which this browser cannot display/);
  assert.match(pdf, /Read the file from this URL/);
  const html = formatSnapshot(
    payload(),
    diagnostics({
      network: { documentStatus: () => ({ status: 200, mimeType: 'text/html' }) },
    })
  );
  assert.doesNotMatch(html, /This document is a PDF/);
});

test('snapshot reports a pending file chooser and how to answer it', () => {
  const text = formatSnapshot(
    payload(),
    diagnostics({
      pendingFileChooser: { mode: 'selectMultiple' },
    })
  );
  assert.match(text, /Pending file chooser \(multiple files\)/);
  assert.match(text, /call upload with paths \(no ref needed\)/);
  assert.doesNotMatch(formatSnapshot(payload(), diagnostics()), /file chooser/);
});

test('snapshot lists downloads handed to it and stays quiet otherwise', () => {
  const text = formatSnapshot(payload(), diagnostics(), {
    downloads: [
      {
        id: 'd1',
        file: 'report.pdf',
        state: 'completed',
        received: 2048,
        total: 2048,
        path: 'C:\\Users\\me\\Downloads\\report.pdf',
      },
    ],
  });
  assert.match(
    text,
    /Downloads since last report:\n- \[d1\] report\.pdf — completed, 2 KB → C:\\Users\\me\\Downloads\\report\.pdf/
  );
  assert.doesNotMatch(formatSnapshot(payload(), diagnostics(), { downloads: [] }), /Downloads since/);
});

test('unreported downloads are those started or finished after the last report', () => {
  const downloads = [
    { id: 'd3', startedAt: 300, state: 'in_progress' },
    { id: 'd2', startedAt: 150, completedAt: 250, state: 'completed' },
    { id: 'd1', startedAt: 50, completedAt: 90, state: 'completed' },
  ];
  assert.deepEqual(
    unreportedDownloads(downloads, 200).map((entry) => entry.id),
    ['d3', 'd2']
  );
  assert.deepEqual(
    unreportedDownloads(downloads, 0).map((entry) => entry.id),
    ['d3', 'd2', 'd1']
  );
  assert.deepEqual(unreportedDownloads(downloads, 400), []);
});
