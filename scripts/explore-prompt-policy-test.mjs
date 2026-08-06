#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildExplorerPrompt,
  EXPLORE_TOOL,
  exploreResultCacheKey,
  normalizeExploreRoots,
  settledExplorerResult,
} from '../src/standalone/explore-tool.mjs';
import { BUILTIN_TOOLS } from '../src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs';
import { PATCH_TOOL_DEFS } from '../src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs';
import {
  CWD_TOOL,
  SESSION_MANAGE_TOOL,
  TOOL_SEARCH_TOOL,
} from '../src/session-runtime/tool-defs.mjs';
import { TOOL_DEFS as WEB_TOOL_DEFS } from '../src/runtime/search/tool-defs.mjs';
import { TOOL_DEFS as MEMORY_TOOL_DEFS } from '../src/runtime/memory/tool-defs.mjs';
import { createEagerDispatcher } from '../src/runtime/agent/orchestrator/session/eager-dispatch.mjs';
import { crossTurnSignature } from '../src/runtime/agent/orchestrator/session/loop/completion-guards.mjs';
import {
  isEagerDispatchable,
  isToolCallDedupEligible,
} from '../src/runtime/agent/orchestrator/session/loop/tool-helpers.mjs';
import { assertCodeGraphDescriptionContract } from './code-graph-description-contract.mjs';

test('explore per-query prompt contains only escaped query XML', () => {
  const prompt = buildExplorerPrompt('display model usage show usage model_usage provider_usage session cache usage state');
  assert.equal(prompt, '<query>display model usage show usage model_usage provider_usage session cache usage state</query>');
  assert.doesNotMatch(prompt, /Reminder:|BUDGET|TURN 1|STOP and answer|verdicts|ratings|recommendations/i);
  assert.equal(buildExplorerPrompt('where is <agent> & status?'), '<query>where is &lt;agent&gt; &amp; status?</query>');
  assert.equal(
    buildExplorerPrompt('cross root', ['C:\\Project', 'C:\\Users\\A&B']),
    '<query>cross root</query>\n<roots>\n  <root>C:\\Project</root>\n  <root>C:\\Users\\A&amp;B</root>\n</roots>',
  );
});

test('explore roots are normalized without a fan-out cap and included in cache identity', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mixdog-explore-roots-'));
  try {
    const candidates = Array.from({ length: 5 }, (_, index) => {
      const dir = join(cwd, `root-${index}`);
      mkdirSync(dir);
      return dir;
    });
    const roots = normalizeExploreRoots([
      candidates[0],
      candidates[0],
      ...candidates.slice(1),
      join(cwd, 'missing'),
    ], cwd);
    assert.equal(roots.length, 5);
    assert.equal(roots[0], candidates[0]);
    assert.equal(roots.includes(join(cwd, 'missing')), false);
    const route = { provider: 'test', model: 'model' };
    assert.notEqual(
      exploreResultCacheKey({ cwd, roots: [candidates[0]], route, query: 'x' }),
      exploreResultCacheKey({ cwd, roots: [candidates[1]], route, query: 'x' }),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('explore hard timeout is an observable tool error, not a normal miss', () => {
  // Every failure class carries a machine-stable tag so a wedged compute, a
  // cancellation and a dispatch fault are distinguishable without prose parsing.
  assert.deepEqual(
    settledExplorerResult({ status: 'rejected', reason: new Error('explorer timed out after 60000ms') }),
    { ok: false, text: '[explorer error] [timeout] explorer timed out after 60000ms' },
  );
  assert.deepEqual(
    settledExplorerResult({ status: 'rejected', reason: new Error('explore canceled before dispatch') }),
    { ok: false, text: '[explorer error] [canceled] explore canceled before dispatch' },
  );
  assert.match(
    settledExplorerResult({ status: 'rejected', reason: new Error('provider exploded') }).text,
    /^\[explorer error\] \[dispatch-failed\]/,
  );
  assert.match(
    settledExplorerResult({ status: 'fulfilled', value: '   ' }).text,
    /^\[explorer error\] \[empty-response\]/,
  );
});

test('tool descriptions stay mechanical while routing stays in shared policy', () => {
  const byName = Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool.name, tool]));
  assert.match(byName.read.description, /file contents or line ranges/i);
  assert.match(byName.grep.description, /literal\/regex search.*source blocks with context/i);
  assert.match(byName.find.description, /partial path\/name lookup.*paths only/i);
  assert.match(byName.list.description, /directory entries.*path \+ type/i);
  assert.match(byName.glob.description, /glob patterns under base directories/i);
  assert.match(byName.shell.description, /^Run a shell command\./i);
  assert.doesNotMatch(byName.shell.description, /apply_patch|fixed verification|post-patch shell/i);
  assert.doesNotMatch(byName.shell.description, /sleep\/watch\/dev loops|PowerShell:/i);
  assert.match(EXPLORE_TOOL.description, /coordinate locator/i);
  assert.match(CODE_GRAPH_TOOL_DEFS[0]?.description || '', /structure, symbol relations, and flow/i);
  assert.match(CODE_GRAPH_TOOL_DEFS[0]?.inputSchema?.properties?.symbols?.description || '', /batch multiple in one symbols\[\]/i);
  assert.match(PATCH_TOOL_DEFS[0]?.freeformDescription || '', /Edit files with `apply_patch`.*FREEFORM input/i);
  const webByName = Object.fromEntries(WEB_TOOL_DEFS.map((tool) => [tool.name, tool]));
  const memoryByName = Object.fromEntries(MEMORY_TOOL_DEFS.map((tool) => [tool.name, tool]));
  assert.match(webByName.web_fetch.description, /Fetch page\/docs body from URL/i);
  assert.match(CWD_TOOL.description, /Show or set the session work project/i);
  assert.match(SESSION_MANAGE_TOOL.description, /Schedule conversation reset at current-turn end/i);
  assert.match(memoryByName.memory.description, /^Core-memory mutation\/status\.$/i);
  for (const text of [
    byName.read.description,
    byName.grep.description,
    byName.glob.description,
    byName.find.description,
    byName.list.description,
    byName.shell.description,
    EXPLORE_TOOL.description,
    CODE_GRAPH_TOOL_DEFS[0]?.description || '',
    PATCH_TOOL_DEFS[0]?.freeformDescription || '',
    webByName.web_fetch.description,
    CWD_TOOL.description,
    SESSION_MANAGE_TOOL.description,
    memoryByName.memory.description,
  ]) assert.doesNotMatch(text, /\bUse (?:for|only|when)\b|Final edit/i);
});

