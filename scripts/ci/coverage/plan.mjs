// The reviewed plan (scripts/ci/coverage/plan.json): which legs a release runs, which slots each has, where each family of tests
// must run, and which tracked files are reviewed non-tests or tests that do not run in CI. It is written and reviewed by hand and is NOT derived from any workflow
// or any run: the wiring check compares the workflows to it (wiring.mjs) and the reconciler compares the artifacts to it (reconcile.mjs).
import { readFileSync } from 'node:fs';

import { PRODUCERS } from './evidence.mjs';
import { digestOf, idKey, matchesAny } from './ids.mjs';

export const PLAN = new URL('./plan.json', import.meta.url);
const OSES = new Set(['linux', 'macos', 'windows']);
// fixture/helper/template/non-test-target: not a test at all. vendor: a third-party suite. not-run-in-ci: a real test (live, manual,
// benchmark) no hosted runner can run.
const CLASSES = new Set([
  'fixture',
  'helper',
  'template',
  'vendor',
  'non-test-target',
  'not-run-in-ci',
  'not-run-by-decision',
  'runs-after-packaging',
]);

export function loadPlan(path = PLAN) {
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  const problems = planProblems(plan);
  if (problems.length) throw new Error(`the coverage plan is invalid:\n${problems.join('\n')}`);
  return plan;
}

export const planDigest = (plan) => digestOf(plan);

const LEG_FIELDS = new Set(['id', 'os', 'workflow', 'job', 'slots']);
const SLOT_FIELDS = new Set(['id', 'producer', 'parent']);

/**
 * The obligation a plan reference names: `<leg>#<slot>`. A bare leg id stands for its one slot; a leg with several slots must be named
 * with the slot, so a result is credited to the invocation that was meant to produce it and never to a sibling or a child.
 * @returns {string} the canonical `<leg>#<slot>`
 */
export function obligationOf(plan, ref) {
  const [legId, slot, extra] = String(ref).split('#');
  const leg = [...(plan.legs ?? []), ...(plan.joinLegs ?? [])].find((entry) => entry.id === legId);
  if (!leg || extra !== undefined) throw new Error(`names the undeclared leg ${legId}`);
  const slots = (leg.slots ?? []).map((entry) => entry.id);
  if (slot === undefined) {
    if (slots.length !== 1)
      throw new Error(`names the leg ${legId}, which has the slots ${slots.join(', ')}: name one (${legId}#<slot>)`);
    return `${legId}#${slots[0]}`;
  }
  if (!slots.includes(slot)) throw new Error(`names the slot ${slot}, which ${legId} does not declare`);
  return `${legId}#${slot}`;
}

/** Is the obligation `<leg>#<slot>` one of a join leg (evidence the release workflow checks at its join, which the gate cannot see)? */
export const isJoinObligation = (plan, at) => (plan.joinLegs ?? []).some((leg) => at.startsWith(`${leg.id}#`));

function slotProblems(leg, slots, problems) {
  const ids = slots.map((slot) => slot?.id);
  if (slots.length === 0 || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !id))
    problems.push(`leg ${leg.id} needs distinct named slots`);
  for (const slot of slots) {
    for (const field of Object.keys(slot ?? {}))
      if (!SLOT_FIELDS.has(field)) problems.push(`leg ${leg.id} slot ${slot.id} has the unknown field ${field}`);
    if (!PRODUCERS.has(slot?.producer))
      problems.push(`leg ${leg.id} slot ${slot?.id} needs its producer (${[...PRODUCERS].join(', ')})`);
    if (slot?.parent === undefined) continue;
    if (slot.parent === slot.id) problems.push(`leg ${leg.id} slot ${slot.id} names itself as its parent`);
    else if (!ids.includes(slot.parent))
      problems.push(`leg ${leg.id} slot ${slot.id} names the parent ${slot.parent}, which the leg does not declare`);
    // the parent chain ends in a top-level slot
    const seen = new Set([slot.id]);
    for (
      let at = slots.find((entry) => entry.id === slot.parent);
      at?.parent !== undefined;
      at = slots.find((entry) => entry.id === at.parent)
    ) {
      if (seen.has(at.id)) {
        problems.push(`leg ${leg.id} slot ${slot.id} has a parent cycle`);
        break;
      }
      seen.add(at.id);
    }
  }
}

