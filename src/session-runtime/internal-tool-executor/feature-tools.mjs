// Optional feature tools: office, media and tidy (each loaded on first use;
// their settings gates apply in the executor), and the setup tool.
import { standaloneDataDir } from '../runtime-paths.mjs';
import { createCallerContextResolvers } from './caller-context.mjs';

export function createFeatureToolHandlers({ rt, setupTool }) {
  const { sessionIdFor, signalFor } = createCallerContextResolvers(rt);

  return {
    office: async (args, { callerCtx, callerCwd }) => {
      const { executeOfficeTool } = await import('../../runtime/office/index.mjs');
      return await executeOfficeTool(args, {
        cwd: callerCwd,
        dataDir: standaloneDataDir(),
        requestApproval: callerCtx?.toolApprovalHook,
        sessionId: callerCtx?.sessionId,
        toolCallId: callerCtx?.toolCallId,
        signal: signalFor(callerCtx),
      });
    },
    media: async (args, { callerCtx, callerCwd }) => {
      const { executeMediaTool } = await import('../../runtime/media/tool.mjs');
      const { getSession } = await import('../../runtime/agent/orchestrator/session/manager/session-crud.mjs');
      // Generation spend is attributed to the calling session in the usage ledger.
      const sessionId = sessionIdFor(callerCtx) || '';
      return await executeMediaTool(args, {
        cwd: callerCwd,
        signal: signalFor(callerCtx),
        sessionId,
        sourceType: (sessionId && getSession(sessionId)?.sourceType) || '',
      });
    },
    tidy: async (args, { callerCtx, callerCwd }) => {
      const { executeTidyTool } = await import('../../runtime/tidy/tool.mjs');
      return await executeTidyTool(args, {
        cwd: callerCwd,
        sessionId: sessionIdFor(callerCtx),
        signal: signalFor(callerCtx),
      });
    },
    setup: async (args, { callerCtx }) =>
      await setupTool.execute(args || {}, {
        signal: signalFor(callerCtx),
        callerSessionId: callerCtx?.callerSessionId || null,
        requestApproval: callerCtx?.toolApprovalHook || null,
        toolCallId: callerCtx?.toolCallId || null,
      }),
  };
}
