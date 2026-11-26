import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  expose: ['HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'Node', 'Element'],
});
test.after(restore);
window.HTMLElement.prototype.scrollIntoView = () => {};
const { createRoot } = await import('react-dom/client');
const { ModelCatalog, filterConfiguredModels } = await import('./model-catalog.tsx');
const { routeOption } = await import('./model-route-utils.ts');
const { normalizeModelOptions } = await import('./provider-display.tsx');
const { agentRouteSummary } = await import('./workflows-agent-rows.tsx');
const { routeEditorModels } = await import('./workflows-editors.tsx');
const { normalizedProviderModels } = await import('../shared/desktop-transcript-limits.ts');

const NOT_APPLICABLE = ['effort', 'autoEffort', 'fast', 'fallbacks'];
const provider = (id, model, display) => ({ provider: id, id: model, name: display, display });
// `model/list` as the core answers it with Antigravity ready: providers' models, then the rows of its two presets,
// both labelled "Antigravity" (mixdog-acp agents.rs `picker_rows`): the official server's Gemini models, then the
// CLI's every other model, with no entry for the agent's default model. A model the agent runs at
// several tiers is one row whose tiers are its efforts; the others take no effort.
const OFFICIAL = { provider: 'acp-antigravity', agent: 'antigravity' };
const CLI = { provider: 'acp-antigravity-cli', agent: 'antigravity-cli' };
const agentRows = [
  [OFFICIAL, 'gemini-3.8-flash', 'Antigravity · Gemini 3.8 Flash', ['low', 'medium', 'high']],
  [OFFICIAL, 'gemini-4-neon', 'Antigravity · Gemini 4 Neon', ['low', 'high']],
  [CLI, 'gpt-oss-120b', 'Antigravity · GPT-OSS 120B', ['medium']],
  [CLI, 'claude-opus-5-5', 'Antigravity · Claude Opus 5.5', []],
].map(([agent, id, display, efforts]) => ({
  ...agent,
  id,
  name: display,
  display,
  runner: 'acp',
  notApplicable: efforts.length ? NOT_APPLICABLE.filter((control) => control !== 'effort') : NOT_APPLICABLE,
  ...(efforts.length
    ? { effortOptions: efforts.map((value) => ({ value, label: value })), defaultEffort: efforts[0] }
    : {}),
}));
const providerRows = [
  provider('openai-oauth', 'gpt-5.5', 'GPT-5.5'),
  provider('openai-api', 'gpt-5.4', 'GPT-5.4'),
  provider('cursor-oauth', 'composer-2.5', 'Composer 2.5'),
  provider('antigravity-oauth', 'gemini-3.8-flash', 'Gemini 3.8 Flash'),
];
const models = normalizedProviderModels([...providerRows, ...agentRows]);
const setup = { oauth: [{ id: 'openai-oauth', authenticated: true }], api: [], local: [] };
const AGENT_ROWS = ['Gemini 3.8 Flash', 'Gemini 4 Neon', 'GPT-OSS 120B', 'Claude Opus 5.5'];

const groups = () =>
  [...document.querySelectorAll('.model-group')].map((section) => [
    section.querySelector('h3').textContent,
    [...section.querySelectorAll('[role="option"]')].map((node) => node.textContent),
  ]);
const agentGroup = () =>
  [...document.querySelectorAll('.model-group')].find(
    (section) => section.querySelector('h3').textContent === 'Antigravity ACP'
  );

async function mount(t, props) {
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
  });
  await act(async () =>
    root.render(
      React.createElement(ModelCatalog, {
        models,
        provider: 'openai-oauth',
        model: 'gpt-5.5',
        onSelect: () => true,
        onClose: () => {},
        onOpenModelManagement: () => {},
        onSetModelPreference: () => {},
        ...props,
      })
    )
  );
}

test("Antigravity ACP is one provider group right below Antigravity OAuth, holding both presets' models once each", async (t) => {
  await mount(t, {});
  assert.deepEqual(groups(), [
    ['OpenAI OAuth', ['GPT-5.5']],
    ['Antigravity OAuth', ['Gemini 3.8 Flash']],
    ['Antigravity ACP', AGENT_ROWS],
    ['Cursor OAuth', ['Composer 2.5']],
    ['OpenAI API', ['GPT-5.4']],
  ]);
  const group = agentGroup();
  assert.equal(group.className, 'model-group model-group--provider');
  assert.equal(group.querySelector('h3 [data-provider-icon]').dataset.providerIcon, 'antigravity');
  assert.equal(document.querySelector('.model-group-note'), null);
});