function legProblems(plan, problems) {
  const legIds = new Set();
  // join legs: producers in a release workflow's own jobs (a prepared environment the gate cannot build), checked at that workflow's join
  for (const leg of [...(plan.legs ?? []), ...(plan.joinLegs ?? []).map((entry) => ({ ...entry, join: true }))]) {
    if (!leg.id || !OSES.has(leg.os) || !leg.workflow || !leg.job)
      problems.push(`leg ${JSON.stringify(leg.id)} needs an id, an os, a workflow and a job`);
    if (leg.join && !/^[\w.-]+\.yml#[\w-]+$/.test(leg.caller ?? ''))
      problems.push(`join leg ${leg.id} needs the caller job (<workflow>#<job>) whose run produces it`);
    for (const field of Object.keys(leg))
      if (!LEG_FIELDS.has(field) && !(leg.join && (field === 'caller' || field === 'join')))
        problems.push(
          `leg ${leg.id} has the unknown field ${field} (a leg has a producer for every slot; there is no pending form)`
        );
    if (legIds.has(leg.id)) problems.push(`leg ${leg.id} is declared twice`);
    legIds.add(leg.id);
    slotProblems(leg, Array.isArray(leg.slots) ? leg.slots : [], problems);
  }
}

/** Routing names the gate's own legs: a join leg is only a replacement of an exception, never where a test is routed. */
function refProblems(plan, problems, where, refs) {
  for (const ref of refs) {
    try {
      if (isJoinObligation(plan, obligationOf(plan, ref)))
        problems.push(`${where} routes to the join leg ${ref}, which the gate does not run`);
    } catch (error) {
      problems.push(`${where} ${error.message}`);
    }
  }
}

function clauseProblems(plan, problems, where, requires) {
  if (!Array.isArray(requires) || requires.length === 0)
    problems.push(`${where} has no requirement: a test with no applicable leg is an error`);
  for (const clause of requires ?? []) {
    if (!Array.isArray(clause.anyOf) || clause.anyOf.length === 0) problems.push(`${where} has an empty clause`);
    refProblems(plan, problems, where, clause.anyOf ?? []);
  }
}

function routeAndClassProblems(plan, problems) {
  for (const route of plan.routes ?? []) {
    if (!route.name || !route.family || !route.owner || !Array.isArray(route.include) || route.include.length === 0)
      problems.push(`route ${JSON.stringify(route.name)} needs a name, a family, an owner and include globs`);
    clauseProblems(plan, problems, `route ${route.name}`, route.requires);
  }
  for (const rule of plan.classes ?? []) {
    if (!CLASSES.has(rule.class) || !rule.glob || !rule.reason || !rule.owner)
      problems.push(`class rule ${JSON.stringify(rule.glob)} needs a glob, a known class, a reason and an owner`);
    if (
      (rule.class === 'runs-after-packaging') !== (rule.joinSlot !== undefined) ||
      (rule.joinSlot !== undefined && !isJoinObligation(plan, rule.joinSlot))
    )
      problems.push(
        `class rule ${JSON.stringify(rule.glob)}: runs-after-packaging needs a joinSlot naming a join leg slot, and only it has one`
      );
    if (/^\*\*?$|^\*\*\/\*$/.test(rule.glob ?? '')) problems.push(`class rule ${rule.glob} is not narrow`);
  }
  // a case scoped to some gates only: it tests an artifact only those gates' callers build, and each of them must check its evidence
  for (const scope of plan.gateScopes ?? []) {
    try {
      idKey(scope.id);
    } catch {
      problems.push(`gate scope ${JSON.stringify(scope.id)} is not a case identity`);
    }
    if (!Array.isArray(scope.gates) || scope.gates.length === 0 || !scope.reason || !scope.owner)
      problems.push(`gate scope ${JSON.stringify(scope.id)} needs the gates that must run it, a reason and an owner`);
  }
}

function rustProblems(plan, problems) {
  for (const unit of plan.rust?.standalone ?? [])
    clauseProblems(plan, problems, `rust unit ${unit.manifestDir}`, unit.requires);
  // a target absent from some build variants by a platform cfg: declared here by rule, never inferred from a listing that lacks it
  for (const rule of plan.rust?.absent ?? [])
    for (const name of rule.variants ?? [])
      if (!(plan.rust?.variants ?? []).some((variant) => variant.name === name))
        problems.push(
          `rust absent rule ${JSON.stringify(rule.glob)} names the variant ${name}, which the plan does not declare`
        );
  for (const rule of plan.rust?.absent ?? [])
    if (!rule.glob || !Array.isArray(rule.variants) || rule.variants.length === 0 || !rule.reason || !rule.owner)
      problems.push(`rust absent rule ${JSON.stringify(rule.glob)} needs a glob, its variants, a reason and an owner`);
  for (const unit of plan.rust?.doctests ?? [])
    clauseProblems(plan, problems, `rust doctests of ${unit.manifestDir}`, unit.requires);
  for (const variant of plan.rust?.variants ?? [])
    refProblems(plan, problems, `rust variant ${variant.name}`, [
      ...variant.testLegs,
      variant.listLeg,
      ...Object.values(variant.profileLegs ?? {}).flat(),
    ]);
}

/** Structural problems of a plan: the reviewed document must name an owner everywhere a decision is recorded. */
export function planProblems(plan) {
  const problems = [];
  if (plan.v !== 1) problems.push('plan.v must be 1');
  for (const owner of ['classifier', 'routing', 'exceptions'])
    if (!plan.owners?.[owner]) problems.push(`plan.owners.${owner} is missing`);
  if (Object.hasOwn(plan, 'pendingProducers'))
    problems.push('plan.pendingProducers exists: every declared leg has its producer, there is no pending form');
  legProblems(plan, problems);
  routeAndClassProblems(plan, problems);
  rustProblems(plan, problems);
  return problems;
}
/** Clauses of every route whose include globs match `path` for `family`, as canonical obligations; none is an error for the caller. */
export function clausesFor(plan, family, path) {
  const clauses = new Map();
  const routes = [];
  for (const route of plan.routes) {
    if (route.family !== family || !matchesAny(path, route.include) || matchesAny(path, route.exclude ?? [])) continue;
    routes.push(route.name);
    for (const clause of route.requires) {
      const anyOf = clause.anyOf.map((ref) => obligationOf(plan, ref)).sort();
      clauses.set(JSON.stringify(anyOf), { anyOf });
    }
  }
  return { routes, requires: [...clauses.values()].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) };
}

/** The reviewed classes whose glob matches the path: one, or none; more is an ambiguity the inventory reports. */
export const classesOf = (plan, path) => (plan.classes ?? []).filter((rule) => matchesAny(path, [rule.glob]));
