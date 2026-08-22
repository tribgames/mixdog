import { open } from 'fs/promises';
import { hashText } from './hash-utils.mjs';
import { displayLineForRead } from './read-lines.mjs';
import { READ_LARGE_TAIL_MAX_BYTES } from './read-constants.mjs';

export async function readLargeTailWindowSync(fullPath, st, n) {
    const targetLines = Math.max(1, Math.trunc(n || 20));
    const fh = await open(fullPath, 'r');
    let tailBytes = Math.min(st.size, Math.max(4096, targetLines * 256));
    let buf = Buffer.allocUnsafe(0);
    let bytesRead = 0;
    try {
        while (true) {
            buf = Buffer.allocUnsafe(tailBytes);
            ({ bytesRead } = await fh.read(buf, 0, tailBytes, st.size - tailBytes));
            let lfCount = 0;
            for (let i = 0; i < bytesRead; i++) {
                if (buf[i] === 10) lfCount++;
            }
            if (tailBytes >= st.size || lfCount > targetLines || tailBytes >= READ_LARGE_TAIL_MAX_BYTES) break;
            tailBytes = Math.min(st.size, READ_LARGE_TAIL_MAX_BYTES, tailBytes * 2);
        }
    } finally {
        await fh.close();
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

export async function readLargeHeadWindowSync(fullPath, st, n) {
    const targetLines = Math.max(1, Math.trunc(n || 20));
    const fh = await open(fullPath, 'r');
    let headBytes = Math.min(st.size, Math.max(65536, targetLines * 256));
    let buf = Buffer.allocUnsafe(0);
    let bytesRead = 0;
    let prefixHash = '';
    try {
        while (true) {
            buf = Buffer.allocUnsafe(headBytes);
            ({ bytesRead } = await fh.read(buf, 0, headBytes, 0));
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
        await fh.close();
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
        // Walk back over the trailing continuation bytes to their lead byte and
        // decide ONCE: a complete sequence is kept whole, an incomplete one is
        // dropped whole. The previous version stripped the continuation bytes
        // first and then compared the lead against the untrimmed length, so a
        // COMPLETE multi-byte character at the cut lost its continuations and
        // rendered as a replacement glyph.
        let leadIdx = endByte - 1;
        let contBytes = 0;
        while (leadIdx >= 0 && (buf[leadIdx] & 0xC0) === 0x80 && contBytes < 3) {
            leadIdx--;
            contBytes++;
        }
        if (leadIdx >= 0) {
            const lead = buf[leadIdx];
            const seqLen = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;
            if (seqLen === 1) {
                // ASCII (or a stray continuation run): drop only the strays.
                endByte = contBytes === 0 ? bytesRead : leadIdx + 1;
            } else if (leadIdx + seqLen <= bytesRead) {
                endByte = bytesRead; // complete codepoint at the boundary
            } else {
                endByte = leadIdx;   // truncated codepoint — drop it entirely
            }
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
