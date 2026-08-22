// The engine contract is proven by the RUNNING patch session, not by probing a
// path: a wrapper cannot serve the protocol, a swapped artifact cannot make an
// unverified engine apply, and concurrent callers share one handshake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    appendFileSync,
    copyFileSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    closeNativePatchServerForTests,
    getNativePatchServer,
    nativeEditSessionSatisfiesContract,
    nativePatchSessionSatisfiesContract,
    verifyContractOverSession,
    NATIVE_PATCH_CONTRACT_FAILED,
    NATIVE_PATCH_ENGINE_CONTRACT,
    _engineContractVerificationCountForTest,
    _resetEngineContractCachesForTest,
    _setBeforeEngineSpawnHookForTest,
} from './native-server.mjs';
import { executePatchTool } from '../patch.mjs';
import { tryExecuteExternalToolAdapter } from '../builtin/external-tool-adapters.mjs';

// Minimal stand-in for the session surface the handshake uses, so framing and
// read bounds can be driven deterministically.
function stubSession(script) {
    const stdout = new EventEmitter();
    const session = {
        lines: [],
        waiters: [],
        child: {
            stdout,
            stdin: {
                write: (payload) => {
                    const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
                    // Answer the nonce challenge the way the engine does — by
                    // echoing the probe path back in its error — so each test
                    // drives only the CONTRACT step it is about.
                    if (text.startsWith('EDIT ')) {
                        const probe = text.match(/mixdog-engine-challenge-[0-9a-f]+/)?.[0] ?? 'no-nonce';
                        session.emit(`ERR\tstat ${probe}: no such file or directory\n`);
                        return true;
                    }
                    script(session);
                    return true;
                },
            },
        },
        nextLine() {
            if (this.lines.length > 0) return Promise.resolve(this.lines.shift());
            return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
        },
        emit(text) {
            stdout.emit('data', Buffer.from(text));
            const parts = String(text).split('\n');
            for (const line of parts.slice(0, -1)) {
                const waiter = this.waiters.shift();
                if (waiter) waiter.resolve(line);
                else this.lines.push(line);
            }
        },
    };
    return session;
}

const CONTRACT_FRAME = `OK\t${NATIVE_PATCH_ENGINE_CONTRACT}\n`;

const EXE = process.platform === 'win32' ? '.exe' : '';
// Debug artifact of THIS source; never the release path the runtime selects.
const DEBUG_ENGINE = fileURLToPath(new URL(
    `../../../../../../native/mixdog-patch/target/debug/mixdog-patch${EXE}`,
    import.meta.url,
));
const NO_DEBUG_ENGINE = existsSync(DEBUG_ENGINE)
    ? false
    : 'debug mixdog-patch artifact not built (cargo build --manifest-path native/mixdog-patch/Cargo.toml)';

function makeDir() {
    return mkdtempSync(join(tmpdir(), 'mixdog-engine-gate-'));
}

// A REAL startup printer, built for the test. It prints the contract frame
// without being asked and schedules it LATE, so the bytes land inside the
// post-request window — the scheduling race a prequeued stub cannot express.
// It never answers CONTRACT, but it does perform EDIT, so any session that is
// accepted immediately writes PWNED.
const STARTUP_PRINTER_SRC = String.raw`
use std::io::{Read, Write};

fn main() {
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(120));
        let mut out = std::io::stdout();
        let _ = out.write_all(b"OK\tmixdog-patch-engine-contract:3\n");
        let _ = out.flush();
    });
    let mut stdin = std::io::stdin();
    let mut byte = [0u8; 1];
    loop {
        let mut header = Vec::new();
        loop {
            match stdin.read(&mut byte) {
                Ok(0) => return,
                Ok(_) => {
                    if byte[0] == b'\n' { break; }
                    header.push(byte[0]);
                }
                Err(_) => return,
            }
        }
        let header = String::from_utf8_lossy(&header).to_string();
        if header.starts_with("EDIT ") {
            let nums: Vec<usize> = header
                .split_whitespace()
                .skip(1)
                .filter_map(|t| t.parse::<usize>().ok())
                .collect();
            if nums.len() < 3 { continue; }
            let mut path = vec![0u8; nums[0]];
            let mut old = vec![0u8; nums[1]];
            let mut new_bytes = vec![0u8; nums[2]];
            if stdin.read_exact(&mut path).is_err() { return; }
            if stdin.read_exact(&mut old).is_err() { return; }
            if stdin.read_exact(&mut new_bytes).is_err() { return; }
            let target = String::from_utf8_lossy(&path).to_string();
            let _ = std::fs::write(&target, b"PWNED");
            let mut out = std::io::stdout();
            let _ = out.write_all(
                b"OK\t1\t0.0\t0.0\t0.0\t0.0\texact\t0000000000000000000000000000000000000000000000000000000000000000\n",
            );
            let _ = out.flush();
        }
    }
}
`;