test('shared tool policy routes facets without duplicate content acquisition', () => {
  const rule = readFileSync(new URL('../src/rules/shared/01-tool.md', import.meta.url), 'utf8');
  const policy = rule.replace(/\s+/g, ' ');
  // 1. Unknown facets fan out once; anchored facets partition capabilities.
  assert.match(policy, /Unknown coordinates[\s\S]*one `explore` call[\s\S]*every unknown facet[\s\S]*sent alone/i);
  for (const route of [
    /partial path\/name→`find`/i,
    /exact directory entries→`list`/i,
    /wildcard→\s*`glob`/i,
    /text\/regex-anchored source blocks→`grep`/i,
    /anchorless known file\/range→\s*`read`/i,
    /symbol\/relation→`code_graph`/i,
    /web\/current→`search`/i,
    /returned URL body→\s*`web_fetch`/i,
    /prior work→`recall`/i,
    /durable compact English memory→`memory`/i,
    /explicit project change→`cwd`/i,
    /explicit user-requested conversation reset→\s*`session_manage`/i,
  ]) assert.match(policy, route, `routing table lost ${route}`);
  // 2. `shell` ranks below the retrieval tools and never replaces them.
  assert.match(policy, /→`shell`/i);
  assert.match(policy, /Never use shell equivalents for file discovery or content retrieval/i);
  // 3. Retrieve once, then emit final edit + verification in one mixed batch.
  assert.match(policy, /one message/i);
  assert.match(policy, /one `shell` chain for verification/i);
  assert.match(policy, /Once every final edit is fully determined[\s\S]*one assistant tool batch[\s\S]*one `apply_patch`[\s\S]*one `shell` chain/i);
  assert.match(policy, /runtime supports this mixed batch/i);
  assert.doesNotMatch(policy, /wait for the patch result|next assistant tool turn|post_shell/i);
  assert.match(policy, /fetch all information needed in that batch/i);
  assert.match(policy, /zero\/error or a newly revealed dependency/i);
  assert.match(policy, /never re-fetch an unchanged span/i);
  const patchTool = PATCH_TOOL_DEFS[0] || {};
  assert.doesNotMatch(`${patchTool.description || ''}\n${patchTool.freeformDescription || ''}`, /do not call.*parallel|must not.*parallel/i);
});

