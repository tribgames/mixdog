import assert from 'node:assert/strict';
import test from 'node:test';

import { previewSessionTools } from '../runtime/agent/orchestrator/session/manager/tool-resolution.mjs';
import { permissionFromToolSpec } from '../runtime/agent/orchestrator/session/manager/tool-resolution.mjs';
import { AUTOMATION_TOOL_SCOPE, registerAutomationAgentTool } from './automation-agents.mjs';
import { WEBHOOK_SESSION_TOOLS } from './webhook-session-run.mjs';

test('webhook sessions expose the read-only bundle plus only the automation agent tool', (t) => {
  assert.deepEqual(WEBHOOK_SESSION_TOOLS, ['tools:readonly', 'tools:mcp']);
  assert.equal(permissionFromToolSpec(WEBHOOK_SESSION_TOOLS), 'read');
  const readOnly = ['find', 'glob', 'list', 'grep', 'code_graph', 'read'];
  const scope = { mcpScopeId: AUTOMATION_TOOL_SCOPE };
  // Without the daemon's agent control registered, nothing beyond reading.
  assert.deepEqual(
    previewSessionTools(WEBHOOK_SESSION_TOOLS, [], scope).map((tool) => tool.name),
    readOnly
  );
  t.after(registerAutomationAgentTool(async () => 'agent task: t1'));
  const names = previewSessionTools(WEBHOOK_SESSION_TOOLS, [], scope).map((tool) => tool.name);
  assert.deepEqual([...names].sort(), [...readOnly, 'agent'].sort());
  for (const forbidden of ['shell', 'task', 'git', 'apply_patch', 'memory']) {
    assert.equal(names.includes(forbidden), false, `${forbidden} must stay unavailable to webhook sessions`);
  }
});
