import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { installTestDom, toolModulesSource } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Node'],
  actEnvironment: false,
});
globalThis.HTMLElement.prototype.scrollIntoView = () => {};
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);

// ACP agents turned off: the core still reports its agents, and `model/list` has no row of theirs.
const modules = toolModulesSource();
modules.publish({
  acpAgents: {
    enabled: false,
    agents: [
      {
        id: 'antigravity',
        label: 'Antigravity',
        provider: 'acp-antigravity',
        command: 'agy',
        minimumVersion: '1.5.1',
        state: 'off',
        version: null,
        message: null,
        models: [],
        lastError: null,
        canInstall: true,
        canSignIn: true,
      },
    ],
  },
});
const sent = [];
window.mixdogDesktop = {
  rendererDiagnostic() {},
  sections: modules.sections,
  listProviderModels: async () => [],
  invokeCapability: async (request) => {
    sent.push(request.capability);
    return { value: request.capability === 'getProviderSetup' ? { api: [], oauth: [], local: [] } : null };
  },
  setModelRoute: async () => {
    sent.push('setModelRoute');
    return null;
  },
  setFast: async () => {
    sent.push('setFast');
    return null;
  },
};

const { windowSectionStore } = await import('./section-store.ts');
await windowSectionStore().ready();
const { ModelSelector } = await import('./model-controls.tsx');
const { cachedAgentTierRoute, cachedModelRow, invalidateSharedModelCatalogRequest, writeCachedModelCatalog } =
  await import('./model-catalog-cache.ts');
const { AgentRouteSummary } = await import('./agent-row-parts.tsx');
const { ContextUsageIndicator } = await import('./transcript-status.tsx');
const { createSlashExecutor } = await import('./composer-slash-executor.ts');
const { desktopComposerSlashCommands, slashCommandNotApplicable } = await import('./slash-commands.ts');

const route = { provider: 'acp-antigravity', model: 'default' };

function mountHost(t, afterUnmount = () => {}) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    afterUnmount();
  });
  return { host, root };
}

test("an agent session names its agent's default model and leaves its model controls out when the agent is not listed", async (t) => {
  const { host, root } = mountHost(t);
  await act(async () =>
    root.render(
      React.createElement(ModelSelector, {
        ...route,
        effort: 'high',
        fast: false,
        fastCapable: true,
        modelDisabled: false,
        tuningDisabled: false,
        invokeResult: (work) => work(),
        applySnapshot() {},
        onOpenSettings() {},
      })
    )
  );
  const trigger = host.querySelector('.model-trigger');
  assert.equal(trigger.textContent, 'Default');
  await act(async () => trigger.click());
  const rows = [...document.querySelectorAll('.route-sheet-row')].map((row) => row.textContent);
  assert.equal(rows.length, 1, rows.join(' | '));
  assert.match(rows[0], /^Model/);

  const card = renderToStaticMarkup(
    React.createElement(ContextUsageIndicator, {
      snapshot: {
        sessionId: 'agent-session',
        ...route,
        contextWindow: 200000,
        stats: { currentContextTokens: 8000, currentContextSource: 'last_api_request', currentContextUpdatedAt: 1 },
      },
    })
  );
  // Compact applies to an agent's session as to a provider's: the summary becomes the session's context.
  assert.match(card, /Compact context/);
});

