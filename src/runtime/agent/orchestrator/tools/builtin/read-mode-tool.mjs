import { createReadStream, openSync, readSync, closeSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { isBinaryFile } from './binary-file.mjs';
import { hashText } from './hash-utils.mjs';
import { normalizeOutputPath, countDisplayLines } from './path-utils.mjs';
import { normalizeErrorMessage } from './path-diagnostics.mjs';
import {
    READ_MAX_SIZE_BYTES,
    READ_STREAM_RANGE_MIN_BYTES,
} from './read-constants.mjs';
import {
    LINE_NO_SEP,
    renderReadLine,
} from './read-formatting.mjs';
import {
    displayLineForRead,
    splitRawLinesForHeadTail,
} from './read-lines.mjs';
import {
    openForRead,
    openTextPathForReadMeta,
    detectReadEncoding,
} from './read-open.mjs';
import { capShellOutput } from './shell-output.mjs';
import { countTextStatsStreaming } from './text-stats.mjs';

function requireHelper(helpers, name) {
    const fn = helpers?.[name];
    if (typeof fn !== 'function') throw new Error(`missing read mode helper: ${name}`);
    return fn;
}

// UTF-16 (LE/BE) files pass the binary NUL gate (BOM-exempt) but the
// head/tail/count/summary streaming and small-file paths decode bytes as
// UTF-8, emitting NUL-laden garbage. Detect the BOM up front and decode the
// whole file in-memory, bounded by the same READ_MAX_SIZE_BYTES cap the
// regular read path enforces. BE has no Node string encoding, so swap byte
// pairs to LE (even length) then decode as utf16le — mirrors read-single-tool.
// Returns null for non-UTF-16, { tooLarge:true } past the cap, or { content }.
function decodeUtf16Mode(meta) {
    const enc = detectReadEncoding(meta.fullPath);
    if (enc.encoding !== 'utf16le' && enc.encoding !== 'utf16be') return null;
    if ((meta.st.size ?? 0) > READ_MAX_SIZE_BYTES) return { tooLarge: true };
    const rawBuf = readFileSync(meta.fullPath);
    if (enc.encoding === 'utf16le') {
        return { content: rawBuf.subarray(enc.bomLen).toString('utf16le') };
    }
    const body = rawBuf.subarray(enc.bomLen);
    const even = body.length & ~1;
    return { content: Buffer.from(body.subarray(0, even)).swap16().toString('utf16le') };
}

function utf16TooLargeError(meta) {
    return `Error: UTF-16 file too large for this mode (${meta.st.size} bytes exceeds ${READ_MAX_SIZE_BYTES}-byte cap): ${normalizeOutputPath(meta.fullPath)}`;
}

export async function executeHeadTool(args, workDir, readStateScope, helpers = {}) {
    const streamHeadWindow = requireHelper(helpers, 'streamHeadWindow');
    const recordReadSnapshot = requireHelper(helpers, 'recordReadSnapshot');
    const n = Math.max(1, Math.min(parseInt(args.n ?? 20, 10) || 20, 2000));
    let meta;
    try { meta = openTextPathForReadMeta(args.path, workDir, { enforceSizeCap: false }); }
    catch (err) { return `Error: ${err.message}`; }
    const _u16 = decodeUtf16Mode(meta);
    if (_u16) {
        if (_u16.tooLarge) return utf16TooLargeError(meta);
        const lines = splitRawLinesForHeadTail(_u16.content);
        const sliced = lines.slice(0, n);
        const rendered = sliced.map((l, i) => `${i + 1}${LINE_NO_SEP}${displayLineForRead(l, i)}`).join('\n');
        const out = capShellOutput(rendered);
        if (out === rendered && sliced.length > 0) {
            const isFullFileView = sliced.length >= lines.length;
            recordReadSnapshot(meta.fullPath, meta.st, readStateScope, {
                source: 'read_head',
                fileLineCount: lines.length,
                ranges: isFullFileView ? [{ startLine: 1, endLine: Infinity }] : [{ startLine: 1, endLine: sliced.length }],
                ...(isFullFileView ? { contentHash: hashText(_u16.content) } : { rangeHash: hashText(sliced.join('\n')) }),
            });
        }
        return out;
    }
    if (meta.st.size > READ_STREAM_RANGE_MIN_BYTES) {
        // Binary detection runs before the streamer for medium/large
        // files — otherwise head would happily emit thousands of \uFFFD
        // / NUL-laden lines from a packed binary. The small-file path
        // below relies on openForRead's ETOOBIG branch + the existing
        // small-file UTF-8 read, which already surfaces binary bytes
        // via the same isBinaryFile check.
        if (isBinaryFile(meta.fullPath, meta.st.size ?? 0)) {
            return `Error: file appears to be binary (contains null bytes): ${normalizeOutputPath(meta.fullPath)}`;
        }
        try {
            return await streamHeadWindow(meta.fullPath, meta.st, n, readStateScope, 'read_head_stream');
        } catch (err) {
            return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
        }
    }
    let opened;
    try { opened = await openForRead(args.path, workDir, {}); }
    catch (err) {
        if (err && err.code === 'ETOOBIG') {
            if (err.fullPath && isBinaryFile(err.fullPath, err.size ?? 0)) {
                return `Error: file appears to be binary (contains null bytes): ${normalizeOutputPath(err.fullPath)}`;
            }
            try {
                const stream = createReadStream(err.fullPath, { encoding: 'utf-8' });
                const rl = createInterface({ input: stream, crlfDelay: Infinity });
                const collected = [];
                const rawLines = [];
                for await (let line of rl) {
                    if (collected.length === 0 && line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
                    const lineNo = collected.length + 1;
                    rawLines.push(line);
                    collected.push(renderReadLine(lineNo, line));
                    if (collected.length >= n) { rl.close(); stream.destroy(); break; }
                }
                const rendered = collected.join('\n');
                const out = capShellOutput(rendered);
                if (out === rendered && rawLines.length > 0) {
                    recordReadSnapshot(err.fullPath, err.st, readStateScope, {
                        source: 'read_head_large',
                        ranges: [{ startLine: 1, endLine: rawLines.length }],
                        rangeHash: hashText(rawLines.join('\n')),
                    });
                }
                return out;
            } catch (err2) {
                return `Error: ${normalizeErrorMessage(err2 instanceof Error ? err2.message : String(err2))}`;
            }
        }
        return `Error: ${err.message}`;
    }
    const lines = splitRawLinesForHeadTail(opened.content);
    const sliced = lines.slice(0, n);
    const rendered = sliced.map((l, i) => `${i + 1}${LINE_NO_SEP}${displayLineForRead(l, i)}`).join('\n');
    const out = capShellOutput(rendered);
    if (out === rendered && sliced.length > 0) {
        const isFullFileView = sliced.length >= lines.length;
        const snapshotMeta = {
            source: 'read_head',
            fileLineCount: lines.length,
            ranges: isFullFileView
                ? [{ startLine: 1, endLine: Infinity }]
                : [{ startLine: 1, endLine: sliced.length }],
            ...(isFullFileView ? { contentHash: hashText(opened.content) } : { rangeHash: hashText(sliced.join('\n')) }),
        };
        recordReadSnapshot(opened.fullPath, opened.st, readStateScope, snapshotMeta);
    }
    return out;
}

export async function executeTailTool(args, workDir, readStateScope, helpers = {}) {
    const renderTailWindowSync = requireHelper(helpers, 'renderTailWindowSync');
    const recordReadSnapshot = requireHelper(helpers, 'recordReadSnapshot');
    const n = Math.max(1, Math.min(parseInt(args.n ?? 20, 10) || 20, 2000));
    let meta;
    try { meta = openTextPathForReadMeta(args.path, workDir, { enforceSizeCap: false }); }
    catch (err) { return `Error: ${err.message}`; }
    const _u16 = decodeUtf16Mode(meta);
    if (_u16) {
        if (_u16.tooLarge) return utf16TooLargeError(meta);
        const lines = splitRawLinesForHeadTail(_u16.content);
        const sliced = lines.slice(-n);
        const startIdx = lines.length - sliced.length;
        const rendered = sliced.map((l, i) => `${startIdx + i + 1}${LINE_NO_SEP}${displayLineForRead(l, startIdx + i)}`).join('\n');
        const out = capShellOutput(rendered);
        if (out === rendered && sliced.length > 0) {
            const isFullFileView = sliced.length >= lines.length;
            recordReadSnapshot(meta.fullPath, meta.st, readStateScope, {
                source: 'read_tail',
                fileLineCount: lines.length,
                ranges: isFullFileView ? [{ startLine: 1, endLine: Infinity }] : [{ startLine: startIdx + 1, endLine: lines.length }],
                ...(isFullFileView ? { contentHash: hashText(_u16.content) } : { rangeHash: hashText(sliced.join('\n')) }),
            });
        }
        return out;
    }
    if (meta.st.size > READ_MAX_SIZE_BYTES) {
        try {
            if (isBinaryFile(meta.fullPath, meta.st.size ?? 0)) {
                return `Error: file appears to be binary (contains null bytes): ${normalizeOutputPath(meta.fullPath)}`;
            }
            return renderTailWindowSync(meta.fullPath, meta.st, n, readStateScope, { exactLineNumbers: false, source: 'read_tail_large' });
        } catch (err) {
            return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
        }
    }
    if (meta.st.size > READ_STREAM_RANGE_MIN_BYTES) {
        if (isBinaryFile(meta.fullPath, meta.st.size ?? 0)) {
            return `Error: file appears to be binary (contains null bytes): ${normalizeOutputPath(meta.fullPath)}`;
        }
        try {
            return renderTailWindowSync(meta.fullPath, meta.st, n, readStateScope, { exactLineNumbers: true, source: 'read_tail_window' });
        } catch (err) {
            return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
        }
    }
    let opened;
    try { opened = await openForRead(args.path, workDir, {}); }
    catch (err) {
        if (err && err.code === 'ETOOBIG') {
            try {
                const { fullPath, st } = err;
                if (isBinaryFile(fullPath, st.size ?? 0)) {
                    return `Error: file appears to be binary (contains null bytes): ${normalizeOutputPath(fullPath)}`;
                }
                return renderTailWindowSync(fullPath, st, n, readStateScope, { exactLineNumbers: false, source: 'read_tail_large' });
            } catch (err2) {
                return `Error: ${normalizeErrorMessage(err2 instanceof Error ? err2.message : String(err2))}`;
            }
        }
        return `Error: ${err.message}`;
    }
    const lines = splitRawLinesForHeadTail(opened.content);
    const sliced = lines.slice(-n);
    const startIdx = lines.length - sliced.length;
    const rendered = sliced.map((l, i) => `${startIdx + i + 1}${LINE_NO_SEP}${displayLineForRead(l, startIdx + i)}`).join('\n');
    const out = capShellOutput(rendered);
    if (out === rendered && sliced.length > 0) {
        const isFullFileView = sliced.length >= lines.length;
        const snapshotMeta = {
            source: 'read_tail',
            fileLineCount: lines.length,
            ranges: isFullFileView
                ? [{ startLine: 1, endLine: Infinity }]
                : [{ startLine: startIdx + 1, endLine: lines.length }],
            ...(isFullFileView ? { contentHash: hashText(opened.content) } : { rangeHash: hashText(sliced.join('\n')) }),
        };
        recordReadSnapshot(opened.fullPath, opened.st, readStateScope, snapshotMeta);
    }
    return out;
}

export async function executeWcTool(args, workDir, helpers = {}) {
    const countLogicalLinesBytesSync = requireHelper(helpers, 'countLogicalLinesBytesSync');
    let meta;
    try { meta = openTextPathForReadMeta(args.path, workDir, { enforceSizeCap: false }); }
    catch (err) { return `Error: ${err.message}`; }
    const _u16 = decodeUtf16Mode(meta);
    if (_u16) {
        if (_u16.tooLarge) return utf16TooLargeError(meta);
        const lines = countDisplayLines(_u16.content);
        const words = (_u16.content.match(/\S+/g) || []).length;
        return `lines\t${lines}\twords\t${words}\tbytes\t${meta.st.size}`;
    }
    if (meta.st.size > READ_MAX_SIZE_BYTES) {
        if (isBinaryFile(meta.fullPath, meta.st.size ?? 0)) {
            return `Error: file appears to be binary (contains null bytes): ${normalizeOutputPath(meta.fullPath)}`;
        }
        try {
            const lines = countLogicalLinesBytesSync(meta.fullPath, meta.st.size, meta.st);
            return `lines\t${lines}\twords\t-\tbytes\t${meta.st.size}\t(words skipped: file > cap)`;
        } catch (err) {
            return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
        }
    }
    if (meta.st.size > READ_STREAM_RANGE_MIN_BYTES) {
        if (isBinaryFile(meta.fullPath, meta.st.size ?? 0)) {
            return `Error: file appears to be binary (contains null bytes): ${normalizeOutputPath(meta.fullPath)}`;
        }
        try {
            const stats = await countTextStatsStreaming(meta.fullPath, meta.st.size);
            return `lines\t${stats.lines}\twords\t${stats.words}\tbytes\t${stats.bytes}`;
        } catch (err) {
            return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
        }
    }
    let opened;
    try { opened = await openForRead(args.path, workDir, {}); }
    catch (err) {
        if (err && err.code === 'ETOOBIG') {
            let lines = 0;
            const stream = createReadStream(err.fullPath, { encoding: 'utf-8' });
            const rl = createInterface({ input: stream, crlfDelay: Infinity });
            for await (const _ of rl) lines++;
            return `lines\t${lines}\twords\t-\tbytes\t${err.size}\t(words skipped: file > cap)`;
        }
        return `Error: ${err.message}`;
    }
    const { content, st } = opened;
    const lines = countDisplayLines(content);
    const words = (content.match(/\S+/g) || []).length;
    return `lines\t${lines}\twords\t${words}\tbytes\t${st.size}`;
}

const SUMMARY_SYMBOL_RE = new RegExp([
    '^\\s*(?:export\\s+)?(?:(?:async\\s+)?function|class|interface|type|enum)\\s+[A-Za-z_$][\\w$]*',
    '^\\s*(?:export\\s+)?(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*=',
    '^\\s*(?:def|class)\\s+[A-Za-z_][\\w]*',
    '^\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+[A-Za-z_][\\w]*',
    '^\\s*(?:pub\\s+)?(?:struct|enum|trait|impl)\\s+[A-Za-z_][\\w]*(?:<[^>]+>)?',
    '^\\s*func\\s+(?:\\([^)]*\\)\\s*)?[A-Za-z_][\\w]*\\s*\\(',
    '^\\s*type\\s+[A-Za-z_][\\w]*\\s+(?:struct|interface)\\b',
    '^\\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|async|final)\\s+)*(?:class|interface|enum|record|struct)\\s+[A-Za-z_][\\w]*',
    '^\\s*(?:(?:public|private|protected|internal|static|virtual|override|async|final|synchronized|abstract|partial)\\s+)+(?:[\\w<>\\[\\],.?]+\\s+)+[A-Za-z_][\\w]*\\s*\\(',
    '^\\s*#{1,3}\\s+\\S',
].join('|'));

async function collectSummarySymbols(fullPath, limit) {
    const out = [];
    const stream = createReadStream(fullPath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNo = 0;
    try {
        for await (let line of rl) {
            lineNo += 1;
            if (lineNo === 1 && line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
            if (!SUMMARY_SYMBOL_RE.test(line)) continue;
            out.push(renderReadLine(lineNo, line.trimEnd(), { truncateLongLine: true }));
            if (out.length >= limit) {
                rl.close();
                stream.destroy();
                break;
            }
        }
    } finally {
        stream.destroy();
    }
    return out;
}

// In-memory variant for already-decoded text (UTF-16 path): same regex/limit
// as the streaming collector, but over a decoded string instead of a utf-8
// byte stream.
function collectSummarySymbolsFromContent(content, limit) {
    const out = [];
    const lines = String(content ?? '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (i === 0 && line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
        if (!SUMMARY_SYMBOL_RE.test(line)) continue;
        out.push(renderReadLine(i + 1, line.trimEnd(), { truncateLongLine: true }));
        if (out.length >= limit) break;
    }
    return out;
}

export async function executeSummaryTool(args, workDir, readStateScope, helpers = {}) {
    const countLogicalLinesBytesSync = requireHelper(helpers, 'countLogicalLinesBytesSync');
    const recordReadSnapshot = requireHelper(helpers, 'recordReadSnapshot');
    // Raised from 40/120 to 200/1000: large files (>1500 lines) lose most
    // of their structure under a 40-cap, and the worker ends up calling
    // find_symbol{mode:"overview"} as a follow-up. tail-trim in result-
    // compression remains the actual bound on payload size, so a higher
    // cap costs nothing on small files and surfaces full outline on large.
    const limit = Math.max(1, Math.min(parseInt(args.n ?? args.limit ?? 200, 10) || 200, 1000));
    let meta;
    try { meta = openTextPathForReadMeta(args.path, workDir, { enforceSizeCap: false }); }
    catch (err) { return `Error: ${normalizeErrorMessage(err.message, workDir)}`; }
    if (isBinaryFile(meta.fullPath, meta.st.size ?? 0)) {
        return `Error: file appears to be binary (contains null bytes): ${normalizeOutputPath(args.path || meta.fullPath)}`;
    }

    const _u16 = decodeUtf16Mode(meta);
    if (_u16) {
        if (_u16.tooLarge) return utf16TooLargeError(meta);
        const stats = {
            lines: countDisplayLines(_u16.content),
            words: (_u16.content.match(/\S+/g) || []).length,
            bytes: meta.st.size,
        };
        recordReadSnapshot(meta.fullPath, meta.st, readStateScope, { source: 'read_summary', ranges: [] });
        const symbols = collectSummarySymbolsFromContent(_u16.content, limit);
        const outputPath = normalizeOutputPath(args.path || meta.fullPath);
        const out = [
            `summary ${outputPath}`,
            `lines\t${stats.lines}\twords\t${stats.words}\tbytes\t${stats.bytes}`,
            `symbols\t${symbols.length}${symbols.length >= limit ? ` (capped at ${limit})` : ''}`,
        ];
        if (symbols.length > 0) out.push('', ...symbols);
        else out.push('', '(no obvious symbols/headings found)');
        return capShellOutput(out.join('\n'));
    }

    let stats;
    try {
        stats = meta.st.size > READ_MAX_SIZE_BYTES
            ? { lines: countLogicalLinesBytesSync(meta.fullPath, meta.st.size, meta.st), words: '-', bytes: meta.st.size }
            : (meta.st.size > READ_STREAM_RANGE_MIN_BYTES
                ? await countTextStatsStreaming(meta.fullPath, meta.st.size)
                : null);
        if (!stats) {
            const opened = await openForRead(args.path, workDir, {});
            stats = {
                lines: countDisplayLines(opened.content),
                words: (opened.content.match(/\S+/g) || []).length,
                bytes: opened.st.size,
            };
        }
    } catch (err) {
        return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
    }

    recordReadSnapshot(meta.fullPath, meta.st, readStateScope, {
        source: 'read_summary',
        ranges: [],
    });

    let symbols = [];
    try {
        symbols = await collectSummarySymbols(meta.fullPath, limit);
    } catch { /* best-effort outline */ }
    const outputPath = normalizeOutputPath(args.path || meta.fullPath);
    const lines = [
        `summary ${outputPath}`,
        `lines\t${stats.lines}\twords\t${stats.words}\tbytes\t${stats.bytes}`,
        `symbols\t${symbols.length}${symbols.length >= limit ? ` (capped at ${limit})` : ''}`,
    ];
    if (symbols.length > 0) {
        lines.push('', ...symbols);
    } else {
        lines.push('', '(no obvious symbols/headings found)');
    }
    return capShellOutput(lines.join('\n'));
}

// Hex dump for byte-level/EOL inspection. Binary-safe (no isBinaryFile gate)
// because that is the point of the mode. Default 256 bytes, max 8192 per call,
// paginate via n + offset.
export async function executeHexTool(args, workDir, readStateScope, helpers = {}) {
    const recordReadSnapshot = requireHelper(helpers, 'recordReadSnapshot');
    const n = Math.max(16, Math.min(parseInt(args.n ?? 256, 10) || 256, 8192));
    const offset = Math.max(0, parseInt(args.offset ?? 0, 10) || 0);
    let meta;
    try { meta = openTextPathForReadMeta(args.path, workDir, { enforceSizeCap: false, skipBinary: true }); }
    catch (err) { return `Error: ${err.message}`; }
    let fd;
    try {
        fd = openSync(meta.fullPath, 'r');
        const buf = Buffer.alloc(n);
        const bytesRead = readSync(fd, buf, 0, n, offset);
        const slice = buf.subarray(0, bytesRead);
        const lines = [
            `hex ${normalizeOutputPath(args.path || meta.fullPath)} offset=${offset} read=${bytesRead}/${meta.st.size}`,
        ];
        for (let i = 0; i < bytesRead; i += 16) {
            const chunk = slice.subarray(i, Math.min(i + 16, bytesRead));
            const hex = Array.from(chunk).map((b) => b.toString(16).padStart(2, '0')).join(' ');
            const ascii = Array.from(chunk)
                .map((b) => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.')
                .join('');
            const addrHex = (offset + i).toString(16).padStart(8, '0');
            lines.push(`${addrHex}  ${hex.padEnd(48, ' ')}  |${ascii}|`);
        }
        if (offset + bytesRead < meta.st.size) {
            lines.push(`... ${meta.st.size - offset - bytesRead} more bytes (paginate via n + offset)`);
        }
        recordReadSnapshot(meta.fullPath, meta.st, readStateScope, { source: 'read_hex', ranges: [] });
        return capShellOutput(lines.join('\n'));
    } catch (err) {
        return `Error: ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}`;
    } finally {
        if (fd !== undefined) try { closeSync(fd); } catch { /* fd may already be closed */ }
    }
}
