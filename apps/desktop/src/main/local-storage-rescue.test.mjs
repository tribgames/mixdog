import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { DESKTOP_IPC } from '../shared/contract-ipc.ts';
import { createLocalStorageRescue, registerLocalStorageRescueIpc } from './local-storage-rescue.ts';

function rescue() {
  const seen = { ended: 0, reports: [] };
  const made = createLocalStorageRescue({
    endRenderer: () => {
      seen.ended += 1;
    },
    report: (details) => seen.reports.push(details),
  });
  return { seen, rescue: made };
}
const VALUES = [
  ['layout', '{"a":1}'],
  ['draft', '안녕'],
];

test('a_lost_page_ends_its_process_and_its_values_are_given_until_a_page_made_them_its_storage', () => {
  const { seen, rescue: made } = rescue();
  assert.equal(made.take(), null, 'a page that loads with nothing rescued takes nothing');
  made.lost(VALUES);
  assert.equal(seen.ended, 1);
  assert.deepEqual(seen.reports, [{ keys: 2, chars: 20 }]);
  assert.equal(made.exited(), true, 'the exit that follows is the replacement');
  assert.equal(made.exited(), false, 'a later exit is a failure again');
  assert.deepEqual(made.take(), VALUES);
  assert.deepEqual(made.take(), VALUES, 'taking does not give the rescue up: a page that could not write it leaves it');
  made.restored();
  assert.equal(made.take(), null, 'no later page restores it over newer storage');
});

test('a_later_loss_is_the_rescue_from_then_on_holding_what_that_page_reported', () => {
  const { rescue: made } = rescue();
  made.lost(VALUES);
  made.restored();
  // The replacement lost its link in turn; its report is the whole of what it held, a deleted key left out.
  const later = [
    ['layout', '{"a":2}'],
    ['new', 'x'],
  ];
  made.lost(later);
  assert.deepEqual(made.take(), later);
});

test('only_pairs_of_text_are_kept', () => {
  const { rescue: made } = rescue();
  made.lost([['a', '1'], ['b', 2], ['c'], 'd', null, ['e', '5', 'x']]);
  assert.deepEqual(made.take(), [['a', '1']]);
});

test('only_the_windows_own_page_is_heard_and_a_call_not_acted_on_is_answered', () => {
  const { seen, rescue: made } = rescue();
  const webContents = { mainFrame: {} };
  const ipcMain = new EventEmitter();
  const dispose = registerLocalStorageRescueIpc({ window: { webContents }, ipcMain, rescue: made });
  const own = () => ({ sender: webContents, senderFrame: webContents.mainFrame, returnValue: undefined });
  const other = () => ({ sender: {}, senderFrame: {}, returnValue: undefined });
  const stranger = other();
  ipcMain.emit(DESKTOP_IPC.localStorageLost, stranger, VALUES);
  assert.equal(seen.ended, 0);
  assert.equal(stranger.returnValue, null, 'a blocked caller that is not this page is let go');
  const losing = own();
  ipcMain.emit(DESKTOP_IPC.localStorageLost, losing, VALUES);
  assert.equal(seen.ended, 1);
  assert.equal(losing.returnValue, undefined, 'the losing page is not answered: its process ends');
  const asking = other();
  ipcMain.emit(DESKTOP_IPC.takeLocalStorageRescue, asking);
  assert.equal(asking.returnValue, null);
  const taking = own();
  ipcMain.emit(DESKTOP_IPC.takeLocalStorageRescue, taking);
  assert.deepEqual(taking.returnValue, VALUES);
  ipcMain.emit(DESKTOP_IPC.localStorageRestored, other());
  assert.deepEqual(made.take(), VALUES, 'another page cannot say the rescue was written back');
  ipcMain.emit(DESKTOP_IPC.localStorageRestored, own());
  assert.equal(made.take(), null);
  dispose();
  assert.equal(ipcMain.listenerCount(DESKTOP_IPC.takeLocalStorageRescue), 0);
});

test('a_window_with_no_rescue_answers_every_blocking_call', () => {
  const webContents = { mainFrame: {} };
  const ipcMain = new EventEmitter();
  registerLocalStorageRescueIpc({ window: { webContents }, ipcMain });
  const taking = { sender: webContents, senderFrame: webContents.mainFrame, returnValue: undefined };
  ipcMain.emit(DESKTOP_IPC.takeLocalStorageRescue, taking);
  assert.equal(taking.returnValue, null);
  const losing = { sender: webContents, senderFrame: webContents.mainFrame, returnValue: undefined };
  ipcMain.emit(DESKTOP_IPC.localStorageLost, losing, VALUES);
  assert.equal(losing.returnValue, null);
});
