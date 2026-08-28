#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { loadConfig } from '../src/runtime/agent/orchestrator/config.mjs';
import {
  getProvider,
  initProviders,
} from '../src/runtime/agent/orchestrator/providers/registry.mjs';
import { validateComputerToolArgs } from '../src/runtime/computer-bridge/action-schema.mjs';
import { TOOL_DEFS as COMPUTER_TOOL_DEFS } from '../src/runtime/computer-bridge/tool-defs.mjs';

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function boolArg(name, fallback) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(arg(name, fallback ? 'true' : 'false')).trim().toLowerCase(),
  );
}

function parseArgs(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(String(value || '{}'));
  } catch {
    return null;
  }
}

const scenarios = [
  {
    id: 'safe-search-submit',
    prompt: 'In window hwnd:0x123ABC, click pixel 40,55 from fresh frame frame:q1, type penguin, then press Enter.',
    expected: 'sequence',
    check: (args) => args.input?.steps?.length === 3
      && args.input.steps[0].action === 'click'
      && args.input.steps[1].action === 'type'
      && args.input.steps[2].action === 'key',
  },
  {
    id: 'safe-edit-save',
    prompt: 'In window hwnd:0x123ABC, type Draft42 into fresh semantic ref ref:edit-1, then press Ctrl+S.',
    expected: 'sequence',
    check: (args) => args.input?.steps?.length === 2
      && args.input.steps[0].action === 'type'
      && args.input.steps[1].action === 'key',
  },
  {
    id: 'safe-form-tab',
    prompt: 'In window hwnd:0x123ABC, click pixel 80,120 from fresh frame frame:f1, type user@example.com, press Tab, then type team42.',
    expected: 'sequence',
    check: (args) => args.input?.steps?.length === 4
      && args.input.steps.map((step) => step.action).join(',') === 'click,type,key,type',
  },
  {
    id: 'safe-query-wait',
    prompt: 'In window hwnd:0x123ABC, type status into ref ref:query-1, press Enter, then wait 1 second.',
    expected: 'sequence',
    check: (args) => args.input?.steps?.length === 3
      && args.input.steps[2].action === 'wait',
  },
  {
    id: 'unsafe-popup-transition',
    prompt: 'Click ref ref:open-popup in window hwnd:0x123ABC, then click the popup confirmation.',
    expected: 'click',
    check: (args) => args.input?.ref === 'ref:open-popup',
  },
  {
    id: 'unsafe-cross-window',
    prompt: 'Type A into ref ref:a in window hwnd:0x111, then type B into ref ref:b in window hwnd:0x222.',
    expected: 'type',
    check: (args) => args.input?.window_id === 'hwnd:0x111'
      && args.input?.ref === 'ref:a',
  },
  {
    id: 'unsafe-launch-transition',
    prompt: 'Launch notepad.exe, then type Hello into the newly opened window.',
    expected: 'launch',
    check: (args) => args.input?.app === 'notepad.exe',
  },
  {
    id: 'unsafe-close-transition',
    prompt: 'Close window hwnd:0x111, then type Done into ref ref:done in window hwnd:0x222.',
    expected: 'window',
    check: (args) => args.input?.window_id === 'hwnd:0x111'
      && args.input?.operation === 'close',
  },
];

const providerName = arg('provider', 'openai-oauth');
const model = arg('model', 'gpt-5.6-sol');
const effort = arg('effort', 'xhigh');
const fast = boolArg('fast', true);
const outputPath = resolve(arg(
  'output',
  'artifacts/computer-use/computer-sequence-implicit.json',
));

const config = loadConfig({ secrets: true });
await initProviders(config.providers || {});
const provider = getProvider(providerName);
if (!provider) throw new Error(`provider unavailable: ${providerName}`);

const rows = [];
for (const scenario of scenarios) {
  const startedAt = Date.now();
  let response;
  let error = null;
  try {
    response = await provider.send([
      {
        role: 'system',
        content: 'Perform the requested desktop operation with the available tool. Make exactly one tool call and do not explain.',
      },
      { role: 'user', content: scenario.prompt },
    ], model, [COMPUTER_TOOL_DEFS[0]], {
      effort,
      fast,
      toolChoice: 'required',
      maxOutputTokens: 600,
    });
  } catch (cause) {
    error = cause?.message || String(cause);
  }
  const call = response?.toolCalls?.[0] || null;
  const callCount = response?.toolCalls?.length || 0;
  const args = parseArgs(call?.arguments);
  const validationError = args ? validateComputerToolArgs(args) : 'missing arguments';
  const passed = !error
    && callCount === 1
    && call?.name === 'computer'
    && args?.action === scenario.expected
    && validationError === null
    && scenario.check(args);
  rows.push({
    scenario: scenario.id,
    passed,
    expected_action: scenario.expected,
    actual_action: args?.action || null,
    call_count: callCount,
    all_actions: (response?.toolCalls || []).map((item) => {
      const itemArgs = parseArgs(item?.arguments);
      return itemArgs?.action || null;
    }),
    duration_ms: Date.now() - startedAt,
    arguments: args,
    validation_error: validationError,
    error,
  });
  process.stdout.write(
    `${scenario.id.padEnd(28)} ${passed ? 'PASS' : 'FAIL'} ${args?.action || 'none'}\n`,
  );
}

const safe = rows.filter((row) => row.scenario.startsWith('safe-'));
const unsafe = rows.filter((row) => row.scenario.startsWith('unsafe-'));
const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  provider: providerName,
  model,
  effort,
  fast,
  summary: {
    passed: rows.filter((row) => row.passed).length,
    total: rows.length,
    safe_sequence_selection: `${safe.filter((row) => row.passed).length}/${safe.length}`,
    unsafe_transition_boundary: `${unsafe.filter((row) => row.passed).length}/${unsafe.length}`,
    failures: rows.filter((row) => !row.passed).map((row) => row.scenario),
  },
  rows,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n${outputPath}\n`);
process.exit(report.summary.passed === report.summary.total ? 0 : 1);
