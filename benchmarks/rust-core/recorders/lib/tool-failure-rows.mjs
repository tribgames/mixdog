// The one normalisation of `history/tool-failures.jsonl` rows, used by the recorder (on Node's file) and by the replay (on the
// core's): only the values that two recordings of the same input showed to differ on their own are replaced, each by what it is.
//   - `session_id`, and the session id wherever a text names it (an offloaded result's artifact folder): by the scenario whose
//     session it is (`<session:N>`, N the scenario's index), never by position;
//   - `ts`: an integer epoch millisecond, `<ts>`;
//   - `tool_ms`: a non-negative integer, `<ms>`;
//   - the run's workspace folder, in every form a text writes it (as is, `/`-separated, JSON-escaped), `<WS>`; both sides run in a
//     workspace path of the recorded length, so every cut of a text lands where Node's did;
//   - the profile's data folder (`getPluginData()`, the parent of an offloaded result's artifact), in the same forms, `<DATA>`. Its
//     path, and the session id after it, have no fixed length (a session id carries the process id), so a row whose texts name
//     either must hold its whole text uncut (`error_preview` of `result_bytes_est` bytes, `error_first_line` under its 300 units),
//     and its `result_bytes_est` is counted again on the masked text.
// A row must be the line JavaScript writes for it (`JSON.stringify(JSON.parse(line)) === line`): a key written twice, a number or an
// escape JavaScript writes otherwise fails. The text must be a whole file: every row a line, the last one ended by a newline.

/** `path`, in the forms a text writes it, replaced by `placeholder` (`<WS>` by default: the workspace). */
export function maskWorkspace(text, path, placeholder = '<WS>') {
  const forms = [...new Set([path, path.replaceAll('\\', '/')].flatMap((w) => [w.replaceAll('\\', '\\\\'), w]))];
  let masked = text;
  for (const form of forms) masked = masked.replaceAll(form, placeholder);
  return masked;
}

/** Every string inside `value` passed through `mask`. */
function maskStrings(value, mask) {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map((v) => maskStrings(v, mask));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskStrings(v, mask)]));
  return value;
}

const utf8 = (s) => Buffer.byteLength(s, 'utf8');

// The helper programs the Node runtime itself starts and keeps (the shell host `mixdog-spawn`, resolved at
// native-spawn-client.mjs:366-395 and kept warm by shell-warm-standby.mjs:87-100; the patch tool `mixdog-patch`,
// pristine-execution.mjs:120-150), each with its version in its image name. They are Node's machinery, not anything a tool call
// left: the Rust core has no such processes, so they and the console host each one has are set aside from Node's leftovers.
const NODE_HELPERS = [/^mixdog-spawn-\d+\.\d+\.\d+$/, /^mixdog-patch-\d+\.\d+\.\d+$/];
const isNodeHelper = (name) => NODE_HELPERS.some((pattern) => pattern.test(name ?? ''));

/**
 * What a run's job still held when its program exited (lib/job-run.mjs report), in join order, as `{ name, parent }`: the image name,
 * and its parent as `#k` (the k-th entry of this list), `<runtime>` (the program itself, or for Node one of its helpers: Node's shell
 * host starts a command where the core starts it itself), or null (any other process). Process ids are each run's own and are
 * dropped. With `nodeHelpers`, Node's own helpers and the console host whose parent is one of them are set aside (NODE_HELPERS).
 */
export function leftAtExit({ program, left }, { nodeHelpers = false } = {}) {
  const kept = nodeHelpers ? left.filter((m) => !isNodeHelper(m.name) && !(m.name === 'conhost' && isNodeHelper(m.parent))) : left;
  const parentOf = (m) => {
    const k = kept.findIndex((other) => other.pid === m.parentPid);
    if (k >= 0) return `#${k}`;
    if (m.parentPid === program || (nodeHelpers && isNodeHelper(m.parent))) return '<runtime>';
    return null;
  };
  return kept.map((m) => ({ name: m.name, parent: parentOf(m) }));
}

/**
 * The rows of `text` normalised, grouped by scenario: `sessions[i]` is scenario i's session id (a string; any other value names no
 * session). A row whose `session_id` is not one of them fails, and so does a row that is not after every row of the scenarios before
 * its own (the file is one sequence in scenario order). `dataDir` is the profile's data folder.
 */
export function rowsByScenario(text, sessions, workspace, dataDir) {
  if (text !== '' && !text.endsWith('\n')) throw new Error('the file does not end with a newline');
  const groups = sessions.map(() => []);
  let at = 0;
  for (const line of text === '' ? [] : text.slice(0, -1).split('\n')) {
    const row = JSON.parse(line);
    if (JSON.stringify(row) !== line) throw new Error(`the row is not the line JavaScript writes for it: ${line}`);
    const index = typeof row.session_id === 'string' ? sessions.indexOf(row.session_id) : -1;
    if (index < 0) throw new Error(`a row of session ${JSON.stringify(row.session_id)}, which no scenario has: ${line}`);
    if (index < at) throw new Error(`a row of scenario ${index} after the rows of scenario ${at}: ${line}`);
    at = index;
    if (!Number.isInteger(row.ts)) throw new Error(`ts is not an integer: ${line}`);
    if (!Number.isInteger(row.tool_ms) || row.tool_ms < 0) throw new Error(`tool_ms is not a non-negative integer: ${line}`);
    const session = row.session_id;
    const stable = (s) => maskWorkspace(s, workspace);
    const own = (s) => maskWorkspace(s, dataDir, '<DATA>').split(session).join(`<session:${index}>`);
    const preview = typeof row.error_preview === 'string' ? stable(row.error_preview) : null;
    const out = maskStrings({ ...row, ts: '<ts>', session_id: `<session:${index}>`, tool_ms: '<ms>' }, (s) => own(stable(s)));
    if (preview !== null && own(preview) !== preview) {
      if (utf8(row.error_preview) !== row.result_bytes_est) throw new Error(`a row naming the data folder or its session id is cut (${row.result_bytes_est} bytes, a preview of ${utf8(row.error_preview)}): ${line}`);
      if (row.error_first_line.length >= 300) throw new Error(`a row naming the data folder or its session id has a cut first line: ${line}`);
      out.result_bytes_est = row.result_bytes_est - utf8(preview) + utf8(own(preview));
    }
    groups[index].push(JSON.stringify(out));
  }
  return groups;
}
