import { shouldPersistModelVisibleToolCompletion } from '../runtime/shared/tool-execution-contract.mjs';
import { saveModelSettings } from './model-capabilities.mjs';
import { renderToolSearch } from './tool-catalog.mjs';

export function __renderToolSearchForTest(args = {}, session = {}, mode = 'full', options = {}) {
  return renderToolSearch(args, session, mode, options);
}

export function __saveModelSettingsForTest(cfgMod, route, options = {}) {
  return saveModelSettings(cfgMod, route, options);
}

export function shouldMirrorCompletionToPendingQueue({
  callerSessionId,
  modelVisibleDelivered,
  hasEnqueue,
  text,
  meta = {},
} = {}) {
  if (!callerSessionId || !hasEnqueue || modelVisibleDelivered) return false;
  return shouldPersistModelVisibleToolCompletion(text, meta);
}

export async function dispatchWebSearchRuntimeTool(name, args, callerCtx = {}, {
  getWebSearchModule,
  getCurrentCwd,
  getSession,
  notifyFnForSession,
  runNativeWebSearch,
} = {}) {
  const currentSession = typeof getSession === 'function' ? getSession() : null;
  const callerCwd = callerCtx?.callerCwd || (typeof getCurrentCwd === 'function' ? getCurrentCwd() : process.cwd());
  const callerSessionId = callerCtx?.callerSessionId || currentSession?.id || null;
  const callerSignal = callerCtx?.signal || currentSession?.controller?.signal;
  const webSearchMod = await getWebSearchModule();
  if (!webSearchMod?.handleToolCall) throw new Error('web search runtime is not available');
  return await webSearchMod.handleToolCall(name, args || {}, {
    callerCwd,
    callerSessionId,
    routingSessionId: callerSessionId,
    clientHostPid: callerCtx?.clientHostPid || currentSession?.clientHostPid || process.pid,
    notifyFn: notifyFnForSession(callerSessionId),
    signal: callerSignal,
    nativeWebSearch: name === 'web_search'
      ? async (webSearchArgs) => runNativeWebSearch(webSearchArgs, { signal: callerSignal })
      : undefined,
  });
}

export function memoryToolArgsForCaller(args, callerCwd) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  return typeof input.cwd === 'string' && input.cwd.trim()
    ? input
    : { ...input, cwd: callerCwd };
}
