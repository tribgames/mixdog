import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';

import { installTestDom } from './test-support/test-dom.mjs';
import { useConversationQuotaCard } from './use-conversation-quota-card.ts';

const stop = [
  { kind: 'user', text: 'go' },
  { kind: 'turndone', status: 'failed', quota: { provider: 'p', model: 'm', resetAt: null } },
];
const keys = ['k1', 'k2'];

function Harness({ sessionId, items, loaded = true }) {
  useConversationQuotaCard({
    draftMode: false,
    snapshot: loaded ? { sessionId, items } : {},
    sessionId,
    settledItems: items,
    settledTurnKeys: items.length === 2 ? keys : [],
    pendingPromptCount: 0,
    invokeResult: async () => undefined,
  });
  return null;
}

async function watch(t, run) {
  const { root, window } = installTestDom(t, { rootId: 'root' });
  window.mixdogDesktop = { invokeCapability: async () => ({ value: null }) };
  const toasts = [];
  window.addEventListener('mixdog:desktop-toast', (event) => toasts.push(event.detail));
  const render = (props) => act(async () => root.render(React.createElement(Harness, props)));
  await run(render);
  return toasts;
}

test('the first stop of a new, empty session toasts once', async (t) => {
  const toasts = await watch(t, async (render) => {
    await render({ sessionId: 'new-1', items: [] });
    await render({ sessionId: 'new-1', items: stop });
    await render({ sessionId: 'new-1', items: stop });
  });
  assert.deepEqual(
    toasts.map((toast) => toast.tone),
    ['warn']
  );
});

test('a stop already in a loaded session, or in one still loading, never toasts', async (t) => {
  const toasts = await watch(t, async (render) => {
    await render({ sessionId: 'old-1', items: stop });
    await render({ sessionId: 'old-1', items: stop });
    await render({ sessionId: 'old-2', items: [], loaded: false });
    await render({ sessionId: 'old-2', items: stop });
  });
  assert.deepEqual(toasts, []);
});
