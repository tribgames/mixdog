import assert from 'node:assert/strict';
import test from 'node:test';
import { toDisplayPath } from './path-utils.mjs';

test('toDisplayPath strips a cwd prefix without changing unmatched absolute paths', () => {
    assert.equal(toDisplayPath(''), '');
    assert.equal(toDisplayPath('C:/proj/src/a.ts', 'C:/proj'), 'src/a.ts');
    assert.equal(toDisplayPath('C:\\proj\\src\\a.ts', 'C:/proj/'), 'src/a.ts');
    assert.equal(toDisplayPath('C:/proj', 'C:/proj'), '');
    assert.equal(toDisplayPath('C:/other/a.ts', 'C:/proj'), 'C:/other/a.ts');
    assert.equal(toDisplayPath('C:/proj/src/a.ts'), 'C:/proj/src/a.ts');
});

test('toDisplayPath matches Windows drive-letter casing', () => {
    assert.equal(toDisplayPath('c:/proj/src/a.ts', 'C:/PROJ'), 'src/a.ts');
});
