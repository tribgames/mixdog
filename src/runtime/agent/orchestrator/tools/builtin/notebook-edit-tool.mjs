// notebook_edit — structural Jupyter notebook (.ipynb) cell editor.
//
// Mixdog can READ rendered notebooks (extractIpynbText) but had no
// structural editor: a generic text `edit` against the raw .ipynb JSON is
// fragile (source is line-split arrays, outputs/execution_count are
// machine state). This tool parses the notebook JSON, resolves a cell by
// its real `cell.id` or a numeric `cell-N` index, then replaces / inserts /
// deletes a cell and writes the JSON back — preserving the on-disk BOM
// encoding and line endings, and gated behind the same read-before-write
// snapshot guard as edit/write. Mirrors Claude Code's NotebookEditTool.
import { readFileSync, statSync } from 'fs';
import { extname } from 'path';
import { markCodeGraphDirtyPaths } from '../code-graph.mjs';
import {
    normalizeInputPath,
    normalizeOutputPath,
    resolveAgainstCwd,
} from './path-utils.mjs';
import { normalizeErrorMessage } from './path-diagnostics.mjs';
import { withPathLock } from './path-locks.mjs';
import { withAdvisoryLocks } from './advisory-lock.mjs';
import { hashText } from './hash-utils.mjs';
import {
    getReadSnapshot,
    isSnapshotStale,
    readContentIfSnapshotHashMatches,
    recordReadSnapshot,
} from './read-snapshot-runtime.mjs';
import {
    invalidateBuiltinResultCache,
    seedRawContentCacheAfterWrite,
} from './cache-layers.mjs';
import { atomicWrite } from './atomic-write.mjs';
import { detectExistingEncoding, toWriteBuffer } from './write-tool.mjs';
import {
    hasUnsafeWin32Component,
    isWindowsDevicePath,
} from './device-paths.mjs';

// Jupyter serialises notebooks with a single-space indent.
const IPYNB_INDENT = 1;

// Parse a "cell-N" synthetic id (the addressing scheme the read renderer
// exposes for notebooks without real cell ids) into its 0-based index.
// Returns undefined for anything that is not exactly that shape.
function parseCellId(cellId) {
    if (typeof cellId !== 'string') return undefined;
    const m = cellId.match(/^cell-(\d+)$/);
    if (!m) return undefined;
    const n = Number.parseInt(m[1], 10);
    return Number.isFinite(n) ? n : undefined;
}

// Decode the raw notebook bytes honouring the leading BOM (same invariant
// the write path re-applies), and report the dominant line ending so the
// re-serialised JSON round-trips the file's CRLF/LF convention.
function readNotebookSource(fullPath) {
    const raw = readFileSync(fullPath);
    let text;
    if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
        text = raw.subarray(2).toString('utf16le');
    } else if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
        text = raw.subarray(3).toString('utf-8');
    } else {
        text = raw.toString('utf-8');
    }
    const crlf = (text.match(/\r\n/g) || []).length;
    const lf = (text.match(/\n/g) || []).length;
    const lineEnding = crlf > 0 && crlf >= lf - crlf ? '\r\n' : '\n';
    return { text, lineEnding };
}

