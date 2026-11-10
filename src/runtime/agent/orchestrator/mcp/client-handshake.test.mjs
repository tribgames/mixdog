import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { listAllMcpTools } from './client-handshake.mjs';

const tool = (name) => ({
  name,
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
});

test('a paginated listing keeps the output validators of every page', async () => {
  const pages = { '': { tools: [tool('first')], nextCursor: 'p2' }, p2: { tools: [tool('second')] } };
  const client = new Client({ name: 'test', version: '1.0.0' });
  client.request = async ({ params }) => pages[params?.cursor ?? ''];
  const listed = await listAllMcpTools(client);
  assert.deepEqual(
    listed.tools.map((entry) => entry.name),
    ['first', 'second']
  );
  for (const name of ['first', 'second']) {
    const validate = client.getToolOutputValidator(name);
    assert.ok(validate, `${name} keeps its validator`);
    assert.equal(validate({ n: 'x' }).valid, false);
  }
});
