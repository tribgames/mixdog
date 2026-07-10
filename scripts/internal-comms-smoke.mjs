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
function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}
function rawBlock(text, start, end, label) {
  const source = String(text);
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`${label}: missing start marker ${start}`);
  const finish = source.indexOf(end, from + start.length);
  if (finish < 0) throw new Error(`${label}: missing end marker ${end}`);
  return source.slice(from, finish);
}
function block(text, start, end, label) {
  return normalize(rawBlock(text, start, end, label));
}
function bodyAfterFrontmatter(text, label) {
  const source = String(text);
  const opening = source.match(/^---[ \t]*\r?\n/);
  if (!opening) throw new Error(`${label}: missing frontmatter opening fence`);
  const closing = source.slice(opening[0].length).match(/^---[ \t]*(?:\r?\n|$)/m);
  if (!closing) throw new Error(`${label}: missing frontmatter closing fence`);
  return source.slice(opening[0].length + closing.index + closing[0].length);
}
function roleBody(text, label) {
  return normalize(bodyAfterFrontmatter(text, label));
}
function frontmatter(text, label) {
  const source = String(text);
  const opening = source.match(/^---[ \t]*\r?\n/);
  if (!opening) throw new Error(`${label}: missing frontmatter opening fence`);
  const closing = source.slice(opening[0].length).match(/^---[ \t]*(?:\r?\n|$)/m);
  if (!closing) throw new Error(`${label}: missing frontmatter closing fence`);
  return source.slice(opening[0].length, opening[0].length + closing.index);
}

// --- Compact rule contracts -------------------------------------------------
const workflow = readSrc('workflows', 'default', 'WORKFLOW.md');
const leadBrief = readSrc('rules', 'lead', 'lead-brief.md');
const solo = readSrc('workflows', 'solo', 'WORKFLOW.md');
const bench = readSrc('workflows', 'bench', 'WORKFLOW.md');
const general = readSrc('rules', 'lead', '01-general.md');
const leadTool = readSrc('rules', 'lead', 'lead-tool.md');
const core = readSrc('rules', 'agent', '00-core.md');
const common = readSrc('rules', 'agent', '00-common.md');
const skip = readSrc('rules', 'agent', '20-skip-protocol.md');
const BRIEF_FIELDS = ['Goal:', 'Anchors:', 'Allow/Forbid:', 'Deliver:', 'Verify:'];
const TOKEN_PRINCIPLE = /minimum (?:characters|chars), maximum (?:information|info)/i;
function requireAll(text, label, patterns) {
  for (const pattern of patterns) assert(pattern.test(normalize(text).toLowerCase()), `${label}: missing ${pattern}`);
}
assert(TOKEN_PRINCIPLE.test(normalize(leadBrief)), 'lead-brief.md: brief must state min-char/max-info principle');
for (const field of BRIEF_FIELDS) assert(leadBrief.includes(field), `lead-brief.md: brief missing labeled field ${field}`);
assert(leadBrief.includes('Stop:'), 'lead-brief.md: brief must add Stop: for heavy-worker bound');
assert(/role-known|already (?:owns|knows)|wasted cost|wasted/i.test(normalize(leadBrief)), 'lead-brief.md: brief must ban restating known rules/background as cost');
assert(/spec\/test beats its summary/i.test(normalize(leadBrief)), 'lead-brief.md: spec/test must beat summary');
requireAll(leadBrief, 'Lead brief lifecycle', [
  /full brief only for fresh spawn\/`respawned: true`/, /live follow-ups are delta/,
  /dead-tag send is cold: re-supply anchors/, /never `send` mid-run/,
  /batch one follow-up after completion/, /interrupt only to cancel/,
  /agent communication is english/,
]);
assert(/lead brief contract/i.test(normalize(workflow)), 'WORKFLOW.md: must defer to the lead brief contract');
assert(!BRIEF_FIELDS.every((field) => workflow.includes(field)), 'WORKFLOW.md: must not duplicate the full brief field list');

