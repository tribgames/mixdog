import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { activeSessionTerminalId, getSessionTerminalTabs, releaseSessionTerminalTabs } from './session-terminal-tabs.ts';
import { onTerminalRevealRequested } from './terminal-command-request.ts';
import { desktopToolActivityTerminalRuns } from './transcript-tool-core.ts';
import { TerminalPeekLines } from './terminal-peek-line.tsx';
import { ToolActivityGroup } from './TranscriptView.tsx';

const run = (id, command, result) => ({
  kind: 'tool',
  id,
  name: 'terminal',
  args: { action: 'run', command },
  result,
  completedAt: 1,
});
const REPLY = (terminalId) =>
  `Terminal run: ${terminalId} · 2 pwsh running C:\\work · cursor=42\nCommand sent to the side terminal.\nThe terminal is running in the background; no pane shows it right now.`;

test('only a run whose reply names its terminal leaves a card; a pending call leaves none', () => {
  const items = [
    run('a', 'npm test', REPLY('session-terminal:sess-1:2')),
    { ...run('b', 'ls', 'Error: no terminal tab 5'), isError: true },
    { kind: 'tool', id: 'c', name: 'terminal', args: { action: 'read', tab: 1 }, result: 'Terminal: x', completedAt: 1 },
    { kind: 'tool', id: 'd', name: 'terminal', args: { action: 'run', command: 'pwd' }, completedAt: 0 },
  ];
  assert.deepEqual(desktopToolActivityTerminalRuns(items), [
    { id: 'a', command: 'npm test', terminalId: 'session-terminal:sess-1:2' },
  ]);
  // A reply without a terminal id (an odd result) is not a started run either.
  assert.deepEqual(desktopToolActivityTerminalRuns([run('e', 'ls', 'ok')]), []);
});

test('the "터미널 · 명령 · 보기" card selects the run\'s terminal tab and reveals the session terminal', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const previous = new Map(
    ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.mixdogDesktop = {};
  const sid = 'sess-1';
  const revealed = [];
  const root = createRoot(dom.window.document.getElementById('root'));
  try {
    // No dock can be revealed yet: no card.
    const items = [run('a', 'npm test', REPLY(`session-terminal:${sid}:2`))];
    await act(async () => root.render(React.createElement(TerminalPeekLines, { items, sessionId: sid })));
    assert.equal(dom.window.document.querySelector('.transcript-terminal-peek'), null);

    let stop = () => {};
    await act(async () => {
      stop = onTerminalRevealRequested((sessionId) => revealed.push(sessionId));
    });
    try {
      await act(async () =>
        root.render(React.createElement(ToolActivityGroup, { items, disclosureScope: sid }))
      );
      const card = dom.window.document.querySelector('.transcript-terminal-peek');
      assert.ok(card, 'the tool group carries a terminal card');
      assert.equal(card.textContent, 'Terminal·npm test·View');
      assert.equal(activeSessionTerminalId(sid), `session-terminal:${sid}`);
      await act(async () => card.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
      assert.deepEqual(revealed, [sid]);
      assert.equal(activeSessionTerminalId(sid), `session-terminal:${sid}:2`);
      assert.deepEqual(getSessionTerminalTabs(sid).tabs.map((tab) => tab.n), [1, 2]);

      // A draft has no dock to open.
      await act(async () => root.render(React.createElement(TerminalPeekLines, { items, sessionId: 'new-task' })));
      assert.equal(dom.window.document.querySelector('.transcript-terminal-peek'), null);
    } finally {
      await act(async () => stop());
    }
  } finally {
    releaseSessionTerminalTabs(sid);
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});


