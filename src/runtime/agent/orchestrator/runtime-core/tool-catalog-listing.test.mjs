import assert from 'node:assert/strict';
import test from 'node:test';

import { applyDeferredToolSurface, rebuildDeferredToolSurfaceForProvider } from './tool-catalog.mjs';

// A standalone tool as the runtime declares it (with a title and a when-to-use trigger) and as a new session stores it in `session.tools`
// (`_getMcpTools` projects an internal tool to name, description, schema and annotations only).
const declared = {
  name: 'zeta_probe',
  title: 'Zeta probe',
  trigger: 'Probe zeta when the user names it.',
  description: 'Probes zeta in depth: reads every zeta source, compares the readings and reports the drift with the evidence for each reading, at length.',
  inputSchema: { type: 'object', properties: {} },
  annotations: {},
};
const { title: _title, trigger: _trigger, ...stored } = declared;

const newSession = (provider) => ({
  id: 'listing-fixture',
  provider,
  model: 'fixture-model',
  toolSpec: 'full',
  tools: [stored],
  messages: [{ role: 'system', content: '# Tool Use' }, { role: 'system', content: '# Profile' }, { role: 'system', content: '# Session', cacheTier: 'tier3' }],
});

const listing = (session) => session.messages.map((message) => message.content).join('\n').match(/^- zeta_probe: .*$/m)?.[0];

test("a new session's deferred listing names the tool's trigger, before and after the surface is rebuilt", () => {
  const session = newSession('anthropic-oauth');
  applyDeferredToolSurface(session, 'lead', [declared], { provider: 'anthropic-oauth' });
  assert.equal(listing(session), `- zeta_probe: ${declared.trigger}`);
  // Another exposure rewrites the fixed listing from the stored catalog.
  rebuildDeferredToolSurfaceForProvider(session, 'gemini');
  assert.equal(listing(session), `- zeta_probe: ${declared.trigger}`);
});
