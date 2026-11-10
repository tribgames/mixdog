// The one normalisation of `history/tool-failures.jsonl` rows, used by the recorder (on Node's file) and by the replay (on the
// core's): only the values that two recordings of the same input showed to differ on their own are replaced, each by what it is.
//   - `session_id`: by the scenario whose session it is (`<session:N>`, N the scenario's index), never by position;
//   - `ts`: an integer epoch millisecond, `<ts>`;
//   - `tool_ms`: a non-negative integer as JavaScript prints it (`"tool_ms":<digits>`), `<ms>`;
//   - the run's workspace folder, in every form a row writes it (as is, `/`-separated, JSON-escaped), `<WS>`.
// The text must be a whole file: every row a line, the last one ended by a newline.

/** The workspace path, in the forms a row writes it, replaced by `<WS>`. */
export function maskWorkspace(text, workspace) {
  const forms = [...new Set([workspace, workspace.replaceAll('\\', '/')].flatMap((w) => [w.replaceAll('\\', '\\\\'), w]))];
  let masked = text;
  for (const form of forms) masked = masked.replaceAll(form, '<WS>');
  return masked;
}

/**
 * The rows of `text` normalised, grouped by scenario: `sessions[i]` is scenario i's session id. A row of a session no scenario has
 * fails, and so does a row that is not after every row of the scenarios before its own (the file is one sequence in scenario order).
 */
export function rowsByScenario(text, sessions, workspace) {
  if (text !== '' && !text.endsWith('\n')) throw new Error('the file does not end with a newline');
  const groups = sessions.map(() => []);
  let at = 0;
  for (const line of text === '' ? [] : text.slice(0, -1).split('\n')) {
    const row = JSON.parse(line);
    const index = sessions.indexOf(row.session_id);
    if (index < 0) throw new Error(`a row of session ${row.session_id}, which no scenario has: ${line}`);
    if (index < at) throw new Error(`a row of scenario ${index} after the rows of scenario ${at}: ${line}`);
    at = index;
    if (!Number.isInteger(row.ts)) throw new Error(`ts is not an integer: ${line}`);
    if (!Number.isInteger(row.tool_ms) || row.tool_ms < 0) throw new Error(`tool_ms is not a non-negative integer: ${line}`);
    const replaced = [
      [`"ts":${row.ts},`, '"ts":"<ts>",'],
      [`"session_id":${JSON.stringify(row.session_id)},`, `"session_id":"<session:${index}>",`],
      [`"tool_ms":${row.tool_ms},`, '"tool_ms":"<ms>",'],
    ].reduce((out, [from, to]) => {
      if (out.split(from).length !== 2) throw new Error(`${from} is not written once, as JavaScript writes it, in ${line}`);
      return out.replace(from, to);
    }, line);
    groups[index].push(maskWorkspace(replaced, workspace));
  }
  return groups;
}
