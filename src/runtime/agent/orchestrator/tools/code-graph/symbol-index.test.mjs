// Outline rendering over the native symbol record v2 — the ONLY source of
// symbols. The cheap regex extractor these tests used to exercise is gone:
// comment handling, control-flow filtering and per-language matchers now all
// live in the extractor, and a node without `symbols` renders nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _symbolOutlineRows,
  _symbolRowLabel,
  _lookupCandidateNodes,
  _getTokenSymbolsForNode,
  _graphHasNativeSymbols,
  _graphExpectsNativeSymbols,
} from './symbol-index.mjs';

const node = (symbols) => ({ rel: 'src/a.mjs', lang: 'javascript', symbols });

test('outline rows nest members under their parent and mark exports', () => {
  const rows = _symbolOutlineRows(
    node([
      {
        name: 'Worker',
        kind: 'class',
        startLine: 5,
        endLine: 15,
        startCol: 14,
        endCol: 1,
        exported: true,
        sig: 'class Worker',
      },
      {
        name: 'start',
        kind: 'method',
        startLine: 6,
        endLine: 8,
        startCol: 3,
        endCol: 3,
        sig: 'start(input)',
        parent: 'Worker',
      },
      {
        name: 'helper',
        kind: 'function',
        startLine: 7,
        endLine: 7,
        startCol: 5,
        endCol: 20,
        sig: 'function helper(v)',
        parent: 'start',
      },
      { name: 'handler', kind: 'variable', startLine: 17, endLine: 17, startCol: 7, endCol: 20 },
    ])
  );
  assert.deepEqual(rows, [
    // `class Worker` == `kind name` → redundant, omitted; the others add
    // parameters, so they trail the anchor after two spaces.
    'export class Worker (L5-15)',
    '  method start (L6-8)  start(input)',
    '    function helper (L7)  function helper(v)',
    'variable handler (L17)',
  ]);
});

test('depth bounds the containment level and rows stay ordered by line', () => {
  const outline = node([
    { name: 'b', kind: 'method', startLine: 9, endLine: 9, startCol: 3, endCol: 4, parent: 'A' },
    { name: 'A', kind: 'class', startLine: 2, endLine: 10, startCol: 7, endCol: 1 },
    { name: 'deep', kind: 'function', startLine: 9, endLine: 9, startCol: 20, endCol: 24, parent: 'b' },
  ]);
  assert.deepEqual(_symbolOutlineRows(outline, { depth: 1 }), ['class A (L2-10)', '  method b (L9)']);
  // A cap cuts mid-block, so it announces itself at column 0 — a silent cut
  // reads like the file's full structure.
  assert.deepEqual(_symbolOutlineRows(outline, { cap: 2 }), [
    'class A (L2-10)',
    '  method b (L9)',
    '… +1 more (mode:symbols for the full outline)',
  ]);
  assert.equal(_symbolOutlineRows(outline, { cap: 3 }).length, 3);
});

test('the row grammar keeps the bare name in one position and trails the sig', () => {
  assert.equal(
    _symbolRowLabel({ name: 'f', kind: 'function', startLine: 3, endLine: 4, sig: 'function f(a, b)', exported: true }),
    'export function f (L3-4)  function f(a, b)'
  );
  assert.equal(
    _symbolRowLabel({ name: 'top', kind: 'function', startLine: 1, endLine: 2, sig: 'async def top(x)' }),
    'function top (L1-2)  async def top(x)'
  );
  // A sig that only restates `name` or `kind name` carries nothing the row
  // does not already say.
  assert.equal(
    _symbolRowLabel({ name: 'Service', kind: 'class', startLine: 2, endLine: 9, sig: 'class Service' }),
    'class Service (L2-9)'
  );
  assert.equal(
    _symbolRowLabel({ name: 'Sink', kind: 'trait', startLine: 5, endLine: 5, sig: 'Sink' }),
    'trait Sink (L5)'
  );
  assert.equal(_symbolRowLabel({ name: 'MAX', kind: 'constant', startLine: 7, endLine: 7 }), 'constant MAX (L7)');
});

test('one record is one line, and the anchor terminates a name with inner spaces', () => {
  // Real record shape from the extractor (Solidity pragma; C++/Scala
  // `operator ==` has the same shape): the name is taken verbatim, so a
  // consumer reads it up to the trailing anchor rather than to the first
  // space.
  const row = _symbolRowLabel({
    name: 'solidity ^0.8.19',
    kind: 'constant',
    startLine: 1,
    endLine: 1,
    exported: true,
    sig: 'pragma solidity ^0.8.19',
  });
  assert.equal(row, 'export constant solidity ^0.8.19 (L1)  pragma solidity ^0.8.19');
  const parsed = /^( *)(?:(export) )?([A-Za-z]+) (.+?) \(L(\d+)(?:-(\d+))?\)(?: {2}(.*))?$/.exec(row);
  assert.deepEqual(
    [parsed[3], parsed[4], parsed[5], parsed[7]],
    ['constant', 'solidity ^0.8.19', '1', 'pragma solidity ^0.8.19']
  );
  // A span that carried a newline/tab must not split one symbol into two
  // rows — every level below it would read as the wrong containment depth.
  const folded = _symbolRowLabel({ name: 'op\n==', kind: 'method', startLine: 4, endLine: 6, sig: 'fn op\t==(self)' });
  assert.equal(folded, 'method op == (L4-6)  fn op ==(self)');
  assert.equal(folded.includes('\n'), false);
});

test('a node without a native record contributes no rows and no tokens', () => {
  assert.deepEqual(_symbolOutlineRows(node([])), []);
  assert.deepEqual(_symbolOutlineRows({ rel: 'x', lang: 'javascript' }), []);
  assert.equal(_getTokenSymbolsForNode({ rel: 'x', lang: 'javascript' }), null);
  assert.deepEqual(_getTokenSymbolsForNode({ tokenSymbols: ['a'] }), ['a']);
});

test('candidate lookup uses native tokens only — no full-graph fallback', () => {
  const tokened = { rel: 'src/a.mjs', lang: 'javascript', tokenSymbols: ['alpha'], symbols: [] };
  const tokenless = { rel: 'src/b.mjs', lang: 'javascript', tokenSymbols: null, symbols: [] };
  const graph = {
    nodes: new Map([
      [tokened.rel, tokened],
      [tokenless.rel, tokenless],
    ]),
    _symbolTokenIndex: new Map(),
  };
  assert.deepEqual(
    _lookupCandidateNodes(graph, 'alpha').map((n) => n.rel),
    ['src/a.mjs']
  );
  // A miss is the empty set, not "every node in the graph".
  assert.deepEqual(_lookupCandidateNodes(graph, 'beta'), []);
});

test('symbol capability probes separate "no symbols" from "not an extraction language"', () => {
  const withSymbols = {
    nodes: new Map([['a.mjs', { lang: 'javascript', symbols: [{ name: 'x', kind: 'function', startLine: 1 }] }]]),
  };
  const withoutSymbols = { nodes: new Map([['a.mjs', { lang: 'javascript', symbols: [] }]]) };
  const nonExtraction = { nodes: new Map([['a.css', { lang: 'css', symbols: [] }]]) };
  assert.equal(_graphHasNativeSymbols(withSymbols), true);
  assert.equal(_graphHasNativeSymbols(withoutSymbols), false);
  assert.equal(_graphExpectsNativeSymbols(withoutSymbols), true);
  assert.equal(_graphExpectsNativeSymbols(nonExtraction), false);
});