export async function executeNotebookEditTool(args, workDir, readStateScope, options = {}) {
    if (typeof args.file_path === 'string' && !args.notebook_path) args.notebook_path = args.file_path;
    if (typeof args.path === 'string' && !args.notebook_path) args.notebook_path = args.path;

    let notebookPath = args.notebook_path;
    if (typeof notebookPath === 'string') notebookPath = normalizeInputPath(notebookPath);
    if (!notebookPath) return 'Error: notebook_path is required';

    const newSource = args.new_source;
    const cellId = args.cell_id;
    let cellType = args.cell_type;
    const editMode = args.edit_mode === undefined || args.edit_mode === null ? 'replace' : args.edit_mode;

    if (editMode !== 'replace' && editMode !== 'insert' && editMode !== 'delete') {
        return `Error: edit_mode must be replace, insert, or delete (got ${JSON.stringify(args.edit_mode)})`;
    }
    if (cellType !== undefined && cellType !== 'code' && cellType !== 'markdown') {
        return `Error: cell_type must be code or markdown (got ${JSON.stringify(cellType)})`;
    }
    if (editMode !== 'delete' && typeof newSource !== 'string') {
        return `Error: new_source must be a string for edit_mode=${editMode}`;
    }
    if (editMode === 'insert' && !cellType) {
        return 'Error: cell_type is required when using edit_mode=insert';
    }
    if (editMode !== 'insert' && !cellId) {
        return 'Error: cell_id must be specified when not inserting a new cell';
    }

    // R12: Win32 component / device-name guard before path resolution so a
    // relative path can't be coerced into a device alias or NTFS ADS suffix.
    if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(notebookPath)) {
        return `Error: cannot edit Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(notebookPath)}`;
    }
    if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(notebookPath)) {
        return `Error: cannot edit Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(notebookPath)}`;
    }

    const fullPath = resolveAgainstCwd(notebookPath, workDir);
    // R1: short-circuit UNC/SMB paths before any fs probe to prevent NTLM
    // credential leakage via implicit network auth.
    if (fullPath.startsWith('\\\\') || fullPath.startsWith('//')) {
        return `Error: UNC/SMB paths are not supported (R1: NTLM-leak prevention): ${notebookPath}`;
    }
    if (typeof isWindowsDevicePath === 'function' && isWindowsDevicePath(fullPath)) {
        return `Error: cannot edit Windows device path (reserved name or raw-device namespace): ${normalizeOutputPath(notebookPath)}`;
    }
    if (typeof hasUnsafeWin32Component === 'function' && hasUnsafeWin32Component(fullPath)) {
        return `Error: cannot edit Windows path with trailing dot/space or NTFS ADS suffix (bypasses device guard): ${normalizeOutputPath(notebookPath)}`;
    }

    if (extname(fullPath).toLowerCase() !== '.ipynb') {
        return `Error: file must be a Jupyter notebook (.ipynb). For other file types use edit/write: ${normalizeOutputPath(notebookPath)}`;
    }

    return withPathLock(fullPath, () =>
        withAdvisoryLocks([fullPath], async () => {
            let existing;
            try {
                existing = statSync(fullPath);
            } catch (err) {
                if (err && err.code === 'ENOENT') {
                    return `Error: notebook file does not exist: ${normalizeOutputPath(notebookPath)}`;
                }
                return `Error: stat failed before edit: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}: ${notebookPath}`;
            }
            if (!existing.isFile()) {
                return `Error: notebook path is not a regular file: ${normalizeOutputPath(notebookPath)}`;
            }

            // Read-before-write guard (parity with edit/write): the notebook
            // must have been read this session, and not changed since, or a
            // structural edit could clobber an unseen / externally-modified file.
            const snapshot = getReadSnapshot(fullPath, readStateScope);
            if (!snapshot) {
                return `Error [code 6]: notebook has not been read yet — read it first before editing: ${normalizeOutputPath(notebookPath)}`;
            }
            if (isSnapshotStale(existing, snapshot, fullPath)) {
                const hashOk = readContentIfSnapshotHashMatches(fullPath, snapshot, null, existing);
                if (hashOk === null) {
                    return `Error [code 7]: notebook modified since read — read it again before editing: ${normalizeOutputPath(notebookPath)}`;
                }
            }

            let originalText;
            let lineEnding;
            try {
                ({ text: originalText, lineEnding } = readNotebookSource(fullPath));
            } catch (err) {
                return `Error: failed to read notebook: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}: ${notebookPath}`;
            }

            let notebook;
            try {
                notebook = JSON.parse(originalText);
            } catch {
                return `Error: notebook is not valid JSON: ${normalizeOutputPath(notebookPath)}`;
            }
            if (!notebook || !Array.isArray(notebook.cells)) {
                return `Error: notebook JSON has no "cells" array: ${normalizeOutputPath(notebookPath)}`;
            }

            // Resolve target cell index: real cell.id first, then cell-N index.
            let cellIndex;
            if (!cellId) {
                cellIndex = 0; // insert-at-start default
            } else {
                cellIndex = notebook.cells.findIndex((cell) => cell && cell.id === cellId);
                if (cellIndex === -1) {
                    const parsed = parseCellId(cellId);
                    if (parsed !== undefined) {
                        // Mode-aware bound (matches NotebookEditTool semantics):
                        // insert may address the append slot (index ===
                        // cells.length) to add a cell at the very end;
                        // replace/delete require an EXISTING cell
                        // [0 .. cells.length-1], so a past-end index errors.
                        const maxIndex = editMode === 'insert'
                            ? notebook.cells.length
                            : notebook.cells.length - 1;
                        if (parsed < 0 || parsed > maxIndex) {
                            return `Error: cell with index ${parsed} does not exist in notebook (${notebook.cells.length} cells)`;
                        }
                        cellIndex = parsed;
                    } else {
                        return `Error: cell with ID "${cellId}" not found in notebook`;
                    }
                }
                // Insert lands AFTER the referenced cell. When the index is the
                // append slot (=== cells.length) there is no referenced cell to
                // sit after, so leave it as-is to append at the very end.
                if (editMode === 'insert' && cellIndex < notebook.cells.length) {
                    cellIndex += 1;
                }
            }

            // Insert at the append slot (index === cells.length) adds a cell at
            // the very end — this is the reachable "add a cell at the end" path.
            // replace/delete past-end already errored at the bound check above.
            let effectiveMode = editMode;

            // Only mint a real cell id when the notebook format supports it
            // (nbformat 4.5+ / >4), matching how Jupyter assigns cell ids.
            const supportsCellId =
                notebook.nbformat > 4 ||
                (notebook.nbformat === 4 && (notebook.nbformat_minor ?? 0) >= 5);
            let resultCellId;
            if (supportsCellId) {
                resultCellId = effectiveMode === 'insert'
                    ? Math.random().toString(36).substring(2, 15)
                    : cellId;
            }

            if (effectiveMode === 'delete') {
                notebook.cells.splice(cellIndex, 1);
            } else if (effectiveMode === 'insert') {
                const newCell = cellType === 'markdown'
                    ? { cell_type: 'markdown', metadata: {}, source: newSource }
                    : { cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: newSource };
                if (supportsCellId) newCell.id = resultCellId;
                notebook.cells.splice(cellIndex, 0, newCell);
            } else {
                const targetCell = notebook.cells[cellIndex];
                if (!targetCell) {
                    return `Error: cell at index ${cellIndex} does not exist in notebook`;
                }
                targetCell.source = newSource;
                // A MODIFIED code cell's prior run state is invalid: reset
                // execution_count and clear THIS cell's outputs only; every
                // other cell's structure/outputs is left untouched.
                if (targetCell.cell_type === 'code') {
                    targetCell.execution_count = null;
                    targetCell.outputs = [];
                }
                if (cellType && cellType !== targetCell.cell_type) {
                    targetCell.cell_type = cellType;
                    // Switching to code requires the code-cell machine fields;
                    // switching to markdown drops them.
                    if (cellType === 'code') {
                        if (targetCell.execution_count === undefined) targetCell.execution_count = null;
                        if (!Array.isArray(targetCell.outputs)) targetCell.outputs = [];
                    } else {
                        delete targetCell.execution_count;
                        delete targetCell.outputs;
                    }
                }
            }

            let updatedText = JSON.stringify(notebook, null, IPYNB_INDENT);
            // Preserve the file's line-ending convention. JSON.stringify only
            // emits \n; re-apply CRLF when the original used it.
            if (lineEnding === '\r\n') updatedText = updatedText.replace(/\n/g, '\r\n');

            // Re-encode honouring the on-disk BOM (utf16le / utf8+BOM / utf8).
            const writeContent = toWriteBuffer(updatedText, detectExistingEncoding(fullPath));

            try {
                await atomicWrite(fullPath, writeContent, { sessionId: options?.sessionId });
            } catch (err) {
                return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
            }

            let writtenStat = null;
            try { writtenStat = statSync(fullPath); } catch {}
            // Refresh the read snapshot post-write (matches edit/write) so a
            // follow-up read/edit in the same instant isn't blocked or stale.
            recordReadSnapshot(fullPath, writtenStat || undefined, readStateScope, {
                source: 'write',
                contentHash: hashText(writeContent),
                replaceExisting: true,
            });
            invalidateBuiltinResultCache([fullPath]);
            seedRawContentCacheAfterWrite(fullPath, writeContent, writtenStat);
            markCodeGraphDirtyPaths([fullPath]);

            const cellLabel = resultCellId || (cellId ?? `cell-${cellIndex}`);
            switch (effectiveMode) {
                case 'insert':
                    return `Inserted ${cellType || 'code'} cell ${cellLabel} in ${normalizeOutputPath(notebookPath)}`;
                case 'delete':
                    return `Deleted cell ${cellId} in ${normalizeOutputPath(notebookPath)}`;
                default:
                    return `Updated cell ${cellLabel} in ${normalizeOutputPath(notebookPath)}`;
            }
        })
    );
}

export default executeNotebookEditTool;