test('explorer locator policy retains its compact behavioral contract', () => {
  const rule = readFileSync(new URL('../src/rules/agent/30-explorer.md', import.meta.url), 'utf8');
  const policy = rule.replace(/\s+/g, ' ');
  const required = [
    /Return only WHERE \(`path:line`\), never WHY[\s\S]*You ARE `explore`; never call it/i,
    /only grep\/find\/glob\/code_graph[\s\S]*`read` and `list` are forbidden/i,
    /Turn 1 \(`turn 1\/3`\) is the whole search[\s\S]*Split broad\/uncertain input into every known facet[\s\S]*one batch under the shared one-route contract[\s\S]*upstream producer\/derivation layer[\s\S]*SAME batch[\s\S]*Follow-up turns batch every unresolved facet in parallel[\s\S]*single-tool turn is allowed only when exactly one pre-anchor\/zero-hit facet remains/i,
    /Grep defaults to `output_mode:"content_with_context"` with `context:0`[\s\S]*tight `head_limit` \(≤20\)[\s\S]*`files_with_matches` only as a cheap existence probe/i,
    /Each pattern is one identifier, camel\/snake variant, or concept synonym[\s\S]*never a prose phrase[\s\S]*Spaces and non-ASCII are allowed only in verbatim quoted error\/log literals[\s\S]*Translate other non-English queries to English identifiers/i,
    /Scope is every `<roots><root>…<\/root><\/roots>` entry when supplied[\s\S]*otherwise session cwd[\s\S]*Search every supplied root in the turn-1 batch[\s\S]*grep\/glob batch `path\[\]`[\s\S]*find uses one sibling call per root[\s\S]*Never silently fall back to cwd[\s\S]*find result is relative to its exact root[\s\S]*prefix that root[\s\S]*For unverified `src` paths, use `find` first[\s\S]*never guess or invent directories[\s\S]*`path:"\."` with guessed `src\/\*\*`[\s\S]*supplied root or an exact find-returned path[\s\S]*After zero hits, change tokens or scope, never wording or guessed paths/i,
    /anchor is a `path:line` containing a query token or synonym[\s\S]*code_graph hit[\s\S]*Generic terms without query specificity are zero[\s\S]*Never re-locate, reconfirm, or upgrade an anchor[\s\S]*path without `:line` is a pre-anchor and counts as zero/i,
    /After every result, stop and answer on any specific-token anchor[\s\S]*mark a weak anchor `\?`/i,
    /code-location query left only with pre-anchors[\s\S]*sole anchor-minting follow-up[\s\S]*one scoped `content_with_context` grep with `head_limit`[\s\S]*If it returns zero[\s\S]*changed tokens or scope[\s\S]*Never make a second minting hop or fabricate\/estimate a line/i,
    /at most 3 turns[\s\S]*label every tool message `turn N\/3`[\s\S]*normally use one batch and one answer[\s\S]*Turns 2–3 are allowed only when turn 1 has zero anchors/i,
    /first matching entry\/definition anchors a concept, value, or default[\s\S]*never trace its chain[\s\S]*explicit flow or default-resolution query[\s\S]*entry anchor but no resolved value[\s\S]*turn 2 for one resolving hop/i,
    /Answer in at most 3 lines[\s\S]*`path:line — symbol — short reason`[\s\S]*Copy every cited `path:line` verbatim[\s\S]*tool result in this session[\s\S]*never estimate, adjust, or recall/i,
    /Every code-location line requires `:line`[\s\S]*never return a bare filename or vague prose/i,
    /file\/dir-location query may return an exact verified path without `:line`/i,
    /Return `EXPLORATION_FAILED` only after spending the budget with zero anchors[\s\S]*prefer a weak anchor to a false miss/i,
  ];
  for (const behavior of required) assert.match(policy, behavior);
  assert.doesNotMatch(policy, /grep[^.]{0,120}\band\b[^.]{0,120}code_graph[^.]{0,120}\band\b[^.]{0,120}find/i);
});

test('canonical schemas preserve shapes while cross-tool batching stays in shared policy', () => {
  const graph = CODE_GRAPH_TOOL_DEFS[0];
  const patch = readFileSync(new URL('../src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs', import.meta.url), 'utf8');
  const mode = graph?.inputSchema?.properties?.mode?.description || '';
  const description = graph?.description || '';
  const symbols = graph?.inputSchema?.properties?.symbols?.description || '';
  assert.doesNotThrow(() => assertCodeGraphDescriptionContract({
    description,
    modeDescription: mode,
    symbolsDescription: symbols,
  }));
  assert.deepEqual(graph?.inputSchema?.required, ['mode']);
  assert.equal(graph?.inputSchema?.properties?.file, undefined);
  assert.equal(graph?.inputSchema?.properties?.symbol, undefined);
  assert.doesNotMatch(patch, /followed by a shell|post-patch verification|same response/i);
});

