// Per-round batching reminder for Anthropic providers that accept turn-scoped
// system messages: a `role: "system"` entry with `clear_at: "next_user_message"`
// appended after every tool-result turn, the pattern Anthropic documents for
// Claude Fable 5.1 agent loops. The text comes from the route policy
// (`rules/routes/*.md`, `round-reminder:`) through opts.roundReminder; the
// message is request-only and never stored as a transcript row.
//
// Kill switch: MIXDOG_ROUND_REMINDER=0 stops new boundaries while every
// recorded one is still replayed (see appendTurnReminders).
import { envFlag } from '../../../shared/env.mjs';

// The sentence every pre-route build sent. Histories recorded under it must
// replay it byte-for-byte: later signed thinking is bound to that prefix.
export const LEGACY_FABLE_51_REMINDER =
  'Privately identify all independent next actions, then request them together in this response.';
const TURN_SCOPED = 'next_user_message';

function toolResultIds(message) {
  if (message?.role !== 'user' || !Array.isArray(message.content)) return [];
  return message.content
    .filter((block) => block?.type === 'tool_result' && typeof block.tool_use_id === 'string')
    .map((block) => block.tool_use_id);
}

// Persist the reminder's scope and exact text with the response it produced,
// partial responses included, so replay rebuilds that prefix byte-for-byte
// even after the route text changes. A round the kill switch suppressed is
// recorded too, with an empty text: without that record the rebuild would
// read the round as unmarked history and insert the legacy boundary in front
// of thinking that was signed without one.
export function withTurnReminderContext(replay, body) {
  if (replay?.provider !== 'anthropic') return replay;
  const messages = body?.messages;
  const tail = messages?.at(-1);
  const bounded = tail?.role === 'system' && tail.clear_at === TURN_SCOPED && typeof tail.content === 'string';
  const ids = toolResultIds(bounded ? messages.at(-2) : tail);
  if (!ids.length) return replay;
  return {
    ...replay,
    requestContext: {
      ...replay.requestContext,
      turnReminder: { version: 2, toolResultIds: ids, text: bounded ? tail.content : '' },
    },
  };
}

// tool_result id → the reminder text that followed it when its response was
// produced. Version-1 rows (`fable51Batching`) predate configurable text and
// always carried the legacy sentence.
function recordedReminders(history) {
  const texts = new Map();
  for (const message of history) {
    const replay = message?.providerReplay;
    if (message?.role !== 'assistant' || replay?.provider !== 'anthropic') continue;
    const context = replay.requestContext || {};
    const records = [
      [context.turnReminder, context.turnReminder?.version === 2 ? context.turnReminder.text : null],
      [context.fable51Batching, context.fable51Batching?.version === 1 ? LEGACY_FABLE_51_REMINDER : null],
    ];
    for (const [record, text] of records) {
      if (typeof text !== 'string' || !Array.isArray(record?.toolResultIds)) continue;
      for (const id of record.toolResultIds) if (typeof id === 'string') texts.set(id, text);
    }
  }
  return texts;
}

// Rebuild each request-only boundary at its original place with its original
// text, not just at the latest tool result: later signed thinking is bound to
// that earlier prefix. `reminder` is the route's current text; without one no
// boundary is emitted at all. MIXDOG_ROUND_REMINDER=0 suppresses only the
// round being sent; every recorded boundary is still rebuilt.
export function appendTurnReminders(messages, reminder, history = []) {
  const line = typeof reminder === 'string' ? reminder.trim() : '';
  if (!line || !Array.isArray(messages)) return false;
  const current = envFlag('MIXDOG_ROUND_REMINDER', true) ? line : '';
  const recorded = recordedReminders(history);
  let changed = false;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const next = messages[index + 1];
    const followsToolResult =
      message?.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((block) => block?.type === 'tool_result');
    // A user interjection before the next assistant response takes
    // precedence. An already-present system boundary must not be doubled.
    if (!followsToolResult || (next && next.role !== 'assistant')) continue;
    const ids = toolResultIds(message);
    const texts = new Set(ids.map((id) => recorded.get(id)).filter((text) => typeof text === 'string'));
    let boundary;
    if (!next) {
      // Suppressed round: nothing is sent now, and withTurnReminderContext
      // records that absence so the rebuild keeps it absent.
      if (!current) continue;
      boundary = { role: 'system', content: current, clear_at: TURN_SCOPED };
    } else if (ids.length > 0 && texts.size === 1 && ids.every((id) => recorded.has(id))) {
      const text = [...texts][0];
      if (!text) continue;
      boundary = { role: 'system', content: text, clear_at: TURN_SCOPED };
    } else {
      // Unmarked historical responses predate turn-scoped reminders: their
      // permanent legacy boundary stays byte-identical.
      boundary = { role: 'system', content: LEGACY_FABLE_51_REMINDER };
    }
    messages.splice(index + 1, 0, boundary);
    index += 1;
    changed = true;
  }
  return changed;
}
