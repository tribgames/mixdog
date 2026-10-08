// OOXML (.docx / .pptx / .xlsx) text extraction, shared by the read tool and
// provider lowering. Office
// files are ZIP containers holding XML parts; this module implements the
// minimal ZIP central-directory reader (stored + deflate entries via
// node:zlib) and a tag-level pass over the document, slide, and sheet XML.
// No external dependencies.
import { readFile, stat } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

// Longest run of attributes inside one tag that a pattern will cross. Bounded
// so a tag with no closing bracket cannot make a pattern rescan the part.
const ATTR_BOUND = 4096;
const ATTRS = `[^<>]{0,${ATTR_BOUND}}`;
const A = ATTRS;
// A regex built from a raw template; the interpolations are pattern text.
const re = (flags = '') => (strings, ...values) => new RegExp(String.raw(strings, ...values), flags);
// The patterns the per-cell / per-run loops use are built once.
const V_RE = re()`<v(?:\s${A})?>([^<]*)</v>`;
const T_RUN_RE = re('g')`<t(?:\s${A})?>([^<]*)</t>`;
const HIDDEN_RUN_RE = re()`<w:vanish\b(?!${A}\bw:val="(?:false|0)")`;
const HIDDEN_SHAPE_RE = re()`<p:cNvPr\b${A}\bhidden="(?:1|true)"`;
const HIDDEN_SLIDE_RE = re()`<p:sld\b${A}\bshow="0"`;
const BODY_PLACEHOLDER_RE = re()`<p:ph\b${A}\btype="body"`;
const GRAPHIC_FRAME_OPEN_RE = re()`^<p:graphicFrame\b${A}>`;

// Whole-container read cap. Office decks with embedded media can be large;
// the XML parts we extract are a tiny fraction, but the container must be
// read to locate them. Beyond this the caller gets a clear refusal.
const OFFICE_MAX_BYTES = 50 * 1024 * 1024;

const EOCD_SIG = 0x06054b50; // end of central directory
const CDIR_SIG = 0x02014b50; // central directory file header
const LOCAL_SIG = 0x04034b50; // local file header

// Parse the ZIP central directory. Returns Map<name, {method, start, end}>
// where start/end bound the compressed data inside `buf`.
function zipCentralDirectory(buf, limits = {}) {
  // EOCD is at most 22 + 65535 (comment) bytes from the end.
  const scanFrom = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP container (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  const budget = { remaining: Math.min(CONTAINER_MAX_INFLATED_BYTES, limits.maxContainerBytes || Infinity) };
  const maxPartBytes = Math.min(PART_MAX_INFLATED_BYTES, limits.maxPartBytes || Infinity);
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
      entries.set(name, { name, method, start, end: start + compressedSize, budget, maxPartBytes });
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// A crafted container can inflate a few KB into gigabytes. Every entry is
// capped on its own, and all entries of one container share a total budget.
const PART_MAX_INFLATED_BYTES = 32 * 1024 * 1024;
const CONTAINER_MAX_INFLATED_BYTES = 128 * 1024 * 1024;

function zipEntryContent(buf, entry) {
  const raw = buf.subarray(entry.start, entry.end);
  if (entry.method === 0) {
    // stored
    if (raw.length > entry.maxPartBytes) {
      throw new Error(`zip entry ${entry.name} is too large when decompressed (limit ${entry.maxPartBytes} bytes)`);
    }
    return raw;
  }
  if (entry.method !== 8) throw new Error(`unsupported ZIP compression method ${entry.method}`);
  const limit = Math.min(entry.maxPartBytes, entry.budget.remaining);
  let out;
  try {
    out = inflateRawSync(raw, { maxOutputLength: Math.max(1, limit) });
  } catch (err) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`zip entry ${entry.name} is too large when decompressed (limit ${limit} bytes)`);
    }
    throw err;
  }
  entry.budget.remaining -= out.length;
  return out;
}