test('code graph and eager-dispatch boundaries preserve runtime shape', () => {
  const schema = CODE_GRAPH_TOOL_DEFS[0]?.inputSchema?.properties || {};
  const fileModes = ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols'];
  const symbolModes = ['symbols', 'find_symbol', 'symbol_search', 'search', 'references', 'callers', 'callees'];
  assert.deepEqual(new Set(schema.mode?.enum), new Set([...fileModes, ...symbolModes]));
  const assertBatchShape = (field) => {
    assert.equal(field?.anyOf?.length, 2);
    assert.deepEqual(field.anyOf.map((entry) => entry.type), ['string', 'array']);
    assert.equal(field.anyOf[1].items.type, 'string');
    assert.equal(field.anyOf[1].minItems, 1);
  };
  assertBatchShape(schema.files);
  assertBatchShape(schema.symbols);
  assert.equal(schema.file, undefined);
  assert.equal(schema.symbol, undefined);
  assert.equal(schema.language, undefined);
  const tools = [
    ...BUILTIN_TOOLS,
    { name: 'mcp_read', annotations: { readOnlyHint: true } },
    { name: 'mcp_write', annotations: { readOnlyHint: false } },
  ];
  assert.equal(isEagerDispatchable('read', tools), true);
  assert.equal(isEagerDispatchable('shell', tools), false);
  assert.equal(isEagerDispatchable('mcp_read', tools), true);
  assert.equal(isEagerDispatchable('mcp_write', tools), false);
  assert.equal(isToolCallDedupEligible('read', tools), true);
  assert.equal(isToolCallDedupEligible('mcp_read', tools), true);
});

test('same-batch load_tool and legacy tool_search repeats all execute eagerly', async () => {
  const tools = [...BUILTIN_TOOLS, TOOL_SEARCH_TOOL];
  assert.equal(isEagerDispatchable('load_tool', tools), true);
  assert.equal(isEagerDispatchable('tool_search', tools), true);
  assert.equal(isToolCallDedupEligible('load_tool', tools), false);
  assert.equal(isToolCallDedupEligible('tool_search', tools), false);
  assert.equal(isToolCallDedupEligible('read', tools), true);

  const args = { names: ['shell'] };
  const calls = [
    { id: 'load-1', name: 'load_tool', arguments: args },
    { id: 'load-2', name: 'load_tool', arguments: args },
    { id: 'legacy-1', name: 'tool_search', arguments: args },
    { id: 'legacy-2', name: 'tool_search', arguments: args },
  ];
  const executed = [];
  const crossTurnCalls = new Map([
    [crossTurnSignature('load_tool', args), { count: 1, firstIteration: 1 }],
    [crossTurnSignature('tool_search', args), { count: 1, firstIteration: 1 }],
  ]);
  const dispatcher = createEagerDispatcher({
    tools,
    cwd: process.cwd(),
    sessionId: null,
    sessionRef: {},
    signal: null,
    opts: {},
    crossTurnCalls,
    getIterations: () => 2,
    getNextIteration: () => 2,
    repeatFailLimit: 3,
    executeToolFn: async (name) => {
      executed.push(name);
      return '{}';
    },
  });
  dispatcher.startEagerRun(calls, 0, new Set());
  assert.equal(dispatcher.pending.size, 4);
  await Promise.all([...dispatcher.pending.values()].map((entry) => entry.promise));
  assert.deepEqual(executed, ['load_tool', 'load_tool', 'tool_search', 'tool_search']);

  const normalExecuted = [];
  const normalDispatcher = createEagerDispatcher({
    tools,
    cwd: process.cwd(),
    sessionId: null,
    sessionRef: {},
    signal: null,
    opts: {},
    crossTurnCalls: new Map(),
    getIterations: () => 1,
    getNextIteration: () => 1,
    repeatFailLimit: 3,
    executeToolFn: async (name) => {
      normalExecuted.push(name);
      return 'ok';
    },
  });
  normalDispatcher.startEagerRun([
    { id: 'read-1', name: 'read', arguments: { path: 'same.txt' } },
    { id: 'read-2', name: 'read', arguments: { path: 'same.txt' } },
  ], 0, new Set());
  await Promise.all([...normalDispatcher.pending.values()].map((entry) => entry.promise));
  assert.deepEqual(normalExecuted, ['read']);
});

