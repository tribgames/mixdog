import { createReadStream, openSync, readSync, closeSync } from 'fs';
import * as fsPromises from 'fs/promises';
import { createInterface } from 'readline';
import { capShellOutput } from './shell-output.mjs';
import {
    READ_LARGE_TAIL_MAX_BYTES,
    READ_MAX_LINE_COLLECT_BYTES,
    READ_MAX_OUTPUT_BYTES,
    READ_MAX_SCAN_BYTES,
    READ_STREAM_TIMEOUT_MS,
} from './read-constants.mjs';
import {
    buildSmartReadTruncationMarker,
    LINE_NO_SEP,
    renderReadLine,
    SMART_READ_HEAD_LINES,
    SMART_READ_TAIL_LINES,
    truncateReadLineText,
} from './read-formatting.mjs';
import { displayLineForRead } from './read-lines.mjs';
import {
    readLargeHeadWindowSync,
    readLargeTailWindowSync,
} from './read-windows.mjs';
import { mergeReadRanges } from './read-ranges.mjs';
import { hashText } from './hash-utils.mjs';
import {
    getReadRangeIndex,
    maybeRecordReadRangeAnchor,
    nearestReadRangeAnchor,
    scheduleReadRangeIndexPersist,
} from './read-range-index.mjs';

function streamingHooks(hooks = {}) {
    return {
        ioTraceStart: typeof hooks.ioTraceStart === 'function' ? hooks.ioTraceStart : () => 0,
        ioTraceDone: typeof hooks.ioTraceDone === 'function' ? hooks.ioTraceDone : () => {},
        recordReadSnapshot: typeof hooks.recordReadSnapshot === 'function' ? hooks.recordReadSnapshot : () => {},
    };
}

