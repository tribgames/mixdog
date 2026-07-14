#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildExplorerPrompt } from '../src/standalone/explore-tool.mjs';
import { EXPLORE_TOOL } from '../src/standalone/explore-tool.mjs';
import { BUILTIN_TOOLS } from '../src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs';
import { TOOL_SEARCH_TOOL } from '../src/session-runtime/tool-defs.mjs';
import { createEagerDispatcher } from '../src/runtime/agent/orchestrator/session/eager-dispatch.mjs';
import { crossTurnSignature } from '../src/runtime/agent/orchestrator/session/loop/completion-guards.mjs';
import {
  isEagerDispatchable,
  isToolCallDedupEligible,
} from '../src/runtime/agent/orchestrator/session/loop/tool-helpers.mjs';

test('explore per-query prompt contains only escaped query XML', () => {
  const prompt = buildExplorerPrompt('display model usage show usage model_usage provider_usage session cache usage state');
  assert.equal(prompt, '<query>display model usage show usage model_usage provider_usage session cache usage state</query>');
  assert.doesNotMatch(prompt, /Reminder:|BUDGET|TURN 1|STOP and answer|verdicts|ratings|recommendations/i);
  assert.equal(buildExplorerPrompt('where is <agent> & status?'), '<query>where is &lt;agent&gt; &amp; status?</query>');
});

test('builtin route descriptions carry the shortest verified-path policy', () => {
  const byName = Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool.name, tool]));
  // Conditional find-first: only genuinely guessed fragments route through
  // find, and in the SAME turn — project root itself is a verified scope.
  assert.match(byName.grep.description, /project root counts as verified/i);
  assert.match(byName.grep.description, /guessed path fragment → find first/i);
  assert.match(byName.grep.description, /no path "\." \+ guessed src\/\*\*/i);
  assert.match(byName.glob.description, /project root is verified/i);
  assert.match(byName.glob.description, /Guessed root\/name → find first/i);
  assert.match(byName.find.description, /output paths are verified/i);
  assert.match(byName.read.description, /guessed path\/name → find first/i);
  assert.match(byName.read.description, /Batch paths\/regions as real arrays.*path\[\]/i);
  assert.match(byName.shell.description, /Shell\/write calls are serial/i);
  assert.doesNotMatch(byName.shell.description, /parallel calls/i);
  assert.match(byName.find.description, /lookup only for unknown partial paths\/names/i);
  assert.match(byName.find.description, /project root or already-verified roots/i);
  assert.doesNotMatch(byName.grep.description, /find for that fragment before any grep\/glob/i);
  assert.match(byName.grep.description, /nonzero content_with_context result resolves that search concept/i);
  assert.match(byName.grep.description, /Only zero\/error results may change tokens or scope/i);
  assert.match(`${byName.code_graph?.description || ''} ${CODE_GRAPH_TOOL_DEFS[0]?.inputSchema?.properties?.symbols?.description || ''}`, /multiple exact symbols use one symbols\[\] call/i);
  assert.match(CODE_GRAPH_TOOL_DEFS[0]?.description || '', /verified source files only/i);
});

test('shared tool policy routes facets without duplicate content acquisition', () => {
  const rule = readFileSync(new URL('../src/rules/shared/01-tool.md', import.meta.url), 'utf8');
  const policy = rule.replace(/\s+/g, ' ');
  assert.match(policy, /for each facet choose exactly one shortest locator route/i);
  assert.match(policy, /broad\/uncertain→\s*`explore`.*partial path\/name→\s*`find`.*verified root\+wildcard→\s*`glob`.*quoted\/non-identifier literal or regex→\s*`grep`.*exact code identifier\/relation→\s*`code_graph` before grep/i);
  assert.match(policy, /grep only for a requested literal occurrence or after graph zero\/error/i);
  assert.match(policy, /batch compatible targets/i);
  assert.match(policy, /parallelize distinct facets only, never alternative routes for one facet/i);
  assert.match(policy, /put independent read-only calls in one turn; they may run concurrently regardless of tool/i);
  assert.match(policy, /after locator results, collect all known candidate files\/regions before inspection/i);
  assert.match(policy, /batch compatible reads.*same-file regions.*in one `path\[\]` call and graph targets in arrays/i);
  assert.match(policy, /parallelize independent incompatible read-only inspections/i);
  assert.match(policy, /do not start a singleton while a known compatible candidate remains/i);
  assert.match(policy, /shell\/write calls are serial/i);
  assert.match(policy, /later turns are only for targets dependent on prior results or unresolved facets/i);
  assert.match(policy, /stop when evidence covers the deliverable/i);
  assert.match(policy, /sufficient contextual grep means no overlapping `read`/i);
  assert.match(policy, /files_with_matches.*count.*capped.*insufficient context.*inspect only missing content/i);
  assert.match(policy, /known file\/span→`read` directly without `grep`/i);
  assert.doesNotMatch(policy, /retrieval[^.]{0,120}\b(?:one|at most \d+)\s+(?:lookup|inspection|turn|call)/i);
  assert.doesNotMatch(policy, /\bput independent calls in one turn\b/i);
  assert.doesNotMatch(policy, /\b(?:all|every)\s+(?:independent\s+)?(?:calls|tool calls)\b[^.]{0,80}\bone turn\b/i);
  assert.doesNotMatch(policy, /\bone lookup\b[^.]{0,80}\bat most\b[^.]{0,40}\binspection\b/i);
  assert.doesNotMatch(policy, /all (?:independent )?(?:calls|tool calls|targets)[^.]{0,100}\bone (?:tool )?(?:message|call)/i);
});