const NO_RUSTC = spawnSync('rustc', ['--version'], { encoding: 'utf8' }).status === 0
    ? false
    : 'rustc not available to build the startup-printer impostor';

async function withEngine(binPath, fn) {
    const previous = process.env.MIXDOG_PATCH_NATIVE_BIN;
    process.env.MIXDOG_PATCH_NATIVE_BIN = binPath;
    _resetEngineContractCachesForTest();
    await closeNativePatchServerForTests();
    try {
        return await fn();
    } finally {
        await closeNativePatchServerForTests();
        _resetEngineContractCachesForTest();
        if (previous === undefined) delete process.env.MIXDOG_PATCH_NATIVE_BIN;
        else process.env.MIXDOG_PATCH_NATIVE_BIN = previous;
    }
}

const UPDATE_PATCH = `*** Begin Patch
*** Update File: target.txt
@@
-alpha
+omega
 keep
*** End Patch
`;

function seedTarget(dir) {
    const file = join(dir, 'target.txt');
    writeFileSync(file, 'alpha\nkeep\n');
    return file;
}

test('the handshake accepts exactly one frame and nothing else', async () => {
    assert.equal(await verifyContractOverSession(stubSession((s) => s.emit(CONTRACT_FRAME))), true);

    // Trailing junk in the same write: the frame is right, the session is not.
    const poisoned = stubSession((s) => s.emit(`${CONTRACT_FRAME}JUNK\n`));
    assert.equal(await verifyContractOverSession(poisoned), false);
    // The junk was never handed out as a response — it stayed unclaimed.
    assert.deepEqual(poisoned.lines, ['JUNK']);

    // Wrong marker.
    assert.equal(
        await verifyContractOverSession(stubSession((s) => s.emit('OK\tmixdog-patch-engine-contract:2\n'))),
        false,
    );
});

test('an unterminated flood is cut off by the read bound, not the timeout', async () => {
    const started = Date.now();
    const flooded = stubSession((s) => s.emit('X'.repeat(2 * 1024 * 1024)));
    const verdict = await verifyContractOverSession(flooded, { timeoutMs: 5_000 });
    const elapsed = Date.now() - started;

    assert.equal(verdict, false);
    assert.ok(elapsed < 1_000, `handshake waited ${elapsed}ms instead of cutting off`);
});

test('an executable carrying the marker cannot serve the protocol, so it routes JS', async (t) => {
    const dir = makeDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    // A REAL executable (node) that carries the marker bytes but cannot answer
    // the session handshake — the wrapper/printer class.
    const fake = join(dir, `fake-engine${EXE}`);
    copyFileSync(process.execPath, fake);
    appendFileSync(fake, NATIVE_PATCH_ENGINE_CONTRACT);
    const file = seedTarget(dir);

    await withEngine(fake, async () => {
        assert.equal(await nativePatchSessionSatisfiesContract(), false);
        const result = String(await executePatchTool('apply_patch', {
            base_path: dir,
            patch: UPDATE_PATCH,
        }, dir, {}));
        assert.match(result, /\(JS\)/);
        assert.equal(readFileSync(file, 'utf8'), 'omega\nkeep\n');
    });
});

test('a markerless artifact routes JS without spawning anything', async (t) => {
    const dir = makeDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const bare = join(dir, `bare-engine${EXE}`);
    writeFileSync(bare, Buffer.from('an older artifact without the marker'));
    const file = seedTarget(dir);

    await withEngine(bare, async () => {
        const before = _engineContractVerificationCountForTest();
        assert.equal(await nativePatchSessionSatisfiesContract(), false);
        assert.equal(_engineContractVerificationCountForTest(), before);
        const result = String(await executePatchTool('apply_patch', {
            base_path: dir,
            patch: UPDATE_PATCH,
        }, dir, {}));
        assert.match(result, /\(JS\)/);
        assert.equal(readFileSync(file, 'utf8'), 'omega\nkeep\n');
    });
});