export async function streamReadRange(fullPath, offset, limit, stHint = null, hooks = {}) {
    const { ioTraceStart, ioTraceDone } = streamingHooks(hooks);
    const _displayPath = hooks.displayPath || fullPath;
    const traceStart = ioTraceStart();
    const stForIndex = stHint || await fsPromises.stat(fullPath).catch(() => null);
    const rangeIndex = getReadRangeIndex(fullPath, stForIndex);
    const anchor = nearestReadRangeAnchor(rangeIndex, offset);
    const fh = await fsPromises.open(fullPath, 'r');
    const CHUNK_BYTES = 1024 * 1024;
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    const collected = [];
    let position = anchor.byteOffset;
    let lineIdx = anchor.line;
    let currentLineBytes = 0;
    let collectedBytes = 0;
    let truncated = false;
    let stoppedAtLimit = false;
    let firstEmitted = 0;
    let lastEmitted = 0;
    let pendingParts = [];
    let pendingBytes = 0;
    let lineCollectCapped = false;
    let prefixHash = rangeIndex?.prefixHash || '';
    const deadline = Date.now() + READ_STREAM_TIMEOUT_MS;
    let bytesScanned = anchor.byteOffset;

    const shouldCollectLine = () => lineIdx >= offset && collected.length < limit;
    const renderLine = (lineBuf) => {
        if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 13) {
            lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
        }
        let line = lineBuf.toString('utf-8');
        if (lineIdx === 0 && line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
        // Per-line truncation mirrors the non-streamed path
        // (read-formatting.renderReadLine): a single multi-MB line
        // would otherwise blow past READ_MAX_OUTPUT_BYTES on its
        // own and force the whole window to truncate. renderReadLine
        // applies the same head/tail cap and "[line truncated]"
        // marker so the rendered byte count stays bounded.
        const rendered = renderReadLine(lineIdx + 1, line);
        // Cap is byte-oriented (READ_MAX_OUTPUT_BYTES). String .length counts
        // UTF-16 code units and underestimates bytes for non-ASCII output, so
        // measure with Buffer.byteLength to keep the rendered slice <= cap.
        // Truncation drops the entire rendered line (codepoint-safe by
        // construction), so no mid-codepoint cut can occur here.
        collectedBytes += Buffer.byteLength(rendered, 'utf8') + 1;
        if (collectedBytes > READ_MAX_OUTPUT_BYTES) {
            truncated = true;
            return false;
        }
        collected.push(rendered);
        if (firstEmitted === 0) firstEmitted = lineIdx + 1;
        lastEmitted = lineIdx + 1;
        return true;
    };
    const finishLine = (finalSegment = null, nextLineStartByte = null) => {
        if (shouldCollectLine()) {
            const finalLen = finalSegment ? finalSegment.length : 0;
            let lineBuf;
            if (lineCollectCapped) {
                lineBuf = Buffer.concat(pendingParts, pendingBytes);
                lineBuf = Buffer.from(lineBuf.toString('utf-8').slice(0, READ_MAX_LINE_COLLECT_BYTES));
            } else if (pendingParts.length === 0) {
                lineBuf = finalSegment || Buffer.alloc(0);
            } else if (finalLen > 0 && pendingBytes + finalLen <= READ_MAX_LINE_COLLECT_BYTES) {
                lineBuf = Buffer.concat([...pendingParts, finalSegment], pendingBytes + finalLen);
            } else if (finalLen > 0) {
                const room = Math.max(0, READ_MAX_LINE_COLLECT_BYTES - pendingBytes);
                lineBuf = room > 0
                    ? Buffer.concat([...pendingParts, finalSegment.subarray(0, Math.min(room, finalLen))], pendingBytes + Math.min(room, finalLen))
                    : Buffer.concat(pendingParts, pendingBytes);
            } else {
                lineBuf = Buffer.concat(pendingParts, pendingBytes);
            }
            pendingParts = [];
            pendingBytes = 0;
            lineCollectCapped = false;
            if (!renderLine(lineBuf)) return false;
            if (Number.isFinite(limit) && collected.length >= limit) {
                stoppedAtLimit = true;
                lineIdx++;
                if (nextLineStartByte !== null) maybeRecordReadRangeAnchor(rangeIndex, lineIdx, nextLineStartByte);
                currentLineBytes = 0;
                return false;
            }
        } else {
            pendingParts = [];
            pendingBytes = 0;
        }
        lineIdx++;
        if (nextLineStartByte !== null) maybeRecordReadRangeAnchor(rangeIndex, lineIdx, nextLineStartByte);
        currentLineBytes = 0;
        return true;
    };

    try {
        let stop = false;
        while (!stop) {
            if (Date.now() > deadline) {
                throw new Error(`read timed out after ${READ_STREAM_TIMEOUT_MS}ms`);
            }
            const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, position);
            if (bytesRead === 0) break;
            const chunkStart = position;
            position += bytesRead;
            bytesScanned = position;
            if (bytesScanned > READ_MAX_SCAN_BYTES) {
                throw new Error(`read scan exceeds ${READ_MAX_SCAN_BYTES} bytes`);
            }
            if (!prefixHash && chunkStart === 0) {
                prefixHash = hashText(buf.subarray(0, Math.min(bytesRead, 65536)));
                if (rangeIndex && rangeIndex.prefixHash !== prefixHash) {
                    rangeIndex.prefixHash = prefixHash;
                    scheduleReadRangeIndexPersist(rangeIndex);
                }
            }
            let start = 0;
            if (lineIdx < offset) {
                while (lineIdx < offset && start < bytesRead) {
                    const nl = buf.indexOf(10, start);
                    if (nl === -1 || nl >= bytesRead) {
                        currentLineBytes += bytesRead - start;
                        start = bytesRead;
                        break;
                    }
                    currentLineBytes += nl - start;
                    lineIdx++;
                    const nextLineStartByte = chunkStart + nl + 1;
                    maybeRecordReadRangeAnchor(rangeIndex, lineIdx, nextLineStartByte);
                    currentLineBytes = 0;
                    start = nl + 1;
                }
                if (lineIdx < offset) continue;
            }
            while (start < bytesRead) {
                const nl = buf.indexOf(10, start);
                if (nl === -1 || nl >= bytesRead) break;
                const segment = buf.subarray(start, nl);
                currentLineBytes += segment.length;
                if (!finishLine(segment, chunkStart + nl + 1)) { stop = true; break; }
                start = nl + 1;
            }
            if (stop) break;
            if (start < bytesRead) {
                const segment = buf.subarray(start, bytesRead);
                currentLineBytes += segment.length;
                if (shouldCollectLine() && segment.length > 0) {
                    if (pendingBytes >= READ_MAX_LINE_COLLECT_BYTES) {
                        lineCollectCapped = true;
                    } else {
                        const room = READ_MAX_LINE_COLLECT_BYTES - pendingBytes;
                        const take = Math.min(segment.length, room);
                        if (take > 0) {
                            pendingParts.push(Buffer.from(segment.subarray(0, take)));
                            pendingBytes += take;
                        }
                        if (take < segment.length) lineCollectCapped = true;
                    }
                }
            }
        }
        if (!stop && currentLineBytes > 0) finishLine();
    } finally {
        await fh.close().catch(() => {});
    }

    let out = collected.join('\n');
    if (truncated) {
        out += `\n\n... [output truncated at ${Math.round(READ_MAX_OUTPUT_BYTES/1024)} KB] ...`;
    } else if (stoppedAtLimit) {
        out += `${out ? '\n' : ''}... [range limit reached; next offset: ${offset + collected.length}]`;
    } else if (!out && offset >= lineIdx) {
        out = `(no lines in range; file has ${lineIdx} lines)`;
    }
    ioTraceDone('read_range_stream', traceStart, {
        pathHash: hashText(fullPath).slice(0, 12),
        offset,
        limit: Number.isFinite(limit) ? limit : 'inf',
        anchorLine: anchor.line,
        anchorByte: anchor.byteOffset,
        emitted: collected.length,
        bytes: stForIndex?.size || 0,
    });
    return { text: out, firstEmitted, lastEmitted, prefixHash };
}

