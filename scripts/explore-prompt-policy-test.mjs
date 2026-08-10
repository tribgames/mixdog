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

test('explore preserves the complete distinct anchor set', () => {
  const lines = [
    'src/a.ts:1 — a — direct',
    'src/b.ts:2 — b — direct',
    'src/c.ts:3 — c — direct',
    'src/d.ts:4 — d — direct',
    'src/e.ts:5 — e — direct',
    'src/a.ts:1 — duplicate — ignored',
  ];
  const result = settledExplorerResult({ status: 'fulfilled', value: lines.join('\n') });
  assert.equal(result.ok, true);
  assert.deepEqual(result.text.split('\n'), lines.slice(0, 5));
});

test('tool descriptions stay mechanical while routing stays in shared policy', () => {
  const byName = Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool.name, tool]));
  assert.match(byName.read.description, /known-file contents or line ranges/i);
  assert.match(byName.grep.description, /file-content literal\/regex search.*contextual path:line blocks/i);
  assert.match(byName.grep.inputSchema?.properties?.pattern?.description || '', /pattern\[\] batches exact query literals and identifier variants/i);
  assert.match(byName.find.description, /filename\/directory path-string lookup.*paths only.*No source-content, symbol, value, or line search/i);
  assert.match(byName.find.inputSchema?.properties?.query?.description || '', /filename or directory path fragments.*matched against path strings/i);
  assert.match(byName.list.description, /known-directory immediate entries.*path \+ type.*no wildcard/i);
  assert.match(byName.glob.description, /known-base wildcard paths.*returns paths only/i);
  assert.match(byName.shell.description, /^Run a shell command\./i);
  assert.doesNotMatch(byName.shell.description, /apply_patch|fixed verification|post-patch shell/i);
  assert.doesNotMatch(byName.shell.description, /sleep\/watch\/dev loops|PowerShell:/i);
  assert.match(EXPLORE_TOOL.description, /coordinate locator/i);
  assert.match(EXPLORE_TOOL.inputSchema?.properties?.query?.description || '', /one concrete unknown target[\s\S]*minimal complete direct path:line set/i);
  assert.match(CODE_GRAPH_TOOL_DEFS[0]?.description || '', /structure, symbol relations, and flow/i);
  assert.match(CODE_GRAPH_TOOL_DEFS[0]?.inputSchema?.properties?.symbols?.description || '', /batch multiple in one symbols\[\]/i);
  assert.match(PATCH_TOOL_DEFS[0]?.freeformDescription || '', /Compact patch: U\/A\/D path[\s\S]*M rename or R root[\s\S]*@ hunks/i);
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
  // 1. Baseline routing is canonical; explore is only the unknown-coordinate
  // fast path and never owns analysis or solutions.
  assert.match(policy, /Baseline routing assigns each facet directly by the evidence needed[\s\S]*`explore`, when exposed, is a fast path only for facets whose repository coordinates remain unknown[\s\S]*returns the minimal complete direct `path:line` anchors, not analysis or solutions[\s\S]*resume baseline routing from those anchors/i);
  assert.doesNotMatch(policy, /Git state|executable availability/i);
  for (const route of [
    /path\/name only→`find`/i,
    /exact directory entries→`list`/i,
    /wildcard\/recursive paths→\s*`glob`/i,
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
  // Classified facets use baseline routes directly; shell stays outside.
  assert.match(policy, /Baseline routing assigns each facet directly by the evidence needed/i);
  assert.match(policy, /evidence unavailable to file tools—an independent facet, batched with the rest/i);
  assert.match(policy, /conclusive result ends its facet[\s\S]*never broaden, repeat, or reconfirm[\s\S]*prior output is needed to form the next call[\s\S]*on failure rerun only the failed check/i);
  // Shortest-turn batching without speculative re-reads: dependency includes
  // need/scope decisions, satisfied dependents are dropped, and returned
  // content is never re-acquired.
  assert.match(policy, /known state — task\/brief-supplied facts, returned content, and the effects of your own successful calls — is never re-acquired/i);
  assert.match(policy, /\(as input or to decide its need\/scope\)[\s\S]*drop a call whose deciding evidence already suffices/i);
  // 2. Negative shell steering lives on the shell tool description (reference
  // parity); the rule mentions shell only for batched final verification.
  assert.doesNotMatch(policy, /process\/env, git, build\/run\/test→`shell`|Call `shell` only when/i);
  assert.doesNotMatch(policy, /Never use shell equivalents/i);
  const shellDescription = BUILTIN_TOOLS.find((tool) => tool.name === 'shell')?.description || '';
  assert.match(shellDescription, /Executable\/runtime\/state evidence only — never file exploration in any command segment/i);
  assert.match(shellDescription, /NOT ls\/find\/cat\/head\/tail\/grep\/rg\/sed; dedicated file tools cover those/i);
  assert.match(shellDescription, /Chain dependent commands with &&/i);
  const descOf = (name) => BUILTIN_TOOLS.find((tool) => tool.name === name)?.description || '';
  assert.match(descOf('list'), /Replaces ls; meta:true adds size\/mtime\/mode\./);
  assert.match(descOf('read'), /Replaces cat\/head\/tail\./);
  assert.match(descOf('grep'), /Replaces grep\/rg\./);
  assert.match(descOf('glob'), /Replaces find -name\./);
  assert.match(policy, /explicit paths may be outside cwd/i);
  assert.match(policy, /project-relative paths[\s\S]*omit optional scopes equal to its root/i);
  // Guessed identities (paths, module specifiers, record shapes) are facets:
  // verified before anything depends on them, never acted on as known.
  assert.match(policy, /Act only on verified identities[\s\S]*guessed identity is itself a facet[\s\S]*cheapest batched probe \(one lookup or sample record\)[\s\S]*before anything depends on it/i);
  // 3. Retrieval fans out maximally, while execution and mutation retain
  // their own phase boundary.
  assert.match(policy, /`explore`, when exposed, is a fast path only[\s\S]*call it first once for all such independent facets in one query array[\s\S]*minimal complete direct `path:line` anchors[\s\S]*resume baseline routing from those anchors/i);
  assert.match(policy, /Baseline routing assigns each facet directly by the evidence needed/i);
  assert.match(policy, /Batch calls iff no call needs another's output \(as input or to decide its need\/scope\) or can change another's inputs\/state; otherwise serialize[\s\S]*Before each retrieval batch[\s\S]*deduplicate every facet the task still requires[\s\S]*route each once to the cheapest sufficient tool[\s\S]*all required variants\/scopes[\s\S]*launch every independent call together[\s\S]*Never split one decision across overlapping facets[\s\S]*duplicate\/broaden a facet through another tool[\s\S]*add `shell`\/`apply_patch` mutation merely to widen retrieval[\s\S]*reserve known work[\s\S]*cap fanout/i);
  assert.match(policy, /Once the edit is determined[\s\S]*one assistant turn[\s\S]*one `apply_patch` per file or cohesive unit[\s\S]*all patches first[\s\S]*one batched verification `shell` for required postconditions only[\s\S]*runtime waits for every patch and skips the shell if any fails[\s\S]*Retry only failed envelopes[\s\S]*Create or edit text only with `apply_patch`, never `shell`[\s\S]*Earlier `shell` is only for[\s\S]*executable\/runtime\/state evidence/i);
  assert.doesNotMatch(policy, /before every tool batch|whatever the tool|every turn, widest probe to last|one `apply_patch` for all edits and one `shell` chain|otherwise finish without it|Prefer parallel calls when independent|risk-proportionate|rerun only failures|zero\/error or a newly revealed dependency|cross-scope verification/i);
  assert.match(policy, /Take the cheapest sufficient evidence per facet[\s\S]*symbol relations end at `code_graph`[\s\S]*values\/locations end at the context grep returns[\s\S]*`read` covers only what returned spans cannot[\s\S]*anchored offset\/limit window[\s\S]*never a full-file read when a window suffices/i);
  assert.match(policy, /adjacent context around an edit point counts as needed evidence[\s\S]*The moment evidence determines the edit, stop retrieving and patch/i);
  assert.match(policy, /cheapest sufficient tool[\s\S]*required variants\/scopes[\s\S]*Never split one decision across overlapping facets[\s\S]*duplicate\/broaden a facet through another tool/i);
  assert.match(policy, /never broaden, repeat, or reconfirm\. Follow up only/i);
  assert.match(policy, /prior output is needed to form the next call/i);
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
    /Locate and return exact coordinates only[\s\S]*minimal complete WHERE set \(`path:line`\)[\s\S]*never analysis, evaluation, explanation, recommendation, or a solution[\s\S]*You ARE `explore`; never call it[\s\S]*Follow the shared routing rules[\s\S]*add no rules or exceptions/i,
    /Target: ONE tool turn[\s\S]*within 10 seconds[\s\S]*Hard limit: FIVE tool turns plus ONE tool-less final-report turn[\s\S]*`turn 1\/6`[\s\S]*`turn 5\/6`[\s\S]*`turn 6\/6`[\s\S]*FINAL REPORT TURN[\s\S]*no tools[\s\S]*credible anchors currently held[\s\S]*`EXPLORATION_FAILED` if none exist/i,
    /target is complete only when every distinct coordinate directly satisfying its query is held[\s\S]*one anchor suffices only when the target is singular by construction[\s\S]*Before EVERY tool call[\s\S]*still lack a complete direct anchor set[\s\S]*adds a distinct matching coordinate[\s\S]*answer immediately[\s\S]*never spend a turn merely because budget remains/i,
    /Turns 2-5 are ONLY for incomplete targets[\s\S]*changed concrete tokens or a new exact scope in maximum fanout[\s\S]*Page only when output explicitly reports truncation or incompleteness[\s\S]*never repeat tokens and scope[\s\S]*lacks a concrete anchor-producing move[\s\S]*stop early with `EXPLORATION_FAILED`/i,
    /credible tool-returned coordinate is FINAL[\s\S]*Never re-locate, re-read, reconfirm, verify, upgrade, cross-check, quote, or strengthen it through another tool or turn[\s\S]*Copy paths and coordinates exactly[\s\S]*never repair, normalize, estimate, or recall them/i,
    /code anchor requires a tool-returned `path:line`[\s\S]*bare path is valid only for a file\/dir-location query[\s\S]*Generic matches and guessed coordinates are zero anchors[\s\S]*Search every supplied `<root>`[\s\S]*otherwise search session cwd/i,
    /one compact line per distinct direct match[\s\S]*`path:line — symbol — short reason`[\s\S]*no fixed item-count cap[\s\S]*omit incidental matches and prose[\s\S]*completeness\/list\/count query[\s\S]*copy EVERY returned matching `path:line` once[\s\S]*preserve the tool-reported total[\s\S]*never omit a direct match or page after a complete result[\s\S]*budget cannot produce a credible anchor[\s\S]*never fabricate, soften, or return vague prose/i,
  ];
  for (const behavior of required) assert.match(policy, behavior);
  assert.doesNotMatch(policy, /## Maximum fan-out|Extract every independent locator facet|Never reserve known work, serialize independent calls, or cap facet count/i);
  assert.doesNotMatch(policy, /find_symbol|symbol_search|pattern\[\]|context:0|head_limit|file\/dir name|wildcard path/i);
  assert.ok(rule.length < 3_500, `explorer role contract regressed in size: ${rule.length}`);
  const exploreSource = readFileSync(new URL('../src/standalone/explore-tool.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(exploreSource, /EXPLORE_MAX_ANCHOR_LINES|slice\(0,\s*EXPLORE_MAX_ANCHOR_LINES\)/);
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
  assert.match(mode, /file modes: overview\/imports\/dependents\/related\/impact.*symbols with files\[\] gives a file outline.*others are symbol modes/i);
  assert.match(description, /exact identifiers use find_symbol\/references\/callers\/callees.*keywords use symbol_search\/search \(symbol-index terms\)/i);
  assert.match(description, /omit unsupported target arrays; never mix them/i);
  assert.match(CODE_GRAPH_TOOL_DEFS[0]?.inputSchema?.properties?.files?.description || '', /supported targets only/i);
  assert.match(CODE_GRAPH_TOOL_DEFS[0]?.inputSchema?.properties?.symbols?.description || '', /exact identifiers.*keywords.*symbol-index terms/i);
  const grep = Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool.name, tool])).grep;
  assert.doesNotMatch(grep.inputSchema.properties.pattern.description, /code_graph/i);
});

