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

// --- Lead brief contract: canonical in lead-brief.md, referenced from WORKFLOW -
const workflow = readSrc('workflows', 'default', 'WORKFLOW.md');
const leadBrief = readSrc('rules', 'lead', 'lead-brief.md');
const BRIEF_FIELDS = ['Goal:', 'Anchors:', 'Allow/Forbid:', 'Deliver:', 'Verify:'];
// Canonical brief contract lives in lead-brief.md (Lead brief contract).
const TOKEN_PRINCIPLE = /minimum (?:characters|chars), maximum (?:information|info)/i;
assert(TOKEN_PRINCIPLE.test(normalize(leadBrief)), 'lead-brief.md: brief must state min-char/max-info principle');
for (const field of BRIEF_FIELDS) assert(leadBrief.includes(field), `lead-brief.md: brief missing labeled field ${field}`);
assert(leadBrief.includes('Stop:'), 'lead-brief.md: brief must add Stop: for heavy-worker bound');
assert(/role-known|already (?:owns|knows)|wasted cost|wasted/i.test(normalize(leadBrief)), 'lead-brief.md: brief must ban restating known rules/background as cost');
assert(/Referenced spec\/test file beats its summary/i.test(normalize(leadBrief)), 'lead-brief.md: brief must state spec-file precedence over summary');
// WORKFLOW.md must not duplicate the field list; it defers to the lead brief contract.
assert(/lead brief contract/i.test(normalize(workflow)), 'WORKFLOW.md: must defer to the lead brief contract');
assert(!BRIEF_FIELDS.every((field) => workflow.includes(field)), 'WORKFLOW.md: must not duplicate the full brief field list');

// --- Agent handoff contract (00-core.md) -----------------------------------
const core = readSrc('rules', 'agent', '00-core.md');
assert(/fragments/i.test(core), '00-core: handoff must require fragments');
assert(/file:line/i.test(core), '00-core: handoff must anchor evidence to file:line');
assert(/Ban headings/i.test(normalize(core)), '00-core: handoff must list banned cost items');
for (const banned of ['headings', 'tables', 'narration', 'raw logs', 'next-checks']) {
  assert(core.toLowerCase().includes(banned), `00-core: banned list missing ${banned}`);
}
const common = readSrc('rules', 'agent', '00-common.md');
assert(/Public Agent Constraints/i.test(common), '00-common: must be titled public-only constraints');
assert(/git operations deferred to Lead/i.test(common), '00-common: must refuse git/Ship');
assert(/Overflow goes to a file/i.test(common), '00-common: must keep overflow-to-file rule');

// --- Per-role output contracts --------------------------------------------
const roles = {
  'worker/AGENT.md': readSrc('agents', 'worker', 'AGENT.md'),
  'heavy-worker/AGENT.md': readSrc('agents', 'heavy-worker', 'AGENT.md'),
  'reviewer/AGENT.md': readSrc('agents', 'reviewer', 'AGENT.md'),
  'debugger/AGENT.md': readSrc('agents', 'debugger', 'AGENT.md'),
};

// --- Approved workflow contracts -------------------------------------------
function snapshot(actual, expected, label) {
  assert(normalize(actual) === normalize(expected), `${label}: canonical snapshot changed`);
}
const approvalGateRaw = rawBlock(workflow, 'HARD APPROVAL GATE', 'Lead supervises', 'Default approval gate');
const selectionRaw = rawBlock(workflow, 'Lead supervises', '1. Plan', 'Default selection');
snapshot(selectionRaw, `Lead supervises/delegates/coordinates/judges/decides. After approval, delegate
by default. Lead handles only coordination, git, or an obvious one-edit/
one-check change; all other implementation, research, and debugging goes to
the matching agent. Select Worker for bounded work on an established path
when risk, coupling, and verification complexity are low and local
verification is clear. Select Heavy Worker when risk, coupling, or
verification complexity is high, including any high-risk scope. Architecture,
contracts, storage, concurrency, security, and lifecycle concerns are
indicators to weigh, not automatic categories; use Heavy Worker for coupled
multi-stage work requiring coordinated verification.
Reviewer verifies an implementation scope; Debugger handles requested
debugging or root cause after a failed fix.`, 'Default selection');
const delegateRaw = rawBlock(workflow, '2. Delegate', '3. Review', 'Default Delegate');
snapshot(delegateRaw, `2. Delegate — maximize useful fan-out: split every ready, independent scope
whose parallel benefit exceeds its coordination/merge cost to its own
appropriately selected Worker or Heavy Worker, and spawn all such agents
in the SAME turn. There is no arbitrary agent-count cap. Serialize only a
real dependency, an overlapping write, or an inseparable coupled scope;
otherwise keep useful scopes parallel. Briefs follow Lead brief contract.
After spawning async agents, END THE TURN.`, 'Default Delegate');
const reviewRaw = rawBlock(workflow, '3. Review', '4. Report', 'Default Review');
snapshot(reviewRaw, `3. Review — after approval, complete delegation, review, self-verification, and
in-scope fixes without reapproval. Once each implementation scope lands,
spawn one Reviewer for that scope, with all ready reviewers in the SAME
turn, and run Lead integration/cross-scope verification for all scopes IN
PARALLEL. The Reviewer independently judges the scope's risk, intent, and
boundaries; Lead checks acceptance and interactions across scopes, not
duplicate same-scope busywork. For high-risk scopes, add distinct review
lenses (for example security, concurrency, or contract review). Every
delegated implementation gets a Reviewer plus Lead integration
verification. Synthesize findings into ONE verdict; send merged fixes to
the original scope's live session and loop fix -> re-verify (same reviewer
session + Lead integration re-check) until clean. Use Debugger first when
asked for debugging or a bug survives 2+ fix cycles. On each agent
report, relay scope+verdict and next work as in-progress, never as a
conclusion.`, 'Default Review');

let defaultBody = bodyAfterFrontmatter(workflow, 'Default workflow');
for (const extracted of [approvalGateRaw, selectionRaw, delegateRaw, reviewRaw]) defaultBody = defaultBody.replace(extracted, '');
assert(!/\b(?:Worker|Heavy Worker|Reviewer|Debugger|delegat\w*|spawn\w*|assign\w*|rout\w*|parallel|concurrent|same[- ]turn|fan-out|agent-count|review[- ]lens(?:es)?)\b/i.test(defaultBody), 'Default: role/delegation/review policy must stay in canonical blocks');

const solo = readSrc('workflows', 'solo', 'WORKFLOW.md');
assert(/^agents:\s*$/m.test(frontmatter(solo, 'Solo workflow')), 'Solo: agents frontmatter must be empty');
const soloRaw = rawBlock(solo, '2. Execute', '4. Report', 'Solo execution');
snapshot(soloRaw, `2. Execute — after approval, Lead does all work directly. Do not
spawn, send, delegate, or ask agents to work. Complete execution and
in-scope fixes without reapproval. Interim updates are in-progress, never
conclusions.
3. Verify — Lead checks and fixes directly until clean or a blocker is
reported.`, 'Solo execution');
const soloBody = bodyAfterFrontmatter(solo, 'Solo workflow').replace(soloRaw, '');
assert(!/\b(?:spawn\w*|send\w*|delegat\w*|assign\w*|rout\w*|choose\w*|select\w*|match\w*|agent[- ]selection|ask\w*[^.!?]{0,40}\bagents?)\b/i.test(soloBody), 'Solo: delegation/selection policy must stay in Execute/Verify block');

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
