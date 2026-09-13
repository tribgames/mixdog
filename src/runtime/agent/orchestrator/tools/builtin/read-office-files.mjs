// OOXML (.docx / .pptx / .xlsx) text extraction for the read tool. Office
// files are ZIP containers holding XML parts; this module implements the
// minimal ZIP central-directory reader (stored + deflate entries via
// node:zlib) and a tag-level pass over the document, slide, and sheet XML.
// No external dependencies.
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
// become tabs. A table keeps its shape — cells are separated by tabs and rows
// by newlines — because one value per line loses which column it belongs to.
// Everything else is markup and drops out.
// A figure is content the page shows, but it carries no text runs: read as
// plain text a picture or a chart vanished completely, so a figure-led report
// looked like prose with a gap. The marker says what sits there, and repeats
// the description the file gives a reader who cannot see it.
function drawingMarker(xml) {
    const kind = /<c:chart\b|\bchart"|<cx:chart\b/.test(xml)
        ? 'chart'
        : /<dgm:relIds\b|diagramData/.test(xml)
            ? 'diagram'
            : 'image';
    const descr = decodeXmlEntities(/<(?:wp|pic|p|xdr):(?:docPr|cNvPr)\b[^>]*\bdescr="([^"]+)"/.exec(xml)?.[1] || '').trim();
    return descr ? `[${kind}: ${descr}]` : `[${kind}]`;
}

