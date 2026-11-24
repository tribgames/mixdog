import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { engineLane } from '../host/browser-engine/engine-lane.test-helper.mjs';
import { createBrowserBackgroundPages } from './guest-background-pages.ts';
import { BrowserGuestStateStore } from './host-state.ts';
import { createBrowserLocalPrompts } from './local-prompts.ts';
import { createRefUpload } from './ref-upload.ts';
import { BrowserSessionRegistry } from './session-registry.ts';
import { BACKGROUND_PAGE_IDLE_MS, FINISHED_TURN_PAGE_IDLE_MS } from './tab-policy.ts';

/** One session's agent tabs, with the prompt a person answers on them. Every
 *  page's renderer is hung: a script sent to it never answers. */
function harness() {
  const sessions = new BrowserSessionRegistry();
  const state = new BrowserGuestStateStore();
  const scripts = { sent: 0 };
  let nextId = 0;
  const pages = createBrowserBackgroundPages(
    { sessions, state, isBackgroundBusy: () => false },
    {
      create: () => ({
        window: {
          destroyed: false,
          isDestroyed() {
            return this.destroyed;
          },
          destroy() {
            this.destroyed = true;
          },
          once() {},
        },
        guest: {
          id: ++nextId,
          isDestroyed: () => false,
          executeJavaScriptInIsolatedWorld() {
            scripts.sent += 1;
            return new Promise(() => {});
          },
        },
      }),
      initialize() {},
    }
  );
  const uploads = createRefUpload({
    pendingFileChooser: (guest) => state.for(guest).pendingFileChooser,
    clearFileChooser: (guest) => (state.for(guest).pendingFileChooser = null),
    cdp: { call: async (_guest, _method, _params, _signal, options = {}) => options.beforeDispatch?.() },
  });
  const prompts = createBrowserLocalPrompts({
    state,
    controller: (guest) => sessions.sessionIdForGuest(guest),
    dialogs: {},
    uploads,
    chooseFiles: async () => ({ canceled: false, filePaths: [fileURLToPath(import.meta.url)] }),
  });
  /** The person looks at the agent's tab and answers the file chooser it opened. */
  const chooseFile = (tab, chooser = { backendNodeId: 7 }) => {
    sessions.selectGuest('s', tab.guest);
    state.for(tab.guest).pendingFileChooser = { mode: 'selectSingle', openedAt: 0, ...chooser };
    const requestId = prompts.describe(tab.guest).fileChooser.id;
    return prompts.answer(tab.guest, { type: 'choose-files', requestId }, () => {});
  };
  return { sessions, state, pages, scripts, chooseFile, open: (name) => pages.ensureOffscreen('s', name) };
}

test("a file a person chose in the agent's tab keeps the tab once they switch away; a failed choice does not", async () => {
  const h = harness();
  const chosen = h.open('chosen');
  const failed = h.open('failed');
  const pressed = h.open('pressed');
  const elsewhere = h.open('elsewhere');

  await h.chooseFile(chosen);
  await assert.rejects(h.chooseFile(failed, { backendNodeId: undefined }), /no target element/);
  h.sessions.selectGuest('s', pressed.guest);
  h.state.for(pressed.guest).userInput = true;
  // The person switches to another tab; the turn ends and its wait runs out.
  h.sessions.selectGuest('s', elsewhere.guest);
  const finishedAt = Date.now();
  h.sessions.beginTurn('s', 1);
  h.sessions.finishTurn('s', 1, finishedAt);
  h.pages.sweep(finishedAt + FINISHED_TURN_PAGE_IDLE_MS);

  assert.equal(chosen.window.isDestroyed(), false, 'the attached file is still there');
  assert.equal(failed.window.isDestroyed(), true, 'nothing was attached');
  assert.equal(pressed.window.isDestroyed(), true, 'a press alone left no work');
  assert.equal(elsewhere.window.isDestroyed(), false, 'shown to the person');
});

test("a form the agent filled keeps its tab while the turn waits on the user, and not once the turn ends", async () => {
  const h = harness();
  // The agent's `fill`, as the engine sends it: the page function sets the value and answers what the field holds.
  const lane = engineLane({ state: h.state, evaluate: async () => ({ ok: true, value: { value: 'Ada Lovelace' } }) });
  const filled = h.open('filled');
  const idle = h.open('idle');
  const startedAt = Date.now();
  h.sessions.beginTurn('s', 1);
  await lane.refCall(filled.guest, { edits: true, args: ['Ada Lovelace'] });
  assert.equal(h.state.for(filled.guest).userEdits, false, 'the agent’s edit is not the person’s');

  // The turn asks the user and waits well past the live-turn idle time.
  h.pages.sweep(startedAt + BACKGROUND_PAGE_IDLE_MS + 5 * 60_000);
  assert.equal(filled.window.isDestroyed(), false, 'the filled form is kept for the turn');
  assert.equal(idle.window.isDestroyed(), true, 'an unedited tab is not');

  const finishedAt = startedAt + BACKGROUND_PAGE_IDLE_MS + 6 * 60_000;
  h.sessions.finishTurn('s', 1, finishedAt);
  h.pages.sweep(finishedAt);
  assert.equal(filled.window.isDestroyed(), true, 'once the turn ended the long-idle tab is reclaimed');
});

test('a hung renderer never holds a sweep up: due pages close within the call, nothing is asked of them', () => {
  const h = harness();
  const idle = h.open('idle');
  const finishedAt = Date.now();
  h.sessions.beginTurn('s', 1);
  h.sessions.finishTurn('s', 1, finishedAt);
  h.pages.sweep(finishedAt + FINISHED_TURN_PAGE_IDLE_MS);
  assert.equal(idle.window.isDestroyed(), true);
  assert.equal(h.scripts.sent, 0);
});
