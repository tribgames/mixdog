import { traceAgentBatch } from '../agent-trace.mjs';
import { randomUUID } from 'node:crypto';

// Only documented array inputs count. Keep dimensions separate: grep patterns
// and scopes, for example, are not interchangeable units of work.
const ARRAY_INPUTS = new Map([
  ['read', ['file_path', 'path']],
  ['git', ['command']],
  ['grep', ['pattern', 'path']],
  ['glob', ['pattern']],
  ['code_graph', ['files', 'symbols']],
]);

export function recordToolBatch(sessionId, calls, iteration) {
  const n = Array.isArray(calls) ? calls.length : Number(calls);
  if (!sessionId || !Number.isFinite(n) || n <= 0) return null;
  let batchId = null;
  try {
    let batchCalls = null;
    if (Array.isArray(calls)) {
      batchId = randomUUID();
      batchCalls = calls.map((call) => {
        const fields = ARRAY_INPUTS.get(call.name);
        return {
          tool_call_id: call.id ?? null,
          tool_name: call.name,
          array_lengths: fields
            ? Object.fromEntries(
                fields
                  .filter((key) => Array.isArray(call.arguments?.[key]))
                  .map((key) => [key, call.arguments[key].length])
              )
            : null,
        };
      });
    }
    traceAgentBatch({ sessionId, toolCallCount: n, batchId, batchCalls, iteration });
  } catch {
    /* telemetry must never alter tool execution */
  }
  return batchId;
}
