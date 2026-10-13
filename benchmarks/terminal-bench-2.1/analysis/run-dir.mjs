// Where a published run lives: the full local `jobs-*` copy when it exists,
// otherwise the committed `<harness>/<model>/<date>/` export (verdicts, verifier output and
// usage snapshots only; no session logs or traces), located through
// `index.json`. `root` is the terminal-bench-2.1 directory.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readHistoryIndex(root = '.') {
    const file = resolve(root, 'index.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

// `name` is a jobsDir, optionally followed by a sub-run (`jobs-x/2026-08-02__19-20-02`).
export function historyRunDir(name, root = '.') {
    const [jobsDir, ...rest] = name.split(/[\\/]+/);
    const entry = readHistoryIndex(root).find((e) => e.jobsDir === jobsDir);
    return entry ? resolve(root, entry.path, ...rest) : null;
}

export function resolveRunDir(name, root = '.') {
    const local = resolve(root, name);
    return existsSync(local) ? local : historyRunDir(name, root) ?? local;
}

// For metrics that read session logs or traces, which the committed export omits.
export function requireLocalRunDir(name, root = '.') {
    const local = resolve(root, name);
    if (!existsSync(local)) {
        throw new Error(`${name} is not on this machine: this metric reads session logs/traces, which the committed export does not archive`);
    }
    return local;
}
