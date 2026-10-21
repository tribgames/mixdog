// Optional feature tools gated by settings for model-initiated calls: office,
// media and tidy (each loaded on first use), and the setup tool.
import { standaloneDataDir } from '../runtime-paths.mjs';
import { createCallerContextResolvers } from './caller-context.mjs';

export function createFeatureToolHandlers({ rt, setupTool, officeToolsEnabled, mediaToolEnabled, tidyToolEnabled }) {
  const { sessionIdFor, signalFor } = createCallerContextResolvers(rt);
  const requireEnabled = (callerCtx, enabled, label) => {
    if (callerCtx?.invocationSource === 'model-tool' && !enabled()) {
      throw new Error(`${label} is disabled in settings; start a new session to refresh the tool list`);
    }
  };

  return {
    office: async (args, { callerCtx, callerCwd }) => {
      requireEnabled(callerCtx, officeToolsEnabled, 'office');
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
      requireEnabled(callerCtx, mediaToolEnabled, 'media');
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
      requireEnabled(callerCtx, tidyToolEnabled, 'tidy');
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
      }),
  };
}
