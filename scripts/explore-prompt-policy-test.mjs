#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildExplorerPrompt,
  EXPLORE_COMPUTE_HARD_TIMEOUT_MS,
  EXPLORE_MAX_LOOP_ITERATIONS,
  EXPLORE_TOOL,
  exploreResultCacheKey,
  normalizeExploreRoots,
  settledExplorerResult,
} from '../src/standalone/explore-tool.mjs';
import { BUILTIN_TOOLS } from '../src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs';
import { executeBuiltinTool } from '../src/runtime/agent/orchestrator/tools/builtin.mjs';
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
  assert.equal(EXPLORE_COMPUTE_HARD_TIMEOUT_MS, 60_000);
  assert.equal(EXPLORE_MAX_LOOP_ITERATIONS, 5);
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
  assert.deepEqual(
    settledExplorerResult({ status: 'fulfilled', value: 'EXPLORATION_FAILED' }),
    {
      ok: false,
      text: 'EXPLORATION_FAILED [reported] — explorer spent its budget with zero anchors',
    },
  );
});

test('tool descriptions stay mechanical while routing stays in shared policy', () => {
  const byName = Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool.name, tool]));
  assert.match(byName.read.description, /known-file contents or line ranges/i);
  assert.match(byName.grep.description, /source-content literal\/regex search.*path:line blocks with context/i);
  assert.match(byName.grep.inputSchema?.properties?.pattern?.description || '', /pattern\[\] batches exact query literals and identifier variants/i);
  assert.match(byName.find.description, /filename\/directory path-string lookup.*paths only.*No source-content, symbol, value, or line search/i);
  assert.match(byName.find.inputSchema?.properties?.query?.description || '', /filename or directory path fragments.*matched against path strings/i);
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

