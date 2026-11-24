import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  expose: ['HTMLElement', 'navigator'],
});
const { DesktopErrorBoundary, componentFrames, errorFrames } = await import('./RendererRecovery.tsx');

// A render failure the boundary caught was recorded by name and fingerprint alone: the log of an installed build could not say where
// it failed or in which conversation. It now carries the error's frames, React's component stack and the selected conversation.
test('a render failure caught by the boundary records where it failed and the selected conversation, never its text', async (t) => {
  const told = [];
  window.mixdogDesktop = { rendererDiagnostic: (payload) => told.push(payload) };
  t.after(() => {
    delete window.mixdogDesktop;
  });
  t.mock.method(console, 'error', () => {});
  function Broken({ broken }) {
    if (broken) throw new RangeError('Invalid array length for user@example.com');
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host, { onCaughtError() {} });
  t.after(() => act(() => root.unmount()));
  // A window that is up fails on an update of its tree, as the installed build's did.
  const render = (broken) =>
    act(async () =>
      root.render(
        React.createElement(
          DesktopErrorBoundary,
          null,
          React.createElement(
            'nav',
            null,
            React.createElement('div', { className: 'session-row selected', 'data-session-id': 'sess_selected' }),
            React.createElement('div', { className: 'session-row', 'data-session-id': 'sess_other' })
          ),
          React.createElement('section', null, React.createElement(Broken, { broken }))
        )
      )
    );
  await render(false);
  await render(true);
  assert.ok(host.querySelector('.desktop-recovery-screen'), 'the boundary caught it');
  const report = told.find((payload) => payload.phase === 'boundary');
  assert.ok(report, 'the failure was reported');
  assert.equal(report.errorName, 'RangeError');
  assert.equal(report.sessionId, 'sess_selected');
  assert.ok(report.stack.length > 0, 'the error stack is recorded');
  assert.match(report.stack[0], /^Broken@renderer-boundary-diagnostic\.test\.mjs:\d+:\d+$/, 'as frames, file names only');
  assert.ok(
    report.componentStack.some((frame) => frame.startsWith('Broken')),
    `the component stack is recorded: ${report.componentStack}`
  );
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /user@example\.com|Invalid array length/, 'the message is not recorded');
  assert.doesNotMatch(text, /[\\/]/, 'no directory of the files is recorded');
});

test('stack frames keep the function, the file name and the position; a component without a location keeps its name', () => {
  const error = new RangeError('Invalid array length');
  error.stack =
    'RangeError: Invalid array length\n    at Le (file:///C:/Program%20Files/Mixdog/resources/app.asar/out/renderer/assets/react-vendor-C.js:8:1234)\n    at file:///C:/x/MarkdownBody-CL.js:6:77';
  assert.deepEqual(errorFrames(error), ['Le@react-vendor-C.js:8:1234', '<anonymous>@MarkdownBody-CL.js:6:77']);
  assert.deepEqual(componentFrames('\n    at MarkdownBody (file:///C:/x/MarkdownBody-CL.js:6:77)\n    at Panel'), [
    'MarkdownBody@MarkdownBody-CL.js:6:77',
    'Panel',
  ]);
});

// A message that runs over several lines is part of the stack's header: a line of it that reads like a frame was recorded, its
// directories run together ("Usersalicesecret-project").
test('no line of the message is read as a frame, and a frame without a position is no frame', () => {
  const error = new Error('could not open\n    at /Users/alice/secret-project\n    at /Users/alice/notes.md:3:4');
  error.stack = `${String(error)}\n    at render (file:///C:/x/Panel-A.js:10:2)\n    at /Users/alice/secret-project`;
  assert.deepEqual(errorFrames(error), ['render@Panel-A.js:10:2']);
  assert.deepEqual(componentFrames('\n    at /Users/alice/secret-project\n    at Panel'), ['Panel']);
});
