// Browser Use, Computer Use and Terminal: the environment kill switch, then the
// bridge client. None asks the user before a call.
import { executeBrowserTool } from '../../runtime/browser-bridge/client.mjs';
import { executeComputerTool } from '../../runtime/computer-bridge/client.mjs';
import { executeTerminalTool } from '../../runtime/terminal-bridge/client.mjs';
import { executeVisualizeTool } from '../../runtime/visualize-bridge/client.mjs';
import { featureEnvOverride, moduleEnabled } from '../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { createCallerContextResolvers } from './caller-context.mjs';
import { unattendedApprovalPort } from '../../runtime/agent/orchestrator/session/human-gate/unattended-port.mjs';
import { isGrantedRun } from '../../runtime/agent/orchestrator/session/human-gate/run-policy.mjs';

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
    const sessionId = sessionIdFor(callerCtx);
    const run = unattendedApprovalPort()?.runOf?.(sessionId);
    return await executeBrowserTool(args, {
      tool: name,
      sessionId,
      // A schedule/webhook run never asks for form submits, posts or uploads;
      // the bot that owns the run comes from the run's record, so its `block`
      // applies whatever the display metadata says.
      unattendedRun: isGrantedRun(run),
      unattendedAgent: run?.agentId || '',
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
      // The agent turn, as for the browser: it scopes a saved-login fill's protection.
      turnId: callerCtx?.turnId || rt.session?.usageMetricsTurnId,
      signal: signalFor(callerCtx),
    });
  };

  // `run` is gated by the exec policy; the elevation approval comes from the
  // runtime's gate (callerCtx), never from the model's args.
  const terminal = async (args, { callerCtx }) => {
    if (environmentDisabled(callerCtx, 'MIXDOG_FEATURE_TERMINAL')) {
      throw new Error('the terminal tool is disabled in this environment');
    }
    return await executeTerminalTool(args, {
      sessionId: sessionIdFor(callerCtx),
      elevationApproved: callerCtx?.elevationApproved === true,
      signal: signalFor(callerCtx),
    });
  };

  const visualize = async (args, { callerCtx, callerCwd }) => {
    if (environmentDisabled(callerCtx, 'MIXDOG_FEATURE_VISUALIZE')) {
      throw new Error('the visualize tool is disabled in this environment');
    }
    // A conversation keeps its frozen tool list, so honor the Settings toggle
    // at execution time too (an env override wins, as in builtinFeatureActive).
    if (!(featureEnvOverride('MIXDOG_FEATURE_VISUALIZE') ?? moduleEnabled(rt.config, 'visualize', true))) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: Visualize is turned off in Settings by the user. Do not turn it back on unless the user asks; give the file path instead.',
          },
        ],
        isError: true,
      };
    }
    return await executeVisualizeTool(args, {
      sessionId: sessionIdFor(callerCtx),
      callId: callerCtx?.toolCallId,
      cwd: callerCwd,
      signal: signalFor(callerCtx),
    });
  };

  return { browser, browser_devtools: browser, computer, terminal, visualize };
}