assert(/fragments/i.test(core), '00-core: handoff must require fragments');
assert(/file:line/i.test(core), '00-core: handoff must anchor evidence to file:line');
for (const banned of ['headings', 'tables', 'narration', 'raw logs', 'next-checks']) {
  assert(core.toLowerCase().includes(banned), `00-core: banned list missing ${banned}`);
}
assert(/Public Agent Constraints/i.test(common), '00-common: must be titled public-only constraints');
assert(/git operations deferred to Lead/i.test(normalize(common)), '00-common: must refuse git/Ship');
assert(/Overflow goes to a file/i.test(common), '00-common: must keep overflow-to-file rule');
requireAll(common, 'Public-agent shell', [
  /shell only verifies own edits/, /no exploration, install, or state change beyond brief/,
]);

// --- Per-role output contracts --------------------------------------------
const roles = {
  'worker/AGENT.md': readSrc('agents', 'worker', 'AGENT.md'),
  'heavy-worker/AGENT.md': readSrc('agents', 'heavy-worker', 'AGENT.md'),
  'reviewer/AGENT.md': readSrc('agents', 'reviewer', 'AGENT.md'),
  'debugger/AGENT.md': readSrc('agents', 'debugger', 'AGENT.md'),
};

// Semantic contracts deliberately avoid prose snapshots.
function snapshot(actual, expected, label) {
  assert(normalize(actual) === normalize(expected), `${label}: canonical snapshot changed`);
}
assert(/^agents:\s*$/m.test(frontmatter(solo, 'Solo workflow')), 'Solo: agents frontmatter must be empty');
requireAll(workflow, 'Default approval', [
  /read-only investigation\/planning while consulting/, /later explicit user message after the latest plan/,
  /initial\/additional\/changed requests reset planning/, /scope change needs a revised plan and fresh approval/,
  /no edits, state mutation, or delegation/,
]);
requireAll(workflow, 'Default routing', [
  /delegate by default/, /only coordinates, does git, or an obvious 1-edit\/ 1-check change/,
  /implementation\/research\/debugging to its matching agent/, /indicators, not automatic categories/,
  /worker: bounded established path, low local risk\/coupling\/verification, clear local check/,
  /heavy worker: high risk\/coupling\/verification \(including any high-risk scope\), or coupled staged work needing coordinated verification/,
  /reviewer verifies an implementation/, /debugger handles requested debugging or root cause after a failed fix/,
]);
requireAll(workflow, 'Default lifecycle', [
  /draft before any implementation/, /parallel gain exceeds coordination\/merge cost/,
  /all in one turn, with no count cap/, /real dependency, overlapping write, or inseparable coupling/,
  /after async spawn, end the turn/, /every delegated implementation gets one reviewer/,
  /lead integration\/cross-scope verification in parallel/, /high-risk scopes add distinct lenses/,
  /original live session/, /loop fix -> re-verify \(same reviewer \+ lead re-check\) until clean/,
  /bug surviving 2\+ fix cycles/, /agent reports relay.*as in-progress, never conclusions/,
  /final \(not interim\) report/, /never forward raw agent output/,
  /explicit user request after issue-free feedback/, /outcome\/direction change, pause and re-consult/,
]);
requireAll(solo, 'Solo lifecycle', [
  /no edits or state mutation/, /never spawn, send, delegate, or ask agents to work/,
  /read-only investigation\/planning while consulting/,
  /later explicit user message after the latest plan/,
  /initial\/additional\/changed requests reset planning/,
  /scope change needs a revised plan and fresh approval/,
  /checks\/fixes directly until clean or reports a blocker/, /final \(not interim\) report/,
  /interim updates are in-progress, never conclusions/,
  /issue-free user feedback/,
]);
requireAll(bench, 'Bench lifecycle', [
  /never wait for approval or ask questions/, /verified complete or provably blocked/,
  /maximum independent scopes/, /spawning every scope in one turn/,
  /build\/test-green gate/, /no polling, guessing, or dependent work/,
  /one reviewer per implementation scope/, /never deferred\/batched/,
  /fact-check agent responses and cross-check implementation\/review yourself before acting/,
  /return fixes to the original scope/, /loop verify -> fix -> re-verify until clean/,
  /skip only simple, low-risk review/, /hard blocked/, /outcome and evidence/,
]);
requireAll(leadTool, 'Lead tools', [
  /write-role agents self-verify/, /cross-scope verification.*benches.*all git/,
  /workflow permits delegation/, /no-delegation workflow.*controls/,
]);
requireAll(general, 'General safety', [
  /identify as mixdog\/current coding agent/, /destructive\/hard-to-reverse action needs explicit confirmation/,
  /never push, build, deploy without explicit user request/, /implementation approval is not deploy approval/,
]);
requireAll(skip, 'Silent skip', [
  /webhook-handler/, /scheduler-task/, /label-only, duplicate\/dedup, no action needed\/report/,
  /whole response.*\[meta:silent\]/,
]);