export function tryWindowedSmartReadSummary(fullPath, st, source = 'read_smart_stream', hooks = {}) {
    const { ioTraceStart, ioTraceDone } = streamingHooks(hooks);
    const displayPath = hooks.displayPath || fullPath;
    const traceStart = ioTraceStart();
    try {
        const totalLines = countLogicalLinesBytesSync(fullPath, st.size, st, hooks);
        const headCount = Math.min(SMART_READ_HEAD_LINES, totalLines);
        const tailStartIdx = Math.max(headCount, totalLines - SMART_READ_TAIL_LINES);
        const elidedRows = tailStartIdx - headCount;
        if (elidedRows <= 0) return null;

        const head = readLargeHeadWindowSync(fullPath, st, headCount);
        if (head.capped || head.lines.length < headCount) return null;
        const tail = readLargeTailWindowSync(fullPath, st, Math.min(SMART_READ_TAIL_LINES, totalLines - headCount));
        if (tail.capped || tail.lines.length === 0) return null;
        const tailStartLine = Math.max(headCount + 1, totalLines - tail.lines.length + 1);
        const tailRaw = tail.lines.map((line, i) => displayLineForRead(line, tailStartLine + i - 1));
        const headRows = head.lines.map((line, i) => renderReadLine(i + 1, line));
        const tailEntries = tailRaw.map((raw, i) => ({
            lineNo: tailStartLine + i,
            raw,
            rendered: renderReadLine(tailStartLine + i, raw),
        }));

        let headTake = headRows.length;
        let tailTake = tailEntries.length;
        let text = '';
        let selectedHeadRows = headRows;
        let selectedHeadRaw = head.lines;
        let selectedTailEntries = tailEntries;
        const marker = () => buildSmartReadTruncationMarker(totalLines, st.size, displayPath);
        while (true) {
            selectedHeadRows = headRows.slice(0, headTake);
            selectedHeadRaw = head.lines.slice(0, headTake);
            selectedTailEntries = tailEntries.slice(Math.max(0, tailEntries.length - tailTake));
            const headText = selectedHeadRows.join('\n');
            const tailText = selectedTailEntries.map((entry) => entry.rendered).join('\n');
            text = `${headText}\n${marker()}\n${tailText}`;
            // Byte-accurate compare against the byte-oriented cap; head/tail
            // shrinking drops whole rendered rows so the seam never lands
            // mid-codepoint.
            if (Buffer.byteLength(text, 'utf8') <= READ_MAX_OUTPUT_BYTES || (headTake <= 1 && tailTake <= 1)) break;
            if (headTake >= tailTake && headTake > 1) {
                headTake = Math.max(1, Math.floor(headTake * 0.75));
            } else if (tailTake > 1) {
                tailTake = Math.max(1, Math.floor(tailTake * 0.75));
            } else {
                break;
            }
        }

        const ranges = [];
        const rangeHashes = [];
        if (selectedHeadRaw.length > 0) {
            ranges.push({ startLine: 1, endLine: selectedHeadRaw.length });
            rangeHashes.push({ startLine: 1, endLine: selectedHeadRaw.length, hash: hashText(selectedHeadRaw.join('\n')) });
        }
        if (selectedTailEntries.length > 0) {
            const selectedTailStart = selectedTailEntries[0].lineNo;
            const selectedTailEnd = selectedTailEntries[selectedTailEntries.length - 1].lineNo;
            ranges.push({ startLine: selectedTailStart, endLine: selectedTailEnd });
            rangeHashes.push({
                startLine: selectedTailStart,
                endLine: selectedTailEnd,
                hash: hashText(selectedTailEntries.map((entry) => entry.raw).join('\n')),
            });
        }
        const result = {
            text,
            prefixHash: head.prefixHash,
            snapshotMeta: {
                source,
                fileLineCount: totalLines,
                ranges: mergeReadRanges(ranges),
                rangeHashes,
            },
        };
        ioTraceDone('read_smart_window', traceStart, {
            pathHash: hashText(fullPath).slice(0, 12),
            bytes: st.size,
            totalLines,
            head: selectedHeadRaw.length,
            tail: selectedTailEntries.length,
        });
        return result;
    } catch {
        return null;
    }
}