test("the composer's trigger and the session panel's Info row name an agent's model as a provider's", async (t) => {
  const listProviderModels = window.mixdogDesktop.listProviderModels;
  window.mixdogDesktop.listProviderModels = async () =>
    [
      ['gemini-3.8-flash', 'Antigravity ACP · Gemini 3.8 Flash'],
      ['gpt-oss-120b', 'Antigravity ACP · GPT-OSS 120B'],
    ].map(([model, display]) => ({
      provider: 'acp-antigravity',
      model,
      display,
      runner: 'acp',
      agent: 'antigravity',
      // The agent runs each at tiers of its own: they are the model's efforts.
      notApplicable: ['autoEffort', 'fast', 'fallbacks'],
      effortOptions: [{ value: 'medium', label: 'Medium' }],
    }));
  invalidateSharedModelCatalogRequest();
  const { host, root } = mountHost(t, () => {
    window.mixdogDesktop.listProviderModels = listProviderModels;
    window.localStorage.clear();
  });
  const settled = async (model, triggerRowLabel, expected) => {
    await act(async () =>
      root.render(
        React.createElement(ModelSelector, {
          provider: 'acp-antigravity',
          model,
          effort: '',
          fast: false,
          fastCapable: false,
          modelDisabled: false,
          tuningDisabled: false,
          invokeResult: (work) => work(),
          applySnapshot() {},
          onOpenSettings() {},
          ...(triggerRowLabel ? { triggerRowLabel } : {}),
        })
      )
    );
    const trigger = () => host.querySelector(triggerRowLabel ? '.session-rail-pick' : '.model-trigger');
    for (let tries = 0; tries < 50 && trigger()?.textContent !== expected; tries += 1) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    return trigger()?.textContent;
  };
  assert.equal(await settled('gemini-3.8-flash', '', 'Gemini 3.8 Flash'), 'Gemini 3.8 Flash');
  assert.equal(await settled('gpt-oss-120b', '', 'GPT-OSS 120B'), 'GPT-OSS 120B');
  assert.equal(await settled('gemini-3.8-flash', 'Model', 'Gemini 3.8 Flash'), 'Gemini 3.8 Flash');
  assert.equal(await settled('gpt-oss-120b', 'Model', 'GPT-OSS 120B'), 'GPT-OSS 120B');
});

test("with no row of the agent's listed, its model keeps the agent's own name from the first render, never one built from its id", async (t) => {
  window.localStorage.clear();
  invalidateSharedModelCatalogRequest();
  const { host, root } = mountHost(t, () => window.localStorage.clear());
  const firstRender = async (key) => {
    await act(async () =>
      root.render(
        React.createElement(
          'div',
          { key },
          React.createElement(ModelSelector, {
            provider: 'acp-antigravity',
            model: 'gpt-oss-20b',
            effort: 'medium',
            fast: false,
            fastCapable: false,
            modelDisabled: false,
            tuningDisabled: false,
            invokeResult: (work) => work(),
            applySnapshot() {},
            onOpenSettings() {},
          }),
          React.createElement(AgentRouteSummary, {
            agent: {
              provider: 'acp-antigravity',
              model: 'gpt-oss-20b',
              effort: 'medium',
              fast: true,
              status: 'running',
            },
          })
        )
      )
    );
    return [host.querySelector('.model-trigger').textContent, host.querySelector('.agent-route-summary').textContent];
  };
  // Never listed in this window: the id as the agent knows it, not the provider rules' "GPT-Oss-20b"; the agent's
  // row says its effort (the tier it runs) and no speed.
  const [unseenTrigger, unseenSummary] = await firstRender('unseen');
  assert.equal(unseenTrigger, 'gpt-oss-20b');
  assert.match(unseenSummary, /^gpt-oss-20b\s*Medium$/);

  // Listed once while the agent was ready, then a restart's catalog without the agent's rows replaced it.
  writeCachedModelCatalog([
    {
      provider: 'acp-antigravity',
      model: 'gpt-oss-20b',
      display: 'Antigravity ACP · GPT-OSS 20B',
      runner: 'acp',
    },
  ]);
  writeCachedModelCatalog([{ provider: 'openai', model: 'gpt-5', display: 'GPT-5' }]);
  const [listedTrigger, listedSummary] = await firstRender('listed');
  assert.equal(listedTrigger, 'GPT-OSS 20B');
  assert.match(listedSummary, /^GPT-OSS 20B\s*Medium$/);
});

