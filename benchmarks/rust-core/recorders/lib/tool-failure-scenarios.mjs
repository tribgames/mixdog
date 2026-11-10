// The scripted turns of the tool-failure recording (record-tool-failures.mjs) and its replay on the Rust core
// (replay-tool-failures.mjs): one definition, so both sides are given the same model replies and the same workspace.
//
// A reply is what the model says in one request: `calls` are its tool calls (`args` an object, or `raw` for a
// call whose argument text is not JSON); a reply without calls ends the turn. `hook` / `approval` are how the
// session is made to refuse a call, `abortWhenFile` ends the turn once the tool has created that file in the
// workspace.
export const MODEL = 'fake-model';
export const FILES = {
  'a.txt': 'hello\nsecond line\n',
};

const DONE = { text: 'done', calls: [] };

/** Long enough that a 300-unit cut lands inside the emoji that follows `n` units of 'é'. */
function boundaryName(workspace, prefix, cutAt) {
  const lead = prefix + workspace.length + 1;
  return `${'é'.repeat(cutAt - lead - 1)}😀${'x'.repeat(30)}-token=abc123`;
}

export function scenarios(workspace) {
  return [
    {
      name: 'tool errors, refusals and redaction in one batch',
      replies: [
        {
          text: 'go',
          calls: [
            { id: 'c1', name: 'read', args: {} },
            { id: 'c2', name: 'read', args: { path: 'missing.txt' } },
            { id: 'c3', name: 'edit', args: { file_path: 'nofile-token=abc123.txt', old_string: 'a', new_string: 'b' } },
            { id: 'c4', name: 'edit', args: { file_path: 'a.txt', old_string: 'nope', new_string: 'x' } },
            { id: 'c7', name: 'read', args: { path: 'a.txt', offset: 'x' } },
            { id: 'c8', name: 'task', args: { action: 'bogus' } },
            { id: 'c9', name: 'shell', args: { command: 'node -e "process.exit(3)"' } },
            { id: 'c10', name: 'frobnicate', args: {} },
          ],
        },
        {
          text: 'again',
          calls: [
            { id: 'd1', name: 'edit', args: { file_path: boundaryName(workspace, 'Error: cannot read '.length, 300), old_string: 'a', new_string: 'b' } },
            { id: 'd2', name: 'edit', args: { file_path: 'z'.repeat(1500), old_string: 'a', new_string: 'b' } },
          ],
        },
        DONE,
      ],
    },
    {
      name: 'a call whose arguments are not JSON',
      replies: [{ text: 'go', calls: [{ id: 'm1', name: 'read', raw: '{"path":' }] }, DONE],
    },
    {
      name: 'a shell command that outlives its timeout',
      replies: [{ text: 'go', calls: [{ id: 't1', name: 'shell', args: { command: 'node -e "setTimeout(()=>{},20000)"', timeout_ms: 1000 } }] }, DONE],
    },
    {
      name: 'a call refused by a hook',
      hook: { action: 'deny', reason: 'blocked by test hook' },
      replies: [{ text: 'go', calls: [{ id: 'h1', name: 'read', args: { path: 'a.txt' } }] }, DONE],
    },
    {
      name: 'a call whose approval is denied',
      hook: { action: 'ask', reason: 'needs approval' },
      approval: { approved: false, reason: 'no thanks' },
      replies: [{ text: 'go', calls: [{ id: 'p1', name: 'read', args: { path: 'a.txt' } }] }, DONE],
    },
    {
      name: 'a turn ended while its shell command runs',
      abortWhenFile: 'started.flag',
      replies: [
        { text: 'go', calls: [{ id: 'a1', name: 'shell', args: { command: 'node -e "require(\'fs\').writeFileSync(\'started.flag\',\'1\');setTimeout(()=>{},20000)"' } }] },
        DONE,
      ],
    },
  ];
}
