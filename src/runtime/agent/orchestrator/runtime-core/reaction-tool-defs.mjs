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
      "Leave one emoji reaction under the user's message. Be sparing: most messages get none. React only when the moment genuinely calls for it (real good or sad news, heartfelt thanks, something truly funny), never on two messages in a row. A plain ok or got it usually needs neither reply nor reaction, unless an acknowledgement is clearly expected.❤️ warmth or good news, 👍 agreement or ok, ✔️ done or noted, 😆 funny, 😮 surprising, 😢 sad, 🙏 thanks. React alone, with no reply text, when the reaction fully answers; also reply when the message needs an answer. Never react to questions or requests needing real content, never as a status signal, and never mention or explain a reaction. In a group room, react only to messages for you, never repeating one another member left. Reacting again replaces yours.",
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
export function isReactionToolCall(call) {
  const name = call?.name ?? call?.function?.name;
  if (name === REACTION_TOOL_NAME) return true;
  return name === 'call_tool' && call?.arguments?.name === REACTION_TOOL_NAME;
}

/** The ids of a batch's react calls. */
export function reactionCallIds(calls) {
  return new Set((calls || []).filter(isReactionToolCall).map((call) => call?.id).filter(Boolean));
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
