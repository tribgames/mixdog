// Where a published run lives: the full local `jobs-*` copy when it exists,
// otherwise the committed `raw-runs/` export (verdicts, verifier output and
// usage snapshots only; no session logs or traces). `root` is the
// terminal-bench-2.1 directory.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function resolveRunDir(name, root = '.') {
    const local = resolve(root, name);
    return existsSync(local) ? local : resolve(root, 'raw-runs', name);
}

// For metrics that read session logs or traces, which `raw-runs/` omits.
export function requireLocalRunDir(name, root = '.') {
    const local = resolve(root, name);
    if (!existsSync(local)) {
        throw new Error(`${name} is not on this machine: this metric reads session logs/traces, which raw-runs/ does not archive`);
    }
    return local;
}
