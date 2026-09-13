import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeGrepTool } from './search-grep-tool.mjs';
import { validateBuiltinArgs } from './arg-guard.mjs';

test('grep rejects non-boolean scope options instead of silently widening the search', () => {
    for (const key of ['include_noise', 'text']) {
        assert.match(validateBuiltinArgs('grep', { pattern: 'needle', [key]: 'true' }), /must be a boolean/);
        assert.equal(validateBuiltinArgs('grep', { pattern: 'needle', [key]: false }), null);
    }
});

test('grep scope opt-ins preserve ignored files, binary matches, exclusions and cache isolation', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-grep-scope-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const dir of ['.git', 'ignored', 'node_modules/pkg']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'ignored/\n');
    writeFileSync(join(root, 'visible.txt'), 'needle visible\n');
    writeFileSync(join(root, 'ignored/item.txt'), 'needle ignored\n');
    writeFileSync(join(root, 'node_modules/pkg/item.txt'), 'needle dependency\n');
    writeFileSync(join(root, 'binary.dat'), Buffer.from('\0needle binary\n'));
    const search = async (args) => String(await executeGrepTool({
        pattern: 'needle', path: root, mode: 'files', limit: 100, ...args,
    }, root)).replaceAll('\\', '/');
    const before = await search({});
    assert.match(before, /visible\.txt/);
    assert.doesNotMatch(before, /ignored\/item|node_modules|binary\.dat/);
    const ignored = await search({ include_noise: true });
    assert.match(ignored, /ignored\/item\.txt/);
    assert.match(ignored, /node_modules\/pkg\/item\.txt/);
    assert.doesNotMatch(ignored, /binary\.dat/);
    const binary = await search({ text: true });
    assert.match(binary, /binary\.dat/);
    assert.doesNotMatch(binary, /ignored\/item|node_modules/);
    const all = await search({ include_noise: true, text: true });
    for (const file of ['visible.txt', 'ignored/item.txt', 'node_modules/pkg/item.txt', 'binary.dat']) {
        assert.ok(all.includes(file), `missing ${file}: ${all}`);
    }
    assert.equal(await search({ include_noise: false, text: false }), before);
    const excluded = await search({ include_noise: true, text: true, glob: '!ignored/**' });
    assert.doesNotMatch(excluded, /ignored\/item/);
    assert.match(excluded, /binary\.dat/);
    for (const args of [
        { pattern: ['needle', 'absent'], mode: 'content', context: 0 },
        { path: [join(root, 'ignored'), join(root, 'binary.dat')], mode: 'content', context: 0 },
        { mode: 'count' },
        { mode: 'content', context: 2 },
    ]) {
        const output = await search({ include_noise: true, text: true, ...args });
        assert.match(output, /binary\.dat/);
        assert.match(output, /item\.txt/);
        assert.doesNotMatch(output, /Error:|unsupported/);
    }
});
