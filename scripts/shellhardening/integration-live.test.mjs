import test from 'node:test';
import assert from 'node:assert/strict';
import {
  os,
  fs,
  path,
  spawnSync,
  executeBashTool,
  mkdtempSync,
  rmSync,
  writeFileSync,
  tmpdir,
  join,
  normalizeToolEnvelope,
  hasCmd,
} from './_shared.mjs';


test('integration: live pwsh no-match search head (findstr) exits 1', (t) => {
    if (process.platform !== 'win32') return t.skip('win32-only');
    if (!hasCmd('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'])) {
        return t.skip('pwsh not installed');
    }
    // findstr is a native no-match=exit-1 search head (unlike the Select-String
    // cmdlet, which never sets a nonzero exit code). Run it through a fresh pwsh
    // to confirm the exit-1 premise A relies on holds for a `_SEARCH_HEADS`
    // command in the real host.
    const r = spawnSync('pwsh', [
        '-NoProfile', '-Command',
        "'aaa' | findstr zzz; exit $LASTEXITCODE",
    ], { encoding: 'utf8' });
    assert.equal(r.status, 1, 'findstr with no match must exit 1');
});

test('integration: shell keeps a failed PowerShell pipeline producer exit', {
    skip: process.platform !== 'win32',
}, async () => {
    const result = normalizeToolEnvelope(await executeBashTool({
        command: `node -e 'process.stdout.write("producer-failed"); process.exit(7)' 2>&1 | Select-String impossible`,
        timeout_ms: 10_000,
    }, process.cwd()));
    assert.match(result.result, /^\[exit code: 7\]/);
    assert.match(result.result, /filter-swallowed output rescue/);
    assert.match(result.result, /producer-failed/);
});

test('integration: live git diff --quiet on a dirty repo exits 1', (t) => {
    if (process.platform !== 'win32') return t.skip('win32-only');
    if (!hasCmd('git', ['--version'])) return t.skip('git not installed');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdog-difftest-'));
    try {
        const run = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
        run(['init', '-q']);
        run(['config', 'user.email', 't@t']);
        run(['config', 'user.name', 't']);
        const f = path.join(dir, 'f.txt');
        fs.writeFileSync(f, 'one\n');
        run(['add', '-A']);
        run(['commit', '-q', '-m', 'init']);
        // introduce an unstaged change → `git diff --quiet` signals exit 1.
        fs.writeFileSync(f, 'two\n');
        const r = run(['diff', '--quiet']);
        assert.equal(r.status, 1, 'git diff --quiet on a dirty tree must exit 1');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
