import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';

import { codeGraph } from './dispatch.mjs';
import { _attachGraphRuntimeCaches } from './graph-model.mjs';
import { _symbolLine } from './symbol-index.mjs';

// Native record v2: unified kinds for every language (solidity `contract` →
// class, hcl `resource` → struct, …), optional sig/exported/parent.
function nativeSym(name, kind, startLine, startCol = 1, endCol = null, extra = {}) {
  return {
    name,
    kind,
    startLine,
    endLine: extra.endLine ?? startLine,
    startCol,
    endCol: endCol == null ? startCol + String(name).length : endCol,
    ...(extra.exported ? { exported: true } : {}),
    ...(extra.sig ? { sig: extra.sig } : {}),
    ...(extra.parent ? { parent: extra.parent } : {}),
  };
}

function makeNode(rel, lang, extra = {}) {
  return {
    abs: resolve(process.cwd(), rel),
    rel,
    lang,
    fingerprint: extra.fingerprint || 'fp',
    parseError: extra.parseError || '',
    rawImports: extra.rawImports || [],
    resolvedImports: extra.resolvedImports || [],
    importedBy: extra.importedBy || [],
    packageName: extra.packageName || '',
    namespaceName: extra.namespaceName || '',
    goPackageName: extra.goPackageName || '',
    topLevelTypes: extra.topLevelTypes || [],
    tokenSymbols: extra.tokenSymbols || null,
    symbols: extra.symbols || [],
  };
}

function makeGraph() {
  const cwd = process.cwd();
  const token = makeNode('src/Token.sol', 'solidity', {
    rawImports: ['./IERC20.sol'],
    resolvedImports: [resolve(cwd, 'src/IERC20.sol')],
    tokenSymbols: ['contract', 'Token', 'function', 'transfer', 'address', 'to', 'public', 'mint'],
    topLevelTypes: ['Token'],
    symbols: [
      nativeSym('Token', 'class', 1, 10, 15, { endLine: 4, exported: true, sig: 'contract Token' }),
      nativeSym('transfer', 'function', 2, 12, 20, {
        exported: true,
        sig: 'function transfer(address to) public',
        parent: 'Token',
      }),
      nativeSym('mint', 'function', 3, 12, 16, { exported: true, sig: 'function mint() public', parent: 'Token' }),
    ],
  });
  const iface = makeNode('src/IERC20.sol', 'solidity', {
    tokenSymbols: ['IERC20', 'transfer'],
    symbols: [
      nativeSym('IERC20', 'interface', 1, 1, 7, { endLine: 3, exported: true }),
      nativeSym('transfer', 'function', 2, 1, 9, { parent: 'IERC20' }),
    ],
  });
  const hs = makeNode('src/Math.hs', 'haskell', {
    tokenSymbols: ['module', 'Math', 'where', 'factorial', 'n', 'product'],
    symbols: [nativeSym('factorial', 'function', 3, 1, 10)],
  });
  const hcl = makeNode('src/main.tf', 'hcl', {
    tokenSymbols: ['resource', 'aws_instance', 'web', 'ami'],
    symbols: [nativeSym('aws_instance', 'struct', 1, 1, 13, { sig: 'resource "aws_instance" "web"' })],
  });
  const graph = _attachGraphRuntimeCaches({
    cwd,
    nodes: new Map([
      [token.rel, token],
      [iface.rel, iface],
      [hs.rel, hs],
      [hcl.rel, hcl],
    ]),
    reverse: new Map([[iface.rel, new Set([token.rel])]]),
  });
  graph._sourceTextCache.set(token.rel, {
    fingerprint: token.fingerprint,
    text: 'contract Token {\n  function transfer(address to) public {}\n  function mint() public {}\n}\n',
  });
  graph._sourceTextCache.set(hs.rel, {
    fingerprint: hs.fingerprint,
    text: 'module Math where\n\nfactorial n = product [1..n]\n',
  });
  graph._sourceTextCache.set(hcl.rel, {
    fingerprint: hcl.fingerprint,
    text: 'resource "aws_instance" "web" {\n  ami = "ami-123"\n}\n',
  });
  return graph;
}

