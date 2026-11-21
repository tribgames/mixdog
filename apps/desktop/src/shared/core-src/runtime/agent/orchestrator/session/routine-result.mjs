const LOGIN_REQUIRED = 'Sign-in required: ';
/** Each way an unattended run can need a person, and its summary prefix. */
const HUMAN_NEEDED = Object.freeze({
  login_required: LOGIN_REQUIRED,
  human_action_required: 'Action required: ',
  sensitive_confirmation_required: 'Confirmation required: ',
});
/** The failure summary of an unattended run that needs a person (`outcome`) on `site`. */
function routineHumanNeededText(outcome, site) {
  const label = String(site || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${HUMAN_NEEDED[outcome] || HUMAN_NEEDED.human_action_required}${label || 'the site'}`;
}
/** `{ outcome, site }` of such a failure summary, or null for any other. */
export function routineHumanNeeded(summary) {
  const text = String(summary ?? '');
  for (const [outcome, prefix] of Object.entries(HUMAN_NEEDED)) {
    if (text.startsWith(prefix)) {
      const site = text.slice(prefix.length).trim();
      return site ? { outcome, site } : null;
    }
  }
  return null;
}
export function routineLoginRequiredText(site) {
  return routineHumanNeededText('login_required', site);
}
/** The site of a sign-in-required failure summary, or null for any other. */
export function routineLoginRequiredSite(summary) {
  const needed = routineHumanNeeded(summary);
  return needed?.outcome === 'login_required' ? needed.site : null;
}

/** A routine provenance `{ kind, name, status: 'ok' | 'failed', summary?, error? }`
 *  in its canonical shape, or null when `value` is not one. Summary rows and
 *  the session catalog carry it next to the last-message line, so a client
 *  labels a routine result by this marker, never by parsing the line. */
export function normalizeRoutineProvenance(value) {
  if (!value || typeof value !== 'object') return null;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || (value.kind !== 'schedule' && value.kind !== 'webhook')) return null;
  if (value.status !== 'ok' && value.status !== 'failed') return null;
  const text = (key) => (typeof value[key] === 'string' && value[key] ? { [key]: value[key] } : {});
  return { kind: value.kind, name, status: value.status, ...text('summary'), ...text('error') };
}
