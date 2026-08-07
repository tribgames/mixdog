import { closeSync, openSync, readSync } from 'fs';
import { open } from 'fs/promises';

const HEAD_CAP = 64 * 1024;
const TAIL_SIZE = 4 * 1024;

function hasUtf16Bom(buf, length = buf?.length || 0) {
    return length >= 2
        && ((buf[0] === 0xff && buf[1] === 0xfe)
            || (buf[0] === 0xfe && buf[1] === 0xff));
}

function containsNull(buf, length = buf?.length || 0) {
    for (let i = 0; i < length; i++) {
        if (buf[i] === 0) return true;
    }
    return false;
}

// Binary detection: reading a PNG / ELF / zip / compressed blob as utf-8
// pollutes the context with U+FFFD characters and wastes tokens. Sample the
// head and tail of the file and look for a null byte — the canonical signal
// that the file is not plain text. Head window scales with file size:
// min(fileSize, 64KB) head + 4KB tail, so a 250KB file with a null byte at
// 9KB or 249KB is caught equally. This synchronous form remains for legacy
// mode readers. The main read path uses inspectBinaryFile(), which performs
// the same probes asynchronously.
// Callers inside the ≤READ_MAX_SIZE_BYTES branch should pass st.size so the
// tail probe fires; callers above the cap pass the real size from err.size.
export function isBinaryFile(fullPath, fileSize = 0) {
    const headBytes = fileSize > 0 ? Math.min(fileSize, HEAD_CAP) : HEAD_CAP;
    let fd = null;
    try {
        fd = openSync(fullPath, 'r');
        // Head probe
        const headBuf = Buffer.allocUnsafe(headBytes);
        const nHead = readSync(fd, headBuf, 0, headBytes, 0);
        if (nHead === 0) return false;
        // UTF-16 text has a null byte in every other position; a leading
        // UTF-16 BOM marks it as text the read path can decode
        // (detectReadEncodingFromBuffer/decodeReadBuffer support utf16le and
        // utf16be), so exempt it rather than reject the file as binary.
        // FF FE = UTF-16LE, FE FF = UTF-16BE.
        if (hasUtf16Bom(headBuf, nHead)) return false;
        if (containsNull(headBuf, nHead)) return true;
        // Tail probe (only when file is larger than head window)
        if (fileSize > headBytes && fileSize > TAIL_SIZE) {
            const tailOffset = fileSize - TAIL_SIZE;
            const tailBuf = Buffer.allocUnsafe(TAIL_SIZE);
            const nTail = readSync(fd, tailBuf, 0, TAIL_SIZE, tailOffset);
            if (containsNull(tailBuf, nTail)) return true;
        }
        return false;
    } catch {
        return false;
    } finally {
        if (fd !== null) { try { closeSync(fd); } catch {} }
    }
}

/** Classify an already-loaded whole file without another open/read cycle. */
export function isBinaryBuffer(buf, fileSize = buf?.length || 0) {
    if (!Buffer.isBuffer(buf) || buf.length === 0) return false;
    const size = fileSize > 0 ? Math.min(fileSize, buf.length) : buf.length;
    const headBytes = Math.min(size, HEAD_CAP);
    if (hasUtf16Bom(buf, headBytes)) return false;
    if (containsNull(buf, headBytes)) return true;
    if (size > headBytes && size > TAIL_SIZE) {
        const tail = buf.subarray(Math.max(0, size - TAIL_SIZE), size);
        if (containsNull(tail)) return true;
    }
    return false;
}

/**
 * Async binary probe that keeps one file handle for head, tail, and preview.
 * Returns the head bytes even when the null marker is in the tail so callers
 * can render a hex preview without reopening the file.
 */
export async function inspectBinaryFile(fullPath, fileSize = 0, { previewBytes = 256 } = {}) {
    const headBytes = fileSize > 0 ? Math.min(fileSize, HEAD_CAP) : HEAD_CAP;
    let fh;
    try {
        fh = await open(fullPath, 'r');
        const headBuf = Buffer.allocUnsafe(Math.max(0, headBytes));
        const { bytesRead: nHead } = await fh.read(headBuf, 0, headBytes, 0);
        const head = headBuf.subarray(0, nHead);
        const preview = head.subarray(0, Math.min(previewBytes, nHead));
        if (nHead === 0 || hasUtf16Bom(head, nHead)) return { isBinary: false, preview };
        if (containsNull(head, nHead)) return { isBinary: true, preview };
        if (fileSize > headBytes && fileSize > TAIL_SIZE) {
            const tailBuf = Buffer.allocUnsafe(TAIL_SIZE);
            const { bytesRead: nTail } = await fh.read(
                tailBuf,
                0,
                TAIL_SIZE,
                fileSize - TAIL_SIZE,
            );
            if (containsNull(tailBuf, nTail)) return { isBinary: true, preview };
        }
        return { isBinary: false, preview };
    } catch {
        return { isBinary: false, preview: Buffer.alloc(0) };
    } finally {
        if (fh) { try { await fh.close(); } catch {} }
    }
}

const BINARY_PREVIEW_BYTES = 256;

export function formatBinaryReadPreviewFromBuffer(
    buffer,
    displayPath,
    fileSize,
    { previewBytes = BINARY_PREVIEW_BYTES } = {},
) {
    const source = Buffer.isBuffer(buffer) ? buffer : Buffer.alloc(0);
    const slice = source.subarray(0, Math.min(previewBytes, source.length));
    const hex = Array.from(slice).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const disp = displayPath || '(binary file)';
    const note = `binary, ${fileSize} byte${fileSize === 1 ? '' : 's'}`;
    const text = `${disp}\n${note}\n${hex || '(empty)'}`;
    return { text, snapshotMeta: { source: 'read_hex', ranges: [] } };
}

/** Short hex preview for read when null bytes mark the file as binary. */
export function formatBinaryReadPreview(fullPath, displayPath, fileSize, { previewBytes = BINARY_PREVIEW_BYTES } = {}) {
    const n = Math.max(0, Math.min(previewBytes, fileSize > 0 ? fileSize : previewBytes));
    let fd = null;
    try {
        fd = openSync(fullPath, 'r');
        const buf = Buffer.alloc(n);
        const bytesRead = readSync(fd, buf, 0, n, 0);
        return formatBinaryReadPreviewFromBuffer(
            buf.subarray(0, bytesRead),
            displayPath || fullPath,
            fileSize,
            { previewBytes },
        );
    } catch {
        const disp = displayPath || fullPath;
        return {
            text: `${disp}\nbinary, ${fileSize} bytes\n(preview unavailable)`,
            snapshotMeta: { source: 'read_hex', ranges: [] },
        };
    } finally {
        if (fd !== null) { try { closeSync(fd); } catch {} }
    }
}
