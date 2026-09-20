// Optional feature tools gated by settings for model-initiated calls: office
// (lazy-loaded), media, tidy, and the setup tool.
import { executeMediaTool } from '../../runtime/media/tool.mjs';
import { executeTidyTool } from '../../runtime/tidy/tool.mjs';
import { STANDALONE_DATA_DIR } from '../runtime-paths.mjs';

export function createFeatureToolHandlers({ rt, setupTool, officeToolsEnabled, mediaToolEnabled, tidyToolEnabled }) {
  const signalFor = (callerCtx) => callerCtx?.signal || rt.session?.controller?.signal || null;
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
        dataDir: STANDALONE_DATA_DIR,
        requestApproval: callerCtx?.toolApprovalHook,
        sessionId: callerCtx?.sessionId,
        toolCallId: callerCtx?.toolCallId,
        signal: signalFor(callerCtx),
      });
    },
    media: async (args, { callerCtx, callerCwd }) => {
      requireEnabled(callerCtx, mediaToolEnabled, 'media');
      return await executeMediaTool(args, { cwd: callerCwd, signal: signalFor(callerCtx) });
    },
    tidy: async (args, { callerCtx, callerCwd }) => {
      requireEnabled(callerCtx, tidyToolEnabled, 'tidy');
      return await executeTidyTool(args, {
        cwd: callerCwd,
        sessionId: callerCtx?.sessionId || callerCtx?.callerSessionId || rt.session?.id,
        signal: signalFor(callerCtx),
      });
    },
    setup: async (args, { callerCtx }) => await setupTool.execute(args || {}, { signal: signalFor(callerCtx) }),
  };
}
