import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
const { overrideConfirmAction } = await import('./app-confirm.tsx');

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Element', 'Node', 'navigator'],
});
const { createRoot } = await import('react-dom/client');
// A coarse primary pointer keeps the search field from auto-focusing.
window.matchMedia = (query) => ({
  matches: query.includes('coarse'),
  addEventListener() {},
  removeEventListener() {},
});
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
HTMLElement.prototype.scrollIntoView = () => {};
Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });

const calls = [];
let menuReply;
let projectMenuReply;
let handlers = {};
window.mixdogDesktop = {
  rendererDiagnostic() {},
  async invokeCapability(request) {
    calls.push(request);
    if (handlers[request.capability]) return { value: await handlers[request.capability](request), snapshot: null };
    if (request.capability === 'getBranchMenu') return { value: menuReply, snapshot: null };
    if (request.capability === 'getProjectBranchMenu') return { value: projectMenuReply, snapshot: null };
    throw new Error('WORKTREE_NOT_IMPLEMENTED');
  },
};

const { BranchChip } = await import('./BranchChip.tsx');
const { clearBranchMenuCache } = await import('./branch-menu.tsx');
const model = await import('./worktree-branch-model.ts');
const { initUiLanguage, setUiLanguagePreference } = await import('./i18n.ts');
const { SourceControlBranchPicker } = await import('./source-control-branch-picker.tsx');

const branch = (name, current = false) => ({ name, current, remote: false, upstream: '' });
const workspace = (over = {}) => ({
  projectPath: '/p',
  repoCommonDir: '/p/.git',
  cwd: '/p',
  worktreeId: null,
  branch: 'main',
  baseCommit: null,
  mergeTarget: 'main',
  revision: 3,
  transition: { state: 'idle', txId: null },
  ...over,
});
const menuFor = (over = {}) => ({
  workspace: workspace(),
  branches: [branch('main', true), branch('feat/ssh-remote'), branch('next-patch'), branch('ext-branch')],
  occupancy: [
    { branch: 'main', kind: 'current' },
    { branch: 'feat/ssh-remote', kind: 'session', sessionId: 'other-session' },
    { branch: 'next-patch', kind: 'free' },
    { branch: 'ext-branch', kind: 'external', path: '/elsewhere/ext' },
  ],
  retainedWorktree: null,
  ...over,
});
/** A Project menu with no session (getProjectBranchMenu): revision 0, real occupancy. */
const draftMenu = () =>
  menuFor({
    workspace: workspace({ revision: 0 }),
    branches: [branch('main', true), branch('dev'), branch('mixdog/held')],
    occupancy: [
      { branch: 'main', kind: 'current' },
      { branch: 'dev', kind: 'free' },
      { branch: 'mixdog/held', kind: 'session', sessionId: 'holder' },
    ],
  });
const rect = (top = 600) => ({ x: 300, y: top, left: 300, right: 460, top, bottom: top + 28, width: 160, height: 28 });

async function mount(t, props = {}, { keepCache = false, gate = null } = {}) {
  calls.length = 0;
  handlers = gate
    ? {
        getBranchMenu: async () => {
          await gate.promise;
          return menuReply;
        },
      }
    : {};
  if (!keepCache) clearBranchMenuCache();
  menuReply ??= menuFor();
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const opened = [];
  await act(async () =>
    root.render(
      React.createElement(BranchChip, {
        sessionId: 's1',
        draftId: '',
        projectPath: '/p',
        ...props,
      })
    )
  );
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const anchor = host.querySelector('.composer-branch-context');
  if (anchor) anchor.getBoundingClientRect = () => rect();
  return { host, opened, trigger: host.querySelector('.branch-chip-trigger') };
}
const openMenu = async (trigger) => {
  await act(async () => trigger.click());
  return document.querySelector('.branch-menu');
};
const items = (menu) => [...menu.querySelectorAll('.branch-menu-item')];
const settle = () => act(async () => {});
const typeBranchName = async (input, value) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
};
const pressBranchKey = async (input, key, options = {}) => {
  await act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, ...options })));
};

for (const draft of [false, true]) {
  test(`new branch opens a name dialog without native prompt (${draft ? 'draft' : 'session'})`, async (t) => {
    setUiLanguagePreference('en');
    await initUiLanguage();
    menuReply = menuFor();
    projectMenuReply = draftMenu();
    const prompt = t.mock.method(window, 'prompt', () => {
      throw new Error('prompt() is and will not be supported.');
    });
    const draftId = 'dialog-branch';
    const { trigger } = await mount(t, draft ? { sessionId: '', draftId } : {});
    if (draft) await act(async () => model.setWorktreeIntent(draftId, true));
    t.after(async () => act(async () => model.setWorktreeIntent(draftId, false)));
    const capability = draft ? 'selectProjectBranch' : 'selectBranch';
    handlers[capability] = () => {
      const updated = menuFor({ workspace: workspace({ branch: 'feat/dialog', revision: 4 }) });
      if (draft) projectMenuReply = updated;
      else menuReply = updated;
      return { revision: 4, workspace: updated.workspace };
    };
    const menu = await openMenu(trigger);
    calls.length = 0;
    await act(async () => menu.querySelector('[data-kind="create"]').click());
    const dialog = document.querySelector('.branch-name-dialog');
    assert.ok(dialog, 'New branch must open a separate name dialog');
    assert.equal(document.querySelector('.branch-menu'), null);
    assert.equal(dialog.getAttribute('role'), 'dialog');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent, 'New branch');
    const input = dialog.querySelector('input');
    assert.equal(input.closest('label').querySelector('span').textContent, 'New branch name');
    assert.equal(document.activeElement, input);
    assert.equal(prompt.mock.callCount(), 0);
    assert.deepEqual(calls, []);
    await typeBranchName(input, '   ');
    await pressBranchKey(input, 'Enter');
    assert.deepEqual(calls, [], 'blank names must not reach the runtime');
    await typeBranchName(input, '  feat/dialog  ');
    await pressBranchKey(input, 'Enter', { isComposing: true });
    assert.deepEqual(calls, [], 'IME confirmation must not create a branch');
    if (draft) await act(async () => dialog.querySelector('[type="submit"]').click());
    else await pressBranchKey(input, 'Enter');
    assert.deepEqual(
      calls.filter((call) => call.capability === capability),
      draft
        ? []
        : [{ capability, args: [{ branch: 'feat/dialog', create: true, expectedRevision: 3 }], sessionId: 's1' }]
    );
    assert.equal(document.querySelector('.branch-menu'), null);
    assert.equal(document.querySelector('.branch-name-dialog'), null);
    assert.equal(trigger.querySelector('.branch-chip-label').textContent, 'feat/dialog');
    assert.equal(document.activeElement, trigger);
    if (draft) {
      assert.equal(model.getWorktreeIntent(draftId), true);
      assert.deepEqual(model.getBranchIntent(draftId), { branch: 'feat/dialog', create: true });
    }
  });
}

