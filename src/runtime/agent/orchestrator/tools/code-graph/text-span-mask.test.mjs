import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _inferSpanEndByIndent } from './span.mjs';
import { _maskNonCodeText } from './text-mask.mjs';
import { _atJsRegexPosition, _extractCallees, _jsBraceKindAt } from './search.mjs';

test('indentation span inference keeps a multiline arrow signature whole', () => {
    const lines = [
        'const handler = (',
        '  a,',
        '  b,',
        ') => {',
        '  return a + b;',
        '};',
    ];
    assert.equal(_inferSpanEndByIndent(lines, 1), 6);
});

test('indentation span inference still ends at a plain matching closer', () => {
    const lines = [
        'const rows = [',
        '  1,',
        '  2,',
        '];',
        'const other = 3;',
    ];
    assert.equal(_inferSpanEndByIndent(lines, 1), 4);
});

test('python f-string interpolation keeps its call visible', () => {
    const masked = _maskNonCodeText('x = f"total {compute_total(rows)} done"\n', 'python');
    assert.match(masked, /compute_total\(rows\)/);
    assert.doesNotMatch(masked, /done/);
});

test('C# interpolated string exposes the call and keeps {{ }} literal', () => {
    const masked = _maskNonCodeText('var s = $"{Compute(x)} {{literal}}";\n', 'csharp');
    assert.match(masked, /Compute\(x\)/);
    assert.doesNotMatch(masked, /literal/);
});

test('kotlin string template exposes the call', () => {
    const masked = _maskNonCodeText('val s = "n=${computeTotal(rows)}"\n', 'kotlin');
    assert.match(masked, /computeTotal\(rows\)/);
});

test('bash command substitution inside double quotes stays code', () => {
    const masked = _maskNonCodeText('echo "value $(compute_total rows) done"\n', 'bash');
    assert.match(masked, /compute_total rows/);
    assert.doesNotMatch(masked, /value/);
});

test('a plain python string is still fully masked', () => {
    const masked = _maskNonCodeText('x = "total {compute_total(rows)} done"\n', 'python');
    assert.doesNotMatch(masked, /compute_total/);
});

test('a python triple-quoted f-string interpolates', () => {
    const masked = _maskNonCodeText('x = f"""head {compute(rows)} tail"""\n', 'python');
    assert.match(masked, /compute\(rows\)/);
    assert.doesNotMatch(masked, /head/);
});

test('a kotlin raw string template interpolates', () => {
    const masked = _maskNonCodeText('val s = """head ${compute(rows)} tail"""\n', 'kotlin');
    assert.match(masked, /compute\(rows\)/);
    assert.doesNotMatch(masked, /head/);
});

test('a kotlin bare $name keeps the identifier but a JS template does not', () => {
    const kotlin = _maskNonCodeText('val s = "id=$userId done"\n', 'kotlin');
    assert.match(kotlin, /userId/);
    assert.doesNotMatch(kotlin, /done/);

    // JS template literals have no bare form: `$userId` is literal text.
    const js = _maskNonCodeText('const s = `id=$userId`;\n', 'javascript');
    assert.doesNotMatch(js, /userId/);
});

test('a non-matching same-indent closer does not end the span', () => {
    const lines = [
        'const handler = {',
        '  run: (',
        '  ) => 1,',
        ')',
        '};',
    ];
    assert.equal(_inferSpanEndByIndent(lines, 1), 5);
});

test('a division after an object literal is not read as a regex', () => {
    const text = 'function f(){ const x = {} / 2; } outside();';
    assert.equal(_atJsRegexPosition(text, text.indexOf('/ 2')), false);
});

test('a statement-position regex after a closing brace is recognized', () => {
    const text = '}\n/re/.test(x)';
    assert.equal(_atJsRegexPosition(text, text.indexOf('/re/')), true);
});

test('a postfix increment before a slash stays division', () => {
    const text = 'const y = a++ / b;';
    assert.equal(_atJsRegexPosition(text, text.indexOf('/ b')), false);
});

test('brace kinds separate object literals from blocks', () => {
    assert.equal(_jsBraceKindAt('const x = {}', 10), 'object');
    assert.equal(_jsBraceKindAt('call({})', 5), 'object');
    assert.equal(_jsBraceKindAt('return {}', 7), 'object');
    // Property value: the scanner passes the ENCLOSING brace kind, which is
    // what separates `{ key: {…} }` from a labeled block.
    assert.equal(_jsBraceKindAt('const y = { a: {} }', 15, null, 'object'), 'object');
    // Grammatical position, not a character list: unary `!` and binary `-`.
    assert.equal(_jsBraceKindAt('!{}', 1), 'object');
    assert.equal(_jsBraceKindAt('1 - {}', 4), 'object');
    assert.equal(_jsBraceKindAt('function f() {}', 13), 'block');
    assert.equal(_jsBraceKindAt('const f = () => {}', 16), 'block');
    assert.equal(_jsBraceKindAt('if (x) {}', 7), 'block');
    assert.equal(_jsBraceKindAt('do {} while (x)', 3), 'block');
    assert.equal(_jsBraceKindAt('if (x) {} else {}', 15), 'block');
});

