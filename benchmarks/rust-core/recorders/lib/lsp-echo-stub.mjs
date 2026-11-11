// Scripted LSP server for the lone-surrogate wire recording: Content-Length framed JSON-RPC on stdio. It offers rename,
// workspace symbols, code actions and their resolve, completion and its resolve, signature help, on-type formatting, inlay hints and
// their resolve, and one command, and answers every request with the params it received, as its JSON parser read them
// (`received`), so the recording shows what reached the server. Before answering, it reports the request (method and params) to the
// recording's local server (`POST /lsp`, JSON.stringify: a lone unit as its escape), which logs it among the case's requests.
import { ORIGIN } from './lone-surrogate-wire-cases.mjs';

let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
};
async function handle({ id, method, params }) {
  if (method === 'initialize') {
    return send({
      id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          renameProvider: true,
          workspaceSymbolProvider: true,
          codeActionProvider: { resolveProvider: true },
          completionProvider: { resolveProvider: true },
          signatureHelpProvider: {},
          documentOnTypeFormattingProvider: { firstTriggerCharacter: '}' },
          inlayHintProvider: { resolveProvider: true },
          executeCommandProvider: { commands: ['stub.run'] },
        },
        serverInfo: { name: 'echo-stub', version: '0.0.0' },
      },
    });
  }
  if (method === 'exit') return process.exit(0);
  if (id === undefined) return undefined;
  if (method === 'shutdown') return send({ id, result: null });
  const reported = await fetch(`${ORIGIN}/lsp`, { method: 'POST', body: JSON.stringify({ method, params }) });
  await reported.arrayBuffer();
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
    handle(message).catch((error) => {
      process.stderr.write(`lsp-echo-stub: ${error.stack}\n`);
      process.exit(1);
    });
  }
});
