// A file scope the shared native search server could not serve is answered by
// reading that one file, so a starved queue costs a bounded wait instead of a
// whole turn. The scanner declines whenever it cannot reproduce the request.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runGrepSingleFileRescue } from './lib/grep-single-file-rescue.mjs';

const STATUS = 'Name:\tnode\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nCapEff:\t000001ffffffffff\n';

function request(overrides) {
    return {
        caseInsensitive: false,
        multilineMode: false,
        onlyMatching: false,
        fileType: null,
        outputMode: 'content',
        showLineNumbers: true,
        withFilename: false,
        filenameOmitted: true,
        beforeN: 0,
        afterN: 0,
        contextN: 0,
        headLimit: 250,
        offset: 0,
        patternCapNote: '',
        globPatterns: [],
        ...overrides,
    };
}

async function withStatusFile(run) {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-grep-rescue-'));
    try {
        const file = join(root, 'status');
        await writeFile(file, STATUS);
        return await run({ root, file });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test('a missed file scope is scanned directly and reports the same matches', async () => {
    await withStatusFile(async ({ root, file }) => {
        const out = await runGrepSingleFileRescue(request({
            filePath: file,
            searchPath: file,
            grepResolvedPath: file,
            workDir: root,
            patterns: ['^(Uid|Gid|Cap(Inh|Prm|Eff|Bnd|Amb))'],
        }));
        assert.match(out, /2:Uid:/);
        assert.match(out, /3:Gid:/);
        assert.match(out, /4:CapEff:/);
        assert.doesNotMatch(out, /Name:/);
        assert.match(out, /scanned directly/);
    });
});

test('counts and no-match answers keep the ordinary grep shapes', async () => {
    await withStatusFile(async ({ root, file }) => {
        const counted = await runGrepSingleFileRescue(request({
            filePath: file,
            searchPath: file,
            grepResolvedPath: file,
            workDir: root,
            outputMode: 'count',
            patterns: ['^(Uid|Gid)'],
        }));
        assert.match(counted, /\b2\b/);

        const empty = await runGrepSingleFileRescue(request({
            filePath: file,
            searchPath: file,
            grepResolvedPath: file,
            workDir: root,
            patterns: ['NoSuchFieldHere'],
        }));
        assert.match(empty, /\(no matches\)/);
    });
});

test('a request the scanner cannot reproduce declines instead of guessing', async () => {
    await withStatusFile(async ({ root, file }) => {
        const base = {
            filePath: file,
            searchPath: file,
            grepResolvedPath: file,
            workDir: root,
        };
        // Regex JS cannot compile: the caller keeps the native error.
        assert.equal(await runGrepSingleFileRescue(request({
            ...base,
            patterns: ['a{2,1}'],
        })), null);
        // Multiline matching spans lines; this scanner is line-oriented.
        assert.equal(await runGrepSingleFileRescue(request({
            ...base,
            patterns: ['Uid'],
            multilineMode: true,
        })), null);
    });
});