test('new branch can use the existing search text directly', async (t) => {
  menuReply = menuFor();
  const { trigger } = await mount(t);
  handlers.selectBranch = () => ({ workspace: workspace(), revision: 4 });
  const menu = await openMenu(trigger);
  await typeBranchName(menu.querySelector('input'), '  feat/from-search  ');
  await act(async () => menu.querySelector('[data-kind="create"]').click());
  assert.deepEqual(
    calls.filter((call) => call.capability === 'selectBranch'),
    [
      {
        capability: 'selectBranch',
        args: [{ branch: 'feat/from-search', create: true, expectedRevision: 3 }],
        sessionId: 's1',
      },
    ]
  );
});

for (const dismissal of ['Escape', 'Cancel', 'backdrop']) {
  test(`branch name dialog supports ${dismissal} without creating a branch`, async (t) => {
    menuReply = menuFor();
    const { trigger } = await mount(t);
    let menu = await openMenu(trigger);
    await act(async () => menu.querySelector('[data-kind="create"]').click());
    const dialog = document.querySelector('.branch-name-dialog');
    const input = dialog.querySelector('input');
    assert.ok(input);
    await typeBranchName(input, 'feat/cancelled');
    if (dismissal === 'Escape') await pressBranchKey(input, 'Escape');
    else if (dismissal === 'Cancel') await act(async () => dialog.querySelector('[type="button"]').click());
    else {
      await act(async () => {
        dialog.parentElement.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
        dialog.parentElement.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      });
    }
    assert.equal(document.querySelector('.branch-menu'), null);
    assert.equal(document.querySelector('.branch-name-dialog'), null);
    assert.equal(document.activeElement, trigger);
    assert.equal(
      calls.some((call) => call.capability === 'selectBranch'),
      false
    );
    menu = await openMenu(trigger);
    assert.equal(menu.querySelector('input').getAttribute('aria-label'), 'Search branches');
    assert.equal(menu.querySelector('input').value, '');
  });
}

