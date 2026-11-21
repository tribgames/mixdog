import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after } from 'node:test';

const fakeMonaco = new URL('./test-fixtures/editor-lsp-fake-monaco.mjs', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './monaco-setup' || specifier === './i18n') return next(fakeMonaco, context);
    return next(specifier, context);
  },
});
after(() => hooks.deregister());

const { registered } = await import('./test-fixtures/editor-lsp-fake-monaco.mjs');
const { graphContextsByModel } = await import('./editor-graph-context.ts');
const { registerLspCapabilityProviders } = await import('./editor-lsp-providers.ts');

const FLAGS = [
  'completion',
  'completionResolve',
  'signatureHelp',
  'hover',
  'declaration',
  'definition',
  'typeDefinition',
  'implementation',
  'references',
  'documentHighlight',
  'linkedEditingRange',
  'documentSymbol',
  'codeLens',
  'codeLensResolve',
  'rename',
  'prepareRename',
  'codeAction',
  'codeActionResolve',
  'formatting',
  'rangeFormatting',
  'onTypeFormatting',
  'documentLink',
  'documentLinkResolve',
  'documentColor',
  'foldingRange',
  'selectionRange',
  'semanticTokens',
  'semanticTokensRange',
  'semanticTokensDelta',
  'inlayHint',
  'inlayHintResolve',
  'callHierarchy',
  'workspaceSymbol',
  'executeCommand',
];
const capsWith = (value) => ({
  ...Object.fromEntries(FLAGS.map((flag) => [flag, value])),
  completionTriggerCharacters: [],
  signatureHelpTriggerCharacters: [],
  signatureHelpRetriggerCharacters: [],
  codeActionKinds: [],
  onTypeFormattingTriggerCharacters: [],
  semanticTokensLegend: { tokenTypes: ['t'], tokenModifiers: [] },
});
const capsOn = capsWith(true);
const capsOff = capsWith(false);

const URI = 'file:///m';
const model = {
  uri: { toString: () => URI },
  getWordUntilPosition: () => ({ startColumn: 1, endColumn: 2 }),
};
const position = { lineNumber: 2, column: 3 };
const range = {
  startLineNumber: 1,
  startColumn: 1,
  endLineNumber: 1,
  endColumn: 2,
};
const live = { isCancellationRequested: false };
const cancelled = { isCancellationRequested: true };
const lspRange = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 1 },
};
const location = { uri: 'file:///c:/p/a.ts', range: lspRange };
const edit = { range: lspRange, newText: 'x' };

const calls = [];
const responses = {};
const requestLsp = async (method, params) => {
  calls.push([method, params]);
  return responses[method];
};
const base = { projectPath: 'c:/p', relPath: 'a.ts' };
const contexts = {
  accept: { ...base, lspCapabilities: capsOn, requestLsp },
  noRequest: { ...base, lspCapabilities: capsOn },
  capOff: { ...base, lspCapabilities: capsOff, requestLsp },
};
const use = (name) => graphContextsByModel.set(URI, { current: contexts[name] });

const plain = (value) =>
  JSON.parse(JSON.stringify(value, (_key, item) => (ArrayBuffer.isView(item) ? Array.from(item) : item)));

const providerFor = (method) => registered.find((entry) => entry.method === method).provider;

registerLspCapabilityProviders('pin', capsOn);

