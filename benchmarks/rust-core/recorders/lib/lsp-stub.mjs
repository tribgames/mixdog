// Scripted LSP server for the desktop LSP twin: speaks Content-Length framed JSON-RPC on stdio and answers with
// fixed content only (no clocks, pids or paths of its own), so the product's real client flow records identically.
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
};
const reply = (id, result) => send({ id, result });
function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      return reply(id, {
        capabilities: {
          textDocumentSync: 1,
          hoverProvider: true,
          definitionProvider: true,
          completionProvider: { triggerCharacters: ['.', ':'] },
          documentSymbolProvider: true,
        },
        serverInfo: { name: 'scripted-stub', version: '0.0.0' },
      });
    case 'textDocument/didOpen':
      return send({
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: params.textDocument.uri,
          diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, severity: 2, source: 'scripted-stub', message: 'stub diagnostic' }],
        },
      });
    case 'textDocument/hover':
      return reply(id, { contents: { kind: 'markdown', value: 'stub hover' } });
    case 'textDocument/definition':
      return reply(id, { uri: params.textDocument.uri, range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } } });
    case 'textDocument/completion':
      return reply(id, [{ label: 'stub_item', kind: 3 }]);
    case 'textDocument/documentSymbol':
      return reply(id, []);
    case 'shutdown':
      return reply(id, null);
    case 'exit':
      return process.exit(0);
    default:
      // Unknown requests get a null result; notifications (no id) are ignored.
      return id === undefined ? undefined : reply(id, null);
  }
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
