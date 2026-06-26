import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createMixdogSessionRuntime } from '../src/mixdog-session-runtime.mjs';

const args = parseArgs(process.argv.slice(2));
const timeoutMs = Number(args.get('timeout-ms') || 480000);
const keep = args.get('keep') === true;
const selectedScenario = String(args.get('scenario') || 'explicit-parallel');
const RETRIEVAL_SCENARIOS = new Set([
  'broad-locator-explore',
  'known-symbol-direct',
  'memory-recall',
  'web-search',
]);

const SCENARIOS = {
  'explicit-parallel': {
    description: 'Explicit worker/debugger/reviewer parallel delegation.',
    setup: setupMultiFileProject,
    prompt: (projectDir) => `
This is an actual lead workflow smoke test for Mixdog CLI.

Work inside this temporary project only:
${projectDir}

Goal: validate how the lead plans and batches independent work. Do not solve everything directly in the lead.

Please use the bridge tool with async workers for the independent sections below. Spawn distinct tags early so the work can overlap, then poll/read the jobs and make a concise final report.

Independent sections:
1. worker: update src/math.mjs to export subtract(a, b).
2. debugger: diagnose and fix src/format.mjs so titleCase("  hello   mixdog ") returns "Hello Mixdog".
3. reviewer: review src/policy.mjs and the small smoke scope for obvious risk; report only, no edit unless a clear bug is found.

Use minimal exploration. Prefer grep/code_graph/apply_patch over broad reading. Keep each worker brief: maxLoopIterations 4 and idleTimeoutMs 120000 are enough.
After worker results return, run npm run smoke in ${projectDir} if needed, then summarize:
- whether bridge workers were used
- which roles/tags ran
- whether the smoke passed
`.trim(),
    validate: validateMultiFileProject,
    expect: {
      minSpawns: 3,
      minFirstIterBridgeCalls: 2,
      requiredRoles: ['worker', 'debugger', 'reviewer'],
      requireFilesOk: true,
    },
  },
  'natural-multifile': {
    description: 'Natural multi-file task with no hard bridge command; should still delegate useful independent work.',
    setup: setupMultiFileProject,
    prompt: (projectDir) => `
Work in this temporary project only:
${projectDir}

The smoke test is failing. Please get it passing and do a quick risk check of the tiny policy file. Use the normal Mixdog workflow for a small multi-file fix: keep lead context small, split independent investigation/implementation/review work when useful, then report the final result.

Targets:
- src/math.mjs is missing the operation used by src/smoke.mjs.
- src/format.mjs mishandles extra whitespace.
- src/policy.mjs only needs a quick risk review unless you find a real bug.

Keep exploration tight and verify with npm run smoke.
`.trim(),
    validate: validateMultiFileProject,
    expect: {
      minSpawns: 2,
      minFirstIterBridgeCalls: 1,
      minPreEditImplementationSpawns: 1,
      requiredAnyRoles: ['worker', 'debugger', 'reviewer'],
      requireFilesOk: true,
    },
  },
  'tiny-direct': {
    description: 'Tiny single-file edit; should avoid unnecessary worker spawn.',
    setup: setupTinyProject,
    prompt: (projectDir) => `
Work in this temporary project only:
${projectDir}

Tiny direct fix: update src/clamp.mjs so clamp(12, 0, 10) returns 10 and clamp(-1, 0, 10) returns 0. This is intentionally a one-file change; handle it directly unless a worker is truly necessary. Verify with npm run smoke and report briefly.
`.trim(),
    validate: validateTinyProject,
    expect: {
      maxSpawns: 0,
      requireFilesOk: true,
    },
  },
  'broad-locator-explore': {
    description: 'Broad unrelated locator questions should use explore rather than reading many files in Lead.',
    setup: setupLocatorProject,
    prompt: (projectDir) => `
Work in this temporary project only:
${projectDir}

I need file:line candidates only. I do not know exact symbols or file names.
Find likely places for these unrelated concerns:
- where startup/bootstrap orchestration happens
- where saved user preferences are loaded
- where async queue draining is coordinated

Use the normal Mixdog broad locator workflow. Do not edit files and do not prove root cause; just return concise candidates.
`.trim(),
    validate: validateReadOnlyProject,
    expect: {
      minToolCalls: { explore: 1 },
      maxMutations: 0,
      requireFilesOk: true,
    },
  },
  'known-symbol-direct': {
    description: 'Known symbol/file clue should use direct code tools, not explore.',
    setup: setupLocatorProject,
    prompt: (projectDir) => `
Work in this temporary project only:
${projectDir}

Where is the function loadUserPreferences defined? Give the file:line candidate only. This is a known symbol lookup; keep it minimal and do not edit.
`.trim(),
    validate: validateReadOnlyProject,
    expect: {
      minToolCallsAny: ['code_graph', 'grep'],
      maxToolCalls: { explore: 0 },
      maxMutations: 0,
      requireFilesOk: true,
    },
  },
  'memory-recall': {
    description: 'Prior-decision question should use recall.',
    setup: setupLocatorProject,
    prepare: async (runtime) => {
      return await runtime.memoryControl({
        action: 'core',
        op: 'add',
        project_id: 'common',
        category: 'decision',
        element: 'lead workflow smoke sentinel',
        summary: 'For Mixdog retrieval smoke, the chosen sentinel color is cobalt and the routing keyword is otterglass.',
      });
    },
    prompt: (projectDir) => `
Work in this temporary project only:
${projectDir}

We decided a sentinel color and routing keyword earlier for the Mixdog retrieval smoke. Please check memory/previous decisions and tell me the color and keyword. Do not inspect source files.
`.trim(),
    validate: validateReadOnlyProject,
    expect: {
      minToolCalls: { recall: 1 },
      maxMutations: 0,
      finalTextIncludes: ['cobalt', 'otterglass'],
      requireFilesOk: true,
    },
  },
  'web-search': {
    description: 'External current-info question should use search.',
    setup: setupLocatorProject,
    prompt: (projectDir) => `
Work in this temporary project only:
${projectDir}

What is the current official Node.js LTS major version? This requires current external information, so use web search. Answer with one concise sentence and cite the source title/URL if available. Do not edit files.
`.trim(),
    validate: validateReadOnlyProject,
    expect: {
      minToolCalls: { search: 1 },
      maxMutations: 0,
      requireFilesOk: true,
      allowToolErrors: args.get('allow-search-error') === true,
    },
  },
};

