import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  expose: ['HTMLElement', 'Event'],
  actEnvironment: false,
});
globalThis.React = React;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.HTMLElement.prototype.attachEvent = () => {};
window.HTMLElement.prototype.detachEvent = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { createRoot } = await import('react-dom/client');
const { computerReadinessBlocking, computerReadinessPending, computerReadinessRows, linuxPlatformFacts } = await import(
  './computer-readiness.ts'
);
const { featureStatus } = await import('./built-in-features-panel.tsx');
const { ComputerReadinessSection, inputAccessError, useComputerReadiness } = await import(
  './computer-readiness-section.tsx'
);

const ready = { state: 'ready' };
const linux = (capabilities = {}, extra = {}) => ({
  platform: 'linux',
  screen_capture: 'ready',
  accessibility: 'ready',
  input: 'ready',
  linux: {
    session: 'wayland',
    desktop: 'gnome',
    capabilities: {
      capture: ready,
      windows: ready,
      accessibility: ready,
      semanticActions: ready,
      pointer: ready,
      keyboard: ready,
      clipboard: ready,
      ocr: ready,
      ...capabilities,
    },
    ...extra,
  },
});
const rowsOf = (readiness) => computerReadinessRows(readiness);
const byId = (rows, id) => rows.find((row) => row.id === id);

test('a ready Linux session lists nothing', () => {
  assert.deepEqual(rowsOf(linux()), []);
  assert.deepEqual(rowsOf(linux({ capture: { state: 'unknown' } })), []);
});

test('Windows and an unread host list nothing', () => {
  assert.deepEqual(
    rowsOf({
      platform: 'win32',
      screen_capture: 'not_required_on_windows',
      accessibility: 'not_required_on_windows',
      input: 'target_integrity_dependent',
    }),
    []
  );
  assert.deepEqual(rowsOf(null), []);
});

test('allow_input is a Mouse and keyboard row with an Allow action', () => {
  const rows = rowsOf(
    linux({
      pointer: { state: 'needs_setup', fix: 'allow_input' },
      keyboard: { state: 'needs_setup', fix: 'allow_input' },
    })
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { title: rows[0].title, status: rows[0].status, tone: rows[0].tone, action: rows[0].action },
    {
      title: 'Mouse and keyboard',
      status: 'Allow needed',
      tone: 'warn',
      action: { kind: 'allow_input', label: 'Allow' },
    }
  );
});

test('relogin shows the status and no button; enable_window_helper offers Try again', () => {
  const relogin = byId(rowsOf(linux({ windows: { state: 'needs_setup', fix: 'relogin' } })), 'windows');
  assert.equal(relogin.status, 'Sign-in needed again');
  assert.equal(relogin.tone, 'warn');
  assert.equal(relogin.action, undefined);
  assert.match(relogin.description, /^Sign out and back in to turn it on\./);

  const retry = byId(rowsOf(linux({ windows: { state: 'needs_setup', fix: 'enable_window_helper' } })), 'windows');
  assert.equal(retry.status, 'Needed');
  assert.deepEqual(retry.action, { kind: 'retry', label: 'Try again' });
});

test('unsupported windows names the desktop and has no button', () => {
  const kde = byId(rowsOf(linux({ windows: { state: 'unsupported' } }, { desktop: 'kde' })), 'windows');
  assert.equal(kde.status, 'Not supported');
  assert.equal(kde.tone, 'muted');
  assert.equal(kde.action, undefined);
  assert.equal(kde.needsSetup, false);
  assert.match(kde.description, /^Not supported on KDE yet\./);
});

