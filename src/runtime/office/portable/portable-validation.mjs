import { dirname, extname, join, posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { measureTextBlock, reviewShapeSpacing, reviewStatLabelProximity, reviewTextBoxFit, reviewTextContrast, reviewVerticalBalance } from './text-metrics.mjs';
import {
  columnLabel,
  columnNumber,
  iterateSheetCells,
  iterateSheetRows,
  parseCellRef,
  workbookSheets,
} from './portable-cells.mjs';
import { imagePixelSize, loadPackage, partRelationshipPath, relationshipMap, relationshipOwner, relationshipTarget, removeContentTypeOverride, zipText } from './portable-opc.mjs';
import { docxTables } from './portable-docx-xml.mjs';
import { inspectPptxTextBoxes } from './portable-pptx.mjs';
import { slidePath } from './portable-pptx-package.mjs';
import { snapshotDocx, snapshotXlsx } from './portable-snapshot.mjs';
import { worksheetSection } from './portable-sheet-xml.mjs';
import { OOXML_REQUIRED, paragraphTexts, xmlAttribute, xmlDecode } from './portable-xml.mjs';

async function inspectXmlParts(zip, entries) {
  const malformedXml = [];
  const xmlEntries = entries.filter((name) => name === '[Content_Types].xml' || /\.(?:xml|rels)$/i.test(name));
  const { JSDOM } = await import('jsdom');
  for (const name of xmlEntries) {
    try {
      const xml = await zipText(zip, name);
      const dom = new JSDOM(xml, { contentType: 'text/xml' });
      dom.window.close();
    } catch (error) {
      malformedXml.push({ part: name, error: error?.message || String(error) });
    }
  }
  return malformedXml;
}


function contentTypeCoverage(entries, xml, format) {
  const defaults = new Map();
  const overrides = new Map();
  for (const match of xml.matchAll(/<Default\b([^>]*?)\/?>/gi)) {
    defaults.set(xmlAttribute(match[1], 'Extension').toLowerCase(), xmlAttribute(match[1], 'ContentType'));
  }
  for (const match of xml.matchAll(/<Override\b([^>]*?)\/?>/gi)) {
    overrides.set(xmlAttribute(match[1], 'PartName').replace(/^\/+/, ''), xmlAttribute(match[1], 'ContentType'));
  }
  const missingContentTypes = entries.filter((name) => {
    if (name === '[Content_Types].xml') return false;
    if (overrides.has(name)) return false;
    const extension = name.toLowerCase().endsWith('.rels')
      ? 'rels'
      : posix.extname(name).slice(1).toLowerCase();
    return !extension || !defaults.has(extension);
  });
  const mainPart = OOXML_REQUIRED[format]?.[1] || '';
  const mainContentType = overrides.get(mainPart) || '';
  return {
    missingContentTypes,
    mainPart,
    mainContentType,
    mainContentTypeMissing: Boolean(mainPart && !mainContentType),
  };
}


async function baselinePackage(zip, original) {
  if (!original) return { compared: false };
  const originalZip = await loadPackage(original);
  const currentEntries = new Set(Object.entries(zip.files).filter(([, entry]) => !entry.dir).map(([name]) => name));
  const originalEntries = Object.entries(originalZip.files).filter(([, entry]) => !entry.dir).map(([name]) => name);
  const protectedPattern = /(?:^|\/)(?:vbaProject\.bin|vbaData\.xml|_xmlsignatures\/|origin\.sigs$|signatures?\.xml$|customUI\/|embeddings\/|externalLinks\/|connections\.xml$|slideMasters\/|slideLayouts\/|theme\/)/i;
  const protectedParts = originalEntries.filter((name) => protectedPattern.test(name));
  const lostProtectedParts = protectedParts.filter((name) => !currentEntries.has(name));
  const hash = async (entry) => createHash('sha256').update(await entry.async('nodebuffer')).digest('hex');
  const changedProtectedParts = [];
  const changedParts = [];
  for (const name of originalEntries) {
    const current = zip.file(name);
    if (!current) continue;
    const [before, after] = await Promise.all([hash(originalZip.file(name)), hash(current)]);
    if (before !== after) {
      changedParts.push(name);
      if (protectedPattern.test(name)) changedProtectedParts.push({ part: name, before, after });
    }
  }
  const signatureParts = originalEntries.filter((name) => /(?:^|\/)(?:_xmlsignatures\/|origin\.sigs$|signatures?\.xml$)/i.test(name));
  return {
    compared: true,
    original,
    originalEntries: originalEntries.length,
    addedParts: [...currentEntries].filter((name) => !originalZip.file(name)),
    lostProtectedParts,
    changedProtectedParts,
    signatureParts,
    digitalSignatureInvalidated: signatureParts.length > 0 && changedParts.length > 0,
  };
}


function rejectedDocxText(xml) {
  let value = String(xml || '');
  value = value.replace(/<w:ins(?:\s[^>]*)?>[\s\S]*?<\/w:ins>/g, '');
  value = value.replace(/<w:del(?:\s[^>]*)?>([\s\S]*?)<\/w:del>/g, (_, body) => (
    body.replaceAll('<w:delText', '<w:t').replaceAll('</w:delText>', '</w:t>')
  ));
  return [...value.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
    .map((paragraph) => paragraphTexts(paragraph[1], 'w:t').join(''))
    .filter((text) => text.length > 0)
    .join('\n');
}


async function validateDocxRedlining(zip, originalPath) {
  if (!originalPath) {
    return {
      requested: true,
      ok: false,
      reason: 'Redlining audit requires an opened source document.',
    };
  }
  try {
    const original = await loadPackage(originalPath);
    const before = rejectedDocxText(await zipText(original, 'word/document.xml'));
    const after = rejectedDocxText(await zipText(zip, 'word/document.xml'));
    return {
      requested: true,
      ok: before === after,
      originalCharacters: before.length,
      rejectedCharacters: after.length,
      reason: before === after ? '' : 'Document text differs from the source after rejecting tracked changes; at least one edit is untracked.',
    };
  } catch (error) {
    return {
      requested: true,
      ok: false,
      reason: error?.message || String(error),
    };
  }
}


export async function validatePortableOoxml(path, format, options = {}) {
  const zip = await loadPackage(path);
  const entries = Object.entries(zip.files).filter(([, entry]) => !entry.dir).map(([name]) => name);
  const missing = (OOXML_REQUIRED[format] || []).filter((name) => !zip.file(name));
  const unsafeEntries = entries.filter((name) => name.includes('..') || name.startsWith('/') || /^[A-Za-z]:/.test(name));
  const macros = entries.filter((name) => /vbaProject\.bin$/i.test(name));
  const signatures = entries.filter((name) => /(?:^|\/)(?:_xmlsignatures\/|origin\.sigs$|signatures?\.xml$)/i.test(name));
  const externalLinks = entries.filter((name) => /(?:^|\/)externalLinks\//i.test(name));
  const dataConnections = entries.filter((name) => /(?:^|\/)connections\.xml$/i.test(name));
  // A chart's data workbook is native chart evidence, not an activatable
  // object: it is excluded from the embedded-object security finding.
  const chartWorkbooks = new Set();
  for (const relPath of entries.filter((name) => /(?:^|\/)charts\/_rels\/chart[^/]*\.xml\.rels$/i.test(name))) {
    const xml = await zipText(zip, relPath);
    for (const match of xml.matchAll(/<Relationship\b([^>]+?)\/?>/gi)) {
      if (!/\/package$/i.test(xmlAttribute(match[1], 'Type'))) continue;
      const target = xmlAttribute(match[1], 'Target');
      chartWorkbooks.add(posix.normalize(posix.join(posix.dirname(relPath.replace(/_rels\/$|_rels\//, '')), target)));
    }
  }
  const embeddedObjects = entries.filter((name) => /(?:^|\/)embeddings\//i.test(name) && !chartWorkbooks.has(name));
  const malformedXml = await inspectXmlParts(zip, entries);
  const contentTypes = contentTypeCoverage(entries, await zipText(zip, '[Content_Types].xml'), format);
  const missingRelationships = [];
  const duplicateRelationshipIds = [];
  const externalRelationships = [];
  for (const relPath of entries.filter((name) => name.endsWith('.rels'))) {
    const xml = await zipText(zip, relPath);
    const ids = new Set();
    for (const match of xml.matchAll(/<Relationship\b([^>]+?)\/?>/gi)) {
      const id = xmlAttribute(match[1], 'Id');
      const target = xmlAttribute(match[1], 'Target');
      const mode = xmlAttribute(match[1], 'TargetMode');
      if (id && ids.has(id)) duplicateRelationshipIds.push({ relationship: relPath, id });
      if (id) ids.add(id);
      if (mode.toLowerCase() === 'external') {
        externalRelationships.push({ relationship: relPath, id, target: xmlDecode(target) });
        continue;
      }
      const resolved = relationshipTarget(relPath, target);
      if (!resolved || resolved.startsWith('../') || !zip.file(resolved)) {
        missingRelationships.push({ relationship: relPath, id, target: xmlDecode(target), resolved });
      }
    }
  }
  const baseline = await baselinePackage(zip, options.original);
  const redlining = format === 'docx' && options.auditProfile === 'redlining'
    ? await validateDocxRedlining(zip, options.original)
    : null;
  const ok = missing.length === 0
    && unsafeEntries.length === 0
    && malformedXml.length === 0
    && contentTypes.missingContentTypes.length === 0
    && !contentTypes.mainContentTypeMissing
    && missingRelationships.length === 0
    && duplicateRelationshipIds.length === 0
    && !(baseline.lostProtectedParts?.length)
    && !(baseline.changedProtectedParts?.length)
    && baseline.digitalSignatureInvalidated !== true
    && (!redlining || redlining.ok);
  return {
    ok,
    format,
    entries: entries.length,
    missing,
    unsafeEntries,
    macros,
    security: {
      macros,
      signatures,
      externalLinks,
      dataConnections,
      embeddedObjects,
      macroExecution: 'disabled',
      digitalSignatureInvalidated: baseline.digitalSignatureInvalidated === true,
    },
    malformedXml,
    missingRelationships,
    duplicateRelationshipIds,
    externalRelationships,
    ...contentTypes,
    baseline,
    redlining,
    validation: 'opc-relationships-content-types-xml',
  };
}


const BUILTIN_NUMBER_FORMATS = Object.freeze({
  9: '0%',
  10: '0.00%',
  5: '$#,##0_);($#,##0)',
  6: '$#,##0_);[Red]($#,##0)',
  7: '$#,##0.00_);($#,##0.00)',
  8: '$#,##0.00_);[Red]($#,##0.00)',
  37: '#,##0_);(#,##0)',
  38: '#,##0_);[Red](#,##0)',
  39: '#,##0.00_);(#,##0.00)',
  40: '#,##0.00_);[Red](#,##0.00)',
});


async function workbookNumberFormats(zip) {
  const styles = await zipText(zip, 'xl/styles.xml');
  if (!styles) return [];
  const custom = new Map([...styles.matchAll(/<numFmt\b[^>]*\bnumFmtId="(\d+)"[^>]*\bformatCode="([^"]*)"/g)]
    .map((match) => [Number(match[1]), xmlDecode(match[2])]));
  const section = /<cellXfs\b[^>]*>[\s\S]*?<\/cellXfs>/.exec(styles)?.[0] || '';
  return [...section.matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map((match) => {
    const id = Number(/\bnumFmtId="(\d+)"/.exec(match[0])?.[1]) || 0;
    return custom.get(id) || BUILTIN_NUMBER_FORMATS[id] || '';
  });
}


async function percentScaleIssues(zip, sheets) {
  const formats = await workbookNumberFormats(zip);
  if (!formats.length) return [];
  const issues = [];
  for (const sheet of sheets) {
    const xml = await zipText(zip, sheet.path);
    if (!xml) continue;
    for (const cell of iterateSheetCells(xml)) {
      const style = Number(/\bs="(\d+)"/.exec(cell.attributes)?.[1]);
      if (!Number.isInteger(style)) continue;
      const format = formats[style] || '';
      if (!format.includes('%')) continue;
      const raw = /<v>([\s\S]*?)<\/v>/.exec(cell.body)?.[1];
      const value = Number(raw);
      if (!Number.isFinite(value) || Math.abs(value) <= 1.5) continue;
      const reference = cell.ref;
      issues.push({
        severity: 'warning',
        code: 'percent_stored_as_whole',
        path: `/sheet[${sheet.name}]/cell[${reference}]`,
        message: `Percent-formatted cell holds ${value}; Excel renders that as ${(value * 100).toLocaleString('en-US')}%. Store percentages as fractions.`,
        source: 'number-format',
      });
      if (issues.length >= 50) return issues;
    }
  }
  return issues;
}


const DEFAULT_COLUMN_WIDTH = 8.43;


function formattedNumberWidth(value, format) {
  const absolute = Math.abs(value);
  const decimals = (format.match(/\.(0+)/)?.[1] || '').length;
  const grouped = format.includes(',');
  const percent = format.includes('%');
  const scaled = percent ? absolute * 100 : absolute;
  const whole = Math.trunc(scaled);
  let width = String(whole).length;
  if (grouped && whole >= 1000) width += Math.floor((String(whole).length - 1) / 3);
  if (decimals) width += decimals + 1;
  if (percent) width += 1;
  if (/[$€£¥₩]/.test(format)) width += 1;
  if (value < 0) width += 1;
  return width;
}


async function columnFitIssues(zip, sheets) {
  const formats = await workbookNumberFormats(zip);
  const issues = [];
  for (const sheet of sheets) {
    const xml = await zipText(zip, sheet.path);
    if (!xml) continue;
    const widths = new Map();
    const section = worksheetSection(xml, 'cols');
    if (section) {
      for (const match of section[0].matchAll(/<col\b([^>]*)\/>/g)) {
        const min = Number(xmlAttribute(match[1], 'min')) || 0;
        const max = Number(xmlAttribute(match[1], 'max')) || min;
        const width = Number(xmlAttribute(match[1], 'width'));
        if (!Number.isFinite(width) || width <= 0) continue;
        for (let column = min; column >= 1 && column <= max && column - min < 2048; column += 1) {
          widths.set(column, width);
        }
      }
    }
    for (const cell of iterateSheetCells(xml)) {
      const attributes = cell.attributes;
      if (/\bt="(?:s|inlineStr|str|b)"/.test(attributes)) continue;
      const raw = /<v>([\s\S]*?)<\/v>/.exec(cell.body)?.[1];
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      const reference = cell.ref;
      if (!reference) continue;
      const column = columnNumber(parseCellRef(reference).col);
      const width = widths.get(column) ?? DEFAULT_COLUMN_WIDTH;
      const style = Number(/\bs="(\d+)"/.exec(attributes)?.[1]);
      const format = Number.isInteger(style) ? formats[style] || '' : '';
      const needed = formattedNumberWidth(value, format);
      if (needed <= width + 0.5) continue;
      issues.push({
        severity: 'warning',
        code: 'column_too_narrow',
        path: `/sheet[${sheet.name}]/cell[${reference}]`,
        message: `Number needs about ${needed} characters but column ${columnLabel(column)} is ${width.toFixed(1)} wide; Excel shows ###. Run autofit_range.`,
        source: 'number-format',
      });
      if (issues.length >= 50) return issues;
    }
  }
  return issues;
}


async function formulaConsistencyIssues(zip, sheets) {
  const issues = [];
  for (const sheet of sheets) {
    const xml = await zipText(zip, sheet.path);
    if (!xml) continue;
    for (const row of iterateSheetRows(xml)) {
      const cells = [...iterateSheetCells(row.body)].map((cell) => ({
        reference: cell.ref,
        formula: /<f[\s>]/.test(cell.body),
        numeric: !/\bt="(?:s|inlineStr|str|b)"/.test(cell.attributes)
          && Number.isFinite(Number(/<v>([\s\S]*?)<\/v>/.exec(cell.body)?.[1])),
      }));
      if (cells.filter((cell) => cell.formula).length < 3) continue;
      for (const cell of cells) {
        if (cell.formula || !cell.numeric || !cell.reference) continue;
        issues.push({
          severity: 'warning',
          code: 'formula_inconsistency',
          path: `/sheet[${sheet.name}]/cell[${cell.reference}]`,
          message: 'A hardcoded value interrupts a row of formulas; a lone edited cell mid-row is a common silent error.',
          source: 'formula-audit',
        });
        if (issues.length >= 50) return issues;
      }
    }
  }
  return issues;
}


const PLACEHOLDER_RULES = Object.freeze([
  { code: 'placeholder_text', label: 'lorem ipsum filler', pattern: /\b(?:lorem|ipsum)\b/i },
  { code: 'placeholder_text', label: 'repeated X placeholder', pattern: /\bx{3,}\b/i },
  { code: 'placeholder_text', label: 'TODO marker', pattern: /\bTODO\b/ },
  { code: 'placeholder_text', label: 'insert marker', pattern: /\[\s*insert\b/i },
  { code: 'placeholder_text', label: 'layout instruction', pattern: /this[^.]{0,40}\b(?:page|slide)\b[^.]{0,40}layout/i },
  { code: 'placeholder_text', label: 'click-to-edit prompt', pattern: /click to (?:edit|add)/i },
  { code: 'placeholder_text', label: 'Korean input prompt', pattern: /(?:여기에|내용을|제목을)\s*입력/ },
  { code: 'unfilled_token', label: 'unresolved template token', pattern: /\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/ },
]);


async function placeholderIssues(zip, format) {
  const parts = format === 'pptx'
    ? Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort()
    : format === 'docx'
      ? ['word/document.xml']
      : [];
  if (!parts.length) return [];
  const tag = format === 'pptx' ? 'a:t' : 'w:t';
  const issues = [];
  for (const part of parts) {
    const xml = await zipText(zip, part);
    if (!xml) continue;
    const text = paragraphTexts(xml, tag).join(' ');
    if (!text.trim()) continue;
    const slide = Number(/slide(\d+)\.xml$/.exec(part)?.[1]) || 0;
    for (const rule of PLACEHOLDER_RULES) {
      const found = rule.pattern.exec(text);
      if (!found) continue;
      issues.push({
        severity: 'warning',
        code: rule.code,
        path: slide ? `/slide[${slide}]` : '/body',
        message: `Leftover ${rule.label}: "${found[0].slice(0, 60)}"`,
        source: 'placeholder-scan',
      });
    }
  }
  return issues;
}


const EMU_PER_POINT = 12700;
const DEFAULT_CELL_INSETS = Object.freeze({ left: 91440, right: 91440, top: 45720, bottom: 45720 });

async function tableCellOverflowIssues(zip) {
  const parts = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort();
  const issues = [];
  for (const part of parts) {
    const xml = await zipText(zip, part);
    if (!xml) continue;
    const slide = Number(/slide(\d+)\.xml$/.exec(part)?.[1]) || 0;
    let tableOrdinal = 0;
    for (const table of xml.matchAll(/<a:tbl>[\s\S]*?<\/a:tbl>/g)) {
      tableOrdinal += 1;
      const widths = [...table[0].matchAll(/<a:gridCol\b[^>]*\bw="(\d+)"/g)].map((match) => Number(match[1]));
      if (!widths.length) continue;
      let rowOrdinal = 0;
      for (const row of table[0].matchAll(/<a:tr\b[^>]*>[\s\S]*?<\/a:tr>/g)) {
        rowOrdinal += 1;
        const declared = Number(/<a:tr\b[^>]*\bh="(\d+)"/.exec(row[0])?.[1]) || 0;
        if (!declared) continue;
        let columnOrdinal = 0;
        for (const cell of row[0].matchAll(/<a:tc(?:\s[^>]*)?>[\s\S]*?<\/a:tc>/g)) {
          columnOrdinal += 1;
          const width = widths[columnOrdinal - 1];
          if (!width) continue;
          const body = /<a:txBody>[\s\S]*?<\/a:txBody>/.exec(cell[0])?.[0] || '';
          const text = paragraphTexts(body, 'a:t').join(' ').trim();
          if (!text) continue;
          const size = Number(/<a:rPr\b[^>]*\bsz="(\d+)"/.exec(body)?.[1] || 0) / 100 || 18;
          const bold = /<a:rPr\b[^>]*\bb="1"/.test(body);
          const usable = (width - DEFAULT_CELL_INSETS.left - DEFAULT_CELL_INSETS.right) / EMU_PER_POINT;
          const available = (declared - DEFAULT_CELL_INSETS.top - DEFAULT_CELL_INSETS.bottom) / EMU_PER_POINT;
          if (usable <= 0 || available <= 0) continue;
          const measured = measureTextBlock([{ text, fontSize: size, bold }], { width: usable });
          if (measured.height <= available * 1.08) continue;
          issues.push({
            severity: 'warning',
            code: 'table_cell_overflow',
            path: `/slide[${slide}]/table[${tableOrdinal}]/row[${rowOrdinal}]/cell[${columnOrdinal}]`,
            message: `Cell text needs about ${Math.round(measured.height)}pt across ${measured.lines} line(s)`
              + ` but the row offers ${Math.round(available)}pt; shorten the text or widen the column.`,
            source: 'text-metrics',
          });
          if (issues.length >= 20) return issues;
        }
      }
    }
  }
  return issues;
}


async function imageDistortionIssues(zip, format) {
  const parts = format === 'pptx'
    ? Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort()
    : format === 'docx'
      ? ['word/document.xml']
      : [];
  if (!parts.length) return [];
  const issues = [];
  for (const part of parts) {
    const xml = await zipText(zip, part);
    if (!xml) continue;
    const relationships = relationshipMap(await zipText(zip, partRelationshipPath(part)));
    const slide = Number(/slide(\d+)\.xml$/.exec(part)?.[1]) || 0;
    const pictures = format === 'pptx'
      ? [...xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)]
      : [...xml.matchAll(/<w:drawing>[\s\S]*?<\/w:drawing>/g)];
    let ordinal = 0;
    for (const picture of pictures) {
      ordinal += 1;
      const embed = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(picture[0])?.[1];
      const extent = format === 'pptx'
        ? /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(picture[0])
        : /<wp:extent\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(picture[0]);
      if (!embed || !extent) continue;
      const target = relationships.get(embed);
      if (!target) continue;
      const media = posix.normalize(posix.join(posix.dirname(part), target));
      const file = zip.file(media);
      if (!file) continue;
      const source = imagePixelSize(await file.async('nodebuffer'));
      if (!source?.width || !source?.height) continue;
      const placed = Number(extent[1]) / Number(extent[2]);
      const original = source.width / source.height;
      const sourceRect = format === 'pptx'
        ? /<a:srcRect\b([^>]*)\/?>/.exec(picture[0])?.[1]
        : '';
      const visibleWidth = sourceRect
        ? 1 - ((Number(xmlAttribute(sourceRect, 'l')) || 0) + (Number(xmlAttribute(sourceRect, 'r')) || 0)) / 100000
        : 1;
      const visibleHeight = sourceRect
        ? 1 - ((Number(xmlAttribute(sourceRect, 't')) || 0) + (Number(xmlAttribute(sourceRect, 'b')) || 0)) / 100000
        : 1;
      const visibleAspect = original * visibleWidth / visibleHeight;
      if (!Number.isFinite(placed) || !Number.isFinite(visibleAspect) || visibleAspect <= 0) continue;
      const drift = Math.abs(placed - visibleAspect) / visibleAspect;
      if (drift <= 0.1) continue;
      issues.push({
        severity: 'warning',
        code: 'image_aspect_distorted',
        path: slide ? `/slide[${slide}]/picture[${ordinal}]` : `/body/picture[${ordinal}]`,
        message: `Image is stretched ${Math.round(drift * 100)}% off its visible ${source.width}x${source.height} aspect ratio;`
          + ' set only width or height to keep the original proportions.',
        source: 'image-audit',
      });
      if (issues.length >= 20) return issues;
    }
  }
  return issues;
}


const CLEANABLE_PARTS = /^(?:ppt|xl|word)\/(?:media|embeddings|charts|drawings|diagrams|ink|notesSlides)\//i;


async function referencedParts(zip) {
  const referenced = new Set();
  for (const relationships of Object.keys(zip.files).filter((name) => name.endsWith('.rels'))) {
    const owner = relationshipOwner(relationships);
    const xml = await zipText(zip, relationships);
    if (!xml) continue;
    for (const match of xml.matchAll(/<Relationship\b[^>]*?\/?>/g)) {
      if (/\bTargetMode="External"/i.test(match[0])) continue;
      const target = xmlDecode(xmlAttribute(match[0], 'Target'));
      if (!target) continue;
      referenced.add(target.startsWith('/')
        ? target.slice(1)
        : posix.normalize(posix.join(posix.dirname(owner || ''), target)));
    }
  }
  return referenced;
}


export async function removeOrphanPackageParts(zip) {
  const removed = [];
  if (!Object.keys(zip.files).some((name) => name.endsWith('.rels'))) {
    return { removed, skipped: 'no-relationship-parts' };
  }
  for (let pass = 0; pass < 8; pass += 1) {
    const referenced = await referencedParts(zip);
    if (!referenced.size) {
      throw new Error('Refusing to clean the package: no relationship resolves to a part');
    }
    const orphans = Object.keys(zip.files).filter((name) => (
      !zip.files[name].dir
      && CLEANABLE_PARTS.test(name)
      && !name.includes('/_rels/')
      && !referenced.has(name)
    ));
    if (!orphans.length) break;
    for (const orphan of orphans) {
      zip.remove(orphan);
      removed.push(orphan);
      const relationships = partRelationshipPath(orphan);
      if (zip.file(relationships)) {
        zip.remove(relationships);
        removed.push(relationships);
      }
      await removeContentTypeOverride(zip, `/${orphan}`);
    }
  }
  return { removed };
}


export async function issuesPortableOoxml(path, format, options = {}) {
  const zip = await loadPackage(path);
  const issues = [];
  const validation = await validatePortableOoxml(path, format);
  for (const missing of validation.missing) {
    issues.push({ severity: 'error', code: 'missing_part', path: `/${missing}`, message: `Required package part is missing: ${missing}` });
  }
  for (const unsafe of validation.unsafeEntries) {
    issues.push({ severity: 'error', code: 'unsafe_zip_entry', path: `/${unsafe}`, message: `Unsafe ZIP entry path: ${unsafe}` });
  }
  for (const malformed of validation.malformedXml) {
    issues.push({ severity: 'error', code: 'malformed_xml', path: `/${malformed.part}`, message: malformed.error });
  }
  for (const relationship of validation.missingRelationships) {
    issues.push({ severity: 'error', code: 'missing_relationship_target', path: `/${relationship.relationship}`, message: `Relationship ${relationship.id || '(unnamed)'} targets missing part ${relationship.resolved || relationship.target}` });
  }
  for (const relationship of validation.duplicateRelationshipIds) {
    issues.push({ severity: 'error', code: 'duplicate_relationship_id', path: `/${relationship.relationship}`, message: `Relationship id is duplicated: ${relationship.id}` });
  }
  for (const part of validation.missingContentTypes) {
    issues.push({ severity: 'error', code: 'missing_content_type', path: `/${part}`, message: 'Package part has no matching content type declaration.' });
  }
  if (validation.mainContentTypeMissing) {
    issues.push({ severity: 'error', code: 'missing_main_content_type', path: `/${validation.mainPart}`, message: 'The main Office document part needs an explicit content type override.' });
  }
  for (const finding of await placeholderIssues(zip, format)) issues.push(finding);
  for (const finding of await imageDistortionIssues(zip, format)) issues.push(finding);
  if (format === 'xlsx') {
    const workbookSheetList = await workbookSheets(zip);
    for (const finding of await percentScaleIssues(zip, workbookSheetList)) issues.push(finding);
    for (const finding of await columnFitIssues(zip, workbookSheetList)) issues.push(finding);
    for (const finding of await formulaConsistencyIssues(zip, workbookSheetList)) issues.push(finding);
  }
  if (format === 'pptx') {
    const inspected = await inspectPptxTextBoxes(zip);
    for (const fit of reviewTextBoxFit(inspected.boxes, {
      slideWidth: inspected.slideWidth,
      slideHeight: inspected.slideHeight,
    })) {
      issues.push({ severity: 'warning', source: 'text-metrics', ...fit });
    }
    for (const contrast of reviewTextContrast(inspected.boxes)) {
      issues.push({ severity: 'warning', source: 'text-metrics', ...contrast });
    }
    for (const spacing of reviewShapeSpacing(inspected.boxes)) {
      issues.push({ severity: 'info', source: 'text-metrics', ...spacing });
    }
    for (const balance of reviewVerticalBalance(inspected.content, {
      slideWidth: inspected.slideWidth,
      slideHeight: inspected.slideHeight,
      boxes: inspected.boxes,
    })) {
      issues.push({ severity: 'warning', source: 'text-metrics', ...balance });
    }
    for (const detached of reviewStatLabelProximity(inspected.boxes)) {
      issues.push({ severity: 'warning', source: 'text-metrics', ...detached });
    }
    for (const overflow of await tableCellOverflowIssues(zip)) issues.push(overflow);
  }
  for (const part of validation.baseline.lostProtectedParts || []) {
    issues.push({ severity: 'error', code: 'lost_protected_part', path: `/${part}`, message: 'A macro, master, layout, or theme part from the source package was removed.' });
  }
  for (const part of validation.baseline.changedProtectedParts || []) {
    issues.push({ severity: 'error', code: 'changed_protected_part', path: `/${part.part}`, message: 'A macro, signature, embedded object, external link, connection, master, layout, or theme part changed unexpectedly.' });
  }
  if (validation.security?.digitalSignatureInvalidated) {
    issues.push({ severity: 'error', code: 'digital_signature_invalidated', path: '/', message: 'The source package was digitally signed and document changes invalidate that signature.' });
  }
  for (const macro of validation.macros) {
    issues.push({ severity: 'warning', code: 'macro_present', path: `/${macro}`, message: 'VBA macro payload is present and is never executed by the portable backend.' });
  }
  for (const connection of validation.security?.dataConnections || []) {
    issues.push({ severity: 'warning', code: 'data_connection_present', path: `/${connection}`, message: 'Workbook data connection is preserved but never refreshed automatically.' });
  }
  for (const embedded of validation.security?.embeddedObjects || []) {
    issues.push({ severity: 'warning', code: 'embedded_object_present', path: `/${embedded}`, message: 'Embedded object is preserved but never activated by Mixdog.' });
  }
  for (const relationship of validation.externalRelationships) {
    issues.push({ severity: 'warning', code: 'external_relationship', path: `/${relationship.relationship}`, message: `External relationship: ${relationship.target}` });
  }
  if (format === 'docx') {
    const snapshot = await snapshotDocx(zip);
    if (snapshot.revisionCount) issues.push({ severity: 'info', code: 'unresolved_revisions', path: '/body', message: `${snapshot.revisionCount} tracked revision element(s) remain unresolved.` });
    if (snapshot.commentCount) issues.push({ severity: 'info', code: 'unresolved_comments', path: '/body', message: `${snapshot.commentCount} comment(s) remain in the document.` });
    const document = await zipText(zip, 'word/document.xml');
    const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(document)?.[1] || '';
    const printable = body
      .replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, '')
      .replace(/<w:sectPr\b[^>]*\/>/g, '');
    if (!/<w:t[\s>]/.test(printable) && !/<w:tbl>/.test(printable) && !/<w:drawing>/.test(printable)) {
      issues.push({
        severity: 'error',
        code: 'empty_document',
        path: '/body',
        message: 'The document body carries no text, table, or image; the requested content never reached the file.',
      });
    }
    const section = /<w:sectPr\b[\s\S]*?<\/w:sectPr>/.exec(document)?.[0] || '';
    const page = /<w:pgSz\b[^>]*\bw:w="(\d+)"/.exec(section);
    const margins = /<w:pgMar\b[^>]*\bw:left="(\d+)"[^>]*\bw:right="(\d+)"/.exec(section)
      || /<w:pgMar\b[^>]*\bw:right="(\d+)"[^>]*\bw:left="(\d+)"/.exec(section);
    const usable = (page ? Number(page[1]) : 12240)
      - (margins ? Number(margins[1]) + Number(margins[2]) : 2880);
    let ordinal = 0;
    for (const table of docxTables(document)) {
      ordinal += 1;
      const grid = /<w:tblGrid(?:\s[^>]*)?>[\s\S]*?<\/w:tblGrid>/.exec(table[0])?.[0] || '';
      const columns = [...grid.matchAll(/<w:gridCol\b[^>]*\bw:w="(\d+)"/g)].map((match) => Number(match[1]));
      if (!columns.length) continue;
      const width = columns.reduce((total, column) => total + column, 0);
      if (width <= usable * 1.02) continue;
      issues.push({
        severity: 'warning',
        code: 'table_wider_than_page',
        path: `/body/table[${ordinal}]`,
        message: `Table spans ${(width / 1440).toFixed(2)}in across a ${(usable / 1440).toFixed(2)}in text column; run fit_table to rebalance.`,
      });
    }
  } else if (format === 'xlsx') {
    const selective = Boolean(options.sheet || options.range);
    const snapshot = await snapshotXlsx(zip, selective ? {
      paged: true,
      sheet: options.sheet,
      range: options.range,
      offset: 0,
      limit: Number.MAX_SAFE_INTEGER,
    } : {});
    const errorPattern = /^(?:#REF!|#DIV\/0!|#VALUE!|#NAME\?|#N\/A|#NUM!|#NULL!)$/i;
    for (const sheet of snapshot.sheets) {
      for (const cell of sheet.cells) {
        if (cell.formula && cell.cacheState === 'missing') {
          issues.push({ severity: 'warning', code: 'formula_cache_missing', path: cell.path, message: 'Formula has no cached value; the workbook is marked for full recalculation on open.' });
        }
        if (errorPattern.test(String(cell.value || ''))) {
          issues.push({ severity: 'error', code: 'formula_error', path: cell.path, message: `Cell contains formula error ${cell.value}` });
        }
      }
    }
    if (options.auditProfile === 'financial-model') {
      if (!snapshot.sheets.some((sheet) => sheet.name.toLowerCase() === 'checks')) {
        issues.push({ severity: 'warning', code: 'missing_checks_sheet', path: '/', message: 'Financial-model audit expects a Checks sheet with explicit tie-out formulas.' });
      }
      for (const sheet of snapshot.sheets) {
        const formulaRows = new Set(sheet.cells.filter((cell) => cell.formula).map((cell) => parseCellRef(cell.ref).row));
        for (const cell of sheet.cells) {
          if (!cell.formula && formulaRows.has(parseCellRef(cell.ref).row) && /^-?\d+(?:\.\d+)?$/.test(String(cell.value || ''))) {
            issues.push({ severity: 'warning', code: 'rogue_hardcode', path: cell.path, message: 'Numeric hardcode appears inside a row that otherwise contains formulas.' });
          }
        }
      }
    }
  } else if (format === 'pptx') {
    const requestedPages = new Set((options.pages || []).map(Number));
    const slidePaths = Object.keys(zip.files).filter((name) => {
      if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) return false;
      if (!requestedPages.size) return true;
      return requestedPages.has(Number(/slide(\d+)\.xml$/.exec(name)?.[1]));
    });
    for (const slidePath of slidePaths) {
      const xml = await zipText(zip, slidePath);
      const slide = Number(/slide(\d+)\.xml$/.exec(slidePath)?.[1]);
      let picture = 0;
      for (const match of xml.matchAll(/<p:pic(?:\s[^>]*)?>[\s\S]*?<\/p:pic>/g)) {
        picture += 1;
        const descr = /\bdescr="([^"]*)"/.exec(match[0])?.[1] || '';
        if (!descr) issues.push({ severity: 'warning', code: 'missing_alt_text', path: `/slide[${slide}]/picture[${picture}]`, message: 'Picture has no alternative text.' });
      }
    }
  }
  return { ok: !issues.some((issue) => issue.severity === 'error'), format, issueCount: issues.length, issues };
}
