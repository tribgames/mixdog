// Validates the setup-guide model recommendation list and exits non-zero when
// it is older than its own staleAfterDays.
//
//   node scripts/check-model-recommendations.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src/defaults/skills/setup-guide/model-recommendations.json'
);
const data = JSON.parse(readFileSync(file, 'utf8'));
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const errors = [];
const str = (v) => typeof v === 'string' && v.trim() !== '';

if (!DATE.test(data.asOf ?? '')) errors.push('asOf must be YYYY-MM-DD');
if (!Number.isInteger(data.staleAfterDays) || data.staleAfterDays <= 0) {
  errors.push('staleAfterDays must be a positive integer');
}
if (!Array.isArray(data.roles) || data.roles.length === 0) errors.push('roles must be a non-empty array');
for (const [i, entry] of (Array.isArray(data.roles) ? data.roles : []).entries()) {
  const at = `roles[${i}]`;
  if (!Array.isArray(entry.roles) || entry.roles.length === 0 || !entry.roles.every(str)) {
    errors.push(`${at}.roles must be a non-empty string array`);
  }
  if (entry.preferOtherProviderThan !== undefined) {
    const known = new Set(data.roles.flatMap((r) => r.roles ?? []));
    const list = entry.preferOtherProviderThan;
    if (!Array.isArray(list) || !list.length || !list.every((r) => known.has(r))) {
      errors.push(`${at}.preferOtherProviderThan must list existing role names`);
    }
  }
  if (!Array.isArray(entry.picks) || entry.picks.length === 0) errors.push(`${at}.picks must be non-empty`);
  for (const [j, pick] of (Array.isArray(entry.picks) ? entry.picks : []).entries()) {
    for (const key of ['provider', 'model', 'effort', 'source']) {
      if (!str(pick[key])) errors.push(`${at}.picks[${j}].${key} is required`);
    }
    if (!DATE.test(pick.checkedAt ?? '')) errors.push(`${at}.picks[${j}].checkedAt must be YYYY-MM-DD`);
    if (str(pick.source) && !/^https?:\/\//.test(pick.source)) errors.push(`${at}.picks[${j}].source must be a URL`);
  }
}
const MODES = ['none', 'focused', 'balanced', 'swarm'];
const knownRoles = new Set((Array.isArray(data.roles) ? data.roles : []).flatMap((r) => r.roles ?? []));
const roleList = (v) => Array.isArray(v) && v.every((r) => knownRoles.has(r));
const d = data.delegation;
if (!d || typeof d !== 'object') errors.push('delegation is required');
else {
  if (!roleList(d.baseRoster) || !d.baseRoster.length) errors.push('delegation.baseRoster must list existing roles');
  const modes = Array.isArray(d.modes) ? d.modes : [];
  if (modes.map((m) => m.mode).join() !== MODES.join())
    errors.push(`delegation.modes must be ${MODES.join(', ')} in order`);
  for (const m of modes) {
    if (!str(m.label) || !roleList(m.agents))
      errors.push(`delegation.modes ${m.mode}: label and existing-role agents required`);
    if (!m.plans || typeof m.plans !== 'object') errors.push(`delegation.modes ${m.mode}: plans required`);
  }
  const lean = d.leanReview;
  if (
    !lean ||
    !roleList(lean.agentsOff) ||
    !roleList(lean.agentsOn) ||
    !lean.fitsModes?.every((x) => MODES.includes(x))
  ) {
    errors.push('delegation.leanReview needs valid fitsModes, agentsOff, agentsOn');
  }
}
for (const [i, entry] of (Array.isArray(data.roles) ? data.roles : []).entries()) {
  for (const [j, pick] of (Array.isArray(entry.picks) ? entry.picks : []).entries()) {
    if (pick.plans !== undefined && !(pick.plans && Object.values(pick.plans).every(str))) {
      errors.push(`roles[${i}].picks[${j}].plans must map plan to model string`);
    }
  }
}
if (errors.length) {
  console.error(`[model-recommendations] invalid:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}

const ageDays = Math.floor((Date.now() - Date.parse(data.asOf)) / 86_400_000);
if (ageDays > data.staleAfterDays) {
  console.error(
    `[model-recommendations] stale: asOf ${data.asOf} is ${ageDays} days old (limit ${data.staleAfterDays}). Re-check the picks and update the file.`
  );
  process.exit(1);
}
console.log(`[model-recommendations] ok (asOf ${data.asOf}, ${ageDays} days old)`);
