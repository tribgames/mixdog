// OOXML (.docx / .pptx) text extraction for the read tool. Office files are
// ZIP containers holding XML parts; this module implements the minimal ZIP
// central-directory reader (stored + deflate entries via node:zlib) and a
// tag-level text pass over the document/slide XML. No external dependencies.
import { readFile, stat } from 'fs/promises';
import { inflateRawSync } from 'node:zlib';

// Whole-container read cap. Office decks with embedded media can be large;
// the XML parts we extract are a tiny fraction, but the container must be
// read to locate them. Beyond this the caller gets a clear refusal.
const OFFICE_MAX_BYTES = 50 * 1024 * 1024;

const EOCD_SIG = 0x06054b50; // end of central directory
const CDIR_SIG = 0x02014b50; // central directory file header
const LOCAL_SIG = 0x04034b50; // local file header

// Parse the ZIP central directory. Returns Map<name, {method, start, end}>
// where start/end bound the compressed data inside `buf`.
function zipCentralDirectory(buf) {
    // EOCD is at most 22 + 65535 (comment) bytes from the end.
    const scanFrom = Math.max(0, buf.length - 22 - 65535);
    let eocd = -1;
    for (let i = buf.length - 22; i >= scanFrom; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a ZIP container (no end-of-central-directory record)');
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const entries = new Map();
    for (let i = 0; i < count; i++) {
        if (off + 46 > buf.length || buf.readUInt32LE(off) !== CDIR_SIG) break;
        const method = buf.readUInt16LE(off + 10);
        const compressedSize = buf.readUInt32LE(off + 20);
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const localOff = buf.readUInt32LE(off + 42);
        const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
        // Data offset requires the LOCAL header's name/extra lengths (they can
        // differ from the central-directory copy).
        if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === LOCAL_SIG) {
            const lNameLen = buf.readUInt16LE(localOff + 26);
            const lExtraLen = buf.readUInt16LE(localOff + 28);
            const start = localOff + 30 + lNameLen + lExtraLen;
            entries.set(name, { method, start, end: start + compressedSize });
        }
        off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

function zipEntryContent(buf, entry) {
    const raw = buf.subarray(entry.start, entry.end);
    if (entry.method === 0) return raw; // stored
    if (entry.method === 8) return inflateRawSync(raw); // deflate
    throw new Error(`unsupported ZIP compression method ${entry.method}`);
}

function decodeXmlEntities(text) {
    return text
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

// Sequential pass over one XML part: text runs (<w:t>/<a:t>) are captured in
// document order; paragraph closes and explicit breaks become newlines, tabs
// become tabs. Everything else is markup and drops out.
function ooxmlPartText(xml, { textTag, paraTag }) {
    const pattern = new RegExp(
        `<${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${textTag}>` // 1: text run
        + `|</${paraTag}>` // paragraph end
        + '|<w:tab\\b[^>]*/>'
        + `|<(?:w|a):br\\b[^>]*/>`,
        'g',
    );
    let out = '';
    let match;
    while ((match = pattern.exec(xml)) !== null) {
        if (match[1] !== undefined) out += decodeXmlEntities(match[1]);
        else if (match[0].includes('tab')) out += '\t';
        else out += '\n';
    }
    // Collapse the trailing run of blank lines XML part endings produce.
    return out.replace(/\n{3,}/g, '\n\n').trim();
}

function capOutput(text, maxOutputBytes) {
    const buf = Buffer.from(text, 'utf8');
    if (buf.length <= maxOutputBytes) return text;
    return `${buf.subarray(0, maxOutputBytes).toString('utf8').replace(/\uFFFD+$/, '')}\n... [office text truncated at ${maxOutputBytes} bytes]`;
}

/**
 * Extract plain text from a .docx or .pptx file. Always returns a flat string
 * (batch-safe); failures return an "Error: …" string mirroring extractPdfText.
 */
export async function extractOoxmlText(fullPath, { maxOutputBytes = 100 * 1024 } = {}) {
    const ext = String(fullPath).toLowerCase().slice(-5);
    try {
        const st = await stat(fullPath);
        if (st.size > OFFICE_MAX_BYTES) {
            return `Error: office file is ${st.size} bytes (max ${OFFICE_MAX_BYTES}); extract the part you need with a shell unzip instead`;
        }
        const buf = await readFile(fullPath);
        const entries = zipCentralDirectory(buf);
        if (ext === '.docx') {
            const entry = entries.get('word/document.xml');
            if (!entry) return 'Error: no word/document.xml part — not a DOCX document (or an encrypted one)';
            const text = ooxmlPartText(zipEntryContent(buf, entry).toString('utf8'), { textTag: 'w:t', paraTag: 'w:p' });
            return capOutput(text || '(no text content in document)', maxOutputBytes);
        }
        // .pptx: one section per slide, in slide-number order.
        const slides = [...entries.keys()]
            .map((name) => { const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name); return m ? { name, n: Number(m[1]) } : null; })
            .filter(Boolean)
            .sort((a, b) => a.n - b.n);
        if (slides.length === 0) return 'Error: no ppt/slides/*.xml parts — not a PPTX presentation (or an encrypted one)';
        const sections = slides.map(({ name, n }) => {
            const text = ooxmlPartText(zipEntryContent(buf, entries.get(name)).toString('utf8'), { textTag: 'a:t', paraTag: 'a:p' });
            return `--- slide ${n} ---\n${text || '(no text)'}`;
        });
        return capOutput(sections.join('\n\n'), maxOutputBytes);
    } catch (err) {
        return `Error: office extraction failed — ${err instanceof Error ? err.message : String(err)}`;
    }
}