test('explorer grep returns a flat path:line stream while other roles retain source context', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mixdog-explorer-flat-grep-'));
  try {
    writeFileSync(join(cwd, 'a.mjs'), 'const needle = 1;\n');
    writeFileSync(join(cwd, 'b.mjs'), 'const needle = 2;\n');
    const args = {
      pattern: 'needle',
      path: cwd,
      output_mode: 'content_with_context',
      head_limit: 40,
    };
    const explorer = await executeBuiltinTool('grep', { ...args }, cwd, { agent: 'explorer' });
    assert.match(explorer, /a\.mjs:1:const needle = 1;/);
    assert.match(explorer, /b\.mjs:1:const needle = 2;/);
    assert.match(explorer, /\[total 2 matches\]/);
    assert.doesNotMatch(explorer, /Raw source spans|Additional matches|\[lines \d+-\d+\]/);

    const lead = await executeBuiltinTool('grep', { ...args }, cwd, { agent: 'lead' });
    assert.match(lead, /Raw source spans/);
    assert.doesNotMatch(lead, /\[total 2 matches\]/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('shared tool policy routes facets without duplicate content acquisition', () => {
  const rule = readFileSync(new URL('../src/rules/shared/01-tool.md', import.meta.url), 'utf8');
  const policy = rule.replace(/\s+/g, ' ');
  // 1. Repository-source coordinates may route to explorer; runtime state
  // stays direct. Explorer never owns analysis or solutions.
  assert.match(policy, /Call `explore` only to locate unknown coordinates in repository source[\s\S]*Git state, process\/environment, and executable availability[\s\S]*directly[\s\S]*`shell`[\s\S]*returns locations, not analysis or solutions/i);
  for (const route of [
    /path\/name only→`find`/i,
    /exact directory entries→`list`/i,
    /wildcard paths→\s*`glob`/i,
    /source content\/value\/`path:line`→`grep`/i,
    /known file\/range→\s*`read`/i,
    /exact symbol\/relation→`code_graph`/i,
    /web\/current→`search`/i,
    /returned URL body→\s*`web_fetch`/i,
    /prior work→`recall`/i,
    /durable compact English memory→`memory`/i,
    /explicit project change→`cwd`/i,
    /explicit user-requested conversation reset→\s*`session_manage`/i,
  ]) assert.match(policy, route, `routing table lost ${route}`);
  // 2. Shell owns runtime state but never replaces source retrieval tools.
  assert.doesNotMatch(policy, /process\/env, git, build\/run\/test→`shell`|Call `shell` only when/i);
  assert.match(policy, /Never use shell equivalents for file discovery or content retrieval/i);
  assert.match(policy, /explicit paths may be outside cwd/i);
  // 3. One shared maximum-fanout contract governs every retrieval stage
  // without sending one facet through alternative tools.
  assert.match(policy, /route each anchored facet exactly once by the evidence required/i);
  assert.match(policy, /Before each retrieval batch[\s\S]*extract every independent facet[\s\S]*deduplicate overlap[\s\S]*assign exactly ONE routed tool per facet[\s\S]*launch all independent facets together[\s\S]*one maximum-fanout batch[\s\S]*Never send one facet to alternative tools[\s\S]*reserve known work[\s\S]*serialize independent calls[\s\S]*cap facet count/i);
  assert.match(policy, /Once the edit is determined[\s\S]*one assistant turn[\s\S]*one `apply_patch` for all edits[\s\S]*When final verification uses `shell`[\s\S]*after `apply_patch` in that same assistant turn[\s\S]*batching all required verification commands into one `shell` call/i);
  assert.doesNotMatch(policy, /one `apply_patch` for all edits and one `shell` chain|If final verification actually requires `shell`|otherwise finish without it|Prefer parallel calls when independent|risk-proportionate|rerun only failures|zero\/error or a newly revealed dependency|cross-scope verification/i);
  assert.match(policy, /Fetch all information needed in that batch/i);
  assert.match(policy, /never re-fetch an unchanged span/i);
  const leadToolPolicy = readFileSync(new URL('../src/rules/lead/lead-tool.md', import.meta.url), 'utf8');
  const leadGeneralPolicy = readFileSync(new URL('../src/rules/lead/01-general.md', import.meta.url), 'utf8');
  assert.doesNotMatch(leadToolPolicy, /cross-scope verification/i);
  assert.doesNotMatch(leadGeneralPolicy, /Act proactively|exhaust safe in-scope checks/i);
  const patchTool = PATCH_TOOL_DEFS[0] || {};
  assert.doesNotMatch(`${patchTool.description || ''}\n${patchTool.freeformDescription || ''}`, /do not call.*parallel|must not.*parallel/i);
});

test('explorer locator policy retains its compact behavioral contract', () => {
  const rule = readFileSync(new URL('../src/rules/agent/30-explorer.md', import.meta.url), 'utf8');
  const policy = rule.replace(/\s+/g, ' ');
  const required = [
    /Locate and return exact coordinates and positions only[\s\S]*Do not analyze, evaluate, explain, recommend, or solve the task[\s\S]*Return only WHERE \(`path:line`\)[\s\S]*You ARE `explore`; never call it[\s\S]*Follow the shared tool-routing rules exactly[\s\S]*add no routing rules or exceptions/i,
    /Before EVERY tool call[\s\S]*facets still have ZERO credible anchors[\s\S]*new anchor rather than confirm an existing one/i,
    /no facet has zero anchors[\s\S]*tool call is FORBIDDEN: answer now[\s\S]*confirms, re-reads, verifies, counts, quotes, strengthens, or adds context[\s\S]*FORBIDDEN: answer now/i,
    /Target: ONE tool turn[\s\S]*within 10 seconds[\s\S]*Hard limit: FIVE tool turns plus ONE tool-less final-report turn[\s\S]*`turn 1\/6`[\s\S]*`turn 5\/6`[\s\S]*`turn 6\/6`[\s\S]*FINAL TURN/i,
    /After turns 1-4, report immediately if every requested facet has an anchor[\s\S]*Do not spend another turn merely because budget remains/i,
    /Turns 2-5 are ONLY for unresolved facets with zero anchors[\s\S]*shared maximum-fanout contract[\s\S]*changed concrete tokens or a new exact scope[\s\S]*Never repeat the same tokens and scope/i,
    /next turn lacks a concrete anchor-producing move[\s\S]*stop early with `EXPLORATION_FAILED`/i,
    /After turn 5, stop tools unconditionally[\s\S]*Turn 6 \(`turn 6\/6`\)[\s\S]*FINAL REPORT TURN[\s\S]*last turn[\s\S]*credible anchors currently held[\s\S]*none exist[\s\S]*`EXPLORATION_FAILED`[\s\S]*no sixth tool turn/i,
    /credible tool-returned anchor is FINAL[\s\S]*Never re-locate, re-read, reconfirm, verify, upgrade, cross-check[\s\S]*same facet through another tool or turn/i,
    /code anchor requires a tool-returned `path:line`[\s\S]*bare path is valid only for a file\/dir-location query[\s\S]*Generic matches and guessed coordinates are zero anchors[\s\S]*Search every supplied `<root>`[\s\S]*otherwise search session cwd/i,
    /Answer in at most 3 lines[\s\S]*`path:line — symbol — short reason`[\s\S]*completeness\/list\/count query[\s\S]*copy EVERY returned matching `path:line`[\s\S]*exactly once[\s\S]*tool-reported total[\s\S]*listed item count[\s\S]*equals it[\s\S]*3-line limit does not apply[\s\S]*Never omit a match[\s\S]*budget cannot produce a credible anchor[\s\S]*Never fabricate, soften, or return vague prose/i,
  ];
  for (const behavior of required) assert.match(policy, behavior);
  assert.doesNotMatch(policy, /## Maximum fan-out|Extract every independent locator facet|Never reserve known work, serialize independent calls, or cap facet count/i);
  assert.doesNotMatch(policy, /find_symbol|symbol_search|pattern\[\]|context:0|head_limit|file\/dir name|wildcard path/i);
  assert.ok(rule.length < 4_500, `explorer role contract regressed in size: ${rule.length}`);
  assert.doesNotMatch(policy, /prefer a weak anchor|prefix that root|spending the budget/i);
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
  assert.match(schema.cwd?.description || '', /explicit root/i);
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
  assert.match(byName.find.description, /filename\/directory path-string lookup.*paths only.*No source-content, symbol, value, or line search/i);
  assert.match(byName.list.description, /directory entries/i);
  assert.match(byName.grep.description, /source-content literal\/regex search.*path:line blocks with context/i);
  assert.match(byName.read.description, /known-file contents or line ranges/i);
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
  assert.match(pattern, /pattern\[\] batches exact query literals and identifier variants/i);
  assert.doesNotMatch(pattern, /known files\/spans use path\[\]/i);
});

test('explore locates; location-freeze policy lives in shared rules', () => {
  assert.match(EXPLORE_TOOL.description, /repo- or machine-wide coordinate locator/i);
  assert.doesNotMatch(EXPLORE_TOOL.description, /up to \d+|fan-out cap/i);
  const rule = readFileSync(new URL('../src/rules/shared/01-tool.md', import.meta.url), 'utf8');
  const policy = rule.replace(/\s+/g, ' ');
  // explore handles repository-source coordinates alone; runtime state stays direct.
  assert.match(policy, /Call `explore` only to locate unknown coordinates in repository source/i);
  assert.match(policy, /Git state, process\/environment, and executable availability[\s\S]*directly[\s\S]*`shell`/i);
  assert.match(policy, /returns locations, not analysis or solutions/i);
  assert.match(policy, /route each anchored facet exactly once by the evidence required/i);
  assert.match(policy, /never re-fetch an unchanged span/i);
});
