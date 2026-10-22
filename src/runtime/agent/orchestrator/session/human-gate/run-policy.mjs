// session/human-gate/run-policy.mjs
// Schedule and webhook runs never ask. Saving a schedule or webhook is the
// user's explicit grant for its runs (and for the work they start: sub-agents):
// outbound actions and ordinary tool approvals are
// allowed without a card, a held row or a push, inside the bot's own
// permissions (a `block` is applied before any ask, gate.mjs). Payments and
// permanent deletes (the action kinds that can never be remembered) are never
// done in a run: denied at once, with a result the bot can report. Group-room
// members are not runs of this kind and keep their held/approval behaviour.
import { ACTION_KINDS, isRememberableAction } from './outbound-policy.mjs';

export const RUN_FORBIDDEN_REASON =
  "Payments and permanent deletes aren't allowed in schedule/webhook runs; do it from the chat.";

/** The ask reason of a schedule/webhook save: the grant, said plainly. */
export const AUTOMATION_GRANT_REASON =
  "Approving lets this schedule's or webhook's runs act without asking, within the bot's permissions. Payments and permanent deletes are never done in runs.";

/** Whether `run` (the unattended port's `runOf`) is a schedule or webhook run. */
export const isGrantedRun = (run) => Boolean(run) && run.kind !== 'room';

/** Whether an outbound request is a payment or permanent delete. */
export function isForbiddenInRun(request) {
  const category = request?.kind === 'outbound' ? request.outbound?.category : '';
  return ACTION_KINDS.includes(category) && !isRememberableAction(category);
}

const READ_VERBS = new Set([
  'get',
  'list',
  'search',
  'read',
  'fetch',
  'retrieve',
  'find',
  'view',
  'describe',
  'lookup',
]);
const DELETE_TOKENS = new Set(['delete', 'remove', 'destroy', 'erase', 'purge', 'wipe']);

/** Whether a connector/MCP tool deletes remote items without being a confirmed
 *  recoverable `trash`: in a run that counts as a permanent delete. Read-verb
 *  names (`list_deleted_items`) stay reads. `classified` is the outbound
 *  classification of the call (outbound-policy.mjs), if any. */
export function isRemoteDeleteInRun({ name, annotations }, classified) {
  const toolName = String(name || '');
  if (!toolName.startsWith('mcp__')) return false;
  if (classified?.category === 'trash') return false;
  if (classified?.category === 'delete') return true;
  const bare = String(annotations?.mcpToolName || toolName.split('__').slice(2).join('__'))
    .toLowerCase()
    .replace(/-/g, '_');
  const tokens = bare.split(/[^a-z0-9]+/).filter(Boolean);
  if (READ_VERBS.has(tokens[0])) return false;
  return tokens.some((token) => DELETE_TOKENS.has(token));
}

/** Whether `call` saves a schedule or webhook (the setup tool's `save_automation`). */
export const savesAutomation = (call) => call?.name === 'setup' && call.args?.action === 'save_automation';

/** The answer a granted run gets instead of a card: `{ approval }` to run the
 *  call, or `{ denial, approval }` for a payment or permanent delete. The
 *  `response` is the audit decision (`run-allowed`, `run-forbidden`). */
export function runAskOutcome({ name, request }) {
  if (isForbiddenInRun(request)) {
    return {
      denial: `Error: tool "${name}" denied: ${RUN_FORBIDDEN_REASON} Report this to the user; do not retry it or reach the same result another way.`,
      approval: { approved: false, response: 'run-forbidden', reason: RUN_FORBIDDEN_REASON },
    };
  }
  return { approval: { approved: true, response: 'run-allowed', reason: 'schedule/webhook run' } };
}