test('optional packages are muted with a How to install action; required ones stay warn', () => {
  const rows = rowsOf(
    linux({
      pointer: { state: 'needs_setup', fix: 'allow_input' },
      keyboard: { state: 'needs_setup', fix: 'allow_input' },
      clipboard: { state: 'needs_setup', fix: 'install_package', package: 'wl-clipboard', optional: true },
      ocr: { state: 'needs_setup', fix: 'install_package', package: 'tesseract-ocr', optional: true },
    })
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.status, row.tone, row.action?.kind, row.action?.package]),
    [
      ['input', 'Allow needed', 'warn', 'allow_input', undefined],
      ['clipboard', 'Optional add-on', 'muted', 'install_how', 'wl-clipboard'],
      ['ocr', 'Optional add-on', 'muted', 'install_how', 'tesseract-ocr'],
    ]
  );
  assert.equal(computerReadinessBlocking(rows), true);
  assert.equal(computerReadinessPending(rows), true);

  const required = byId(
    rowsOf(linux({ clipboard: { state: 'needs_setup', fix: 'install_package', package: 'xclip' } })),
    'clipboard'
  );
  assert.equal(required.status, 'Needed');
  assert.equal(required.tone, 'warn');
});

test('only optional items left: no section rows, no rail tag, no polling', () => {
  // A plain dpkg -i leaves wl-clipboard and tesseract out; nothing blocks work.
  const rows = rowsOf(
    linux({
      clipboard: { state: 'needs_setup', fix: 'install_package', package: 'wl-clipboard', optional: true },
      ocr: { state: 'needs_setup', fix: 'install_package', package: 'tesseract-ocr', optional: true },
    })
  );
  assert.deepEqual(rows, []);
  assert.equal(computerReadinessBlocking(rows), false);
  assert.equal(computerReadinessPending(rows), false);
});

test('semantic actions and accessibility share one row; capture needs_setup has one too', () => {
  const rows = rowsOf(linux({ semanticActions: { state: 'needs_setup' }, capture: { state: 'needs_setup' } }));
  assert.deepEqual(rows.map((row) => row.id).sort(), ['accessibility', 'capture']);
});

test('macOS maps each missing grant to a row that opens its System Settings pane', () => {
  const mac = (screen_capture, accessibility) => ({
    platform: 'darwin',
    screen_capture,
    accessibility,
    input: 'accessibility_dependent',
  });
  assert.deepEqual(rowsOf(mac('granted', 'granted')), []);
  const rows = rowsOf(mac('denied', 'not-determined'));
  assert.deepEqual(
    rows.map((row) => [row.id, row.title, row.status, row.action]),
    [
      ['screen', 'Screen Recording', 'Allow needed', { kind: 'open_settings', label: 'Open settings', pane: 'screen' }],
      [
        'accessibility',
        'Accessibility',
        'Allow needed',
        { kind: 'open_settings', label: 'Open settings', pane: 'accessibility' },
      ],
    ]
  );
  assert.equal(rowsOf(mac('restricted', 'granted')).length, 1);
  assert.equal(computerReadinessBlocking(rows), true);
});

test('Info facts report the real session and desktop', () => {
  assert.deepEqual(linuxPlatformFacts({ session: 'wayland', desktop: 'gnome', capabilities: {} }), [
    ['Engine', 'AT-SPI · Wayland'],
    ['Platform', 'Linux · GNOME, Wayland'],
  ]);
  assert.deepEqual(linuxPlatformFacts({ session: 'x11', desktop: 'other', capabilities: {} }), [
    ['Engine', 'AT-SPI · X11'],
    ['Platform', 'Linux · X11'],
  ]);
});

const featureState = (readinessBlocking, overrides = {}) => ({
  ready: true,
  installed: true,
  supported: true,
  available: true,
  enabled: true,
  action: null,
  progressPercent: null,
  readinessBlocking,
  ...overrides,
});

test('the rail tags Computer Use "Setup needed" only while something blocks work', () => {
  assert.deepEqual(featureStatus(featureState(true)), { label: 'Setup needed', tone: 'warn' });
  assert.equal(featureStatus(featureState(false)), null);
  // Not installed or switched off still reads as that, not as a setup problem.
  assert.deepEqual(featureStatus(featureState(true, { installed: false })), { label: 'Not installed', tone: 'muted' });
  assert.deepEqual(featureStatus(featureState(true, { enabled: false })), { label: 'Disabled', tone: 'muted' });
});

function Harness({ api }) {
  const readiness = useComputerReadiness(api, false);
  return React.createElement(ComputerReadinessSection, { rows: readiness.rows, api, refresh: readiness.refresh });
}

