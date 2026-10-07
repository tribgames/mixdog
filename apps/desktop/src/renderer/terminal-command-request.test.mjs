import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useEffect } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import MarkdownAstBody from './MarkdownAstBody';
import { parseMarkdownToHast } from './markdown-ast';
import { MarkdownSessionContext } from './MarkdownLink';
import {
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
