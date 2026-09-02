import assert from 'node:assert/strict';
import test from 'node:test';

import { BROWSER_ACTIONS } from '../../../../../../src/runtime/browser-bridge/browser-action-contract.mjs';
import { TABLESS_ACTIONS } from '../command.ts';
import { BROWSER_ACTION_HANDLERS, browserActionHandler, PAGE_ACTIONS } from './index.ts';

test('every page-addressed contract action resolves to exactly one handler', () => {
  const missing = PAGE_ACTIONS.filter((action) => typeof browserActionHandler(action) !== 'function');
  assert.deepEqual(missing, []);
  const extra = Object.keys(BROWSER_ACTION_HANDLERS).filter((action) => !PAGE_ACTIONS.includes(action));
  assert.deepEqual(extra, []);
});

test('session bookkeeping actions stay out of the page registry', () => {
  for (const action of TABLESS_ACTIONS) {
    assert.ok(BROWSER_ACTIONS.includes(action), `${action} is a contract action`);
    assert.equal(browserActionHandler(action), undefined);
  }
});

test('unknown and prototype names never resolve to a handler', () => {
  assert.equal(browserActionHandler('teleport'), undefined);
  assert.equal(browserActionHandler('constructor'), undefined);
  assert.equal(browserActionHandler('__proto__'), undefined);
});