function parseArgs(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out.set(key.slice(2), next);
      i += 1;
    } else {
      out.set(key.slice(2), true);
    }
  }
  return out;
}

function writeLines(path, lines) {
  writeFileSync(path, `${lines.join('\n')}\n`);
}

function setupPackage(projectDir) {
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
    name: 'mixdog-lead-workflow-smoke',
    private: true,
    type: 'module',
    scripts: { smoke: 'node src/smoke.mjs' },
  }, null, 2) + '\n');
}

function setupMultiFileProject(projectDir) {
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  setupPackage(projectDir);
  writeLines(join(projectDir, 'src', 'math.mjs'), [
    'export function add(a, b) {',
    '  return a + b;',
    '}',
    '',
  ]);
  writeLines(join(projectDir, 'src', 'format.mjs'), [
    'export function titleCase(value) {',
    '  return String(value).split(" ").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");',
    '}',
    '',
  ]);
  writeLines(join(projectDir, 'src', 'policy.mjs'), [
    'export const policy = {',
    '  retries: 2,',
    '  timeoutMs: 1500,',
    '};',
    '',
  ]);
  writeLines(join(projectDir, 'src', 'smoke.mjs'), [
    'import { add, subtract } from "./math.mjs";',
    'import { titleCase } from "./format.mjs";',
    '',
    'if (add(2, 3) !== 5) throw new Error("add failed");',
    'if (subtract(5, 2) !== 3) throw new Error("subtract failed");',
    'if (titleCase("  hello   mixdog ") !== "Hello Mixdog") throw new Error("titleCase failed");',
    'console.log("ok");',
    '',
  ]);
}

function setupTinyProject(projectDir) {
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  setupPackage(projectDir);
  writeLines(join(projectDir, 'src', 'clamp.mjs'), [
    'export function clamp(value, min, max) {',
    '  return value;',
    '}',
    '',
  ]);
  writeLines(join(projectDir, 'src', 'smoke.mjs'), [
    'import { clamp } from "./clamp.mjs";',
    '',
    'if (clamp(5, 0, 10) !== 5) throw new Error("middle failed");',
    'if (clamp(12, 0, 10) !== 10) throw new Error("upper failed");',
    'if (clamp(-1, 0, 10) !== 0) throw new Error("lower failed");',
    'console.log("ok");',
    '',
  ]);
}

