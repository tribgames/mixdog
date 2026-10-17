// The phone-side download UI (GitHub #40): what chat links and generated media
// ask the host for, the transfer panel's retry/cancel/share behavior, and the
// action's gating on old hosts.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { DESKTOP_TOAST_EVENT } from './desktop-toasts.tsx';
import { FileDownloadError } from '../shared/file-downloads.ts';
import { startFileDownload } from './file-download-panel.tsx';
import {
  MarkdownLink,
  MarkdownOpenFileContext,
  MarkdownProjectContext,
  MarkdownSessionContext,
  MarkdownTranscriptItemContext,
} from './MarkdownLink.tsx';
import { installTestDom } from './test-support/test-dom.mjs';
import { TranscriptArtifacts } from './transcript-artifacts-ui.tsx';

const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

/** A host whose `authorize` records the request and refuses `not-linked`. */
function refusingDownloads({ available = true } = {}) {
  const requests = [];
  return {
    requests,
    api: {
      available: () => available,
      authorize: async (request) => {
        requests.push(request);
        throw new FileDownloadError('not-linked', 'No reply links that file.');
      },
      begin: async () => assert.fail('never begins'),
      readRange: async () => assert.fail('never reads'),
      finish: async () => assert.fail('never finishes'),
      abort: async () => true,
    },
  };
}

