// Tail reminders: short per-model/per-language nudges appended to the very end
// of an outgoing request (after the last tool result), fresh on every request.
// They are never stored as messages of their own; the Anthropic builders place
// their last cache breakpoint BEFORE them. The assistant turn a request produces
// keeps that request's reminder text (`turnReminder`, send-with-recovery.mjs).
// How each provider places them (providers/lib/tail-reminder-split.mjs):
//   - legacy: the reminder ends this request only and is gone from the next;
//   - turn-scoped (first-party Anthropic on a supported model, opt-in per
//     provider): a clear_at system message that every later request re-sends
//     verbatim before its assistant turn, so the wire is append-only and the
//     model's earlier thinking stays bound to an unchanged prefix.
//
// HOW TO ADD A RULE (a new per-model/per-language fix needs nothing else):
//   1. Append {id, when, text} to TAIL_REMINDER_RULES. `when` holds any of
//      provider / model / language / role, each a list of accepted values; ALL
//      given tags must match, an omitted tag matches anything.
//   2. `text` may use `{language}` (the language block's name, e.g. "Korean").
//   3. Add a positive and a negative case to tail-reminder-rules.test.mjs.
// Values: provider = provider id or family ('anthropic'); model = normalized
// family id ('claude-opus-5-5', route prefix/dots/date folded); language = id
// ('ko'); role = 'lead' | 'bot' | 'worker'. Unknown tags throw at load.
import { AGENT_MODE } from './agent-mode.mjs';
import { _buildLeadLanguage } from './manager/rules-cache.mjs';
import { TAIL_REMINDER_META } from '../providers/lib/tail-reminder-split.mjs';

const TAIL_REMINDER_TAGS = Object.freeze(['provider', 'model', 'language', 'role']);
const ROLES = ['lead', 'bot', 'worker'];

const PROVIDER_FAMILIES = Object.freeze({
  'anthropic-oauth': 'anthropic',
  anthropic: 'anthropic',
});

export const TAIL_REMINDER_RULES = Object.freeze([
  // Claude Opus 5.5 keeps answering Korean users in English in long agentic
  // turns, where many English tool results sit between the user message and
  // the final answer.
  {
    id: 'opus-5-5-korean',
    when: { model: ['claude-opus-5-5'], language: ['ko'], role: ['lead', 'bot'] },
    text: 'Write all user-facing text in {language}.',
  },
]);

export function validateTailReminderRules(rules) {
  if (!Array.isArray(rules)) throw new Error('tail reminder rules must be an array');
  const ids = new Set();
  for (const rule of rules) {
    if (!rule?.id || ids.has(rule.id)) throw new Error(`tail reminder rule: missing or duplicate id "${rule?.id}"`);
    ids.add(rule.id);
    for (const key of Object.keys(rule)) {
      if (!['id', 'when', 'text'].includes(key))
        throw new Error(`tail reminder rule ${rule.id}: unknown field "${key}"`);
    }
    if (typeof rule.text !== 'string' || !rule.text.trim())
      throw new Error(`tail reminder rule ${rule.id}: text required`);
    for (const [tag, values] of Object.entries(rule.when || {})) {
      if (!TAIL_REMINDER_TAGS.includes(tag)) throw new Error(`tail reminder rule ${rule.id}: unknown tag "${tag}"`);
      if (!Array.isArray(values) || !values.length || values.some((v) => typeof v !== 'string' || !v)) {
        throw new Error(`tail reminder rule ${rule.id}: "${tag}" must be a non-empty string list`);
      }
    }
    for (const role of rule.when?.role || []) {
      if (!ROLES.includes(role)) throw new Error(`tail reminder rule ${rule.id}: unknown role "${role}"`);
    }
  }
  return rules;
}
validateTailReminderRules(TAIL_REMINDER_RULES);

/** `anthropic/claude-opus-5.5`, `claude-opus-5-5-20260101`, `us.anthropic.claude-opus-5-5-v1:0`,
 *  `claude-opus-5-5-thinking` → `claude-opus-5-5`. */
export function modelFamilyId(model) {
  let id = String(model || '')
    .trim()
    .toLowerCase()
    .replace(/\./g, '-');
  const at = id.indexOf('claude-');
  if (at >= 0) id = id.slice(at);
  else id = id.slice(id.lastIndexOf('/') + 1);
  // `@date`, Bedrock `-v1:0`, a gateway `:variant` (`:thinking`), `-v1`,
  // `-YYYYMMDD`, and the `-thinking` alias of the same model.
  return id
    .replace(/@.*$/, '')
    .replace(/-v\d+:\d+$/, '')
    .replace(/:[^/]*$/, '')
    .replace(/-v\d+$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-thinking$/, '');
}

/** The session's role: 'worker' (agent-owned), 'bot' (agent mode) or 'lead'. */
function tailReminderRole(session) {
  if (session?.owner === 'agent') return 'worker';
  return session?.sessionMode === AGENT_MODE ? 'bot' : 'lead';
}

// All given conditions must hold (AND); an omitted condition matches anything.
function ruleMatches({ when = {} }, { provider, model, languageId, role }) {
  const family = PROVIDER_FAMILIES[provider];
  if (when.provider && !when.provider.some((p) => p === provider || (family && p === family))) return false;
  if (when.model && !when.model.includes(modelFamilyId(model))) return false;
  if (when.language && !when.language.includes(languageId)) return false;
  if (when.role && !when.role.includes(role)) return false;
  return true;
}

/**
 * The joined text of every matching rule wrapped as one system-reminder, or ''.
 * context = {provider, model, language: {id, name}|null, role}.
 */
export function matchTailReminder(context, rules = TAIL_REMINDER_RULES) {
  const language = context.language || null;
  const facts = { ...context, languageId: language?.id };
  const texts = rules
    .filter((rule) => ruleMatches(rule, facts))
    .map((rule) => rule.text.replaceAll('{language}', language?.name || ''));
  return texts.length ? `<system-reminder>${texts.join('\n')}</system-reminder>` : '';
}

/** `messages` plus the tail reminder for this request (a copy; the input is untouched). */
export function withTailReminder(messages, { session, provider, model }, language = _buildLeadLanguage()) {
  const text = matchTailReminder({
    provider: session?.provider || provider?.name || '',
    model,
    language,
    role: tailReminderRole(session),
  });
  if (!text) return messages;
  return [...messages, { role: 'user', content: text, meta: { source: TAIL_REMINDER_META } }];
}