// reg: the Monaco registration; lsp: the request it sends; off: what a rejected context returns.
const cases = [
  {
    reg: 'registerTypeDefinitionProvider',
    lsp: 'textDocument/typeDefinition',
    response: location,
    off: [],
    run: (p) => p.provideTypeDefinition(model, position),
    on: (r) => [r[0].uri.fsPath, r[0].range.endColumn],
    expected: ['c:/p/a.ts', 2],
  },
  {
    reg: 'registerDeclarationProvider',
    lsp: 'textDocument/declaration',
    response: location,
    off: [],
    run: (p) => p.provideDeclaration(model, position),
    on: (r) => [r[0].uri.fsPath, r[0].range.endColumn],
    expected: ['c:/p/a.ts', 2],
  },
  {
    reg: 'registerImplementationProvider',
    lsp: 'textDocument/implementation',
    response: location,
    off: [],
    run: (p) => p.provideImplementation(model, position),
    on: (r) => [r[0].uri.fsPath, r[0].range.endColumn],
    expected: ['c:/p/a.ts', 2],
  },
  {
    reg: 'registerCompletionItemProvider',
    lsp: 'textDocument/completion',
    response: { items: [{ label: 'foo', kind: 3, insertText: 'foo()' }] },
    off: { suggestions: [] },
    run: (p) => p.provideCompletionItems(model, position),
    on: (r) => [r.suggestions.length, r.suggestions[0].label, r.suggestions[0].insertText, r.suggestions[0].kind],
    expected: [1, 'foo', 'foo()', 'Function'],
  },
  {
    reg: 'registerSignatureHelpProvider',
    lsp: 'textDocument/signatureHelp',
    token: true,
    response: { signatures: [{ label: 'f(a)', parameters: [{ label: 'a' }] }] },
    off: null,
    run: (p, token) =>
      p.provideSignatureHelp(model, position, token, {
        triggerKind: 1,
        isRetrigger: false,
      }),
    on: (r) => [r.value.signatures[0].label, r.value.signatures[0].parameters[0].label],
    expected: ['f(a)', 'a'],
  },
  {
    reg: 'registerHoverProvider',
    lsp: 'textDocument/hover',
    response: { contents: 'doc' },
    off: null,
    run: (p) => p.provideHover(model, position),
    on: (r) => r.contents,
    expected: [{ value: 'doc' }],
  },
  {
    reg: 'registerDocumentHighlightProvider',
    lsp: 'textDocument/documentHighlight',
    token: true,
    response: [{ range: lspRange, kind: 2 }],
    off: [],
    run: (p, token) => p.provideDocumentHighlights(model, position, token),
    on: (r) => [r.length, r[0].kind, r[0].range.endColumn],
    expected: [1, 1, 2],
  },
  {
    reg: 'registerLinkedEditingRangeProvider',
    lsp: 'textDocument/linkedEditingRange',
    token: true,
    response: { ranges: [lspRange] },
    off: null,
    run: (p, token) => p.provideLinkedEditingRanges(model, position, token),
    on: (r) => r.ranges.length,
    expected: 1,
  },
  {
    reg: 'registerCodeLensProvider',
    lsp: 'textDocument/codeLens',
    token: true,
    response: [{ range: lspRange, command: { command: 'c', title: 'T' } }],
    off: { lenses: [] },
    run: (p, token) => p.provideCodeLenses(model, token),
    on: (r) => [r.lenses.length, r.lenses[0].command.title, r.lenses[0].command.id],
    expected: [1, 'T', 'mixdog.editor.executeLspCommand'],
  },
  {
    reg: 'registerCodeActionProvider',
    lsp: 'textDocument/codeAction',
    response: [{ title: 'Fix', kind: 'quickfix' }],
    off: { actions: [] },
    run: (p) => p.provideCodeActions(model, range, { markers: [], trigger: 1 }),
    on: (r) => [r.actions.length, r.actions[0].title, r.actions[0].command.id],
    expected: [1, 'Fix', 'mixdog.editor.applyLspCodeAction'],
  },
  {
    reg: 'registerDocumentFormattingEditProvider',
    lsp: 'textDocument/formatting',
    response: [edit],
    off: [],
    run: (p) => p.provideDocumentFormattingEdits(model, { tabSize: 2 }),
    on: (r) => r.map((row) => [row.text, row.range.endColumn]),
    expected: [['x', 2]],
  },
  {
    reg: 'registerDocumentRangeFormattingEditProvider',
    lsp: 'textDocument/rangeFormatting',
    response: [edit],
    off: [],
    run: (p) => p.provideDocumentRangeFormattingEdits(model, range, { tabSize: 2 }),
    on: (r) => r.map((row) => [row.text, row.range.endColumn]),
    expected: [['x', 2]],
  },
  {
    reg: 'registerOnTypeFormattingEditProvider',
    lsp: 'textDocument/onTypeFormatting',
    token: true,
    response: [edit],
    off: [],
    run: (p, token) => p.provideOnTypeFormattingEdits(model, position, ';', { tabSize: 2 }, token),
    on: (r) => r.map((row) => [row.text, row.range.endColumn]),
    expected: [['x', 2]],
  },
  {
    reg: 'registerLinkProvider',
    lsp: 'textDocument/documentLink',
    token: true,
    response: [{ range: lspRange, target: 'http://x' }],
    off: { links: [] },
    run: (p, token) => p.provideLinks(model, token),
    on: (r) => [r.links.length, r.links[0].url],
    expected: [1, 'http://x'],
  },
  {
    reg: 'registerColorProvider',
    lsp: 'textDocument/documentColor',
    token: true,
    response: [{ range: lspRange, color: { red: 2, green: 0, blue: 0, alpha: 1 } }],
    off: [],
    run: (p, token) => p.provideDocumentColors(model, token),
    on: (r) => [r.length, r[0].color.red, r[0].color.alpha],
    expected: [1, 1, 1],
  },
  {
    reg: 'registerColorProvider',
    lsp: 'textDocument/colorPresentation',
    token: true,
    response: [{ label: 'red' }],
    off: [],
    run: (p, token) => p.provideColorPresentations(model, { color: { red: 1 }, range }, token),
    on: (r) => r.map((row) => row.label),
    expected: ['red'],
  },
  {
    reg: 'registerFoldingRangeProvider',
    lsp: 'textDocument/foldingRange',
    token: true,
    response: [{ startLine: 1, endLine: 3, kind: 'comment' }],
    off: [],
    run: (p, token) => p.provideFoldingRanges(model, {}, token),
    on: (r) => r,
    expected: [{ start: 2, end: 4, kind: 'comment' }],
  },
  {
    reg: 'registerSelectionRangeProvider',
    lsp: 'textDocument/selectionRange',
    token: true,
    response: [{ range: lspRange, parent: { range: lspRange } }],
    off: [],
    run: (p, token) => p.provideSelectionRanges(model, [position], token),
    on: (r) => r.map((chain) => chain.length),
    expected: [2],
  },
  {
    reg: 'registerDocumentSemanticTokensProvider',
    lsp: 'textDocument/semanticTokens/full',
    token: true,
    response: { resultId: 'r', data: [1, 2, 3] },
    off: { data: [] },
    run: (p, token) => p.provideDocumentSemanticTokens(model, null, token),
    on: (r) => [r.resultId, plain(r.data)],
    expected: ['r', [1, 2, 3]],
  },
  {
    reg: 'registerDocumentRangeSemanticTokensProvider',
    lsp: 'textDocument/semanticTokens/range',
    token: true,
    response: { resultId: 'r', data: [4, 5] },
    off: { data: [] },
    run: (p, token) => p.provideDocumentRangeSemanticTokens(model, range, token),
    on: (r) => [r.resultId, plain(r.data)],
    expected: ['r', [4, 5]],
  },
  {
    reg: 'registerInlayHintsProvider',
    lsp: 'textDocument/inlayHint',
    token: true,
    response: [{ position: { line: 0, character: 1 }, label: 'hint', kind: 1 }],
    off: { hints: [] },
    run: (p, token) => p.provideInlayHints(model, range, token),
    on: (r) => [r.hints.length, r.hints[0].label, r.hints[0].kind],
    expected: [1, 'hint', 'Type'],
  },
];