// Word can hide a run (w:vanish): the words stay in the file and the page does
// not show them — a template's internal remark, a withdrawn clause. Read as
// ordinary prose they are quoted back as the document's own words, so a passage
// the document withholds is marked as one instead of dropped or trusted.
function markHiddenWordRuns(xml) {
    if (!/<w:vanish\b/.test(xml)) return xml;
    const OPEN = '<w:r><w:t>[hidden: </w:t></w:r>';
    const CLOSE = '<w:r><w:t>]</w:t></w:r>';
    let out = '';
    let cursor = 0;
    let open = false;
    for (const run of xml.matchAll(/<w:r\b(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g)) {
        const properties = /<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/.exec(run[0])?.[0] || '';
        const hidden = /<w:vanish\b(?![^>]*\bw:val="(?:false|0)")/.test(properties) && /<w:t[\s>]/.test(run[0]);
        const gap = xml.slice(cursor, run.index);
        // A paragraph break ends the marked passage even when the next run hides too.
        if (open && (!hidden || gap.includes('</w:p>'))) {
            out += CLOSE;
            open = false;
        }
        out += gap;
        if (hidden && !open) {
            out += OPEN;
            open = true;
        }
        out += run[0];
        cursor = run.index + run[0].length;
    }
    return `${out}${open ? CLOSE : ''}${xml.slice(cursor)}`;
}

// PowerPoint's selection pane hides a shape: it stays in the file and the slide
// does not show it — a superseded draft, a production note. Read as ordinary
// slide text it is quoted back as what the page says.
function markHiddenSlideShapes(xml) {
    if (!/<p:cNvPr\b[^>]*\bhidden="(?:1|true)"/.test(xml)) return xml;
    return xml.replace(/<p:(sp|pic|graphicFrame)\b[\s\S]*?<\/p:\1>/g, (block) => {
        if (!/<p:cNvPr\b[^>]*\bhidden="(?:1|true)"/.test(block)) return block;
        const inside = ooxmlPartText(block, { textTag: 'a:t', paraTag: 'a:p' }).replace(/\s*\n+\s*/g, ' ').trim();
        const label = (inside || drawingMarker(block).replace(/^\[|\]$/g, ''))
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;');
        return `<a:p><a:r><a:t>[hidden: ${label}]</a:t></a:r></a:p>`;
    });
}

function ooxmlPartText(xml, { textTag, paraTag, notes = null }) {
    const pattern = new RegExp(
        `<${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${textTag}>` // 1: text run
        + `|</${paraTag}>` // paragraph end
        + '|</(?:w|a):tc>' // table cell end
        + '|</(?:w|a):tr>' // table row end
        + '|<w:tab\\b[^>]*/>'
        + '|<(?:w|a):br\\b[^>]*/>'
        + '|<w:(?:foot|end)noteReference\\b[^>]*/>' // a citation marker
        + '|<w:drawing\\b[\\s\\S]*?</w:drawing>' // a Word figure
        + '|<p:pic\\b[\\s\\S]*?</p:pic>' // a slide picture
        + '|<p:graphicFrame\\b[\\s\\S]*?</p:graphicFrame>', // a slide chart, table, or diagram
        'g',
    );
    let out = '';
    let match;
    // A figure already ends its own line, so the paragraph that holds it must
    // not add a second one and leave a blank line in the middle of the prose.
    let afterFigure = false;
    while ((match = pattern.exec(xml)) !== null) {
        if (match[1] !== undefined) {
            out += decodeXmlEntities(match[1]);
            afterFigure = false;
        } else if (match[0].startsWith('<w:drawing') || match[0].startsWith('<p:pic')) {
            if (out && !out.endsWith('\n')) out += '\n';
            out += drawingMarker(match[0]);
            // A Word text box lives inside the drawing; its words stay readable.
            const inside = [...match[0].matchAll(/<w:txbxContent\b[^>]*>([\s\S]*?)<\/w:txbxContent>/g)]
                .map(([, box]) => ooxmlPartText(box, { textTag, paraTag }))
                .filter(Boolean)
                .join(' ');
            if (inside) out += ` ${inside.replace(/\s*\n+\s*/g, ' ')}`;
            out += '\n';
            afterFigure = true;
        } else if (match[0].startsWith('<w:footnoteReference') || match[0].startsWith('<w:endnoteReference')) {
            // The citation is where the sentence puts it; the note's own words
            // are collected under the body so the source survives the read.
            if (notes) {
                notes.push({
                    kind: match[0].startsWith('<w:endnoteReference') ? 'endnote' : 'footnote',
                    id: /\bw:id="(-?\d+)"/.exec(match[0])?.[1] || '',
                });
                out += `[note ${notes.length}]`;
                afterFigure = false;
            }
        } else if (match[0].startsWith('<p:graphicFrame')) {
            // The frame holds a table, a chart, or a diagram. A table is words
            // the reader needs; the other two carry none, so they are named.
            const inner = match[0]
                .replace(/^<p:graphicFrame\b[^>]*>/, '')
                .replace(/<\/p:graphicFrame>$/, '');
            if (/<a:tbl\b/.test(inner)) {
                const rows = ooxmlPartText(inner, { textTag, paraTag });
                if (rows) {
                    if (out && !out.endsWith('\n')) out += '\n';
                    out += `${rows}\n`;
                }
                afterFigure = Boolean(rows);
            } else {
                if (out && !out.endsWith('\n')) out += '\n';
                out += `${drawingMarker(match[0])}\n`;
                afterFigure = true;
            }
        } else if (match[0].endsWith(':tc>')) {
            out = `${out.replace(/[\t\n]+$/, '')}\t`;
            afterFigure = false;
        } else if (match[0].endsWith(':tr>')) {
            out = `${out.replace(/[\t\n]+$/, '')}\n`;
            afterFigure = false;
        } else if (match[0].includes('tab')) {
            out += '\t';
            afterFigure = false;
        } else {
            if (!afterFigure) out += '\n';
            afterFigure = false;
        }
    }
    // Collapse the trailing run of blank lines XML part endings produce.
    return out.replace(/\n{3,}/g, '\n\n').trim();
}

// A workbook's text is its grid: sheet by sheet, one row per line, cells
// separated by tabs and empty columns kept so a value stays under its header.
// A formula cell reads as the value Excel last cached for it, which is what
// the sheet shows.
const SHEET_MAX_ROWS = 5000;

// The first eight bytes of every legacy Office (OLE compound) file.
const OLE_COMPOUND_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function columnIndex(reference) {
    const letters = /^[A-Z]+/.exec(String(reference).toUpperCase())?.[0] || '';
    let index = 0;
    for (const letter of letters) index = (index * 26) + (letter.charCodeAt(0) - 64);
    return Math.max(1, index);
}

function sharedStringTable(xml) {
    if (!xml) return [];
    return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map(([, inner]) => (
        [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
            .map(([, text]) => decodeXmlEntities(text))
            .join('')
    ));
}

// Excel stores a date as a day count and a percentage as a fraction, so a
// reader that prints the stored value answers "46311" for a deadline of
// 2026-10-15 and "0.928" for 92.8%. The cell's own number format says which,
// and these two are the ones that change the meaning of the value.
const BUILTIN_NUMBER_FORMATS = new Map([
    [9, '0%'], [10, '0.00%'],
    [14, 'm/d/yyyy'], [15, 'd-mmm-yy'], [16, 'd-mmm'], [17, 'mmm-yy'],
    [18, 'h:mm AM/PM'], [19, 'h:mm:ss AM/PM'], [20, 'h:mm'], [21, 'h:mm:ss'],
    [22, 'm/d/yyyy h:mm'], [45, 'mm:ss'], [46, '[h]:mm:ss'], [47, 'mm:ss.0'],
]);

function cellNumberFormats(xml) {
    if (!xml) return [];
    const custom = new Map([...xml.matchAll(/<numFmt\b[^>]*\bnumFmtId="(\d+)"[^>]*\bformatCode="([^"]*)"/g)]
        .map(([, id, code]) => [Number(id), decodeXmlEntities(code)]));
    const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] || '';
    return [...cellXfs.matchAll(/<xf\b([^>]*?)\/?>/g)].map(([, attributes]) => {
        const id = Number(/\bnumFmtId="(\d+)"/.exec(attributes)?.[1] || 0);
        return custom.get(id) || BUILTIN_NUMBER_FORMATS.get(id) || '';
    });
}

function displayedNumber(raw, format) {
    const number = Number(raw);
    if (!Number.isFinite(number) || !format) return raw;
    // Literals and escaped characters are text, not format tokens.
    const code = String(format).replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
    const date = /[yd]/i.test(code);
    const time = /[hs]/i.test(code);
    if (date || time) {
        const stamp = new Date(Math.round((number - 25569) * 86400000));
        if (Number.isNaN(stamp.getTime())) return raw;
        const pad = (value) => String(value).padStart(2, '0');
        const day = `${stamp.getUTCFullYear()}-${pad(stamp.getUTCMonth() + 1)}-${pad(stamp.getUTCDate())}`;
        const clock = `${pad(stamp.getUTCHours())}:${pad(stamp.getUTCMinutes())}`
            + (/s/i.test(code) ? `:${pad(stamp.getUTCSeconds())}` : '');
        if (date && time) return `${day} ${clock}`;
        return date ? day : clock;
    }
    if (code.includes('%')) {
        const decimals = (/\.([0#]+)/.exec(code)?.[1] || '').length;
        return `${(number * 100).toFixed(decimals)}%`;
    }
    return raw;
}

function columnName(index) {
    let name = '';
    let remaining = index;
    while (remaining > 0) {
        const step = (remaining - 1) % 26;
        name = `${String.fromCharCode(65 + step)}${name}`;
        remaining = Math.floor((remaining - 1) / 26);
    }
    return name;
}

// A sheet hides rows and columns the same way it hides a whole sheet: the values
// stay in the file and the workbook does not show them — a filtered view, a
// working column. Read as ordinary cells they enter the answer as what the sheet
// says, and an edit written into a hidden column lands where nobody looks.
function hiddenColumnNumbers(xml) {
    const declarations = /<cols\b[^>]*>([\s\S]*?)<\/cols>/.exec(xml)?.[1] || '';
    const hidden = [];
    for (const [, attributes] of declarations.matchAll(/<col\b([^>]*?)\/?>/g)) {
        if (!/\bhidden="(?:1|true)"/.test(attributes)) continue;
        const first = Number(/\bmin="(\d+)"/.exec(attributes)?.[1] || 0);
        const last = Number(/\bmax="(\d+)"/.exec(attributes)?.[1] || first);
        if (!first) continue;
        for (let index = first; index <= last && index - first < 64; index += 1) hidden.push(index);
    }
    return hidden;
}

function worksheetRows(xml, strings, formats = []) {
    const lines = [];
    let truncated = false;
    for (const row of xml.matchAll(/<row(\s[^>]*)?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const rowAttributes = row[1] || '';
        const rowXml = row[2];
        if (lines.length >= SHEET_MAX_ROWS) { truncated = true; break; }
        const cells = [];
        for (const cell of (rowXml || '').matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const attributes = cell[1] || '';
            const inner = cell[2] || '';
            const type = /\bt="([^"]+)"/.exec(attributes)?.[1] || 'n';
            let text = '';
            if (type === 's') {
                const index = Number(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1]);
                text = strings[index] ?? '';
            } else if (type === 'inlineStr') {
                text = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
                    .map(([, value]) => decodeXmlEntities(value)).join('');
            } else {
                text = decodeXmlEntities(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1] || '');
                const style = Number(/\bs="(\d+)"/.exec(attributes)?.[1] ?? NaN);
                if (text && Number.isInteger(style)) text = displayedNumber(text, formats[style] || '');
            }
            const column = columnIndex(/\br="([^"]+)"/.exec(attributes)?.[1] || '');
            while (cells.length < column - 1) cells.push('');
            cells[column - 1] = text;
        }
        const line = cells.join('\t').replace(/\t+$/, '');
        lines.push(line && /\bhidden="(?:1|true)"/.test(rowAttributes) ? `[hidden] ${line}` : line);
    }
    while (lines.length && !lines.at(-1)) lines.pop();
    const header = (lines[0] || '').replace(/^\[hidden\] /, '').split('\t');
    const hiddenColumns = hiddenColumnNumbers(xml).map((index) => {
        const label = String(header[index - 1] || '').trim();
        return label ? `${columnName(index)} (${label})` : columnName(index);
    });
    return { text: lines.join('\n'), truncated, hiddenColumns };
}

