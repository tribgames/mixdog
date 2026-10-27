import { SESSION_ID_PATTERN } from '../../runtime/agent/orchestrator/runtime-core/session-id.mjs';

const TARGET_ACTIONS = new Set(['status', 'read', 'send', 'cancel', 'delete']);
const MUTATING_ACTIONS = new Set(['send', 'cancel', 'delete']);

/** The calling session of a `session` request; throws on an action the tool
 *  does not run or a request without a valid caller session. */
export function requestCaller(action, context) {
  if (
    action !== 'list' &&
    action !== 'create' &&
    action !== 'bots' &&
    action !== 'worktree' &&
    action !== 'route' &&
    !TARGET_ACTIONS.has(action)
  ) {
    throw new Error(`session: unsupported remote action "${action}"`);
  }
  const caller = context.callerSessionId;
  if (typeof caller !== 'string' || !SESSION_ID_PATTERN.test(caller)) {
    throw new Error('session: caller session is required');
  }
  return caller;
}

/** The addressed session and transcript paging of a `list` or target action:
 *  `{ sessionId, limit, offset, textOffset }`; throws on a missing target, a
 *  self mutation or paging out of range. */
export function targetRequest(args, action, caller) {
  const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
  if (TARGET_ACTIONS.has(action) && !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`session: session_id is required for action=${action}`);
  }
  if (MUTATING_ACTIONS.has(action) && sessionId === caller) {
    throw new Error(`session: ${action} must target another session`);
  }
  const limit = args.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('session: limit must be an integer from 1 to 100');
  }
  const offset = args.offset ?? 0;
  const textOffset = args.text_offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + limit)) {
    throw new Error('session: offset must be a nonnegative safe integer');
  }
  if (!Number.isSafeInteger(textOffset) || textOffset < 0) throw new Error('session: invalid text_offset');
  if (args.text_offset !== undefined && (args.offset === undefined || limit !== 1 || !args.item_id)) {
    throw new Error('session: text_offset requires offset, limit:1 and item_id from read');
  }
  return { sessionId, limit, offset, textOffset };
}
