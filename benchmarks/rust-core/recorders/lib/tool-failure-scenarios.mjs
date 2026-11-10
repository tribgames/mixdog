// The scripted turns of the tool-failure recording (record-tool-failures.mjs) and its replay on the Rust core
// (replay-tool-failures.mjs): one definition, so both sides are given the same model replies and the same workspace.
//
// A reply is what the model says in one request: `calls` are its tool calls (`args` an object, or `raw` for a
// call whose argument text is not JSON); a reply without calls ends the turn. `hook` / `approval` are how the
// session is made to refuse a call, `abortWhenFile` ends the turn once the tool has created that file in the
// workspace.
export const MODEL = 'fake-model';
// `fx-mcp.mjs` is the stdio MCP server the `full` scenarios connect: no SDK, four tools (`fail` answers an `isError` result, `boom` a
// JSON-RPC error, `ok` a success, `big` a success whose text is `Error: ` and 100,000 more characters), so Node's client and the
// core's speak to the same bytes. `boom`'s code is an internal error
// (-32603): Node takes -32000 and -32001 for the SDK's own closed-connection and timeout codes and reconnects the server before it
// answers (`isMcpServerResponseError`, mcp/client.mjs:917-925, and the reconnect at :542-600), which the core does not do; that gap
// is reported, not recorded here.
const MCP_SERVER = `
let buffered = '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const TOOLS = ['fail', 'boom', 'ok', 'big'].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  let at;
  while ((at = buffered.indexOf('\\n')) >= 0) {
    const line = buffered.slice(0, at);
    buffered = buffered.slice(at + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fx', version: '1' } });
    else if (message.method === 'tools/list') reply({ tools: TOOLS });
    else if (message.method === 'tools/call' && message.params.name === 'fail') reply({ content: [{ type: 'text', text: 'it broke' }], isError: true });
    else if (message.method === 'tools/call' && message.params.name === 'boom') send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'server exploded' } });
    else if (message.method === 'tools/call' && message.params.name === 'big') reply({ content: [{ type: 'text', text: 'Error: ' + 'x'.repeat(100000) }] });
    else if (message.method === 'tools/call') reply({ content: [{ type: 'text', text: 'fine' }] });
    else send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no such method' } });
  }
});
`;
export const FILES = {
  'a.txt': 'hello\nsecond line\n',
  'fx-mcp.mjs': MCP_SERVER,
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
      // `full`: the whole model tool surface (skills, the delegated-agent tool, the MCP server `fx`), not the headless allowlist.
      name: 'skill, delegated-agent and MCP tool failures',
      full: true,
      replies: [
        {
          text: 'go',
          calls: [
            { id: 'k1', name: 'Skill', args: { name: 'no-such-skill' } },
            { id: 'k2', name: 'Skill', args: {} },
            { id: 'g1', name: 'agent', args: { type: 'bogus' } },
            { id: 'g2', name: 'agent', args: { type: 'read', task_id: 'task_does_not_exist' } },
            { id: 'g3', name: 'agent', args: { type: 'send' } },
          ],
        },
        DONE,
      ],
    },
    {
      // MCP tools called by their `mcp__fx__*` names: an `isError` result, a JSON-RPC error, a success.
      name: 'MCP tool failures',
      full: true,
      replies: [
        {
          text: 'go',
          calls: [
            { id: 'x1', name: 'mcp__fx__fail', args: {} },
            { id: 'x2', name: 'mcp__fx__boom', args: {} },
            { id: 'x3', name: 'mcp__fx__ok', args: {} },
          ],
        },
        DONE,
      ],
    },
    {
      name: 'a turn ended while its shell command runs',
      abortWhenFile: 'started.flag',
      replies: [
        { text: 'go', calls: [{ id: 'a1', name: 'shell', args: { command: 'node -e "require(\'fs\').writeFileSync(\'started.flag\',\'1\');setTimeout(()=>{},20000)"' } }] },
        DONE,
      ],
    },
    {
      // Calls that failed before the turn is ended, in the batch the end cancels: Node throws at the abort check after the call it was
      // taking (`processToolBatch`, tool-batch.mjs:36) before `finalizeBatchResults`, where the failure rows are written.
      name: 'a turn ended while a batch with failed calls runs',
      abortWhenFile: 'batch.flag',
      replies: [
        {
          text: 'go',
          calls: [
            { id: 'b1', name: 'read', args: {} },
            { id: 'b2', name: 'frobnicate', args: {} },
            { id: 'b3', name: 'shell', args: { command: 'node -e "require(\'fs\').writeFileSync(\'batch.flag\',\'1\');setTimeout(()=>{},20000)"' } },
          ],
        },
        DONE,
      ],
    },
    {
      // A returned `Error: …` text past the offload threshold: the call is an error by the tool's own return (execute-call.mjs:17-20),
      // and its row holds the offloaded result (finalize.mjs:238), with the artifact persisted in the profile's data folder.
      name: 'a returned error that is offloaded',
      full: true,
      replies: [{ text: 'go', calls: [{ id: 'o1', name: 'mcp__fx__big', args: {} }] }, DONE],
    },
  ];
}
