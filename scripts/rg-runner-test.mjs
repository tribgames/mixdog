import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
    _resolveRgExecutable,
    _rgEagainRetryArgs,
    _rgThreadCap,
    _withRgThreads,
    ensureRgResolved,
    rgSupportsPcre2,
} from '../src/runtime/agent/orchestrator/tools/builtin/rg-runner.mjs';

function makeRgFile(path) {
    writeFileSync(path, '');
    if (process.platform !== 'win32') chmodSync(path, 0o755);
}

test('rg resolver prefers direct current-directory/PATH search over where/which', async () => {
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-rg-'));
    const pathDir = join(dir, 'path');
    mkdirSync(pathDir);
    const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const current = join(dir, name);
    const fromPath = join(pathDir, name);
    makeRgFile(current);
    makeRgFile(fromPath);
    try {
        process.chdir(dir);
        process.env.PATH = pathDir;
        assert.equal(await _resolveRgExecutable(), process.platform === 'win32' ? current : fromPath);
        assert.ok(isAbsolute(await _resolveRgExecutable()));
    } finally {
        process.chdir(originalCwd);
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('rg resolver honors PATH order when no current-directory executable exists', async () => {
    const originalPath = process.env.PATH;
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-rg-'));
    const first = join(dir, 'first');
    const second = join(dir, 'second');
    mkdirSync(first);
    mkdirSync(second);
    const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const expected = join(second, name);
    makeRgFile(expected);
    try {
        process.env.PATH = `${first}${process.platform === 'win32' ? ';' : ':'}${second}`;
        assert.equal(await _resolveRgExecutable(), expected);
    } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('rg resolver makes relative PATH candidates absolute', async () => {
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-rg-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const expected = join(bin, name);
    makeRgFile(expected);
    try {
        process.chdir(dir);
        process.env.PATH = `.${process.platform === 'win32' ? ';' : ':'}bin`;
        const resolved = await _resolveRgExecutable();
        assert.equal(resolved, expected);
        assert.ok(isAbsolute(resolved));
    } finally {
        process.chdir(originalCwd);
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('rg resolver skips directories and non-executable POSIX files', async () => {
    const originalPath = process.env.PATH;
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-rg-'));
    const bad = join(dir, 'bad');
    const good = join(dir, 'good');
    mkdirSync(bad);
    mkdirSync(good);
    const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const nonExecutable = join(bad, name);
    const expected = join(good, name);
    if (process.platform === 'win32') mkdirSync(nonExecutable);
    else writeFileSync(nonExecutable, '');
    makeRgFile(expected);
    try {
        process.env.PATH = `${bad}${process.platform === 'win32' ? ';' : ':'}${good}`;
        assert.equal(await _resolveRgExecutable(), expected);
    } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('rg resolver rejects Windows command wrappers', async (t) => {
    if (process.platform !== 'win32') {
        t.skip('Windows spawn resolution only');
        return;
    }
    const originalPath = process.env.PATH;
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-rg-'));
    writeFileSync(join(dir, 'rg.cmd'), '@echo off\r\n');
    try {
        process.env.PATH = dir;
        assert.notEqual(await _resolveRgExecutable(), join(dir, 'rg.cmd'));
    } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('rg resolver preserves empty PATH components as current-directory entries', async () => {
    const originalCwd = process.cwd();
    const originalPath = process.env.PATH;
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-rg-'));
    const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const expected = join(dir, name);
    makeRgFile(expected);
    try {
        process.chdir(dir);
        process.env.PATH = process.platform === 'win32' ? `;${dir}` : `:${dir}`;
        assert.equal(await _resolveRgExecutable(), expected);
    } finally {
        process.chdir(originalCwd);
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('rg resolver invalidates cached executable when PATH or file usability changes', async () => {
    const originalPath = process.env.PATH;
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-rg-'));
    const firstDir = join(dir, 'first');
    const secondDir = join(dir, 'second');
    mkdirSync(firstDir);
    mkdirSync(secondDir);
    const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const first = join(firstDir, name);
    const second = join(secondDir, name);
    makeRgFile(first);
    makeRgFile(second);
    try {
        process.env.PATH = firstDir;
        assert.equal(await ensureRgResolved(), first);
        process.env.PATH = secondDir;
        assert.equal(await ensureRgResolved(), second);
        if (process.platform === 'win32') rmSync(second);
        else chmodSync(second, 0o644);
        assert.notEqual(await ensureRgResolved(), second);
        if (process.platform !== 'win32') rmSync(second);
    } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('bare rg fallback is probed again after it becomes usable', async () => {
    const originalPath = process.env.PATH;
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-rg-'));
    try {
        process.env.PATH = dir;
        assert.equal(await ensureRgResolved(), 'rg');
        const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
        makeRgFile(join(dir, name));
        assert.notEqual(await ensureRgResolved(), 'rg');
    } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('PCRE2 capability cache follows the resolved executable', async (t) => {
    if (process.platform === 'win32') {
        t.skip('portable executable fixture unavailable on Windows');
        return;
    }
    const originalPath = process.env.PATH;
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-rg-'));
    const firstDir = join(dir, 'first');
    const secondDir = join(dir, 'second');
    mkdirSync(firstDir);
    mkdirSync(secondDir);
    const first = join(firstDir, 'rg');
    const second = join(secondDir, 'rg');
    writeFileSync(first, '#!/bin/sh\nprintf "PCRE2 10.40\\n"\n');
    writeFileSync(second, '#!/bin/sh\nexit 1\n');
    chmodSync(first, 0o755);
    chmodSync(second, 0o755);
    try {
        process.env.PATH = firstDir;
        assert.equal(await rgSupportsPcre2(), true);
        process.env.PATH = secondDir;
        assert.equal(await rgSupportsPcre2(), false);
    } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('rg thread cap honors the environment override', () => {
    const original = process.env.MIXDOG_RG_THREADS;
    try {
        process.env.MIXDOG_RG_THREADS = '7.9';
        assert.equal(_rgThreadCap(), 7);
        process.env.MIXDOG_RG_THREADS = '0';
        assert.ok(_rgThreadCap() >= 2);
    } finally {
        if (original === undefined) delete process.env.MIXDOG_RG_THREADS;
        else process.env.MIXDOG_RG_THREADS = original;
    }
});

test('rg treats a -e --threads pattern as a pattern during injection and retry', () => {
    const args = ['-e', '--threads', 'needle'];
    const injected = _withRgThreads(args);
    assert.equal(injected[0], '--threads');
    assert.equal(injected[2], '-e');
    assert.deepEqual(injected.slice(3), ['--threads', 'needle']);
    assert.deepEqual(_rgEagainRetryArgs(args), ['-j', '1', '-e', '--threads', 'needle']);
});
