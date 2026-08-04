import { readFile, stat } from 'fs/promises';
import { open } from 'fs/promises';
import { createRequire } from 'module';
import { READ_MAX_SIZE_BYTES } from './read-constants.mjs';
import { imageBlocksFromBuffer } from './read-image-resize.mjs';

const requireCjs = createRequire(import.meta.url);
const DEFAULT_READ_MAX_OUTPUT_BYTES = 100 * 1024;

// PDFs at or under this size are emitted as an Anthropic base64 document
// block (the model reads the rendered PDF directly). Mirrors CC's
// PDF_TARGET_RAW_SIZE (20MB raw → ~27MB base64, under the 32MB request cap).
// Larger PDFs fall back to pdf-parse TEXT extraction.
const PDF_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

// %PDF- magic bytes (0x25 0x50 0x44 0x46 0x2D). A document block must only be
// emitted for a real PDF — sending a non-PDF blob as application/pdf would
// poison the conversation history (the API/model rejects the malformed block).
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

// Per-output text ceiling inside a notebook. A single cell output larger than
// this is replaced with a jq hint (port of CC's large-notebook guidance) so a
// runaway stdout / data dump can't blow the read budget.
const IPYNB_OUTPUT_MAX_CHARS = 10_000;

// Read the leading bytes and confirm the %PDF- magic header. Returns false on
// any IO error (caller treats a non-PDF as text-fallback).
async function fileStartsWithPdfMagic(fullPath) {
    let fh;
    try {
        fh = await open(fullPath, 'r');
        const head = Buffer.alloc(PDF_MAGIC.length);
        const { bytesRead } = await fh.read(head, 0, PDF_MAGIC.length, 0);
        return bytesRead === PDF_MAGIC.length && head.equals(PDF_MAGIC);
    } catch {
        return false;
    } finally {
        if (fh) { try { await fh.close(); } catch {} }
    }
}

// Validate / parse a pages arg ("N" or "N-M", 1-based, span <=20). Returns
// { filter } on success, { error } (a string) on rejection, or { filter: null }
// when no pages arg was supplied.
function parsePagesArg(pagesArg) {
    if (pagesArg == null || pagesArg === '') return { filter: null };
    if (typeof pagesArg !== 'string') {
        return { error: `Error: pages must be a string like "1-5"; got ${typeof pagesArg}` };
    }
    const trimmed = pagesArg.trim();
    const m = trimmed.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) {
        return { error: `Error: pages "${trimmed}" not in "N" or "N-M" form (1-based positive integers)` };
    }
    const from = parseInt(m[1], 10);
    const to = m[2] ? parseInt(m[2], 10) : from;
    if (from < 1 || to < 1) {
        return { error: `Error: pages "${trimmed}" out of range — page numbers are 1-based` };
    }
    if (to < from) {
        return { error: `Error: pages "${trimmed}" inverted — end (${to}) precedes start (${from})` };
    }
    if (to - from + 1 > 20) {
        return { error: `Error: pages "${trimmed}" spans ${to - from + 1} pages; max 20 per request — narrow the range` };
    }
    return { filter: { from, to } };
}

// pdf-parse TEXT extraction. Fallback path for PDFs over the document-block
// size cap, and the always-path when a page range is requested (a base64
// document block can't be page-filtered, so a narrowed read keeps using text).
async function extractPdfTextBody(fullPath, pageFilter, maxOutputBytes) {
    const pdfParse = requireCjs('pdf-parse');
    const buf = await readFile(fullPath);
    const pageTexts = [];
    const data = await pdfParse(buf, {
        pagerender: (pageData) => {
            // pdf-parse exposes either `pageNumber` (1-based, pdf.js) or
            // `_pageIndex` (0-based, internal); preferring pageIndex+1 over
            // pageNumber dropped/duplicated pages when pdf.js renumbered with
            // annotations or oddball page trees. Use pageNumber first.
            const pageNum = (typeof pageData.pageNumber === 'number')
                ? pageData.pageNumber
                : ((pageData._pageIndex ?? pageData.pageIndex ?? 0) + 1);
            if (pageFilter && (pageNum < pageFilter.from || pageNum > pageFilter.to)) return Promise.resolve('');
            return pageData.getTextContent().then((tc) => {
                const text = tc.items.map((i) => i.str).join(' ');
                pageTexts.push({ page: pageNum, text });
                return text;
            });
        },
    });
    let out = pageFilter
        ? pageTexts.map((p) => `--- Page ${p.page} ---\n${p.text}`).join('\n\n')
        : (data.text || '');
    if (out.length > maxOutputBytes) {
        out = out.slice(0, maxOutputBytes) + `\n\n... [PDF output truncated at ${Math.round(maxOutputBytes / 1024)} KB; use pages param to narrow]`;
    }
    return out || '(no text content extracted from PDF)';
}

