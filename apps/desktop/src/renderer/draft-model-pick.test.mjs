import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent'],
});
globalThis.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.HTMLElement.prototype.attachEvent = () => {};
globalThis.HTMLElement.prototype.detachEvent = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);

const catalogModel = (model, display) => ({
  provider: 'openai',
  model,
  display,
  effortOptions: [],
  fastCapable: false,
  fastEfforts: [],
  modelParameterOptions: [],
  parameterVariants: [],
  defaultModelParameters: {},
  savedModelParameters: {},
});
const modelA = catalogModel('gpt-draft-a', 'Draft A');
const modelB = catalogModel('gpt-draft-b', 'Draft B');
const routeWrites = [];
window.mixdogDesktop = {
  rendererDiagnostic() {},
  listProviderModels: async () => [modelA, modelB],
  invokeCapability: async ({ capability }) =>
    capability === 'getProviderSetup'
      ? { value: { api: [{ id: 'openai', authenticated: true }] }, snapshot: null }
      : { value: null, snapshot: null },
  setModelRoute: async (selection, sessionId) => {
    routeWrites.push({ model: selection.model, sessionId });
    return { provider: selection.provider, model: selection.model };
  },
  sessionStreamPosition: async () => ({ epoch: 'unfed', seq: 1, order: 1 }),
};

const { useDraftPanePreferences } = await import('./use-draft-pane-preferences.ts');
const { submittedDraftRoute } = await import('./draft-pane-prefs-store.ts');
const { ComposerModelControls } = await import('./ComposerFooter.tsx');

/** A New Task with the panel off: the draft's prefs and the model control
 *  under its composer, wired as the pane renderer wires them. */
function DraftComposer({ report }) {
  const selection = { kind: 'new' };
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const drafts = useDraftPanePreferences({
    selection,
    selectionRef,
    snapshot: {},
    projectCatalogValidated: true,
    preferredDraftProjectPath: '',
    effectiveDraftProjectPath: (candidate) => String(candidate || ''),
  });
  report(drafts);
  const route = drafts.resolvedDraftPrefsFor('default').modelSelection;
  return React.createElement(ComposerModelControls, {
    provider: route?.provider ?? '',
    model: route?.model ?? '',
    effort: '',
    fast: false,
    fastCapable: false,
    sessionId: '',
    transitioning: false,
    commandBusy: false,
    paneActive: true,
    invokeResult: async (action) => action(),
    applySnapshot() {},
    onOpenSettings() {},
    onDraftModelSelection: (picked) => drafts.stageNewTaskModelSelection(picked, 'default'),
    onRoutePreferenceApplied: drafts.rememberSessionRouteForNextTask,
  });
}

test('a model picked under a New Task composer replaces an earlier /model pick in what the first message sends', async (t) => {
  window.localStorage.clear();
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const latest = { drafts: null };
  await act(async () => root.render(React.createElement(DraftComposer, { report: (drafts) => (latest.drafts = drafts) })));
  // `/model openai:gpt-draft-a` in a draft stages the pick (composer-slash-executor).
  await act(async () => latest.drafts.stageNewTaskModelSelection({ provider: 'openai', model: modelA.model }));
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  });
  await act(async () => document.querySelector('.model-trigger').click());
  const modelRow = [...document.querySelectorAll('.route-sheet-row')].find((el) => el.textContent.includes('Model'));
  await act(async () => modelRow.click());
  const optionB = [...document.querySelectorAll('.route-sheet-flyout--model [role="option"]')].find((el) =>
    el.textContent.includes('Draft B')
  );
  await act(async () => optionB.click());
  assert.equal(submittedDraftRoute(latest.drafts.resolvedDraftPrefsFor('default'))?.model, modelB.model);
  assert.deepEqual(routeWrites, [], "a draft's pick is staged, not written to the host route");
});
