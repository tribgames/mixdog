import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codeGraphDocumentSymbols,
  codeGraphOutlineItems,
  codeGraphSymbolKindValue,
  parseCodeGraphSymbols,
  UNIFIED_SYMBOL_KINDS,
} from './editor-code-graph.ts';

test('parseCodeGraphSymbols: old row grammar without sig or indent', () => {
  const text = 'function save (L89-104)';
  const rows = parseCodeGraphSymbols(text);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    kind: 'function',
    name: 'save',
    line: 89,
    endLine: 104,
    exported: false,
    sig: null,
    level: 0,
  });
});

test('parseCodeGraphSymbols: single-line anchor without range', () => {
  const text = 'variable here (L19)';
  const rows = parseCodeGraphSymbols(text);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    kind: 'variable',
    name: 'here',
    line: 19,
    endLine: 19,
    exported: false,
    sig: null,
    level: 0,
  });
});

test('parseCodeGraphSymbols: exported prefix', () => {
  const text = 'export class Service (L27-45)';
  const rows = parseCodeGraphSymbols(text);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    kind: 'class',
    name: 'Service',
    line: 27,
    endLine: 45,
    exported: true,
    sig: null,
    level: 0,
  });
});

test('parseCodeGraphSymbols: nested indentation and signatures', () => {
  const text = [
    'export class Service (L27-45)',
    '  function run (L33-37)  def run(self, payload) -> str',
    '    constant CANCELLED (L42)  const CANCELLED: &str',
  ].join('\n');
  const rows = parseCodeGraphSymbols(text);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    kind: 'class',
    name: 'Service',
    line: 27,
    endLine: 45,
    exported: true,
    sig: null,
    level: 0,
  });
  assert.deepEqual(rows[1], {
    kind: 'function',
    name: 'run',
    line: 33,
    endLine: 37,
    exported: false,
    sig: 'def run(self, payload) -> str',
    level: 1,
  });
  assert.deepEqual(rows[2], {
    kind: 'constant',
    name: 'CANCELLED',
    line: 42,
    endLine: 42,
    exported: false,
    sig: 'const CANCELLED: &str',
    level: 2,
  });
});

test('parseCodeGraphSymbols: complex signatures with generics, parens, arrows', () => {
  const text = 'export method transform (L10-25)  pub async fn transform<T, R>(input: &T) -> Result<R, Error>';
  const rows = parseCodeGraphSymbols(text);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    kind: 'method',
    name: 'transform',
    line: 10,
    endLine: 25,
    exported: true,
    sig: 'pub async fn transform<T, R>(input: &T) -> Result<R, Error>',
    level: 0,
  });
});

