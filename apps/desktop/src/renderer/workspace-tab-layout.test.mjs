// Consecutive closes inside the exit beat (Ctrl+Q held down): the ghosts keep
// the slots they closed from, so no node changes place and no neighbour's
// width transition restarts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { tabsWithClosingGhosts } from './workspace-tab-layout.ts';

const tab = (key) => ({ key, title: key });
const keys = (display) => display.map((entry) => `${entry.closing ? '~' : ''}${entry.tab.key}`);

function strip(initial) {
  const previousTabs = { current: initial };
  const closingTabs = { current: new Map() };
  const enteringKeys = { current: new Set() };
  return (tabs, activeKey = null) => {
    const display = tabsWithClosingGhosts(tabs, previousTabs, closingTabs, enteringKeys, activeKey);
    previousTabs.current = tabs;
    return display;
  };
}

test('a close inside a running exit keeps every ghost in its slot', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(tab);
  const render = strip([a, b, c, d]);
  assert.deepEqual(keys(render([a, b, d])), ['a', 'b', '~c', 'd']);
  assert.deepEqual(keys(render([a, b])), ['a', 'b', '~c', '~d']);
});

test('closing leftwards inside a running exit keeps the earlier ghost in place', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(tab);
  const render = strip([a, b, c, d]);
  assert.deepEqual(keys(render([a, b, d])), ['a', 'b', '~c', 'd']);
  assert.deepEqual(keys(render([a, d])), ['a', '~b', '~c', 'd']);
  assert.deepEqual(keys(render([d])), ['~a', '~b', '~c', 'd']);
});

test('a ghost whose predecessor was replaced keeps its place before its follower', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(tab);
  const x = tab('x');
  const render = strip([a, b, c, d]);
  assert.deepEqual(keys(render([a, b, d])), ['a', 'b', '~c', 'd']);
  assert.deepEqual(keys(render([a, x, d])), ['a', 'x', '~c', 'd']);
});

test('a single close still leaves one ghost in its slot', () => {
  const [a, b, c] = ['a', 'b', 'c'].map(tab);
  const render = strip([a, b, c]);
  assert.deepEqual(keys(render([a, c])), ['a', '~b', 'c']);
});