export function renderTailWindowSync(fullPath, st, n, readStateScope, { exactLineNumbers = false, source = 'read_tail_window' } = {}, hooks = {}) {
    const { recordReadSnapshot } = streamingHooks(hooks);
    const tail = readLargeTailWindowSync(fullPath, st, n);
    // Always derive a sensible per-line numbering. With
    // exactLineNumbers:false we previously emitted `(approx)1│ ...`
    // for every line, which collides with editor coordinates. Omit
    // the prefix entirely when the line number isn't trustworthy and
    // surface a single header line so the caller knows numbers were
    // dropped on purpose.
    const totalLines = exactLineNumbers ? countLogicalLinesBytesSync(fullPath, st.size, st, hooks) : 0;
    const startLine = exactLineNumbers ? Math.max(1, totalLines - tail.lines.length + 1) : 0;
    const rendered = tail.lines.map((l, i) => {
        const line = truncateReadLineText(displayLineForRead(l, exactLineNumbers ? startLine + i - 1 : i));
        if (exactLineNumbers) {
            return `${startLine + i}${LINE_NO_SEP}${line}`;
        }
        // Drop the line-number prefix when we cannot honour it
        // exactly; "(approx)1│" misled callers into editing the
        // wrong rows. Leading marker line below explains the omission.
        return line;
    }).join('\n');
    const headerPrefix = !exactLineNumbers
        ? `... [tail of ${tail.lines.length} lines from end of file; line numbers omitted]\n`
        : '';
    const marker = tail.capped
        ? `\n... [tail window capped at ${Math.round(READ_LARGE_TAIL_MAX_BYTES / 1024)} KB]`
        : '';
    const payload = headerPrefix + rendered + marker;
    const out = capShellOutput(payload);
    if (exactLineNumbers && out === payload && tail.lines.length > 0) {
        recordReadSnapshot(fullPath, st, readStateScope, {
            source,
            fileLineCount: totalLines,
            ranges: [{ startLine, endLine: startLine + tail.lines.length - 1 }],
            rangeHash: hashText(tail.lines.join('\n')),
        });
    }
    return out;
}

export function countLogicalLinesBytesSync(fullPath, size, stHint = null, hooks = {}) {
    const { ioTraceStart, ioTraceDone } = streamingHooks(hooks);
    if (!size) return 0;
    const traceStart = ioTraceStart();
    const rangeIndex = stHint ? getReadRangeIndex(fullPath, stHint) : null;
    const fd = openSync(fullPath, 'r');
    const CHUNK_BYTES = 1024 * 1024;
    const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size));
    let position = 0;
    let lines = 0;
    let lastByte = -1;
    const deadline = Date.now() + READ_STREAM_TIMEOUT_MS;
    try {
        while (position < size) {
            if (Date.now() > deadline) throw new Error(`read timed out after ${READ_STREAM_TIMEOUT_MS}ms`);
            const toRead = Math.min(buf.length, size - position);
            const bytesRead = readSync(fd, buf, 0, toRead, position);
            if (bytesRead <= 0) break;
            let start = 0;
            while (start < bytesRead) {
                const nl = buf.indexOf(10, start);
                if (nl === -1 || nl >= bytesRead) break;
                lines++;
                maybeRecordReadRangeAnchor(rangeIndex, lines, position + nl + 1);
                start = nl + 1;
            }
            lastByte = buf[bytesRead - 1];
            position += bytesRead;
        }
    } finally {
        closeSync(fd);
    }
    if (lastByte !== -1 && lastByte !== 10) lines++;
    if (rangeIndex && rangeIndex.totalLines !== lines) {
        rangeIndex.totalLines = lines;
        scheduleReadRangeIndexPersist(rangeIndex);
    }
    ioTraceDone('read_count_lines', traceStart, {
        pathHash: hashText(fullPath).slice(0, 12),
        bytes: size,
        lines,
    });
    return lines;
}