test('branch name dialog blocks duplicate requests and preserves failed names for retry', async (t) => {
  menuReply = menuFor();
  const { trigger } = await mount(t);
  let rejectCreation;
  handlers.selectBranch = () =>
    new Promise((_, reject) => {
      rejectCreation = reject;
    });
  const menu = await openMenu(trigger);
  await act(async () => menu.querySelector('[data-kind="create"]').click());
  const dialog = document.querySelector('.branch-name-dialog');
  const input = dialog.querySelector('input');
  assert.ok(input);
  await typeBranchName(input, 'feat/retry');
  await pressBranchKey(input, 'Enter');
  await pressBranchKey(input, 'Enter');
  await act(async () => dialog.querySelector('[type="submit"]').click());
  await pressBranchKey(input, 'Escape');
  await act(async () => {
    dialog.parentElement.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    dialog.parentElement.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(document.querySelector('.branch-name-dialog'), dialog, 'busy creation cannot be dismissed');
  assert.equal(calls.filter((call) => call.capability === 'selectBranch').length, 1);
  await act(async () => rejectCreation(new Error('Branch creation failed')));
  assert.match(dialog.querySelector('[role="alert"]').textContent, /Branch creation failed/);
  assert.equal(input.value, 'feat/retry');
  handlers.selectBranch = () => ({ workspace: workspace(), revision: 4 });
  await pressBranchKey(input, 'Enter');
  assert.equal(calls.filter((call) => call.capability === 'selectBranch').length, 2);
  assert.equal(document.querySelector('.branch-menu'), null);
  assert.equal(document.querySelector('.branch-name-dialog'), null);
});

test('menu structure: search, worktree, branch section, separator, new branch', async (t) => {
  setUiLanguagePreference('en');
  await initUiLanguage();
  menuReply = menuFor();
  const { trigger } = await mount(t);
  assert.equal(trigger.querySelector('.branch-chip-label').textContent, 'main');
  assert.equal(trigger.querySelector('.branch-chip-fork'), null);
  const menu = await openMenu(trigger);
  assert.equal(menu.querySelector('input[type="search"]').placeholder, 'Search branches');
  assert.ok(menu.querySelector('input[type="search"]').closest('.schedules-search'));
  const list = menu.querySelector('.branch-menu-list');
  assert.equal(list.querySelectorAll('.branch-row-more').length, 4, 'every branch exposes its own actions');
  const [worktree, ...rest] = items(list);
  assert.equal(worktree.querySelector('span').textContent, 'Worktree');
  assert.equal(worktree.querySelector('small').textContent, 'New branch · separate folder');
  assert.equal(list.querySelector('h3').textContent, 'Branch');
  assert.deepEqual(
    rest.map((row) => [row.querySelector('span').textContent, row.querySelector('small')?.textContent ?? '']),
    [
      ['main', ''],
      ['feat/ssh-remote', 'Worktree'],
      ['next-patch', ''],
      ['ext-branch', 'Worktree'],
    ]
  );
  assert.deepEqual(
    [...list.querySelectorAll('.branch-menu-check')].map((check) => check.closest('[data-branch]')?.dataset.branch),
    ['main'],
    'the check marks the current branch while the worktree is not selected'
  );
  for (const shell of list.querySelectorAll('.branch-row-shell')) {
    assert.ok(shell.querySelector(':scope > .branch-row-more'), 'the … trigger sits inside the row');
  }
  assert.equal(menu.lastElementChild.querySelector('span').textContent, 'New branch');
  // No merge / return entries live in this menu.
  assert.equal(menu.textContent.includes('Merge'), false);
});

test('menu opens above the chip, left-aligned with the shared 6px gap', async (t) => {
  menuReply = menuFor();
  const { trigger } = await mount(t);
  const menu = await openMenu(trigger);
  assert.equal(menu.style.top, '');
  assert.equal(parseFloat(menu.style.bottom), 900 - rect().top + 6);
  assert.equal(parseFloat(menu.style.left), rect().left);
  assert.ok(parseFloat(menu.style.maxHeight) <= 320);
});

test('a remounted chip shows the cached menu at once; the fresh list updates the same rows in place', async (t) => {
  setUiLanguagePreference('en');
  await initUiLanguage();
  menuReply = menuFor();
  const first = await mount(t, { sessionId: 'cached-s' });
  await settle();
  assert.equal(first.trigger.querySelector('.branch-chip-label').textContent, 'main');
  // The pane remounts (a route switch) while the re-read is outstanding.
  const gate = Promise.withResolvers();
  const second = await mount(t, { sessionId: 'cached-s' }, { keepCache: true, gate });
  assert.ok(second.trigger, 'the chip is there before any read answers');
  assert.equal(second.trigger.querySelector('.branch-chip-label').textContent, 'main');
  const menu = await openMenu(second.trigger);
  const names = () =>
    items(menu)
      .filter((item) => item.dataset.kind === 'branch')
      .map((item) => item.dataset.branch);
  assert.deepEqual(names(), ['main', 'feat/ssh-remote', 'next-patch', 'ext-branch']);
  const row = menu.querySelector('[data-branch="next-patch"]');
  row.focus();
  menuReply = menuFor({
    branches: [
      branch('aaa-new'),
      branch('main', true),
      branch('feat/ssh-remote'),
      branch('next-patch'),
      branch('ext-branch'),
    ],
    occupancy: [...menuFor().occupancy, { branch: 'aaa-new', kind: 'free' }],
  });
  gate.resolve();
  await settle();
  assert.deepEqual(names(), ['main', 'aaa-new', 'feat/ssh-remote', 'next-patch', 'ext-branch']);
  assert.equal(menu.querySelector('[data-branch="next-patch"]'), row, 'the row element is kept');
  assert.equal(document.activeElement, row, 'focus stays on the row');
});

test('a chosen branch row spins at once and the chip shows the pending mark until the result arrives', async (t) => {
  menuReply = menuFor();
  const { trigger } = await mount(t);
  const gate = Promise.withResolvers();
  handlers.selectBranch = async () => {
    await gate.promise;
    throw new Error('WORKTREE_BUSY_JOBS: busy');
  };
  const menu = await openMenu(trigger);
  const row = menu.querySelector('[data-branch="next-patch"]');
  await act(async () => row.click());
  assert.equal(row.dataset.pending, 'true');
  assert.ok(row.querySelector('.progress-spinner-turn'));
  assert.ok(trigger.querySelector('.progress-spinner-turn'), 'the chip shows a pending mark');
  gate.resolve();
  await settle();
  await settle();
  assert.equal(row.querySelector('.progress-spinner-turn'), null);
  assert.equal(trigger.querySelector('.progress-spinner-turn'), null);
  assert.ok(document.querySelector('.branch-menu-notice[role="alert"]'));
});

test('chip states: current branch, worktree intent in a draft, worktree-bound session', async (t) => {
  setUiLanguagePreference('en');
  await initUiLanguage();
  // Draft: the Project's menu comes from the runtime (no session), "Worktree"
  // is a lazy intent.
  projectMenuReply = draftMenu();
  const draft = await mount(t, { sessionId: '', draftId: 'd1' });
  assert.deepEqual(
    calls.filter((call) => call.capability === 'getProjectBranchMenu'),
    [{ capability: 'getProjectBranchMenu', args: [{ projectPath: '/p' }] }]
  );
  assert.equal(draft.trigger.querySelector('.branch-chip-label').textContent, 'main');
  let menu = await openMenu(draft.trigger);
  await act(async () => items(menu)[0].click());
  assert.equal(document.querySelector('.branch-menu'), null);
  assert.equal(draft.trigger.querySelector('.branch-chip-label').textContent, 'Worktree');
  assert.ok(draft.trigger.querySelector('.branch-chip-fork'));
  assert.equal(model.getWorktreeIntent('d1'), true);
  menu = await openMenu(draft.trigger);
  const selected = items(menu)[0];
  assert.equal(selected.querySelector('small').textContent, 'New branch · separate folder');
  assert.equal(selected.hasAttribute('data-selected'), true);
  assert.ok(selected.querySelector('.branch-menu-check'), 'only the selected worktree row shows the check');
  assert.equal(menu.querySelectorAll('.branch-menu-check').length, 1);
  assert.equal(menu.querySelector('[data-branch="main"] small').textContent, 'Current');
  assert.equal(menu.querySelector('[data-branch="main"] .branch-menu-check'), null, 'the check moved to the worktree');
  assert.equal(menu.querySelector('[data-branch="main"]').hasAttribute('data-selected'), false);
  assert.equal(model.takeWorktreeIntent('d1'), true);
  assert.equal(model.getWorktreeIntent('d1'), false);
  await act(async () => draft.trigger.click());
  assert.equal(document.querySelector('.branch-menu'), null);

  // Bound session: the generated branch with the fork icon, marked current.
  menuReply = menuFor({
    workspace: workspace({ worktreeId: 'w1', branch: 'mixdog/fix-bom', cwd: '/wt' }),
    branches: [branch('main', true), branch('mixdog/fix-bom')],
    occupancy: [
      { branch: 'main', kind: 'current' },
      { branch: 'mixdog/fix-bom', kind: 'session', sessionId: 's2' },
    ],
  });
  const bound = await mount(t, { sessionId: 's2' });
  assert.equal(bound.trigger.querySelector('.branch-chip-label').textContent, 'mixdog/fix-bom');
  assert.ok(bound.trigger.querySelector('.branch-chip-fork'));
  const boundMenu = await openMenu(bound.trigger);
  assert.deepEqual(
    items(boundMenu.querySelector('.branch-menu-list')).map((row) => row.querySelector('small')?.textContent ?? ''),
    ['New branch · separate folder', '', 'Project folder']
  );
});

test('occupancy: shared and external worktrees move this session instead of opening another session', async (t) => {
  menuReply = menuFor();
  const { trigger, opened } = await mount(t);
  handlers.selectBranch = (request) => ({
    revision: 4,
    workspace: workspace({ branch: request.args[0].branch, revision: 4 }),
  });
  let menu = await openMenu(trigger);
  const [, , used, free, external] = items(menu);
  assert.equal(used.getAttribute('data-tooltip'), null);
  assert.notEqual(external.getAttribute('aria-disabled'), 'true');
  assert.equal(external.getAttribute('data-tooltip'), null);
  calls.length = 0;
  await act(async () => external.click());
  assert.equal(calls.filter((call) => call.capability === 'selectBranch').length, 1);
  menu = await openMenu(trigger);
  await act(async () => items(menu)[2].click());
  assert.deepEqual(opened, []);
  assert.equal(calls.filter((call) => call.capability === 'selectBranch').length, 2);
  assert.equal(document.querySelector('.branch-menu'), null);
  menu = await openMenu(trigger);
  calls.length = 0;
  handlers.selectBranch = () => ({ revision: 4, workspace: workspace({ branch: 'next-patch', revision: 4 }) });
  await act(async () => items(menu)[3].click());
  assert.deepEqual(
    calls.filter((call) => call.capability === 'selectBranch'),
    [{ capability: 'selectBranch', args: [{ branch: 'next-patch', expectedRevision: 3 }], sessionId: 's1' }]
  );
  assert.ok(free);
});

test('large repository confirms once and resends with confirmLarge', async (t) => {
  setUiLanguagePreference('en');
  await initUiLanguage();
  menuReply = menuFor();
  const { trigger } = await mount(t);
  const prompts = [];
  overrideConfirmAction((text) => (prompts.push(text), true));
  let attempts = 0;
  handlers.requestWorktree = (request) => {
    attempts += 1;
    if (!request.args[0].confirmLarge) {
      const error = new Error('large');
      error.code = 'WORKTREE_LARGE_REPO_CONFIRM';
      error.details = { sizeBytes: 3 * 1024 ** 3 };
      throw error;
    }
    // A session's worktree is created and entered now.
    const bound = workspace({ worktreeId: 'w9', branch: 'mixdog/now', cwd: '/wt', revision: 4 });
    menuReply = menuFor({ workspace: bound });
    return { revision: 4, workspace: bound };
  };
  const menu = await openMenu(trigger);
  await act(async () => items(menu)[0].click());
  assert.equal(attempts, 2);
  assert.deepEqual(prompts, ['A worktree needs about 3.0 GB. Create it anyway?']);
  const sent = calls.filter((call) => call.capability === 'requestWorktree').map((call) => call.args[0]);
  assert.deepEqual(sent, [
    { expectedRevision: 3, provision: true },
    { expectedRevision: 3, provision: true, confirmLarge: true },
  ]);
  assert.equal(trigger.querySelector('.branch-chip-label').textContent, 'mixdog/now');
  assert.equal(model.getWorktreeIntent('s1'), false, 'a session keeps no client-side choice');
  menuReply = menuFor();
});

test('mid-session the chip follows the backend menu, never a stale client-side choice', async (t) => {
  setUiLanguagePreference('en');
  await initUiLanguage();
  // A worktree-bound session…
  menuReply = menuFor({
    workspace: workspace({ worktreeId: 'w1', branch: 'mixdog/fix', cwd: '/wt', revision: 5 }),
    retainedWorktree: { id: 'w1', branch: 'mixdog/fix', path: '/wt' },
  });
  // …with a leftover "Worktree" choice under its key (e.g. from a draft or an older build).
  model.setWorktreeIntent('s1', true);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    model.setWorktreeIntent('s1', false);
  });
  const render = (refreshKey) =>
    act(async () =>
      root.render(
        React.createElement(BranchChip, {
          sessionId: 's1',
          draftId: '',
          projectPath: '/p',
          refreshKey,
        })
      )
    );
  await render('5:/wt');
  const chip = () => host.querySelector('.composer-branch-context');
  assert.equal(chip().getAttribute('data-state'), 'worktree');
  // removeWorktree returned the session to the project folder on main.
  menuReply = menuFor({ workspace: workspace({ revision: 6 }), pendingWorktree: null, retainedWorktree: null });
  await render('6:/p');
  assert.equal(chip().getAttribute('data-state'), 'branch');
  assert.equal(chip().querySelector('.branch-chip-label').textContent, 'main');
  // A choice the runtime holds for the next send shows as the intent.
  menuReply = menuFor({ pendingWorktree: { name: null } });
  await render('6:/p:pending');
  assert.equal(chip().getAttribute('data-state'), 'intent');
  menuReply = menuFor();
});

