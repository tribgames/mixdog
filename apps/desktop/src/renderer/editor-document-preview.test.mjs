// Desktop documents use external apps; restored tabs stay inert, while
// remote surfaces keep their page viewer and its conversion-failure escape.
import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  actEnvironment: false,
});
globalThis.requestAnimationFrame = (callback) => {
  callback(0);
  return 1;
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { useEditorFileSession } = await import('./use-editor-file-session.ts');
// Every import resolves before the first test registers: the runner's
// --test-force-exit ends the process once registered tests finish.
const { EditorPaneFileFallback } = await import('./editor-pane-surfaces.tsx');
const { resetOfficeInstall } = await import('./editor-office-install.ts');
const { storeDesktopStatus } = await import('./settings/desktop-status-cache.ts');

async function mountSession(api, relPath) {
  window.mixdogDesktop = api;
  const session = { current: null };
  function Harness() {
    const editorRef = useRef(null);
    const syncLspRef = useRef(async () => false);
    session.current = useEditorFileSession({
      editorRef,
      projectPath: 'C:/Project/demo',
      relPath,
      active: true,
      editorSettings: {},
      notifyReady() {},
      onDirty() {},
      syncLspRef,
    });
    return null;
  }
  const host = document.createElement('div');
  document.querySelector('main').append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Harness)));
  return { root, session };
}

function surface(t, electron = false) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: electron ? 'Electron/41.0' : 'Mozilla/5.0' },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete globalThis.navigator;
  });
}

const renderedPage = (page) => ({
  page,
  width: 1200,
  height: 1697,
  mime: 'image/png',
  base64: `page-${page}`,
});

test('a remote surface opens the document as pages and scrolls on', async (t) => {
  surface(t);
  const requested = [];
  const api = {
    previewDocumentPages: async (_projectPath, _relPath, _accessToken, options) => {
      requested.push([...options.pages]);
      return {
        format: 'docx',
        mtimeMs: 42,
        size: 4096,
        pageCount: 3,
        pages: options.pages.map(renderedPage),
      };
    },
  };
  const { root, session } = await mountSession(api, 'docs/report.docx');
  try {
    assert.deepEqual(requested, [[1]], 'opening costs exactly one page');
    assert.equal(session.current.documentPreview.pageCount, 3);
    assert.equal(session.current.preview, null, 'no PDF viewer is claimed here');
    assert.equal(session.current.load.binary, true, 'the text editor stays out of the way');

    // Pages arriving out of order still read top to bottom.
    await act(async () => session.current.loadDocumentPages([3, 2]));
    assert.deepEqual(
      session.current.documentPreview.pages.map((page) => page.page),
      [1, 2, 3]
    );
    assert.equal(session.current.documentError, '');
  } finally {
    await act(async () => root.unmount());
  }
});

