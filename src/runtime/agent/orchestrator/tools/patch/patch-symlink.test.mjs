// apply_patch through a symlink. The TOCTOU snapshot has to follow the link
// exactly the way atomicWrite does; an lstat of the link inode never matches
// the followed stat, which rejected every such patch as "changed on disk".
// The link itself must also survive the atomic rename.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executePatchTool } from '../patch.mjs';
import { closeNativePatchServerForTests } from './native-server.mjs';

// Windows without Developer Mode / admin rights refuses symlink creation
// (EPERM), so the host capability decides whether this case can run at all.
function symlinkSupported(dir) {
    try {
        writeFileSync(join(dir, 'probe.txt'), 'x');
        symlinkSync(join(dir, 'probe.txt'), join(dir, 'probe.link'));
        return true;
    } catch {
        return false;
    }
}

const asHeaderPath = (p) => p.replace(/\\/g, '/');

test('apply_patch updates a symlinked file through the link', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-patch-symlink-'));
    t.after(() => {
        rmSync(dir, { recursive: true, force: true });
        void closeNativePatchServerForTests?.();
    });
    if (!symlinkSupported(dir)) {
        t.skip('symlink creation is not permitted on this host');
        return;
    }
    // Target outside base_path — the shape that routes to the JS writer, and
    // the exact shape of the nginx sites-enabled/default case from the bench.
    const base = join(dir, 'app');
    mkdirSync(base);
    const real = join(dir, 'sites-available.conf');
    const link = join(dir, 'sites-enabled.conf');
    writeFileSync(real, 'root /var/www/html;\nindex index.html;\n');
    symlinkSync(real, link);

    const result = String(await executePatchTool('apply_patch', {
        base_path: base,
        patch: `*** Begin Patch
*** Update File: ${asHeaderPath(link)}
@@
-root /var/www/html;
+root /usr/share/novnc;
 index index.html;
*** End Patch
`,
    }, base, {}));

    assert.doesNotMatch(result, /^Error/);
    assert.doesNotMatch(result, /changed on disk/);
    assert.equal(readFileSync(real, 'utf8'), 'root /usr/share/novnc;\nindex index.html;\n');
    assert.equal(readFileSync(link, 'utf8'), 'root /usr/share/novnc;\nindex index.html;\n');
    // The link is still a link: the write landed on its target, not on top of it.
    assert.equal(lstatSync(link).isSymbolicLink(), true);
});

test('an in-base symlinked target is patched through the link', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-patch-symlink-'));
    t.after(() => {
        rmSync(dir, { recursive: true, force: true });
        void closeNativePatchServerForTests?.();
    });
    if (!symlinkSupported(dir)) {
        t.skip('symlink creation is not permitted on this host');
        return;
    }
    // Inside base_path the native engine would normally take this entry; a
    // symlinked target has to be routed to the JS writer instead, because the
    // engine renames its output over the path it was handed.
    const real = join(dir, 'real.conf');
    const link = join(dir, 'link.conf');
    writeFileSync(real, 'keep\nold\n');
    symlinkSync(real, link);

    const result = String(await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Update File: link.conf
@@
 keep
-old
+new
*** End Patch
`,
    }, dir, {}));

    assert.doesNotMatch(result, /^Error/);
    assert.equal(readFileSync(real, 'utf8'), 'keep\nnew\n');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
});

test('a second patch through the same link still sees a fresh snapshot', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-patch-symlink-'));
    t.after(() => {
        rmSync(dir, { recursive: true, force: true });
        void closeNativePatchServerForTests?.();
    });
    if (!symlinkSupported(dir)) {
        t.skip('symlink creation is not permitted on this host');
        return;
    }
    const base = join(dir, 'app');
    mkdirSync(base);
    const real = join(dir, 'real.conf');
    const link = join(dir, 'link.conf');
    writeFileSync(real, 'a\nb\n');
    symlinkSync(real, link);

    const patch = (from, to) => `*** Begin Patch
*** Update File: ${asHeaderPath(link)}
@@
-${from}
+${to}
 b
*** End Patch
`;
    const first = String(await executePatchTool('apply_patch', { base_path: base, patch: patch('a', 'A') }, base, {}));
    assert.doesNotMatch(first, /^Error/);
    const second = String(await executePatchTool('apply_patch', { base_path: base, patch: patch('A', 'AA') }, base, {}));
    assert.doesNotMatch(second, /^Error/);
    assert.equal(readFileSync(real, 'utf8'), 'AA\nb\n');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
});