test('without Antigravity OAuth the agent group follows the last OAuth group', async (t) => {
  await mount(t, { models: models.filter((option) => option.provider !== 'antigravity-oauth') });
  assert.deepEqual(
    groups().map(([title]) => title),
    ['OpenAI OAuth', 'Cursor OAuth', 'Antigravity ACP', 'OpenAI API']
  );
});

test("an agent's model is marked, recent and searched like a provider's, and choosing it picks the agent's route", async (t) => {
  window.localStorage.setItem(
    'mixdog.desktop-recent-models',
    JSON.stringify(['model:acp-antigravity-cli:gpt-oss-120b'])
  );
  t.after(() => window.localStorage.clear());
  const chosen = [];
  const preferences = [];
  await mount(t, {
    provider: 'acp-antigravity-cli',
    model: 'gpt-oss-120b',
    onSelect: (option) => chosen.push(option),
    onSetModelPreference: (option, change) => preferences.push([option.provider, option.model, change]),
  });
  assert.deepEqual(groups()[0], ['Recent', ['GPT-OSS 120B (Antigravity ACP)']]);
  assert.deepEqual(
    [...agentGroup().querySelectorAll('[aria-selected="true"]')].map((node) => node.textContent),
    ['GPT-OSS 120B']
  );

  const search = document.querySelector('.model-search input');
  await act(async () => {
    search.value = 'claude';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.deepEqual(groups(), [['Antigravity ACP', ['Claude Opus 5.5']]]);

  const agentRow = agentGroup().querySelector('[role="option"]');
  // An agent's model is made a favourite from its row's menu, as a provider's is.
  await act(async () => {
    agentRow.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  const favorite = [...document.querySelectorAll('[role="menuitem"]')].find(
    (item) => item.textContent === 'Favorite model'
  );
  assert.ok(favorite, 'the row menu offers the favourite');
  await act(async () => favorite.click());
  assert.deepEqual(preferences, [['acp-antigravity-cli', 'claude-opus-5-5', { favorite: true }]]);

  await act(async () => agentRow.click());
  assert.deepEqual(
    chosen.map(({ provider, model, runner, notApplicable }) => ({
      provider,
      model,
      runner,
      notApplicable,
    })),
    [
      {
        provider: 'acp-antigravity-cli',
        model: 'claude-opus-5-5',
        runner: 'acp',
        notApplicable: NOT_APPLICABLE,
      },
    ]
  );
});

test("an agent's models are offered where a pick is saved, as a connected provider's are", () => {
  for (const [providerSetup, error] of [
    [setup, ''],
    [null, ''],
    [setup, 'unavailable'],
  ]) {
    assert.deepEqual(
      filterConfiguredModels(models, providerSetup, error)
        .filter((option) => option.provider.startsWith('acp-'))
        .map((option) => `${option.provider}/${option.model}`),
      [
        'acp-antigravity/gemini-3.8-flash',
        'acp-antigravity/gemini-4-neon',
        'acp-antigravity-cli/gpt-oss-120b',
        'acp-antigravity-cli/claude-opus-5-5',
      ]
    );
  }
  // A provider that is not connected stays out; the agent needs no entry of the provider setup.
  assert.ok(filterConfiguredModels(models, setup, '').every((option) => option.provider !== 'cursor-oauth'));
});

test('ACP web-search models survive routeOption and filterConfiguredModels for the Web Search editor', () => {
  const rawWebSearchRows = [
    { provider: 'openai-oauth', id: 'gpt-5.5', name: 'GPT-5.5', display: 'GPT-5.5', supportsWebSearch: true },
    ...agentRows.map((row) => ({ ...row, supportsWebSearch: true, webSearchCapable: true })),
  ];
  const webSearchModels = filterConfiguredModels(normalizeModelOptions(rawWebSearchRows.map(routeOption)), setup);
  const offered = routeEditorModels({ id: 'web-search', modelKind: 'webSearch' }, [], webSearchModels);
  assert.deepEqual(
    offered
      .filter((option) => option.provider.startsWith('acp-'))
      .map((option) => `${option.provider}/${option.model}`)
      .sort(),
    [
      'acp-antigravity-cli/claude-opus-5-5',
      'acp-antigravity-cli/gpt-oss-120b',
      'acp-antigravity/gemini-3.8-flash',
      'acp-antigravity/gemini-4-neon',
    ]
  );
  assert.ok(offered.filter((option) => option.provider.startsWith('acp-')).every((option) => option.runner === 'acp'));

  const summary = agentRouteSummary(
    { provider: 'acp-antigravity', model: 'gemini-3.8-flash', effort: 'high' },
    offered,
    { webSearch: true }
  );
  assert.equal(summary.model, 'Gemini 3.8 Flash');
  assert.equal(summary.effort, 'high');
});