test('code graph descriptions partition file and symbol targets', () => {
  const description = CODE_GRAPH_TOOL_DEFS[0]?.description || '';
  const modeProperty = CODE_GRAPH_TOOL_DEFS[0]?.inputSchema?.properties?.mode || {};
  const mode = modeProperty.description || '';
  assert.deepEqual(modeProperty.enum, ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols', 'find_symbol', 'symbol_search', 'search', 'references', 'callers', 'callees']);
  assert.match(mode, /file modes=\{overview,imports,dependents,related,impact\}.*symbols with files\[\]=file outline.*rest are symbol modes/i);
  assert.match(description, /exact identifiers via find_symbol\/references\/callers\/callees.*keywords via symbol_search\/search \(symbol-index terms\)/i);
  assert.match(description, /unsupported target arrays are omitted, never mixed/i);
  assert.match(CODE_GRAPH_TOOL_DEFS[0]?.inputSchema?.properties?.files?.description || '', /supported targets only/i);
  assert.match(CODE_GRAPH_TOOL_DEFS[0]?.inputSchema?.properties?.symbols?.description || '', /exact identifiers.*keywords.*symbol-index terms/i);
  const grep = Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool.name, tool])).grep;
  assert.doesNotMatch(grep.inputSchema.properties.pattern.description, /code_graph/i);
});

test('retrieval tool descriptions keep route capabilities disjoint', () => {
  const byName = Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool.name, tool]));
  assert.match(EXPLORE_TOOL.description, /coordinate locator/i);
  assert.match(byName.find.description, /partial path\/name lookup.*paths only/i);
  assert.match(byName.list.description, /directory entries/i);
  assert.match(byName.grep.description, /literal\/regex search.*source blocks with context/i);
  assert.match(byName.read.description, /file contents or line ranges/i);
  assert.doesNotMatch(byName.shell.inputSchema.properties.command.description, /Select-String|Get-Content|\btail\b|\bhead\b/i);
  assert.match(CODE_GRAPH_TOOL_DEFS[0].description, /symbol-index terms/i);
});

test('retrieval schemas require their primary arguments and preserve region paths', () => {
  const byName = Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool.name, tool]));
  const read = byName.read.inputSchema;
  assert.deepEqual(read.required, ['path']);
  const region = read.properties.path.anyOf[1].items.anyOf[1];
  assert.deepEqual(region.required, ['path']);
  assert.deepEqual(byName.grep.inputSchema.anyOf, [{ required: ['pattern'] }, { required: ['glob'] }]);
  assert.deepEqual(byName.grep.inputSchema.properties.output_mode.enum, ['content_with_context', 'files_with_matches', 'count']);
  assert.equal(byName.grep.inputSchema.properties['-C'], undefined);
  assert.match(byName.grep.inputSchema.properties.context.description, /omit for automatic context.*0 for matches only/i);
  const grepSchema = byName.grep.inputSchema;
  const valid = (value) => grepSchema.anyOf.some((branch) => branch.required.every((key) => Object.hasOwn(value, key)));
  assert.equal(valid({ pattern: 'x' }), true);
  assert.equal(valid({ glob: '*.mjs' }), true);
  assert.equal(valid({}), false);
});

test('grep scopes do not masquerade as read regions', () => {
  const pattern = Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool.name, tool])).grep.inputSchema.properties.pattern.description;
  assert.match(pattern, /pattern\[\] batches variants/i);
  assert.doesNotMatch(pattern, /known files\/spans use path\[\]/i);
});

test('explore locates; location-freeze policy lives in shared rules', () => {
  assert.match(EXPLORE_TOOL.description, /repo- or machine-wide coordinate locator/i);
  assert.doesNotMatch(EXPLORE_TOOL.description, /up to \d+|fan-out cap/i);
  const rule = readFileSync(new URL('../src/rules/shared/01-tool.md', import.meta.url), 'utf8');
  const policy = rule.replace(/\s+/g, ' ');
  // explore leads alone and its anchors — not a second explore — route the rest.
  assert.match(policy, /Unknown coordinates.*one `explore` call/i);
  assert.match(policy, /every unknown facet.*sent alone/i);
  assert.match(policy, /batch every anchored retrieval needed/i);
  assert.match(policy, /never re-fetch an unchanged span/i);
});
