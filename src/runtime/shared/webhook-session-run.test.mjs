import assert from 'node:assert/strict';
import test from 'node:test';

import { previewSessionTools } from '../agent/orchestrator/session/manager/tool-resolution.mjs';
import { WEBHOOK_SESSION_TOOLS } from './webhook-session-run.mjs';

test('webhook sessions expose only the deterministic read-only tool bundle', () => {
  assert.deepEqual(WEBHOOK_SESSION_TOOLS, ['tools:readonly']);
  const names = previewSessionTools(WEBHOOK_SESSION_TOOLS, []).map((tool) => tool.name);
  assert.deepEqual(names, ['find', 'glob', 'list', 'grep', 'code_graph', 'read']);
  for (const forbidden of ['shell', 'task', 'git', 'apply_patch', 'agent', 'memory']) {
    assert.equal(names.includes(forbidden), false, `${forbidden} must stay unavailable to webhook sessions`);
  }
});
