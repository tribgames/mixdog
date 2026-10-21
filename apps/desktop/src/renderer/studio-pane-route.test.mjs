import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  actEnvironment: false,
});
globalThis.React = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import('react-dom/client');
const { useStudioRouteSync } = await import('./studio-pane-route.ts');
const { DEFAULT_STUDIO_OPTIONS } = await import('./studio-support.ts');

test('options snap onto a gateway model whose quality tiers have no "auto"', async () => {
  const model = { id: 'openai/gpt-image-2.5/flare/text-to-image', label: 'GPT Image 2.5 Flare' };
  const spec = {
    defaultModel: model.id,
    controls: {},
    models: [{ ...model, controls: { resolution: ['1k', '2k'], quality: ['low', 'high'], maxReferences: 8 } }],
  };
  const lane = { id: 'nano-gpt', label: 'NanoGPT', authType: 'api-key', authProvider: 'nano-gpt', authenticated: true };
  let options = { ...DEFAULT_STUDIO_OPTIONS };
  function Probe() {
    const [state, setOptions] = React.useState(DEFAULT_STUDIO_OPTIONS);
    options = state;
    useStudioRouteSync({
      active: false,
      activeModel: model.id,
      api: undefined,
      kind: 'image',
      lane: { ...lane, kinds: ['image'], image: spec, video: null },
      laneId: lane.id,
      model: model.id,
      setLaneId() {},
      setModel() {},
      setOptions,
      spec,
    });
    return null;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Probe)));
    assert.equal(options.quality, 'low', 'an "auto" quality the model does not list never reaches the request');
    assert.equal(options.resolution, '1k');
    assert.equal(options.aspectRatio, 'auto', 'no aspect control, so the value is left alone');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
