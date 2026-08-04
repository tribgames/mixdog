// Regression tests for the 2026-08-02 shell/apply_patch harness fixes:
//  1. pwsh standby pool flushes formatted object output BEFORE the done
//     sentinel (Format-Table buffering swallowed captures — measured live).
//  2. compacted patch markers name the files the patch touched, so a model
//     re-reads them instead of replaying the marker as patch input.
//  3. detectBlockedSleepPattern is exported and matches the leading
//     sleep-chain shapes bash-tool auto-promotes to background tasks.
//  4. V4A context-tolerance tier: unique window, exact deletions, <=2 drifted
//     context lines applied with the FILE's version of drifted context.
//  5. pwsh standby isolates leaked global functions/variables/aliases
//     between commands (daemon-global pool = cross-session surface).
//  6. shell-typed `apply_patch` invocations (codex habit) are extracted for
//     routing to the internal patch engine instead of "command not found".
//  7. successful patches append a numbered post-patch excerpt of the changed
//     span so follow-up patches have byte-exact context without a read turn.
//  8. buildPowerShellFilterTeePlan inserts a Tee-Object spill ONLY for the
//     exactly-recognized producer|filter… pipeline shape (filter-swallowed
//     `(no output)` failures), and consumeFilterTeeCapture reads+deletes it.
//  9. detectLongForegroundReason flags watch-like/long-sleep commands for
//     auto-async promotion instead of the old hard deny.
// 10. acquireShellLeaseBounded retries transient memory-pressure rejections
//     inside the admission deadline instead of failing the call instantly.
// Run: npm run test:shell-harness
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { takePwshStandby } from '../src/runtime/agent/orchestrator/tools/lib/pwsh-standby-pool.mjs';
import { compactToolCallsForHistory } from '../src/runtime/agent/orchestrator/session/loop/stored-tool-args.mjs';
import {
    buildPowerShellFilterTeePlan,
    consumeFilterTeeCapture,
    detectBlockedSleepPattern,
    detectLongForegroundReason,
    extractShellApplyPatchInvocation,
} from '../src/runtime/agent/orchestrator/tools/builtin/shell-analysis.mjs';
import { acquireShellLeaseBounded } from '../src/runtime/agent/orchestrator/tools/shell-command.mjs';
import { parseV4APatch } from '../src/runtime/agent/orchestrator/tools/patch/parsing.mjs';
import { splitTextLinesForPatch } from '../src/runtime/agent/orchestrator/tools/patch/matcher.mjs';
import { applyV4AHunksToLines } from '../src/runtime/agent/orchestrator/tools/patch/v4a-convert.mjs';
import { appendPostPatchExcerpts } from '../src/runtime/agent/orchestrator/tools/patch/orchestrator.mjs';

function v4aHunksFor(patchLines) {
    const [section] = parseV4APatch(['*** Begin Patch', ...patchLines, '*** End Patch'].join('\n'));
    return section.hunks;
}

test('V4A context tolerance applies a unique window with one drifted context line', () => {
    const src = splitTextLinesForPatch('alpha line one\nfunction helperOne(arg, extra) {\n  remove me\nbeta line two\ntail line\n');
    const hunks = v4aHunksFor([
        '*** Update File: t.txt',
        ' function helperOne(arg) {',
        '-  remove me',
        '+  replaced line',
        ' beta line two',
    ]);
    const out = applyV4AHunksToLines(src, hunks, { fuzzy: true });
    assert.equal(
        out.join('\n'),
        'alpha line one\nfunction helperOne(arg, extra) {\n  replaced line\nbeta line two\ntail line',
        'drifted context keeps the FILE version; only the deletion is replaced',
    );
});

test('V4A context tolerance rejects a drifted deletion line', () => {
    const src = splitTextLinesForPatch('function helperOne(arg, extra) {\n  remove me\nbeta line two\n');
    const hunks = v4aHunksFor([
        '*** Update File: t.txt',
        ' function helperOne(arg, extra) {',
        '-  remove me!',
        '+  replaced line',
        ' beta line two',
    ]);
    assert.throws(() => applyV4AHunksToLines(src, hunks, { fuzzy: true }), /context not found/);
});

