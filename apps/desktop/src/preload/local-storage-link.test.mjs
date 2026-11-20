import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_IPC } from '../shared/contract-ipc.ts';
import { createLinkWatch, restoreRescuedLocalStorage } from './local-storage-link.ts';

/** A started watch (its first probe is out) over what a test says is heard of each probe: `page` the page's own,
 *  `backend` an acknowledgement. */
function link({ replacement = false } = {}) {
  const state = { probes: 0, lost: 0 };
  const watch = createLinkWatch({
    replacement,
    probe: () => {
      state.probes += 1;
    },
    lost: () => {
      state.lost += 1;
    },
  });
  watch.tick();
  /** Runs `periods` periods: what is `heard` of the probe that is out, then the tick that judges it. */
  const run = (periods, heard) => {
    for (let i = 0; i < periods; i += 1) {
      if (heard.page) watch.heard('page');
      if (heard.backend) watch.heard('backend');
      watch.tick();
    }
  };
  return { state, run, watch };
}
const UP = { page: true, backend: true };
const SILENT = { page: true, backend: false };
const DEAF = { page: false, backend: false };

test('two_periods_in_a_row_with_the_page_heard_and_no_acknowledgement_are_a_loss_reported_once', () => {
  const { state, run } = link();
  run(3, UP);
  run(1, SILENT);
  assert.equal(state.lost, 0, 'one silent period is not a loss');
  run(1, SILENT);
  assert.equal(state.lost, 1);
  const probes = state.probes;
  run(3, SILENT);
  assert.equal(state.lost, 1, 'it is reported once');
  assert.equal(state.probes, probes, 'a lost link is not written to again');
});

test('an_acknowledgement_that_comes_late_still_counts_for_the_period_it_comes_in', () => {
  const { state, run } = link();
  run(2, UP);
  run(1, SILENT);
  // The answer to an earlier probe arrives after the next one was sent: the backend answered in this period.
  run(1, UP);
  run(1, SILENT);
  assert.equal(state.lost, 0, 'the silent period before the answer does not count');
  run(1, SILENT);
  assert.equal(state.lost, 1);
});

test('a_period_in_which_the_page_itself_was_not_heard_says_nothing_about_the_link', () => {
  const { state, run } = link();
  run(2, UP);
  run(10, DEAF);
  assert.equal(state.lost, 0, 'a busy page, or a frame that hears nothing, is not a lost link');
  run(1, SILENT);
  run(1, DEAF);
  run(1, SILENT);
  assert.equal(state.lost, 1, 'the silent periods on either side of it are in a row');
});

test('a_link_that_was_silent_from_the_first_probe_is_lost_too', () => {
  const { state, run } = link();
  run(3, SILENT);
  assert.equal(state.lost, 1, 'a page loaded into a process whose link was already gone');
});

test('a_replacement_whose_link_never_answered_is_not_replaced_again_but_one_that_answered_is', () => {
  const dead = link({ replacement: true });
  dead.run(6, SILENT);
  assert.equal(dead.state.lost, 0, 'another process would not connect either');
  assert.equal(dead.state.probes, 2, 'and it is not written to again');
  const alive = link({ replacement: true });
  alive.run(2, UP);
  alive.run(2, SILENT);
  assert.equal(alive.state.lost, 1);
});

/** A page storage over `held`, refusing a write to any key in `full`. */
function pageStorage(held = {}, full = []) {
  const values = new Map(Object.entries(held));
  return {
    values,
    setItem: (key, value) => {
      if (full.includes(key)) throw new Error('QuotaExceededError');
      values.set(key, value);
    },
    clear: () => values.clear(),
  };
}
const taking = (answer, sent = []) => ({
  sendSync: (channel) => (sent.push(channel), answer),
  send: (channel) => sent.push(channel),
});
const RESCUED = [['draft', 'v2'], ['layout', '{}']];

test('the_storage_becomes_the_rescue_and_main_is_told_and_no_rescue_leaves_it_alone', () => {
  const sent = [];
  const untouched = pageStorage({ a: '1' });
  assert.equal(restoreRescuedLocalStorage(taking(null, sent), untouched), 'none');
  assert.deepEqual([...untouched.values], [['a', '1']]);
  assert.deepEqual(sent.splice(0), [DESKTOP_IPC.takeLocalStorageRescue]);
  // The backend still holds what it had at the loss: an older draft, and a key the page deleted since.
  const storage = pageStorage({ draft: 'v1', deleted: 'x' });
  assert.equal(restoreRescuedLocalStorage(taking(RESCUED, sent), storage), 'whole');
  assert.deepEqual([...storage.values], RESCUED);
  assert.deepEqual(sent, [DESKTOP_IPC.takeLocalStorageRescue, DESKTOP_IPC.localStorageRestored]);
});

test('a_storage_that_refused_the_rescue_leaves_it_with_main', () => {
  const sent = [];
  assert.equal(restoreRescuedLocalStorage(taking(RESCUED, sent), pageStorage({}, ['layout'])), 'refused');
  assert.deepEqual(sent, [DESKTOP_IPC.takeLocalStorageRescue], 'main is not told, so the next page load takes it again');
});