// Speaker notes carry what the slide does not say out loud. They live in a
// separate part, so a deck read without them looks complete while the
// narration is missing; only the body placeholder is notes text — the rest of
// that part is the slide thumbnail and its page number.
function slideNotesText(buf, entries, slidePart) {
    const relsName = slidePart.replace(/^ppt\/slides\//, 'ppt/slides/_rels/').concat('.rels');
    const relsEntry = entries.get(relsName);
    if (!relsEntry) return '';
    const rels = zipEntryContent(buf, relsEntry).toString('utf8');
    const target = [...rels.matchAll(/<Relationship\b[^>]*\bTarget="([^"]+)"/g)]
        .map(([, value]) => String(value))
        .find((value) => /notesSlide\d+\.xml$/.test(value));
    if (!target) return '';
    const notesEntry = entries.get(`ppt/${target.replace(/^\.\.\//, '')}`);
    if (!notesEntry) return '';
    const xml = zipEntryContent(buf, notesEntry).toString('utf8');
    return [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)]
        .filter((shape) => /<p:ph\b[^>]*\btype="body"/.test(shape[0]))
        .map((shape) => ooxmlPartText(shape[0], { textTag: 'a:t', paraTag: 'a:p' }))
        .filter(Boolean)
        .join('\n')
        .trim();
}

