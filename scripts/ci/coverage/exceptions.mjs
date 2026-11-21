import { readFileSync } from 'node:fs';

import { idKey } from './ids.mjs';
import { obligationOf } from './plan.mjs';

export const EXCEPTIONS = new URL('./exceptions.json', import.meta.url);
const OSES = new Set(['linux', 'macos', 'windows']);
const KINDS = new Set(['skip', 'todo', 'ignored']);
export const OS_OF = { linux: 'linux', darwin: 'macos', win32: 'windows' };

export function loadExceptions(plan, path = EXCEPTIONS) {
  const list = JSON.parse(readFileSync(path, 'utf8'));
  const problems = exceptionProblems(list, plan);
  if (problems.length) throw new Error(`the exceptions list is invalid:\n${problems.join('\n')}`);
  return list;
}

/**
 * Where an excepted case is executed instead, in a form the reconciler enforces:
 *   {kind: 'runs', in: [<leg>#<slot>, ...]}  a pass of the same case on one of these planned obligations
 *   {kind: 'parent', parents: [<id>, ...]}   the case is a child process of these tests, each of which must pass on some leg
 *   {kind: 'none', reason}                   no lane of the gate runs it (a machine or data a hosted runner does not have); the reason
 *                                            names where it is run, and nothing is enforced
 */
function replacementProblems(replacement, plan) {
  const kind = replacement?.kind;
  const fields = { runs: ['kind', 'in'], parent: ['kind', 'parents'], none: ['kind', 'reason'] }[kind];
  if (!fields) return ["replacement must be {kind:'runs', in}, {kind:'parent', parents} or {kind:'none', reason}"];
  const problems = Object.keys(replacement)
    .filter((field) => !fields.includes(field))
    .map((field) => `replacement ${kind} has the unknown field ${field}`);
  if (kind === 'none' && (typeof replacement.reason !== 'string' || !replacement.reason))
    problems.push('replacement none needs its reason');
  if (kind === 'parent') {
    if (!Array.isArray(replacement.parents) || replacement.parents.length === 0)
      problems.push('replacement parent needs the identities of the tests that start it');
    for (const id of replacement.parents ?? []) {
      try {
        idKey(id);
      } catch {
        problems.push(`replacement parent ${JSON.stringify(id)} is not a case identity`);
      }
    }
  }
  if (kind === 'runs') {
    if (!Array.isArray(replacement.in) || replacement.in.length === 0)
      problems.push('replacement runs needs the obligations (<leg>#<slot>) it runs in');
    for (const ref of replacement.in ?? []) {
      try {
        if (plan) obligationOf(plan, ref);
      } catch (error) {
        problems.push(`replacement runs ${error.message}`);
      }
    }
  }
  return problems;
}

/** `${...}` in a reviewed reason text stands for a value the test interpolates (an architecture, an error code): it is the test's own source text. */
export const templateMatches = (template, text) =>
  new RegExp(
    `^${template
      .split(/\$\{[^}]*\}/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.+')}$`
  ).test(text);

/** @param {object} [plan] the reviewed plan: when given, every replacement obligation must be one it declares */
export function exceptionProblems(list, plan) {
  const problems = [];
  if (list.v !== 1 || !Array.isArray(list.exceptions)) return ['exceptions.json needs v: 1 and an exceptions array'];
  const seen = new Set();
  for (const [index, entry] of list.exceptions.entries()) {
    const label = `exception ${index} ${JSON.stringify(entry.id)}`;
    for (const field of Object.keys(entry)) {
      if (
        ![
          'id',
          'platform',
          'slot',
          'kind',
          'reasonCode',
          'reasonText',
          'reasonTemplate',
          'owner',
          'reason',
          'replacement',
        ].includes(field)
      )
        problems.push(`${label}: unknown field ${field} (no file, wildcard, whole-file or optional form exists)`);
    }
    try {
      idKey(entry.id);
    } catch {
      problems.push(`${label}: needs an exact case identity`);
      continue;
    }
    if (entry.id[0] === 'node-suite') problems.push(`${label}: suites are not excepted, their leaves are`);
    if (!OSES.has(entry.platform)) problems.push(`${label}: platform must be linux, macos or windows`);
    if (!KINDS.has(entry.kind)) problems.push(`${label}: kind must be skip, todo or ignored`);
    if (!entry.reasonCode || !/^[a-z0-9-]+$/.test(entry.reasonCode)) problems.push(`${label}: needs a reasonCode`);
    if (
      entry.reasonCode === 'uncoded' &&
      typeof entry.reasonText !== 'string' &&
      ![entry.reasonTemplate].flat().every((template) => typeof template === 'string')
    )
      problems.push(`${label}: an uncoded skip needs its exact reasonText (or the test's own reasonTemplate)`);
    if (!entry.owner || !entry.reason) problems.push(`${label}: needs an owner and a human reason`);
    problems.push(...replacementProblems(entry.replacement, plan).map((text) => `${label}: ${text}`));
    const key = `${idKey(entry.id)}|${entry.platform}|${entry.slot ?? ''}|${entry.kind}|${entry.reasonCode}`;
    if (seen.has(key)) problems.push(`${label}: duplicate tuple`);
    seen.add(key);
  }
  return problems;
}

/** Does `tuple` allow the observed skip? Exact on identity, platform, slot (when the tuple names one), kind and reason code. */
export function allows(tuple, observed) {
  if (idKey(tuple.id) !== idKey(observed.id) || tuple.platform !== observed.platform || tuple.kind !== observed.kind)
    return false;
  if (tuple.slot !== undefined && tuple.slot !== observed.slot) return false;
  if (tuple.reasonCode !== observed.reasonCode) return false;
  if (typeof tuple.reasonText === 'string' && tuple.reasonText !== observed.reasonText) return false;
  if (
    tuple.reasonTemplate !== undefined &&
    ![tuple.reasonTemplate].flat().some((template) => templateMatches(template, observed.reasonText ?? ''))
  )
    return false;
  return true;
}
