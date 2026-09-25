import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotProviderRequestTools } from './provider-request-snapshot.mjs';
import { providerNativeToolPrefixCount } from './provider-request-tools.mjs';

test('Anthropic deferred tool snapshot adds only discovered schemas', () => {
  const session = {
    provider: 'anthropic-oauth',
    deferredNativeTools: true,
    deferredToolCatalog: [
      { name: 'shell', inputSchema: { type: 'object', properties: {} } },
      { name: 'recall', inputSchema: { type: 'object', properties: {} } },
    ],
  };
  const tools = [{ name: 'load_tool', inputSchema: { type: 'object', properties: {} } }];
  const first = snapshotProviderRequestTools({
    provider: session.provider,
    tools,
    messages: [],
    session,
  });
  const later = snapshotProviderRequestTools({
    provider: session.provider,
    tools,
    messages: [
      {
        role: 'tool',
        nativeToolSearch: {
          provider: 'anthropic-oauth',
          toolReferences: ['shell'],
        },
      },
    ],
    session,
  });
  assert.deepEqual(
    first.map((tool) => tool.name),
    ['load_tool']
  );
  assert.deepEqual(
    later.map((tool) => tool.name),
    ['load_tool', 'shell']
  );
  assert.equal(later[1].deferLoading, true);
  assert.equal(
    later.some((tool) => tool.name === 'recall'),
    false
  );
});

function fullSnapshot(options) {
  return snapshotProviderRequestTools(structuredClone(options));
}

function assertMatchesFullSnapshot(options) {
  const snapshot = snapshotProviderRequestTools(options);
  const reference = fullSnapshot(options);
  assert.deepEqual(snapshot, reference);
  assert.equal(providerNativeToolPrefixCount(snapshot), providerNativeToolPrefixCount(reference));
  return snapshot;
}

function referenceMessage(names, provider = 'anthropic-oauth') {
  return { role: 'tool', content: 'loaded', nativeToolSearch: { provider, toolReferences: names } };
}

test('memoized snapshots equal the full computation as catalog and transcript change', () => {
  const schema = (name) => ({ name, inputSchema: { type: 'object', properties: { value: { type: 'string' } } } });
  const session = {
    provider: 'anthropic-oauth',
    deferredNativeTools: true,
    deferredToolCatalog: [schema('shell'), schema('recall'), schema('mcp__demo__one')],
    deferredLateToolCatalog: [schema('mcp__demo__late')],
  };
  const tools = [schema('load_tool'), schema('read')];
  const nativeTools = [{ type: 'web_search_20250305', name: 'web_search' }];
  let messages = [{ role: 'user', content: 'hi' }];
  const options = () => ({ provider: session.provider, tools, nativeTools, messages, session });

  const first = assertMatchesFullSnapshot(options());
  assert.equal(snapshotProviderRequestTools(options()), first, 'unchanged inputs reuse the frozen snapshot');

  // Appended and replaced transcripts, edited and compacted histories.
  messages.push(referenceMessage(['shell']));
  assertMatchesFullSnapshot(options());
  messages = [...messages, referenceMessage(['mcp__demo__late'], 'anthropic')];
  assertMatchesFullSnapshot(options());
  messages[1] = referenceMessage(['recall']);
  assertMatchesFullSnapshot(options());
  messages.push(referenceMessage(['shell'], 'openai'));
  assertMatchesFullSnapshot(options());
  messages = [messages[0], messages.at(-1)];
  assertMatchesFullSnapshot(options());

  // Catalog revisions: in-place tool growth, replaced descriptors and lists,
  // selection state, MCP availability and native definitions.
  tools.push(schema('grep'));
  assertMatchesFullSnapshot(options());
  tools[0] = schema('load_tool');
  assertMatchesFullSnapshot(options());
  session.deferredDiscoveredTools = ['mcp__demo__one'];
  assertMatchesFullSnapshot(options());
  session.deferredMcpToolNames = ['mcp__demo__late'];
  assertMatchesFullSnapshot(options());
  session.deferredToolCatalog = [schema('mcp__demo__one'), schema('shell')];
  session.deferredMcpToolNames = ['mcp__demo__one'];
  assertMatchesFullSnapshot(options());
  nativeTools.pop();
  assertMatchesFullSnapshot(options());
  session.deferredNativeTools = false;
  assertMatchesFullSnapshot(options());
  tools.length = 0;
  assertMatchesFullSnapshot(options());
});

