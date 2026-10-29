import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExplore, EXPLORE_OUTPUT_CAP } from './tool.mjs';
import { EXPLORER_MAX_TOOL_ROUNDS, EXPLORER_SYSTEM_PROMPT, EXPLORER_TOOL_NAMES } from './explorer.mjs';
import { featureDisallowedToolsFor } from '../agent/orchestrator/runtime-core/builtin-features.mjs';

const ROUTE = { provider: 'openai', model: 'gpt-x' };
const configured = { agents: { explore: ROUTE } };
const text = (r) => r.content[0].text;
const READ_ONLY = ['code_graph', 'find', 'glob', 'grep', 'list', 'read'];
const userText = (messages) => messages.find((m) => m.role === 'user')?.content;

// A fake provider: `respond(query, messages, opts, round)` answers each send
// of the explorer asking `query`; every request is recorded.
function harness(respond, config = configured, extra = {}) {
  const requests = [];
  const children = [];
  const childOf = (query) => {
    let child = children.find((c) => c.query === query);
    if (!child) {
      child = { query, open: 0, rounds: 0 };
      children.push(child);
    }
    return child;
  };
  const provider = {
    name: 'openai',
    async send(messages, _model, tools, opts) {
      const query = userText(messages);
      const child = childOf(query);
      child.signal = opts.signal;
      child.open += 1;
      child.rounds += 1;
      requests.push({ query, messages: structuredClone(messages), tools, opts });
      try {
        const out = await respond(query, messages, opts, child.rounds);
        return typeof out === 'string' ? { content: out, toolCalls: [], stopReason: 'end_turn' } : out;
      } finally {
        child.open -= 1;
      }
    },
  };
  const deps = { load: () => config, initialize: async () => {}, providerFor: () => provider, ...extra };
  return { deps, requests, children };
}

const abortable = (signal) =>
  new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));

test('a string query runs one read-only explorer on the Explore route and returns its answer', async () => {
  const h = harness((q) => `answer to ${q}\nsrc/a.mjs:3 — here`);
  const res = await runExplore({ query: 'where is X' }, { cwd: process.cwd(), callerSessionId: 's1' }, h.deps);
  assert.equal(res.isError, undefined);
  assert.equal(text(res), 'answer to where is X\nsrc/a.mjs:3 — here');
  const [request] = h.requests;
  // Only the dedicated prompt and the question: no rules, skills or session context.
  assert.deepEqual(
    request.messages.map((m) => [m.role, m.content]),
    [
      ['system', EXPLORER_SYSTEM_PROMPT],
      ['user', 'where is X'],
    ]
  );
  assert.deepEqual(request.tools.map((t) => t.name).sort(), READ_ONLY);
  assert.equal(request.opts.promptCacheScope, 'shared');
  assert.equal(request.opts.promptCachePrefixTtl, undefined);
  assert.equal(request.opts.sessionId, undefined);
  assert.equal(request.opts.session.ownerSessionId, 's1');
});

test('a tool-calling round is executed in the caller cwd and then answered', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'explore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'target.txt'), 'needle here\n');
  let toolResult = null;
  const h = harness((_q, messages, _opts, round) => {
    if (round === 1) {
      return {
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'target.txt' } }],
        stopReason: 'tool_calls',
      };
    }
    toolResult = messages.find((m) => m.role === 'tool');
    return 'Found it.\ntarget.txt:1 — needle';
  });
  const res = await runExplore({ query: 'where is the needle' }, { cwd: dir }, h.deps);
  assert.equal(text(res), 'Found it.\ntarget.txt:1 — needle');
  assert.equal(h.requests.length, 2);
  assert.equal(toolResult.toolCallId, 'c1');
  assert.match(JSON.stringify(toolResult.content), /needle here/);
  // The prefix of the continuation is unchanged.
  assert.deepEqual(h.requests[1].messages.slice(0, 2), h.requests[0].messages);
});

test('only the read-only tools run: any other call is refused unrun', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'explore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let refusal = null;
  const h = harness((_q, messages, _opts, round) => {
    if (round === 1) {
      return {
        content: '',
        toolCalls: [
          {
            id: 'w1',
            name: 'apply_patch',
            arguments: { patch: '*** Begin Patch\n*** Add File: made.txt\n+x\n*** End Patch' },
          },
          { id: 's1', name: 'shell', arguments: { command: 'echo hi > shelled.txt' } },
        ],
        stopReason: 'tool_calls',
      };
    }
    refusal = messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    return 'nothing';
  });
  await runExplore({ query: 'q' }, { cwd: dir }, h.deps);
  assert.equal(refusal.length, 2);
  for (const body of refusal) assert.match(body, /not available on this session's schema allowlist/);
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual([...EXPLORER_TOOL_NAMES].sort(), READ_ONLY);
});

test('the round cap makes the explorer answer without tools', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'explore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const choices = [];
  const h = harness((_q, _messages, opts, round) => {
    choices.push(opts.toolChoice);
    if (opts.toolChoice === 'none') return 'best answer so far';
    return {
      content: '',
      toolCalls: [{ id: `g${round}`, name: 'list', arguments: { path: '.' } }],
      stopReason: 'tool_calls',
    };
  });
  const res = await runExplore({ query: 'loop forever' }, { cwd: dir }, h.deps);
  assert.equal(text(res), 'best answer so far');
  assert.equal(h.requests.length, EXPLORER_MAX_TOOL_ROUNDS + 1);
  assert.equal(choices.at(-1), 'none');
  assert.ok(choices.slice(0, -1).every((c) => c !== 'none'));
});

