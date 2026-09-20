// Browser Use and Computer Use: the environment kill switch, the once-per-
// session first-use approval, then the bridge client.
import { executeBrowserTool } from '../../runtime/browser-bridge/client.mjs';
import { executeComputerTool } from '../../runtime/computer-bridge/client.mjs';
import { createBridgeFirstUseGate } from '../bridge-first-use-gate.mjs';
import { featureEnvOverride } from '../config-helpers.mjs';

export function createBridgeToolHandlers({ rt }) {
  const bridgeFirstUseGate = createBridgeFirstUseGate({ getConfig: () => rt.config });
  const sessionIdFor = (callerCtx) => callerCtx?.sessionId || callerCtx?.callerSessionId || rt.session?.id;
  const signalFor = (callerCtx) => callerCtx?.signal || rt.session?.controller?.signal || null;

  // Browser Use and Computer Use ask the user once per session before their
  // first live call; the answer is the tool result when it is no.
  const firstUseDenial = async (name, args, callerCtx, callerCwd) => {
    const denial = await bridgeFirstUseGate({
      name,
      args,
      cwd: callerCwd,
      sessionId: sessionIdFor(callerCtx),
      toolCallId: callerCtx?.toolCallId || null,
      toolApprovalHook: callerCtx?.toolApprovalHook,
      invocationSource: callerCtx?.invocationSource,
    });
    return denial ? { content: [{ type: 'text', text: denial }], isError: true } : null;
  };

  const environmentDisabled = (callerCtx, feature) =>
    callerCtx?.invocationSource === 'model-tool' && featureEnvOverride(feature) === false;

  // `browser` and `browser_devtools` are one bridge; the tool name only
  // scopes which actions the validator admits.
  const browser = async (args, { name, callerCtx, callerCwd }) => {
    if (environmentDisabled(callerCtx, 'MIXDOG_FEATURE_BROWSER')) {
      throw new Error('the browser tool is disabled in this environment');
    }
    const denied = await firstUseDenial(name, args, callerCtx, callerCwd);
    if (denied) return denied;
    return await executeBrowserTool(args, {
      tool: name,
      sessionId: sessionIdFor(callerCtx),
      turnId: callerCtx?.turnId || rt.session?.usageMetricsTurnId,
      signal: signalFor(callerCtx),
    });
  };

  const computer = async (args, { name, callerCtx, callerCwd }) => {
    if (environmentDisabled(callerCtx, 'MIXDOG_FEATURE_COMPUTER')) {
      throw new Error('the computer tool is disabled in this environment');
    }
    const denied = await firstUseDenial(name, args, callerCtx, callerCwd);
    if (denied) return denied;
    return await executeComputerTool(args, {
      sessionId: sessionIdFor(callerCtx),
      cwd: callerCwd,
      requestApproval: callerCtx?.toolApprovalHook,
      toolCallId: callerCtx?.toolCallId || null,
      signal: signalFor(callerCtx),
    });
  };

  return { browser, browser_devtools: browser, computer };
}
