// fs-reachability.mjs — async reachability preflight for tools that then do
// synchronous filesystem work (read / write / edit / apply_patch).
//
// WHY: a synchronous `statSync` / `readFileSync` / `realpathSync` on a dead
// mount or hung network path BLOCKS the Node main thread. Because the event
// loop is frozen, even the 630s dispatch ceiling (a main-loop setTimeout)
// cannot fire — the tool call hangs indefinitely. An async `fsPromises.stat`
// runs on the libuv threadpool, so a per-path deadline CAN fire on the main
// loop and surface a clean error BEFORE the blocking sync call is reached.
//
// This is a preflight gate, not a full sync->async rewrite: the existing sync
// logic is unchanged; we only refuse to enter it when the path is unreachable.
import { stat } from 'node:fs/promises';

const FS_REACHABILITY_DEADLINE_MS = 5000;

// Resolve true when the path is reachable (exists OR cleanly absent — ENOENT,
// EACCES, etc. are "the FS answered", let the real sync logic produce its own
// error). Reject with EFSUNREACHABLE only when the stat itself exceeds the
// deadline, which is the dead-mount / hung-FS signature.
export async function assertPathReachable(path, deadlineMs = FS_REACHABILITY_DEADLINE_MS) {
    if (typeof path !== 'string' || path.length === 0) return null;
    const ms = Number(deadlineMs) > 0 ? Number(deadlineMs) : FS_REACHABILITY_DEADLINE_MS;
    let timer = null;
    // Resolve to the Stats on success so a caller can seed its stat cache and
    // avoid an immediate redundant synchronous re-stat of the same path; a
    // clean FS rejection (ENOENT/EACCES) resolves to null (still "reachable").
    const probe = stat(path).then((s) => s, () => null);
    const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve('TIMEOUT'), ms);
    });
    const result = await Promise.race([
        probe.finally(() => { if (timer) clearTimeout(timer); }),
        deadline,
    ]);
    if (result === 'TIMEOUT') {
        const err = new Error(
            `path unreachable: stat exceeded ${ms}ms (possible dead mount / hung filesystem): ${path}`,
        );
        err.code = 'EFSUNREACHABLE';
        throw err;
    }
    return result; // Stats on success, null on a clean FS rejection
}

// Batch variant: reject if ANY path is unreachable. Runs probes concurrently so
// the wall-clock cost is one deadline, not N.
export async function assertPathsReachable(paths, deadlineMs = FS_REACHABILITY_DEADLINE_MS) {
    const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.length) : [];
    if (list.length === 0) return;
    await Promise.all(list.map((p) => assertPathReachable(p, deadlineMs)));
}
