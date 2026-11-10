// The stored form of a message once its session has sensitive values
// (sensitive-values.mjs): only what a message carries as text changes —
//   - its content's text (media-normalization.mjs mapContentText: a string,
//     text parts, a part's string content; media and attachment references
//     stay as they are), tool results included;
//   - its tool calls' argument values (the arguments object, or the JSON text
//     a provider sends them as, parsed and written again).
// Ids, roles, timestamps and every other field stay as they are. Text that is
// a JSON document stays one: its string values are redacted inside it, a
// number that spells a value becomes the marker string, and its keys are kept.
// A message that changes, or whose provider replay state holds a value, is
// stored without that state (manager/provider-replay.mjs): the state belongs
// to the exact message the provider produced, and a provider would check it
// against what it sent — as after a route change, the text and tool calls stay.
import { mapContentText } from '../providers/media-normalization.mjs';
import { providerReplayState, stripProviderReplayMessage } from './manager/provider-replay.mjs';
import { MARKER, containsSensitive, redactSensitiveText, sensitiveValuesVersion } from './sensitive-values.mjs';

function redactJsonValue(sessionId, value) {
  if (typeof value === 'string') return redactTextOrJson(sessionId, value);
  if (typeof value === 'number') return containsSensitive(sessionId, String(value)) ? MARKER : value;
  if (!value || typeof value !== 'object') return value;
  const list = Array.isArray(value);
  const out = list ? [] : {};
  let changed = false;
  for (const [key, item] of Object.entries(value)) {
    const next = redactJsonValue(sessionId, item);
    if (next !== item) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}

/** Text redacted as text, or — when it is a JSON object, array or string (RFC 8259) —
 *  as the JSON document it is, so it still parses afterwards. */
function redactTextOrJson(sessionId, text) {
  // A JSON document is judged by its decoded values, never its raw text: an
  // escape (`\u0036…`) spells a value the raw text does not contain.
  const head = text.trimStart()[0];
  if (head === '{' || head === '[' || head === '"') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if ((parsed && typeof parsed === 'object') || typeof parsed === 'string') {
      const redacted = redactJsonValue(sessionId, parsed);
      return redacted === parsed ? text : JSON.stringify(redacted);
    }
  }
  return redactSensitiveText(sessionId, text);
}

/** Message content with the session's values redacted in its text. */
export function redactSensitiveContent(sessionId, content) {
  if (!sensitiveValuesVersion(sessionId)) return content;
  return mapContentText(content, (text) => redactTextOrJson(sessionId, text));
}

/** A tool call with the session's values redacted in its argument values. */
export function redactSensitiveToolCall(sessionId, call) {
  if (!sensitiveValuesVersion(sessionId) || !call || typeof call !== 'object' || !('arguments' in call)) return call;
  const args = redactJsonValue(sessionId, call.arguments);
  return args === call.arguments ? call : { ...call, arguments: args };
}

/** `message` as it is stored for `sessionId`; the same object when unchanged. */
export function redactSensitiveMessage(sessionId, message) {
  if (!sensitiveValuesVersion(sessionId) || !message || typeof message !== 'object') return message;
  const out = { ...message };
  let changed = false;
  if ('content' in message) {
    out.content = redactSensitiveContent(sessionId, message.content);
    changed = out.content !== message.content;
  }
  if (Array.isArray(message.toolCalls)) {
    const calls = message.toolCalls.map((call) => redactSensitiveToolCall(sessionId, call));
    if (calls.some((call, index) => call !== message.toolCalls[index])) {
      out.toolCalls = calls;
      changed = true;
    }
  }
  const replay = providerReplayState(message);
  const replayHolds = replay !== null && containsSensitive(sessionId, JSON.stringify(replay));
  if (!changed && !replayHolds) return message;
  return replay === null ? out : stripProviderReplayMessage(out);
}

/** Messages as they are stored for `sessionId`; the same array when unchanged. */
export function redactSensitiveMessages(sessionId, messages) {
  if (!sensitiveValuesVersion(sessionId) || !Array.isArray(messages)) return messages;
  let changed = false;
  const out = messages.map((message) => {
    const next = redactSensitiveMessage(sessionId, message);
    if (next !== message) changed = true;
    return next;
  });
  return changed ? out : messages;
}
