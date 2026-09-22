/**
 * hook-bus/event-runner.mjs — running the standard handlers of one event:
 * matcher selection with per-handler dedupe, and the sequential aggregation
 * that short-circuits once a denial-capable event is blocked. Running a single
 * handler (trust gate, type dispatch) lives in ./handler-dispatch.mjs.
 */
import { throwIfAborted } from '../../runtime/shared/abort-race.mjs';
import { NO_MATCHER_EVENTS, EXIT2_BLOCK_EVENTS, TOP_LEVEL_DECISION_EVENTS } from './constants.mjs';
import { matchFieldFor, matcherFires } from './config.mjs';
import { parseHandlerOutput } from './handlers.mjs';
import { createHandlerDispatch } from './handler-dispatch.mjs';
import { handlerDedupeKey, shellCountFor } from './rules.mjs';

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

  const runOneHandler = createHandlerDispatch({ emit, pluginData, promptRunner, mcpToolRunner });

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