function setupLocatorProject(projectDir) {
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  setupPackage(projectDir);
  writeLines(join(projectDir, 'src', 'boot-orchestrator.mjs'), [
    'export function startBootstrapSequence() {',
    '  return ["config", "providers", "workers"];',
    '}',
    '',
  ]);
  writeLines(join(projectDir, 'src', 'preferences-store.mjs'), [
    'export function loadUserPreferences() {',
    '  return { theme: "dark", fastMode: false };',
    '}',
    '',
  ]);
  writeLines(join(projectDir, 'src', 'queue-drain.mjs'), [
    'export function drainAsyncQueue(queue) {',
    '  while (queue.length > 0) queue.shift()();',
    '}',
    '',
  ]);
  writeLines(join(projectDir, 'src', 'smoke.mjs'), [
    'console.log("ok");',
    '',
  ]);
}

function validateMultiFileProject(projectDir) {
  const math = readFileSync(join(projectDir, 'src', 'math.mjs'), 'utf8');
  const format = readFileSync(join(projectDir, 'src', 'format.mjs'), 'utf8');
  return {
    mathHasSubtract: /export\s+function\s+subtract/.test(math),
    formatHandlesWhitespace: /trim\(\)/.test(format) || /filter\(/.test(format) || /\\s\+/.test(format),
    smokeFileExists: existsSync(join(projectDir, 'src', 'smoke.mjs')),
  };
}

function validateTinyProject(projectDir) {
  const clamp = readFileSync(join(projectDir, 'src', 'clamp.mjs'), 'utf8');
  return {
    clampUsesBounds: /Math\.min|Math\.max|if\s*\(|<\s*min|>\s*max/.test(clamp),
    smokeFileExists: existsSync(join(projectDir, 'src', 'smoke.mjs')),
  };
}

function validateReadOnlyProject(projectDir) {
  return {
    bootFileExists: existsSync(join(projectDir, 'src', 'boot-orchestrator.mjs')),
    prefsFileExists: existsSync(join(projectDir, 'src', 'preferences-store.mjs')),
    queueFileExists: existsSync(join(projectDir, 'src', 'queue-drain.mjs')),
  };
}

function compact(value, max = 700) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return raw.length > max ? `${raw.slice(0, max)}...` : raw;
}

function bridgeSummary(call) {
  const input = call?.input || call?.arguments || call?.args || {};
  return {
    id: call?.id || call?.callId || null,
    name: call?.name || call?.toolName || 'tool',
    type: input?.type || input?.action || null,
    role: input?.role || null,
    tag: input?.tag || null,
    mode: input?.mode || null,
    wait: input?.wait ?? null,
    input: compact(input, 500),
  };
}

function evaluate(summary, scenario) {
  const expect = scenario.expect || {};
  const failures = [];
  const maxToolErrors = expect.allowToolErrors ? Infinity : (Number.isFinite(expect.maxToolErrors) ? expect.maxToolErrors : 0);
  if (!summary.ok) failures.push(summary.timedOut ? 'turn timed out' : 'turn failed');
  if (summary.toolErrors.length > maxToolErrors) {
    failures.push(`expected at most ${maxToolErrors} tool errors, got ${summary.toolErrors.length}`);
  }
  for (const [toolName, minCount] of Object.entries(expect.minToolCalls || {})) {
    const actual = summary.tools.counts[toolName] || 0;
    if (actual < minCount) failures.push(`expected ${toolName} >= ${minCount}, got ${actual}`);
  }
  for (const [toolName, maxCount] of Object.entries(expect.maxToolCalls || {})) {
    const actual = summary.tools.counts[toolName] || 0;
    if (actual > maxCount) failures.push(`expected ${toolName} <= ${maxCount}, got ${actual}`);
  }
  if (Array.isArray(expect.minToolCallsAny) && expect.minToolCallsAny.length > 0) {
    const hit = expect.minToolCallsAny.some((toolName) => (summary.tools.counts[toolName] || 0) > 0);
    if (!hit) failures.push(`expected at least one tool call from ${expect.minToolCallsAny.join(', ')}`);
  }
  if (Number.isFinite(expect.maxMutations) && summary.tools.mutations > expect.maxMutations) {
    failures.push(`expected mutations <= ${expect.maxMutations}, got ${summary.tools.mutations}`);
  }
  if (Number.isFinite(expect.minSpawns) && summary.bridge.spawns < expect.minSpawns) {
    failures.push(`expected at least ${expect.minSpawns} bridge spawns, got ${summary.bridge.spawns}`);
  }
  if (Number.isFinite(expect.maxSpawns) && summary.bridge.spawns > expect.maxSpawns) {
    failures.push(`expected at most ${expect.maxSpawns} bridge spawns, got ${summary.bridge.spawns}`);
  }
  if (Number.isFinite(expect.minFirstIterBridgeCalls) && summary.bridge.firstIterBridgeCount < expect.minFirstIterBridgeCalls) {
    failures.push(`expected at least ${expect.minFirstIterBridgeCalls} bridge calls in first bridge iteration, got ${summary.bridge.firstIterBridgeCount}`);
  }
  if (Number.isFinite(expect.minPreEditImplementationSpawns) && summary.bridge.preEditImplementationSpawns < expect.minPreEditImplementationSpawns) {
    failures.push(`expected at least ${expect.minPreEditImplementationSpawns} pre-edit implementation/debug bridge spawns, got ${summary.bridge.preEditImplementationSpawns}`);
  }
  for (const role of expect.requiredRoles || []) {
    if (!summary.bridge.roles.includes(role)) failures.push(`missing bridge role ${role}`);
  }
  if (Array.isArray(expect.requiredAnyRoles) && expect.requiredAnyRoles.length > 0) {
    const hasAny = expect.requiredAnyRoles.some((role) => summary.bridge.roles.includes(role));
    if (!hasAny) failures.push(`missing any bridge role from ${expect.requiredAnyRoles.join(', ')}`);
  }
  if (expect.requireFilesOk && !Object.values(summary.files || {}).every(Boolean)) {
    failures.push(`file validation failed: ${JSON.stringify(summary.files)}`);
  }
  for (const needle of expect.finalTextIncludes || []) {
    if (!String(summary.finalText || '').toLowerCase().includes(String(needle).toLowerCase())) {
      failures.push(`final text missing ${JSON.stringify(needle)}`);
    }
  }
  return failures;
}

function summarizeToolResult(resultPayload) {
  const content = typeof resultPayload?.content === 'string'
    ? resultPayload.content
    : compact(resultPayload);
  const toolKind = resultPayload?.toolKind
    || (/^Error:/i.test(content) ? 'error' : 'normal');
  return {
    toolCallId: resultPayload?.toolCallId || null,
    toolKind,
    content: compact(content, 700),
  };
}

async function runScenario(name) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario: ${name}. Available: ${Object.keys(SCENARIOS).join(', ')}, all`);

  const tempRoot = mkdtempSync(join(tmpdir(), `mixdog-lead-${name}-`));
  const projectDir = join(tempRoot, 'project');
  mkdirSync(projectDir, { recursive: true });
  scenario.setup(projectDir);

  const events = [];
  const toolCalls = [];
  const toolResults = [];
  const prepareResults = [];
  let text = '';
  let reasoning = '';
  let timedOut = false;

  function record(kind, payload) {
    events.push({ t: Math.round(performance.now()), kind, payload });
  }

  const runtime = await createMixdogSessionRuntime({
    provider: args.get('provider') || undefined,
    model: args.get('model') || undefined,
    cwd: projectDir,
    toolMode: 'full',
  });

  if (args.get('effort')) {
    try { await runtime.setEffort(args.get('effort')); } catch (error) { record('setEffort:error', error?.message || String(error)); }
  }
  if (args.has('fast')) {
    try { await runtime.setFast(args.get('fast') !== 'off'); } catch (error) { record('setFast:error', error?.message || String(error)); }
  }
  if (typeof scenario.prepare === 'function') {
    const prepareResult = await scenario.prepare(runtime, projectDir);
    prepareResults.push(prepareResult);
    record('prepare', compact(prepareResult, 700));
  }

  const startedAt = performance.now();
  record('runtime', {
    provider: runtime.provider,
    model: runtime.model,
    effort: runtime.effort,
    fast: runtime.fast,
    cwd: runtime.cwd,
  });

  const timer = setTimeout(() => {
    timedOut = true;
    try { runtime.abort(`lead-workflow-smoke-timeout:${name}`); } catch {}
  }, timeoutMs);
  timer.unref?.();

  try {
    const { result } = await runtime.ask(scenario.prompt(projectDir), {
      onToolCall(iter, calls) {
        for (const call of calls || []) {
          const summary = bridgeSummary(call);
          toolCalls.push({ iter, ...summary });
          record('toolCall', { iter, ...summary });
        }
      },
      onToolResult(resultPayload) {
        const summarized = summarizeToolResult(resultPayload);
        toolResults.push(summarized);
        record('toolResult', summarized);
      },
      onTextDelta(chunk) {
        text += chunk || '';
      },
      onReasoningDelta(chunk) {
        reasoning += chunk || '';
      },
      onStageChange(stage) {
        record('stage', stage);
      },
    });
    text = result?.content || text;
  } catch (error) {
    record('ask:error', error?.message || String(error));
    if (!timedOut) throw error;
  } finally {
    clearTimeout(timer);
    try { await runtime.close(`lead-workflow-smoke-done:${name}`); } catch {}
  }

  const elapsedMs = Math.round(performance.now() - startedAt);
  const bridgeCalls = toolCalls.filter((call) => call.name === 'bridge');
  const toolCounts = {};
  for (const call of toolCalls) {
    toolCounts[call.name] = (toolCounts[call.name] || 0) + 1;
  }
  const mutationCount = toolCalls.filter((call) => call.name === 'apply_patch').length;
  const spawnCalls = bridgeCalls.filter((call) => call.type === 'spawn' || call.type === null);
  const mutationIters = toolCalls
    .filter((call) => call.name === 'apply_patch')
    .map((call) => Number(call.iter))
    .filter(Number.isFinite);
  const firstMutationIter = mutationIters.length ? Math.min(...mutationIters) : null;
  const implementationSpawnCalls = spawnCalls.filter((call) => {
    const role = String(call.role || '').toLowerCase();
    const tag = String(call.tag || '').toLowerCase();
    if (!['worker', 'heavy-worker', 'debugger'].includes(role)) return false;
    return !/(verify|smoke|review|policy)/.test(tag);
  });
  const preEditImplementationSpawns = firstMutationIter == null
    ? implementationSpawnCalls.length
    : implementationSpawnCalls.filter((call) => Number(call.iter) < firstMutationIter).length;
  const distinctRoles = [...new Set(bridgeCalls.map((call) => call.role).filter(Boolean))];
  const distinctTags = [...new Set(bridgeCalls.map((call) => call.tag).filter(Boolean))];
  const firstBridgeIter = Math.min(...bridgeCalls.map((call) => Number(call.iter)).filter(Number.isFinite));
  const firstIterBridgeCount = Number.isFinite(firstBridgeIter)
    ? bridgeCalls.filter((call) => Number(call.iter) === firstBridgeIter).length
    : 0;

  const summary = {
    scenario: name,
    description: scenario.description,
    ok: !timedOut,
    timedOut,
    elapsedMs,
    tempRoot,
    projectDir,
    route: events.find((e) => e.kind === 'runtime')?.payload || null,
    prepareResults,
    bridge: {
      calls: bridgeCalls.length,
      spawns: spawnCalls.length,
      firstBridgeIter: Number.isFinite(firstBridgeIter) ? firstBridgeIter : null,
      firstIterBridgeCount,
      firstMutationIter,
      implementationSpawns: implementationSpawnCalls.length,
      preEditImplementationSpawns,
      roles: distinctRoles,
      tags: distinctTags,
    },
    tools: {
      counts: toolCounts,
      mutations: mutationCount,
      retrievalCalls: ['explore', 'recall', 'search', 'web_fetch'].reduce((out, name) => {
        out[name] = toolCounts[name] || 0;
        return out;
      }, {}),
    },
    files: scenario.validate(projectDir),
    finalText: compact(text, 1600),
    recentEvents: events.slice(-40),
    allToolCalls: toolCalls,
    toolErrors: toolResults.filter((result) => result.toolKind === 'error'),
    toolResultCount: toolResults.length,
    reasoningChars: reasoning.length,
  };

  summary.failures = evaluate(summary, scenario);
  summary.passed = summary.failures.length === 0;

  if (!keep) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }

  return summary;
}

async function main() {
  const names = selectedScenario === 'all'
    ? Object.keys(SCENARIOS)
    : selectedScenario.split(',').map((part) => part.trim()).filter(Boolean);
  const summaries = [];
  for (const name of names) {
    const summary = await runScenario(name);
    summaries.push(summary);
    console.log(JSON.stringify(summary, null, 2));
  }
  const passed = summaries.every((summary) => summary.passed);
  if (summaries.length > 1) {
    console.log(JSON.stringify({
      passed,
      scenarios: summaries.map((summary) => ({
        scenario: summary.scenario,
        passed: summary.passed,
        elapsedMs: summary.elapsedMs,
        spawns: summary.bridge.spawns,
        firstIterBridgeCount: summary.bridge.firstIterBridgeCount,
        roles: summary.bridge.roles,
        failures: summary.failures,
      })),
    }, null, 2));
  }
  process.exitCode = passed ? 0 : 1;
}

main()
  .then(() => {
    process.exit(process.exitCode || 0);
  })
  .catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
