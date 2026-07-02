#!/usr/bin/env node
// Static smoke for internal-comms token-optimization rules (min chars / max
// info). Asserts the Lead brief contract and the agent handoff contract are
// present and injected, without any model call. Live token A/B is a separate
// bench (scripts/internal-comms-bench.mjs).
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const rulesBuilder = require('../src/lib/rules-builder.cjs');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function readSrc(...parts) {
  return readFileSync(join(root, 'src', ...parts), 'utf8');
}
// Rules wrap across lines; collapse whitespace so phrase asserts are line-agnostic.
function flat(text) {
  return String(text || '').replace(/\s+/g, ' ');
}

// --- Lead brief contract: canonical in lead-brief.md, referenced from WORKFLOW -
const workflow = readSrc('workflows', 'default', 'WORKFLOW.md');
const leadBrief = readSrc('rules', 'lead', 'lead-brief.md');
const BRIEF_FIELDS = ['Goal:', 'Anchors:', 'Allow/Forbid:', 'Deliver:', 'Verify:'];
// Canonical brief contract lives in lead-brief.md (Lead brief contract).
assert(/minimum characters, maximum information/i.test(flat(leadBrief)), 'lead-brief.md: brief must state min-char/max-info principle');
for (const field of BRIEF_FIELDS) assert(leadBrief.includes(field), `lead-brief.md: brief missing labeled field ${field}`);
assert(leadBrief.includes('Stop:'), 'lead-brief.md: brief must add Stop: for heavy-worker bound');
assert(/role-known|already (?:owns|knows)|wasted cost|wasted/i.test(flat(leadBrief)), 'lead-brief.md: brief must ban restating known rules/background as cost');
// WORKFLOW.md must not duplicate the field list; it defers to the lead brief contract.
assert(/lead brief contract/i.test(flat(workflow)), 'WORKFLOW.md: must defer to the lead brief contract');
assert(!BRIEF_FIELDS.every((field) => workflow.includes(field)), 'WORKFLOW.md: must not duplicate the full brief field list');

// --- Agent handoff contract (00-common.md) ---------------------------------
const common = readSrc('rules', 'agent', '00-common.md');
assert(/minimum characters, maximum information/i.test(flat(common)), '00-common: handoff must state token-optimized principle');
assert(/fragments/i.test(common), '00-common: handoff must require fragments');
assert(/file:line/i.test(common), '00-common: handoff must anchor evidence to file:line');
assert(/Banned as pure cost/i.test(flat(common)), '00-common: handoff must list banned cost items');
for (const banned of ['headings', 'tables', 'narration', 'raw logs', 'next-checks']) {
  assert(common.toLowerCase().includes(banned), `00-common: banned list missing ${banned}`);
}

// --- Per-role output contracts --------------------------------------------
const roles = {
  'worker/AGENT.md': readSrc('agents', 'worker', 'AGENT.md'),
  'heavy-worker/AGENT.md': readSrc('agents', 'heavy-worker', 'AGENT.md'),
  'reviewer/AGENT.md': readSrc('agents', 'reviewer', 'AGENT.md'),
  'debugger/AGENT.md': readSrc('agents', 'debugger', 'AGENT.md'),
};
for (const [name, text] of Object.entries(roles)) {
  assert(/file:line/i.test(text), `${name}: role output must anchor to file:line`);
  assert(/fragments|no report bloat|no prose|no narration|no preamble/i.test(flat(text)), `${name}: role output must forbid prose bloat`);
}
assert(/severity-ordered/i.test(flat(roles['reviewer/AGENT.md'])), 'reviewer: must keep severity-ordered findings');
assert(/confirmed[\s\S]*inferences/i.test(roles['debugger/AGENT.md']), 'debugger: must separate confirmed facts vs inferences');
assert(/Stop:|how-to-verify|how to verify/i.test(flat(roles['heavy-worker/AGENT.md'])), 'heavy-worker: must bound scope / state how to verify');

// --- Injection: Lead rules actually carry the brief contract ---------------
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-internal-comms-smoke-'));
try {
  const leadRules = rulesBuilder.buildInjectionContent({ PLUGIN_ROOT: join(root, 'src'), DATA_DIR: dataDir });
  assert(/minimum characters, maximum information/i.test(flat(leadRules)), 'injected Lead rules must carry the brief token principle');
  for (const field of BRIEF_FIELDS) assert(leadRules.includes(field), `injected Lead rules missing brief field ${field}`);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

process.stdout.write('internal comms smoke passed\n');
