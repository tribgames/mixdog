import {
    appendMutationPlanFailure,
    executeMutationPlan,
    isMutationPlanRoutable,
    planEditMutationRoute,
} from '../mutation-planner.mjs';
import { resolveAgainstCwd, normalizeInputPath } from './path-utils.mjs';
import { normalizeErrorMessage } from './path-diagnostics.mjs';
import { assertPathsReachable } from './fs-reachability.mjs';
import { isUncPath, isWindowsDevicePath, hasUnsafeWin32Component, isBlockedDevicePath } from './device-paths.mjs';

function editItemsFromBatchArgs(args) {
    return args.edits.map((edit) => ({
        path: edit?.path || args.path,
        old_string: edit?.old_string,
        new_string: edit?.new_string,
        replace_all: edit?.replace_all,
    }));
}

function editItemFromSingleArgs(args) {
    return {
        path: args.path,
        old_string: args.old_string,
        new_string: args.new_string,
        replace_all: args.replace_all,
    };
}

async function maybeExecutePlannedMutation(items, workDir, readStateScope, options, routeOptions) {
    const plan = planEditMutationRoute(items, routeOptions);
    if (!isMutationPlanRoutable(plan)) return null;
    return executeMutationPlan(plan, { workDir, readStateScope, options });
}

// Strip a trailing line coordinate (`:N`, `:N-M`, `#LN`) using a PURE regex —
// no filesystem access. The real edit path does precise line-vs-colon
// disambiguation later (which needs FS); the reachability preflight only needs
// a statable base path, and using existsSync here would itself block on a dead
// mount BEFORE the async reachability check could run. A Windows drive colon
// (`C:\...`) is not a trailing `:digits`, so it is unaffected.
function stripLineCoordForReach(p) {
    return String(p)
        .replace(/#L\d+(?:-L?\d+)?(?:\b.*)?$/i, '')
        .replace(/:\d+(?:-\d+)?(?::.*)?$/, '');
}

// Reject UNC/device/ADS/blocked paths BEFORE the reachability stat — statting
// a UNC/device path would itself trigger the network/raw-device access (NTLM
// leak) the edit engine's own guards prevent. edit-engine guards run only
// after this preflight, so we mirror them here to avoid the stat entirely.
function _guardedEditError(p) {
    if (isUncPath(p)) return `Error: cannot edit UNC / SMB path (network credential leak risk): ${p}`;
    if (isWindowsDevicePath(p)) return `Error: cannot edit Windows device path (reserved name or raw-device namespace): ${p}`;
    if (hasUnsafeWin32Component(p)) return `Error: cannot edit Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${p}`;
    if (isBlockedDevicePath(p)) return `Error: cannot edit device file: ${p}`;
    return null;
}

async function assertEditTargetsReachable(args, workDir) {
    const fullPaths = [];
    const seen = new Set();
    let guardErr = null;
    const addPath = (raw) => {
        if (typeof raw !== 'string' || !raw) return;
        // normalizeInputPath FIRST (FS-pure: trim/~/win32-mount/NFC) so we stat
        // the same path the edit engine later opens; then strip line coord.
        const norm = stripLineCoordForReach(normalizeInputPath(raw));
        if (!norm) return;
        const fullPath = resolveAgainstCwd(norm, workDir);
        if (seen.has(fullPath)) return;
        seen.add(fullPath);
        // Guarded paths are rejected (not stat'd) — see _guardedEditError.
        if (!guardErr) guardErr = _guardedEditError(norm) || _guardedEditError(fullPath);
        fullPaths.push(fullPath);
    };
    if (Array.isArray(args.edits) && args.edits.length > 0) {
        for (const item of editItemsFromBatchArgs(args)) addPath(item.path);
    } else {
        addPath(args.path);
    }
    if (guardErr) return guardErr;
    try {
        await assertPathsReachable(fullPaths);
    } catch (err) {
        return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
    }
    return null;
}

export async function executeEditTool(args, workDir, readStateScope, executeChildBuiltinTool, options = {}, handlers = {}) {
    const result = await _executeEditToolImpl(args, workDir, readStateScope, executeChildBuiltinTool, options, handlers);
    // ② completion progress (claude "Found N" parity). Best-effort, no-op when
    // onProgress is absent (no progressToken). Never throws — only emits on a
    // successful edit (an "Error:" body is left to the tool result alone).
    if (typeof options?.onProgress === 'function') {
        try {
            const _body = String(result);
            if (!/^Error[\s[]/.test(_body)) {
                const _rep = /\((\d+) replacements applied\)/.exec(_body);
                if (_rep) options.onProgress(`edited ${_rep[1]} replacements`);
                else {
                    const _one = /^Edited:\s+(.+?)(?:\s+\((?:native|\d+)\))?$/m.exec(_body);
                    if (_one) options.onProgress(`edited ${_one[1].trim()}`);
                    else {
                        const _ok = (_body.match(/^OK\s/gm) || []).length;
                        if (_ok) options.onProgress(`edited ${_ok} files`);
                    }
                }
            }
        } catch { /* best-effort */ }
    }
    return result;
}

async function _executeEditToolImpl(args, workDir, readStateScope, executeChildBuiltinTool, options = {}, handlers = {}) {
    if (typeof args.file_path === 'string' && !args.path) args.path = args.file_path;
    if (Array.isArray(args.edits)) {
        for (const edit of args.edits) {
            if (edit && typeof edit.file_path === 'string' && !edit.path) edit.path = edit.file_path;
        }
    }

    if (Array.isArray(args.edits) && args.edits.length > 0) {
        const items = editItemsFromBatchArgs(args);
        const paths = new Set(items.map((item) => item.path).filter(Boolean));
        if (paths.size === 0) return 'Error: each edit requires a path (either on the item or at top level)';

        const reachErr = await assertEditTargetsReachable(args, workDir);
        if (reachErr) return reachErr;

        const planned = await maybeExecutePlannedMutation(items, workDir, readStateScope, options);
        if (planned?.ok) return planned.text;

        let result;
        if (paths.size === 1) {
            const onePath = [...paths][0];
            result = await handlers.runMultiEdit({
                path: onePath,
                edits: items.map(({ path: _path, ...rest }) => rest),
            }, workDir, readStateScope, null, options);
        } else {
            result = await handlers.runBatchEdit({
                edits: items.map((item) => ({
                    path: item.path,
                    old_string: item.old_string,
                    new_string: item.new_string,
                    replace_all: item.replace_all,
                })),
            }, workDir, readStateScope, null, executeChildBuiltinTool, options);
        }

        const fallback = await maybeExecutePlannedMutation(items, workDir, readStateScope, options, {
            priorResult: result,
        });
        if (fallback?.ok) return fallback.text;
        return appendMutationPlanFailure(appendMutationPlanFailure(result, planned), fallback);
    }

    const item = editItemFromSingleArgs(args);
    const reachErr = await assertEditTargetsReachable(args, workDir);
    if (reachErr) return reachErr;

    const planned = await maybeExecutePlannedMutation([item], workDir, readStateScope, options);
    if (planned?.ok) return planned.text;

    const result = await handlers.runSingleEdit(args, workDir, readStateScope, options);
    const fallback = await maybeExecutePlannedMutation([item], workDir, readStateScope, options, {
        priorResult: result,
    });
    if (fallback?.ok) return fallback.text;
    return appendMutationPlanFailure(appendMutationPlanFailure(result, planned), fallback);
}
