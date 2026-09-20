/**
 * hook-bus/event-runner.mjs — running the standard handlers of one event:
 * matcher selection with per-handler dedupe, the trust gate for project
 * hooks, dispatch by handler type, and the sequential aggregation that
 * short-circuits once a denial-capable event is blocked.
 */
import { throwIfAborted } from '../../runtime/shared/abort-race.mjs';
import {
  NO_MATCHER_EVENTS,
  SUPPORTED_HANDLER_TYPES,
  EXIT2_BLOCK_EVENTS,
  TOP_LEVEL_DECISION_EVENTS,
} from './constants.mjs';
import { matchFieldFor, matcherFires } from './config.mjs';
import {
  ifConditionPasses,
  parseHandlerOutput,
  runCommandHandler,
  runHttpHandler,
  runMcpToolHandler,
  runPromptHandler,
} from './handlers.mjs';
import { handlerDedupeKey, shellCountFor } from './rules.mjs';

// Executable/network handlers from an untrusted project hooks file are an
// RCE + exfil vector without a user-level trust opt-in.
const TRUST_GATED_TYPES = new Set(['command', 'http', 'mcp_tool']);

// A failed run is reported as a hook:error and skipped; returns the message
// or null when the run produced usable output.
function runFailure(run, handler) {
  if (run.timedOut)
    return `hook ${shellCountFor(handler)} timed out: ${handler.command || handler.url || handler.type}`;
  if (run.spawnError) return `hook spawn failed: ${run.spawnError.message || run.spawnError}`;
  if (run.exitCode && run.exitCode !== 0 && run.exitCode !== 2) {
    return (run.stderr || '').trim() || `hook exited ${run.exitCode}`;
  }
  return null;
}

function foldParsedOutput(agg, parsed) {
  if (parsed.additionalContext) agg.additionalContext.push(parsed.additionalContext);
  if (parsed.updatedInput && !agg.updatedInput) agg.updatedInput = parsed.updatedInput;
  if (parsed.updatedToolName && !agg.updatedToolName) agg.updatedToolName = parsed.updatedToolName;
  if (parsed.updatedToolOutput != null && agg.updatedToolOutput == null)
    agg.updatedToolOutput = parsed.updatedToolOutput;
  if (parsed.askReason && !agg.ask && !agg.blocked) {
    agg.ask = true;
    agg.askReason = parsed.askReason;
  }
  if (parsed.block && !agg.blocked) {
    agg.blocked = true;
    agg.reason = parsed.reason;
  }
}

export function createEventRunner({ loadConfig, emit, cursor, pluginData, promptRunner, mcpToolRunner }) {
  function selectHandlers(eventName, payload) {
    const cfg = loadConfig(payload.cwd || cursor.cwd);
    if (cfg.disabled || !cfg.standard) return [];
    const groups = cfg.events[eventName];
    if (!Array.isArray(groups)) return [];
    const field = matchFieldFor(eventName, payload);
    const handlers = [];
    const seen = new Set();
    for (const group of groups) {
      if (NO_MATCHER_EVENTS.has(eventName) || matcherFires(group.matcher, field)) {
        for (const handler of group.hooks) {
          const key = handlerDedupeKey(handler);
          if (seen.has(key)) continue;
          seen.add(key);
          handlers.push(handler);
        }
      }
    }
    return handlers;
  }

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

  async function runOneHandler(handler, eventName, payload, { signal } = {}) {
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
  }

  async function runEventHandlers(eventName, payload, { signal } = {}) {
    throwIfAborted(signal);
    const handlers = selectHandlers(eventName, payload);
    const agg = {
      blocked: false,
      reason: null,
      updatedInput: null,
      updatedToolName: null,
      updatedToolOutput: null,
      additionalContext: [],
      ask: false,
      askReason: null,
      handlersRun: handlers.length,
    };
    // Run sequentially and short-circuit once a deny lands: concurrent execution
    // let side-effect hooks fire even when an earlier hook already denied.
    // Denial-capable events must not run remaining handlers after a block.
    const shortCircuit = EXIT2_BLOCK_EVENTS.has(eventName) || TOP_LEVEL_DECISION_EVENTS.has(eventName);
    for (const handler of handlers) {
      throwIfAborted(signal);
      let run;
      try {
        run = await runOneHandler(handler, eventName, payload, { signal });
        throwIfAborted(signal);
      } catch (error) {
        throwIfAborted(signal);
        emit('hook:error', { name: payload.tool_name || eventName, error: error?.message || String(error) });
        continue;
      }
      if (!run) continue;
      const failure = runFailure(run, handler);
      if (failure) {
        emit('hook:error', { name: payload.tool_name || eventName, error: failure });
        continue;
      }
      foldParsedOutput(agg, parseHandlerOutput(run, eventName));
      if (agg.blocked && shortCircuit) break;
    }
    return agg;
  }

  return { runEventHandlers };
}
