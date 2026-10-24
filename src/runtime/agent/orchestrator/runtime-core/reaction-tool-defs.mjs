// react: a bot's emoji reaction on the user's message, shown under the user's
// bubble the way a messenger shows one. Offered only in a bot's own chat with
// the user (its home chat or its seat in a group room) while the Reactions
// setting is on (session-tool-surface.mjs, builtin-features.mjs).
export const REACTION_TOOL_NAME = 'react';

/** The reactions a bot can leave, in the order the schema lists them. */
export const REACTION_EMOJI = Object.freeze(['❤️', '👍', '✔️', '😆', '😮', '😢', '🙏']);
const MESSAGES_BACK_MAX = 20;

export const REACTION_TOOL_DEFS = Object.freeze([
  {
    name: REACTION_TOOL_NAME,
    title: 'React',
    trigger: "Leave one emoji reaction on the user's message, as a chat app shows one under it.",
    description:
      "Leave one emoji reaction under the user's message. Two uses only. Instead of a reply: when the message needs no words back (ok, got it, agreement, thanks, a done update), react alone with no reply text, when the reaction fully answers, instead of a filler reply like 'sounds good'. As emphasis: on clear good or sad news or something truly funny, react and still reply as the message needs; keep this rare, about once per 5-10 exchanges. Otherwise none: never react to questions or requests needing real content, never on two messages in a row, never as a status signal, and never mention or explain a reaction. ❤️ warmth or good news, 👍 agreement or ok, ✔️ done or noted, 😆 funny, 😮 surprising, 😢 sad, 🙏 thanks. In a group room, react only to messages for you, never repeating one another member left. Reacting again replaces yours.",
    annotations: {
      title: 'React',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      agentHidden: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        emoji: { type: 'string', description: `One of ${REACTION_EMOJI.join(' ')}.` },
        messages_back: {
          type: 'integer',
          minimum: 0,
          maximum: MESSAGES_BACK_MAX,
          description: "0 or omitted: the user's latest message; 1: the one before it, and so on.",
        },
        remove: { type: 'boolean', description: 'Remove your reaction instead.' },
      },
      additionalProperties: false,
    },
  },
]);

const bare = (text) => text.replace(/\uFE0F/g, '');

/** The reaction `value` names (a missing or extra U+FE0F tolerated), or ''. */
export function reactionEmoji(value) {
  const text = typeof value === 'string' ? bare(value.trim()) : '';
  return (text && REACTION_EMOJI.find((emoji) => bare(emoji) === text)) || '';
}

/** `{ emoji, messagesBack }` of a react call (`emoji` '' removes); throws on
 *  anything else. */
export function validateReactionArgs(args) {
  const input = args && typeof args === 'object' ? args : {};
  const back = input.messages_back ?? 0;
  if (!Number.isInteger(back) || back < 0 || back > MESSAGES_BACK_MAX) {
    throw new Error(`react: messages_back is a whole number from 0 to ${MESSAGES_BACK_MAX}`);
  }
  if (input.remove === true) return { emoji: '', messagesBack: back };
  const emoji = reactionEmoji(input.emoji);
  if (!emoji) throw new Error(`react: emoji must be exactly one of ${REACTION_EMOJI.join(' ')}`);
  return { emoji, messagesBack: back };
}

/** Whether a provider tool call (direct, or bridged through call_tool) is a react call. */
function isReactionToolCall(call) {
  const name = call?.name ?? call?.function?.name;
  if (name === REACTION_TOOL_NAME) return true;
  return name === 'call_tool' && call?.arguments?.name === REACTION_TOOL_NAME;
}

/** The ids of a batch's react calls. */
export function reactionCallIds(calls) {
  return new Set(
    (calls || [])
      .filter(isReactionToolCall)
      .map((call) => call?.id)
      .filter(Boolean)
  );
}

// What each successful react call actually hit, keyed by session and tool
// call id: the tool result reaches the loop as plain text (internal-tools.mjs
// normalizes every handler return to a string), so this is the result's
// metadata side channel. `{ messageId, room }`: the id of the message
// reactToMessage reacted on, and whether that log is a group room's (a
// separate transcript from the worker's own).
//
// A record belongs to the loop of its session: the batch that ran the call
// consumes it (takeReactionTarget), agentLoop clears the session's leftovers
// whenever it ends, success or not (clearReactionTargets), and the cap bounds
// the map even if neither ever ran.
const REACTION_TARGET_CAP = 256;
const reactionTargets = new Map();
const targetKey = (sessionId, toolCallId) => `${sessionId}\u0000${toolCallId}`;

/** Records the message a successful react call landed on. */
export function noteReactionTarget(sessionId, toolCallId, target) {
  if (!sessionId || !toolCallId || !target?.messageId) return;
  reactionTargets.set(targetKey(sessionId, toolCallId), target);
  if (reactionTargets.size > REACTION_TARGET_CAP) reactionTargets.delete(reactionTargets.keys().next().value);
}

/** Drops every record of `sessionId`: its loop has ended. */
export function clearReactionTargets(sessionId) {
  const prefix = `${sessionId}\u0000`;
  for (const key of reactionTargets.keys()) if (key.startsWith(prefix)) reactionTargets.delete(key);
}

/** How many records are held (tests). */
export function reactionTargetCount() {
  return reactionTargets.size;
}

/** The recorded target of a react call, consumed; null when it recorded none. */
export function takeReactionTarget(sessionId, toolCallId) {
  const key = targetKey(sessionId, toolCallId);
  const target = reactionTargets.get(key) ?? null;
  reactionTargets.delete(key);
  return target;
}

/** Whether a tool result reports one of `ids` (reactionCallIds) as executed
 *  and succeeded: a rejected, denied, skipped or failed call is not a reaction,
 *  and neither is an early UI-only notify that precedes the real result. */
export function isReactionSuccess(message, ids) {
  return (
    message?.role === 'tool' &&
    message.__earlyNotify !== true &&
    message.toolKind === 'normal' &&
    ids.has(message.toolCallId)
  );
}
