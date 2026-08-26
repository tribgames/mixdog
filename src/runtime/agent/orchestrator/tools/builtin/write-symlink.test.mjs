// Writing through a symlink must land on the file the link points at and leave
// the link in place. The atomic rename would otherwise replace the link with a
// regular file and silently detach layouts like nginx's sites-enabled/default
// from sites-available/default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    lstatSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicWrite, symlinkWriteTarget } from './atomic-write.mjs';
import { tryExecuteExternalToolAdapter } from './external-tool-adapters.mjs';

function makeDir() {
    return mkdtempSync(join(tmpdir(), 'mixdog-write-symlink-'));
}

// Windows without Developer Mode / admin rights refuses symlink creation
// (EPERM), so the host capability decides whether these cases can run.
function symlinkSupported(dir) {
    try {
        writeFileSync(join(dir, 'probe.txt'), 'x');
        symlinkSync(join(dir, 'probe.txt'), join(dir, 'probe.link'));
        return true;
    } catch {
        return false;
    }
}

test('symlinkWriteTarget resolves a live link and nothing else', (t) => {
    const dir = makeDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    if (!symlinkSupported(dir)) {
        t.skip('symlink creation is not permitted on this host');
        return;
    }
    const real = join(dir, 'real.txt');
    const link = join(dir, 'link.txt');
    writeFileSync(real, 'a\n');
    symlinkSync(real, link);

    assert.equal(symlinkWriteTarget(link), realpathSync(real));
    assert.equal(symlinkWriteTarget(real), null);
    assert.equal(symlinkWriteTarget(join(dir, 'missing.txt')), null);
    // A dangling link has no target to resolve, so the caller keeps its path.
    const dangling = join(dir, 'dangling.link');
    symlinkSync(join(dir, 'gone.txt'), dangling);
    assert.equal(symlinkWriteTarget(dangling), null);
});

test('atomicWrite writes through a symlink and keeps the link', async (t) => {
    const dir = makeDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    if (!symlinkSupported(dir)) {
        t.skip('symlink creation is not permitted on this host');
        return;
    }
    const real = join(dir, 'real.conf');
    const link = join(dir, 'link.conf');
    writeFileSync(real, 'old\n');
    symlinkSync(real, link);

    await atomicWrite(link, 'new\n');

    assert.equal(readFileSync(real, 'utf8'), 'new\n');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
});

test('the expected-target guard still fires when the real file moved', async (t) => {
    const dir = makeDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    if (!symlinkSupported(dir)) {
        t.skip('symlink creation is not permitted on this host');
        return;
    }
    const real = join(dir, 'guard.conf');
    const link = join(dir, 'guard.link');
    writeFileSync(real, 'old\n');
    symlinkSync(real, link);
    const before = statSync(link);

    // Somebody else rewrites the real file after the snapshot was taken.
    writeFileSync(real, 'rewritten by another writer\n');

    await assert.rejects(
        () => atomicWrite(link, 'mine\n', {
            expectedTargetSnapshot: {
                exists: true,
                size: before.size,
                mtimeMs: before.mtimeMs,
                ctimeMs: before.ctimeMs,
                ino: before.ino,
            },
        }),
        (err) => err?.code === 'ESTALE_TARGET',
    );
    assert.equal(readFileSync(real, 'utf8'), 'rewritten by another writer\n');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
});

test('edit updates through a symlink and keeps the link', async (t) => {
    const dir = makeDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    if (!symlinkSupported(dir)) {
        t.skip('symlink creation is not permitted on this host');
        return;
    }
    const real = join(dir, 'sites-available.conf');
    const link = join(dir, 'sites-enabled.conf');
    writeFileSync(real, 'root /var/www/html;\nindex index.html;\n');
    symlinkSync(real, link);

    const result = String(await tryExecuteExternalToolAdapter('edit', {
        file_path: link,
        old_string: 'root /var/www/html;',
        new_string: 'root /usr/share/novnc;',
    }, dir, {}));

    assert.match(result, /^Updated /);
    assert.equal(readFileSync(real, 'utf8'), 'root /usr/share/novnc;\nindex index.html;\n');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
});

test('write replaces content through a symlink and keeps the link', async (t) => {
    const dir = makeDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    if (!symlinkSupported(dir)) {
        t.skip('symlink creation is not permitted on this host');
        return;
    }
    const real = join(dir, 'payload.txt');
    const link = join(dir, 'payload.link');
    writeFileSync(real, 'old\n');
    symlinkSync(real, link);

    const result = String(await tryExecuteExternalToolAdapter('write', {
        file_path: link,
        contents: 'fresh\n',
    }, dir, {}));

    assert.match(result, /^Updated /);
    assert.equal(readFileSync(real, 'utf8'), 'fresh\n');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
});