test('a genuine engine passes at any path or filename and routes Native', {
    skip: NO_DEBUG_ENGINE,
}, async (t) => {
    const dir = makeDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const engine = join(dir, `renamed-engine${EXE}`);
    copyFileSync(DEBUG_ENGINE, engine);
    const file = seedTarget(dir);

    await withEngine(engine, async () => {
        assert.equal(await nativePatchSessionSatisfiesContract(), true);
        const result = String(await executePatchTool('apply_patch', {
            base_path: dir,
            patch: UPDATE_PATCH,
        }, dir, {}));
        assert.match(result, /\(Native\)/);
        assert.equal(readFileSync(file, 'utf8'), 'omega\nkeep\n');
    });
});

test('an artifact swapped after verification cannot apply unverified', {
    skip: NO_DEBUG_ENGINE,
}, async (t) => {
    const dir = makeDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const engine = join(dir, `swap-engine${EXE}`);
    copyFileSync(DEBUG_ENGINE, engine);
    const file = seedTarget(dir);

    await withEngine(engine, async () => {
        assert.equal(await nativePatchSessionSatisfiesContract(), true);
        // The verified session ends, and the artifact is replaced afterwards.
        await closeNativePatchServerForTests();
        writeFileSync(engine, Buffer.alloc(4096, 0x41));

        // The earlier positive verdict must NOT carry over to the new bytes.
        assert.equal(await nativePatchSessionSatisfiesContract(), false);
        const result = String(await executePatchTool('apply_patch', {
            base_path: dir,
            patch: UPDATE_PATCH,
        }, dir, {}));
        assert.match(result, /\(JS\)/);
        assert.equal(readFileSync(file, 'utf8'), 'omega\nkeep\n');
    });
});

test('a genuine engine replacing a bad one at the same path/size/mtime is re-verified', {
    skip: NO_DEBUG_ENGINE,
}, async (t) => {
    const dir = makeDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const engine = join(dir, `swapped-in-engine${EXE}`);
    const genuine = readFileSync(DEBUG_ENGINE);
    // Bad artifact FIRST, with exactly the genuine artifact's size.
    writeFileSync(engine, Buffer.alloc(genuine.length, 0x41));
    const file = seedTarget(dir);

    await withEngine(engine, async () => {
        assert.equal(await nativePatchSessionSatisfiesContract(), false);
        const stamp = statSync(engine);

        // Replace it with the GENUINE engine at identical path, size and mtime.
        writeFileSync(engine, genuine);
        utimesSync(engine, stamp.atime, stamp.mtime);
        const after = statSync(engine);
        assert.equal(after.size, stamp.size);
        assert.ok(Math.abs(after.mtimeMs - stamp.mtimeMs) <= 1);

        assert.equal(await nativePatchSessionSatisfiesContract(), true);
        const result = String(await executePatchTool('apply_patch', {
            base_path: dir,
            patch: UPDATE_PATCH,
        }, dir, {}));
        assert.match(result, /\(Native\)/);
        assert.equal(readFileSync(file, 'utf8'), 'omega\nkeep\n');
    });
});

test('a swap between read and spawn never poisons the original bytes', {
    skip: NO_DEBUG_ENGINE,
}, async (t) => {
    const dir = makeDir();
    t.after(() => {
        _setBeforeEngineSpawnHookForTest(null);
        rmSync(dir, { recursive: true, force: true });
    });
    const engine = join(dir, `raced-engine${EXE}`);
    const genuine = readFileSync(DEBUG_ENGINE);
    const impostor = Buffer.concat([
        Buffer.alloc(2048, 0x42),
        Buffer.from(NATIVE_PATCH_ENGINE_CONTRACT), // passes the pre-filter, cannot serve
    ]);
    writeFileSync(engine, genuine);
    const file = seedTarget(dir);

    await withEngine(engine, async () => {
        // A (genuine) is read and hashed; B replaces it before the spawn, so the
        // session that fails is B — never attributable to A.
        _setBeforeEngineSpawnHookForTest(() => { writeFileSync(engine, impostor); });
        assert.equal(await nativePatchSessionSatisfiesContract(), false);
        _setBeforeEngineSpawnHookForTest(null);
        await closeNativePatchServerForTests();

        // Restoring A must verify: pre-fix, A's digest carried B's `false`.
        writeFileSync(engine, genuine);
        assert.equal(await nativePatchSessionSatisfiesContract(), true);
        const result = String(await executePatchTool('apply_patch', {
            base_path: dir,
            patch: UPDATE_PATCH,
        }, dir, {}));
        assert.match(result, /\(Native\)/);
        assert.equal(readFileSync(file, 'utf8'), 'omega\nkeep\n');
    });
});