test('a snapshot after appending one message reads only that message', () => {
  const reads = new Map();
  const tracked = (id, names) => {
    reads.set(id, 0);
    const message = referenceMessage(names);
    const nativeToolSearch = message.nativeToolSearch;
    Object.defineProperty(message, 'nativeToolSearch', {
      enumerable: true,
      get() {
        reads.set(id, reads.get(id) + 1);
        return nativeToolSearch;
      },
    });
    return message;
  };
  const session = {
    provider: 'anthropic-oauth',
    deferredNativeTools: true,
    deferredToolCatalog: [{ name: 'shell', inputSchema: { type: 'object' } }],
  };
  const tools = [{ name: 'load_tool', inputSchema: { type: 'object' } }];
  const messages = [tracked('m0', []), tracked('m1', [])];
  const snapshot = () => snapshotProviderRequestTools({ provider: session.provider, tools, messages, session });
  assert.deepEqual(
    snapshot().map((tool) => tool.name),
    ['load_tool']
  );
  for (const id of reads.keys()) reads.set(id, 0);
  messages.push(tracked('m2', ['shell']));
  assert.deepEqual(
    snapshot().map((tool) => tool.name),
    ['load_tool', 'shell']
  );
  assert.deepEqual(Object.fromEntries(reads), { m0: 0, m1: 0, m2: 1 });
});

test('boxed primitives unwrap without probing plain schema records', () => {
  const originalValueOf = Number.prototype.valueOf;
  let probes = 0;
  Number.prototype.valueOf = function valueOf() {
    probes += 1;
    return originalValueOf.call(this);
  };
  let snapshot;
  try {
    snapshot = snapshotProviderRequestTools({
      provider: 'openai',
      tools: [
        {
          name: 'boxed',
          inputSchema: {
            type: 'object',
            properties: { n: { maximum: Object(3) }, s: { title: Object('t') }, b: { default: Object(false) } },
            symbol: Object(Symbol('opaque')),
          },
        },
      ],
      messages: [],
      session: {},
    });
  } finally {
    Number.prototype.valueOf = originalValueOf;
  }
  assert.equal(probes, 1, 'only the boxed Number is unwrapped through Number.prototype.valueOf');
  assert.deepEqual(snapshot[0].inputSchema, {
    type: 'object',
    properties: { n: { maximum: 3 }, s: { title: 't' }, b: { default: false } },
    symbol: {},
  });
  assert.throws(
    () =>
      snapshotProviderRequestTools({
        provider: 'openai',
        tools: [{ name: 'big', inputSchema: { default: Object(1n) } }],
        messages: [],
        session: {},
      }),
    /BigInt is not JSON-serializable/
  );
});

test('Anthropic can select a late MCP schema without exposing unselected peers', () => {
  const session = {
    provider: 'anthropic-oauth',
    deferredNativeTools: true,
    deferredToolCatalog: [],
    deferredLateToolCatalog: [
      { name: 'mcp__demo__selected', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } },
      { name: 'mcp__demo__hidden', inputSchema: { type: 'object', properties: { secret: { type: 'string' } } } },
    ],
    deferredDiscoveredTools: ['mcp__demo__selected'],
  };
  const snapshot = snapshotProviderRequestTools({
    provider: session.provider,
    tools: [{ name: 'load_tool', inputSchema: { type: 'object', properties: {} } }],
    messages: [],
    session,
  });

  assert.deepEqual(
    snapshot.map((tool) => tool.name),
    ['load_tool', 'mcp__demo__selected']
  );
  assert.equal(snapshot[1].deferLoading, true);
});