test('parseCodeGraphSymbols: CRLF and trailing whitespace tolerance', () => {
  const text = 'export interface Config (L1-20)   \r\n  property timeout (L5)  timeout: number  \r\n\r\n';
  const rows = parseCodeGraphSymbols(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Config');
  assert.equal(rows[0].exported, true);
  assert.equal(rows[0].sig, null);
  assert.equal(rows[0].level, 0);

  assert.equal(rows[1].name, 'timeout');
  assert.equal(rows[1].exported, false);
  assert.equal(rows[1].sig, 'timeout: number');
  assert.equal(rows[1].level, 1);
});

test('parseCodeGraphSymbols: deduplication of identical rows', () => {
  const text = [
    'function save (L89-104)',
    'function save (L89-104)',
  ].join('\n');
  const rows = parseCodeGraphSymbols(text);
  assert.equal(rows.length, 1);
});

test('codeGraphOutlineItems: uses explicit level and sig detail from new rows', () => {
  const model = {
    uri: { toString: () => 'file:///workspace/service.ts' },
    getLineCount: () => 100,
  };
  const context = {
    projectPath: '/workspace',
    relPath: 'service.ts',
  };
  const symbols = parseCodeGraphSymbols([
    'export class Service (L10-50)',
    '  method process (L20-30)  process(data: string): boolean',
    '    variable count (L25)  count: number',
  ].join('\n'));

  const items = codeGraphOutlineItems(model, context, symbols);
  assert.equal(items.length, 3);

  // Service: level 0, detail = class
  assert.equal(items[0].name, 'Service');
  assert.equal(items[0].detail, 'class');
  assert.equal(items[0].kind, 'class');
  assert.equal(items[0].level, 0);
  assert.equal(items[0].line, 10);
  assert.equal(items[0].endLine, 50);

  // process: level 1 from row, detail = signature
  assert.equal(items[1].name, 'process');
  assert.equal(items[1].detail, 'process(data: string): boolean');
  assert.equal(items[1].kind, 'method');
  assert.equal(items[1].level, 1);
  assert.equal(items[1].line, 20);
  assert.equal(items[1].endLine, 30);

  // count: level 2 from row, detail = signature
  assert.equal(items[2].name, 'count');
  assert.equal(items[2].detail, 'count: number');
  assert.equal(items[2].kind, 'variable');
  assert.equal(items[2].level, 2);
  assert.equal(items[2].line, 25);
  assert.equal(items[2].endLine, 25);
});

test('codeGraphOutlineItems: fallback to span nesting for old rows at level 0', () => {
  const model = {
    uri: { toString: () => 'file:///workspace/old.py' },
    getLineCount: () => 100,
  };
  const context = {
    projectPath: '/workspace',
    relPath: 'old.py',
  };
  // Old rows: all have level 0, no signatures
  const symbols = parseCodeGraphSymbols([
    'class Container (L1-40)',
    'function helper (L5-15)',
    'function standalone (L50-60)',
  ].join('\n'));

  assert.equal(symbols[0].level, 0);
  assert.equal(symbols[1].level, 0);
  assert.equal(symbols[2].level, 0);

  const items = codeGraphOutlineItems(model, context, symbols);
  assert.equal(items.length, 3);

  // Container: top level -> level 0
  assert.equal(items[0].name, 'Container');
  assert.equal(items[0].level, 0);
  assert.equal(items[0].detail, 'class');

  // helper: span L5-15 nests inside L1-40 -> fallback spanLevel 1
  assert.equal(items[1].name, 'helper');
  assert.equal(items[1].level, 1);
  assert.equal(items[1].detail, 'function');

  // standalone: span L50-60 does not nest -> level 0
  assert.equal(items[2].name, 'standalone');
  assert.equal(items[2].level, 0);
  assert.equal(items[2].detail, 'function');
});

test('symbolKind mapping totality: covers all 21 unified vocabulary kinds', () => {
  const expectedMappings = {
    module: 1,       // Module
    namespace: 2,    // Namespace
    package: 3,      // Package
    class: 4,        // Class
    impl: 4,         // Class
    method: 5,       // Method
    property: 6,     // Property
    field: 7,        // Field
    constructor: 8,  // Constructor
    enum: 9,         // Enum
    interface: 10,   // Interface
    trait: 10,       // Interface
    protocol: 10,    // Interface
    function: 11,    // Function
    macro: 11,       // Function
    variable: 12,    // Variable
    constant: 13,    // Constant
    enumMember: 21,  // EnumMember
    struct: 22,      // Struct
    type: 10,        // Interface (aligned with LSP type alias -> Interface)
    event: 23,       // Event
  };

  for (const kind of UNIFIED_SYMBOL_KINDS) {
    assert.ok(kind in expectedMappings, `Missing expected mapping for unified kind: ${kind}`);
    const mapped = codeGraphSymbolKindValue(kind);
    assert.equal(mapped, expectedMappings[kind], `Kind ${kind} mapped to ${mapped}, expected ${expectedMappings[kind]}`);
  }

  // Dead legacy token 'binding' falls back to default Variable (12)
  assert.equal(codeGraphSymbolKindValue('binding'), 12);
  // Unknown token falls back to default Variable (12)
  assert.equal(codeGraphSymbolKindValue('unknown_custom_kind'), 12);
});

test('codeGraphDocumentSymbols: builds hierarchical DocumentSymbol tree from level for new rows', () => {
  const model = {
    uri: { toString: () => 'file:///workspace/service.ts' },
    getLineCount: () => 100,
    getLineContent: (n) => {
      if (n === 10) return 'export class Service {';
      if (n === 20) return '  process(data: string): boolean {';
      if (n === 25) return '    const count = 1;';
      return '';
    },
    getLineMaxColumn: () => 80,
  };
  const symbols = parseCodeGraphSymbols([
    'export class Service (L10-50)',
    '  method process (L20-30)  process(data: string): boolean',
    '    variable count (L25)  count: number',
  ].join('\n'));

  const roots = codeGraphDocumentSymbols(model, symbols);
  assert.equal(roots.length, 1);
  const service = roots[0];
  assert.equal(service.name, 'Service');
  assert.equal(service.kind, 4); // Class
  assert.equal(service.detail, 'class');
  assert.equal(service.children.length, 1);

  const process = service.children[0];
  assert.equal(process.name, 'process');
  assert.equal(process.kind, 5); // Method
  assert.equal(process.detail, 'process(data: string): boolean');
  assert.equal(process.children.length, 1);

  const count = process.children[0];
  assert.equal(count.name, 'count');
  assert.equal(count.kind, 12); // Variable
  assert.equal(count.detail, 'count: number');
  assert.equal(count.children.length, 0);
});

test('codeGraphDocumentSymbols: fallback to span nesting for old rows at level 0', () => {
  const model = {
    uri: { toString: () => 'file:///workspace/old.py' },
    getLineCount: () => 100,
    getLineContent: (n) => {
      if (n === 1) return 'class Container:';
      if (n === 5) return '  def helper(): pass';
      if (n === 50) return 'def standalone(): pass';
      return '';
    },
    getLineMaxColumn: () => 80,
  };
  // Old rows without indent
  const symbols = parseCodeGraphSymbols([
    'class Container (L1-40)',
    'function helper (L5-15)',
    'function standalone (L50-60)',
  ].join('\n'));

  const roots = codeGraphDocumentSymbols(model, symbols);
  assert.equal(roots.length, 2);

  const container = roots[0];
  assert.equal(container.name, 'Container');
  assert.equal(container.kind, 4); // Class
  assert.equal(container.children.length, 1);

  const helper = container.children[0];
  assert.equal(helper.name, 'helper');
  assert.equal(helper.kind, 11); // Function
  assert.equal(helper.children.length, 0);

  const standalone = roots[1];
  assert.equal(standalone.name, 'standalone');
  assert.equal(standalone.kind, 11); // Function
  assert.equal(standalone.children.length, 0);
});

test('parseCodeGraphSymbols: symbols containing special characters (. :: $ =)', () => {
  const text = [
    'function run= (L1-2)  def run=(val)',
    'method Foo::bar (L10-20)  void Foo::bar()',
    'variable $myVar (L5)  const $myVar: number',
    'property obj.prop (L3)',
  ].join('\n');
  const rows = parseCodeGraphSymbols(text);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].name, 'run=');
  assert.equal(rows[0].sig, 'def run=(val)');
  assert.equal(rows[1].name, 'Foo::bar');
  assert.equal(rows[1].sig, 'void Foo::bar()');
  assert.equal(rows[2].name, '$myVar');
  assert.equal(rows[2].sig, 'const $myVar: number');
  assert.equal(rows[3].name, 'obj.prop');
  assert.equal(rows[3].sig, null);
});

test('parseCodeGraphSymbols: signature separated by one space is not swallowed into name', () => {
  // Grammar requires two spaces before signature. One space fails row grammar and is rejected.
  const valid = parseCodeGraphSymbols('function run (L1-2)  def run(a)');
  assert.equal(valid.length, 1);
  assert.equal(valid[0].name, 'run');
  assert.equal(valid[0].sig, 'def run(a)');

  const invalid = parseCodeGraphSymbols('function run (L1-2) x');
  assert.equal(invalid.length, 0);
});





