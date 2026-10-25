import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useEffect } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import MarkdownAstBody from './MarkdownAstBody';
import { parseMarkdownToHast } from './markdown-ast';
import { MarkdownSessionContext } from './MarkdownLink';
import { TERMINAL_SHOWN_WAIT_MS } from '../shared/terminal-command';
import { activeSessionTerminalId, getSessionTerminalTabs, releaseSessionTerminalTabs } from './session-terminal-tabs';
import {
  handleTerminalRunRequest,
  markTerminalShown,
  onTerminalCommandRequested,
  onTerminalRevealRequested,
  requestTerminalCommand,
  sessionTerminalId,
  terminalCommandInput,
} from './terminal-command-request';

const CopyControl = () => null;

test('a command enters each line in turn and ends with Enter', () => {
  assert.equal(terminalCommandInput('npm test'), 'npm test\r');
  assert.equal(terminalCommandInput('cd app\r\nnpm test\n\n'), 'cd app\rnpm test\r');
});

test('a command reveals the session terminal and waits until that terminal takes it', () => {
  const revealed = [];
  const stopReveal = onTerminalRevealRequested((sessionId) => revealed.push(sessionId));
  try {
    requestTerminalCommand('sess-1', 'npm test');
    requestTerminalCommand('sess-1', 'git status');
    assert.deepEqual(revealed, ['sess-1', 'sess-1']);
    const entered = [];
    const stop = onTerminalCommandRequested(sessionTerminalId('sess-1'), (input) => entered.push(input));
    assert.deepEqual(entered, ['npm test\r', 'git status\r']);
    requestTerminalCommand('sess-1', 'ls');
    assert.deepEqual(entered, ['npm test\r', 'git status\r', 'ls\r']);
    stop();
    // Another session's terminal never receives it; blank commands are ignored.
    const other = [];
    requestTerminalCommand('sess-1', '   ');
    onTerminalCommandRequested(sessionTerminalId('sess-2'), (input) => other.push(input))();
    assert.deepEqual(other, []);
  } finally {
    stopReveal();
  }
});