test('V4A context tolerance rejects ambiguous duplicate windows', () => {
    const src = splitTextLinesForPatch([
        'ctx one(arg, extra) {', '  remove me', 'shared tail',
        'ctx one(arg, other) {', '  remove me', 'shared tail', '',
    ].join('\n'));
    const hunks = v4aHunksFor([
        '*** Update File: t.txt',
        ' ctx one(arg) {',
        '-  remove me',
        '+  replaced',
        ' shared tail',
    ]);
    assert.throws(() => applyV4AHunksToLines(src, hunks, { fuzzy: true }), /context not found/);
});

test('compacted patch marker names its target files', () => {
    const filler = `+${'x'.repeat(96)}\n`.repeat(120);
    const patch = `*** Begin Patch\n*** Update File: src/foo/alpha.mjs\n@@\n${filler}*** Add File: src/foo/beta.tsx\n${filler}*** End Patch\n`;
    assert.ok(patch.length > 10_000, 'fixture must exceed the compaction limit');
    const [call] = compactToolCallsForHistory([
        { id: 'c1', name: 'apply_patch', arguments: { patch } },
    ]);
    const marker = call.arguments.patch;
    assert.match(marker, /^\[mixdog compacted patch:[^\]\n]*\]$/, 'marker keeps the no-]/no-newline contract');
    assert.ok(marker.includes('src/foo/alpha.mjs'), 'marker lists first touched file');
    assert.ok(marker.includes('src/foo/beta.tsx'), 'marker lists second touched file');
    assert.ok(marker.includes('re-read'), 'marker keeps the recovery instruction');
});

test('unified-diff patch marker falls back to +++/--- paths', () => {
    const filler = `+${'y'.repeat(96)}\n`.repeat(120);
    const patch = `--- a/lib/gamma.mjs\n+++ b/lib/gamma.mjs\n@@ -1,2 +1,2 @@\n${filler}`;
    assert.ok(patch.length > 10_000);
    const [call] = compactToolCallsForHistory([
        { id: 'c2', name: 'apply_patch', arguments: { patch } },
    ]);
    assert.ok(call.arguments.patch.includes('lib/gamma.mjs'), 'unified paths extracted');
});

test('leading sleep chains are detected for auto-async promotion', () => {
    assert.ok(detectBlockedSleepPattern('sleep 3; echo hi'), 'posix sleep chain');
    assert.ok(detectBlockedSleepPattern('Start-Sleep -Seconds 12; Get-Content x.log'), 'PS Start-Sleep chain');
    assert.ok(detectBlockedSleepPattern('sleep 300'), 'standalone long sleep');
    assert.equal(detectBlockedSleepPattern('sleep 0.5 && echo ok'), null, 'sub-2s float sleep passes');
    assert.equal(detectBlockedSleepPattern('echo hi; sleep 5'), null, 'non-leading sleep passes');
});

test('watch-like/long-sleep commands are flagged for auto-async promotion', () => {
    assert.ok(detectLongForegroundReason('npm run dev'), 'watch-like dev server');
    assert.ok(detectLongForegroundReason('gh run watch 123'), 'gh run watch');
    assert.ok(detectLongForegroundReason('Get-Content x.log; Start-Sleep -Seconds 45; Get-Content y.log'), 'mid-chain long PS sleep');
    assert.equal(detectLongForegroundReason('npm run build'), null, 'plain build passes');
    assert.equal(detectLongForegroundReason('Start-Sleep -Seconds 5; ls'), null, 'short sleep passes');
});

test('filter-swallowed PS pipelines get a tee plan only in the exact shape', () => {
    const plan = buildPowerShellFilterTeePlan("cd C:\\x; npm run test 2>&1 | Select-String -Pattern 'not ok' | Select-Object -First 5");
    assert.ok(plan, 'canonical filter pipeline gets a plan');
    assert.ok(plan.command.startsWith('cd C:\\x; npm run test 2>&1 | Tee-Object -FilePath '), 'tee inserted after the producer, head preserved verbatim');
    assert.match(plan.command, /\| Tee-Object -FilePath '[^']+' \| Select-String -Pattern 'not ok' \| Select-Object -First 5$/, 'filter stages preserved after the tee');
    assert.equal(buildPowerShellFilterTeePlan('npm run test'), null, 'no pipeline → no plan');
    assert.equal(buildPowerShellFilterTeePlan('Select-String foo bar.txt | Select-Object -First 2'), null, 'filter-headed producer skipped');
    assert.equal(buildPowerShellFilterTeePlan('npm test 2>&1 | ForEach-Object { $($_.Line) }'), null, 'subexpression syntax bails');
    assert.equal(buildPowerShellFilterTeePlan('npm test > out.log | Select-String x'), null, 'file redirect bails');
    assert.equal(buildPowerShellFilterTeePlan('npm test 2>&1 | Tee-Object -FilePath a.log | Select-String x'), null, 'existing tee bails');
    assert.equal(buildPowerShellFilterTeePlan('npm test 2>&1 | Sort-Object | Select-String x'), null, 'unknown middle stage bails');
});

