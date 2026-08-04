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
const general = readSrc('rules', 'lead', '01-general.md');
const leadTool = readSrc('rules', 'lead', 'lead-tool.md');
const core = readSrc('rules', 'agent', '00-core.md');
const common = readSrc('rules', 'agent', '00-common.md');
const skip = readSrc('rules', 'agent', '20-skip-protocol.md');
const OPTIONAL_BRIEF_FIELDS = ['Anchors:', 'Allow/Forbid:', 'Deliver:'];
const TOKEN_PRINCIPLE = /minimum (?:characters|chars), maximum (?:information|info)/i;
function requireAll(text, label, patterns) {
  for (const pattern of patterns) assert(pattern.test(normalize(text).toLowerCase()), `${label}: missing ${pattern}`);
}
assert(TOKEN_PRINCIPLE.test(normalize(leadBrief)), 'lead-brief.md: brief must state min-char/max-info principle');
assert(leadBrief.includes('Task:'), 'lead-brief.md: brief must require labeled field Task:');
assert(!leadBrief.includes('Goal:'), 'lead-brief.md: Goal: must be replaced by Task:');
for (const field of OPTIONAL_BRIEF_FIELDS) assert(leadBrief.includes(field), `lead-brief.md: brief missing optional labeled field ${field}`);
assert(!leadBrief.includes('Verify:'), 'lead-brief.md: must not prescribe Verify:');
assert(
  !/copy a prior role(?:'s)? brief|worker\s*(?:->|→)\s*debugger\s*(?:->|→)\s*reviewer|\blead\s*\/\s*worker\b/i.test(leadBrief),
  'lead-brief.md: must not restore cross-role Task copying or lineage',
);
requireAll(leadBrief, 'Lead brief task', [
  /`task:` is mandatory and lossless/, /intent/, /required and forbidden outcomes/,
  /completion\/stop boundary/, /other fields are task-specific deltas/,
  /user-supplied exact targets, and exact replacements\/outputs/,
  /never infer exactness from task name, file count, or difficulty/,
  /each role constructs it from/,
  /the original request and official spec\/test acceptance criteria/,
]);
assert(/role-known|already (?:owns|knows)|wasted cost|wasted/i.test(normalize(leadBrief)), 'lead-brief.md: brief must ban restating known rules/background as cost');
assert(/original request and official spec\/test acceptance criteria/i.test(normalize(leadBrief)), 'lead-brief.md: original request and official acceptance criteria must beat summary');
requireAll(leadBrief, 'Lead brief lifecycle', [
  /full brief only for a fresh spawn or `respawned: true`/, /live follow-ups carry only the delta/,
  /dead-tag send is cold and must re-supply anchors/, /never `send` mid-run/,
  /batch one follow-up after completion/, /interrupt only to cancel/,
  /agent communication is english/,
]);
assert(/lead brief contract/i.test(normalize(workflow)), 'WORKFLOW.md: must defer to the lead brief contract');
assert(!OPTIONAL_BRIEF_FIELDS.every((field) => workflow.includes(field)), 'WORKFLOW.md: must not duplicate the optional brief field list');

assert(/fragments/i.test(core), '00-core: handoff must require fragments');
assert(/file:line/i.test(core), '00-core: handoff must anchor evidence to file:line');
for (const banned of ['headings', 'tables', 'narration', 'raw logs', 'next checks']) {
  assert(core.toLowerCase().includes(banned), `00-core: banned list missing ${banned}`);
}
assert(/Public Agent Constraints/i.test(common), '00-common: must be titled public-only constraints');
assert(/git operations deferred to Lead/i.test(normalize(common)), '00-common: must refuse git/Ship');
assert(/Overflow goes to a file/i.test(common), '00-common: must keep overflow-to-file rule');
requireAll(common, 'Public-agent shell', [
  /use shell only to verify your edits/, /never explore, install, or change state beyond the brief/,
]);

// --- Per-role output contracts --------------------------------------------
const roles = {
  'worker/AGENT.md': readSrc('agents', 'worker', 'AGENT.md'),
  'heavy-worker/AGENT.md': readSrc('agents', 'heavy-worker', 'AGENT.md'),
  'reviewer/AGENT.md': readSrc('agents', 'reviewer', 'AGENT.md'),
  'debugger/AGENT.md': readSrc('agents', 'debugger', 'AGENT.md'),
};
const reviewerRole = roles['reviewer/AGENT.md'];
assert(
  !/construct the review\s*`task:` independently/i.test(reviewerRole),
  'reviewer/AGENT.md: must not restore Reviewer-specific Task construction',
);
assert(
  !/treat prior reports as unverified claims rather than evidence/i.test(reviewerRole),
  'reviewer/AGENT.md: must not restore prior-report framing',
);

// Semantic contracts deliberately avoid prose snapshots.
function snapshot(actual, expected, label) {
  assert(normalize(actual) === normalize(expected), `${label}: canonical snapshot changed`);
}
assert(/^agents:\s*$/m.test(frontmatter(solo, 'Solo workflow')), 'Solo: agents frontmatter must be empty');
requireAll(workflow, 'Default approval', [
  /consult the user and build the plan together/,
  /before the user explicitly approves the latest plan/,
  /read-only investigation and planning/,
  /no edits, no state mutation, no delegation/,
  /new or changed request resets planning/,
  /scope change requires fresh approval/,
]);
const WORKER_HEAVY_ROUTING_CONTRACT = [
  /route by complexity/,
  /simple, well-understood implementation goes to worker/,
  /complex or investigative implementation goes to heavy worker/,
];
requireAll(workflow, 'Default Worker/Heavy Worker routing', WORKER_HEAVY_ROUTING_CONTRACT);
assert(
  !/fully\s+specified\s+artifact/i.test(workflow),
  'Default: removed Worker routing criterion must not return',
);
const ROUTING_REVIEW_POLICY = [
  /lead itself edits only a local, one-turn configuration\/git change/,
  /debugger only on a defect needing deep root-cause analysis or a bug surviving 2\+ review\/fix cycles/,
  /every implementation gets its own reviewer, attached per scope/,
  /only the local lead-direct edits above are exempt/,
  /keep the same reviewer through the fix loop/,
  /repeat fix -> re-verify until clean/,
  /lead cross-verifies in parallel with the reviewer/,
];
requireAll(workflow, 'Default routing/review policy', ROUTING_REVIEW_POLICY);
assert(
  !/(high clarity|low structural complexity|immediate 1-step|genuinely simple)/i.test(workflow),
  'Default: heuristic routing/review language must not return',
);
requireAll(workflow, 'Default lifecycle', [
  /fan out at maximum width: one agent per independent scope, all spawned in one turn/,
  /only a scope that depends on another's output waits/,
  /disjoint file\/module sets are independent; merge only on a true output dependency/,
  /prefer parallel scopes over sequential slices in one agent/,
  /brief each agent per the lead brief contract/,
  /report the verified result against the approved plan/,
  /on direction change, pause and re-consult the user/,
]);
requireAll(solo, 'Solo lifecycle', [
  /consult the user and build the plan together/,
  /before the user explicitly approves the latest plan/,
  /read-only investigation and planning — no edits, no state mutation/,
  /new or changed request resets planning; a scope change requires fresh approval/,
  /never spawn, send, or delegate to agents/,
  /complete in-scope fixes without reapproval/,
  /verification is single-pass and risk-proportional/,
  /a pass is final/,
  /iterate only on a failing check, re-running just that check after each fix, or report the blocker/,
  /report the result and its proving check against the approved plan/,
  /on direction change, pause and re-consult the user/,
]);
requireAll(leadTool, 'Lead tools', [
  /write-role agents self-verify/, /cross-scope verification.*benches.*all git/,
]);
requireAll(general, 'General safety', [
  /you are mixdog, the current coding-agent/, /never identify as generic openai\/chatgpt/,
  /destructive\/hard-to-reverse action needs explicit confirmation/,
  /never `~`, a root, or unresolved variables\/globs/,
  /report material deletions with recoverability/,
  /when blocked, exhaust safe in-scope checks once/,
]);
requireAll(workflow, 'Default ship safety', [
  /build, deploy, commit, and push happen only on an explicit user request/,
]);
requireAll(solo, 'Solo ship safety', [
  /build, deploy, commit, and push happen only on an explicit user request/,
]);
requireAll(skip, 'Silent skip', [
  /webhook-handler/, /scheduler-task/, /non-actionable/,
  /prefix every non-actionable[\s\S]*\[meta:silent\]/,
]);

const roleSnapshots = {
  'worker/AGENT.md': `# Worker
Scoped implementation agent.

Own only the bounded responsibility assigned in the brief. Trust its
\`file:line\` anchors; do only minimal targeted discovery, then make the
smallest coherent patch. No drive-by cleanup or scope expansion.

EDIT-FIRST DISCIPLINE. Patch promptly rather than repeating read-only turns;
stop and report blocked when the assigned scope cannot be completed.

Patch and report the changed \`file:line\`; verification belongs to the Lead and Reviewer.`,
  'heavy-worker/AGENT.md': `# Heavy Worker
Own the assigned implementation slice through staged delivery.

Break work into bounded, dependency-aware slices and execute them in sequence.
Keep the smallest coherent change; control blast radius rather than rewriting
adjacent systems.

EDIT-FIRST DISCIPLINE. Patch incrementally and stop at the first explicit
boundary: unclear ownership, a missing dependency, or growing blast radius.
Do not cross that boundary without a new bounded assignment; report blocked
work with the relevant file:line.

Finish the slice and report the changed \`file:line\`; verification belongs to the Lead and Reviewer.`,
  'reviewer/AGENT.md': `# Reviewer
Independent regression/risk review agent.

Review the diff and tests with independent judgment. Prioritize actionable
correctness, regression, security, and verification risks; inspect affected
boundaries. Do not reimplement the change or report non-risky nits. Independently
evaluate the final deliverable with a critical lens, actively seeking errors,
unsupported assumptions, and counterexamples before confirming.

Report findings first, severity-ordered, with one line per \`file:line\`. If clean,
say so in one line and include only material residual risk.

When the work comes with stated criteria or reference material for judging
it, verify against those as given — substituting your own interpretation or
a self-built check is a verification risk to report.`,
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
  assert(leadRules.includes('Task:'), 'injected Lead rules missing mandatory brief field Task:');
  assert(!leadRules.includes('Goal:'), 'injected Lead rules must not retain Goal:');
  for (const field of OPTIONAL_BRIEF_FIELDS) assert(leadRules.includes(field), `injected Lead rules missing optional brief field ${field}`);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

process.stdout.write('internal comms smoke passed\n');