test('object-literal divisions after ! and - do not swallow the rest of the file', () => {
    for (const body of ['!{} / 2;', '1 - {} / 2;']) {
        const rel = 'probe-op.mjs';
        const text = `function f(){ ${body} } outside();\n`;
        const node = {
            rel,
            abs: rel,
            lang: 'javascript',
            fingerprint: '',
            symbols: [],
            topLevelTypes: [],
            resolvedImports: [],
            rawImports: [],
        };
        const graph = {
            nodes: new Map([[rel, node]]),
            reverse: new Map(),
            _sourceTextCache: new Map([[rel, { fingerprint: '', text }]]),
            _sourceLinesCache: new Map(),
            _maskedLinesCache: new Map(),
        };
        const rows = _extractCallees(
            graph,
            { rel, lang: 'javascript', line: 1, col: 1, declarationLike: true },
            '.',
            { callerSymbol: 'f' },
        );
        assert.deepEqual(rows.map((row) => row.name), [], `body: ${body}`);
    }
});

test('a labeled block is a block, an object property and a ternary are values', () => {
    assert.equal(_jsBraceKindAt('label: {}', 7, null, 'block'), 'block');
    assert.equal(_jsBraceKindAt('({ key: {} })', 8, null, 'object'), 'object');
    assert.equal(_jsBraceKindAt('const v = c ? a : {};', 18, null, 'block'), 'object');
});

test('a case label with a ternary expression still opens a block', () => {
    const src = 'switch (v) { case c ? a : b: {} }';
    assert.equal(_jsBraceKindAt(src, src.indexOf('{}'), null, 'block'), 'block');
    const plain = 'switch (v) { case 1: {} }';
    assert.equal(_jsBraceKindAt(plain, plain.indexOf('{}'), null, 'block'), 'block');
    const ternary = 'const v = c ? a : {};';
    assert.equal(_jsBraceKindAt(ternary, ternary.indexOf('{}'), null, 'block'), 'object');
});

test('a case-label block keeps the callee behind it', () => {
    const rel = 'probe-case.mjs';
    const text = 'function f(){ switch (v) { case c ? a : b: {} /[}]/.test(x); tail(); } }\n';
    const node = {
        rel,
        abs: rel,
        lang: 'javascript',
        fingerprint: '',
        symbols: [],
        topLevelTypes: [],
        resolvedImports: [],
        rawImports: [],
    };
    const graph = {
        nodes: new Map([[rel, node]]),
        reverse: new Map(),
        _sourceTextCache: new Map([[rel, { fingerprint: '', text }]]),
        _sourceLinesCache: new Map(),
        _maskedLinesCache: new Map(),
    };

    const names = _extractCallees(
        graph,
        { rel, lang: 'javascript', line: 1, col: 1, declarationLike: true },
        '.',
        { callerSymbol: 'f' },
    ).map((row) => row.name);
    assert.ok(names.includes('tail'), `expected 'tail' in ${JSON.stringify(names)}`);
});

test('a labeled block keeps the regex after it and the calls behind it', () => {
    const rel = 'probe-label.mjs';
    const text = 'function f(){ label: {} /[}]/.test(x); inside(); }\n';
    const node = {
        rel,
        abs: rel,
        lang: 'javascript',
        fingerprint: '',
        symbols: [],
        topLevelTypes: [],
        resolvedImports: [],
        rawImports: [],
    };
    const graph = {
        nodes: new Map([[rel, node]]),
        reverse: new Map(),
        _sourceTextCache: new Map([[rel, { fingerprint: '', text }]]),
        _sourceLinesCache: new Map(),
        _maskedLinesCache: new Map(),
    };

    const rows = _extractCallees(
        graph,
        { rel, lang: 'javascript', line: 1, col: 1, declarationLike: true },
        '.',
        { callerSymbol: 'f' },
    );
    const names = rows.map((row) => row.name);
    assert.ok(names.includes('test'), `expected 'test' in ${JSON.stringify(names)}`);
    assert.ok(names.includes('inside'), `expected 'inside' in ${JSON.stringify(names)}`);
});

test('a multiline object-literal division does not swallow the rest of the file', () => {
    // Probe: the `/` sits on its own line after `{}`. A line-break heuristic
    // reads it as a regex, runs past the closing brace and attributes the
    // following top-level call as a callee of f.
    const rel = 'probe.mjs';
    const text = 'function f(){ const x = {}\n/ 2; } outside();\n';
    const node = {
        rel,
        abs: rel,
        lang: 'javascript',
        fingerprint: '',
        symbols: [],
        topLevelTypes: [],
        resolvedImports: [],
        rawImports: [],
    };
    const graph = {
        nodes: new Map([[rel, node]]),
        reverse: new Map(),
        _sourceTextCache: new Map([[rel, { fingerprint: '', text }]]),
        _sourceLinesCache: new Map(),
        _maskedLinesCache: new Map(),
    };

    // The discriminator: a bare line break says "regex", the tracked brace
    // kind says "division". The scanner uses the tracked kind.
    assert.equal(_atJsRegexPosition(text, text.indexOf('/ 2')), true);
    assert.equal(_atJsRegexPosition(text, text.indexOf('/ 2'), 'object'), false);

    const rows = _extractCallees(
        graph,
        { rel, lang: 'javascript', line: 1, col: 1, declarationLike: true },
        '.',
        { callerSymbol: 'f' },
    );
    assert.deepEqual(rows.map((row) => row.name), []);
});
