// Tool-call ids at the wire. A transcript keeps each tool call's id as the
// provider that produced it minted it; after a model switch another provider
// may refuse it (Anthropic accepts only [A-Za-z0-9_-]; OpenAI chat caps the
// length). Each request builder projects the ids onto its own rule just
// before lowering: a valid id passes unchanged (so native replay items and
// the provider's own ids stay byte-exact), an invalid one becomes a
// deterministic, collision-free stand-in, and a call and its result always
// map to the same value. Persisted history is never rewritten.
import { createHash } from 'node:crypto';

export const ANTHROPIC_TOOL_CALL_IDS = Object.freeze({ allowed: /^[A-Za-z0-9_-]+$/, maxLength: 64 });
export const OPENAI_RESPONSES_TOOL_CALL_IDS = Object.freeze({ allowed: /^[A-Za-z0-9_.:-]+$/, maxLength: 64 });
export const OPENAI_CHAT_TOOL_CALL_IDS = Object.freeze({ allowed: /^[A-Za-z0-9_.:-]+$/, maxLength: 40 });

const HASH_CHARS = 10;

function standIn(id, rule, salt) {
  const hash = createHash('sha256').update(`${salt}\u0000${id}`).digest('hex').slice(0, HASH_CHARS);
  const stem = String(id)
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, Math.max(0, rule.maxLength - HASH_CHARS - 1));
  return stem ? `${stem}_${hash}` : `call_${hash}`.slice(0, rule.maxLength);
}

const isValid = (id, rule) => id.length > 0 && id.length <= rule.maxLength && rule.allowed.test(id);

/** id → wire id for every tool call and result in `messages` under `rule`. */
export function toolCallWireIdMap(messages, rule) {
  const ids = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'assistant')
      for (const call of message.toolCalls || []) if (call?.id) ids.add(String(call.id));
    if (message?.role === 'tool' && message.toolCallId) ids.add(String(message.toolCallId));
  }
  const map = new Map();
  const taken = new Set([...ids].filter((id) => isValid(id, rule)));
  for (const id of ids) {
    if (isValid(id, rule)) continue;
    let salt = 0;
    let wire = standIn(id, rule, salt);
    while (taken.has(wire)) wire = standIn(id, rule, ++salt);
    taken.add(wire);
    map.set(id, wire);
  }
  return map;
}

/** `messages` with tool-call ids projected onto `rule`; the same array when none needs it. */
export function withWireToolCallIds(messages, rule) {
  const map = toolCallWireIdMap(messages, rule);
  if (!map.size) return messages;
  return messages.map((message) => {
    if (message?.role === 'tool' && map.has(String(message.toolCallId))) {
      return { ...message, toolCallId: map.get(String(message.toolCallId)) };
    }
    if (message?.role !== 'assistant' || !message.toolCalls?.some((call) => map.has(String(call?.id)))) return message;
    return {
      ...message,
      toolCalls: message.toolCalls.map((call) =>
        map.has(String(call?.id)) ? { ...call, id: map.get(String(call.id)) } : call
      ),
    };
  });
}