async function dispatch(graph, args) {
  return String(await codeGraph(args, process.cwd(), null, { graph }));
}

test('unknown langs solidity/haskell/hcl never throw and native symbols drive graph modes', async () => {
  const graph = makeGraph();

  const overviewAll = await dispatch(graph, { mode: 'overview' });
  assert.match(overviewAll, /solidity\t2/);
  assert.match(overviewAll, /haskell\t1/);
  assert.match(overviewAll, /hcl\t1/);

  const overviewSol = await dispatch(graph, { mode: 'overview', file: 'src/Token.sol' });
  assert.match(overviewSol, /language: solidity/);
  assert.match(overviewSol, /transfer/);

  // Unified kinds + sig + export marker + parent nesting, same shape for every
  // language the extractor knows.
  const symbolsSol = await dispatch(graph, { mode: 'symbols', file: 'src/Token.sol' });
  assert.match(symbolsSol, /^export class Token \(L1-4\) {2}contract Token$/m);
  assert.match(symbolsSol, /^ {2}export function transfer \(L2\) {2}function transfer\(address to\) public$/m);

  const symbolsHs = await dispatch(graph, { mode: 'symbols', file: 'src/Math.hs' });
  assert.match(symbolsHs, /^function factorial \(L3\)$/m);

  const symbolsHcl = await dispatch(graph, { mode: 'symbols', file: 'src/main.tf' });
  assert.match(symbolsHcl, /^struct aws_instance \(L1\) {2}resource "aws_instance" "web"$/m);

  const findNativeOnly = await dispatch(graph, { mode: 'find_symbol', symbol: 'IERC20' });
  assert.match(findNativeOnly, /IERC20/);
  assert.match(findNativeOnly, /src\/IERC20\.sol/);

  const findHs = await dispatch(graph, { mode: 'find_symbol', symbol: 'factorial' });
  assert.match(findHs, /factorial/);
  assert.match(findHs, /src\/Math\.hs/);

  const search = await dispatch(graph, { mode: 'symbol_search', symbol: 'transfer' });
  assert.match(search, /transfer/);
  assert.match(search, /Token\.sol|IERC20\.sol/);

  const imports = await dispatch(graph, { mode: 'imports', file: 'src/Token.sol' });
  assert.match(imports, /IERC20\.sol/);

  const dependents = await dispatch(graph, { mode: 'dependents', file: 'src/IERC20.sol' });
  assert.match(dependents, /Token\.sol/);

  const impact = await dispatch(graph, { mode: 'impact', file: 'src/Token.sol' });
  assert.match(impact, /language\tsolidity/);
  assert.match(impact, /transfer|Token/);

  const refs = await dispatch(graph, { mode: 'references', symbol: 'transfer', language: 'solidity' });
  assert.match(refs, /# references|# declaration|transfer/);

  // Call analysis is AST-only: this fixture graph carries no `calls` at all,
  // so callers reports the missing capability instead of an empty answer.
  await assert.rejects(
    () => dispatch(graph, { mode: 'callers', symbol: 'transfer', language: 'solidity' }),
    /no AST call sites are available/
  );

  const refsHs = await dispatch(graph, { mode: 'references', symbol: 'factorial', language: 'haskell' });
  assert.equal(typeof refsHs, 'string');
  assert.doesNotMatch(refsHs, /no adapter topLevelTypes/);
  assert.match(refsHs, /factorial|# references|# declaration/);
});

test('_symbolLine reads the record start line', () => {
  assert.equal(_symbolLine({ line: 4, startLine: 1 }), 4);
  assert.equal(_symbolLine({ startLine: 7 }), 7);
  assert.equal(_symbolLine({ line: 0, startLine: 3 }), 0);
  assert.equal(_symbolLine({}), 0);
});

test('every language is native-only: source text never produces a symbol', async () => {
  const cwd = process.cwd();
  // The node's `symbols`/`tokens` say one thing, its source text another. The
  // record wins everywhere — there is no regex outline left to disagree with
  // it, and a declaration only the text knows about is simply not a symbol.
  const js = makeNode('src/keep.js', 'javascript', {
    symbols: [nativeSym('nativeOnly', 'function', 99, 1, 11, { sig: 'function nativeOnly()', exported: true })],
    tokenSymbols: ['nativeOnly', 'localFn'],
  });
  const ts = makeNode('src/keep.ts', 'typescript', {
    symbols: [nativeSym('nativeOnlyTs', 'function', 80)],
    tokenSymbols: ['nativeOnlyTs', 'LocalTs'],
  });
  // No record at all → no outline, no find_symbol hit, no keyword match.
  const bare = makeNode('src/bare.js', 'javascript', { symbols: [], tokenSymbols: ['orphanFn'] });
  const graph = _attachGraphRuntimeCaches({
    cwd,
    nodes: new Map([
      [js.rel, js],
      [ts.rel, ts],
      [bare.rel, bare],
    ]),
    reverse: new Map(),
  });
  graph._sourceTextCache.set(js.rel, { fingerprint: js.fingerprint, text: 'function localFn() {}\n' });
  graph._sourceTextCache.set(ts.rel, { fingerprint: ts.fingerprint, text: 'export class LocalTs {}\n' });
  graph._sourceTextCache.set(bare.rel, { fingerprint: bare.fingerprint, text: 'function orphanFn() {}\n' });

  const jsOutline = await dispatch(graph, { mode: 'symbols', file: 'src/keep.js' });
  assert.match(jsOutline, /^export function nativeOnly \(L99\) {2}function nativeOnly\(\)$/m);
  assert.doesNotMatch(jsOutline, /localFn/);

  const tsOutline = await dispatch(graph, { mode: 'symbols', file: 'src/keep.ts' });
  assert.match(tsOutline, /^function nativeOnlyTs \(L80\)$/m);
  assert.doesNotMatch(tsOutline, /LocalTs/);

  assert.equal(await dispatch(graph, { mode: 'symbols', file: 'src/bare.js' }), '(no symbols)');

  const jsFind = await dispatch(graph, { mode: 'find_symbol', symbol: 'nativeOnly' });
  assert.match(jsFind, /keep\.js/);
  assert.match(jsFind, /export function/);
  const textOnlyFind = await dispatch(graph, { mode: 'find_symbol', symbol: 'orphanFn' });
  assert.doesNotMatch(textOnlyFind, /# best declaration candidate/);
  const textOnlySearch = await dispatch(graph, { mode: 'symbol_search', symbol: 'orphan' });
  assert.match(textOnlySearch, /no symbol keyword matches/);
});

test('a graph of extraction languages with no record at all is a capability failure', async () => {
  const cwd = process.cwd();
  const bare = makeNode('src/bare.js', 'javascript', { symbols: [], tokenSymbols: ['orphanFn'] });
  const graph = _attachGraphRuntimeCaches({
    cwd,
    nodes: new Map([[bare.rel, bare]]),
    reverse: new Map(),
  });
  graph._sourceTextCache.set(bare.rel, { fingerprint: bare.fingerprint, text: 'function orphanFn() {}\n' });

  for (const mode of ['symbols', 'find_symbol', 'symbol_search']) {
    await assert.rejects(
      () => dispatch(graph, { mode, file: 'src/bare.js', symbol: 'orphanFn' }),
      /no native symbols are available/,
      mode
    );
  }
  // overview still answers — with the same capability hint attached.
  const overview = await dispatch(graph, { mode: 'overview', file: 'src/bare.js' });
  assert.match(overview, /language: javascript/);
  assert.match(overview, /note: no outline is shown/);
});

test('references for a lang with no files keeps the existing no-adapter error', async () => {
  const graph = makeGraph();
  await assert.rejects(
    () => dispatch(graph, { mode: 'references', symbol: 'x', language: 'cobol' }),
    /no adapter topLevelTypes and is not in supportedRegexLangs/
  );
  // callers has no regex-language gate left: its answer depends on call data,
  // which this graph does not have.
  await assert.rejects(
    () => dispatch(graph, { mode: 'callers', symbol: 'x', language: 'cobol' }),
    /no AST call sites are available/
  );
});
