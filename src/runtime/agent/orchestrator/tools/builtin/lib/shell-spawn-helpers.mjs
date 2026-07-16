import { basename } from 'path';
import { killProcessTree } from '../shell-job-process.mjs';

const SPAWN_ERROR_GUARD = Symbol('mixdog.spawnErrorGuard');

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function awaitSpawnReady(child, label) {
    return new Promise((resolve, reject) => {
        if (!child || typeof child.once !== 'function') {
            reject(new Error(`${label} spawn returned no child process`));
            return;
        }
        let spawned = false;
        let bufferedError = null;
        const cleanup = () => child.removeListener('spawn', onSpawn);
        const onError = (error) => {
            if (spawned) {
                bufferedError = bufferedError || error;
                return;
            }
            cleanup();
            child.removeListener('error', onError);
            reject(error);
        };
        const onSpawn = () => {
            cleanup();
            spawned = true;
            const pid = Number(child.pid);
            if (!Number.isFinite(pid) || pid <= 0) {
                child.removeListener('error', onError);
                reject(new Error(`${label} spawn returned no pid`));
                return;
            }
            child[SPAWN_ERROR_GUARD] = {
                adopt(handler) {
                    child.on('error', handler);
                    child.removeListener('error', onError);
                    if (bufferedError) handler(bufferedError);
                    delete child[SPAWN_ERROR_GUARD];
                },
                discard() {
                    child.removeListener('error', onError);
                    delete child[SPAWN_ERROR_GUARD];
                },
            };
            resolve(child);
        };
        child.once('error', onError);
        child.once('spawn', onSpawn);
    });
}

export function adoptSpawnErrorHandler(child, handler) {
    const guard = child?.[SPAWN_ERROR_GUARD];
    if (guard) guard.adopt(handler);
    else child?.on?.('error', handler);
}

export function discardSpawnErrorGuard(child) {
    child?.[SPAWN_ERROR_GUARD]?.discard?.();
}

export async function rollbackSpawnedChild(child, { timeoutMs = 5000 } = {}) {
    if (!child || child.exitCode != null || child.signalCode != null) {
        return { confirmed: true, errors: [] };
    }
    const errors = [];
    let timer = null;
    let settled = false;
    const outcome = await new Promise((resolve) => {
        const finish = (confirmed) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            child.removeListener('exit', onExit);
            child.removeListener('close', onExit);
            child.removeListener('error', onError);
            resolve({ confirmed, errors });
        };
        const onExit = () => finish(true);
        const onError = (error) => { errors.push(error); };
        child.on('error', onError);
        child.once('exit', onExit);
        child.once('close', onExit);
        timer = setTimeout(() => finish(false), Math.max(1, Number(timeoutMs) || 5000));
        try { killProcessTree(child.pid, 'SIGKILL'); } catch (error) { errors.push(error); }
        try { child.kill?.('SIGKILL'); } catch (error) { errors.push(error); }
    });
    return outcome;
}

export function shellQuoteSingle(s) {
    return `'${String(s).replace(/'/g, `'\"'\"'`)}'`;
}

export function psSingleQuote(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
}

export function isPowerShellShell(shell, shellType) {
    if (shellType === 'powershell') return true;
    const stem = basename(String(shell || '')).toLowerCase().replace(/\.exe$/, '');
    return stem === 'pwsh' || stem === 'powershell';
}