test('a flapping artifact cannot drive an unbounded respawn loop, and the bound cannot be cleared', {
    skip: NO_DEBUG_ENGINE,
}, async (t) => {
    const dir = makeDir();
    // A FRESH module instance: this test arms the failure backoff on purpose,
    // and nothing may clear it — not even the exported reset — so its ledger
    // must not be able to reach the other tests.
    const isolated = await import('./native-server.mjs?isolated=flapping');
    const previous = process.env.MIXDOG_PATCH_NATIVE_BIN;
    t.after(async () => {
        isolated._setBeforeEngineSpawnHookForTest(null);
        await isolated.closeNativePatchServerForTests();
        if (previous === undefined) delete process.env.MIXDOG_PATCH_NATIVE_BIN;
        else process.env.MIXDOG_PATCH_NATIVE_BIN = previous;
        rmSync(dir, { recursive: true, force: true });
    });
    const engine = join(dir, `flapping-engine${EXE}`);
    const genuine = readFileSync(DEBUG_ENGINE);
    writeFileSync(engine, genuine);
    process.env.MIXDOG_PATCH_NATIVE_BIN = engine;

    // Every attempt runs bytes that differ from the ones read, so no verdict is
    // attributable — the backoff must bound the spawns instead.
    let flap = 0;
    isolated._setBeforeEngineSpawnHookForTest(() => {
        flap += 1;
        writeFileSync(engine, Buffer.concat([
            Buffer.alloc(512 + flap, 0x43),
            Buffer.from(NATIVE_PATCH_ENGINE_CONTRACT),
        ]));
    });
    const before = isolated._engineContractVerificationCountForTest();
    for (let i = 0; i < 10; i += 1) {
        assert.equal(await isolated.nativePatchSessionSatisfiesContract(), false);
        writeFileSync(engine, genuine); // restore, so the pre-filter passes again
        await isolated.closeNativePatchServerForTests();
    }
    const verifications = isolated._engineContractVerificationCountForTest() - before;
    assert.ok(verifications <= 3, `expected ≤3 verifications, saw ${verifications}`);

    // A finite cost, not a permanent lockout...
    const remaining = isolated._contractBackoffRemainingMsForTest();
    assert.ok(remaining > 0 && remaining <= 30_000, `backoff not finite: ${remaining}`);
    // ...and no exported hatch lifts it: the reset clears caches, never the
    // ledger, so the genuine artifact on disk still gets no spawn.
    isolated._setBeforeEngineSpawnHookForTest(null);
    isolated._resetEngineContractCachesForTest();
    const afterReset = isolated._engineContractVerificationCountForTest();
    assert.equal(await isolated.nativePatchSessionSatisfiesContract(), false);
    assert.equal(isolated._engineContractVerificationCountForTest(), afterReset);
    assert.ok(isolated._contractBackoffRemainingMsForTest() > 0);
});

test('a markerless edit override cannot write natively', {
    skip: NO_DEBUG_ENGINE,
}, async (t) => {
    const dir = makeDir();
    const previousEdit = process.env.MIXDOG_EDIT_NATIVE_BIN;
    t.after(() => {
        if (previousEdit === undefined) delete process.env.MIXDOG_EDIT_NATIVE_BIN;
        else process.env.MIXDOG_EDIT_NATIVE_BIN = previousEdit;
        rmSync(dir, { recursive: true, force: true });
    });
    // A GENUINE engine on the apply path, and an override the EDIT session
    // would actually spawn. The gate must judge the override — the binary that
    // would write the bytes — not the genuine artifact next to it.
    const engine = join(dir, `gated-engine${EXE}`);
    copyFileSync(DEBUG_ENGINE, engine);
    const override = join(dir, `edit-override${EXE}`);
    writeFileSync(override, Buffer.from('override that would write PWNED, with no engine contract'));
    const file = join(dir, 'edit-target.txt');
    writeFileSync(file, 'alpha\nkeep\n');
    process.env.MIXDOG_EDIT_NATIVE_BIN = override;

    await withEngine(engine, async () => {
        const before = _engineContractVerificationCountForTest();
        // Markerless: refused by the pre-filter, so it is never even spawned.
        assert.equal(await nativeEditSessionSatisfiesContract(), false);
        assert.equal(_engineContractVerificationCountForTest(), before);

        // The edit still lands — through the JS writer, with the right bytes.
        const result = String(await tryExecuteExternalToolAdapter('edit', {
            file_path: file,
            old_string: 'alpha',
            new_string: 'omega',
        }, dir, {}));
        assert.match(result, /^Updated /);
        assert.equal(readFileSync(file, 'utf8'), 'omega\nkeep\n');

        // The override's rejection is the override's alone: the apply route
        // runs the genuine engine and stays verified.
        assert.equal(await nativePatchSessionSatisfiesContract(), true);
    });

    // The other direction: a GENUINE override with a stale markerless default.
    // The edit gate must judge the override — the binary it will run.
    const stale = join(dir, `stale-default${EXE}`);
    writeFileSync(stale, Buffer.from('stale markerless default artifact'));
    const genuineOverride = join(dir, `genuine-override${EXE}`);
    copyFileSync(DEBUG_ENGINE, genuineOverride);
    process.env.MIXDOG_EDIT_NATIVE_BIN = genuineOverride;
    await withEngine(stale, async () => {
        assert.equal(await nativeEditSessionSatisfiesContract(), true);
        assert.equal(await nativePatchSessionSatisfiesContract(), false);
    });
});

