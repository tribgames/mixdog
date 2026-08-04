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

connection.onRequest('initialize', () => ({
  capabilities: {
    completionProvider: {
      resolveProvider: true,
      triggerCharacters: ['.'],
    },
    signatureHelpProvider: {
      triggerCharacters: ['('],
      retriggerCharacters: [','],
    },
    hoverProvider: true,
    declarationProvider: true,
    definitionProvider: true,
    typeDefinitionProvider: true,
    implementationProvider: true,
    referencesProvider: true,
    documentHighlightProvider: true,
    linkedEditingRangeProvider: true,
    documentSymbolProvider: true,
    codeLensProvider: { resolveProvider: true },
    renameProvider: { prepareProvider: true },
    codeActionProvider: {
      resolveProvider: true,
      codeActionKinds: ['quickfix', 'refactor', 'source.organizeImports'],
    },
    documentFormattingProvider: false,
    documentRangeFormattingProvider: true,
    documentOnTypeFormattingProvider: {
      firstTriggerCharacter: '}',
      moreTriggerCharacter: [';'],
    },
    documentLinkProvider: { resolveProvider: true },
    colorProvider: true,
    foldingRangeProvider: true,
    selectionRangeProvider: true,
    semanticTokensProvider: {
      legend: {
        tokenTypes: ['function', 'variable'],
        tokenModifiers: ['declaration'],
      },
      range: true,
      full: { delta: true },
    },
    inlayHintProvider: { resolveProvider: true },
    callHierarchyProvider: true,
    executeCommandProvider: { commands: ['mock.apply'] },
  },
}));
connection.onRequest('textDocument/completion', () => [{
  label: 'main',
  kind: 3,
  detail: 'mock completion',
}]);
connection.onRequest('textDocument/signatureHelp', () => ({
  signatures: [{
    label: 'main(value: string)',
    documentation: 'Mock signature',
    parameters: [{ label: [5, 18], documentation: 'value parameter' }],
  }],
  activeSignature: 0,
  activeParameter: 0,
}));
connection.onRequest('completionItem/resolve', (item) => ({
  ...item,
  documentation: 'Resolved completion',
}));
connection.onRequest('textDocument/hover', () => ({
  contents: { kind: 'markdown', value: '**mock hover**' },
  range,
}));
connection.onRequest('textDocument/definition', (params) => [{
  uri: params.textDocument.uri,
  range,
}]);
connection.onRequest('textDocument/declaration', (params) => [{
  uri: params.textDocument.uri,
  range,
}]);
connection.onRequest('textDocument/references', (params) => [{
  uri: params.textDocument.uri,
  range,
}]);
connection.onRequest('textDocument/documentHighlight', () => [{
  range,
  kind: 2,
}]);
connection.onRequest('textDocument/linkedEditingRange', () => ({
  ranges: [range],
  wordPattern: '[A-Za-z_]+',
}));
connection.onRequest('textDocument/documentSymbol', () => [{
  name: 'main',
  kind: 12,
  range,
  selectionRange: range,
}]);
connection.onRequest('textDocument/codeLens', () => [{
  range,
  data: { id: 1 },
}]);
connection.onRequest('codeLens/resolve', (lens) => ({
  ...lens,
  command: { title: 'Run mock lens', command: 'mock.apply', arguments: [1] },
}));
connection.onRequest('textDocument/typeDefinition', (params) => [{
  uri: params.textDocument.uri,
  range,
}]);
connection.onRequest('textDocument/implementation', (params) => [{
  uri: params.textDocument.uri,
  range,
}]);
connection.onRequest('textDocument/prepareCallHierarchy', (params) => [{
  name: 'main',
  kind: 12,
  uri: params.textDocument.uri,
  range,
  selectionRange: range,
}]);
connection.onRequest('callHierarchy/incomingCalls', (params) => [{
  from: params.item,
  fromRanges: [range],
}]);
connection.onRequest('callHierarchy/outgoingCalls', (params) => [{
  to: params.item,
  fromRanges: [range],
}]);
connection.onRequest('textDocument/prepareRename', () => ({
  range,
  placeholder: 'main',
}));
connection.onRequest('textDocument/rename', (params) => ({
  changes: {
    [params.textDocument.uri]: [{ range, newText: params.newName }],
  },
}));
connection.onRequest('textDocument/codeAction', () => [{
  title: 'Mock quick fix',
  kind: 'quickfix',
  data: { id: 1 },
}]);
connection.onRequest('codeAction/resolve', (action) => ({
  ...action,
  edit: {
    changes: {
      'file:///main.py': [{ range, newText: 'fixed' }],
    },
  },
}));
connection.onRequest('textDocument/rangeFormatting', () => [{
  range,
  newText: 'formatted',
}]);
connection.onRequest('textDocument/onTypeFormatting', () => [{
  range,
  newText: 'typed',
}]);
connection.onRequest('textDocument/documentLink', () => [{
  range,
  data: { id: 1 },
}]);
connection.onRequest('documentLink/resolve', (link) => ({
  ...link,
  target: 'https://example.test/',
  tooltip: 'Mock link',
}));
connection.onRequest('textDocument/documentColor', () => [{
  range,
  color: { red: 1, green: 0, blue: 0, alpha: 1 },
}]);
connection.onRequest('textDocument/colorPresentation', () => [{
  label: '#ff0000',
  textEdit: { range, newText: '#ff0000' },
}]);
connection.onRequest('textDocument/foldingRange', () => [{
  startLine: 0,
  endLine: 1,
  kind: 'region',
}]);
connection.onRequest('textDocument/selectionRange', () => [{
  range,
  parent: {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 1, character: 0 },
    },
  },
}]);
connection.onRequest('textDocument/semanticTokens/full', () => ({
  resultId: 'tokens-1',
  data: [0, 0, 4, 0, 1],
}));
connection.onRequest('textDocument/semanticTokens/full/delta', () => ({
  resultId: 'tokens-2',
  edits: [{ start: 4, deleteCount: 1, data: [0] }],
}));
connection.onRequest('textDocument/semanticTokens/range', () => ({
  data: [0, 0, 4, 0, 1],
}));
connection.onRequest('textDocument/inlayHint', () => [{
  position: { line: 0, character: 4 },
  label: ': string',
  kind: 1,
  data: { id: 1 },
}]);
connection.onRequest('inlayHint/resolve', (hint) => ({
  ...hint,
  tooltip: 'Resolved inlay hint',
}));
connection.onRequest('workspace/executeCommand', (params) => params);
connection.onRequest('shutdown', () => null);
connection.onNotification('exit', () => {
  connection.dispose();
  setImmediate(() => process.exit(0));
});
connection.listen();