test('a declined large-repository prompt sends nothing more', async (t) => {
  menuReply = menuFor();
  const { trigger } = await mount(t);
  overrideConfirmAction(() => false);
  let attempts = 0;
  handlers.requestWorktree = () => {
    attempts += 1;
    const error = new Error('large');
    error.code = 'WORKTREE_LARGE_REPO_CONFIRM';
    throw error;
  };
  const menu = await openMenu(trigger);
  await act(async () => items(menu)[0].click());
  assert.equal(attempts, 1);
  assert.ok(document.querySelector('.branch-menu'));
});

test('uncommitted project files ask leave / carry / cancel and resend with carryChanges', async (t) => {
  setUiLanguagePreference('en');
  await initUiLanguage();
  menuReply = menuFor();
  const { trigger } = await mount(t);
  handlers.requestWorktree = (request) => {
    if (!request.args[0].carryChanges) {
      throw new Error(
        'Error invoking remote method: WORKTREE_DIRTY_CHOICE: dirty\n[worktree-details] {"count":3,"paths":["src/a.ts","b.md"]}'
      );
    }
    if (request.args[0].carryChanges === 'carry') {
      const error = new Error('busy');
      error.code = 'WORKTREE_BUSY_JOBS';
      throw error;
    }
    return { revision: 4, workspace: workspace({ revision: 4 }) };
  };
  const dialog = () => document.querySelector('.worktree-carry-dialog');
  const choice = (id) => dialog().querySelector(`footer [data-choice="${id}"]`);
  const sent = () => calls.filter((call) => call.capability === 'requestWorktree').map((call) => call.args[0]);
  // The choice replaces the menu (nothing of it is drawn over the dialog);
  // Cancel sends nothing more and leaves both closed.
  let menu = await openMenu(trigger);
  await act(async () => items(menu)[0].click());
  assert.equal(document.querySelector('.branch-menu'), null, 'the menu closes before the dialog opens');
  assert.equal(dialog().querySelector('h3').textContent, 'Uncommitted files in the project folder: 3');
  assert.deepEqual(
    [...dialog().querySelectorAll('footer button')].map((node) => node.textContent),
    ['Cancel', 'Bring changes', 'Leave changes and move']
  );
  // A capped preview of the paths; the rest is marked.
  assert.deepEqual(
    [...dialog().querySelectorAll('.worktree-carry-paths li')].map((node) => node.textContent),
    ['src/a.ts', 'b.md', '…']
  );
  assert.match(dialog().querySelector('[data-choice="leave"] span').textContent, /without these edits/);
  assert.equal(document.activeElement, choice('leave'), 'leaving the changes is the default');
  assert.ok(choice('leave').classList.contains('primary'));
  await act(async () => choice('cancel').click());
  assert.equal(dialog(), null);
  assert.deepEqual(sent(), [{ expectedRevision: 3, provision: true }]);
  assert.equal(document.querySelector('.branch-menu'), null);
  // Carry: the menu comes back with the refusal as its notice.
  calls.length = 0;
  menu = await openMenu(trigger);
  await act(async () => items(menu)[0].click());
  await act(async () => choice('carry').click());
  assert.deepEqual(sent(), [
    { expectedRevision: 3, provision: true },
    { expectedRevision: 3, provision: true, carryChanges: 'carry' },
  ]);
  assert.equal(
    document.querySelector('.branch-menu [role="alert"]').textContent,
    'Background tasks are still running. Wait for them or stop them, then try again.'
  );
  assert.equal(dialog(), null);
  // Leave: the worktree is created and the menu stays closed.
  calls.length = 0;
  menu = document.querySelector('.branch-menu');
  await act(async () => items(menu)[0].click());
  await act(async () => choice('leave').click());
  assert.deepEqual(sent().at(-1), { expectedRevision: 3, provision: true, carryChanges: 'leave' });
  assert.equal(document.querySelector('.branch-menu'), null);
});

test('busy jobs and revision conflicts become a notice; a conflict re-reads the menu', async (t) => {
  setUiLanguagePreference('en');
  await initUiLanguage();
  menuReply = menuFor();
  const { trigger } = await mount(t);
  handlers.selectBranch = () => {
    const error = new Error('busy');
    error.code = 'WORKTREE_BUSY_JOBS';
    throw error;
  };
  let menu = await openMenu(trigger);
  await act(async () => items(menu)[3].click());
  menu = document.querySelector('.branch-menu');
  assert.equal(
    menu.querySelector('[role="alert"]').textContent,
    'Background tasks are still running. Wait for them or stop them, then try again.'
  );
  handlers.selectBranch = () => {
    // The code survives IPC only inside the message text.
    throw new Error('Error invoking remote method: WORKTREE_REVISION_CONFLICT: stale');
  };
  const before = calls.filter((call) => call.capability === 'getBranchMenu').length;
  await act(async () => items(menu)[3].click());
  await settle();
  assert.equal(
    document.querySelector('.branch-menu [role="alert"]').textContent,
    'The workspace changed, so the menu was refreshed. Try again.'
  );
  assert.ok(calls.filter((call) => call.capability === 'getBranchMenu').length > before);
});

