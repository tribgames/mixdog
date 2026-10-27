// The Workflows editors never re-send a stored fallback list the user did not
// edit: a route may keep a fallback that is inactive on the main model's provider
// (the runtime refuses an explicit list that repeats it).
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['HTMLElement'],
});
const { createRoot } = await import('react-dom/client');
const { useWorkflowEditors } = await import('./workflows-editors.tsx');
const { routeWithEditedFallbacks } = await import('./RouteChainEditor.tsx');
test.after(() => dom.window.close());

const DUPLICATE = { provider: 'anthropic-oauth', model: 'claude-sonnet-5-5' };
const OTHER = { provider: 'openai', model: 'gpt-5.4' };
// Stored: main on anthropic-oauth, whose own provider is repeated by a fallback.
const STORED = { provider: 'anthropic-oauth', model: 'claude-opus-5-5', fallbacks: [DUPLICATE, OTHER] };

function mount(t, api = {}) {
  const calls = [];
  const mainRoutes = [];
  let editors;
  function Probe() {
    editors = useWorkflowEditors({
      api,
      active: true,
      run: async (capability, args) => {
        calls.push([capability, args]);
        return {};
      },
      setError() {},
      setMainRoute: (route) => mainRoutes.push(route),
      onDismiss() {},
    });
    return null;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return {
    calls,
    mainRoutes,
    editors: () => editors,
    render: () => act(async () => root.render(React.createElement(Probe))),
  };
}

test('routeWithEditedFallbacks omits an unchanged list and keeps an edited one', () => {
  const primaryOnly = { ...STORED, model: 'claude-haiku-5-5' };
  const omitted = routeWithEditedFallbacks(primaryOnly, STORED);
  assert.equal('fallbacks' in omitted, false);
  assert.equal(omitted.model, 'claude-haiku-5-5');
  // The same rows rebuilt with another key order are still unchanged.
  const reordered = { ...primaryOnly, fallbacks: [{ model: DUPLICATE.model, provider: DUPLICATE.provider }, OTHER] };
  assert.equal('fallbacks' in routeWithEditedFallbacks(reordered, STORED), false);
  const edited = { ...STORED, fallbacks: [OTHER] };
  assert.deepEqual(routeWithEditedFallbacks(edited, STORED).fallbacks, [OTHER]);
  const cleared = { ...STORED, fallbacks: [] };
  assert.deepEqual(routeWithEditedFallbacks(cleared, STORED).fallbacks, []);
  assert.equal(
    'fallbacks' in
      routeWithEditedFallbacks({ provider: 'openai', model: 'a', fallbacks: [] }, { provider: 'openai', model: 'a' }),
    false
  );
});

test('switching an agent on or off sends only the switch, never the stored route', async (t) => {
  const harness = mount(t);
  await harness.render();
  harness.editors().setAgentEnabled('reviewer', true);
  harness.editors().setAgentEnabled('reviewer', false);
  assert.deepEqual(harness.calls, [
    ['setAgentRoute', ['reviewer', { disabled: false }]],
    ['setAgentRoute', ['reviewer', { disabled: true }]],
  ]);
});

for (const capability of ['setAgentRoute', 'setModelRoute']) {
  test(`${capability}: a primary-only edit omits the stored fallbacks; a row edit sends the list`, async (t) => {
    const sent = [];
    const harness = mount(t, {
      async setModelRoute(selection) {
        sent.push(selection);
        return { ...selection };
      },
    });
    await harness.render();
    const target = {
      id: 'reviewer',
      label: 'Reviewer',
      route: STORED,
      capability,
      modelKind: capability === 'setModelRoute' ? 'main' : 'agent',
      description: '',
      readOnlyDefinition: false,
    };
    const submit = async (route) => {
      await act(async () => harness.editors().openRoute(target));
      await act(async () => harness.editors().saveRoute(route));
    };
    const routeOf = () => (capability === 'setModelRoute' ? sent.at(-1) : harness.calls.at(-1)[1][1]);

    await submit({ ...STORED, model: 'claude-haiku-5-5', effort: 'low' });
    assert.equal(routeOf().model, 'claude-haiku-5-5');
    assert.equal('fallbacks' in routeOf(), false, 'the stored list is kept, not re-sent');

    await submit({ ...STORED, fallbacks: [OTHER] });
    assert.deepEqual(routeOf().fallbacks, [OTHER], 'a deliberate list edit is sent');
  });
}

test('saving an agent definition omits unchanged fallbacks and sends an edited list', async (t) => {
  const harness = mount(t, {
    async invokeCapability({ capability }) {
      return {
        value:
          capability === 'getAgentDefinition'
            ? { id: 'reviewer', name: 'Reviewer', route: STORED, routeConfigured: true }
            : {},
      };
    },
  });
  await harness.render();
  await act(async () => harness.editors().openAgentEditor('reviewer', 'Reviewer', true));
  const saved = () => harness.calls.filter(([capability]) => capability === 'saveAgentDefinition').at(-1)[1][0];
  await act(async () =>
    harness.editors().saveAgent({ id: 'reviewer', route: { ...STORED, model: 'claude-haiku-5-5' } })
  );
  assert.equal(saved().route.model, 'claude-haiku-5-5');
  assert.equal('fallbacks' in saved().route, false);
  await act(async () => harness.editors().saveAgent({ id: 'reviewer', route: { ...STORED, fallbacks: [OTHER] } }));
  assert.deepEqual(saved().route.fallbacks, [OTHER]);
});
