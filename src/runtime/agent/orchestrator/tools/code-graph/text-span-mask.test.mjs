import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _inferSpanEndByIndent } from './span.mjs';
import { _maskNonCodeText } from './text-mask.mjs';

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

