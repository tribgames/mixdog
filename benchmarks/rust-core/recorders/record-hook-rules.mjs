#!/usr/bin/env node
// What the PreToolUse gate decides for a tool call while hook rules are saved and removed under a live bus, on real Node
// (`createStandaloneHookBus` of services/hook-bus.mjs, the bus every adopted session's before-tool hook calls): a rule added while a
// session is open reaches its very next call, a deleted one stops at once, and a wildcard rule, a deny rule with its reason and a
// disabled rule decide as they are written. The sequence is the one of session-adopt-hooks.test.mjs "an adopted (resumed) session sees
// hook rules saved while it is open, and stops when they are removed", with the rule kinds the bus stores added to it.
//
// Per step: an edit of the rule store (add, delete, enable) records the hooks file the bus wrote (parsed, whole); a call records the
// decision the gate returned (whole), or null. The replay writes each recorded file where the core reads its hooks and asks the
// gate again.
//
//   node benchmarks/rust-core/recorders/record-hook-rules.mjs --tree <exact export of b6f10295a with node_modules>
// Output: native/core/fixtures/hook-rules/golden.json
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recorderProvenance } from './lib/provenance.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-hook-rules.mjs';
const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);

const sandbox = mkdtempSync(join(process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir(), 'rec-hook-rules-'));
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[name] = join(sandbox, name.toLowerCase());
delete process.env.MIXDOG_HOOKS_FILE;
const data = join(sandbox, 'data');
mkdirSync(data, { recursive: true });
const { createStandaloneHookBus } = await importFrom(tree, 'src/session-runtime/services/hook-bus.mjs');
const bus = createStandaloneHookBus({ dataDir: data });
const file = join(data, 'hooks.json');

const steps = [
  { op: 'call', tool: 'setup' },
  { op: 'add', rule: { tool: 'setup', action: 'ask' } },
  { op: 'add', rule: { tool: 'mcp__cal__*', action: 'ask' } },
  { op: 'call', tool: 'setup' },
  { op: 'call', tool: 'mcp__cal__create' },
  { op: 'call', tool: 'read' },
  { op: 'delete', index: 0 },
  { op: 'call', tool: 'setup' },
  { op: 'call', tool: 'mcp__cal__create' },
  { op: 'add', rule: { tool: 'shell', action: 'deny', reason: 'no shell here' } },
  { op: 'call', tool: 'shell' },
  { op: 'enable', index: 1, enabled: false },
  { op: 'call', tool: 'shell' },
  { op: 'enable', index: 1, enabled: true },
  { op: 'call', tool: 'shell' },
  { op: 'delete', index: 1 },
  { op: 'delete', index: 0 },
  { op: 'call', tool: 'mcp__cal__create' },
  { op: 'call', tool: 'shell' },
];
const out = [];
for (const step of steps) {
  const record = { ...step };
  if (step.op === 'call') record.decision = (await bus.beforeTool({ name: step.tool, args: {}, cwd: data })) ?? null;
  else {
    if (step.op === 'add') bus.addRule(step.rule);
    else if (step.op === 'delete') bus.deleteRule(step.index);
    else bus.setRuleEnabled(step.index, step.enabled);
    bus.flushRules();
    record.file = JSON.parse(readFileSync(file, 'utf8'));
  }
  out.push(record);
}

const finalOut = join(FIXTURES_ROOT, 'hook-rules');
const stage = stageSet(finalOut);
writeJson(join(stage, 'golden.json'), { note: 'the PreToolUse gate of a live Node hook bus while its rules are saved and removed', steps: out });
writeSetManifest(stage, {
  set: 'hook-rules',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    cases: out.length,
    syntheticInputs: ['the rule edits and tool names: those of session-adopt-hooks.test.mjs, with a deny rule and an enable toggle added'],
    keptWhole: 'per step: the edit or call, the hooks file the bus wrote after an edit, the decision of a call',
    exclusions: {},
  },
});
commitStage(stage, finalOut);
rmSync(sandbox, { recursive: true, force: true });
console.log(`steps=${out.length}`);
process.exit(0);
