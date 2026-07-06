// Full-tree shutdown for stdio MCP child processes.
//
// The MCP SDK's StdioClientTransport.close() closes stdin, waits ~2s, then
// SIGTERMs / SIGKILLs the *direct* child only. On Windows that maps to
// TerminateProcess on the spawned wrapper (uvx/npx/uv) and leaves its
// grandchildren (uv.exe -> mcp-for-unity.exe -> python.exe) orphaned. This
// module implements the MCP spec shutdown order over the whole process tree:
// close stdin -> grace wait for voluntary exit -> force-kill the recorded
// tree (taskkill /T /F on Windows, SIGTERM->SIGKILL of every descendant on
// POSIX). No external dependencies.
import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';

function delay(ms) {
    return new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        if (t.unref) t.unref();
    });
}

// Spawn a helper command and resolve its stdout (empty string on any error).
function run(cmd, args) {
    return new Promise((resolve) => {
        let out = '';
        let cp;
        try {
            cp = spawn(cmd, args, { windowsHide: true });
        }
        catch {
            resolve('');
            return;
        }
        cp.stdout?.on('data', (d) => { out += String(d); });
        cp.on('error', () => resolve(out));
        cp.on('close', () => resolve(out));
    });
}

// Snapshot the whole process table once: parent map + a per-pid identity
// token (Windows CreationDate, POSIX lstart) so a later kill can prove a pid
// number was not recycled onto a different process before signalling it.
async function enumerate() {
    const childrenOf = new Map();
    const tokenOf = new Map();
    const out = isWin
        ? await run('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            `Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToString('o'))" }`,
        ])
        : await run('ps', ['-A', '-o', 'pid=,ppid=,lstart=']);
    for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)(?:\s+(.+))?$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const ppid = Number(m[2]);
        const token = (m[3] || '').trim() || null;
        if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
        childrenOf.get(ppid).push(pid);
        tokenOf.set(pid, token);
    }
    return { childrenOf, tokenOf };
}

// BFS every descendant pid of rootPid (excludes rootPid).
function descendantsOf(childrenOf, rootPid) {
    const result = [];
    const seen = new Set([rootPid]);
    const stack = [rootPid];
    while (stack.length) {
        const cur = stack.pop();
        for (const child of childrenOf.get(cur) ?? []) {
            if (!seen.has(child)) {
                seen.add(child);
                result.push(child);
                stack.push(child);
            }
        }
    }
    return result;
}

// Exposed for tests: descendant pid list captured while the tree is intact.
export async function collectDescendants(rootPid) {
    const { childrenOf } = await enumerate();
    return descendantsOf(childrenOf, rootPid);
}

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        // EPERM => exists but not signalable by us; ESRCH => gone.
        return Boolean(e && e.code === 'EPERM');
    }
}

function waitExit(proc, ms) {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        const t = setTimeout(() => finish(false), ms);
        if (t.unref) t.unref();
        proc.once('exit', () => { clearTimeout(t); finish(true); });
        proc.once('close', () => { clearTimeout(t); finish(true); });
    });
}

// A pid is safe to signal only if its CURRENT identity token equals the one
// recorded at snapshot time. Both must be present; a gone/recycled pid has a
// missing or mismatched token and is skipped. Tokens come from batched table
// reads (Map), so verification is O(1) with zero extra process spawns.
function stillSame(pid, snapshotToken, currentTokens) {
    const want = snapshotToken.get(pid);
    const cur = currentTokens.get(pid);
    return Boolean(want && cur && want === cur);
}

// Force-kill the given pids, identity-checked against a batched current-token
// table captured immediately before signalling so a recycled pid is never hit.
async function killVerified(pids, snapshotToken, currentTokens) {
    const verified = pids.filter((pid) => stillSame(pid, snapshotToken, currentTokens));
    if (verified.length === 0) return;
    if (isWin) {
        // /T also reaps any still-live children spawned since enumeration;
        // every listed /PID was identity-checked just above.
        const args = ['/F', '/T'];
        for (const p of verified) args.push('/PID', String(p));
        await run('taskkill', args);
        return;
    }
    // POSIX: terminate, brief wait, then hard-kill survivors. Re-verify with a
    // single fresh batched table read (not per-pid) before the SIGKILL pass.
    for (const p of verified) { try { process.kill(p, 'SIGTERM'); } catch { /* ignore */ } }
    await delay(500);
    const { tokenOf: fresh } = await enumerate().catch(() => ({ tokenOf: new Map() }));
    for (const p of verified) {
        if (isAlive(p) && stillSame(p, snapshotToken, fresh)) {
            try { process.kill(p, 'SIGKILL'); } catch { /* ignore */ }
        }
    }
}

/**
 * Shut down an stdio MCP transport's child process tree per MCP spec order.
 * Returns false when the transport has no live child (non-stdio / already
 * exited); true once the tree has been shut down.
 */
export async function shutdownStdioChild(transport, { graceMs = 2000 } = {}) {
    const proc = transport?._process;
    const pid = (typeof transport?.pid === 'number' ? transport.pid : null) ?? proc?.pid ?? null;
    if (!pid) return false;
    const empty = { childrenOf: new Map(), tokenOf: new Map() };
    const snapshotToken = new Map();
    // Snapshot #1: tree + identity tokens while it is still fully intact.
    // Covers children that later get re-parented/orphaned during shutdown.
    const before = await enumerate().catch(() => empty);
    const initial = descendantsOf(before.childrenOf, pid);
    snapshotToken.set(pid, before.tokenOf.get(pid) ?? null);
    for (const d of initial) snapshotToken.set(d, before.tokenOf.get(d) ?? null);
    // 1. Close stdin to request a voluntary shutdown.
    try { proc?.stdin?.end(); } catch { /* ignore */ }
    // 2. Grace period for the server to exit on its own.
    const exited = await waitExit(proc, graceMs);
    // 3. Snapshot #2 after the grace: catches children spawned late during
    //    shutdown that were absent from the first snapshot.
    const after = await enumerate().catch(() => empty);
    const fresh = descendantsOf(after.childrenOf, pid);
    for (const d of fresh) {
        if (!snapshotToken.has(d)) snapshotToken.set(d, after.tokenOf.get(d) ?? null);
    }
    // 4. Candidate set = union of both snapshots' descendants; add the root
    //    only when it did NOT exit on its own (skip stale-root kill per spec).
    const candidates = new Set(initial);
    for (const d of fresh) candidates.add(d);
    if (!exited) candidates.add(pid);
    if (candidates.size === 0) return true;
    // 5. Force-kill. Snapshot #2 is the pre-kill verify table (captured just
    //    now, immediately before signalling) — no per-pid queries.
    await killVerified([...candidates], snapshotToken, after.tokenOf);
    return true;
}