test('explorer locator policy retains its compact behavioral contract', () => {
  const rule = readFileSync(new URL('../src/rules/agent/30-explorer.md', import.meta.url), 'utf8');
  const policy = rule.replace(/\s+/g, ' ');
  const required = [
    /Return only WHERE \(`path:line`\), never WHY[\s\S]*You ARE `explore`; never call it/i,
    /only grep\/find\/glob\/code_graph[\s\S]*`read` and `list` are forbidden/i,
    /Turn 1 \(`turn 1\/3`\) is the whole search[\s\S]*Split broad\/uncertain input into every known facet[\s\S]*one batch under the shared one-route contract[\s\S]*upstream producer\/derivation layer[\s\S]*SAME batch[\s\S]*Follow-up turns batch every unresolved facet in parallel[\s\S]*single-tool turn is allowed only when exactly one pre-anchor\/zero-hit facet remains/i,
    /broad grep use `output_mode:"files_with_matches"`[\s\S]*`content_with_context` with `head_limit` only on paths returned this session/i,
    /Each pattern is one identifier, camel\/snake variant, or concept synonym[\s\S]*never a prose phrase[\s\S]*Spaces and non-ASCII are allowed only in verbatim quoted error\/log literals[\s\S]*Translate other non-English queries to English identifiers/i,
    /Scope is session cwd[\s\S]*For unverified `src` paths, use `find` first[\s\S]*never guess or invent directories[\s\S]*`path:"\."` with guessed `src\/\*\*`[\s\S]*exact find-returned path[\s\S]*no earlier than turn 2[\s\S]*After zero hits, change tokens or scope, never wording or guessed paths/i,
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

test('canonical schemas advertise safe batching without changing tool shapes', () => {
  const graph = readFileSync(new URL('../src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs', import.meta.url), 'utf8');
  const patch = readFileSync(new URL('../src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs', import.meta.url), 'utf8');
  assert.match(graph, /Batch symbols\[\]\/files\[\] by mode/i);
  assert.match(patch, /one patch/i);
  assert.match(patch, /one file block per target/i);
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
  const mode = CODE_GRAPH_TOOL_DEFS[0]?.inputSchema?.properties?.mode?.description || '';
  assert.match(mode, /file modes=\{overview,imports,dependents,related,impact\}.*symbols with files.*files\[\].*file outline/i);
  assert.match(mode, /symbol modes=\{find_symbol,symbol_search,search,references,callers,callees\}.*fileless symbols.*symbol_search keywords/i);
  assert.match(description, /exact identifiers.*find_symbol\/references\/callers\/callees.*keywords.*symbol_search\/search/i);
  assert.match(description, /IDs→graph; literal\/zero→grep/i);
  assert.match(description, /unsupported target arrays.*omitted.*never silently mixed/i);
  assert.match(CODE_GRAPH_TOOL_DEFS[0]?.inputSchema?.properties?.files?.description || '', /supported targets only/i);
  assert.match(CODE_GRAPH_TOOL_DEFS[0]?.inputSchema?.properties?.symbols?.description || '', /exact identifiers.*keywords/i);
  const grep = Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool.name, tool])).grep;
  assert.match(grep.description, /quoted\/non-identifier literal or regex→grep/i);
  assert.doesNotMatch(grep.inputSchema.properties.pattern.description, /code_graph/i);
});

test('retrieval schemas require their primary arguments and preserve region paths', () => {
  const byName = Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool.name, tool]));
  const read = byName.read.inputSchema;
  assert.deepEqual(read.required, ['path']);
  const region = read.properties.path.anyOf[1].items.anyOf[1];
  assert.deepEqual(region.required, ['path']);
  assert.deepEqual(byName.grep.inputSchema.anyOf, [{ required: ['pattern'] }, { required: ['glob'] }]);
  assert.deepEqual(byName.grep.inputSchema.properties.output_mode.enum, ['content_with_context', 'files_with_matches', 'count']);
  const grepSchema = byName.grep.inputSchema;
  const valid = (value) => grepSchema.anyOf.some((branch) => branch.required.every((key) => Object.hasOwn(value, key)));
  assert.equal(valid({ pattern: 'x' }), true);
  assert.equal(valid({ glob: '*.mjs' }), true);
  assert.equal(valid({}), false);
});

test('grep scopes do not masquerade as read regions', () => {
  const pattern = Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool.name, tool])).grep.inputSchema.properties.pattern.description;
  assert.match(pattern, /path\[\] batches verified scopes only/i);
  assert.match(pattern, /file\/span reads use read path\[\] regions/i);
  assert.doesNotMatch(pattern, /known files\/spans use path\[\]/i);
});

test('explore freezes returned facets and avoids re-location', () => {
  assert.match(EXPLORE_TOOL.description, /freezes the LOCATION only/i);
  assert.match(EXPLORE_TOOL.description, /read\/code_graph detail inspection is valid when content was not returned/i);
  assert.match(EXPLORE_TOOL.description, /never re-locate it/i);
  assert.match(EXPLORE_TOOL.description, /search only unresolved facets/i);
  const rule = readFileSync(new URL('../src/rules/shared/01-tool.md', import.meta.url), 'utf8');
  assert.match(rule, /freezes the LOCATION only[\s\S]*read or[\s\S]*code_graph detail inspection is valid[\s\S]*never re-locate it/i);
  assert.match(rule, /nonzero[\s\S]*content_with_context[\s\S]*result resolves[\s\S]*act directly/i);
});
