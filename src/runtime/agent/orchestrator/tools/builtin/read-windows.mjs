import { closeSync, openSync, readSync } from 'fs';
import { hashText } from './hash-utils.mjs';
import { displayLineForRead } from './read-lines.mjs';
import { READ_LARGE_TAIL_MAX_BYTES } from './read-constants.mjs';

export function readLargeTailWindowSync(fullPath, st, n) {
    const targetLines = Math.max(1, Math.trunc(n || 20));
    const fd = openSync(fullPath, 'r');
    let tailBytes = Math.min(st.size, Math.max(4096, targetLines * 256));
    let buf = Buffer.allocUnsafe(0);
    let bytesRead = 0;
    try {
        while (true) {
            buf = Buffer.allocUnsafe(tailBytes);
            bytesRead = readSync(fd, buf, 0, tailBytes, st.size - tailBytes);
            let lfCount = 0;
            for (let i = 0; i < bytesRead; i++) {
                if (buf[i] === 10) lfCount++;
            }
            if (tailBytes >= st.size || lfCount > targetLines || tailBytes >= READ_LARGE_TAIL_MAX_BYTES) break;
            tailBytes = Math.min(st.size, READ_LARGE_TAIL_MAX_BYTES, tailBytes * 2);
        }
    } finally {
        closeSync(fd);
    }
    const readWindow = buf.subarray(0, bytesRead);
    const approximate = tailBytes < st.size;
    // Advance past a leading partial UTF-8 codepoint (continuation bytes
    // 0b10xxxxxx) when we did not start at the file head; otherwise the
    // toString decode emits a U+FFFD or splits a multibyte char in two.
    // Bounded by 4 since UTF-8 sequences are at most 4 bytes long.
    let tOff = 0;
    if (approximate) {
        const padding = 4;
        while (tOff < readWindow.length && tOff < padding && (readWindow[tOff] & 0xC0) === 0x80) tOff++;
    }
    const text = readWindow.subarray(tOff).toString('utf-8');
    const lines = text.split('\n');
    // Drop the (likely partial) first line only when we actually started
    // mid-file AND the slice still contains more than one line. Whether
    // the boundary advance consumed bytes or not, the first line in an
    // approximate window can never be trusted to start at a real BOL.
    if (approximate && lines.length > 1) lines.shift();
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const sliced = lines.slice(-targetLines);
    return {
        lines: sliced,
        approximate,
        capped: approximate && tailBytes >= READ_LARGE_TAIL_MAX_BYTES,
        bytesRead,
    };
}

export function readLargeHeadWindowSync(fullPath, st, n) {
    const targetLines = Math.max(1, Math.trunc(n || 20));
    const fd = openSync(fullPath, 'r');
    let headBytes = Math.min(st.size, Math.max(65536, targetLines * 256));
    let buf = Buffer.allocUnsafe(0);
    let bytesRead = 0;
    let prefixHash = '';
    try {
        while (true) {
            buf = Buffer.allocUnsafe(headBytes);
            bytesRead = readSync(fd, buf, 0, headBytes, 0);
            if (!prefixHash && bytesRead > 0) {
                prefixHash = hashText(buf.subarray(0, Math.min(bytesRead, 65536)));
            }
            let lfCount = 0;
            for (let i = 0; i < bytesRead; i++) {
                if (buf[i] === 10) lfCount++;
            }
            if (headBytes >= st.size || lfCount >= targetLines || headBytes >= READ_LARGE_TAIL_MAX_BYTES) break;
            headBytes = Math.min(st.size, READ_LARGE_TAIL_MAX_BYTES, headBytes * 2);
        }
    } finally {
        closeSync(fd);
    }
    if (headBytes < st.size && bytesRead > 0 && buf.subarray(0, bytesRead).indexOf(10) === -1) {
        return { lines: [], prefixHash, capped: true };
    }
    // Cut the head on a UTF-8 codepoint boundary when we did not reach EOF;
    // otherwise the trailing decode can produce a U+FFFD glyph and emit a
    // partial trailing codepoint into the rendered head window. Trim any
    // trailing continuation bytes (0b10xxxxxx) within buf[0..bytesRead),
    // then drop a lead byte whose declared sequence runs past bytesRead.
    let endByte = bytesRead;
    if (headBytes < st.size) {
        while (endByte > 0 && (buf[endByte - 1] & 0xC0) === 0x80) endByte--;
        if (endByte > 0) {
            const lead = buf[endByte - 1];
            const seqLen = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;
            if (seqLen > 1 && (endByte - 1) + seqLen > bytesRead) endByte--;
        }
    }
    const text = buf.subarray(0, endByte).toString('utf-8');
    const lines = text.split('\n');
    if (headBytes >= st.size && lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    // When the head window is approximate (did not reach EOF), the final
    // line is partial by definition — its bytes were arbitrarily cut at
    // the read window edge. Drop it so callers never see a half-line.
    if (headBytes < st.size && lines.length > 1) lines.pop();
    return {
        lines: lines.slice(0, targetLines).map((line, i) => displayLineForRead(line, i)),
        prefixHash,
        capped: headBytes >= READ_LARGE_TAIL_MAX_BYTES && headBytes < st.size,
    };
}