// A footnote is where a report keeps the source of the figure beside it, and it
// lives in its own part: read as body text alone, every citation disappeared.
function noteBodies(buf, entries, part, tag) {
    const xml = partText(buf, entries, part);
    const bodies = new Map();
    if (!xml) return bodies;
    const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'g');
    for (const [, attributes, inner] of xml.matchAll(pattern)) {
        // The separator rules Word draws above the note area carry a type and
        // no words; they are not notes.
        if (/\bw:type="/.test(attributes)) continue;
        const id = /\bw:id="(-?\d+)"/.exec(attributes)?.[1] || '';
        bodies.set(id, ooxmlPartText(inner, { textTag: 'w:t', paraTag: 'w:p' }).replace(/\s*\n+\s*/g, ' ').trim());
    }
    return bodies;
}

// A header and a footer print on every page — the confidentiality mark, the
// document number, the revision. They live in their own parts, so a document
// read from the body alone loses what each of its pages actually says. The page
// number itself is dropped: a bare numeral says nothing once the page is gone.
function documentChromeText(buf, entries) {
    const sections = [];
    for (const kind of ['header', 'footer']) {
        const pattern = new RegExp(`^word/${kind}\\d+\\.xml$`);
        const seen = new Set();
        const lines = [];
        for (const name of [...entries.keys()].filter((entry) => pattern.test(entry)).sort()) {
            const xml = markHiddenWordRuns(zipEntryContent(buf, entries.get(name)).toString('utf8'));
            for (const line of ooxmlPartText(xml, { textTag: 'w:t', paraTag: 'w:p' }).split('\n')) {
                const text = line.trim();
                // The same header repeats as the first-page and even-page variant.
                if (!text || seen.has(text) || /^[\d\s./\-–—]+$/.test(text)) continue;
                seen.add(text);
                lines.push(text);
            }
        }
        if (lines.length) sections.push(`--- ${kind} ---\n${lines.join('\n')}`);
    }
    return sections.length ? `\n\n${sections.join('\n\n')}` : '';
}

function documentNotes(buf, entries, notes) {
    if (!notes.length) return '';
    const bodies = {
        footnote: noteBodies(buf, entries, 'word/footnotes.xml', 'w:footnote'),
        endnote: noteBodies(buf, entries, 'word/endnotes.xml', 'w:endnote'),
    };
    const lines = notes.map((note, index) => `[note ${index + 1}] ${bodies[note.kind].get(note.id) || '(note text missing)'}`);
    return `\n\n--- notes ---\n${lines.join('\n')}`;
}