for (const row of cases) {
  test(`${row.lsp}: a rejected context answers its empty value, an accepted one maps the reply`, async () => {
    const provider = providerFor(row.reg);
    responses[row.lsp] = row.response;
    for (const name of ['noRequest', 'capOff']) {
      use(name);
      calls.length = 0;
      assert.deepEqual(plain(await row.run(provider, live)), plain(row.off), name);
      assert.equal(calls.length, 0, `${name} sends nothing`);
    }
    use('accept');
    if (row.token) {
      calls.length = 0;
      assert.deepEqual(plain(await row.run(provider, cancelled)), plain(row.off), 'cancelled');
      assert.equal(calls.length, 0, 'cancelled sends nothing');
    }
    calls.length = 0;
    assert.deepEqual(plain(row.on(await row.run(provider, live))), plain(row.expected));
    assert.equal(calls.at(-1)[0], row.lsp);
  });
}

const resolveCases = [
  {
    reg: 'registerCompletionItemProvider',
    lsp: 'completionItem/resolve',
    response: { detail: 'resolved' },
    provide: async (p) => (await p.provideCompletionItems(model, position)).suggestions[0],
    resolve: (p, item) => p.resolveCompletionItem(item),
    on: (r) => r.detail,
    expected: 'resolved',
    seed: { 'textDocument/completion': { items: [{ label: 'foo' }] } },
  },
  {
    reg: 'registerCodeLensProvider',
    lsp: 'codeLens/resolve',
    response: { range: lspRange, command: { command: 'r', title: 'R' } },
    provide: async (p) => (await p.provideCodeLenses(model, live)).lenses[0],
    resolve: (p, item) => p.resolveCodeLens(model, item),
    on: (r) => r.command.title,
    expected: 'R',
    seed: { 'textDocument/codeLens': [{ range: lspRange }] },
  },
  {
    reg: 'registerCodeActionProvider',
    lsp: 'codeAction/resolve',
    response: { title: 'Fixed' },
    provide: async (p) => (await p.provideCodeActions(model, range, { markers: [], trigger: 1 })).actions[0],
    resolve: (p, item) => p.resolveCodeAction(item),
    on: (r) => r.title,
    expected: 'Fixed',
    seed: { 'textDocument/codeAction': [{ title: 'Fix' }] },
  },
  {
    reg: 'registerLinkProvider',
    lsp: 'documentLink/resolve',
    response: { range: lspRange, target: 'http://y' },
    provide: async (p) => (await p.provideLinks(model, live)).links[0],
    resolve: (p, item) => p.resolveLink(item),
    on: (r) => r.url,
    expected: 'http://y',
    seed: { 'textDocument/documentLink': [{ range: lspRange }] },
  },
  {
    reg: 'registerInlayHintsProvider',
    lsp: 'inlayHint/resolve',
    response: { position: { line: 0, character: 1 }, label: 'hint2' },
    provide: async (p) => (await p.provideInlayHints(model, range, live)).hints[0],
    resolve: (p, item) => p.resolveInlayHint(item),
    on: (r) => r.label,
    expected: 'hint2',
    seed: {
      'textDocument/inlayHint': [{ position: { line: 0, character: 1 }, label: 'hint' }],
    },
  },
];