test('the section lists rows, runs actions, and disappears by itself on the next read', async (t) => {
  const reads = [
    linux({
      pointer: { state: 'needs_setup', fix: 'allow_input' },
      keyboard: { state: 'needs_setup', fix: 'allow_input' },
      clipboard: { state: 'needs_setup', fix: 'install_package', package: 'wl-clipboard', optional: true },
    }),
    linux({
      pointer: { state: 'needs_setup', fix: 'allow_input' },
      keyboard: { state: 'needs_setup', fix: 'allow_input' },
      clipboard: { state: 'needs_setup', fix: 'install_package', package: 'wl-clipboard', optional: true },
    }),
    // The grant went through; only the optional add-on is left, so the section goes.
    linux({ clipboard: { state: 'needs_setup', fix: 'install_package', package: 'wl-clipboard', optional: true } }),
  ];
  let reading = 0;
  const allowed = [];
  const api = {
    computerReadiness: async () => reads[Math.min(reading++, reads.length - 1)],
    requestLinuxInputAccess: async () => {
      allowed.push(true);
      return { ok: false, reason: 'failed' };
    },
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => root.render(React.createElement(Harness, { api })));
  await act(async () => {});

  const section = host.querySelector('[data-computer-readiness]');
  assert.ok(section);
  assert.match(section.textContent, /Readiness/);
  assert.deepEqual(
    [...section.querySelectorAll('[data-readiness-row]')].map((row) => row.getAttribute('data-readiness-row')),
    ['input', 'clipboard']
  );
  const clipboard = section.querySelector('[data-readiness-row="clipboard"]');
  assert.equal(clipboard.getAttribute('data-tone'), 'muted');
  assert.equal(clipboard.querySelector('.extensions-item-status').textContent, 'Optional add-on');

  // A failed grant shows the message and the row stays.
  await act(async () => section.querySelector('[data-readiness-row="input"] button').click());
  assert.deepEqual(allowed, [true]);
  assert.match(host.textContent, /Mouse and keyboard access could not be allowed\./);
  assert.ok(host.querySelector('[data-readiness-row="input"]'));

  // How to install opens a note with the package command.
  await act(async () => host.querySelector('[data-readiness-row="clipboard"] button').click());
  assert.match(host.textContent, /sudo apt install wl-clipboard/);

  // Coming back to the window re-reads; with only the optional add-on left the whole section is gone.
  await act(async () => {
    window.dispatchEvent(new window.Event('focus'));
  });
  assert.equal(host.querySelector('[data-computer-readiness]'), null);
});

test('a failed Allow picks a guidance line from the structured result, not the English diagnostic', () => {
  const base = 'Mouse and keyboard access could not be allowed.';
  const line = (result) => inputAccessError({ ok: false, message: 'ENGLISH DIAGNOSTIC', ...result });
  assert.equal(
    line({ reason: 'access_unavailable', detail: 'relogin' }),
    `${base} Sign out and back in, or add your user to the input group, then try again.`
  );
  assert.equal(
    line({ reason: 'access_unavailable', detail: 'no-module' }),
    `${base} The uinput kernel module is not available on this system.`
  );
  assert.equal(line({ reason: 'failed', exitCode: 3 }), `${base} The repair script failed (exit 3).`);
  assert.equal(line({ reason: 'cancelled' }), `${base} Authorization was cancelled.`);
  assert.equal(
    line({ reason: 'pkexec_missing' }),
    `${base} pkexec is not installed, so access cannot be set up from here.`
  );
  assert.equal(line({ reason: 'failed' }), base);
  assert.equal(inputAccessError(undefined), base);
});

test('every locale carries the input-access guidance keys with literals and placeholders intact', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../locales/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 11);
  for (const name of files) {
    const catalog = JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
    const get = (key) => catalog[key];
    assert.match(get('Sign out and back in, or add your user to the input group, then try again.'), /input/, name);
    assert.match(get('The uinput kernel module is not available on this system.'), /uinput/, name);
    assert.match(get('The repair script failed (exit {{code}}).'), /\{\{code\}\}/, name);
    assert.ok(get('Authorization was cancelled.'), name);
    assert.match(get('pkexec is not installed, so access cannot be set up from here.'), /pkexec/, name);
  }
});
