import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const noop = () => {};
const modelA = {
  provider: 'openai',
  model: 'gpt-draft-a',
  display: 'Draft A',
  effortOptions: [],
  fastCapable: false,
  fastEfforts: [],
  modelParameterOptions: [],
  parameterVariants: [],
  defaultModelParameters: {},
  savedModelParameters: {},
};
const modelB = { ...modelA, model: 'gpt-draft-b', display: 'Draft B' };

async function mount(t, element, invoke = async () => ({ value: null })) {
  const { document, root } = installTestDom(t, {
    rootId: 'root',
    expose: ['HTMLElement', 'Node', 'Event', 'CustomEvent', 'MutationObserver'],
  });
  window.HTMLElement.prototype.scrollIntoView ??= noop;
  window.HTMLElement.prototype.attachEvent ??= noop;
  window.HTMLElement.prototype.detachEvent ??= noop;
  const routeWrites = [];
  window.mixdogDesktop = {
    rendererDiagnostic: noop,
    listProviderModels: async () => [modelA, modelB],
    invokeCapability: async (request) =>
      request.capability === 'getProviderSetup'
        ? { value: { api: [{ id: 'openai', authenticated: true }] }, snapshot: null }
        : invoke(request),
    setModelRoute: async (selection) => {
      routeWrites.push(selection);
      return selection;
    },
    sessionStreamPosition: async () => ({ epoch: 'unfed', seq: 1, order: 1 }),
  };
  window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  if (!globalThis.getComputedStyle) {
    globalThis.getComputedStyle = window.getComputedStyle.bind(window);
    t.after(() => delete globalThis.getComputedStyle);
  }
  window.requestAnimationFrame ??= globalThis.requestAnimationFrame;
  window.cancelAnimationFrame ??= globalThis.cancelAnimationFrame;
  await act(async () => root.render(element));
  return { document, root, routeWrites };
}

function draftInfo({ open = true, picked = [], projectPath = '', draftId = 'default', ...over } = {}) {
  return {
    open,
    onToggle: noop,
    answersModelPickerRequests: false,
    draft: {
      project: {
        projects: [{ path: 'C:/work/app', name: 'app' }],
        activePath: projectPath,
        activeLabel: projectPath ? 'app' : '',
        disabled: false,
        onClear: () => picked.push('clear'),
        onSelect: (path) => picked.push(`project ${path}`),
      },
      workflow: { workflow: null, disabled: false, invokeResult: async (action) => action(), applySnapshot: noop },
      delegation: {
        mode: 'none',
        disabled: false,
        invokeResult: async () => assert.fail('a draft pick never reaches the session'),
        applySnapshot: noop,
        onDraftChange: (mode) => picked.push(`mode ${mode}`),
      },
      branch: { sessionId: '', draftId, projectPath },
    },
    model: {
      provider: modelA.provider,
      model: modelA.model,
      effort: '',
      fast: false,
      fastCapable: false,
      sessionId: '',
      modelDisabled: false,
      tuningDisabled: false,
      invokeResult: async (action) => action(),
      applySnapshot: noop,
      onOpenSettings: noop,
      onDraftModelSelection: (selection) => picked.push(`model ${selection.model}`),
    },
    ...over,
  };
}

const settle = () =>
  act(async () => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  });

test("a New Task's Info holds its context pickers and model, and a pick acts on the draft", async (t) => {
  const { DraftInfoSection } = await import('./session-rail-draft.tsx');
  const picked = [];
  const { document } = await mount(t, React.createElement(DraftInfoSection, draftInfo({ picked })));
  const row = (title) => document.querySelector(`[data-category="info"] button.session-rail-row[title="${title}"]`);
  assert.equal(row('Project').textContent, 'ProjectNo project');
  assert.ok(document.querySelector('[data-category="info"] .session-rail-model'), 'the model the composer line held');
  const pick = async (title, label) => {
    await act(async () => row(title).click());
    const option = [...document.querySelectorAll('.route-sheet-option')].find((el) => el.textContent.startsWith(label));
    await act(async () => option.click());
  };
  await pick('Project', 'app');
  await pick('Delegation mode', 'Swarm');
  assert.deepEqual(picked, ['project C:/work/app', 'mode swarm']);
});

test("a model picked in a New Task's Info replaces the draft's own pick and writes no route", async (t) => {
  const { DraftInfoSection } = await import('./session-rail-draft.tsx');
  const picked = [];
  const { document, routeWrites } = await mount(t, React.createElement(DraftInfoSection, draftInfo({ picked })));
  await settle();
  await act(async () => document.querySelector('.session-rail-model button.session-rail-row').click());
  const modelRow = [...document.querySelectorAll('.route-sheet-row')].find((el) => el.textContent.includes('Model'));
  await act(async () => modelRow.click());
  const option = [...document.querySelectorAll('.route-sheet-flyout--model [role="option"]')].find((el) =>
    el.textContent.includes('Draft B')
  );
  await act(async () => option.click());
  assert.deepEqual(picked, ['model gpt-draft-b'], 'staged in the draft, as the first message sends it');
  assert.deepEqual(routeWrites, [], 'no route write the draft would override');
});

test('folding Info before the branch read answers still arms the New Task default worktree', async (t) => {
  const { DraftInfoSection } = await import('./session-rail-draft.tsx');
  const { clearBranchMenuReads } = await import('./branch-menu-data.ts');
  const { getWorktreeIntent } = await import('./worktree-branch-model.ts');
  clearBranchMenuReads();
  let answer;
  const read = new Promise((resolve) => {
    answer = resolve;
  });
  const invoke = async ({ capability }) => {
    if (capability === 'getProjectBranchMenu') return { value: await read };
    if (capability === 'getWorktreeSettings') return { value: { newTaskDefault: 'worktree' } };
    return { value: null };
  };
  const props = (open) => draftInfo({ open, projectPath: 'C:/work/app', draftId: 'draft-folded' });
  const { root } = await mount(t, React.createElement(DraftInfoSection, props(true)), invoke);
  await act(async () => root.render(React.createElement(DraftInfoSection, props(false))));
  await act(async () =>
    answer({
      workspace: {
        projectPath: 'C:/work/app',
        repoCommonDir: 'C:/work/app/.git',
        cwd: 'C:/work/app',
        worktreeId: null,
        branch: 'main',
        transition: { state: 'idle' },
      },
      branches: [],
      worktrees: [],
    })
  );
  await settle();
  assert.equal(getWorktreeIntent('draft-folded'), true, 'the first message starts in a worktree');
});
