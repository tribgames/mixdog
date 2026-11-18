import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';

assert.ok(process.versions.electron, 'the fixture must run on packaged Electron, not checkout Node');
assert.equal(realpathSync.native(process.execPath), process.argv[2], 'the fixture must run on Electron from this package');

const tool = {
  name: 'packaged_echo',
  description: 'Echoes fixture text.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  annotations: { readOnlyHint: true },
};

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const { id, method, params } = JSON.parse(line);
  if (id == null) continue;
  let reply;
  switch (method) {
    case 'initialize':
      reply = { result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'packaging-fixture', version: '1.0.0' },
      } };
      break;
    case 'tools/list':
      reply = { result: { tools: [tool] } };
      break;
    case 'tools/call':
      if (params.name === tool.name) reply = { result: { content: [{ type: 'text', text: params.arguments.text }] } };
      break;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...(reply ?? { error: { code: -32601, message: 'Method not found' } }) })}\n`);
}