test('desktop Office tabs render pages in-app without launching an OS app', async (t) => {
  surface(t, true);
  const requested = [];
  const launched = [];
  const api = {
    previewDocumentPages: async (_projectPath, _relPath, _accessToken, options) => {
      requested.push([...options.pages]);
      return { format: 'pptx', mtimeMs: 5, size: 10, pageCount: 2, pages: options.pages.map(renderedPage) };
    },
    openFilePath: async () => launched.push('launch'),
    openLocalFile: async () => launched.push('launch'),
  };
  const { root, session } = await mountSession(api, 'docs/deck.pptx');
  try {
    assert.deepEqual(requested, [[1]]);
    assert.deepEqual(launched, []);
    assert.equal(session.current.documentPreview.pageCount, 2);
    assert.equal(session.current.documentError, '');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a desktop Office conversion failure falls back to the binary notice without launching', async (t) => {
  surface(t, true);
  const launched = [];
  const api = {
    previewDocumentPages: async () => {
      throw new Error('converter missing');
    },
    openFilePath: async () => launched.push('launch'),
    readProjectFile: async () => ({ content: '', mtimeMs: 11, binary: true, tooLarge: false, encoding: 'utf8' }),
    readEditorBackup: async () => null,
  };
  const { root, session } = await mountSession(api, 'docs/deck.pptx');
  try {
    assert.match(session.current.documentError, /converter missing/);
    assert.equal(session.current.documentPreview, null);
    assert.equal(session.current.load.binary, true);
    assert.equal(session.current.error, '');
    assert.deepEqual(launched, []);
  } finally {
    await act(async () => root.unmount());
  }
});

test('a remote document that cannot be converted keeps the binary notice', async (t) => {
  surface(t);
  const api = {
    previewDocumentPages: async () => {
      throw new Error('LibreOffice is not installed');
    },
    readProjectFile: async () => ({
      content: '',
      mtimeMs: 11,
      binary: true,
      tooLarge: false,
      encoding: 'utf8',
    }),
    readEditorBackup: async () => null,
  };
  const { root, session } = await mountSession(api, 'docs/budget.xlsx');
  try {
    assert.match(session.current.documentError, /LibreOffice/);
    assert.equal(session.current.preview, null);
    assert.equal(session.current.documentPreview, null);
    assert.equal(session.current.load.binary, true, 'the binary notice is what stays on screen');
    assert.equal(session.current.error, '', 'a missing viewer is not a load failure');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a PDF opens in the page viewer, never through the native preview', async (t) => {
  surface(t, true);
  const requested = [];
  const api = {
    previewProjectFile: async () => {
      throw new Error('the iframe preview must not be requested');
    },
    previewDocumentPages: async (_projectPath, _relPath, _accessToken, options) => {
      requested.push({ ...options });
      return { format: 'pdf', mtimeMs: 1, size: 2, pageCount: 2, pages: options.pages.map(renderedPage) };
    },
  };
  const { root, session } = await mountSession(api, 'docs/report.pdf');
  try {
    assert.deepEqual(
      requested.map((entry) => entry.pages),
      [[1]]
    );
    assert.equal(session.current.preview, null);
    assert.equal(session.current.documentPreview.format, 'pdf');
    await act(async () => session.current.loadDocumentPages([2], 2000));
    assert.equal(requested.at(-1).maxWidth, 2000, 'zoomed pages are requested at the wider resolution');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a PDF without the page API falls back to the binary notice, not an iframe', async (t) => {
  surface(t, true);
  const api = {
    previewProjectFile: async () => {
      throw new Error('the iframe preview must not be requested');
    },
    readProjectFile: async () => ({ content: '', mtimeMs: 11, binary: true, tooLarge: false, encoding: 'utf8' }),
    readEditorBackup: async () => null,
  };
  const { root, session } = await mountSession(api, 'docs/report.pdf');
  try {
    assert.equal(session.current.preview, null);
    assert.equal(session.current.documentPreview, null);
    assert.equal(session.current.load.binary, true);
  } finally {
    await act(async () => root.unmount());
  }
});

const revisionOf =
  (mtimeMs, size, pageCount = 3) =>
  (options) => ({
    format: 'docx',
    mtimeMs,
    size,
    pageCount,
    pages: options.pages.map(renderedPage),
  });

test('a page result of another revision replaces the preview instead of mixing with it', async (t) => {
  surface(t, true);
  let serve = revisionOf(1, 10);
  const api = { previewDocumentPages: async (_p, _r, _a, options) => serve(options) };
  const { root, session } = await mountSession(api, 'docs/report.docx');
  try {
    assert.deepEqual(
      session.current.documentPreview.pages.map((p) => p.page),
      [1]
    );
    serve = revisionOf(2, 10, 5);
    await act(async () => session.current.loadDocumentPages([2]));
    const preview = session.current.documentPreview;
    assert.equal(preview.mtimeMs, 2);
    assert.equal(preview.pageCount, 5);
    assert.deepEqual(
      preview.pages.map((p) => p.page),
      [2],
      'page 1 of the old revision is dropped'
    );
    serve = revisionOf(2, 11, 5);
    await act(async () => session.current.loadDocumentPages([3]));
    assert.equal(session.current.documentPreview.size, 11, 'a changed size is a new revision too');
    assert.deepEqual(
      session.current.documentPreview.pages.map((p) => p.page),
      [3]
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test('an edited document refreshes after the change is seen twice, keeping the viewer mounted', async (t) => {
  surface(t, true);
  const intervals = new Map();
  let nextId = 1;
  const original = [window.setInterval, window.clearInterval];
  window.setInterval = (callback, ms) => {
    if (ms !== 2500) return original[0].call(window, callback, ms);
    intervals.set(nextId, callback);
    return nextId++;
  };
  window.clearInterval = (id) => {
    if (!intervals.delete(id)) original[1].call(window, id);
  };
  t.after(() => {
    [window.setInterval, window.clearInterval] = original;
  });
  let disk = { mtimeMs: 1, size: 10 };
  const requests = [];
  const api = {
    statProjectFile: async () => ({ ...disk }),
    previewDocumentPages: async (_p, _r, _a, options) => {
      requests.push([...options.pages]);
      return revisionOf(disk.mtimeMs, disk.size)(options);
    },
  };
  const { root, session } = await mountSession(api, 'docs/report.docx');
  const poll = () => act(async () => Promise.all([...intervals.values()].map((tick) => tick())));
  try {
    await poll();
    assert.deepEqual(requests, [[1]], 'an unchanged file costs no page request');
    disk = { mtimeMs: 2, size: 12 };
    await poll();
    assert.deepEqual(requests, [[1]], 'the first sighting only waits (the file may still be written)');
    await poll();
    assert.deepEqual(requests, [[1], [1]]);
    assert.equal(session.current.documentPreview.mtimeMs, 2);
    assert.equal(session.current.documentPreview.size, 12);
    await poll();
    assert.equal(requests.length, 2, 'settled: no further requests');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a failed batch keeps the pages that arrived and Retry re-requests just that batch', async (t) => {
  surface(t, true);
  let fail = false;
  const requests = [];
  const api = {
    previewDocumentPages: async (_p, _r, _a, options) => {
      requests.push([...options.pages]);
      if (fail) throw new Error('rasterizer crashed');
      return revisionOf(1, 10)(options);
    },
  };
  const { root, session } = await mountSession(api, 'docs/report.docx');
  try {
    await act(async () => session.current.loadDocumentPages([2]));
    fail = true;
    await act(async () => session.current.loadDocumentPages([3, 4]));
    assert.deepEqual(
      session.current.documentPreview.pages.map((p) => p.page),
      [1, 2],
      'earlier pages stay'
    );
    assert.equal(session.current.documentError, '', 'a page failure is not a document failure');
    assert.deepEqual(Object.keys(session.current.documentPageErrors), ['3', '4']);
    assert.deepEqual(session.current.documentPageErrors[3].batch, [3, 4]);
    assert.match(session.current.documentPageErrors[3].message, /rasterizer crashed/);

    fail = false;
    const { batch } = session.current.documentPageErrors[3];
    await act(async () => session.current.loadDocumentPages(batch));
    assert.deepEqual(requests.at(-1), [3, 4]);
    assert.deepEqual(session.current.documentPageErrors, {});
    assert.deepEqual(
      session.current.documentPreview.pages.map((p) => p.page),
      [1, 2, 3, 4]
    );
  } finally {
    await act(async () => root.unmount());
  }
});

// ---- Office preview: "Install LibreOffice" in the failure note ----
async function mountFallback(api, relPath, { active = true } = {}) {
  window.mixdogDesktop = api;
  let setActive = () => {};
  function Harness() {
    const [paneActive, setPaneActive] = React.useState(active);
    setActive = setPaneActive;
    const editorRef = useRef(null);
    const syncLspRef = useRef(async () => false);
    const session = useEditorFileSession({
      editorRef,
      projectPath: 'C:/Project/demo',
      relPath,
      active: true,
      editorSettings: {},
      notifyReady() {},
      onDirty() {},
      syncLspRef,
    });
    if (session.documentPreview) return React.createElement('p', { id: 'pages' }, 'pages');
    if (!session.load) return null;
    return React.createElement(EditorPaneFileFallback, {
      breadcrumbs: null,
      load: session.load,
      note: session.documentError,
      officeMissing: session.documentOfficeMissing,
      password: session.documentPassword
        ? {
            ...session.documentPassword,
            onSubmit: session.unlockDocument,
            onCancel: session.cancelDocumentPassword,
          }
        : undefined,
      active: paneActive,
      onRetry: session.documentError ? session.reload : undefined,
      onOpen() {},
    });
  }
  const host = document.createElement('div');
  document.querySelector('main').append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Harness)));
  return { root, host, activate: (next) => act(async () => setActive(next)) };
}

function officeApi({ failure, install }) {
  const calls = { previews: 0, installs: 0, statusReads: 0, refreshes: [] };
  let installed = false;
  let reported = false;
  const api = {
    previewDocumentPages: async (_p, _r, _a, options) => {
      calls.previews += 1;
      if (!installed) throw new Error(failure);
      return { format: 'docx', mtimeMs: 1, size: 1, pageCount: 1, pages: options.pages.map(renderedPage) };
    },
    installLibreOffice: async () => {
      calls.installs += 1;
      const result = await install();
      installed = result.installed;
      return result;
    },
    // Like the host: a plain read answers from its cache (a stale "missing"
    // until something re-probes); only a refresh read sees the real state.
    libreOfficeStatus: async (refresh) => {
      calls.statusReads += 1;
      calls.refreshes.push(refresh);
      if (refresh === true) reported = installed;
      return { installed: reported };
    },
    readProjectFile: async () => ({ content: '', mtimeMs: 11, binary: true, tooLarge: false, encoding: 'utf8' }),
    readEditorBackup: async () => null,
  };
  // An install done outside Mixdog: only the backend changes, nothing is stored.
  const installOutside = () => {
    installed = true;
  };
  return { api, calls, installOutside };
}

function fakeClock(t) {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });
  return (ms) => {
    now += ms;
  };
}

const buttons = (host) => [...host.querySelectorAll('.editor-pane-notice-actions button')];
const installButton = (host) => host.querySelector('.editor-pane-notice button.primary');

test('Install LibreOffice shows only when no Office engine was found', async (t) => {
  surface(t, true);
  resetOfficeInstall();
  const missing = officeApi({
    failure: 'OFFICE_PREVIEW_UNAVAILABLE: no engine',
    install: async () => ({ installed: true }),
  });
  const first = await mountFallback(missing.api, 'docs/a.docx');
  const other = officeApi({ failure: 'converter missing', install: async () => ({ installed: true }) });
  const second = await mountFallback(other.api, 'docs/b.docx');
  try {
    assert.match(installButton(first.host).textContent, /Install LibreOffice/);
    assert.match(first.host.textContent, /Microsoft Office works too/);
    assert.equal(installButton(second.host), null, 'another failure offers no install');
    assert.equal(buttons(second.host).length, 2);
  } finally {
    await act(async () => first.root.unmount());
    await act(async () => second.root.unmount());
  }
});

test('Install LibreOffice runs the guided install, then retries the preview', async (t) => {
  surface(t, true);
  resetOfficeInstall();
  let finish;
  const { api, calls } = officeApi({
    failure: 'OFFICE_PREVIEW_UNAVAILABLE: no engine',
    install: () =>
      new Promise((resolve) => {
        finish = () => resolve({ installed: true, version: '25.2' });
      }),
  });
  const { root, host } = await mountFallback(api, 'docs/a.docx');
  try {
    await act(async () => installButton(host).click());
    assert.equal(calls.installs, 1);
    assert.match(installButton(host).textContent, /Installing…/);
    assert.equal(installButton(host).disabled, true);
    assert.ok(
      buttons(host).every((button) => button.disabled),
      'every button waits for the install'
    );
    assert.match(host.textContent, /few minutes/);
    const previewsBefore = calls.previews;
    await act(async () => finish());
    assert.equal(calls.previews, previewsBefore + 1, 'success retries the preview');
    assert.ok(host.querySelector('#pages'), 'the retried preview renders');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a failed install shows the error and offers Install again', async (t) => {
  surface(t, true);
  resetOfficeInstall();
  const { api, calls } = officeApi({
    failure: 'OFFICE_PREVIEW_UNAVAILABLE: no engine',
    install: async () => {
      throw new Error('winget exited with 1');
    },
  });
  const { root, host } = await mountFallback(api, 'docs/a.docx');
  try {
    await act(async () => installButton(host).click());
    assert.match(host.textContent, /winget exited with 1/);
    assert.match(host.textContent, /Extensions → Built-in → Office/);
    assert.match(installButton(host).textContent, /Install again/);
    assert.equal(installButton(host).disabled, false);
    assert.equal(calls.previews, 1, 'a failed install does not retry the preview');
  } finally {
    await act(async () => root.unmount());
  }
});

test('the phone surface hides the install button', async (t) => {
  surface(t);
  resetOfficeInstall();
  const { api } = officeApi({
    failure: 'OFFICE_PREVIEW_UNAVAILABLE: no engine',
    install: async () => ({ installed: true }),
  });
  const desktop = await mountFallback(api, 'docs/a.docx');
  document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
  t.after(() => document.documentElement.removeAttribute('data-mixdog-mobile-tabs'));
  const phone = await mountFallback(api, 'docs/b.docx');
  try {
    assert.ok(installButton(desktop.host), 'the same failure offers the button without the phone marker');
    assert.equal(installButton(phone.host), null);
    assert.ok(phone.host.querySelector('.editor-pane-notice'), 'the note itself stays');
  } finally {
    await act(async () => desktop.root.unmount());
    await act(async () => phone.root.unmount());
  }
});

test('an install outside Mixdog retries the failed preview when the window regains focus', async (t) => {
  surface(t, true);
  resetOfficeInstall();
  const advance = fakeClock(t);
  const { api, calls, installOutside } = officeApi({
    failure: 'OFFICE_PREVIEW_UNAVAILABLE: no engine',
    install: async () => ({ installed: true }),
  });
  const { root, host } = await mountFallback(api, 'docs/a.docx');
  try {
    assert.ok(installButton(host), 'the failed preview stays open');
    assert.equal(calls.statusReads, 1, 'showing the failed preview checked the engine once');
    installOutside();
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    assert.equal(calls.statusReads, 1, 'a focus right after the check is throttled');
    assert.equal(host.querySelector('#pages'), null);
    advance(10_000);
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    assert.equal(calls.statusReads, 2, 'the focus re-read the engine status');
    assert.deepEqual(calls.refreshes, [true, true], 'both reads asked the host to re-probe');
    assert.ok(host.querySelector('#pages'), 'the failed preview retried and renders');
    assert.equal(calls.installs, 0, 'nothing was installed from Mixdog');
  } finally {
    await act(async () => root.unmount());
  }
});

test('an install outside Mixdog retries the failed preview when its pane is activated', async (t) => {
  surface(t, true);
  resetOfficeInstall();
  const advance = fakeClock(t);
  const { api, calls, installOutside } = officeApi({
    failure: 'OFFICE_PREVIEW_UNAVAILABLE: no engine',
    install: async () => ({ installed: true }),
  });
  const { root, host, activate } = await mountFallback(api, 'docs/a.docx');
  try {
    await activate(false);
    installOutside();
    advance(10_000);
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    assert.equal(calls.statusReads, 1, 'a hidden pane does not re-check on focus');
    assert.equal(host.querySelector('#pages'), null);
    await activate(true);
    assert.equal(calls.statusReads, 2, 'activating the pane re-read the engine status');
    assert.ok(host.querySelector('#pages'), 'the failed preview retried and renders');
  } finally {
    await act(async () => root.unmount());
  }
});

test('an install done elsewhere clears the failure and retries the failed pane', async (t) => {
  surface(t, true);
  resetOfficeInstall();
  const { api, calls } = officeApi({
    failure: 'OFFICE_PREVIEW_UNAVAILABLE: no engine',
    install: async () => {
      throw new Error('winget exited with 1');
    },
  });
  const { root, host } = await mountFallback(api, 'docs/a.docx');
  try {
    await act(async () => installButton(host).click());
    assert.match(installButton(host).textContent, /Install again/);
    const previewsBefore = calls.previews;
    // Settings (or a fresh status read) records LibreOffice as installed.
    api.previewDocumentPages = async (_p, _r, _a, options) => ({
      format: 'docx',
      mtimeMs: 1,
      size: 1,
      pageCount: 1,
      pages: options.pages.map(renderedPage),
    });
    await act(async () => {
      storeDesktopStatus(api, 'libreOffice', { installed: true });
    });
    assert.equal(calls.installs, 1, 'the pane did not install again');
    assert.ok(host.querySelector('#pages'), 'the failed pane retried and now renders');
    assert.equal(calls.previews, previewsBefore, 'the retry used the replaced reader');
  } finally {
    await act(async () => root.unmount());
  }
});

// ---- Password-protected documents ----
function protectedApi(password) {
  const requests = [];
  const api = {
    previewDocumentPages: async (_p, _r, _a, options) => {
      requests.push(options);
      // As the IPC rejection arrives: Electron's prefix, then the runtime's coded text.
      if (!options.password) {
        throw new Error(
          "Error invoking remote method 'mixdog:preview-document-pages': Error: This file is password-protected and can't be previewed. (OFFICE_PREVIEW_PASSWORD_PROTECTED)"
        );
      }
      if (options.password !== password) {
        throw new Error(
          "Error invoking remote method 'mixdog:preview-document-pages': Error: That password didn't work. (OFFICE_PREVIEW_WRONG_PASSWORD)"
        );
      }
      return { format: 'docx', mtimeMs: 1, size: 1, pageCount: 1, pages: options.pages.map(renderedPage) };
    },
    libreOfficeStatus: async () => ({ installed: true }),
    readProjectFile: async () => ({ content: '', mtimeMs: 11, binary: true, tooLarge: false, encoding: 'utf8' }),
    readEditorBackup: async () => null,
  };
  return { api, requests };
}

const passwordField = (host) => host.querySelector('.editor-pane-password input[type="password"]');
const buttonNamed = (host, name) => buttons(host).find((button) => button.textContent.trim() === name);

async function typeAndSubmit(host, value) {
  const input = passwordField(host);
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  // react-dom loaded before this file's DOM existed, so it watches text fields
  // the no-input-event way: a focused field whose value changed by a key.
  await act(async () => {
    input.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
    setValue.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.KeyboardEvent('keyup', { bubbles: true }));
  });
  assert.equal(buttonNamed(host, 'Open').disabled, false, 'a typed password can be submitted');
  await act(async () => buttonNamed(host, 'Open').click());
}

test('a protected document asks for its password, says when one is wrong, and opens with the right one', async (t) => {
  surface(t, true);
  const { api, requests } = protectedApi('Correct horse');
  const { root, host } = await mountFallback(api, 'docs/secret.docx');
  try {
    assert.ok(passwordField(host), 'the protected failure shows a password field');
    assert.match(host.textContent, /This file is password-protected\. Enter its password to preview it\./);
    assert.equal(buttonNamed(host, 'Retry'), undefined, 'Open replaces Retry while the question is open');
    assert.equal(buttonNamed(host, 'Open').disabled, true, 'nothing to submit yet');
    assert.deepEqual(requests, [{ pages: [1] }], 'the first request carries no password');

    await typeAndSubmit(host, 'wrong guess');
    assert.deepEqual(requests[1], { pages: [1], password: 'wrong guess' }, 'submitting re-requests with the password');
    assert.match(host.textContent, /That password didn't work\./);
    assert.ok(passwordField(host), 'the field stays for another try');
    assert.equal(passwordField(host).value, '', 'the field does not keep the password');
    assert.equal(host.querySelector('#pages'), null);

    await typeAndSubmit(host, 'Correct horse');
    assert.deepEqual(requests[2], { pages: [1], password: 'Correct horse' });
    assert.ok(host.querySelector('#pages'), 'the right password opens the preview');
  } finally {
    await act(async () => root.unmount());
  }
});

test('Cancel closes the password question and keeps the protected-file notice', async (t) => {
  surface(t, true);
  const { api, requests } = protectedApi('Correct horse');
  const { root, host } = await mountFallback(api, 'docs/secret.xlsx');
  try {
    await act(async () => buttonNamed(host, 'Cancel').click());
    assert.equal(passwordField(host), null);
    assert.match(host.textContent, /This file is password-protected and can't be previewed\./);
    assert.ok(buttonNamed(host, 'Retry'), 'Retry asks again');
    assert.equal(requests.length, 1, 'cancelling sends nothing');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a protected file no password can open, or one that needs Microsoft Office, offers no password field', async (t) => {
  surface(t, true);
  for (const [code, text] of [
    ['OFFICE_PREVIEW_PASSWORD_UNSUPPORTED', /This file is password-protected and can't be previewed\./],
    ['OFFICE_PREVIEW_PASSWORD_CORRUPT', /This file is password-protected and can't be previewed\./],
    ['OFFICE_PREVIEW_PASSWORD_NEEDS_OFFICE', /Previewing this password-protected file needs Microsoft Office\./],
  ]) {
    const api = {
      ...protectedApi('x').api,
      previewDocumentPages: async () => {
        throw new Error(`Engine text (${code})`);
      },
    };
    const { root, host } = await mountFallback(api, 'docs/old.pptx');
    try {
      assert.equal(passwordField(host), null, code);
      assert.match(host.textContent, text);
    } finally {
      await act(async () => root.unmount());
    }
  }
});