test('a missing worktree shows the recovery chip and notice', async (t) => {
  setUiLanguagePreference('en');
  await initUiLanguage();
  menuReply = menuFor({
    workspace: workspace({ worktreeId: 'w1', branch: 'mixdog/x', transition: { state: 'recovery', txId: null } }),
  });
  const { trigger } = await mount(t);
  assert.equal(trigger.querySelector('.branch-chip-label').textContent, 'Worktree missing');
  assert.equal(trigger.closest('.composer-branch-context').hasAttribute('data-recovery'), true);
});

test('a superseded missing-worktree fallback whose project menu fails leaves the newer menu alone', async (t) => {
  setUiLanguagePreference('en');
  await initUiLanguage();
  // A mount adopts a menu another host read moments ago: start from no cache.
  clearBranchMenuCache();
  calls.length = 0;
  let branchMenuCalls = 0;
  let failProjectMenu;
  handlers = {
    getBranchMenu: () => {
      branchMenuCalls += 1;
      if (branchMenuCalls === 1) throw new Error('Error invoking remote method: WORKTREE_MISSING: gone');
      return menuFor();
    },
    getProjectBranchMenu: () =>
      new Promise((_resolve, reject) => {
        failProjectMenu = () => reject(new Error('project menu failed'));
      }),
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    handlers = {};
  });
  const render = (refreshKey) =>
    act(async () =>
      root.render(
        React.createElement(BranchChip, {
          sessionId: 's1',
          draftId: '',
          projectPath: '/p',
          refreshKey,
        })
      )
    );
  // The first load falls back to the project menu, which is still pending…
  await render('1');
  assert.equal(typeof failProjectMenu, 'function');
  // …when a newer load lands the healthy session menu.
  await render('2');
  const chip = () => host.querySelector('.composer-branch-context');
  assert.equal(chip().querySelector('.branch-chip-label').textContent, 'main');
  // The stale fallback then fails: it must not clear the menu or flag recovery.
  await act(async () => failProjectMenu());
  await settle();
  assert.equal(chip().hasAttribute('data-recovery'), false);
  assert.equal(chip().querySelector('.branch-chip-label').textContent, 'main');
  chip().getBoundingClientRect = () => rect();
  const menu = await openMenu(host.querySelector('.branch-chip-trigger'));
  assert.equal(menu.querySelector('[role="alert"]'), null);
  assert.ok(items(menu).length > 1);
});

test('a missing worktree whose project menu also fails keeps the last good menu and retries', async (t) => {
  setUiLanguagePreference('en');
  await initUiLanguage();
  // A mount adopts a menu another host read moments ago: start from no cache.
  clearBranchMenuCache();
  calls.length = 0;
  let branchMenuCalls = 0;
  handlers = {
    getBranchMenu: () => {
      branchMenuCalls += 1;
      if (branchMenuCalls === 2) throw new Error('Error invoking remote method: WORKTREE_MISSING: gone');
      return menuFor();
    },
    getProjectBranchMenu: () => {
      throw new Error('project menu failed');
    },
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    handlers = {};
  });
  const render = (refreshKey) =>
    act(async () =>
      root.render(
        React.createElement(BranchChip, {
          sessionId: 's1',
          draftId: '',
          projectPath: '/p',
          refreshKey,
        })
      )
    );
  await render('1');
  const chip = () => host.querySelector('.composer-branch-context');
  assert.equal(chip().querySelector('.branch-chip-label').textContent, 'main');
  await render('2');
  assert.equal(branchMenuCalls, 2);
  assert.equal(chip().querySelector('.branch-chip-label').textContent, 'main');
  assert.equal(chip().hasAttribute('data-recovery'), false);
  // The failed fallback reports failure, so the backoff retry re-reads.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1000)));
  assert.equal(branchMenuCalls, 3);
  assert.equal(chip().querySelector('.branch-chip-label').textContent, 'main');
});

test('Korean copy', async (t) => {
  setUiLanguagePreference('ko');
  await initUiLanguage();
  t.after(async () => {
    setUiLanguagePreference('en');
    await initUiLanguage();
  });
  menuReply = menuFor();
  const { trigger } = await mount(t);
  const menu = await openMenu(trigger);
  const list = menu.querySelector('.branch-menu-list');
  assert.equal(items(list)[0].querySelector('span').textContent, '워크트리');
  assert.equal(items(list)[0].querySelector('small').textContent, '새 브랜치 · 별도 폴더');
  assert.equal(list.querySelector('h3').textContent, '브랜치');
  assert.deepEqual(
    items(list)
      .slice(1)
      .map((row) => row.querySelector('small')?.textContent ?? ''),
    ['', '워크트리', '', '워크트리']
  );
  assert.equal(menu.querySelector('input').placeholder, '브랜치 검색');
  assert.equal(menu.lastElementChild.textContent, '새 브랜치');
});

test('source-control picker marks occupied branches and routes the click', async (t) => {
  setUiLanguagePreference('en');
  await initUiLanguage();
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const opened = [];
  const checkouts = [];
  const none = () => {};
  const rows = [branch('main', true), branch('feat/ssh-remote'), branch('ext-branch')];
  await act(async () =>
    root.render(
      React.createElement(SourceControlBranchPicker, {
        status: { branch: 'main', detached: false, upstreamName: '', operation: '' },
        busy: '',
        open: true,
        query: '',
        loading: false,
        visibleBranches: rows,
        defaultBranch: null,
        otherBranches: rows,
        mergeMode: false,
        occupancy: new Map([
          ['feat/ssh-remote', { branch: 'feat/ssh-remote', kind: 'session', sessionId: 'other' }],
          ['ext-branch', { branch: 'ext-branch', kind: 'external', path: '/x' }],
        ]),
        capabilities: { list: true, create: true, checkout: true, rename: true, delete: true, merge: true },
        rootRef: { current: null },
        triggerRef: { current: null },
        panelRef: { current: null },
        panelStyle: {},
        clickGuard: { markPointerActivation: none, consumePointerClick: () => false, clearPointerActivation: none },
        rowContextMenu: () => ({}),
        missingChannel: (label) => label,
        guarded: (action) => action(),
        onOpen: none,
        onClose: none,
        onQueryChange: none,
        onCreate: none,
        onCheckout: (b) => checkouts.push(b.name),
        onRename: none,
        onDelete: none,
        onMerge: none,
        onToggleMergeMode: none,
        onOpenSession: (id) => opened.push(id),
      })
    )
  );
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const mains = [...document.querySelectorAll('.dock-scm-branch-main')];
  assert.deepEqual(
    mains.map((button) => button.querySelector('.dock-scm-branch-mark')?.textContent ?? ''),
    ['', 'In use', 'External']
  );
  assert.equal(mains[2].disabled, true);
  assert.equal(mains[2].title, 'Checked out in an external worktree: /x');
  await act(async () => mains[1].click());
  assert.deepEqual(opened, ['other']);
  assert.deepEqual(checkouts, []);
});

