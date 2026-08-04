import { closeSync, openSync, readSync } from 'fs';

// Binary detection: reading a PNG / ELF / zip / compressed blob as utf-8
// pollutes the context with U+FFFD characters and wastes tokens. Sample the
// head and tail of the file and look for a null byte — the canonical signal
// that the file is not plain text. Head window scales with file size:
// min(fileSize, 64KB) head + 4KB tail, so a 250KB file with a null byte at
// 9KB or 249KB is caught equally. The sampling is synchronous and cheap
// relative to the 256KB read budget it guards.
// Callers inside the ≤READ_MAX_SIZE_BYTES branch should pass st.size so the
// tail probe fires; callers above the cap pass the real size from err.size.
export function isBinaryFile(fullPath, fileSize = 0) {
    const HEAD_CAP = 64 * 1024;   // 64 KB max head window
    const TAIL_SIZE = 4 * 1024;   // 4 KB tail probe
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
        if (nHead >= 2
            && ((headBuf[0] === 0xff && headBuf[1] === 0xfe)
                || (headBuf[0] === 0xfe && headBuf[1] === 0xff))) return false;
        for (let i = 0; i < nHead; i++) {
            if (headBuf[i] === 0) return true;
        }
        // Tail probe (only when file is larger than head window)
        if (fileSize > headBytes && fileSize > TAIL_SIZE) {
            const tailOffset = fileSize - TAIL_SIZE;
            const tailBuf = Buffer.allocUnsafe(TAIL_SIZE);
            const nTail = readSync(fd, tailBuf, 0, TAIL_SIZE, tailOffset);
            for (let i = 0; i < nTail; i++) {
                if (tailBuf[i] === 0) return true;
            }
        }
        return false;
    } catch {
        return false;
    } finally {
        if (fd !== null) { try { closeSync(fd); } catch {} }
    }
}

const BINARY_PREVIEW_BYTES = 256;

/** Short hex preview for read when null bytes mark the file as binary. */
export function formatBinaryReadPreview(fullPath, displayPath, fileSize, { previewBytes = BINARY_PREVIEW_BYTES } = {}) {
    const n = Math.max(0, Math.min(previewBytes, fileSize > 0 ? fileSize : previewBytes));
    let fd = null;
    try {
        fd = openSync(fullPath, 'r');
        const buf = Buffer.alloc(n);
        const bytesRead = readSync(fd, buf, 0, n, 0);
        const slice = buf.subarray(0, bytesRead);
        const hex = Array.from(slice).map((b) => b.toString(16).padStart(2, '0')).join(' ');
        const disp = displayPath || fullPath;
        const note = `binary, ${fileSize} byte${fileSize === 1 ? '' : 's'}`;
        const text = `${disp}\n${note}\n${hex || '(empty)'}`;
        return { text, snapshotMeta: { source: 'read_hex', ranges: [] } };
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
