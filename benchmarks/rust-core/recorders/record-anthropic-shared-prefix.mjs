#!/usr/bin/env node
// Anthropic shared-prefix cache forks (WP-AI-ANTHROPIC): the REAL Node request
// builders and the message-thread planner are called directly with scripted
// histories, on both routes. No server, no credential.
//
//   node benchmarks/rust-core/recorders/record-anthropic-shared-prefix.mjs [--tree <dir>]
//
// Output: native/core/fixtures/providers/anthropic-shared-prefix/cases.json.
// `requests`: a saved request, a fork (sharedCachePrefixCount) and its edge
// counts, each with the full request body. `threads`: whether the thread
// planner continues/creates a thread with and without the field.
// The set lives inside `providers/`, so record-providers.mjs (which clears that
// directory) must run `recordAnthropicSharedPrefix` after it and before its
// manifest write. Run standalone it leaves the manifest alone.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nodeRealTool, writeJsonCompact } from './lib/tool-definitions.mjs';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const P = 'src/runtime/agent/orchestrator/providers';
const MODEL = 'claude-sonnet-4-5';
// The Lead's `read`: the product's own definition, taken inside the recorder from the tree under test.

// A mid-turn request: it ends with a tool result.
const PREFIX = [
  { role: 'system', content: 'You are the Lead.' },
  { role: 'user', content: 'Refactor the parser.' },
  { role: 'assistant', content: 'Reading it.', toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a' } }] },
  { role: 'tool', toolCallId: 'call_1', content: 'export function parse() {}' },
];
const SUFFIX = [
  { role: 'assistant', content: 'Now editing.', toolCalls: [{ id: 'call_2', name: 'read', arguments: { path: 'b' } }] },
  { role: 'tool', toolCallId: 'call_2', content: 'handled by the main task' },
  { role: 'user', content: '<side-question>Where is parse?</side-question>' },
];
const ALL = [...PREFIX, ...SUFFIX];

// [id, messages, sharedCachePrefixCount]
const REQUESTS = [
  ['saved', PREFIX, undefined],
  ['ordinary', ALL, undefined],
  ['fork', ALL, PREFIX.length],
  // Zero is "no fork" (`!count`).
  ['count-zero', ALL, 0],
  // The prefix lowers to nothing (only the system message): no breakpoint at all.
  ['prefix-lowers-empty', ALL, 1],
  // The whole request is the prefix.
  ['count-equals-length', ALL, ALL.length],
  // The prefix is not part of this request: no message breakpoint.
  ['count-beyond-length', ALL, ALL.length + 1],
];

const ROUTES = [
  ['anthropic-oauth', 'oauth'],
  ['anthropic', 'api'],
];

export async function recordAnthropicSharedPrefix(tree, outFile) {
  const TOOLS = [(await nodeRealTool(tree))('read')];
  const oauth = await importFrom(tree, `${P}/anthropic-oauth.mjs`);
  const api = await importFrom(tree, `${P}/anthropic-api-request.mjs`);
  const threads = await importFrom(tree, `${P}/anthropic-message-threads.mjs`);

  const build = async (route, messages, count) => {
    const opts = count === undefined ? {} : { sharedCachePrefixCount: count };
    if (route === 'anthropic-oauth') {
      const body = oauth._buildRequestBodyForCacheSmoke(messages, MODEL, TOOLS, opts);
      return {
        body,
        betaHeader: oauth._test.buildOAuthBetaHeaders(body, { toolSearch: false, model: MODEL, opts }),
      };
    }
    const built = await api.buildAnthropicApiRequest({
      name: 'anthropic',
      config: {},
      messages,
      useModel: MODEL,
      tools: TOOLS,
      opts,
      fastModeLatched: false,
    });
    return { body: built.params, betaHeader: built.requestHeaders?.['anthropic-beta'] ?? null };
  };

  const requests = [];
  const plans = [];
  for (const [route, suffix] of ROUTES) {
    for (const [id, messages, count] of REQUESTS) {
      const { body, betaHeader } = await build(route, messages, count);
      requests.push({
        id: `${id}.${suffix}`,
        route,
        model: MODEL,
        tools: TOOLS,
        messages,
        sharedCachePrefixCount: count ?? null,
        expected: { body, betaHeader },
      });
    }
    // The thread planner on the request each route built, with and without the field.
    for (const [id, count] of [['ordinary', undefined], ['fork', PREFIX.length]]) {
      threads._threadTest.reset();
      const { body, betaHeader } = await build(route, ALL, count);
      const opts = { sessionId: 'session-fixture', ...(count === undefined ? {} : { sharedCachePrefixCount: count }) };
      const plan = threads.planAnthropicThread({
        provider: route,
        config: {},
        opts,
        body,
        betas: betaHeader ? betaHeader.split(',') : [],
        account: 'account-fixture',
        requestMessages: ALL,
        now: 0,
      });
      plans.push({
        id: `thread.${id}.${suffix}`,
        route,
        sharedCachePrefixCount: count ?? null,
        expected: {
          mode: plan.mode,
          thread: plan.body.thread ?? null,
          threadBeta: plan.betas.includes(threads.MESSAGE_THREADS_BETA),
        },
      });
      plan.settle();
    }
  }
  threads._threadTest.reset();
  await writeJsonCompact(tree, outFile, {
    recorder: 'benchmarks/rust-core/recorders/record-anthropic-shared-prefix.mjs',
    requests,
    threads: plans,
  });
  return requests.length + plans.length;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs();
  const tree = resolveTree(args);
  const setDir = join(FIXTURES_ROOT, 'providers');
  const count = await recordAnthropicSharedPrefix(tree, join(setDir, 'anthropic-shared-prefix', 'cases.json'));
  console.log(`recorded ${count} anthropic shared-prefix cases; providers/MANIFEST.json is regenerated by P0-BENCH`);
}