export async function extractPdfText(fullPath, pagesArg, { maxOutputBytes = DEFAULT_READ_MAX_OUTPUT_BYTES, textOnly = false } = {}) {
    try {
        let pdfStat;
        try { pdfStat = await stat(fullPath); } catch (e) {
            return `Error: pdf stat failed — ${e instanceof Error ? e.message : String(e)}`;
        }

        const pages = parsePagesArg(pagesArg);
        if (pages.error) return pages.error;

        // Document-block path: whole-PDF read, no page range, within the size
        // cap, and confirmed %PDF- magic. Emits a base64 document block the
        // model reads natively (figures, layout, tables) instead of lossy
        // pdf-parse text. The magic-byte guard prevents a non-PDF (mislabelled
        // extension) from poisoning history as a malformed document block.
        // textOnly (batch context) skips the block and always emits text.
        if (!textOnly && !pages.filter && pdfStat.size <= PDF_DOCUMENT_MAX_BYTES) {
            if (await fileStartsWithPdfMagic(fullPath)) {
                const buf = await readFile(fullPath);
                return {
                    content: [{
                        type: 'document',
                        source: {
                            type: 'base64',
                            media_type: 'application/pdf',
                            data: buf.toString('base64'),
                        },
                    }],
                };
            }
            // Not a real PDF — fall through to pdf-parse, which surfaces a
            // clean parse error rather than emitting a bad document block.
        }

        // TEXT fallback: >20MB PDFs, page-filtered reads, or non-magic files.
        return await extractPdfTextBody(fullPath, pages.filter, maxOutputBytes);
    } catch (err) {
        return `Error: pdf-parse failed — ${err instanceof Error ? err.message : String(err)}`;
    }
}