test('consumeFilterTeeCapture reads utf8/utf16 tails and deletes the file', () => {
    const p = join(tmpdir(), `mixdog-tee-test-${Date.now()}.log`);
    writeFileSync(p, 'not ok 1 - failed\n# detail line\n');
    assert.match(consumeFilterTeeCapture(p), /not ok 1 - failed/, 'utf8 tail read');
    assert.equal(existsSync(p), false, 'file deleted after consume');
    writeFileSync(p, '\ufefffailure tail utf16', { encoding: 'utf16le' });
    assert.match(consumeFilterTeeCapture(p), /failure tail utf16/, 'utf16 (BOM) tail read');
    assert.equal(existsSync(p), false, 'utf16 file deleted after consume');
    assert.equal(consumeFilterTeeCapture(p), null, 'missing file yields null');
});

test('shell lease acquisition retries transient memory pressure within the deadline', async () => {
    let calls = 0;
    const fake = {
        acquire: async () => {
            calls++;
            if (calls < 3) {
                const e = new Error('resource pressure: host free memory 500 MB is below 1024 MB minimum; retry after memory recovers');
                e.code = 'ERESOURCEPRESSURE';
                e.metric = 'free-memory';
                throw e;
            }
            return { released: false, signal: null, release: async () => {} };
        },
        snapshot: () => ({ active: { shell: 0 }, limits: { maxShells: Infinity }, queued: 0, activeLeases: [] }),
    };
    const lease = await acquireShellLeaseBounded(fake, { abortSignal: null, label: 'mem-retry-test' });
    assert.ok(lease, 'lease granted after pressure clears');
    assert.equal(calls, 3, 'two pressure rejections were retried');
    const hardErr = new Error('resource pressure: high-load admission queue full (maximum 32)');
    hardErr.code = 'ERESOURCEQUEUEFULL';
    let hardCalls = 0;
    const fakeHard = {
        acquire: async () => { hardCalls++; throw hardErr; },
        snapshot: fake.snapshot,
    };
    await assert.rejects(
        () => acquireShellLeaseBounded(fakeHard, { abortSignal: null, label: 'queue-full-test' }),
        (err) => err === hardErr,
        'non-memory rejections throw immediately',
    );
    assert.equal(hardCalls, 1, 'queue-full is not retried');
});

test('shell-typed apply_patch invocations are extracted for engine routing', () => {
    const body = '*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y\n*** End Patch';
    assert.equal(
        extractShellApplyPatchInvocation(`apply_patch <<'EOF'\n${body}\nEOF`)?.patch,
        body,
        'heredoc form extracts the patch body',
    );
    assert.equal(
        extractShellApplyPatchInvocation(`apply_patch '${body}'`)?.patch,
        body,
        'single quoted-argument form extracts the patch body',
    );
    assert.equal(
        extractShellApplyPatchInvocation(`bash -lc 'apply_patch <<EOF\n${body}\nEOF'`)?.patch,
        body,
        'bash -lc wrapper is unwrapped first',
    );
    assert.equal(extractShellApplyPatchInvocation(body)?.patch, body, 'bare pasted patch routes directly');
    assert.equal(extractShellApplyPatchInvocation('git apply patch.diff'), null, 'unrelated commands pass through');
    assert.equal(extractShellApplyPatchInvocation('echo apply_patch'), null, 'non-leading token passes through');
    assert.ok(extractShellApplyPatchInvocation('apply_patch')?.error, 'missing patch body yields guidance error');
});

