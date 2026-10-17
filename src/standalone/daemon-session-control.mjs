import { SESSION_ID_PATTERN } from '../runtime/agent/orchestrator/runtime-core/session-id.mjs';
import { sessionListOutput, sessionReadOutput, SESSION_TOOL_OUTPUT_BYTES } from './session-tool-output.mjs';

const TARGET_ACTIONS = new Set(['status', 'read', 'send', 'cancel', 'delete']);
const MUTATING_ACTIONS = new Set(['send', 'cancel', 'delete']);

/** Model-facing session operations over the same service used by desktop and TUI. */
export function createSessionControl({ getSessionService }) {
  return async function executeSessionControl(args = {}, context = {}) {
    const action = args.action;
    if (action !== 'list' && !TARGET_ACTIONS.has(action)) {
      throw new Error(`session: unsupported remote action "${action}"`);
    }
    const caller = context.callerSessionId;
    if (typeof caller !== 'string' || !SESSION_ID_PATTERN.test(caller)) {
      throw new Error('session: caller session is required');
    }
    const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
    if (TARGET_ACTIONS.has(action) && (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId))) {
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
    const service = getSessionService();
    if (!service) throw new Error('session: session service is unavailable');
    if (action === 'list') {
      const page = await service.listSessionCatalog({ page: { limit, cursor: args.cursor || null } });
      return sessionListOutput(page, limit);
    }
    if (action === 'send') {
      if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
        throw new Error('session: prompt is required for action=send');
      }
      const result = await service.submitSession({
        sessionId,
        prompt: args.prompt,
        options: { mode: 'prompt', transcriptMeta: { sender: 'lead' } },
      });
      return { sessionId, accepted: result.accepted === true };
    }
    if (action === 'cancel') {
      const result = await service.abortSession({ sessionId });
      return { sessionId, aborted: result.aborted === true };
    }
    if (action === 'delete') {
      const result = await service.configureSession(
        { sessionId, action: 'deleteSession', args: [sessionId] },
        { revision: 1 }
      );
      return { sessionId, deleted: result.value === true };
    }
    if (action === 'read') {
      const result = await service.readSession({ sessionId, transcriptRange: { offset, limit } });
      return sessionReadOutput(sessionId, result.range, { textOffset, itemId: args.item_id });
    }
    const result = await service.readSession({
      sessionId,
      transcriptItemLimit: action === 'status' ? 1 : limit,
      transcriptByteBudget: SESSION_TOOL_OUTPUT_BYTES,
    });
    const snapshot = result.full;
    if (!snapshot) throw new Error(`session: ${sessionId} is unavailable`);
    const status = {
      sessionId,
      title: snapshot.title ?? null,
      cwd: snapshot.cwd ?? null,
      provider: snapshot.provider ?? null,
      model: snapshot.model ?? null,
      busy: snapshot.busy === true,
      quotaResume: snapshot.quotaResume ?? null,
    };
    return status;
  };
}