test('only shell code blocks in a session get a Run control, which sends the code', async (t) => {
  const { dom, root } = installTestDom(t, { rootId: 'root' });
  const revealed = [];
  const stopReveal = onTerminalRevealRequested((sessionId) => revealed.push(sessionId));
  t.after(stopReveal);
  const text = ['```powershell\nGet-ChildItem\n```', '```js\nconsole.log(1)\n```'].join('\n\n');
  const render = (sessionId) =>
    act(async () => {
      root.render(
        React.createElement(
          MarkdownSessionContext.Provider,
          { value: sessionId },
          React.createElement(MarkdownAstBody, { root: parseMarkdownToHast(text), copyControl: CopyControl })
        )
      );
    });
  await render('');
  assert.equal(dom.window.document.querySelectorAll('.markdown-code-run').length, 0);
  await render('sess-run');
  const buttons = dom.window.document.querySelectorAll('.markdown-code-run');
  assert.equal(buttons.length, 1);
  await act(async () => {
    buttons[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  assert.deepEqual(revealed, ['sess-run']);
  const entered = [];
  onTerminalCommandRequested(sessionTerminalId('sess-run'), (input) => entered.push(input))();
  assert.deepEqual(entered, ['Get-ChildItem\r']);
});

test('Run controls follow a terminal host registered after the first render', async (t) => {
  const { dom, root } = installTestDom(t, { rootId: 'root' });
  const ast = parseMarkdownToHast('```powershell\nGet-ChildItem\n```');
  function Host({ enabled }) {
    useEffect(() => {
      if (enabled) return onTerminalRevealRequested(() => {});
    }, [enabled]);
    return React.createElement(
      MarkdownSessionContext.Provider,
      { value: 'sess-late-host' },
      React.createElement(MarkdownAstBody, { root: ast, copyControl: CopyControl })
    );
  }
  const render = (enabled) => act(async () => root.render(React.createElement(Host, { enabled })));
  const buttons = () => dom.window.document.querySelectorAll('.markdown-code-run').length;

  await render(true);
  assert.equal(buttons(), 1);
  await render(false);
  assert.equal(buttons(), 0);
  await render(true);
  assert.equal(buttons(), 1);
});

function withWindow(claims, delays = []) {
  const previous = globalThis.window;
  globalThis.window = {
    setTimeout: (callback, delay) => (delays.push(delay), globalThis.setTimeout(callback, delay)),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    mixdogDesktop: { claimTerminalRun: async (requestId) => (claims.push(requestId), true) },
  };
  return () => {
    globalThis.window = previous;
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("an agent run builds this device's tab list from main, selects the target tab and reveals the dock", () => {
  const sid = 'sess-agent-tabs';
  const first = sessionTerminalId(sid);
  const revealed = [];
  const stopReveal = onTerminalRevealRequested((sessionId) => revealed.push(sessionId));
  try {
    // This device only knows tab 1; main runs tabs 1 and 3 and ran the command in 3.
    assert.deepEqual(
      getSessionTerminalTabs(sid).tabs.map((tab) => tab.id),
      [first]
    );
    handleTerminalRunRequest({
      sessionId: sid,
      terminalId: `${first}:3`,
      tabs: [
        { id: first, tab: 1, cwd: '/a' },
        { id: `${first}:3`, tab: 3, cwd: '/c' },
      ],
    });
    assert.deepEqual(
      getSessionTerminalTabs(sid).tabs.map((tab) => tab.id),
      [first, `${first}:3`]
    );
    assert.equal(getSessionTerminalTabs(sid).tabs[1].cwd, '/c');
    assert.equal(activeSessionTerminalId(sid), `${first}:3`);
    assert.deepEqual(revealed, [sid]);
    // No command is queued for a pane: the process already has it.
    const entered = [];
    onTerminalCommandRequested(`${first}:3`, (input) => entered.push(input))();
    assert.deepEqual(entered, []);
    // A tab never lists a foreign or mismatched terminal.
    handleTerminalRunRequest({
      sessionId: sid,
      terminalId: 'session-terminal:other',
      tabs: [{ id: 'session-terminal:other', tab: 1 }],
    });
    assert.deepEqual(
      getSessionTerminalTabs(sid).tabs.map((tab) => tab.id),
      [first, `${first}:3`]
    );
  } finally {
    stopReveal();
    releaseSessionTerminalTabs(sid);
  }
});

test('main is told the run is shown only once a pane shows that terminal', async () => {
  const sid = 'sess-agent-shown';
  const terminalId = sessionTerminalId(sid);
  const claims = [];
  const restore = withWindow(claims);
  const stopReveal = onTerminalRevealRequested(() => {});
  try {
    handleTerminalRunRequest({ sessionId: sid, terminalId, requestId: 'r-late' });
    await settle();
    assert.deepEqual(claims, [], 'no pane shows it yet');
    // The dock opens in response to the reveal and its pane mounts.
    const unmark = markTerminalShown(terminalId);
    await settle();
    assert.deepEqual(claims, ['r-late']);
    handleTerminalRunRequest({ sessionId: sid, terminalId, requestId: 'r-now' });
    await settle();
    assert.deepEqual(claims, ['r-late', 'r-now'], 'already shown claims at once');
    unmark();
    // A relayed reveal (a phone) carries no request id and claims nothing.
    handleTerminalRunRequest({ sessionId: sid, terminalId });
    await settle();
    assert.deepEqual(claims, ['r-late', 'r-now']);
  } finally {
    restore();
    stopReveal();
    releaseSessionTerminalTabs(sid);
  }
});

test('the renderer watches for a pane for the shared wait that main also counts on', async () => {
  const delays = [];
  const restore = withWindow([], delays);
  const stopReveal = onTerminalRevealRequested(() => {});
  try {
    handleTerminalRunRequest({ sessionId: 'sess-wait', terminalId: sessionTerminalId('sess-wait'), requestId: 'r' });
    assert.deepEqual(delays, [TERMINAL_SHOWN_WAIT_MS]);
    assert.equal(TERMINAL_SHOWN_WAIT_MS > 1000, true, 'a pane appearing after one second still counts');
  } finally {
    restore();
    stopReveal();
    releaseSessionTerminalTabs('sess-wait');
  }
});
