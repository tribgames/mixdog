// Project-file downloads outside the transcript take their owning session
// explicitly: phone sessions stay mounted after a switch, so no global
// "current session" may decide whose project a download resolves against.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useContext } from 'react';

import { FileDownloadError } from '../shared/file-downloads.ts';
import { DESKTOP_TOAST_EVENT } from './desktop-toasts.tsx';
import { MarkdownSessionContext } from './MarkdownLink.tsx';
import { DownloadSessionContext, startFolderDownload, startProjectFileDownload } from './project-file-download.ts';
import { installTestDom } from './test-support/test-dom.mjs';

const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

function setup(t) {
  const view = installTestDom(t, { rootId: 'root' });
  const requests = [];
  view.window.mixdogRemoteServer = 'https://relay.test';
  view.window.mixdogDesktop = {
    fileDownloads: {
      available: () => true,
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
  const toasts = [];
  view.window.addEventListener(DESKTOP_TOAST_EVENT, (event) => toasts.push(event.detail.text));
  const click = (element) =>
    act(async () => {
      element.dispatchEvent(new view.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  return { ...view, requests, toasts, click };
}

/** A retained phone conversation: always mounted, shown only while current. */
function RetainedSession({ id, shown }) {
  return React.createElement(
    'section',
    { id, hidden: !shown },
    React.createElement(
      MarkdownSessionContext.Provider,
      { value: id },
      React.createElement(Download, { label: `file of ${id}` })
    )
  );
}

function Download({ label }) {
  const sessionId = useContext(MarkdownSessionContext);
  return React.createElement(
    'button',
    { type: 'button', onClick: () => void startProjectFileDownload(sessionId, 'a.txt') },
    label
  );
}

test('a download from a retained session after switching back resolves against that session', async (t) => {
  const f = setup(t);
  const screen = (shown) =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement(RetainedSession, { id: 'A', shown: shown === 'A' }),
      React.createElement(RetainedSession, { id: 'B', shown: shown === 'B' })
    );
  for (const shown of ['A', 'B', 'A']) {
    await act(async () => f.root.render(screen(shown)));
    await tick();
  }
  await f.click(f.document.querySelector('#A button'));
  await tick();
  assert.deepEqual(f.requests, [{ source: { kind: 'project', sessionId: 'A', relPath: 'a.txt' }, purpose: 'save' }]);
});

test('surfaces outside the transcript download as the pane session', async (t) => {
  const f = setup(t);
  function PaneFile() {
    const sessionId = useContext(DownloadSessionContext);
    return React.createElement(
      'button',
      { type: 'button', onClick: () => void startFolderDownload(sessionId, 'C:/work/dist') },
      'zip'
    );
  }
  await act(async () =>
    f.root.render(React.createElement(DownloadSessionContext.Provider, { value: 'A' }, React.createElement(PaneFile)))
  );
  await f.click(f.document.querySelector('button'));
  await tick();
  assert.deepEqual(f.requests, [{ source: { kind: 'folder', sessionId: 'A', path: 'C:/work/dist' }, purpose: 'save' }]);
});

test('a download without an owning session is refused before asking the host', async (t) => {
  const f = setup(t);
  await startProjectFileDownload('', 'a.txt');
  assert.deepEqual(f.requests, []);
  assert.equal(f.toasts.length, 1);
});