function setup(t, api = {}) {
  const view = installTestDom(t, { rootId: 'root' });
  view.window.mixdogRemoteServer = 'https://relay.test';
  view.window.mixdogDesktop = api;
  const toasts = [];
  view.window.addEventListener(DESKTOP_TOAST_EVENT, (event) => toasts.push(event.detail.text));
  const doc = view.document;
  const panel = () => doc.querySelector('.file-downloads');
  const rowStatus = () => panel()?.querySelector('.file-download-status')?.textContent ?? null;
  const button = (label) => doc.querySelector(`button[aria-label="${label}"]`);
  const click = (element) =>
    act(async () => {
      element.dispatchEvent(new view.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  const render = async (element) => {
    await act(async () => view.root.render(element));
    await tick();
  };
  return { ...view, doc, toasts, panel, rowStatus, button, click, render };
}

const withContexts = (children, { session = 's1', item = '', project = 'C:/work' } = {}) =>
  React.createElement(
    MarkdownProjectContext.Provider,
    { value: project },
    React.createElement(
      MarkdownSessionContext.Provider,
      { value: session },
      React.createElement(MarkdownTranscriptItemContext.Provider, { value: item }, children)
    )
  );

async function dismissAll(f) {
  for (const close of f.doc.querySelectorAll('.file-downloads button[aria-label^="Dismiss"]')) await f.click(close);
  assert.equal(f.panel(), null);
}

test('a reply link downloads by its transcript row; a refusal stays as a reason', async (t) => {
  const host = refusingDownloads();
  const f = setup(t, { fileDownloads: host.api });
  await f.render(
    withContexts(React.createElement(MarkdownLink, { href: 'C:/out/build.zip' }, 'build'), { item: 'row-7' })
  );
  await f.click(f.doc.querySelector('a'));
  await tick();
  assert.deepEqual(host.requests, [
    { source: { kind: 'link', sessionId: 's1', itemId: 'row-7', href: 'C:/out/build.zip' }, purpose: 'save' },
  ]);
  assert.equal(f.rowStatus(), 'Only files this conversation links can be downloaded.');
  assert.equal(f.panel().querySelector('[role="alert"]') !== null, true);
  assert.equal(f.button('Retry download of build.zip'), null, 'a refusal no retry can change offers none');
  await dismissAll(f);
});

test('outside a reply row a project file downloads by its project path', async (t) => {
  const host = refusingDownloads();
  const f = setup(t, { fileDownloads: host.api });
  await f.render(withContexts(React.createElement(MarkdownLink, { href: 'dist/app.zip' }, 'dist/app.zip')));
  await f.click(f.doc.querySelector('a'));
  await tick();
  assert.deepEqual(host.requests, [
    { source: { kind: 'project', sessionId: 's1', relPath: 'dist/app.zip' }, purpose: 'save' },
  ]);
  await dismissAll(f);
});

test('outside a reply row and the project a file downloads as a path the conversation references', async (t) => {
  const host = refusingDownloads();
  const f = setup(t, { fileDownloads: host.api });
  await f.render(
    withContexts(React.createElement(MarkdownLink, { href: 'C:/Temp/tool%20out/build.zip' }, 'build'), {
      project: 'C:/work',
    })
  );
  await f.click(f.doc.querySelector('a'));
  await tick();
  assert.deepEqual(host.requests, [
    { source: { kind: 'session', sessionId: 's1', path: 'C:/Temp/tool out/build.zip' }, purpose: 'save' },
  ]);
  assert.deepEqual(f.toasts, [], 'no refusal before the host was asked');
  await dismissAll(f);
});

test('the link menu offers Download / Share, disabled with the reason on an old host', async (t) => {
  const host = refusingDownloads({ available: false });
  const f = setup(t, { fileDownloads: host.api });
  await f.render(withContexts(React.createElement(MarkdownLink, { href: 'C:/out/build.zip' }, 'build'), { item: 'r' }));
  await act(async () => {
    f.doc
      .querySelector('a')
      .dispatchEvent(
        new f.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 })
      );
  });
  const item = f.doc.querySelector('[data-action-id="download"]');
  assert.equal(item.textContent, 'Download / Share');
  assert.equal(item.disabled, true);
  assert.equal(item.title, 'Update Mixdog on the PC to download its files.');
  // A tap reports the same reason instead of a dead end, and asks nothing.
  await f.click(f.doc.querySelector('a'));
  assert.deepEqual(f.toasts, ['Update Mixdog on the PC to download its files.']);
  assert.deepEqual(host.requests, []);
  assert.equal(f.panel(), null);
});

test('opening a linked text file names the conversation when resolving its path', async (t) => {
  const resolved = [];
  const opened = [];
  const f = setup(t, {
    fileDownloads: refusingDownloads().api,
    resolveLocalPaths: async (paths, sessionId) => {
      resolved.push([paths, sessionId]);
      return [{ absolutePath: paths[0], dir: false, projectPath: 'C:/out', relPath: 'notes.md', accessToken: 'tok' }];
    },
  });
  await f.render(
    React.createElement(
      MarkdownOpenFileContext.Provider,
      { value: (...args) => opened.push(args) },
      withContexts(React.createElement(MarkdownLink, { href: 'C:/out/notes.md' }, 'notes'), { item: 'r' })
    )
  );
  await f.click(f.doc.querySelector('a'));
  await tick();
  assert.deepEqual(resolved, [[['C:/out/notes.md'], 's1']]);
  assert.deepEqual(opened, [['C:/out', 'notes.md', undefined, 'tok']]);
});

const mediaItem = {
  kind: 'tool',
  name: 'media',
  args: { action: 'generate', kind: 'image' },
  result: { ok: true, assetId: 'asset-1', output: 'C:/media/sunset.png' },
};

test('generated media downloads its asset; an old host disables the action with its reason', async (t) => {
  const host = refusingDownloads();
  const f = setup(t, { fileDownloads: host.api, mediaUrl: (id, variant) => `https://relay.test/m/${id}/${variant}` });
  await f.render(withContexts(React.createElement(TranscriptArtifacts, { items: [mediaItem] })));
  assert.equal(f.button('Open file'), null, 'the host-only open action is gone');
  const download = f.button('Download / Share');
  assert.equal(download.getAttribute('aria-disabled'), null);
  await f.click(download);
  await tick();
  assert.deepEqual(host.requests, [
    { source: { kind: 'media', sessionId: 's1', assetId: 'asset-1' }, purpose: 'save' },
  ]);
  await dismissAll(f);

  host.api.available = () => false;
  await act(async () => f.root.render(null));
  await f.render(withContexts(React.createElement(TranscriptArtifacts, { items: [mediaItem] })));
  const blocked = f.button('Download / Share');
  assert.equal(blocked.getAttribute('aria-disabled'), 'true');
  assert.equal(blocked.dataset.tooltip, 'Update Mixdog on the PC to download its files.');
  await f.click(blocked);
  assert.equal(host.requests.length, 1, 'nothing was asked of the old host');
  assert.deepEqual(f.toasts, ['Update Mixdog on the PC to download its files.']);
});

/** A scripted environment for the panel itself. */
function scriptedEnv({ authorize, sink = { kind: 'browser' }, deliver = async () => 'saved', size = 4 }) {
  const calls = [];
  const transfer = {
    transferId: 't1',
    name: 'report.pdf',
    size,
    mime: 'application/pdf',
    version: 'v',
    expiresAt: 0,
    rangeMaxBytes: 4,
  };
  return {
    calls,
    env: {
      api: {
        available: () => true,
        authorize: (request) => {
          calls.push('authorize');
          return authorize(request);
        },
        begin: async () => transfer,
        readRange: async (_id, offset, length) => ({
          transferId: 't1',
          offset,
          length,
          data: Buffer.alloc(length, 1).toString('base64'),
          version: 'v',
          eof: offset + length >= size,
        }),
        finish: async () => ({ transferId: 't1', size, version: 'v' }),
        abort: async (id) => {
          calls.push(`abort:${id}`);
          return true;
        },
      },
      sink: async () => sink,
      laneUrl: () => null,
      probeLane: async () => 'unavailable',
      deliver,
    },
  };
}

const grant = { grantId: 'g1', name: 'report.pdf', size: 4, mime: 'application/pdf', version: 'v', expiresAt: 0 };

test('a failed download stays with its reason until Retry succeeds; Dismiss clears it', async (t) => {
  const f = setup(t);
  let attempt = 0;
  const { env, calls } = scriptedEnv({
    authorize: async () => {
      attempt += 1;
      if (attempt === 1) throw new FileDownloadError('busy', 'busy');
      return grant;
    },
  });
  await act(async () =>
    startFileDownload({ kind: 'project', sessionId: 's1', relPath: 'report.pdf' }, 'report.pdf', env)
  );
  await tick();
  assert.equal(f.rowStatus(), 'Too many downloads are running. Wait for one to finish.');
  await f.click(f.button('Retry download of report.pdf'));
  await tick();
  assert.deepEqual(calls, ['authorize', 'authorize'], 'each try asks for a fresh grant');
  assert.equal(f.rowStatus(), 'Download started');
  assert.equal(f.panel().querySelector('[role="alert"]'), null);
  await dismissAll(f);
});

test('a finished folder zip says in one line what it left out; nothing when it left out nothing', async (t) => {
  const f = setup(t);
  const note = () => f.panel().querySelector('.file-download-note')?.textContent ?? null;
  const run = async (leftOut) => {
    const { env } = scriptedEnv({ authorize: async () => ({ ...grant, name: 'src.zip', leftOut }) });
    await act(async () => startFileDownload({ kind: 'folder', sessionId: 's1', path: 'src' }, 'src.zip', env));
    await tick();
  };
  await run({ ignored: 14200, secret: 3 });
  assert.equal(f.rowStatus(), 'Download started');
  assert.equal(note(), `Left out ${(14200).toLocaleString()} ignored files and 3 secret files`);
  await dismissAll(f);
  await run({ ignored: 0, secret: 2 });
  assert.equal(note(), 'Left out 2 secret files');
  await dismissAll(f);
  await run({ ignored: 0, secret: 0 });
  assert.equal(note(), null);
  await dismissAll(f);
  await run({ ignored: 0, secret: 0, pages: { included: 8, total: 23 } });
  assert.equal(note(), 'Included the first 8 of 23 pages');
  await dismissAll(f);
});

test('Cancel removes the row and releases a grant that arrives afterwards', async (t) => {
  const f = setup(t);
  let resolveGrant;
  const { env, calls } = scriptedEnv({
    authorize: () =>
      new Promise((resolve) => {
        resolveGrant = () => resolve(grant);
      }),
  });
  await act(async () =>
    startFileDownload({ kind: 'project', sessionId: 's1', relPath: 'report.pdf' }, 'report.pdf', env)
  );
  assert.equal(f.rowStatus(), 'Preparing download…');
  const progress = f.panel().querySelector('progress');
  const label = f.doc.getElementById(progress.getAttribute('aria-labelledby'));
  assert.equal(label?.textContent, 'report.pdf', 'the progress bar is named by its file');
  await f.click(f.button('Cancel download of report.pdf'));
  await tick();
  assert.equal(f.panel(), null, 'a cancel is not a failure');
  resolveGrant();
  await tick();
  assert.deepEqual(calls, ['authorize', 'abort:g1']);
});

/** A native shell with scripted finish and share answers. */
function nativeShell({ persisted, shares = [{ ok: false, error: 'cancelled' }], finish } = {}) {
  const shared = [];
  const call = async (method, args) => {
    if (method === 'fileSaveBegin') return { ok: true, handle: 'h' };
    if (method === 'fileSaveWrite') return { ok: true, handle: 'h', written: args.offset + 4 };
    if (method === 'fileSaveFinish') {
      if (finish) await finish();
      return {
        ok: true,
        handle: 'h',
        displayName: 'report.pdf',
        size: 4,
        ...(persisted === undefined ? {} : { persisted }),
      };
    }
    if (method === 'fileSaveShare') {
      shared.push(args.handle);
      return shares.shift();
    }
    return null;
  };
  return { call, shared };
}

test('a dismissed share sheet is not a failure', async (t) => {
  const f = setup(t);
  for (const persisted of [undefined, true]) {
    const shell = nativeShell({ persisted });
    const native = scriptedEnv({ authorize: async () => grant, sink: { kind: 'native', call: shell.call } });
    await act(async () =>
      startFileDownload({ kind: 'media', sessionId: 's1', assetId: 'a' }, 'report.pdf', native.env)
    );
    await tick();
    assert.equal(f.rowStatus(), 'Saved to this device', 'the file is saved even though nothing was shared');
    assert.equal(f.panel().querySelector('[role="alert"]'), null);
    assert.equal(f.button('Share report.pdf again'), null);
    await dismissAll(f);
  }

  const browser = scriptedEnv({ authorize: async () => grant, deliver: async () => 'dismissed' });
  await act(async () => startFileDownload({ kind: 'media', sessionId: 's1', assetId: 'a' }, 'report.pdf', browser.env));
  await tick();
  assert.equal(f.panel(), null, 'a browser share the user closed leaves no row and no error');
});

test('a file kept only in staging is never called saved: it waits for Share again', async (t) => {
  const f = setup(t);
  const shell = nativeShell({
    persisted: false,
    shares: [
      { ok: true, shared: false },
      { ok: false, error: 'cancelled' },
      { ok: true, shared: true },
    ],
  });
  const native = scriptedEnv({ authorize: async () => grant, sink: { kind: 'native', call: shell.call } });
  await act(async () => startFileDownload({ kind: 'media', sessionId: 's1', assetId: 'a' }, 'report.pdf', native.env));
  await tick();
  assert.equal(f.rowStatus(), 'Not saved yet — share it to keep it');
  assert.equal(f.panel().querySelector('[role="alert"]'), null);
  await f.click(f.button('Share report.pdf again'));
  await tick();
  assert.equal(f.rowStatus(), 'Not saved yet — share it to keep it', 'a second dismissal keeps the row');
  await f.click(f.button('Share report.pdf again'));
  await tick();
  assert.equal(f.rowStatus(), 'Shared');
  assert.deepEqual(shell.shared, ['h', 'h', 'h'], 'every share names the finished handle');
  assert.equal(f.button('Share report.pdf again'), null);
  await dismissAll(f);

  const expiring = nativeShell({
    persisted: false,
    shares: [
      { ok: true, shared: false },
      { ok: false, error: 'unknown-handle' },
    ],
  });
  const expired = scriptedEnv({ authorize: async () => grant, sink: { kind: 'native', call: expiring.call } });
  await act(async () => startFileDownload({ kind: 'media', sessionId: 's1', assetId: 'a' }, 'report.pdf', expired.env));
  await tick();
  await f.click(f.button('Share report.pdf again'));
  await tick();
  assert.equal(f.rowStatus(), 'The unsaved copy on this device expired. Download it again.');
  assert.ok(f.button('Retry download of report.pdf'));
  await dismissAll(f);

  const dismissed = nativeShell({ persisted: false, shares: [{ ok: true, shared: false }] });
  const leaving = scriptedEnv({ authorize: async () => grant, sink: { kind: 'native', call: dismissed.call } });
  await act(async () => startFileDownload({ kind: 'media', sessionId: 's1', assetId: 'a' }, 'report.pdf', leaving.env));
  await tick();
  await dismissAll(f);
});

test('a cancel during the native finish reports a kept file without sharing it', async (t) => {
  const f = setup(t);
  let release;
  const shell = nativeShell({
    persisted: true,
    finish: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const native = scriptedEnv({ authorize: async () => grant, sink: { kind: 'native', call: shell.call } });
  await act(async () => startFileDownload({ kind: 'media', sessionId: 's1', assetId: 'a' }, 'report.pdf', native.env));
  await tick();
  assert.equal(f.rowStatus(), 'Saving on this device…');
  await f.click(f.button('Cancel download of report.pdf'));
  release();
  await tick();
  assert.equal(f.rowStatus(), 'Cancelled after the file was already saved to this device.');
  assert.deepEqual(shell.shared, []);
  await dismissAll(f);
});
