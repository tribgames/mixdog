import { isValidUtf8Buffer } from '../mutation-content-cache.mjs';

// Shared guard. Centralises the UTF-8 check so every byte-exact write
// path (native-exact dispatch, single-edit byte-exact buffer,
// multi-edit byte-exact buffer, AND the stale-auto-refresh path)
// refuses non-UTF-8 targets with identical wording. Without a single
// shared hook the stale-refresh path read with 'utf-8' encoding,
// silently replacing invalid sequences with U+FFFD and bypassing the
// downstream guards that only saw the re-encoded decoded text.
export function assertEditTargetUtf8(rawBuf, filePath) {
    if (isValidUtf8Buffer(rawBuf)) return null;
    // UTF-16 BOM detection BEFORE the generic message: a UTF-16 file is a
    // recognizable, recoverable case (read decodes it; write preserves the
    // BOM round-trip) — calling it "Shift-JIS/Latin-1/binary mix" sends the
    // caller down the wrong recovery path.
    if (rawBuf.length >= 2 && rawBuf[0] === 0xFF && rawBuf[1] === 0xFE) {
        return `Error: file is UTF-16LE (BOM FF FE) — edit only supports UTF-8; use write (preserves UTF-16) or convert the file. Path: ${filePath}`;
    }
    if (rawBuf.length >= 2 && rawBuf[0] === 0xFE && rawBuf[1] === 0xFF) {
        return `Error: file is UTF-16BE (BOM FE FF) — edit only supports UTF-8; convert the file first. Path: ${filePath}`;
    }
    // Strict manual UTF-8 walk for Node <18 / environments where
    // Buffer.isUtf8 is unavailable. Rejects overlong sequences,
    // surrogates, out-of-range code points, and 5/6-byte sequences
    // (Unicode §3.9 Table 3-7).
    let idx2 = 0;
    while (idx2 < rawBuf.length) {
        const b0 = rawBuf[idx2];
        if (b0 < 0x80) { idx2++; continue; }
        let seqLen = 0;
        if ((b0 & 0xE0) === 0xC0) seqLen = 2;
        else if ((b0 & 0xF0) === 0xE0) seqLen = 3;
        else if ((b0 & 0xF8) === 0xF0) seqLen = 4;
        else return `Error: file appears to be non-UTF-8 (Shift-JIS/Latin-1/binary mix). Edit aborted to prevent silent corruption. Path: ${filePath}`;
        if (idx2 + seqLen > rawBuf.length) return `Error: file appears to be non-UTF-8 (Shift-JIS/Latin-1/binary mix). Edit aborted to prevent silent corruption. Path: ${filePath}`;
        if (seqLen === 2 && b0 <= 0xC1) return `Error: file appears to be non-UTF-8 (Shift-JIS/Latin-1/binary mix). Edit aborted to prevent silent corruption. Path: ${filePath}`;
        const b1 = rawBuf[idx2 + 1];
        if (seqLen === 3 && b0 === 0xE0 && b1 < 0xA0) return `Error: file appears to be non-UTF-8 (Shift-JIS/Latin-1/binary mix). Edit aborted to prevent silent corruption. Path: ${filePath}`;
        if (seqLen === 3 && b0 === 0xED && b1 >= 0xA0) return `Error: file appears to be non-UTF-8 (Shift-JIS/Latin-1/binary mix). Edit aborted to prevent silent corruption. Path: ${filePath}`;
        if (seqLen === 4 && b0 === 0xF0 && b1 < 0x90) return `Error: file appears to be non-UTF-8 (Shift-JIS/Latin-1/binary mix). Edit aborted to prevent silent corruption. Path: ${filePath}`;
        if (seqLen === 4 && (b0 > 0xF4 || (b0 === 0xF4 && b1 >= 0x90))) return `Error: file appears to be non-UTF-8 (Shift-JIS/Latin-1/binary mix). Edit aborted to prevent silent corruption. Path: ${filePath}`;
        for (let k = 1; k < seqLen; k++) {
            if ((rawBuf[idx2 + k] & 0xC0) !== 0x80) return `Error: file appears to be non-UTF-8 (Shift-JIS/Latin-1/binary mix). Edit aborted to prevent silent corruption. Path: ${filePath}`;
        }
        idx2 += seqLen;
    }
    return null;
}