test('branchRows filters by search and ignores remote branches', () => {
  const rows = model.branchRows(
    menuFor({ branches: [branch('main', true), { ...branch('origin/main'), remote: true }, branch('dev')] }),
    's1',
    'DE'
  );
  assert.deepEqual(
    rows.map((row) => row.name),
    ['dev']
  );
});

test('the runtime getBranchMenu response feeds the renderer model: rows, marks and search', async (t) => {
  const { createWorkspaceTransitions } = await import('../../../../src/session-runtime/workspace/transitions.mjs');
  // The runtime reads the project folder's repository, so the menu is read
  // for a real git repository with one commit on main.
  const project = mkdtempSync(join(tmpdir(), 'branch-chip-menu-'));
  const git = (...args) => execFileSync('git', ['-C', project, ...args]);
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const session = { id: 'lead-1', cwd: project, desktopSession: { classification: 'project', projectPath: project } };
  const api = createWorkspaceTransitions({
    getSession: () => session,
    getCurrentCwd: () => project,
    getActiveTurnCount: () => 0,
    // The manager's listBranchOccupancy shape: local branch NAMES plus occupancy rows.
    manager: {
      async listBranchOccupancy() {
        return {
          branches: ['main', 'dev', 'feat/ssh-remote', 'ext-branch'],
          occupancy: [
            { branch: 'main', kind: 'current', path: project },
            { branch: 'dev', kind: 'free' },
            { branch: 'feat/ssh-remote', kind: 'session', sessionId: 'other-session', path: '/wt/ssh' },
            { branch: 'ext-branch', kind: 'external', path: '/elsewhere' },
          ],
          retainedWorktree: null,
        };
      },
    },
  });
  const menu = await api.getBranchMenu();
  menu.workspace.branch = 'main';
  assert.deepEqual(
    model.branchRows(menu, 'lead-1', '').map((row) => [row.name, row.mark]),
    [
      ['main', 'current'],
      ['dev', ''],
      ['feat/ssh-remote', 'inUse'],
      ['ext-branch', 'external'],
    ]
  );
  assert.deepEqual(
    model.branchRows(menu, 'lead-1', 'SSH').map((row) => row.name),
    ['feat/ssh-remote']
  );
});

test('a draft defers its branch selection until first send without changing the shared checkout', async (t) => {
  setUiLanguagePreference('en');
  await initUiLanguage();
  projectMenuReply = draftMenu();
  const { trigger, opened } = await mount(t, { sessionId: '', draftId: 'd-guard' });
  const menu = await openMenu(trigger);
  const rows = items(menu.querySelector('.branch-menu-list'));
  assert.deepEqual(
    rows.slice(1).map((row) => row.querySelector('small')?.textContent ?? ''),
    ['', '', 'Worktree'],
    'the real occupancy, not a guess from the branch list'
  );
  handlers.selectProjectBranch = () => {
    throw new Error("Error invoking remote method 'mixdog:invoke-capability': Error: WORKTREE_DIRTY: dirty");
  };
  await act(async () => rows[2].click());
  assert.deepEqual(
    calls.filter((call) => call.capability === 'selectProjectBranch'),
    []
  );
  assert.deepEqual(model.getBranchIntent('d-guard'), { branch: 'dev', create: false });
  assert.equal(document.querySelector('.branch-menu'), null);
  let submitted;
  await act(async () => {
    await model.sendDraftWithWorktreeIntent('d-guard', async (worktree) => {
      submitted = worktree;
      return { accepted: true, sessionId: 'new-session' };
    });
  });
  assert.deepEqual(submitted, { branch: 'dev', create: false });
  assert.deepEqual(opened, []);
  assert.equal(model.getWorktreeIntent('d-guard'), false);
});

test('the New Task context bar orders project → workflow → branch', async (t) => {
  const { ComposerContextChips } = await import('./composer-context-chips.tsx');
  projectMenuReply = draftMenu();
  calls.length = 0;
  handlers = {};
  const host = document.createElement('div');
  host.className = 'composer-context-bar';
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () =>
    root.render(
      React.createElement(ComposerContextChips, {
        project: React.createElement('div', { className: 'composer-project-context' }),
        // A single workflow pack renders no pill; the delegation pill shares the workflow chip class.
        workflow: null,
        delegation: React.createElement('div', { className: 'composer-route-workflow' }),
        branch: React.createElement(BranchChip, {
          sessionId: '',
          draftId: 'd-order',
          projectPath: '/p',
        }),
      })
    )
  );
  assert.deepEqual(
    [...host.children].map((child) => child.className),
    ['composer-project-context', 'composer-route-workflow', 'composer-branch-context']
  );
});

test('a failed New Task send gives the Worktree choice back; a started task consumes it', async () => {
  const key = 'd-restore';
  model.setWorktreeIntent(key, true);
  const sent = [];
  await assert.rejects(
    model.sendDraftWithWorktreeIntent(key, async (worktree) => {
      sent.push(worktree);
      throw new Error('No provider models available. Open /providers to sign in, then /model to choose a model.');
    }),
    /No provider models available/
  );
  assert.deepEqual(sent, [{}], 'the choice rode with the send');
  assert.equal(model.getWorktreeIntent(key), true, 'model resolution failed: the draft keeps its choice');
  // Refused by the host (the session was not bound): still kept.
  await assert.rejects(
    model.sendDraftWithWorktreeIntent(key, async () => {
      throw new Error("Error invoking remote method 'mixdog:submit-new-task': Error: WORKTREE_NOT_IMPLEMENTED: x");
    })
  );
  assert.equal(model.getWorktreeIntent(key), true);
  // Not accepted: kept.
  await model.sendDraftWithWorktreeIntent(key, async () => ({ accepted: false, sessionId: '' }));
  assert.equal(model.getWorktreeIntent(key), true);
  const result = await model.sendDraftWithWorktreeIntent(key, async () => ({ accepted: true, sessionId: 's-new' }));
  assert.equal(result.sessionId, 's-new');
  assert.equal(model.getWorktreeIntent(key), false, 'the started task owns its worktree');
});