test("a route saved under the agent's own id of one tier reads as the model at that tier's effort", async (t) => {
  window.localStorage.clear();
  writeCachedModelCatalog([
    {
      provider: 'acp-antigravity',
      model: 'gemini-3.8-pro',
      display: 'Antigravity ACP · Gemini 3.8 Pro',
      runner: 'acp',
      effortOptions: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' },
      ],
    },
    // An id the agent lists on its own is that model, whatever it ends in.
    { provider: 'acp-antigravity', model: 'gemini-3.8-pro-low', display: 'Antigravity ACP · Pro Low', runner: 'acp' },
    { provider: 'openai', model: 'gpt-5', display: 'GPT-5', effortOptions: [{ value: 'high', label: 'High' }] },
  ]);
  const tier = cachedAgentTierRoute('acp-antigravity', 'gemini-3.8-pro-high');
  assert.deepEqual([tier?.row.model, tier?.effort], ['gemini-3.8-pro', 'high']);
  assert.equal(cachedModelRow('acp-antigravity', 'gemini-3.8-pro-high')?.model, 'gemini-3.8-pro');
  assert.equal(cachedAgentTierRoute('acp-antigravity', 'gemini-3.8-pro-low'), undefined);
  assert.equal(cachedModelRow('acp-antigravity', 'gemini-3.8-pro-low')?.display, 'Antigravity ACP · Pro Low');
  assert.equal(cachedAgentTierRoute('acp-antigravity', 'gemini-3.8-pro'), undefined);
  assert.equal(cachedAgentTierRoute('openai', 'gpt-5-high'), undefined);

  const { host, root } = mountHost(t, () => window.localStorage.clear());
  await act(async () =>
    root.render(
      React.createElement(AgentRouteSummary, {
        agent: {
          provider: 'acp-antigravity',
          model: 'gemini-3.8-pro-high',
          effort: '',
          fast: false,
          status: 'running',
        },
      })
    )
  );
  assert.match(host.querySelector('.agent-route-summary').textContent, /^Gemini 3.8 Pro\s*High$/);
});

test('on an agent session a command follows the model row: one whose control the model has no use for is not offered and, typed, only says why; /compact is sent', async () => {
  const listed = (notApplicable) =>
    desktopComposerSlashCommands('/', false, notApplicable).map((command) => command.name);
  // A model the agent runs at one level takes neither; one it runs at several takes an effort.
  const single = new Set(['effort', 'autoEffort', 'fast', 'fallbacks']);
  const tiered = new Set(['autoEffort', 'fast', 'fallbacks']);
  for (const name of ['effort', 'fast']) assert.equal(listed(single).includes(name), false, name);
  assert.ok(listed(single).includes('compact'));
  // Typed, a command is judged by the same rows: the effort of a model run at several levels is no refusal.
  for (const [name, row, refused] of [
    ['effort', single, true],
    ['effort', tiered, false],
    ['fast', tiered, true],
    ['compact', single, false],
    ['effort', undefined, false],
  ]) {
    assert.equal(slashCommandNotApplicable(name, row), refused, `/${name}`);
  }

  sent.length = 0;
  const notices = [];
  const errors = [];
  const execute = createSlashExecutor({
    sessionId: 'agent-session',
    turnBusy: true,
    ...route,
    agentRoute: { label: 'Antigravity', notApplicable: single },
    effort: '',
    fast: false,
    fastCapable: false,
    modelParameters: {},
    invokeResult: (work) => work(),
    invokeCapabilityResult: async (capability) => {
      sent.push(capability);
      return { value: null };
    },
    applySnapshot() {},
    setAttachmentError: (message) => message && errors.push(message),
    clearNotice() {},
    showNotice: (message) => notices.push(message),
  });
  for (const command of ['/effort high', '/fast off', '/fast on', '/compact']) await execute(command);
  assert.deepEqual(sent, ['compact']);
  assert.deepEqual(errors, []);
  assert.deepEqual(notices, [
    'Antigravity runs its own model settings, so /effort does not apply to this session.',
    'Antigravity runs its own model settings, so /fast does not apply to this session.',
    'Antigravity runs its own model settings, so /fast does not apply to this session.',
  ]);
});