// Every pattern below is linear in the size of the part, whatever the input.
// A crafted part (unclosed tags, a tag with no `>`) must not make the engine
// rescan the rest of the part from every start position:
//  - attribute runs are bounded (ATTR_BOUND) and never cross a tag boundary;
//  - text runs are `[^<]*` (markup never appears inside character data);
//  - container elements are paired by scanElements, which finds each close tag
//    with indexOf from the open tag's end and gives up on a name for good once
//    its close tag is absent from the rest of the part.
function* scanElements(xml, name) {
  const open = new RegExp(`<${name}\\b(${ATTRS}?)(/?)>`, 'g');
  const close = `</${name}>`;
  let closeAbsent = false;
  for (let m = open.exec(xml); m; m = open.exec(xml)) {
    const innerStart = m.index + m[0].length;
    if (m[2]) {
      yield { index: m.index, attrs: m[1], inner: null, full: m[0], end: innerStart };
      continue;
    }
    if (closeAbsent) continue;
    const at = xml.indexOf(close, innerStart);
    if (at < 0) {
      closeAbsent = true;
      continue;
    }
    const end = at + close.length;
    open.lastIndex = end;
    yield { index: m.index, attrs: m[1], inner: xml.slice(innerStart, at), full: xml.slice(m.index, end), end };
  }
}

function firstElement(xml, name) {
  return scanElements(xml, name).next().value || null;
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

// Collapses line breaks (and their surrounding blanks) into single spaces.
// Every run of whitespace that contains a line break becomes one space. A scan,
// not `/\s*\n+\s*/`: a long blank run without a newline would make that regex
// quadratic.
function collapseNewlineRuns(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const blank = /\s/.test(text[i]);
    let j = i + 1;
    let newline = text[i] === '\n';
    while (j < text.length && /\s/.test(text[j]) === blank) {
      if (text[j] === '\n') newline = true;
      j += 1;
    }
    out += blank && newline ? ' ' : text.slice(i, j);
    i = j;
  }
  return out;
}

const flattenLines = (text) => collapseNewlineRuns(text).trim();

