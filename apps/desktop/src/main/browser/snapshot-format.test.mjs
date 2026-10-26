import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserGuestStateStore } from './guest-state.ts';
import { createBrowserRefSet } from './ref-recovery.ts';
import { createBrowserReply, unreportedDownloads } from './reply.ts';
import { formatPageReport, formatSnapshot } from './snapshot-format.ts';

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

test('a reply without a snapshot still carries the page report, and nothing when there is none', () => {
  assert.equal(formatPageReport(diagnostics()), '');
  const report = formatPageReport(
    diagnostics({ console: { recentErrors: () => [], newErrors: () => ['boom'], pendingErrorCount: () => 1 } }),
    { downloads: [{ id: 'd1', file: 'a.csv', state: 'completed', received: 2048, total: 2048, path: 'C:/tmp/a.csv' }] }
  );
  assert.equal(
    report,
    'Downloads since last report:\n- [d1] a.csv — completed, 2 KB → C:/tmp/a.csv\n\nNew console errors: boom'
  );
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

test('a brief reply names the elements that went away', () => {
  const start = { ref: 'p1-s1-e1', role: 'button', name: 'Start', inViewport: true };
  const link = { ref: 'p1-s1-e2', role: 'link', name: 'Docs', inViewport: true };
  const text = formatSnapshot(
    payload({ snapshotId: 'p1-s2', elements: [{ ...link, ref: 'p1-s2-e1' }], totalElements: 1 }),
    diagnostics(),
    { briefAgainst: createBrowserRefSet(payload({ elements: [start, link], totalElements: 2 })) }
  );
  assert.match(text, /; 1 no longer matched: button "Start"\./);
});

test('a network failure is reported once, like a console error, then only newer ones', () => {
  const view = diagnostics({
    networkFailures: ['GET https://example.test/tracker — net::ERR_BLOCKED_BY_CLIENT'],
    reportedNetworkFailures: new Set(),
  });
  assert.match(formatSnapshot(payload(), view), /New network failures: GET https:\/\/example.test\/tracker/);
  assert.doesNotMatch(formatSnapshot(payload(), view), /network failures/);
  view.networkFailures.push('GET https://example.test/api — net::ERR_FAILED');
  const next = formatSnapshot(payload(), view);
  assert.match(next, /New network failures: GET https:\/\/example.test\/api/);
  assert.doesNotMatch(next, /tracker/);
  // A cleared list (a new document) makes the same address news again.
  view.networkFailures.length = 0;
  formatSnapshot(payload(), view);
  assert.equal(view.reportedNetworkFailures.size, 0);
});

test('identical diagnostic lines are said once with a count', () => {
  const beacon = 'GET https://example.test/beacon — net::ERR_FAILED';
  const text = formatSnapshot(
    payload(),
    diagnostics({
      console: { recentErrors: () => [], newErrors: () => ['boom', 'other', 'boom'], pendingErrorCount: () => 3 },
      networkFailures: [beacon, beacon],
    })
  );
  assert.match(text, /New console errors: boom \(×2\) \| other$/m);
  assert.match(text, /network failures: GET https:\/\/example.test\/beacon — net::ERR_FAILED \(×2\)$/m);
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
  assert.match(pdf, /This document is a PDF shown in the browser's built-in viewer/);
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

test('a download state is reported once for the session, not once per page', () => {
  const state = new BrowserGuestStateStore();
  const first = {};
  const second = {};
  state.for(first);
  state.for(second);
  const download = {
    id: 'd1',
    file: 'Images.txt',
    state: 'in_progress',
    received: 10,
    total: 2048,
    path: 'C:/tmp/Images.txt',
    startedAt: Date.now() + 60_000,
  };
  const reply = createBrowserReply({ state, downloadsForGuest: () => [download] });
  assert.match(reply.reportPage(first), /\[d1\] Images\.txt — in_progress/);
  assert.equal(reply.reportPage(second), '', 'the other page already heard this state');
  assert.equal(reply.reportPage(first), '');

  download.state = 'completed';
  download.completedAt = Date.now() + 60_000;
  assert.match(reply.reportPage(second), /\[d1\] Images\.txt — completed/);
  assert.equal(reply.reportPage(first), '', 'a state change is also said once');
});

test('two independent pages failing identically each report their own failure once', () => {
  const state = new BrowserGuestStateStore();
  const signIn = 'POST https://example.test/login — net::ERR_FAILED';
  const pages = [{}, {}].map((guest) => {
    const record = state.for(guest);
    record.networkFailures.push(signIn);
    record.console.recordError('Error: sign-in failed');
    return record;
  });
  for (const record of pages) {
    const report = formatPageReport(record);
    assert.match(report, /New console errors: Error: sign-in failed/);
    assert.match(report, /New network failures: POST https:\/\/example\.test\/login/);
    assert.equal(formatPageReport(record), '', 'each is said once per page');
  }
});

test('a brief reply keeps its budget when the earlier look skipped most of the page', () => {
  const link = (index, extra = {}) => ({
    ref: `p1-s2-e${index}`,
    role: 'link',
    name: `link ${index}`,
    tag: 'ax',
    ...extra,
  });
  const elements = Array.from({ length: 160 }, (_value, index) =>
    link(index + 1, { inViewport: index >= 100 && index < 108 })
  );
  const text = formatSnapshot(payload({ snapshotId: 'p1-s2', elements, totalElements: 285 }), diagnostics(), {
    briefAgainst: createBrowserRefSet(
      payload({
        elements: elements.slice(0, 8).map((el) => ({ ...el, ref: el.ref.replace('s2', 's1') })),
        totalElements: 285,
      })
    ),
  });
  assert.match(text, /152 not previously reported/);
  assert.match(text, /Not previously reported: 152 element\(s\); showing 5/);
  const listed = text.split('\n').filter((line) => /^\s+\[p1-s2-e\d+\]/.test(line));
  assert.equal(listed.length, 5);
  assert.ok(
    listed.every((line) => line.includes(']*')),
    'the ones in view come first'
  );
  assert.match(text, /147 more not listed/);
  assert.ok(text.length < 1_500);
});

test('an empty secret field shows no value; a filled one only says it is redacted', () => {
  const field = (extra) => ({
    ref: 'p1-s1-e1',
    role: 'textbox',
    name: 'Password',
    tag: 'input',
    sensitive: true,
    ...extra,
  });
  const empty = formatSnapshot(payload({ elements: [field({})], totalElements: 1 }), diagnostics());
  assert.match(empty, /\[p1-s1-e1\] textbox "Password"$/m);
  assert.doesNotMatch(empty, /REDACTED/);
  const filled = formatSnapshot(payload({ elements: [field({ filled: true })], totalElements: 1 }), diagnostics());
  assert.match(filled, /textbox "Password" value=\[REDACTED\]$/m);
});

test('refusals of one host for one reason are one line with a count', () => {
  const reason = 'net::ERR_BLOCKED_BY_CLIENT (Browser Use network policy: private or internal address 10.0.0.1)';
  const text = formatSnapshot(
    payload(),
    diagnostics({
      networkFailures: [
        `GET https://a.example/e?n=1 — ${reason}`,
        'GET https://b.example/app.js — net::ERR_FAILED',
        `GET https://a.example/e?n=2 — ${reason}`,
        `GET https://a.example/e?n=3 — ${reason}`,
        `GET https://c.example/e — ${reason}`,
      ],
    })
  );
  assert.match(text, /GET https:\/\/a\.example\/e\?n=1 — .*\(×3 requests to this host\)/);
  assert.equal(text.split('Browser Use network policy').length - 1, 2, 'one line per host, reason said once each');
  assert.doesNotMatch(text, /n=2|n=3/);
  assert.match(text, /https:\/\/b\.example\/app\.js/);
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
