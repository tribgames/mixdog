import assert from 'node:assert/strict';
import test from 'node:test';

import {
  markScreenHelperNoticeShown,
  SCREEN_HELPER_NOTICE_KEY,
  screenHelperNoticeDue,
  screenHelperPanel,
  screenHelperSheetShown,
} from './remote-screen-helper.ts';

const PC_A = 'a'.repeat(32);
const PC_B = 'b'.repeat(32);
const block = (patch = {}) => ({ offer: 'none', outcome: null, detail: null, issue: null, secure: null, ...patch });
const live = { kind: 'live', control: true };
const blockedView = { kind: 'blocked', reason: 'uac', dim: true };
const memory = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), map };
};
const panelFor = (offer) => screenHelperPanel(block({ offer }), false);

test('the notice is due once on a live view when the PC offers an install', () => {
  const storage = memory();
  const panel = panelFor('install');
  assert.equal(screenHelperNoticeDue(live, panel, storage, PC_A), true);
  markScreenHelperNoticeShown(storage, PC_A);
  assert.equal(storage.map.get(`${SCREEN_HELPER_NOTICE_KEY}@${PC_A}`), '1');
  assert.equal(screenHelperNoticeDue(live, panel, storage, PC_A), false);
  // Another PC on the same origin's storage is a first open of its own.
  assert.equal(screenHelperNoticeDue(live, panel, storage, PC_B), true);
});

test('the notice is not due when installed, unsupported, updating or already blocked', () => {
  const storage = memory();
  assert.equal(screenHelperNoticeDue(live, panelFor('none'), storage, PC_A), false);
  assert.equal(screenHelperNoticeDue(live, screenHelperPanel(null, false), storage, PC_A), false);
  assert.equal(screenHelperNoticeDue(live, panelFor('update'), storage, PC_A), false);
  assert.equal(screenHelperNoticeDue(blockedView, panelFor('install'), storage, PC_A), false);
  assert.equal(screenHelperNoticeDue({ kind: 'connecting' }, panelFor('install'), storage, PC_A), false);
  assert.equal(storage.map.size, 0);
});

test('a dismissed notice stays gone, and unreadable storage never nags', () => {
  const storage = memory();
  markScreenHelperNoticeShown(storage, PC_A);
  assert.equal(screenHelperNoticeDue(live, panelFor('install'), storage, PC_A), false);
  const broken = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(screenHelperNoticeDue(live, panelFor('install'), broken, PC_A), false);
  assert.doesNotThrow(() => markScreenHelperNoticeShown(broken, PC_A));
  assert.equal(screenHelperNoticeDue(live, panelFor('install'), null, PC_A), false);
});

test("the notice's button opens the existing install sheet over the live view", () => {
  const base = { open: true, blocked: false, fromNotice: true, action: 'install' };
  assert.equal(screenHelperSheetShown(base), true);
  assert.equal(screenHelperSheetShown({ ...base, fromNotice: false }), false);
  assert.equal(screenHelperSheetShown({ ...base, blocked: true, fromNotice: false }), true);
  assert.equal(screenHelperSheetShown({ ...base, action: null }), false);
  assert.equal(screenHelperSheetShown({ ...base, open: false }), false);
});
