import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  expose: ['navigator', 'Event', 'CustomEvent'],
});
window.mixdogDesktop = { rendererDiagnostic() {} };

const { useDraftPanePreferences } = await import('./use-draft-pane-preferences.ts');
const { submittedDraftRoute } = await import('./draft-pane-prefs-store.ts');
const { announceSetupChange } = await import('./setup-change-refresh.ts');
const { effortForModelChoice } = await import('./model-route-utils.ts');

const PROJECT = 'C:/Project/mixdog';

/** The catalog gate as the renderer applies it before validation: the
 *  requested path passes through untouched. */
const passThroughProjectPath = (candidate) => String(candidate || '').trim();

function Harness({ preferred, resolve, report }) {
  const selection = { kind: 'new' };
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  report(
    useDraftPanePreferences({
      selection,
      selectionRef,
      snapshot: {},
      projectCatalogValidated: Boolean(preferred),
      preferredDraftProjectPath: preferred,
      effectiveDraftProjectPath: resolve,
    })
  );
  return null;
}

/** Mounts the draft-prefs hook against a live DOM, exposing its API and the
 *  project the "default" draft currently resolves to. */
async function mountDrafts(preferred, resolve = passThroughProjectPath) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const latest = { api: null };
  const render = async (nextPreferred) => {
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          preferred: nextPreferred,
          resolve,
          report: (api) => {
            latest.api = api;
          },
        })
      );
    });
  };
  await render(preferred);
  return {
    render,
    api: () => latest.api,
    project: () => latest.api.resolvedDraftPrefsFor('default').projectPath,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('a draft that never chose a project adopts a catalog that lands later', async (t) => {
  window.localStorage.clear();
  // The phone paints its first New task before the relay answers, so nothing
  // is known about projects yet.
  const drafts = await mountDrafts('');
  t.after(() => drafts.unmount());
  assert.equal(drafts.project(), '');

  await drafts.render(PROJECT);
  assert.equal(drafts.project(), PROJECT);
});

test('orchestration mode is independent of workflow and survives draft reload', async (t) => {
  window.localStorage.clear();
  const first = await mountDrafts(PROJECT);
  await act(async () => first.api().stageNewTaskWorkflow({ id: 'default', name: 'Default' }));
  await act(async () => first.api().stageNewTaskOrchestrationMode('swarm'));
  assert.equal(first.api().resolvedDraftPrefsFor('default').orchestrationMode, 'swarm');
  await first.unmount();
  const restored = await mountDrafts(PROJECT);
  t.after(() => restored.unmount());
  assert.equal(restored.api().newTaskOrchestrationMode, 'swarm');
  await act(async () => restored.api().stageNewTaskOrchestrationMode('none'));
  assert.deepEqual(restored.api().resolvedDraftPrefsFor('default').workflow, { id: 'default', name: 'Default' });
  assert.equal(restored.api().newTaskOrchestrationMode, 'none');
});

test('the empty first paint does not survive as a stored choice', async (t) => {
  window.localStorage.clear();
  const first = await mountDrafts('');
  assert.equal(first.project(), '');
  await first.unmount();

  // Reload with the catalog available: the draft must follow it instead of
  // replaying the empty value its first paint stored.
  const second = await mountDrafts(PROJECT);
  t.after(() => second.unmount());
  assert.equal(second.project(), PROJECT);
});

test('an explicit No project survives a reload', async (t) => {
  window.localStorage.clear();
  const first = await mountDrafts(PROJECT);
  await act(async () => first.api().stageNewTaskProject(''));
  assert.equal(first.project(), '');
  await first.unmount();

  const second = await mountDrafts(PROJECT);
  t.after(() => second.unmount());
  assert.equal(second.project(), '');
});

test('an explicit project choice survives a reload', async (t) => {
  window.localStorage.clear();
  const first = await mountDrafts(PROJECT);
  await act(async () => first.api().stageNewTaskProject('C:/Project/other'));
  await first.unmount();

  const second = await mountDrafts(PROJECT);
  t.after(() => second.unmount());
  assert.equal(second.project(), 'C:/Project/other');
});

test('legacy entries release their empty project and keep real ones', async (t) => {
  window.localStorage.clear();
  window.localStorage.setItem(
    'mixdog.desktop-draft-pane-prefs.v2',
    JSON.stringify([['default', { projectPath: '', modelSelection: null, workflow: null }]])
  );
  const frozen = await mountDrafts(PROJECT);
  assert.equal(frozen.project(), PROJECT);
  await frozen.unmount();

  window.localStorage.clear();
  window.localStorage.setItem(
    'mixdog.desktop-draft-pane-prefs.v2',
    JSON.stringify([
      [
        'default',
        {
          projectPath: 'C:/Project/other',
          modelSelection: null,
          workflow: null,
        },
      ],
    ])
  );
  const kept = await mountDrafts(PROJECT);
  t.after(() => kept.unmount());
  assert.equal(kept.project(), 'C:/Project/other');
});

test('a catalog that cannot place the stored project releases it, not clears it', async (t) => {
  window.localStorage.clear();
  const chosen = await mountDrafts(PROJECT);
  await act(async () => chosen.api().stageNewTaskProject(PROJECT));
  assert.equal(chosen.project(), PROJECT);
  await chosen.unmount();

  // A phone that reconnects onto an empty catalog: every lookup answers "".
  const blank = await mountDrafts(PROJECT, () => '');
  assert.equal(blank.project(), '');
  await blank.unmount();

  // The lost lookup must not have been stored as an explicit No project, so
  // the choice returns on its own once the catalog is whole again.
  const recovered = await mountDrafts(PROJECT);
  t.after(() => recovered.unmount());
  assert.equal(recovered.project(), PROJECT);
});

const ASTRA = { provider: 'p', model: 'astra', effort: 'high' };

async function mountWithNextTaskModel() {
  window.localStorage.clear();
  const drafts = await mountDrafts(PROJECT);
  await act(async () => drafts.api().stageNewTaskModelSelection(ASTRA));
  return drafts;
}

test('tuning another conversation leaves the next-task model unchanged, including persisted', async (t) => {
  const first = await mountWithNextTaskModel();
  await act(async () => first.api().rememberSessionRouteForNextTask({ provider: 'p', model: 'sol', effort: 'low' }));
  assert.equal(first.api().lastNewTaskPrefs.current.modelSelection.model, 'astra');
  assert.equal(first.api().newTaskModelSelection.model, 'astra');
  await first.unmount();
  const second = await mountDrafts(PROJECT);
  t.after(() => second.unmount());
  assert.equal(second.api().lastNewTaskPrefs.current.modelSelection.model, 'astra');
});

test('tuning the same model as the next-task model still merges', async (t) => {
  const drafts = await mountWithNextTaskModel();
  t.after(() => drafts.unmount());
  await act(async () => drafts.api().rememberSessionRouteForNextTask({ provider: 'p', model: 'astra', effort: 'low' }));
  const next = drafts.api().lastNewTaskPrefs.current.modelSelection;
  assert.equal(next.model, 'astra');
  assert.equal(next.effort, 'low');
});

// Issue #149: a New task wrote its draft's selection over the Main (Lead)
// route, so an effort the draft only inherited from the last-used cache
// (written before the Lead was edited) replaced the Lead's saved effort.
// An unpicked draft now paints and runs on the Main route the host holds and
// sends no route; only a pick made in that draft is written.
const LAST_PREFS_KEY = 'mixdog.desktop-last-new-task-prefs.v2';
const CACHED_HIGH = { provider: 'p', model: 'astra', effort: 'high' };

/** A host whose Main route can be rewritten from outside this window. */
function installHost(effort) {
  const host = { main: { provider: 'p', model: 'astra', effort } };
  window.mixdogDesktop = {
    rendererDiagnostic() {},
    invokeCapability: async () => ({ value: [], snapshot: host.main }),
  };
  return host;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** A fresh draft whose last-used cache still says high. */
async function mountInheriting() {
  window.localStorage.clear();
  window.localStorage.setItem(
    LAST_PREFS_KEY,
    JSON.stringify({ projectPath: null, modelSelection: CACHED_HIGH, workflow: null })
  );
  const drafts = await mountDrafts(PROJECT);
  await settle();
  return drafts;
}

const resolved = (drafts) => drafts.api().resolvedDraftPrefsFor('default');

test('an unpicked draft paints the host Main route and sends no route', async (t) => {
  installHost('medium');
  const drafts = await mountInheriting();
  t.after(() => drafts.unmount());
  assert.equal(resolved(drafts).modelSelection.effort, 'medium', 'not the cached high');
  assert.equal(submittedDraftRoute(resolved(drafts)), null);
});

// (a) Workflows → Lead and (b) Settings → Model both raise the setup-change
// event after saving; the open draft re-reads the host's Main route.
test('a Lead edited in Workflows or Settings reaches an open draft, and the next task keeps it', async (t) => {
  const host = installHost('high');
  const drafts = await mountInheriting();
  t.after(() => drafts.unmount());
  assert.equal(resolved(drafts).modelSelection.effort, 'high');

  host.main = { ...host.main, effort: 'medium' };
  await act(async () => announceSetupChange('set_route'));
  await settle();

  assert.equal(resolved(drafts).modelSelection.effort, 'medium');
  assert.equal(submittedDraftRoute(resolved(drafts)), null, 'nothing is written back over the Lead');
});

// (c) A phone, the TUI or the setup tool writes the host config: no event
// reaches this window, but opening a draft / returning to the window re-reads.
test('a Lead rewritten outside this window is read when the draft opens or the window returns', async (t) => {
  const host = installHost('high');
  const first = await mountInheriting();
  host.main = { ...host.main, effort: 'medium' };
  await act(async () => window.dispatchEvent(new Event('focus')));
  await settle();
  assert.equal(resolved(first).modelSelection.effort, 'medium');
  assert.equal(submittedDraftRoute(resolved(first)), null);
  await first.unmount();

  host.main = { ...host.main, effort: 'low' };
  const reopened = await mountDrafts(PROJECT);
  t.after(() => reopened.unmount());
  await settle();
  assert.equal(resolved(reopened).modelSelection.effort, 'low');
  assert.equal(submittedDraftRoute(resolved(reopened)), null);
});

test('an explicit pick in the draft is the one thing sent, and a host change does not override it', async (t) => {
  const host = installHost('medium');
  const drafts = await mountInheriting();
  t.after(() => drafts.unmount());
  const pick = { provider: 'p', model: 'astra', effort: 'high' };
  await act(async () => drafts.api().stageNewTaskModelSelection(pick));
  assert.deepEqual(submittedDraftRoute(resolved(drafts)), pick);

  host.main = { ...host.main, effort: 'low' };
  await act(async () => announceSetupChange('set_route'));
  await settle();
  assert.equal(resolved(drafts).modelSelection.effort, 'high');
  assert.deepEqual(submittedDraftRoute(resolved(drafts)), pick);
});

test('re-picking a model keeps the effort on screen, then the host saved one, before the picker memory', () => {
  const values = ['low', 'medium', 'high'];
  const choose = (extra) => effortForModelChoice({ values, sameModel: true, ...extra });
  assert.equal(choose({ current: 'medium', saved: 'low', remembered: 'high' }), 'medium');
  assert.equal(choose({ current: '', saved: 'medium', remembered: 'high' }), 'medium', 'saved outranks remembered');
  assert.equal(choose({ current: '', saved: null, remembered: 'high' }), 'high');
  assert.equal(choose({ current: '', saved: null, remembered: 'xhigh' }), 'high', 'fallback list');
});

test('an explicit model choice replaces the next-task model', async (t) => {
  const drafts = await mountWithNextTaskModel();
  t.after(() => drafts.unmount());
  await act(async () =>
    drafts.api().rememberSessionRouteForNextTask({ provider: 'p', model: 'sol', effort: 'low' }, { modelChoice: true })
  );
  assert.equal(drafts.api().lastNewTaskPrefs.current.modelSelection.model, 'sol');
});
