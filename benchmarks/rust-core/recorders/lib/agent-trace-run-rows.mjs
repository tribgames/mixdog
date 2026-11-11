// The one normalisation of a run's `history/agent-trace.jsonl` rows, used by the recorder (on Node's file) and by the replay (on
// the core's). Only the rows the tool batch writes are taken (`kind` batch, tool, tool_slow: `recordToolBatch` and `traceAgentTool`,
// session/loop/tool-phase.mjs:46 and session/tool-batch/finalize.mjs:226); the other kinds of the file are written by other call sites
// (`context`: the request's context accounting; `usage`: the usage log) and are counted per kind, not compared. Replaced, each by
// what it is (the values two recordings of one input differ on by themselves):
//   - `session_id`: `<session:N>`, N the scenario whose session it is, never by position;
//   - `ts`, and each `execution_intervals` mark: an integer epoch millisecond, `<ts>`;
//   - a batch id (`payload.batch_id` of a batch row, `payload.batch.batch_id` of a tool row): a v4 UUID, `<batch:K>`, K the order
//     of its batch row in the scenario;
//   - `tool_ms` and every `payload.timing` value: a non-negative integer, `<ms>`;
//   - each `local_search` value named `*_ms` (a duration the search took or waited): a non-negative number, `<ms>`;
//   - the workspace folder, in every form a text writes it, `<WS>` (lib/tool-failure-rows.mjs maskWorkspace).
// A row must be the line JavaScript writes for it, and the text a whole file (every row a line ended by a newline).
import { maskWorkspace } from './tool-failure-rows.mjs';

export const TRACED_KINDS = ['batch', 'tool', 'tool_slow'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ms = (v, line) => {
  if (!Number.isInteger(v) || v < 0) throw new Error(`not a non-negative integer (${v}): ${line}`);
  return '<ms>';
};
// `local_search` durations (`addNumber`, local-search-telemetry.mjs): a non-negative number kept to one decimal.
const searchMs = (v, line) => {
  if (typeof v !== 'number' || !(v >= 0) || Math.round(v * 10) / 10 !== v) throw new Error(`not a non-negative tenth of a ms (${v}): ${line}`);
  return '<ms>';
};
const epoch = (v, line) => {
  if (!Number.isInteger(v)) throw new Error(`not an integer epoch (${v}): ${line}`);
  return '<ts>';
};

function maskStrings(value, mask) {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map((v) => maskStrings(v, mask));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskStrings(v, mask)]));
  return value;
}

/**
 * `{ rows, others }` per scenario: `rows` the traced rows normalised (JSON lines, file order), `others` the count of each other kind.
 * `sessions[i]` is scenario i's session id; a row of no scenario's session fails, as does a row before the rows of an earlier scenario.
 */
export function traceRowsByScenario(text, sessions, workspace) {
  if (text !== '' && !text.endsWith('\n')) throw new Error('the file does not end with a newline');
  const groups = sessions.map(() => ({ rows: [], others: {}, batches: [] }));
  let at = 0;
  for (const line of text === '' ? [] : text.slice(0, -1).split('\n')) {
    const row = JSON.parse(line);
    if (JSON.stringify(row) !== line) throw new Error(`the row is not the line JavaScript writes for it: ${line}`);
    const index = typeof row.session_id === 'string' ? sessions.indexOf(row.session_id) : -1;
    if (index < 0) throw new Error(`a row of session ${JSON.stringify(row.session_id)}, which no scenario has: ${line}`);
    if (index < at) throw new Error(`a row of scenario ${index} after the rows of scenario ${at}: ${line}`);
    at = index;
    const group = groups[index];
    if (!TRACED_KINDS.includes(row.kind)) {
      group.others[row.kind] = (group.others[row.kind] ?? 0) + 1;
      continue;
    }
    const batchName = (id) => {
      if (typeof id !== 'string' || !UUID.test(id)) throw new Error(`a batch id that is not a v4 UUID (${id}): ${line}`);
      if (row.kind === 'batch') {
        if (group.batches.includes(id)) throw new Error(`a batch id written twice: ${line}`);
        group.batches.push(id);
      }
      const k = group.batches.indexOf(id);
      if (k < 0) throw new Error(`a tool row of a batch with no batch row before it: ${line}`);
      return `<batch:${k}>`;
    };
    const out = { ...row, ts: epoch(row.ts, line), session_id: `<session:${index}>` };
    if (row.kind === 'batch' && row.payload?.batch_id !== undefined) out.payload = { ...row.payload, batch_id: batchName(row.payload.batch_id) };
    if (row.kind === 'tool' || row.kind === 'tool_slow') {
      out.tool_ms = ms(row.tool_ms, line);
      if (row.local_search) {
        out.local_search = Object.fromEntries(Object.entries(row.local_search).map(([k, v]) => [k, k.endsWith('_ms') ? searchMs(v, line) : v]));
      }
      const payload = { ...row.payload };
      if (payload.timing) payload.timing = Object.fromEntries(Object.entries(payload.timing).map(([k, v]) => [k, ms(v, line)]));
      if (payload.batch) payload.batch = { ...payload.batch, batch_id: batchName(payload.batch.batch_id) };
      if (Array.isArray(payload.execution_intervals)) {
        payload.execution_intervals = payload.execution_intervals.map((iv) => Object.fromEntries(Object.entries(iv).map(([k, v]) => [k, epoch(v, line)])));
      }
      out.payload = payload;
    }
    group.rows.push(JSON.stringify(maskStrings(out, (s) => maskWorkspace(s, workspace))));
  }
  return groups.map(({ rows, others }) => ({ rows, others }));
}