// A sheet's chart is its message, and it lives outside the cell grid: read as
// rows alone, a dashboard sheet came back empty. Each figure is named after the
// grid, with the chart's own title when it has one.
function partText(buf, entries, name) {
    const entry = name ? entries.get(name) : null;
    return entry ? zipEntryContent(buf, entry).toString('utf8') : '';
}

function relatedPart(target, ownerPart) {
    const base = String(ownerPart).replace(/\/[^/]+$/, '');
    const value = String(target).replace(/^\//, '');
    if (!value.startsWith('..')) return value.startsWith('xl/') ? value : `${base}/${value}`;
    return value.replace(/^\.\.\//, `${base.replace(/\/[^/]+$/, '')}/`);
}

function sheetFigures(buf, entries, sheetPart) {
    const sheetRels = partText(buf, entries, sheetPart.replace(/([^/]+)$/, '_rels/$1.rels'));
    const drawingTarget = [...sheetRels.matchAll(/<Relationship\b[^>]*\bTarget="([^"]+)"/g)]
        .map(([, value]) => String(value))
        .find((value) => /drawings\/drawing\d+\.xml$/.test(value));
    if (!drawingTarget) return [];
    const drawingPart = relatedPart(drawingTarget, sheetPart);
    const drawing = partText(buf, entries, drawingPart);
    if (!drawing) return [];
    const drawingRels = partText(buf, entries, drawingPart.replace(/([^/]+)$/, '_rels/$1.rels'));
    const targets = new Map([...drawingRels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)]
        .map(([, id, target]) => [id, relatedPart(target, drawingPart)]));
    const figures = [];
    for (const [anchor] of drawing.matchAll(/<xdr:(?:absoluteAnchor|twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/xdr:(?:absoluteAnchor|twoCellAnchor|oneCellAnchor)>/g)) {
        const chartId = /<c:chart\b[^>]*\br:id="([^"]+)"/.exec(anchor)?.[1];
        if (chartId) {
            const chartXml = partText(buf, entries, targets.get(chartId));
            const title = ooxmlPartText(/<c:title\b[\s\S]*?<\/c:title>/.exec(chartXml)?.[0] || '', { textTag: 'a:t', paraTag: 'a:p' })
                .replace(/\s*\n+\s*/g, ' ')
                .trim();
            figures.push(title ? `[chart: ${title}]` : '[chart]');
            continue;
        }
        if (/<xdr:pic\b/.test(anchor)) figures.push(drawingMarker(anchor));
    }
    return figures;
}

function capOutput(text, maxOutputBytes) {
    const buf = Buffer.from(text, 'utf8');
    if (buf.length <= maxOutputBytes) return text;
    return `${buf.subarray(0, maxOutputBytes).toString('utf8').replace(/\uFFFD+$/, '')}\n... [office text truncated at ${maxOutputBytes} bytes]`;
}

/**
 * Extract plain text from a .docx, .pptx, or .xlsx/.xlsm file. Always returns
 * a flat string (batch-safe); failures return an "Error: …" string mirroring
 * extractPdfText.
 */