export async function extractIpynbText(fullPath, { maxOutputBytes = DEFAULT_READ_MAX_OUTPUT_BYTES, hasRangeArgs = false, textOnly = false } = {}) {
    // Range args (offset/limit/line) don't map cleanly onto a Jupyter
    // notebook: cells aren't line-addressable in the source JSON, so applying
    // offset:200 against rendered code+markdown would slice mid-cell without
    // matching the line numbers a follow-up `edit` would target. Refuse the
    // range up front and direct the caller to the underlying .ipynb JSON.
    if (hasRangeArgs) {
        return 'Error: range args (offset/limit/line) are not supported for .ipynb extraction — cells are not line-addressable; rename to .json or call read on a converted file for line-level access';
    }
    try {
        let nbStat;
        try { nbStat = await stat(fullPath); } catch (e) {
            return `Error: ipynb stat failed — ${e instanceof Error ? e.message : String(e)}`;
        }
        if (nbStat.size > READ_MAX_SIZE_BYTES) {
            return `Error: notebook too large (size: ${nbStat.size}B, cap: ${READ_MAX_SIZE_BYTES}B) — use a cell range to narrow`;
        }
        const raw = await readFile(fullPath, 'utf-8');
        const nb = JSON.parse(raw);
        const cells = Array.isArray(nb.cells) ? nb.cells : [];

        // Accumulate rendered cells as text, flushing to a text block whenever
        // an image output is hit so block ORDER matches notebook order.
        const blocks = [];
        const textParts = [];
        let textLen = 0;
        const flushText = () => {
            if (textParts.length === 0) return;
            blocks.push({ type: 'text', text: textParts.join('\n\n') });
            textParts.length = 0;
        };
        const pushText = (s) => { textParts.push(s); textLen += s.length; };

        let cellIndex = -1;
        for (const cell of cells) {
            cellIndex += 1;
            const src = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
            if (cell.cell_type === 'markdown') {
                pushText(src);
            } else if (cell.cell_type === 'code') {
                let block = src;
                const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
                // Collect image outputs to emit AFTER this cell's code block.
                const pendingImages = [];
                for (const out of outputs) {
                    const data = out.data || {};
                    if (data['text/plain'] || out.text) {
                        const rawTxt = data['text/plain']
                            ? (Array.isArray(data['text/plain']) ? data['text/plain'].join('') : data['text/plain'])
                            : (Array.isArray(out.text) ? out.text.join('') : out.text);
                        // Port CC behaviour: a single huge output is replaced
                        // with a jq hint rather than dumped inline.
                        if (typeof rawTxt === 'string' && rawTxt.length > IPYNB_OUTPUT_MAX_CHARS) {
                            block += `\n# Output: [large output omitted — ${rawTxt.length} chars; inspect with: cat "${fullPath}" | jq '.cells[${cellIndex}].outputs']`;
                        } else {
                            block += '\n# Output:\n' + rawTxt;
                        }
                    } else if (data['image/png'] || data['image/jpeg']) {
                        const isPng = !!data['image/png'];
                        const b64 = isPng ? data['image/png'] : data['image/jpeg'];
                        const b64str = Array.isArray(b64) ? b64.join('') : b64;
                        pendingImages.push({ mimeType: isPng ? 'image/png' : 'image/jpeg', b64: b64str });
                        block += `\n# Output: [image output — cell ${cellIndex}]`;
                    }
                }
                pushText('```python\n' + block + '\n```');
                // Embed each image output as a real image block (resized via the
                // shared helper). On fallback (sharp absent / decode failure) the
                // image is left as the text placeholder already in `block`.
                // textOnly (batch context) skips embedding entirely — the text
                // placeholder in `block` is the only representation.
                if (!textOnly && pendingImages.length > 0) {
                    flushText();
                    for (const img of pendingImages) {
                        let buf;
                        try { buf = Buffer.from(img.b64, 'base64'); } catch { buf = null; }
                        if (!buf || buf.length === 0) continue;
                        const built = await imageBlocksFromBuffer(buf, img.mimeType, { sourcePath: `${fullPath} [cell ${cellIndex}]` });
                        if (built) {
                            if (built.textBlock) blocks.push(built.textBlock);
                            blocks.push(built.imageBlock);
                        }
                        // built === null → sharp unavailable; placeholder text already emitted.
                    }
                }
            }
        }
        flushText();

        // Output-byte cap on the combined TEXT. Image blocks are not counted
        // (they're already size-bounded by the resize helper).
        if (textLen > maxOutputBytes) {
            // Trim trailing text blocks until under the cap, then mark the cut.
            let running = 0;
            const capped = [];
            let truncated = false;
            for (const b of blocks) {
                if (b.type !== 'text') { capped.push(b); continue; }
                if (running >= maxOutputBytes) { truncated = true; continue; }
                if (running + b.text.length > maxOutputBytes) {
                    capped.push({ type: 'text', text: b.text.slice(0, maxOutputBytes - running) });
                    running = maxOutputBytes;
                    truncated = true;
                } else {
                    capped.push(b);
                    running += b.text.length;
                }
            }
            if (truncated) capped.push({ type: 'text', text: `\n\n... [notebook output truncated at ${Math.round(maxOutputBytes / 1024)} KB]` });
            blocks.length = 0;
            blocks.push(...capped);
        }

        const hasImageBlock = blocks.some((b) => b.type === 'image');
        if (blocks.length === 0) return '(empty notebook)';
        // No embedded images → return the joined TEXT string (backwards
        // compatible: works in batch reads and the loop's text path). Images
        // present → return a content-block ARRAY so the model can see them.
        if (!hasImageBlock) {
            return blocks.map((b) => b.text).join('\n\n') || '(empty notebook)';
        }
        return { content: blocks };
    } catch (err) {
        return `Error: ipynb parse failed — ${err instanceof Error ? err.message : String(err)}`;
    }
}