// A figure is content the page shows, but it carries no text runs: read as
// plain text a picture or a chart vanished completely, so a figure-led report
// looked like prose with a gap. The marker says what sits there, and repeats
// the description the file gives a reader who cannot see it.
function drawingMarker(xml) {
  let kind = 'image';
  if (/<c:chart\b|\bchart"|<cx:chart\b/.test(xml)) kind = 'chart';
  else if (/<dgm:relIds\b|diagramData/.test(xml)) kind = 'diagram';
  const descr = decodeXmlEntities(
    re()`<(?:wp|pic|p|xdr):(?:docPr|cNvPr)\b${A}\bdescr="([^"]+)"`.exec(xml)?.[1] || ''
  ).trim();
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
  for (const found of scanElements(xml, 'w:r')) {
    if (found.inner === null) continue;
    const properties = firstElement(found.inner, 'w:rPr')?.full || '';
    const hidden = HIDDEN_RUN_RE.test(properties) && /<w:t[\s>]/.test(found.full);
    const gap = xml.slice(cursor, found.index);
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
    out += found.full;
    cursor = found.end;
  }
  return `${out}${open ? CLOSE : ''}${xml.slice(cursor)}`;
}

// PowerPoint's selection pane hides a shape: it stays in the file and the slide
// does not show it — a superseded draft, a production note. Read as ordinary
// slide text it is quoted back as what the page says.
function markHiddenSlideShapes(xml) {
  const hiddenShape = HIDDEN_SHAPE_RE;
  if (!hiddenShape.test(xml)) return xml;
  // Shapes are paired like scanElements does: a name whose close tag is absent
  // from the rest of the part is given up for good.
  const absent = new Set();
  const shapeOpen = re('g')`<p:(sp|pic|graphicFrame)\b${A}>`;
  let rewritten = '';
  let cursor = 0;
  for (let m = shapeOpen.exec(xml); m; m = shapeOpen.exec(xml)) {
    if (absent.has(m[1])) continue;
    const closeTag = `</p:${m[1]}>`;
    const at = xml.indexOf(closeTag, m.index + m[0].length);
    if (at < 0) {
      absent.add(m[1]);
      continue;
    }
    const end = at + closeTag.length;
    shapeOpen.lastIndex = end;
    rewritten += xml.slice(cursor, m.index) + hideShape(xml.slice(m.index, end), hiddenShape);
    cursor = end;
  }
  return rewritten + xml.slice(cursor);
}

function hideShape(block, hiddenShape) {
  if (!hiddenShape.test(block)) return block;
  const inside = flattenLines(ooxmlPartText(block, { textTag: 'a:t', paraTag: 'a:p' }));
  const label = (inside || drawingMarker(block).replace(/^\[|\]$/g, '')).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<a:p><a:r><a:t>[hidden: ${label}]</a:t></a:r></a:p>`;
}

// Drops the tabs/newlines a table cell or row boundary replaces. A loop, not a
// `[\t\n]+$` regex: a long tab run in the middle of the text would make that
// quadratic.
function trimTrailingBreaks(text) {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '\t' || text[end - 1] === '\n')) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}

// Sequential pass over one XML part: text runs (<w:t>/<a:t>) are captured in
// document order; paragraph closes and explicit breaks become newlines, tabs
// become tabs. A table keeps its shape — cells are separated by tabs and rows
// by newlines — because one value per line loses which column it belongs to.
// Everything else is markup and drops out.
function ooxmlPartText(xml, { textTag, paraTag, notes = null }) {
  const pattern = new RegExp(
    `<${textTag}(?:\\s${ATTRS})?>([^<]*)</${textTag}>` + // 1: text run
      `|</${paraTag}>` + // paragraph end
      '|</(?:w|a):tc>' + // table cell end
      '|</(?:w|a):tr>' + // table row end
      `|<w:tab\\b${ATTRS}/>` +
      `|<(?:w|a):br\\b${ATTRS}/>` +
      `|<w:(?:foot|end)noteReference\\b${ATTRS}/>` + // a citation marker
      `|<(w:drawing|p:pic|p:graphicFrame)\\b${ATTRS}>`, // 2: a figure, frame or picture
    'g'
  );
  let out = '';
  // A figure already ends its own line, so the paragraph that holds it must
  // not add a second one and leave a blank line in the middle of the prose.
  let afterFigure = false;
  const absentCloses = new Set();
  for (let found = pattern.exec(xml); found; found = pattern.exec(xml)) {
    let token = found[0];
    if (found[2]) {
      // Pair the container with its close tag; one whose close tag is absent
      // from the rest of the part is plain markup.
      if (absentCloses.has(found[2])) continue;
      const closeTag = `</${found[2]}>`;
      const at = xml.indexOf(closeTag, found.index + token.length);
      if (at < 0) {
        absentCloses.add(found[2]);
        continue;
      }
      token = xml.slice(found.index, at + closeTag.length);
      pattern.lastIndex = at + closeTag.length;
    }
    if (found[1] !== undefined) {
      out += decodeXmlEntities(found[1]);
      afterFigure = false;
    } else if (token.startsWith('<w:drawing') || token.startsWith('<p:pic')) {
      if (out && !out.endsWith('\n')) out += '\n';
      out += drawingMarker(token);
      // A Word text box lives inside the drawing; its words stay readable.
      const inside = [...scanElements(token, 'w:txbxContent')]
        .filter((box) => box.inner !== null)
        .map((box) => ooxmlPartText(box.inner, { textTag, paraTag }))
        .filter(Boolean)
        .join(' ');
      if (inside) out += ` ${collapseNewlineRuns(inside)}`;
      out += '\n';
      afterFigure = true;
    } else if (token.startsWith('<w:footnoteReference') || token.startsWith('<w:endnoteReference')) {
      // The citation is where the sentence puts it; the note's own words
      // are collected under the body so the source survives the read.
      if (notes) {
        notes.push({
          kind: token.startsWith('<w:endnoteReference') ? 'endnote' : 'footnote',
          id: /\bw:id="(-?\d+)"/.exec(token)?.[1] || '',
        });
        out += `[note ${notes.length}]`;
        afterFigure = false;
      }
    } else if (token.startsWith('<p:graphicFrame')) {
      // The frame holds a table, a chart, or a diagram. A table is words
      // the reader needs; the other two carry none, so they are named.
      const inner = token.replace(GRAPHIC_FRAME_OPEN_RE, '').replace(/<\/p:graphicFrame>$/, '');
      if (/<a:tbl\b/.test(inner)) {
        const rows = ooxmlPartText(inner, { textTag, paraTag });
        if (rows) {
          if (out && !out.endsWith('\n')) out += '\n';
          out += `${rows}\n`;
        }
        afterFigure = Boolean(rows);
      } else {
        if (out && !out.endsWith('\n')) out += '\n';
        out += `${drawingMarker(token)}\n`;
        afterFigure = true;
      }
    } else if (token.endsWith(':tc>')) {
      out = `${trimTrailingBreaks(out)}\t`;
      afterFigure = false;
    } else if (token.endsWith(':tr>')) {
      out = `${trimTrailingBreaks(out)}\n`;
      afterFigure = false;
    } else if (token.includes('tab')) {
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
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  // Excel's last column is XFD (16384); a larger reference is a malformed one.
  return Math.min(16384, Math.max(1, index));
}

// Relationship entries of a .rels part, attribute order independent.
function relationshipList(xml) {
  return [...xml.matchAll(re('g')`<Relationship\b(${A}?)/?>`)]
    .map(([, attributes]) => ({
      id: /\bId="([^"<>]+)"/.exec(attributes)?.[1],
      target: /\bTarget="([^"<>]+)"/.exec(attributes)?.[1],
    }))
    .filter((relationship) => relationship.target !== undefined);
}

function sharedStringTable(xml) {
  if (!xml) return [];
  return [...scanElements(xml, 'si')]
    .filter((item) => item.inner !== null)
    .map((item) => textRuns(item.inner));
}

// Concatenated <t> character data of one fragment.
function textRuns(fragment) {
  return [...fragment.matchAll(T_RUN_RE)]
    .map(([, text]) => decodeXmlEntities(text))
    .join('');
}

// Excel stores a date as a day count and a percentage as a fraction, so a
// reader that prints the stored value answers "46311" for a deadline of
// 2026-10-15 and "0.928" for 92.8%. The cell's own number format says which,
// and these two are the ones that change the meaning of the value.
const BUILTIN_NUMBER_FORMATS = new Map([
  [9, '0%'],
  [10, '0.00%'],
  [14, 'm/d/yyyy'],
  [15, 'd-mmm-yy'],
  [16, 'd-mmm'],
  [17, 'mmm-yy'],
  [18, 'h:mm AM/PM'],
  [19, 'h:mm:ss AM/PM'],
  [20, 'h:mm'],
  [21, 'h:mm:ss'],
  [22, 'm/d/yyyy h:mm'],
  [45, 'mm:ss'],
  [46, '[h]:mm:ss'],
  [47, 'mm:ss.0'],
]);

function cellNumberFormats(xml) {
  if (!xml) return [];
  const custom = new Map(
    [...xml.matchAll(re('g')`<numFmt\b(${A}?)/?>`)]
      .map(([, attributes]) => [/\bnumFmtId="(\d+)"/.exec(attributes)?.[1], /\bformatCode="([^"<>]*)"/.exec(attributes)?.[1]])
      .filter(([id, code]) => id !== undefined && code !== undefined)
      .map(([id, code]) => [Number(id), decodeXmlEntities(code)])
  );
  const cellXfs = firstElement(xml, 'cellXfs')?.inner || '';
  return [...cellXfs.matchAll(re('g')`<xf\b(${A}?)/?>`)].map(([, attributes]) => {
    const id = Number(/\bnumFmtId="(\d+)"/.exec(attributes)?.[1] || 0);
    return custom.get(id) || BUILTIN_NUMBER_FORMATS.get(id) || '';
  });
}

function displayedNumber(raw, format) {
  const number = Number(raw);
  if (!Number.isFinite(number) || !format) return raw;
  // Literals and escaped characters are text, not format tokens.
  const code = String(format)
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '');
  const date = /[yd]/i.test(code);
  const time = /[hs]/i.test(code);
  if (date || time) {
    const stamp = new Date(Math.round((number - 25569) * 86400000));
    if (Number.isNaN(stamp.getTime())) return raw;
    const pad = (value) => String(value).padStart(2, '0');
    const day = `${stamp.getUTCFullYear()}-${pad(stamp.getUTCMonth() + 1)}-${pad(stamp.getUTCDate())}`;
    const clock =
      `${pad(stamp.getUTCHours())}:${pad(stamp.getUTCMinutes())}` +
      (/s/i.test(code) ? `:${pad(stamp.getUTCSeconds())}` : '');
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
  const declarations = firstElement(xml, 'cols')?.inner || '';
  const hidden = [];
  for (const [, attributes] of declarations.matchAll(re('g')`<col\b(${A}?)/?>`)) {
    if (!/\bhidden="(?:1|true)"/.test(attributes)) continue;
    const first = Number(/\bmin="(\d+)"/.exec(attributes)?.[1] || 0);
    const last = Number(/\bmax="(\d+)"/.exec(attributes)?.[1] || first);
    if (!first) continue;
    for (let index = first; index <= last && index - first < 64; index += 1) hidden.push(index);
  }
  return hidden;
}

function trimTrailingTabs(text) {
  let end = text.length;
  while (end > 0 && text[end - 1] === '\t') end -= 1;
  return text.slice(0, end);
}

// `maxContentChars` stops the build once the grid alone is longer than the
// caller can ever show (capOutput cuts the text anyway), so a sheet of far-right
// cells on thousands of rows costs the output cap, not hundreds of megabytes.
// The text built so far is a prefix of the full text, so the cut output is the same.
function worksheetRows(xml, strings, formats = [], maxContentChars = Infinity) {
  const lines = [];
  let truncated = false;
  let chars = 0; // length of lines joined by newlines
  let contentChars = 0; // the same, through the last non-empty line
  for (const row of scanElements(xml, 'row')) {
    const rowAttributes = row.attrs;
    const rowXml = row.inner;
    if (lines.length >= SHEET_MAX_ROWS) {
      truncated = true;
      break;
    }
    const cells = [];
    for (const cell of scanElements(rowXml || '', 'c')) {
      const attributes = cell.attrs;
      const inner = cell.inner || '';
      const type = /\bt="([^"]+)"/.exec(attributes)?.[1] || 'n';
      let text = '';
      if (type === 's') {
        const index = Number(V_RE.exec(inner)?.[1]);
        text = strings[index] ?? '';
      } else if (type === 'inlineStr') {
        text = textRuns(inner);
      } else {
        text = decodeXmlEntities(V_RE.exec(inner)?.[1] || '');
        const style = Number(/\bs="(\d+)"/.exec(attributes)?.[1] ?? NaN);
        if (text && Number.isInteger(style)) text = displayedNumber(text, formats[style] || '');
      }
      const column = columnIndex(/\br="([^"]+)"/.exec(attributes)?.[1] || '');
      while (cells.length < column - 1) cells.push('');
      cells[column - 1] = text;
    }
    const line = trimTrailingTabs(cells.join('\t'));
    const shown = line && /\bhidden="(?:1|true)"/.test(rowAttributes) ? `[hidden] ${line}` : line;
    lines.push(shown);
    chars += (lines.length > 1 ? 1 : 0) + shown.length;
    if (shown) contentChars = chars;
    if (contentChars > maxContentChars) break;
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
  const rels = partText(buf, entries, relsName);
  const target = relationshipList(rels)
    .map(({ target: value }) => String(value))
    .find((value) => /notesSlide\d+\.xml$/.test(value));
  if (!target) return '';
  const xml = partText(buf, entries, `ppt/${target.replace(/^\.\.\//, '')}`);
  return [...scanElements(xml, 'p:sp')]
    .filter((shape) => shape.inner !== null && BODY_PLACEHOLDER_RE.test(shape.full))
    .map((shape) => ooxmlPartText(shape.full, { textTag: 'a:t', paraTag: 'a:p' }))
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
  for (const { attrs: attributes, inner } of scanElements(xml, tag)) {
    if (inner === null) continue;
    // The separator rules Word draws above the note area carry a type and
    // no words; they are not notes.
    if (/\bw:type="/.test(attributes)) continue;
    const id = /\bw:id="(-?\d+)"/.exec(attributes)?.[1] || '';
    bodies.set(id, flattenLines(ooxmlPartText(inner, { textTag: 'w:t', paraTag: 'w:p' })));
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
  const lines = notes.map(
    (note, index) => `[note ${index + 1}] ${bodies[note.kind].get(note.id) || '(note text missing)'}`
  );
  return `\n\n--- notes ---\n${lines.join('\n')}`;
}

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

// A sheet's chart is its message, and it lives outside the cell grid: read as
// rows alone, a dashboard sheet came back empty. Each figure is named after the
// grid, with the chart's own title when it has one.
function sheetFigures(buf, entries, sheetPart) {
  const sheetRels = partText(buf, entries, sheetPart.replace(/([^/]+)$/, '_rels/$1.rels'));
  const drawingTarget = relationshipList(sheetRels)
    .map(({ target: value }) => String(value))
    .find((value) => /drawings\/drawing\d+\.xml$/.test(value));
  if (!drawingTarget) return [];
  const drawingPart = relatedPart(drawingTarget, sheetPart);
  const drawing = partText(buf, entries, drawingPart);
  if (!drawing) return [];
  const drawingRels = partText(buf, entries, drawingPart.replace(/([^/]+)$/, '_rels/$1.rels'));
  const targets = new Map(
    relationshipList(drawingRels)
      .filter((relationship) => relationship.id !== undefined)
      .map(({ id, target }) => [id, relatedPart(target, drawingPart)])
  );
  const figures = [];
  const anchors = ['xdr:absoluteAnchor', 'xdr:twoCellAnchor', 'xdr:oneCellAnchor']
    .flatMap((name) => [...scanElements(drawing, name)])
    .filter((item) => item.inner !== null)
    .sort((a, b) => a.index - b.index);
  for (const { full: anchor } of anchors) {
    const chartId = re()`<c:chart\b${A}?\br:id="([^"<>]+)"`.exec(anchor)?.[1];
    if (chartId) {
      const chartXml = partText(buf, entries, targets.get(chartId));
      const title = flattenLines(
        ooxmlPartText(firstElement(chartXml, 'c:title')?.full || '', { textTag: 'a:t', paraTag: 'a:p' })
      );
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
  let cut = buf.subarray(0, maxOutputBytes).toString('utf8');
  // Drop the replacement characters a split multi-byte sequence leaves (a loop:
  // `/\uFFFD+$/` is quadratic on a long run of them).
  let end = cut.length;
  while (end > 0 && cut[end - 1] === '\uFFFD') end -= 1;
  cut = cut.slice(0, end);
  return `${cut}\n... [office text truncated at ${maxOutputBytes} bytes]`;
}

function docxText(buf, entries, maxOutputBytes) {
  const entry = entries.get('word/document.xml');
  if (!entry) throw new OfficeFormatError('no word/document.xml part — not a DOCX document (or an encrypted one)');
  const notes = [];
  const body = markHiddenWordRuns(zipEntryContent(buf, entry).toString('utf8'));
  const text = ooxmlPartText(body, { textTag: 'w:t', paraTag: 'w:p', notes });
  const cited = documentNotes(buf, entries, notes);
  const chrome = documentChromeText(buf, entries);
  return capOutput(`${text || '(no text content in document)'}${cited}${chrome}`, maxOutputBytes);
}

function workbookText(buf, entries, maxOutputBytes) {
  const workbookEntry = entries.get('xl/workbook.xml');
  if (!workbookEntry) {
    throw new OfficeFormatError('no xl/workbook.xml part — not an Excel workbook (or an encrypted one)');
  }
  const workbook = zipEntryContent(buf, workbookEntry).toString('utf8');
  const relationships = new Map();
  const rels = partText(buf, entries, 'xl/_rels/workbook.xml.rels');
  for (const { id, target } of relationshipList(rels).filter((relationship) => relationship.id !== undefined)) {
    relationships.set(
      id,
      `xl/${String(target)
        .replace(/^\/?xl\//, '')
        .replace(/^\.\//, '')}`
    );
  }
  const strings = sharedStringTable(partText(buf, entries, 'xl/sharedStrings.xml'));
  const formats = cellNumberFormats(partText(buf, entries, 'xl/styles.xml'));
  const sections = [];
  let sectionChars = 0;
  for (const [, attributes] of workbook.matchAll(re('g')`<sheet\b(${A}?)/>`)) {
    // A hidden sheet is content the workbook does not show; reading
    // it as an ordinary sheet presents withheld data as the answer.
    const state = (/\bstate="([^"]*)"/.exec(attributes)?.[1] || '').toLowerCase();
    const label = { hidden: ' (hidden)', veryhidden: ' (very hidden)' }[state] ?? '';
    const name = `${decodeXmlEntities(/\bname="([^"]*)"/.exec(attributes)?.[1] || '')}${label}`;
    const relationshipId = /\br:id="([^"]+)"/.exec(attributes)?.[1] || '';
    const part = relationships.get(relationshipId);
    const entry = part ? entries.get(part) : null;
    if (!entry) {
      sections.push(`--- sheet ${name} ---\n(sheet part missing)`);
      continue;
    }
    const { text, truncated, hiddenColumns } = worksheetRows(
      zipEntryContent(buf, entry).toString('utf8'),
      strings,
      formats,
      maxOutputBytes
    );
    const figures = sheetFigures(buf, entries, part);
    const section =
      `--- sheet ${name} ---\n${text || '(empty sheet)'}` +
      `${truncated ? `\n... [sheet truncated at ${SHEET_MAX_ROWS} rows]` : ''}` +
      `${hiddenColumns.length ? `\n[hidden columns: ${hiddenColumns.join(', ')}]` : ''}` +
      `${figures.length ? `\n${figures.join('\n')}` : ''}`;
    sections.push(section);
    // Sheets past the output cap are cut by capOutput; do not build them.
    sectionChars += section.length + 2;
    if (sectionChars > maxOutputBytes) break;
  }
  if (!sections.length) throw new OfficeFormatError('workbook declares no sheets');
  return capOutput(sections.join('\n\n'), maxOutputBytes);
}

// One section per slide, in slide-number order.
function presentationText(buf, entries, maxOutputBytes) {
  const slides = [...entries.keys()]
    .map((name) => {
      const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
      return m ? { name, n: Number(m[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n);
  if (slides.length === 0) {
    throw new OfficeFormatError('no ppt/slides/*.xml parts — not a PPTX presentation (or an encrypted one)');
  }
  const sections = slides.map(({ name, n }) => {
    const xml = zipEntryContent(buf, entries.get(name)).toString('utf8');
    const text = ooxmlPartText(markHiddenSlideShapes(xml), { textTag: 'a:t', paraTag: 'a:p' });
    const notes = slideNotesText(buf, entries, name);
    // A hidden slide is not shown when the deck is presented; reading it
    // as an ordinary page puts a withdrawn page in the summary.
    const hidden = HIDDEN_SLIDE_RE.test(xml) ? ' (hidden)' : '';
    return `--- slide ${n}${hidden} ---\n${text || '(no text)'}${notes ? `\n[notes] ${notes.replace(/\n/g, '\n        ')}` : ''}`;
  });
  return capOutput(sections.join('\n\n'), maxOutputBytes);
}

/**
 * Extract plain text from a .docx, .pptx, or .xlsx/.xlsm file. Always returns
 * a flat string (batch-safe); failures return an "Error: …" string mirroring
 * extractPdfText.
 */
export async function extractOoxmlText(fullPath, { maxOutputBytes = 100 * 1024 } = {}) {
  try {
    const st = await stat(fullPath);
    if (st.size > OFFICE_MAX_BYTES) {
      return `Error: office file is ${st.size} bytes (max ${OFFICE_MAX_BYTES}); extract the part you need with a shell unzip instead`;
    }
    return extractOoxmlTextFromBuffer(await readFile(fullPath), fullPath, { maxOutputBytes });
  } catch (err) {
    return `Error: office extraction failed — ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Buffer form of extractOoxmlText, shared by the read tool and provider
 * lowering. Synchronous and pure in (buffer, filename extension, limit): the
 * same bytes always yield the same text. The format comes from the filename
 * extension, else from the package's own parts. Failures return "Error: …".
 */
export function extractOoxmlTextFromBuffer(buf, filename = '', { maxOutputBytes = 100 * 1024 } = {}) {
  try {
    return extractOoxmlCore(buf, filename, maxOutputBytes);
  } catch (err) {
    if (err instanceof OfficeFormatError) return `Error: ${err.message}`;
    return `Error: office extraction failed — ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Same extraction, but a file that cannot be read yields null instead of an
 * "Error: …" string, so provider lowering never mistakes a document that
 * happens to start with "Error:" for a failure (or the reverse).
 */
export function tryExtractOoxmlTextFromBuffer(
  buf,
  filename = '',
  { maxOutputBytes = 100 * 1024, maxPartBytes = 0, maxContainerBytes = 0 } = {}
) {
  try {
    return extractOoxmlCore(buf, filename, maxOutputBytes, { maxPartBytes, maxContainerBytes });
  } catch {
    return null;
  }
}

// A structural refusal (as opposed to an unexpected failure).
class OfficeFormatError extends Error {}

function extractOoxmlCore(buf, filename, maxOutputBytes, limits = {}) {
  let ext = String(filename).toLowerCase().slice(-5);
  if (buf.length > OFFICE_MAX_BYTES) {
    throw new OfficeFormatError(
      `office file is ${buf.length} bytes (max ${OFFICE_MAX_BYTES}); extract the part you need with a shell unzip instead`
    );
  }
  // A legacy .doc/.xls/.ppt is an OLE compound file, not a ZIP package —
  // and it often arrives renamed to .docx. "Not a ZIP container" tells the
  // reader nothing it can act on; the format and the way out do.
  if (buf.subarray(0, 8).equals(OLE_COMPOUND_MAGIC)) {
    throw new OfficeFormatError(
      'this is a legacy Office file (.doc/.xls/.ppt), not an Office Open XML package' +
        ' — open it in Word, Excel, or PowerPoint and save a copy as .docx/.xlsx/.pptx, then read that copy'
    );
  }
  const entries = zipCentralDirectory(buf, limits);
  if (!['.docx', '.xlsx', '.xlsm', '.pptx'].includes(ext)) {
    if (entries.has('word/document.xml')) ext = '.docx';
    else if (entries.has('xl/workbook.xml')) ext = '.xlsx';
  }
  if (ext === '.docx') return docxText(buf, entries, maxOutputBytes);
  if (ext === '.xlsx' || ext === '.xlsm') return workbookText(buf, entries, maxOutputBytes);
  return presentationText(buf, entries, maxOutputBytes);
}