test('post-patch excerpt is repeat-gated and numbered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-postpatch-'));
    try {
        writeFileSync(join(dir, 'sample.txt'), 'top line\nkept context\nnew value\nbottom line\n');
        const patch = [
            '*** Begin Patch',
            '*** Update File: sample.txt',
            ' kept context',
            '-old value',
            '+new value',
            ' bottom line',
            '*** End Patch',
        ].join('\n');
        const scope = `test-scope-${Date.now()}-${Math.random()}`;
        const first = appendPostPatchExcerpts('OK Modify sample.txt', patch, '', dir, scope);
        assert.equal(first, 'OK Modify sample.txt', 'first patch of a file appends nothing (batched one-shot case)');
        const out = appendPostPatchExcerpts('OK Modify sample.txt', patch, '', dir, scope);
        assert.match(out, /post-patch state \(verbatim/, 'excerpt banner appended');
        assert.match(out, /sample\.txt lines 2-4/, 'excerpt names the changed span');
        assert.match(out, /3\| new value/, 'excerpt carries numbered current lines');
        assert.equal(
            appendPostPatchExcerpts('Error: nope', patch, '', dir, scope),
            'Error: nope',
            'error outputs stay untouched',
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('pwsh standby flushes formatted object output before the done marker', { skip: process.platform !== 'win32' }, async (t) => {
    const spec = {
        shell: 'pwsh.exe',
        shellArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
        env: { ...process.env },
    };
    let standby = takePwshStandby(spec);
    const warmDeadline = Date.now() + 8000;
    while (!standby && Date.now() < warmDeadline) {
        await delay(200);
        standby = takePwshStandby(spec);
    }
    if (!standby) {
        t.skip('no warm pwsh standby available (pwsh missing?)');
        return;
    }
    let out = '';
    standby.child.stdout.setEncoding('utf8');
    standby.child.stdout.on('data', (c) => { out += c; });
    standby.run('Get-ChildItem env: | Select-Object -First 3 Name', process.cwd());
    const doneDeadline = Date.now() + 15000;
    while (!out.includes(standby.doneMarkerPrefix) && Date.now() < doneDeadline) {
        await delay(100);
    }
    standby.endStdin();
    assert.ok(out.includes(standby.doneMarkerPrefix), 'done sentinel arrived');
    const body = out
        .split('\n')
        .filter((l) => !l.startsWith(standby.doneMarkerPrefix))
        .join('\n');
    assert.match(body, /Name/, 'table header flushed before sentinel');
    assert.match(body, /----/, 'table underline flushed before sentinel');
});

test('pwsh standby isolates leaked global state between commands', { skip: process.platform !== 'win32' }, async (t) => {
    const spec = {
        shell: 'pwsh.exe',
        shellArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
        env: { ...process.env },
    };
    let standby = takePwshStandby(spec);
    const warmDeadline = Date.now() + 8000;
    while (!standby && Date.now() < warmDeadline) {
        await delay(200);
        standby = takePwshStandby(spec);
    }
    if (!standby) {
        t.skip('no warm pwsh standby available (pwsh missing?)');
        return;
    }
    let out = '';
    standby.child.stdout.setEncoding('utf8');
    standby.child.stdout.on('data', (c) => { out += c; });
    const markerCount = () => out.split(standby.doneMarkerPrefix).length - 1;
    const waitMarkers = async (n) => {
        const deadline = Date.now() + 15000;
        while (markerCount() < n && Date.now() < deadline) await delay(100);
        assert.ok(markerCount() >= n, `done sentinel ${n} arrived`);
    };
    standby.run(
        "function global:MixLeakFn { 1 }; $global:MixLeakVar = 1; Set-Alias -Name MixLeakAlias -Value Get-Date -Scope Global; 'primed'",
        process.cwd(),
    );
    await waitMarkers(1);
    standby.run(
        "$r = @(); if (Get-Command MixLeakFn -ErrorAction SilentlyContinue) { $r += 'FN-LEAK' }; if (Get-Variable MixLeakVar -Scope Global -ErrorAction SilentlyContinue) { $r += 'VAR-LEAK' }; if (Get-Alias MixLeakAlias -ErrorAction SilentlyContinue) { $r += 'ALIAS-LEAK' }; Write-Output ('ISOLATION:' + ($r -join ',') + ':END')",
        process.cwd(),
    );
    await waitMarkers(2);
    standby.endStdin();
    assert.match(out, /ISOLATION::END/, `no global state leaked between standby commands (got: ${out.match(/ISOLATION:[^:]*:END/)?.[0] || 'no probe output'})`);
});