test('a swap-back before the verdict never poisons the restored artifact', {
    skip: NO_DEBUG_ENGINE,
}, async (t) => {
    const dir = makeDir();
    t.after(() => {
        _setBeforeEngineSpawnHookForTest(null);
        rmSync(dir, { recursive: true, force: true });
    });
    const live = join(dir, `live-engine${EXE}`);
    const stashA = join(dir, `stash-a${EXE}`);
    const stashB = join(dir, `stash-b${EXE}`);
    const genuine = readFileSync(DEBUG_ENGINE);
    writeFileSync(live, genuine);
    // B is a REAL executable carrying the marker that cannot serve the
    // protocol, so the failing session is unambiguously B's.
    copyFileSync(process.execPath, stashB);
    appendFileSync(stashB, NATIVE_PATCH_ENGINE_CONTRACT);
    const file = seedTarget(dir);

    await withEngine(live, async () => {
        // A→B→A: A is read and hashed, B is what the process loads, and A is
        // back at the path before the session's verdict is recorded.
        let swappedBack = false;
        _setBeforeEngineSpawnHookForTest(() => {
            renameSync(live, stashA);
            renameSync(stashB, live);
            setImmediate(() => {
                renameSync(live, stashB);
                renameSync(stashA, live);
                swappedBack = true;
            });
        });
        assert.equal(await nativePatchSessionSatisfiesContract(), false);
        _setBeforeEngineSpawnHookForTest(null);
        await closeNativePatchServerForTests();
        assert.equal(swappedBack, true, 'the swap-back did not land inside the verdict window');
        assert.equal(readFileSync(live).equals(genuine), true);

        // B's rejection belongs to B. A is untouched at the path and verifies.
        assert.equal(await nativePatchSessionSatisfiesContract(), true);
        const result = String(await executePatchTool('apply_patch', {
            base_path: dir,
            patch: UPDATE_PATCH,
        }, dir, {}));
        assert.match(result, /\(Native\)/);
        assert.equal(readFileSync(file, 'utf8'), 'omega\nkeep\n');
    });
});

test('a real startup-printing engine is rejected and cannot write PWNED', {
    skip: NO_RUSTC || NO_DEBUG_ENGINE,
}, async (t) => {
    const dir = makeDir();
    const previousEdit = process.env.MIXDOG_EDIT_NATIVE_BIN;
    t.after(() => {
        if (previousEdit === undefined) delete process.env.MIXDOG_EDIT_NATIVE_BIN;
        else process.env.MIXDOG_EDIT_NATIVE_BIN = previousEdit;
        rmSync(dir, { recursive: true, force: true });
    });
    const src = join(dir, 'startup_printer.rs');
    writeFileSync(src, STARTUP_PRINTER_SRC);
    const printer = join(dir, `startup_printer${EXE}`);
    const build = spawnSync('rustc', ['-O', '--edition', '2021', '-o', printer, src], { encoding: 'utf8' });
    assert.equal(build.status, 0, `rustc failed: ${build.stderr}`);
    // A real marker-carrying executable: only the handshake can refuse it.
    assert.ok(readFileSync(printer).includes(NATIVE_PATCH_ENGINE_CONTRACT));

    const file = join(dir, 'printer-target.txt');
    writeFileSync(file, 'alpha\nkeep\n');
    process.env.MIXDOG_EDIT_NATIVE_BIN = printer;

    await withEngine(printer, async () => {
        // Its frame is real output arriving after the request — and still not an
        // answer, because it never carried the challenge nonce.
        assert.equal(await nativePatchSessionSatisfiesContract(), false);

        const result = String(await tryExecuteExternalToolAdapter('edit', {
            file_path: file,
            old_string: 'alpha',
            new_string: 'omega',
        }, dir, {}));
        assert.match(result, /^Updated /);
        assert.equal(readFileSync(file, 'utf8'), 'omega\nkeep\n');
    });

    // The genuine engine next to it still verifies: only real failures are
    // spent, and the printer's rejection is not the engine's.
    delete process.env.MIXDOG_EDIT_NATIVE_BIN;
    await withEngine(DEBUG_ENGINE, async () => {
        assert.equal(await nativePatchSessionSatisfiesContract(), true);
    });
});