const roleSnapshots = {
  'worker/AGENT.md': `# Worker
Scoped implementation agent.

Own only the bounded responsibility assigned in the brief. Trust its
\`file:line\` anchors; do only minimal targeted discovery, then make the
smallest coherent patch. No drive-by cleanup or scope expansion.

EDIT-FIRST DISCIPLINE. Patch promptly rather than repeating read-only turns;
stop and report blocked when the assigned scope cannot be completed.

Self-verify with a targeted check (for example, \`node --check\` or a focused
test), then report the changed \`file:line\` and stop.`,
  'heavy-worker/AGENT.md': `# Heavy Worker
Own the assigned implementation slice through staged delivery.

Break work into bounded, dependency-aware slices and execute them in sequence.
At each checkpoint, run the narrowest relevant test or build before expanding
the slice. Keep the smallest coherent change; control blast radius rather than
rewriting adjacent systems.

EDIT-FIRST DISCIPLINE. Patch incrementally and stop at the first explicit
boundary: unclear ownership, a missing dependency, or growing blast radius.
Do not cross that boundary without a new bounded assignment; report blocked
work with the relevant file:line.

Self-verify each checkpoint and the final slice with shell (targeted test/build).`,
  'reviewer/AGENT.md': `# Reviewer
Independent regression/risk review agent.

Review the approved intent, diff, and tests with independent judgment. Prioritize
actionable correctness, regression, security, and verification risks; inspect
affected boundaries. Do not reimplement the change or report non-risky nits.
Report findings first, severity-ordered, with one line per \`file:line\`. If clean,
say so in one line and include only material residual risk.`,
  'debugger/AGENT.md': `# Debugger
Root-cause analysis agent.

Smallest confirmed cause chain before fixes. Return likely cause, evidence
(\`file:line\`), smallest next check/fix. Mark confirmed facts vs inferences;
avoid broad speculation.

Converge, don't sweep: when new evidence stops accruing, report the best
cause chain so far.`,
};
for (const [name, expected] of Object.entries(roleSnapshots)) {
  const text = roles[name];
  const permission = text.match(/^permission:\s*(.+)$/m)?.[1];
  assert(permission === (name === 'worker/AGENT.md' || name === 'heavy-worker/AGENT.md' ? 'read-write' : 'read'), `${name}: permission contract changed`);
  snapshot(roleBody(text, name), expected, name);
}
assert(/confirmed facts vs inferences/i.test(normalize(roles['debugger/AGENT.md'])), 'debugger: must separate confirmed facts from inferences');
assert(/file:line/i.test(normalize(roles['debugger/AGENT.md'])), 'debugger: must anchor evidence to file:line');

// --- Injection: Lead rules actually carry the brief contract ---------------
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-internal-comms-smoke-'));
try {
  const leadRules = rulesBuilder.buildInjectionContent({ PLUGIN_ROOT: join(root, 'src'), DATA_DIR: dataDir });
  assert(TOKEN_PRINCIPLE.test(normalize(leadRules)), 'injected Lead rules must carry the brief token principle');
  for (const field of BRIEF_FIELDS) assert(leadRules.includes(field), `injected Lead rules missing brief field ${field}`);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

process.stdout.write('internal comms smoke passed\n');
