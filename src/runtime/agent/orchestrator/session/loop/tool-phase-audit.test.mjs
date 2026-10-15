// Review regression: the per-turn batch audit records the tool a bridged
// call_tool runs, while the transcript keeps the wire call.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

const dataRoot = mkdtempSync(join(tmpdir(), 'mixdog-tool-phase-audit-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataRoot;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
});

const audited = [];
mock.module(new URL('../../tools/tool-batch-trace.mjs', import.meta.url).href, {
  namedExports: {
    recordToolBatch: (_sessionId, calls) => {
      audited.push(calls.map((call) => ({ id: call.id, name: call.name })));
      return 'batch-fixture';
    },
  },
});
const { agentLoop } = await import('../agent-loop.mjs');
const { setInternalToolsProvider } = await import('../../internal-tools.mjs');

test('recordToolBatch receives the execution call of a bridged call_tool', async (t) => {
  const scopeId = 'tool-phase-audit';
  const probe = {
    name: 'audit_probe',
    description: 'Probe.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  };
  t.after(setInternalToolsProvider({ scopeId, tools: [probe], executor: async () => 'probed' }));
  const session = {
    id: 'audit-session',
    provider: 'openrouter',
    mcpScopeId: scopeId,
    cwd: process.cwd(),
    toolSpec: 'full',
    compaction: { auto: false },
    deferredProviderMode: 'canonical',
    toolExposureMode: 'bridge-v1',
    tools: [],
    deferredToolCatalog: [probe],
    messages: [],
  };
  const messages = [{ role: 'user', content: 'probe' }];
  let sends = 0;
  const provider = {
    name: 'openrouter',
    async send() {
      sends += 1;
      if (sends === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'X', name: 'call_tool', arguments: { name: 'audit_probe', arguments: {} } }],
        };
      }
      return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  await agentLoop(provider, messages, 'fixture-model', session.tools, null, session.cwd, {
    session,
    sessionId: session.id,
  });
  assert.deepEqual(audited, [[{ id: 'X', name: 'audit_probe' }]]);
  const assistant = messages.find((message) => message.toolCalls?.length);
  assert.equal(assistant.toolCalls[0].name, 'call_tool');
  assert.equal(messages.find((message) => message.toolCallId === 'X').content, 'probed');
});