test('retrieval tool descriptions keep route capabilities disjoint', () => {
  const byName = Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool.name, tool]));
  assert.match(EXPLORE_TOOL.description, /coordinate locator/i);
  assert.match(byName.find.description, /filename\/directory path-string lookup.*paths only.*No source-content, symbol, value, or line search/i);
  assert.match(byName.list.description, /known-directory immediate entries.*no wildcard/i);
  assert.match(byName.grep.description, /file-content literal\/regex search.*contextual path:line blocks/i);
  assert.match(byName.read.description, /known-file contents or line ranges/i);
  assert.doesNotMatch(byName.shell.inputSchema.properties.command.description, /Select-String|Get-Content|\btail\b|\bhead\b/i);
  assert.match(CODE_GRAPH_TOOL_DEFS[0].description, /symbol-index terms/i);
});

test('retrieval schemas require their primary arguments and preserve region paths', () => {
  const byName = Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool.name, tool]));
  const read = byName.read.inputSchema;
  assert.deepEqual(read.required, ['path']);
  const region = read.properties.path.anyOf[1].items.anyOf.find((entry) => entry.type === 'array');
  assert.equal(region.type, 'array');
  assert.equal(region.minItems, 2);
  assert.equal(region.maxItems, 3);
  assert.deepEqual(byName.grep.inputSchema.anyOf, [{ required: ['pattern'] }, { required: ['glob'] }]);
  assert.deepEqual(byName.grep.inputSchema.properties.mode.enum, ['content', 'files', 'count']);
  assert.equal(byName.grep.inputSchema.properties.output_mode, undefined);
  assert.equal(byName.grep.inputSchema.properties.head_limit, undefined);
  assert.equal(byName.grep.inputSchema.properties.limit.minimum, 0);
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
  assert.match(EXPLORE_TOOL.description, /plain search over source trees and files/i);
  assert.doesNotMatch(EXPLORE_TOOL.description, /up to \d+|fan-out cap/i);
  const rule = readFileSync(new URL('../src/rules/shared/01-tool.md', import.meta.url), 'utf8');
  const policy = rule.replace(/\s+/g, ' ');
  // Baseline routing is canonical; explore only accelerates unknown coordinates.
  assert.match(policy, /Baseline routing assigns each facet directly by the evidence needed/i);
  assert.match(policy, /`explore`, when exposed, is a fast path only for facets whose repository coordinates remain unknown/i);
  assert.match(policy, /minimal complete direct `path:line` anchors, not analysis or solutions/i);
  assert.match(policy, /resume baseline routing from those anchors/i);
});
