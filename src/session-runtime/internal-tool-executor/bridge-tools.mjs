// Browser Use, Computer Use and Terminal: the environment kill switch, then the
// bridge client. None asks the user before a call.
import { executeBrowserTool } from '../../runtime/browser-bridge/client.mjs';
import { executeComputerTool } from '../../runtime/computer-bridge/client.mjs';
import { executeTerminalTool } from '../../runtime/terminal-bridge/client.mjs';
import { featureEnvOverride } from '../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { createCallerContextResolvers } from './caller-context.mjs';

export function createBridgeToolHandlers({ rt }) {
  const { sessionIdFor, signalFor } = createCallerContextResolvers(rt);

  const environmentDisabled = (callerCtx, feature) =>
    callerCtx?.invocationSource === 'model-tool' && featureEnvOverride(feature) === false;

  // `browser` and `browser_devtools` are one bridge; the tool name only
  // scopes which actions the validator admits.
  const browser = async (args, { name, callerCtx }) => {
    if (environmentDisabled(callerCtx, 'MIXDOG_FEATURE_BROWSER')) {
      throw new Error('the browser tool is disabled in this environment');
    }
    return await executeBrowserTool(args, {
      tool: name,
      sessionId: sessionIdFor(callerCtx),
      turnId: callerCtx?.turnId || rt.session?.usageMetricsTurnId,
      signal: signalFor(callerCtx),
    });
  };

  const computer = async (args, { callerCtx, callerCwd }) => {
    if (environmentDisabled(callerCtx, 'MIXDOG_FEATURE_COMPUTER')) {
      throw new Error('the computer tool is disabled in this environment');
    }
    return await executeComputerTool(args, {
      sessionId: sessionIdFor(callerCtx),
      cwd: callerCwd,
      requestApproval: callerCtx?.toolApprovalHook,
      toolCallId: callerCtx?.toolCallId || null,
      signal: signalFor(callerCtx),
    });
  };

  // Read-only: no approval hook, no working directory.
  const terminal = async (args, { callerCtx }) => {
    if (environmentDisabled(callerCtx, 'MIXDOG_FEATURE_TERMINAL')) {
      throw new Error('the terminal tool is disabled in this environment');
    }
    return await executeTerminalTool(args, {
      sessionId: sessionIdFor(callerCtx),
      signal: signalFor(callerCtx),
    });
  };

  return { browser, browser_devtools: browser, computer, terminal };
}