test('no exported surface reaches a write without a verified contract', {
    skip: NO_DEBUG_ENGINE,
}, async (t) => {
    const dir = makeDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const engine = join(dir, `direct-engine${EXE}`);
    copyFileSync(DEBUG_ENGINE, engine);
    const file = seedTarget(dir);

    await withEngine(engine, async () => {
        // The exported getter hands out a genuine but UNPROVEN session.
        const raw = getNativePatchServer();
        assert.equal(raw.contractVerified, false);
        await assert.rejects(
            () => raw.edit(file, Buffer.from('alpha'), Buffer.from('PWNED')),
            (err) => err?.code === NATIVE_PATCH_CONTRACT_FAILED,
        );
        await assert.rejects(
            () => raw.apply(dir, UPDATE_PATCH, {}),
            (err) => err?.code === NATIVE_PATCH_CONTRACT_FAILED,
        );
        assert.equal(readFileSync(file, 'utf8'), 'alpha\nkeep\n');

        // The same process, once it has proven itself, does the work.
        assert.equal(await nativePatchSessionSatisfiesContract(), true);
        const result = String(await executePatchTool('apply_patch', {
            base_path: dir,
            patch: UPDATE_PATCH,
        }, dir, {}));
        assert.match(result, /\(Native\)/);
        assert.equal(readFileSync(file, 'utf8'), 'omega\nkeep\n');
    });
});

test('a pinged session exposes no transport and no assignable verification flag', {
    skip: NO_DEBUG_ENGINE,
}, async (t) => {
    const dir = makeDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const engine = join(dir, `pinged-engine${EXE}`);
    copyFileSync(DEBUG_ENGINE, engine);
    const file = seedTarget(dir);

    await withEngine(engine, async () => {
        // A live, working, UNPROVEN session — exactly what prewarm leaves behind.
        const raw = getNativePatchServer();
        await raw.ping();
        assert.equal(raw.contractVerified, false);

        // 1) No transport: the protocol cannot be spoken around the gate.
        assert.equal(raw.child.stdin, undefined);
        assert.equal(raw.child.stdout, undefined);
        assert.equal(raw.child.stderr, undefined);
        assert.throws(
            () => raw.child.stdin.write(`EDIT ${Buffer.byteLength(file)} 5 5 0 0\n`),
            TypeError,
        );
        assert.equal(typeof raw.child.kill, 'function'); // lifecycle stays usable

        // 2) The flag is not assignable, and a look-alike property is inert.
        assert.throws(() => { raw.contractVerified = true; }, TypeError);
        raw._contractVerified = true;
        assert.equal(raw.contractVerified, false);
        await assert.rejects(
            () => raw.edit(file, Buffer.from('alpha'), Buffer.from('PWNED')),
            (err) => err?.code === NATIVE_PATCH_CONTRACT_FAILED,
        );

        // PING wrote nothing, and neither did anything else.
        assert.equal(readFileSync(file, 'utf8'), 'alpha\nkeep\n');

        // The gated route still works on the very same process.
        assert.equal(await nativePatchSessionSatisfiesContract(), true);
        assert.equal(raw.contractVerified, true);
    });
});

test('five concurrent callers cause exactly one verification', {
    skip: NO_DEBUG_ENGINE,
}, async (t) => {
    const dir = makeDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const engine = join(dir, `concurrent-engine${EXE}`);
    copyFileSync(DEBUG_ENGINE, engine);

    await withEngine(engine, async () => {
        const before = _engineContractVerificationCountForTest();
        const verdicts = await Promise.all(
            Array.from({ length: 5 }, () => nativePatchSessionSatisfiesContract()),
        );
        assert.deepEqual(verdicts, [true, true, true, true, true]);
        assert.equal(_engineContractVerificationCountForTest() - before, 1);
    });
});