export async function streamHeadWindow(fullPath, st, n, readStateScope, source = 'read_head_stream', hooks = {}) {
    const { recordReadSnapshot } = streamingHooks(hooks);
    const stream = createReadStream(fullPath, { encoding: 'utf-8', signal: AbortSignal.timeout(READ_STREAM_TIMEOUT_MS) });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const collected = [];
    const rawLines = [];
    try {
        for await (let line of rl) {
            if (collected.length === 0 && line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
            const lineNo = collected.length + 1;
            rawLines.push(line);
            collected.push(renderReadLine(lineNo, line));
            if (collected.length >= n) {
                rl.close();
                stream.destroy();
                break;
            }
        }
    } finally {
        try { rl.close(); } catch {}
        try { stream.destroy(); } catch {}
    }
    const rendered = collected.join('\n');
    const out = capShellOutput(rendered);
    if (out === rendered && rawLines.length > 0) {
        recordReadSnapshot(fullPath, st, readStateScope, {
            source,
            ranges: [{ startLine: 1, endLine: rawLines.length }],
            rangeHash: hashText(rawLines.join('\n')),
        });
    }
    return out;
}

export async function streamSmartReadSummary(fullPath, st, source = 'read_smart_stream', hooks = {}) {
    const windowed = tryWindowedSmartReadSummary(fullPath, st, source, hooks);
    if (windowed) return windowed;
    const displayPath = hooks.displayPath || fullPath;

    const fh = await fsPromises.open(fullPath, 'r');
    const CHUNK_BYTES = 1024 * 1024;
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    const headRows = [];
    const headRaw = [];
    const tailRing = new Array(SMART_READ_TAIL_LINES);
    let tailCount = 0;
    let lineNo = 0;
    let position = 0;
    let currentLineStartByte = 0;
    let prefixHash = '';
    let pendingParts = [];
    let pendingBytes = 0;

    const finishLine = (lineBuf, startByte, endByte) => {
        if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 13) {
            lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
        }
        const thisLine = lineNo + 1;
        if (thisLine <= SMART_READ_HEAD_LINES) {
            let raw = lineBuf.toString('utf-8');
            if (lineNo === 0 && raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
            headRaw.push(raw);
            headRows.push(renderReadLine(thisLine, raw));
        } else if (SMART_READ_TAIL_LINES > 0) {
            tailRing[tailCount % SMART_READ_TAIL_LINES] = { lineNo: thisLine, startByte, endByte };
            tailCount++;
        }
        lineNo++;
    };

    const deadline = Date.now() + READ_STREAM_TIMEOUT_MS;
    try {
        while (position < st.size) {
            if (Date.now() > deadline) throw new Error(`read timed out after ${READ_STREAM_TIMEOUT_MS}ms`);
            const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, position);
            if (bytesRead <= 0) break;
            if (!prefixHash && position === 0) {
                prefixHash = hashText(buf.subarray(0, Math.min(bytesRead, 65536)));
            }
            position += bytesRead;
            let start = 0;
            while (start < bytesRead) {
                const nl = buf.indexOf(10, start);
                if (nl === -1 || nl >= bytesRead) break;
                const segment = buf.subarray(start, nl);
                const lineBuf = pendingParts.length === 0
                    ? segment
                    : Buffer.concat([...pendingParts, segment], pendingBytes + segment.length);
                pendingParts = [];
                pendingBytes = 0;
                finishLine(lineBuf, currentLineStartByte, position - bytesRead + nl);
                currentLineStartByte = position - bytesRead + nl + 1;
                start = nl + 1;
            }
            if (start < bytesRead) {
                const segment = buf.subarray(start, bytesRead);
                if (segment.length > 0) {
                    pendingParts.push(Buffer.from(segment));
                    pendingBytes += segment.length;
                }
            }
        }
        if (pendingBytes > 0 || pendingParts.length > 0) {
            const lineBuf = pendingParts.length === 1
                ? pendingParts[0]
                : Buffer.concat(pendingParts, pendingBytes);
            finishLine(lineBuf, currentLineStartByte, st.size);
        }
    } finally {
        await fh.close().catch(() => {});
    }

    const tailLen = Math.min(tailCount, SMART_READ_TAIL_LINES);
    const tailOffsets = [];
    for (let i = tailCount - tailLen; i < tailCount; i++) {
        const entry = tailRing[((i % SMART_READ_TAIL_LINES) + SMART_READ_TAIL_LINES) % SMART_READ_TAIL_LINES];
        if (entry) tailOffsets.push(entry);
    }
    const tailEntries = [];
    if (tailOffsets.length > 0) {
        const firstStart = tailOffsets[0].startByte;
        const lastEnd = tailOffsets[tailOffsets.length - 1].endByte;
        const byteLen = Math.max(0, lastEnd - firstStart);
        let tailWindow = Buffer.alloc(0);
        if (byteLen > 0) {
            const tailFh = await fsPromises.open(fullPath, 'r');
            try {
                tailWindow = Buffer.allocUnsafe(byteLen);
                const { bytesRead } = await tailFh.read(tailWindow, 0, byteLen, firstStart);
                if (bytesRead < byteLen) tailWindow = tailWindow.subarray(0, bytesRead);
            } finally {
                await tailFh.close().catch(() => {});
            }
        }
        for (const entry of tailOffsets) {
            let rawBuf = tailWindow.subarray(entry.startByte - firstStart, entry.endByte - firstStart);
            if (rawBuf.length > 0 && rawBuf[rawBuf.length - 1] === 13) rawBuf = rawBuf.subarray(0, rawBuf.length - 1);
            const raw = rawBuf.toString('utf-8');
            tailEntries.push({ lineNo: entry.lineNo, raw, rendered: renderReadLine(entry.lineNo, raw) });
        }
    }
    const headCount = Math.min(SMART_READ_HEAD_LINES, lineNo);
    const tailStartIdx = Math.max(headCount, lineNo - SMART_READ_TAIL_LINES);
    const elidedRows = tailStartIdx - headCount;
    if (elidedRows <= 0) return null;

    let headTake = headRows.length;
    let tailTake = tailEntries.length;
    let text = '';
    let selectedHeadRows = headRows;
    let selectedHeadRaw = headRaw;
    let selectedTailEntries = tailEntries;
    const marker = () => buildSmartReadTruncationMarker(lineNo, st.size, displayPath);
    while (true) {
        selectedHeadRows = headRows.slice(0, headTake);
        selectedHeadRaw = headRaw.slice(0, headTake);
        selectedTailEntries = tailEntries.slice(Math.max(0, tailEntries.length - tailTake));
        const head = selectedHeadRows.join('\n');
        const tail = selectedTailEntries.map((entry) => entry.rendered).join('\n');
        text = `${head}\n${marker()}\n${tail}`;
        // Byte-accurate compare against the byte-oriented cap; head/tail
        // shrinking drops whole rendered rows so the seam never lands
        // mid-codepoint.
        if (Buffer.byteLength(text, 'utf8') <= READ_MAX_OUTPUT_BYTES || (headTake <= 1 && tailTake <= 1)) break;
        if (headTake >= tailTake && headTake > 1) {
            headTake = Math.max(1, Math.floor(headTake * 0.75));
        } else if (tailTake > 1) {
            tailTake = Math.max(1, Math.floor(tailTake * 0.75));
        } else {
            break;
        }
    }

    const ranges = [];
    const rangeHashes = [];
    if (selectedHeadRaw.length > 0) {
        ranges.push({ startLine: 1, endLine: selectedHeadRaw.length });
        rangeHashes.push({ startLine: 1, endLine: selectedHeadRaw.length, hash: hashText(selectedHeadRaw.join('\n')) });
    }
    if (selectedTailEntries.length > 0) {
        const tailStartLine = selectedTailEntries[0].lineNo;
        const tailEndLine = selectedTailEntries[selectedTailEntries.length - 1].lineNo;
        ranges.push({ startLine: tailStartLine, endLine: tailEndLine });
        rangeHashes.push({
            startLine: tailStartLine,
            endLine: tailEndLine,
            hash: hashText(selectedTailEntries.map((entry) => entry.raw).join('\n')),
        });
    }
    return {
        text,
        prefixHash,
        snapshotMeta: {
            source,
            fileLineCount: lineNo,
            ranges: mergeReadRanges(ranges),
            rangeHashes,
        },
    };
}