test('prompt and tool bytes are identical across two explorers', async () => {
  const h = harness((q) => `${q} done`);
  await runExplore({ query: ['first question', 'second question'] }, {}, h.deps);
  assert.equal(h.requests.length, 2);
  const [a, b] = h.requests;
  assert.equal(JSON.stringify(a.messages[0]), JSON.stringify(b.messages[0]));
  assert.equal(JSON.stringify(a.tools), JSON.stringify(b.tools));
  assert.equal(a.opts.promptCacheScope, 'shared');
  assert.equal(b.opts.promptCacheScope, 'shared');
});

test('Anthropic explorers use the 5-minute tier, never the 1h Lead tier', async () => {
  const route = { provider: 'anthropic', model: 'claude-x' };
  const h = harness(() => 'ok', { agents: { explore: route } });
  await runExplore({ query: 'q' }, {}, h.deps);
  const { cacheStrategy } = h.requests[0].opts;
  assert.equal(cacheStrategy.system, '5m');
  assert.ok(Object.values(cacheStrategy).every((ttl) => ttl !== '1h'));
});

test('an array fans out in parallel, each failure is reported per query and the rest still return', async () => {
  let inFlight = 0;
  let peak = 0;
  const h = harness(async (q) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight -= 1;
    if (q === 'bad') throw new Error('provider exploded');
    return `${q} found at src/${q}.mjs:1`;
  });
  const res = await runExplore({ query: ['one', 'bad', 'two'] }, {}, h.deps);
  assert.equal(peak, 3);
  assert.equal(res.isError, undefined);
  assert.match(text(res), /## Q1: one\none found at src\/one\.mjs:1/);
  assert.match(text(res), /## Q2: bad\n\[explore error\] provider exploded/);
  assert.match(text(res), /## Q3: two\ntwo found at src\/two\.mjs:1/);
  assert.ok(h.children.every((c) => c.open === 0));
});

test('every query failing makes the call an error', async () => {
  const h = harness(() => '');
  const res = await runExplore({ query: ['a', 'b'] }, {}, h.deps);
  assert.equal(res.isError, true);
  assert.match(text(res), /explorer returned no answer/);
});

test('the merged answer is bounded with a fair share per query', async () => {
  const h = harness(() => 'x'.repeat(EXPLORE_OUTPUT_CAP));
  const res = await runExplore({ query: ['a', 'b', 'c'] }, {}, h.deps);
  assert.ok(text(res).length <= EXPLORE_OUTPUT_CAP + 200);
  assert.equal(text(res).match(/answer truncated/g).length, 3);
});

test('a long question gets a shortened heading, never the answer-truncated marker', async () => {
  const long = `where ${'x'.repeat(150)}`;
  const h = harness(() => 'found at src/a.mjs:1');
  const res = await runExplore({ query: [long, 'b'] }, {}, h.deps);
  assert.match(text(res), /## Q1: where x+…\nfound at src\/a\.mjs:1/);
  assert.doesNotMatch(text(res), /answer truncated/);
});

// Nothing an explorer may leave behind: no stored session, no child process.
async function leftovers() {
  const { listStoredSessionSummaries } = await import('../agent/orchestrator/session/store/listing.mjs');
  const sessions = listStoredSessionSummaries().filter((s) => /explore/i.test(`${s.agent} ${s.sourceName}`)).length;
  const handles = process._getActiveHandles().filter((handle) => handle?.constructor?.name === 'ChildProcess').length;
  return { sessions, handles };
}

test('timeout aborts every explorer, keeps salvaged text and leaves nothing behind', async () => {
  const before = await leftovers();
  const h = harness(
    (q, _messages, opts) => {
      if (q === 'a') opts.onTextDelta?.('partial src/a.mjs:2');
      return abortable(opts.signal);
    },
    configured,
    { timeoutMs: 30 }
  );
  const res = await runExplore({ query: ['a', 'b'] }, {}, h.deps);
  assert.ok(h.children.every((c) => c.signal.aborted && c.open === 0));
  assert.match(text(res), /partial src\/a\.mjs:2\n\[explore: partial, timed out\]/);
  assert.match(text(res), /## Q2: b\n\[explore error\] timed out after 0s with no answer/);
  assert.deepEqual(await leftovers(), before);
});

test('caller cancellation aborts every explorer and returns only after they settled', async () => {
  const before = await leftovers();
  const h = harness((_q, _messages, opts) => abortable(opts.signal));
  const controller = new AbortController();
  const pending = runExplore({ query: ['a', 'b'] }, { signal: controller.signal }, h.deps);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.children.length, 2);
  controller.abort(new Error('esc'));
  const res = await pending;
  assert.equal(res.isError, true);
  assert.match(text(res), /cancelled/);
  assert.ok(h.children.every((c) => c.signal.aborted && c.open === 0));
  assert.deepEqual(await leftovers(), before);
});

test('without an Explore model the tool is off the surface and refuses to run', async () => {
  assert.ok(featureDisallowedToolsFor({}).includes('explore'));
  assert.ok(featureDisallowedToolsFor({ ...configured, disabledAgents: ['explore'] }).includes('explore'));
  assert.ok(!featureDisallowedToolsFor(configured).includes('explore'));
  const h = harness(() => 'never');
  const res = await runExplore({ query: 'x' }, {}, { ...h.deps, load: () => ({ default: 'opus', agents: {} }) });
  assert.equal(res.isError, true);
  assert.match(text(res), /no model/);
  assert.equal(h.requests.length, 0);
});
