import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activeSessionTerminalId,
  closeSessionTerminalTab,
  getSessionTerminalTabs,
  openSessionTerminalTab,
  releaseSessionTerminalTabs,
  selectSessionTerminalTab,
  sessionTerminalId,
} from './session-terminal-tabs.ts';
import { loadShellProfiles } from './terminal-shell-profiles.ts';
import { onTerminalCommandRequested, requestTerminalCommand } from './terminal-command-request.ts';

const collect = (terminalId) => {
  const entered = [];
  const stop = onTerminalCommandRequested(terminalId, (input) => entered.push(input));
  return { entered, stop };
};

test('tabs use the fixed id contract and never reuse a number', () => {
  const sid = 'tabs-ids';
  const first = sessionTerminalId(sid);
  assert.deepEqual(
    getSessionTerminalTabs(sid).tabs.map((tab) => tab.id),
    [first]
  );
  const second = openSessionTerminalTab(sid, 'pwsh');
  const third = openSessionTerminalTab(sid);
  assert.equal(second.id, `${first}:2`);
  assert.equal(second.shell, 'pwsh');
  assert.equal(third.id, `${first}:3`);
  assert.equal(getSessionTerminalTabs(sid).activeId, third.id);
  assert.equal(closeSessionTerminalTab(sid, second.id), second.id);
  assert.equal(openSessionTerminalTab(sid).id, `${first}:4`);
  assert.deepEqual(releaseSessionTerminalTabs(sid), [first, third.id, `${first}:4`]);
});

test('closing the last tab leaves one fresh default tab', () => {
  const sid = 'tabs-last';
  const first = sessionTerminalId(sid);
  assert.equal(closeSessionTerminalTab(sid, first), first);
  const { tabs, activeId } = getSessionTerminalTabs(sid);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].shell, '');
  assert.equal(tabs[0].id, `${first}:2`);
  assert.equal(activeId, tabs[0].id);
  assert.equal(closeSessionTerminalTab(sid, 'unknown'), null);
  releaseSessionTerminalTabs(sid);
});

test('closing the active tab activates its neighbour', () => {
  const sid = 'tabs-neighbour';
  const first = sessionTerminalId(sid);
  const second = openSessionTerminalTab(sid);
  const third = openSessionTerminalTab(sid);
  closeSessionTerminalTab(sid, third.id);
  assert.equal(activeSessionTerminalId(sid), second.id);
  selectSessionTerminalTab(sid, first);
  closeSessionTerminalTab(sid, second.id);
  assert.equal(activeSessionTerminalId(sid), first);
  releaseSessionTerminalTabs(sid);
});

test('terminal command requests are delivered to the active tab', () => {
  const sid = 'tabs-route';
  const first = sessionTerminalId(sid);
  const one = collect(first);
  const second = openSessionTerminalTab(sid);
  const two = collect(second.id);
  requestTerminalCommand(sid, 'ls');
  assert.deepEqual(one.entered, []);
  assert.deepEqual(two.entered, ['ls\r']);
  selectSessionTerminalTab(sid, first);
  requestTerminalCommand(sid, 'pwd');
  assert.deepEqual(one.entered, ['pwd\r']);
  assert.deepEqual(two.entered, ['ls\r']);

  // Input for a tab whose pane is not attached yet waits for that pane.
  const third = openSessionTerminalTab(sid);
  requestTerminalCommand(sid, 'whoami');
  const late = collect(third.id);
  assert.deepEqual(late.entered, ['whoami\r']);
  for (const sub of [one, two, late]) sub.stop();
  releaseSessionTerminalTabs(sid);
});

test('shell profiles distinguish failed, empty-ready and ready, and a failure retries', async () => {
  const previous = globalThis.window;
  let answer;
  globalThis.window = { mixdogDesktop: { termProfiles: () => answer() } };
  try {
    answer = () => Promise.reject(new Error('ipc'));
    assert.deepEqual(await loadShellProfiles(), { status: 'failed' });
    answer = () => Promise.resolve(null);
    assert.deepEqual(await loadShellProfiles(), { status: 'failed' });
    answer = () => Promise.resolve([]);
    assert.deepEqual(await loadShellProfiles(), { status: 'ready', profiles: [] });
    const list = [{ id: 'pwsh', label: 'PowerShell', path: 'pwsh', default: true }];
    answer = () => Promise.resolve(list);
    assert.deepEqual(await loadShellProfiles(), { status: 'ready', profiles: list });
    answer = () => Promise.reject(new Error('cached answer must win'));
    assert.deepEqual(await loadShellProfiles(), { status: 'ready', profiles: list });
  } finally {
    globalThis.window = previous;
  }
});