for (const row of resolveCases) {
  test(`${row.lsp}: a rejected context returns the item itself, an accepted one the resolved item`, async () => {
    const provider = providerFor(row.reg);
    Object.assign(responses, row.seed, { [row.lsp]: row.response });
    use('accept');
    const item = await row.provide(provider);
    for (const name of ['noRequest', 'capOff']) {
      use(name);
      calls.length = 0;
      assert.equal(await row.resolve(provider, item), item, name);
      assert.equal(calls.length, 0, `${name} sends nothing`);
    }
    use('accept');
    assert.equal(row.on(await row.resolve(provider, item)), row.expected);
    assert.equal(calls.at(-1)[0], row.lsp);
  });
}

test('semantic tokens ask for a delta once a previous result id and delta support exist', async () => {
  const provider = providerFor('registerDocumentSemanticTokensProvider');
  responses['textDocument/semanticTokens/full/delta'] = {
    resultId: 'r2',
    edits: [{ start: 0, deleteCount: 1, data: [5] }],
  };
  use('accept');
  calls.length = 0;
  const result = await provider.provideDocumentSemanticTokens(model, 'prev', live);
  assert.deepEqual(calls[0], ['textDocument/semanticTokens/full/delta', { previousResultId: 'prev' }]);
  assert.deepEqual(plain(result), {
    resultId: 'r2',
    edits: [{ start: 0, deleteCount: 1, data: [5] }],
  });
});

test('registering the same capabilities again installs no second provider', () => {
  const before = registered.length;
  registerLspCapabilityProviders('pin', capsOn);
  assert.equal(registered.length, before);
});
