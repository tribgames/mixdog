/**
 * hook-bus/handler-dispatch.mjs — running ONE handler of an event: the `if`
 * condition, the supported-type check, the trust gate for project hooks, and
 * dispatch to the runner for its type. Selecting an event's handlers and
 * aggregating their results stays in ./event-runner.mjs.
 */
import { throwIfAborted } from '../../runtime/shared/abort-race.mjs';
import { SUPPORTED_HANDLER_TYPES } from './constants.mjs';
import {
  ifConditionPasses,
  runCommandHandler,
  runHttpHandler,
  runMcpToolHandler,
  runPromptHandler,
} from './handlers.mjs';

// Executable/network handlers from an untrusted project hooks file are an
// RCE + exfil vector without a user-level trust opt-in.
const TRUST_GATED_TYPES = new Set(['command', 'http', 'mcp_tool']);

export function createHandlerDispatch({ emit, pluginData, promptRunner, mcpToolRunner }) {
  const runners = {
    command(handler, payload, eventName, { signal }) {
      if (!handler.command) return null;
      const reportSpawnError = (error) => {
        emit('hook:error', {
          name: payload.tool_name || eventName,
          error: `hook spawn failed: ${error?.message || error}`,
        });
      };
      return runCommandHandler(handler, payload, eventName, pluginData, reportSpawnError, { signal });
    },
    http(handler, payload, eventName, { signal }) {
      if (!handler.url) return null;
      return runHttpHandler(handler, payload, eventName, { signal });
    },
    mcp_tool(handler, payload, eventName, { signal }) {
      if (typeof mcpToolRunner !== 'function') {
        emit('hook:error', { name: payload.tool_name || eventName, error: 'handler type mcp_tool not configured' });
        return null;
      }
      return runMcpToolHandler(handler, payload, eventName, mcpToolRunner, { signal });
    },
    prompt(handler, payload, eventName, { signal }) {
      if (typeof promptRunner !== 'function') {
        emit('hook:error', { name: payload.tool_name || eventName, error: 'handler type prompt not configured' });
        return null;
      }
      return runPromptHandler(handler, payload, eventName, promptRunner, { signal });
    },
  };

  return async function runOneHandler(handler, eventName, payload, { signal } = {}) {
    throwIfAborted(signal);
    if (!handler || typeof handler !== 'object') return null;
    if (!ifConditionPasses(handler.if, eventName, payload.tool_name, payload.tool_input)) return null;
    const type = String(handler.type || '').trim();
    if (!SUPPORTED_HANDLER_TYPES.has(type)) {
      emit('hook:error', {
        name: payload.tool_name || eventName,
        error: `unsupported hook type: ${type || '(missing)'}`,
      });
      return null;
    }
    if (handler._untrusted === true && TRUST_GATED_TYPES.has(type)) {
      emit('hook:error', {
        name: payload.tool_name || eventName,
        error: `blocked ${type} hook from untrusted project (add project to trustedProjects to enable)`,
      });
      return null;
    }
    const runner = runners[type];
    return runner ? await runner(handler, payload, eventName, { signal }) : null;
  };
}