test('dock checkout and create go through the guarded project checkout with readable refusals', async () => {
  setUiLanguagePreference('en');
  await initUiLanguage();
  const { branchActions } = await import('./source-control-actions.ts');
  const runs = [];
  const errors = [];
  const ctx = {
    api: {
      gitCheckoutBranch: () => assert.fail('raw checkout bypasses the guard'),
      gitCreateBranch: () => assert.fail('raw create bypasses the guard'),
    },
    projectPath: '/p',
    run: (key, action) =>
      runs.push(
        Promise.resolve()
          .then(action)
          .catch((error) => errors.push([key, error.message]))
      ),
    setError: () => {},
  };
  const actions = branchActions(ctx, {
    branchQuery: 'feature/new',
    closePicker() {},
    exitMergeMode() {},
    currentBranch: 'main',
  });
  calls.length = 0;
  handlers = {
    selectProjectBranch: (request) => {
      const [input] = request.args;
      if (input.branch === 'dirty') throw new Error('Error invoking remote method: WORKTREE_DIRTY: dirty');
      if (input.branch === 'busy') throw new Error('Error invoking remote method: WORKTREE_BUSY_JOBS: busy');
      return { branch: input.branch.replace(/^origin\//, ''), changed: true };
    },
  };
  actions.checkoutBranch(branch('dev'));
  actions.checkoutBranch({ ...branch('origin/review'), remote: true });
  actions.createBranchFromFilter();
  actions.checkoutBranch(branch('dirty'));
  actions.checkoutBranch(branch('busy'));
  await Promise.all(runs);
  assert.deepEqual(
    calls.filter((call) => call.capability === 'selectProjectBranch').map((call) => call.args[0]),
    [
      { projectPath: '/p', branch: 'dev' },
      { projectPath: '/p', branch: 'origin/review', remote: true },
      { projectPath: '/p', branch: 'feature/new', create: true },
      { projectPath: '/p', branch: 'dirty' },
      { projectPath: '/p', branch: 'busy' },
    ]
  );
  assert.deepEqual(errors, [
    [
      'branch-checkout:dirty',
      'The project folder has uncommitted changes. Commit or stash them before switching branches.',
    ],
    ['branch-checkout:busy', 'Background tasks are still running. Wait for them or stop them, then try again.'],
  ]);
  assert.equal(
    model.worktreeFailureText(
      model.worktreeFailure(
        new Error('Error: WORKTREE_PARTIAL_TRANSITION: The branch change failed (x); it is now on "dev".')
      )
    ),
    'The branch change failed (x); it is now on "dev".'
  );
});

test('the dock merge goes through mergeProjectBranch with the confirmed target, never a raw git merge', async () => {
  setUiLanguagePreference('en');
  await initUiLanguage();
  const { branchActions } = await import('./source-control-actions.ts');
  const runs = [];
  const results = [];
  const ctx = {
    api: { gitMergeBranch: () => assert.fail('a raw merge bypasses the guard') },
    projectPath: '/p',
    run: (key, action) =>
      runs.push(
        Promise.resolve()
          .then(action)
          .then((value) => results.push([key, 'ok', value]))
          .catch((error) => results.push([key, 'error', error.message]))
      ),
    setError: () => {},
  };
  overrideConfirmAction(() => true);
  try {
    const actions = branchActions(ctx, {
      branchQuery: '',
      closePicker() {},
      exitMergeMode() {},
      currentBranch: 'main',
    });
    calls.length = 0;
    handlers = {
      mergeProjectBranch: (request) => {
        const [input] = request.args;
        if (input.branch === 'moved') {
          throw new Error(
            'Error invoking remote method: WORKTREE_TARGET_MISMATCH: moved\n[worktree-details] {"target":"main"}'
          );
        }
        if (input.branch === 'clash') return { merged: false, commit: null, target: 'main', conflicts: ['a.txt'] };
        return { merged: true, commit: 'abcdef0123456789', target: 'main' };
      },
    };
    actions.mergeIntoCurrent(branch('feature'));
    actions.mergeIntoCurrent(branch('moved'));
    actions.mergeIntoCurrent(branch('clash'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(runs);
  } finally {
    overrideConfirmAction(null);
  }
  assert.deepEqual(
    calls.filter((call) => call.capability === 'mergeProjectBranch').map((call) => call.args[0]),
    [
      { projectPath: '/p', branch: 'feature', target: 'main' },
      { projectPath: '/p', branch: 'moved', target: 'main' },
      { projectPath: '/p', branch: 'clash', target: 'main' },
    ]
  );
  assert.deepEqual(results, [
    ['branch-merge:feature', 'ok', 'Merged feature into main (abcdef01).'],
    ['branch-merge:moved', 'error', 'The project folder switched to another branch. Check the target and merge again.'],
    ['branch-merge:clash', 'error', 'Nothing was merged. Conflicting files: a.txt'],
  ]);
});

test('opening a history commit as a branch is the guarded checkout with a start commit; the remote shim has no raw path', async () => {
  setUiLanguagePreference('en');
  await initUiLanguage();
  const { historyCommitActions } = await import('./source-control-actions.ts');
  const runs = [];
  const results = [];
  const ctx = {
    api: {
      gitCreateBranchAtCommit: () => assert.fail('a raw create bypasses the guard'),
      gitCheckoutCommit: () => assert.fail('a raw detached checkout bypasses the guard'),
    },
    projectPath: '/p',
    run: (key, action) =>
      runs.push(
        Promise.resolve()
          .then(action)
          .then(() => results.push([key, 'ok']))
          .catch((error) => results.push([key, error.message]))
      ),
    setError: () => {},
  };
  const originalPrompt = window.prompt;
  const names = ['from-history', 'dirty-try'];
  window.prompt = () => names.shift();
  overrideConfirmAction(() => true);
  const entry = { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', subject: 'Base' };
  try {
    const actions = historyCommitActions(ctx, { commitMessage: '', clearCommitDraft() {} });
    calls.length = 0;
    handlers = {
      selectProjectBranch: (request) => {
        const [input] = request.args;
        if (input.branch === 'dirty-try') throw new Error('Error invoking remote method: WORKTREE_DIRTY: dirty');
        if (input.detach) return { branch: null, changed: true, commit: input.detach, detached: true };
        return { branch: input.branch, changed: true };
      },
    };
    actions.createBranchAtCommit(entry);
    actions.createBranchAtCommit(entry);
    actions.checkoutCommit(entry);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(runs);
    // A session working in the folder refuses the detached checkout readably.
    handlers.selectProjectBranch = () => {
      throw new Error('Error invoking remote method: WORKTREE_BUSY_JOBS: folder in use');
    };
    runs.length = 0;
    actions.checkoutCommit(entry);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(runs);
  } finally {
    window.prompt = originalPrompt;
    overrideConfirmAction(null);
  }
  assert.deepEqual(
    calls.filter((call) => call.capability === 'selectProjectBranch').map((call) => call.args[0]),
    [
      { projectPath: '/p', branch: 'from-history', create: true, startPoint: 'a'.repeat(40) },
      { projectPath: '/p', branch: 'dirty-try', create: true, startPoint: 'a'.repeat(40) },
      { projectPath: '/p', detach: 'a'.repeat(40) },
      { projectPath: '/p', detach: 'a'.repeat(40) },
    ]
  );
  assert.deepEqual(results, [
    [`branch-create-at:${'a'.repeat(40)}`, 'ok'],
    [
      `branch-create-at:${'a'.repeat(40)}`,
      'The project folder has uncommitted changes. Commit or stash them before switching branches.',
    ],
    [`checkout-commit:${'a'.repeat(40)}`, 'ok'],
    [
      `checkout-commit:${'a'.repeat(40)}`,
      'Background tasks are still running. Wait for them or stop them, then try again.',
    ],
  ]);
});

test('typed failures carry their details across IPC: disk sizes and the holder path', () => {
  const disk = model.worktreeFailure(
    new Error(
      'Error invoking remote method: WORKTREE_DISK_INSUFFICIENT: no space\n[worktree-details] {"requiredBytes":3221225472,"freeBytes":1073741824}'
    )
  );
  assert.equal(disk.code, 'WORKTREE_DISK_INSUFFICIENT');
  assert.equal(disk.message, 'Error invoking remote method: WORKTREE_DISK_INSUFFICIENT: no space');
  assert.equal(
    model.worktreeFailureText(disk),
    'Not enough free disk space to create the worktree (3.0 GB needed, 1.0 GB free).'
  );
  const occupied = model.worktreeFailure(
    new Error('WORKTREE_BRANCH_OCCUPIED: taken\n[worktree-details] {"branch":"dev","path":"/elsewhere/dev"}')
  );
  assert.equal(model.worktreeFailureText(occupied), 'This branch is already checked out in /elsewhere/dev.');
  assert.equal(
    model.worktreeFailureText(model.worktreeFailure(new Error('WORKTREE_BRANCH_OCCUPIED: taken'))),
    'This branch is already checked out in another worktree.'
  );
  assert.equal(
    model.worktreeFailureText(model.worktreeFailure(new Error('WORKTREE_REMOVAL_INCOMPLETE: partly'))),
    'The worktree could not be removed completely because a file is still in use. Close it and remove the worktree again.'
  );
});

test('a refused carry names its own reason and never reads as the worktree-removal text', () => {
  const removal = 'The worktree has uncommitted changes.';
  const dirty = (details) =>
    model.worktreeFailure(new Error(`WORKTREE_DIRTY: refused\n[worktree-details] ${JSON.stringify(details)}`));
  const text = (details, options) => model.worktreeFailureText(dirty(details), options);
  const cases = [
    [{ reason: 'operation-in-progress', operation: 'merge' }, /^A merge is in progress in the project folder\./],
    [{ reason: 'operation-in-progress', operation: 'rebase' }, /^A rebase is in progress/],
    [{ reason: 'operation-in-progress', operation: 'cherry-pick' }, /^A cherry-pick is in progress/],
    [{ reason: 'operation-in-progress', operation: 'revert' }, /^A revert is in progress/],
    [{ reason: 'operation-in-progress', operation: 'bisect' }, /^A bisect is in progress/],
    [{ reason: 'operation-in-progress', operation: 'unknown-op' }, /^A Git operation is in progress/],
    [{ reason: 'assume-unchanged', paths: ['a.txt'] }, /^Files hidden from Git/],
    [{ reason: 'skip-worktree', paths: ['a.txt'] }, /^Files hidden from Git/],
    [{ reason: 'sparse-checkout' }, /^Files hidden from Git/],
    [{ reason: 'intent-to-add', paths: ['a.txt'] }, /git add -N/],
    [{ reason: 'unmerged-paths' }, /unresolved merge conflicts/],
    [{ reason: 'dirty-submodules', paths: ['lib'] }, /^Submodules with changes/],
    [{ reason: 'nested-repository', paths: ['vendor/x/'] }, /nested repositories/],
    [{ reason: 'filtered-paths', paths: ['a.bin'] }, /Git LFS/],
    [{ reason: 'too-large', files: 5200, maxFiles: 5000 }, /\(5200, limit 5000\)/],
    [{ reason: 'too-large', maxBytes: 200 * 1048576 }, /over 200 MB/],
    [{ reason: 'something-new' }, /^The changes couldn't be brought into the worktree\./],
  ];
  for (const [details, expected] of cases) {
    const value = text(details, { carry: true });
    assert.match(value, expected, JSON.stringify(details));
    assert.notEqual(value, removal);
    // The reason decides, even on a branch switch that brought the changes.
    assert.match(text(details, { checkout: true }), expected);
  }
  // A carry failure keeps the runtime's recovery hint.
  assert.equal(text({ reason: 'carry-failed', recoveryRef: 'refs/mixdog/carry/1' }), 'refused');
  // No details across the hop: a carry still never reads as a removal.
  assert.equal(
    model.worktreeFailureText(model.worktreeFailure(new Error('WORKTREE_DIRTY: refused')), { carry: true }),
    "The changes couldn't be brought into the worktree. Leave them in the project folder instead, or try again."
  );
  // The removal and project-folder readings are unchanged.
  assert.equal(model.worktreeFailureText(model.worktreeFailure(new Error('WORKTREE_DIRTY: x'))), removal);
  assert.match(text({ reason: 'project-dirty', count: 1 }), /^The project folder has uncommitted changes/);
  // Busy shells of other sessions in the folder have their own text.
  assert.match(
    model.worktreeFailureText(
      model.worktreeFailure(new Error('WORKTREE_BUSY_JOBS: busy\n[worktree-details] {"reason":"folder-shell-jobs"}'))
    ),
    /^Background commands still use an affected folder\./
  );
});

test('a New Task first send carries its worktree choice; a large repository confirms once and resends', async () => {
  setUiLanguagePreference('en');
  await initUiLanguage();
  const coded = (code) => new Error(`Error invoking remote method 'mixdog:submit-new-task': Error: ${code}: refused`);
  // No choice: one plain send.
  const plain = [];
  assert.equal(await model.submitDraftWithWorktree(async (worktree) => (plain.push(worktree), 'sent'), false), 'sent');
  assert.deepEqual(plain, [undefined]);

  // Large repository: ask once, resend with confirmLarge.
  const sent = [];
  const prompts = [];
  const result = await model.submitDraftWithWorktree(
    async (worktree) => {
      sent.push(worktree);
      if (!worktree.confirmLarge) throw coded('WORKTREE_LARGE_REPO_CONFIRM');
      return 'accepted';
    },
    true,
    (message) => (prompts.push(message), true)
  );
  assert.equal(result, 'accepted');
  assert.deepEqual(sent, [{}, { confirmLarge: true }]);
  assert.equal(prompts.length, 1);

  // Declined: nothing is sent again and the caller keeps the draft.
  const declined = [];
  assert.equal(
    await model.submitDraftWithWorktree(
      async (worktree) => {
        declined.push(worktree);
        throw coded('WORKTREE_LARGE_REPO_CONFIRM');
      },
      true,
      () => false
    ),
    null
  );
  assert.deepEqual(declined, [{}]);

  // Disk and busy refusals reject with their readable text.
  for (const [code, text] of [
    ['WORKTREE_DISK_INSUFFICIENT', 'Not enough free disk space to create the worktree.'],
    ['WORKTREE_BUSY_JOBS', 'Background tasks are still running. Wait for them or stop them, then try again.'],
  ]) {
    await assert.rejects(
      model.submitDraftWithWorktree(
        async () => {
          throw coded(code);
        },
        true,
        () => true
      ),
      { message: text }
    );
  }
});
