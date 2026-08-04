import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node.js';

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 4 },
};

connection.onRequest('initialize', () => ({ capabilities: {} }));
connection.onNotification('initialized', () => {
  void (async () => {
    await connection.sendRequest('client/registerCapability', {
      registrations: [
        {
          id: 'dynamic-format',
          method: 'textDocument/formatting',
          registerOptions: { documentSelector: [{ language: 'python', scheme: 'file' }] },
        },
        {
          id: 'dynamic-wrong-language',
          method: 'textDocument/codeLens',
          registerOptions: { documentSelector: [{ language: 'typescript', scheme: 'file' }] },
        },
        {
          id: 'dynamic-wrong-pattern',
          method: 'textDocument/documentLink',
          registerOptions: {
            documentSelector: [{ language: 'python', scheme: 'file', pattern: '**/*.special.py' }],
          },
        },
        {
          id: 'dynamic-range-format',
          method: 'textDocument/rangeFormatting',
          registerOptions: { documentSelector: [{ language: 'python', scheme: 'file' }] },
        },
      ],
    });
    await connection.sendRequest('client/unregisterCapability', {
      unregisterations: [{
        id: 'dynamic-range-format',
        method: 'textDocument/rangeFormatting',
      }],
    });
  })();
});
connection.onRequest('textDocument/formatting', () => [{ range, newText: 'formatted' }]);
connection.onRequest('shutdown', () => null);
connection.onNotification('exit', () => {
  connection.dispose();
  setImmediate(() => process.exit(0));
});
connection.listen();
