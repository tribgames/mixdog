// Scripted LSP server for the lone-surrogate wire recording: Content-Length framed JSON-RPC on stdio. It offers rename,
// workspace symbols and one command, and answers every request with the params it received, as its JSON parser read them
// (`received`), so the recording shows what reached the server.
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
};
function handle({ id, method, params }) {
  if (method === 'initialize') {
    return send({
      id,
      result: {
        capabilities: { textDocumentSync: 1, renameProvider: true, workspaceSymbolProvider: true, executeCommandProvider: { commands: ['stub.run'] } },
        serverInfo: { name: 'echo-stub', version: '0.0.0' },
      },
    });
  }
  if (method === 'exit') return process.exit(0);
  if (id === undefined) return undefined;
  if (method === 'shutdown') return send({ id, result: null });
  return send({ id, result: { received: params } });
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString('ascii'))?.[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
    buffer = buffer.subarray(end + 4 + length);
    handle(message);
  }
});