export async function extractOoxmlText(fullPath, { maxOutputBytes = 100 * 1024 } = {}) {
    const ext = String(fullPath).toLowerCase().slice(-5);
    const spreadsheet = ext === '.xlsx' || ext === '.xlsm';
    try {
        const st = await stat(fullPath);
        if (st.size > OFFICE_MAX_BYTES) {
            return `Error: office file is ${st.size} bytes (max ${OFFICE_MAX_BYTES}); extract the part you need with a shell unzip instead`;
        }
        const buf = await readFile(fullPath);
        // A legacy .doc/.xls/.ppt is an OLE compound file, not a ZIP package —
        // and it often arrives renamed to .docx. "Not a ZIP container" tells the
        // reader nothing it can act on; the format and the way out do.
        if (buf.subarray(0, 8).equals(OLE_COMPOUND_MAGIC)) {
            return 'Error: this is a legacy Office file (.doc/.xls/.ppt), not an Office Open XML package'
                + ' — open it in Word, Excel, or PowerPoint and save a copy as .docx/.xlsx/.pptx, then read that copy';
        }
        const entries = zipCentralDirectory(buf);
        if (ext === '.docx') {
            const entry = entries.get('word/document.xml');
            if (!entry) return 'Error: no word/document.xml part — not a DOCX document (or an encrypted one)';
            const notes = [];
            const body = markHiddenWordRuns(zipEntryContent(buf, entry).toString('utf8'));
            const text = ooxmlPartText(body, { textTag: 'w:t', paraTag: 'w:p', notes });
            const cited = documentNotes(buf, entries, notes);
            const chrome = documentChromeText(buf, entries);
            return capOutput(`${text || '(no text content in document)'}${cited}${chrome}`, maxOutputBytes);
        }
        if (spreadsheet) {
            const workbookEntry = entries.get('xl/workbook.xml');
            if (!workbookEntry) return 'Error: no xl/workbook.xml part — not an Excel workbook (or an encrypted one)';
            const workbook = zipEntryContent(buf, workbookEntry).toString('utf8');
            const relationships = new Map();
            const relsEntry = entries.get('xl/_rels/workbook.xml.rels');
            if (relsEntry) {
                const rels = zipEntryContent(buf, relsEntry).toString('utf8');
                for (const [, id, target] of rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)) {
                    relationships.set(id, `xl/${String(target).replace(/^\/?xl\//, '').replace(/^\.\//, '')}`);
                }
            }
            const stringsEntry = entries.get('xl/sharedStrings.xml');
            const strings = sharedStringTable(stringsEntry ? zipEntryContent(buf, stringsEntry).toString('utf8') : '');
            const formats = cellNumberFormats(partText(buf, entries, 'xl/styles.xml'));
            const sections = [];
            for (const [, attributes] of workbook.matchAll(/<sheet\b([^>]*)\/>/g)) {
                // A hidden sheet is content the workbook does not show; reading
                // it as an ordinary sheet presents withheld data as the answer.
                const state = (/\bstate="([^"]*)"/.exec(attributes)?.[1] || '').toLowerCase();
                const label = state === 'hidden' || state === 'veryhidden' ? ` (${state === 'hidden' ? 'hidden' : 'very hidden'})` : '';
                const name = `${decodeXmlEntities(/\bname="([^"]*)"/.exec(attributes)?.[1] || '')}${label}`;
                const relationshipId = /\br:id="([^"]+)"/.exec(attributes)?.[1] || '';
                const part = relationships.get(relationshipId);
                const entry = part ? entries.get(part) : null;
                if (!entry) { sections.push(`--- sheet ${name} ---\n(sheet part missing)`); continue; }
                const { text, truncated, hiddenColumns } = worksheetRows(zipEntryContent(buf, entry).toString('utf8'), strings, formats);
                const figures = sheetFigures(buf, entries, part);
                sections.push(`--- sheet ${name} ---\n${text || '(empty sheet)'}`
                    + `${truncated ? `\n... [sheet truncated at ${SHEET_MAX_ROWS} rows]` : ''}`
                    + `${hiddenColumns.length ? `\n[hidden columns: ${hiddenColumns.join(', ')}]` : ''}`
                    + `${figures.length ? `\n${figures.join('\n')}` : ''}`);
            }
            if (!sections.length) return 'Error: workbook declares no sheets';
            return capOutput(sections.join('\n\n'), maxOutputBytes);
        }
        // .pptx: one section per slide, in slide-number order.
        const slides = [...entries.keys()]
            .map((name) => { const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name); return m ? { name, n: Number(m[1]) } : null; })
            .filter(Boolean)
            .sort((a, b) => a.n - b.n);
        if (slides.length === 0) return 'Error: no ppt/slides/*.xml parts — not a PPTX presentation (or an encrypted one)';
        const sections = slides.map(({ name, n }) => {
            const xml = zipEntryContent(buf, entries.get(name)).toString('utf8');
            const text = ooxmlPartText(markHiddenSlideShapes(xml), { textTag: 'a:t', paraTag: 'a:p' });
            const notes = slideNotesText(buf, entries, name);
            // A hidden slide is not shown when the deck is presented; reading it
            // as an ordinary page puts a withdrawn page in the summary.
            const hidden = /<p:sld\b[^>]*\bshow="0"/.test(xml) ? ' (hidden)' : '';
            return `--- slide ${n}${hidden} ---\n${text || '(no text)'}${notes ? `\n[notes] ${notes.replace(/\n/g, '\n        ')}` : ''}`;
        });
        return capOutput(sections.join('\n\n'), maxOutputBytes);
    } catch (err) {
        return `Error: office extraction failed — ${err instanceof Error ? err.message : String(err)}`;
    }
}