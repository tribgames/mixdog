import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  contrastRatio,
  measureTextBlock,
  reviewCjkTracking,
  reviewShapeSpacing,
  reviewStatLabelProximity,
  reviewTextBoxFit,
  reviewTextContrast,
  reviewVerticalBalance,
} from './text-metrics.mjs';
import { resolveSlideBackground } from './portable-pptx-core.mjs';
import { workbookSheets } from './portable-cells.mjs';
import {
  imagePixelSize,
  loadPackage,
  partRelationshipPath,
  relationshipMap,
  relationshipOwner,
  relationshipTarget,
  removeContentTypeOverride,
  zipText,
} from './portable-opc.mjs';
import { chartFaultIssues } from './portable-chart-faults.mjs';
import { reviewDeadVectorChart, reviewTextFragmentation } from './review-editability.mjs';
import { docxTables } from './portable-docx-xml.mjs';
import { auditDocxRedliningStories, lintDocxRevisions } from './docx-revisions.mjs';
import { inspectPptxTextBoxes } from './portable-pptx.mjs';
import { FULL_READ_CELL_LIMIT, snapshotDocx, snapshotPptx, snapshotXlsx } from './portable-snapshot.mjs';
import { reviewOfficeStructure } from '../quality/assurance-structure.mjs';
import { auditXlsxFormulas } from './xlsx-formula-audit.mjs';
import {
  cellInkIssues,
  columnFitIssues,
  formulaConsistencyIssues,
  protectedInputIssues,
} from './portable-sheet-audits.mjs';
import {
  OOXML_REQUIRED,
  TEMPLATE_TOKEN_SOURCE,
  paragraphTexts,
  topLevelElements,
  xmlAttribute,
  xmlDecode,
} from './portable-xml.mjs';

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
    const extension = name.toLowerCase().endsWith('.rels') ? 'rels' : posix.extname(name).slice(1).toLowerCase();
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

/** The chart data workbooks a package's chart relationships point at (native chart evidence, not activatable objects). */
async function chartWorkbooksOf(zip, entries) {
  const workbooks = new Set();
  for (const relPath of entries.filter((name) => /(?:^|\/)charts\/_rels\/chart[^/]*\.xml\.rels$/i.test(name))) {
    const xml = await zipText(zip, relPath);
    for (const match of xml.matchAll(/<Relationship\b([^>]+?)\/?>/gi)) {
      if (!/\/package$/i.test(xmlAttribute(match[1], 'Type'))) continue;
      const target = xmlAttribute(match[1], 'Target');
      workbooks.add(posix.normalize(posix.join(posix.dirname(relPath.replace(/_rels\/$|_rels\//, '')), target)));
    }
  }
  return workbooks;
}

// The parts a rewrite must carry through untouched. When the Office application itself saved the file (the
// background backend), masters, layouts and themes are normalised by that save and a chart's data workbook may be
// renumbered (Microsoft_Excel_Worksheet2.xlsx → Microsoft_Excel_Worksheet.xlsx): those are the application's own
// serialisation, not damage, and are reported as normalised instead. Macros, signatures, ribbon customisation,
// external links, connections and embedded objects stay protected under every backend.
const PROTECTED_ALWAYS =
  /(?:^|\/)(?:vbaProject\.bin|vbaData\.xml|_xmlsignatures\/|origin\.sigs$|signatures?\.xml$|customUI\/|embeddings\/|externalLinks\/|connections\.xml$)/i;
const PROTECTED_UNLESS_APPLICATION_SAVED = /(?:^|\/)(?:slideMasters\/|slideLayouts\/|theme\/)/i;
const APPLICATION_BACKENDS = new Set(['microsoft-office-com']);

async function baselinePackage(zip, original, { savedBy = '', chartWorkbooks = new Set() } = {}) {
  if (!original) return { compared: false };
  const originalZip = await loadPackage(original);
  const applicationSaved = APPLICATION_BACKENDS.has(savedBy);
  const currentEntries = new Set(
    Object.entries(zip.files)
      .filter(([, entry]) => !entry.dir)
      .map(([name]) => name)
  );
  const originalEntries = Object.entries(originalZip.files)
    .filter(([, entry]) => !entry.dir)
    .map(([name]) => name);
  const originalChartWorkbooks = applicationSaved ? await chartWorkbooksOf(originalZip, originalEntries) : new Set();
  // A chart workbook the application renumbered is not lost while the saved package still carries one per chart.
  const renumberedWorkbook = (name) =>
    applicationSaved && originalChartWorkbooks.has(name) && chartWorkbooks.size >= originalChartWorkbooks.size;
  const isProtected = (name) =>
    PROTECTED_ALWAYS.test(name) || (!applicationSaved && PROTECTED_UNLESS_APPLICATION_SAVED.test(name));
  const protectedParts = originalEntries.filter((name) => isProtected(name) && !renumberedWorkbook(name));
  const lostProtectedParts = protectedParts.filter((name) => !currentEntries.has(name));
  const hash = async (entry) =>
    createHash('sha256')
      .update(await entry.async('nodebuffer'))
      .digest('hex');
  const changedProtectedParts = [];
  const applicationNormalizedParts = [];
  const changedParts = [];
  for (const name of originalEntries) {
    const current = zip.file(name);
    if (!current) {
      if (applicationSaved && (PROTECTED_UNLESS_APPLICATION_SAVED.test(name) || renumberedWorkbook(name)))
        applicationNormalizedParts.push(name);
      continue;
    }
    const [before, after] = await Promise.all([hash(originalZip.file(name)), hash(current)]);
    if (before !== after) {
      changedParts.push(name);
      if (isProtected(name) && !renumberedWorkbook(name)) changedProtectedParts.push({ part: name, before, after });
      else if (applicationSaved && (PROTECTED_UNLESS_APPLICATION_SAVED.test(name) || renumberedWorkbook(name)))
        applicationNormalizedParts.push(name);
    }
  }
  const signatureParts = originalEntries.filter((name) =>
    /(?:^|\/)(?:_xmlsignatures\/|origin\.sigs$|signatures?\.xml$)/i.test(name)
  );
  return {
    compared: true,
    original,
    savedBy,
    applicationSaved,
    originalEntries: originalEntries.length,
    addedParts: [...currentEntries].filter((name) => !originalZip.file(name)),
    lostProtectedParts,
    changedProtectedParts,
    applicationNormalizedParts,
    signatureParts,
    digitalSignatureInvalidated: signatureParts.length > 0 && changedParts.length > 0,
  };
}

const DOCX_STORY_PART = /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i;

/** Every story part by name: the audit compares each one with its source
 *  counterpart, so a header edited untracked is caught like the body. */
async function docxStoryParts(zip) {
  const parts = new Map();
  for (const name of Object.keys(zip.files)
    .filter((entry) => DOCX_STORY_PART.test(entry))
    .sort()) {
    parts.set(name, await zipText(zip, name));
  }
  return parts;
}

async function validateDocxRedlining(zip, originalPath, author = '') {
  if (!originalPath) {
    return {
      requested: true,
      ok: false,
      reason: 'Redlining audit requires an opened source document.',
    };
  }
  try {
    const original = await loadPackage(originalPath);
    return auditDocxRedliningStories(await docxStoryParts(zip), await docxStoryParts(original), { author });
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
  const entries = Object.entries(zip.files)
    .filter(([, entry]) => !entry.dir)
    .map(([name]) => name);
  const missing = (OOXML_REQUIRED[format] || []).filter((name) => !zip.file(name));
  const unsafeEntries = entries.filter(
    (name) => name.includes('..') || name.startsWith('/') || /^[A-Za-z]:/.test(name)
  );
  const macros = entries.filter((name) => /vbaProject\.bin$/i.test(name));
  const signatures = entries.filter((name) =>
    /(?:^|\/)(?:_xmlsignatures\/|origin\.sigs$|signatures?\.xml$)/i.test(name)
  );
  const externalLinks = entries.filter((name) => /(?:^|\/)externalLinks\//i.test(name));
  const dataConnections = entries.filter((name) => /(?:^|\/)connections\.xml$/i.test(name));
  // A chart's data workbook is native chart evidence, not an activatable
  // object: it is excluded from the embedded-object security finding.
  const chartWorkbooks = await chartWorkbooksOf(zip, entries);
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
  const baseline = await baselinePackage(zip, options.original, { savedBy: options.savedBy, chartWorkbooks });
  const documentLint =
    format === 'docx'
      ? lintDocxRevisions(
          await Promise.all(
            entries
              .filter((name) => /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(name))
              .sort()
              .map(async (name) => ({ part: name, xml: await zipText(zip, name) }))
          ),
          await zipText(zip, 'word/comments.xml')
        )
      : [];
  const redlining =
    format === 'docx' && options.auditProfile === 'redlining'
      ? await validateDocxRedlining(zip, options.original, options.author)
      : null;
  const ok =
    missing.length === 0 &&
    !documentLint.some((finding) => finding.severity === 'error') &&
    unsafeEntries.length === 0 &&
    malformedXml.length === 0 &&
    contentTypes.missingContentTypes.length === 0 &&
    !contentTypes.mainContentTypeMissing &&
    missingRelationships.length === 0 &&
    duplicateRelationshipIds.length === 0 &&
    !baseline.lostProtectedParts?.length &&
    !baseline.changedProtectedParts?.length &&
    baseline.digitalSignatureInvalidated !== true &&
    (!redlining || redlining.ok);
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
    documentLint,
    validation: 'opc-relationships-content-types-xml',
  };
}

// The worst readable ratio among a block's runs, with the size and weight that
// decide the minimum. Word keeps sizes in half-points.
function runInkReading(xml, fill) {
  let worst = null;
  for (const run of xml.matchAll(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g)) {
    const text = paragraphTexts(run[0], 'w:t').join('').trim();
    if (!text) continue;
    const properties = /<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/.exec(run[0])?.[0] || '';
    // Hidden text is not on the printed page: measuring its ink reports a
    // defect about a working note no reader sees.
    if (/<w:vanish(?:\s[^>]*)?\/>/.test(properties) || /<w:vanish\b[^>]*\bw:val="(?:1|true|on)"/.test(properties))
      continue;
    const color = /<w:color\b[^>]*\bw:val="([0-9A-Fa-f]{6})"/.exec(properties)?.[1] || '';
    if (!color) continue;
    const size = Number(/<w:sz\b[^>]*\bw:val="(\d+)"/.exec(properties)?.[1] || 0) / 2 || 11;
    const bold = /<w:b(?:\s[^>]*)?\/>/.test(properties);
    const ratio = contrastRatio(color, fill);
    if (ratio == null) continue;
    const minimum = size >= 18 || (size >= 14 && bold) ? 3 : 4.5;
    if (ratio >= minimum) continue;
    if (!worst || ratio < worst.ratio) worst = { ratio, minimum, size };
  }
  return worst;
}

// What a reader who cannot see the picture is actually told. A writer that
// stores the file name — "preencoded.png", "image3.jpg" — has described
// nothing, and counting it as a description let the accessibility rule pass on
// decks whose every picture was unlabelled.
function describesPicture(description) {
  const text = String(description || '').trim();
  if (!text) return false;
  return !/^[\w ().\-\u00C0-\u024F]+\.(?:png|jpe?g|gif|bmp|tiff?|svg|webp|emf|wmf)$/i.test(text);
}

// Ink a reader cannot see, by the rule the deck and the workbook already use:
// a shaded table row that keeps the body's dark colour, or text so pale it
// disappears into the page.
function documentInkIssues(document) {
  const issues = [];
  const shading = (xml, container) => {
    const block = new RegExp(`<${container}\\b[^>]*>[\\s\\S]*?</${container}>`).exec(xml)?.[0] || '';
    const fill = /<w:shd\b[^>]*\bw:fill="([0-9A-Fa-f]{6})"/.exec(block)?.[1] || '';
    return fill && fill.toLowerCase() !== 'ffffff' ? fill : '';
  };
  const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(document)?.[1] || '';
  let paragraphOrdinal = 0;
  let tableOrdinal = 0;
  for (const block of topLevelElements(body, ['w:p', 'w:tbl'])) {
    if (block.name === 'w:p') {
      paragraphOrdinal += 1;
      const worst = runInkReading(block.xml, shading(block.xml, 'w:pPr') || 'FFFFFF');
      if (!worst) continue;
      issues.push({
        severity: 'warning',
        code: 'low_contrast',
        path: `/body/p[${paragraphOrdinal}]`,
        message: `Text contrast is ${worst.ratio.toFixed(2)}:1 against its field; ${worst.minimum}:1 is the readable minimum at ${Math.round(worst.size)}pt.`,
        source: 'text-metrics',
      });
      if (issues.length >= 20) return issues;
      continue;
    }
    tableOrdinal += 1;
    const tableFill = shading(block.xml, 'w:tblPr');
    let rowOrdinal = 0;
    for (const row of block.xml.matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)) {
      rowOrdinal += 1;
      let cellOrdinal = 0;
      for (const cell of row[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)) {
        cellOrdinal += 1;
        const worst = runInkReading(cell[0], shading(cell[0], 'w:tcPr') || tableFill || 'FFFFFF');
        if (!worst) continue;
        issues.push({
          severity: 'warning',
          code: 'low_contrast',
          path: `/body/tbl[${tableOrdinal}]/row[${rowOrdinal}]/cell[${cellOrdinal}]`,
          message: `Cell text contrast is ${worst.ratio.toFixed(2)}:1 against its field; ${worst.minimum}:1 is the readable minimum at ${Math.round(worst.size)}pt.`,
          source: 'text-metrics',
        });
        if (issues.length >= 20) return issues;
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
  {
    code: 'placeholder_text',
    label: 'layout instruction',
    pattern: /this[^.]{0,40}\b(?:page|slide)\b[^.]{0,40}layout/i,
  },
  { code: 'placeholder_text', label: 'click-to-edit prompt', pattern: /click to (?:edit|add)/i },
  { code: 'placeholder_text', label: 'Korean input prompt', pattern: /(?:여기에|내용을|제목을)\s*입력/ },
  // A value that reached the page as an object: no author types this, and it
  // shipped as a slide title while the measured read reported only the overlap
  // the oversized string caused. Bracketed forms only — "undefined" and "NaN"
  // are words a technical document may mean.
  { code: 'placeholder_text', label: 'stringified value', pattern: /\[object [A-Z]\w*\]/ },
  { code: 'unfilled_token', label: 'unresolved template token', pattern: new RegExp(TEMPLATE_TOKEN_SOURCE, 'u') },
]);

async function placeholderIssues(zip, format) {
  const parts =
    format === 'pptx'
      ? Object.keys(zip.files)
          .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
          .sort()
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
  // A row grows to its tallest cell when the text needs more than the declared height, so a table whose rows
  // are declared to fit can still run off the canvas once drawn. The predicted height (each row at the larger of
  // its declared height and its tallest cell) is compared with the room under the frame's top.
  const slideHeight =
    Number(/<p:sldSz\b[^>]*\bcy="(\d+)"/.exec((await zipText(zip, 'ppt/presentation.xml')) || '')?.[1]) || 0;
  for (const part of parts) {
    const xml = await zipText(zip, part);
    if (!xml) continue;
    const slide = Number(/slide(\d+)\.xml$/.exec(part)?.[1]) || 0;
    // A cell with no fill of its own shows whatever the slide shows.
    const slideSurface = await resolveSlideBackground(zip, part, xml);
    let tableOrdinal = 0;
    for (const frame of xml.matchAll(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g)) {
      const table = /<a:tbl>[\s\S]*?<\/a:tbl>/.exec(frame[0]);
      if (!table) continue;
      tableOrdinal += 1;
      const frameTop = Number(/<p:xfrm>[\s\S]*?<a:off\b[^>]*\by="(-?\d+)"/.exec(frame[0])?.[1]) || 0;
      let predicted = 0;
      const widths = [...table[0].matchAll(/<a:gridCol\b[^>]*\bw="(\d+)"/g)].map((match) => Number(match[1]));
      if (!widths.length) continue;
      let rowOrdinal = 0;
      for (const row of table[0].matchAll(/<a:tr\b[^>]*>[\s\S]*?<\/a:tr>/g)) {
        rowOrdinal += 1;
        const declared = Number(/<a:tr\b[^>]*\bh="(\d+)"/.exec(row[0])?.[1]) || 0;
        let tallest = declared;
        let columnOrdinal = 0;
        for (const cell of row[0].matchAll(/<a:tc(?:\s[^>]*)?>[\s\S]*?<\/a:tc>/g)) {
          columnOrdinal += 1;
          const width = widths[columnOrdinal - 1];
          const body = /<a:txBody>[\s\S]*?<\/a:txBody>/.exec(cell[0])?.[0] || '';
          const text = paragraphTexts(body, 'a:t').join(' ').trim();
          if (!text) continue;
          const size = Number(/<a:rPr\b[^>]*\bsz="(\d+)"/.exec(body)?.[1] || 0) / 100 || 18;
          const bold = /<a:rPr\b[^>]*\bb="1"/.test(body);
          const cellPath = `/slide[${slide}]/table[${tableOrdinal}]/row[${rowOrdinal}]/cell[${columnOrdinal}]`;
          // A header row on a dark fill with the body's dark ink is unreadable
          // in exactly the way a shape's text would be; cells are measured the
          // same way, against their own fill or the slide behind them.
          const properties = /<a:tcPr\b[^>]*>[\s\S]*?<\/a:tcPr>/.exec(cell[0])?.[0] || '';
          // The cell's own fill follows its border definitions, and each border
          // carries a colour of its own: read the fill after the lines are out.
          const surface = properties
            .replace(/<a:ln(?:L|R|T|B|TlToBr|BlToTr)\b[^>]*>[\s\S]*?<\/a:ln(?:L|R|T|B|TlToBr|BlToTr)>/g, '')
            .replace(/<a:ln(?:L|R|T|B|TlToBr|BlToTr)\b[^>]*\/>/g, '');
          const fill = /<a:solidFill>\s*<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/.exec(surface)?.[1] || slideSurface;
          const ink = /<a:rPr\b[^>]*>[\s\S]*?<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/.exec(body)?.[1] || '';
          const ratio = fill && ink ? contrastRatio(ink, fill) : null;
          const minimum = size >= 18 || (size >= 14 && bold) ? 3 : 4.5;
          // Twenty cell reports are enough to read; the rows are still measured so the table's height is known.
          if (ratio != null && ratio < minimum && issues.length < 20) {
            issues.push({
              severity: 'warning',
              code: 'low_contrast',
              path: cellPath,
              message: `Cell text contrast is ${ratio.toFixed(2)}:1 against its fill; ${minimum}:1 is the readable minimum at ${Math.round(size)}pt.`,
              source: 'text-metrics',
            });
          }
          if (!declared || !width) continue;
          // A merged label cell (rowSpan) owns the rows it spans: its room is theirs together, not one row's.
          const rowSpan = Math.max(1, Number(/<a:tc\b[^>]*\browSpan="(\d+)"/.exec(cell[0])?.[1]) || 1);
          const gridSpan = Math.max(1, Number(/<a:tc\b[^>]*\bgridSpan="(\d+)"/.exec(cell[0])?.[1]) || 1);
          const spannedWidth =
            widths.slice(columnOrdinal - 1, columnOrdinal - 1 + gridSpan).reduce((sum, value) => sum + value, 0) ||
            width;
          const usable = (spannedWidth - DEFAULT_CELL_INSETS.left - DEFAULT_CELL_INSETS.right) / EMU_PER_POINT;
          const available = (declared * rowSpan - DEFAULT_CELL_INSETS.top - DEFAULT_CELL_INSETS.bottom) / EMU_PER_POINT;
          if (usable <= 0 || available <= 0) continue;
          const measured = measureTextBlock([{ text, fontSize: size, bold }], { width: usable });
          if (rowSpan === 1)
            tallest = Math.max(
              tallest,
              measured.height * EMU_PER_POINT + DEFAULT_CELL_INSETS.top + DEFAULT_CELL_INSETS.bottom
            );
          if (measured.height <= available * 1.08 || issues.length >= 20) continue;
          issues.push({
            severity: 'warning',
            code: 'table_cell_overflow',
            path: cellPath,
            message:
              `Cell text needs about ${Math.round(measured.height)}pt across ${measured.lines} line(s)` +
              ` but the row offers ${Math.round(available)}pt; shorten the text or widen the column.`,
            source: 'text-metrics',
          });
        }
        predicted += tallest;
      }
      // The lower safe margin is 0.4 in (a source line or page number may sit there; a table may not).
      const room = slideHeight - 0.4 * 914400 - frameTop;
      if (slideHeight && frameTop >= 0 && predicted > room) {
        issues.push({
          severity: 'warning',
          code: 'table_exceeds_canvas',
          path: `/slide[${slide}]/table[${tableOrdinal}]`,
          message: `The table's rows draw to about ${Math.round(predicted / EMU_PER_POINT)}pt tall but only ${Math.round(room / EMU_PER_POINT)}pt remain under its top; the rows that wrap or the count push it past the canvas — fewer rows, wider columns, or a smaller pitch.`,
          source: 'text-metrics',
        });
      }
    }
  }
  return issues;
}

// A picture is only as sharp as the pixels it carries: a 1920-wide projection
// of a 13.3in canvas asks for about 144 of them per inch, and half of that is
// where a seat in the room sees the softness. A rule or gradient stretched from
// a few pixels is not a photograph and is left alone, and a raster that is only
// the fallback behind a vector is not what the page draws.
const IMAGE_MIN_PPI = 72;
const IMAGE_TARGET_PPI = 150;
const IMAGE_SPACER_PX = 8;
const EMU_PER_INCH = EMU_PER_POINT * 72;

// A picture that draws nothing leaves a hole the page still makes room for: the
// circle behind it, the caption under it, and the column beside it all read as
// an icon that failed to arrive. Only a fully transparent raster is read this
// way — a flat colour is a band someone meant to draw — and such a file is never
// large, so only a small one is decoded.
const BLANK_IMAGE_MAX_BYTES = 256 * 1024;

async function drawsNothing(data) {
  if (!data?.length || data.length > BLANK_IMAGE_MAX_BYTES) return false;
  try {
    const { channels } = await sharp(data).stats();
    return channels.length === 4 && channels[3].max === 0;
  } catch {
    // A raster the decoder cannot read is a separate fault; it is not blank.
    return false;
  }
}

async function imagePlacementIssues(zip, format) {
  const parts =
    format === 'pptx'
      ? Object.keys(zip.files)
          .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
          .sort()
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
    const pictures =
      format === 'pptx'
        ? [...xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)]
        : [...xml.matchAll(/<w:drawing>[\s\S]*?<\/w:drawing>/g)];
    let ordinal = 0;
    for (const picture of pictures) {
      ordinal += 1;
      const embed = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(picture[0])?.[1];
      const extent =
        format === 'pptx'
          ? /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(picture[0])
          : /<wp:extent\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(picture[0]);
      if (!embed || !extent) continue;
      const target = relationships.get(embed);
      if (!target) continue;
      const media = posix.normalize(posix.join(posix.dirname(part), target));
      const file = zip.file(media);
      if (!file) continue;
      const bytes = await file.async('nodebuffer');
      const source = imagePixelSize(bytes);
      if (!source?.width || !source?.height) continue;
      const placed = Number(extent[1]) / Number(extent[2]);
      const original = source.width / source.height;
      const sourceRect = format === 'pptx' ? /<a:srcRect\b([^>]*)\/?>/.exec(picture[0])?.[1] : '';
      const visibleWidth = sourceRect
        ? 1 - ((Number(xmlAttribute(sourceRect, 'l')) || 0) + (Number(xmlAttribute(sourceRect, 'r')) || 0)) / 100000
        : 1;
      const visibleHeight = sourceRect
        ? 1 - ((Number(xmlAttribute(sourceRect, 't')) || 0) + (Number(xmlAttribute(sourceRect, 'b')) || 0)) / 100000
        : 1;
      const path = slide ? `/slide[${slide}]/picture[${ordinal}]` : `/body/picture[${ordinal}]`;
      if (await drawsNothing(bytes)) {
        issues.push({
          severity: 'error',
          code: 'blank_image',
          path,
          message:
            'Picture draws nothing: every pixel of the raster is transparent, so the page keeps the frame and its caption while the reader sees an empty box.',
          source: 'image-audit',
        });
        if (issues.length >= 20) return issues;
        continue;
      }
      const inchesWide = Number(extent[1]) / EMU_PER_INCH;
      const inchesTall = Number(extent[2]) / EMU_PER_INCH;
      const drawnAt = Math.min(
        (source.width * visibleWidth) / Math.max(inchesWide, 0.01),
        (source.height * visibleHeight) / Math.max(inchesTall, 0.01)
      );
      if (
        !/svgBlip/.test(picture[0]) &&
        source.width >= IMAGE_SPACER_PX &&
        source.height >= IMAGE_SPACER_PX &&
        drawnAt < IMAGE_MIN_PPI
      ) {
        issues.push({
          severity: 'warning',
          code: 'image_low_resolution',
          path,
          message:
            `Image carries ${source.width}x${source.height} px for a ${inchesWide.toFixed(1)}x${inchesTall.toFixed(1)} in frame` +
            ` (${Math.round(drawnAt)} px per inch); it is enlarged past its own detail and draws soft.` +
            ` Supply about ${Math.round(inchesWide * IMAGE_TARGET_PPI)}x${Math.round(inchesTall * IMAGE_TARGET_PPI)} px, or place it smaller.`,
          source: 'image-audit',
        });
        if (issues.length >= 20) return issues;
      }
      const visibleAspect = (original * visibleWidth) / visibleHeight;
      if (!Number.isFinite(placed) || !Number.isFinite(visibleAspect) || visibleAspect <= 0) continue;
      const drift = Math.abs(placed - visibleAspect) / visibleAspect;
      if (drift <= 0.1) continue;
      issues.push({
        severity: 'warning',
        code: 'image_aspect_distorted',
        path,
        message:
          `Image is stretched ${Math.round(drift * 100)}% off its visible ${source.width}x${source.height} aspect ratio;` +
          ' set only width or height to keep the original proportions.',
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
      referenced.add(
        target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(posix.dirname(owner || ''), target))
      );
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
    const orphans = Object.keys(zip.files).filter(
      (name) => !zip.files[name].dir && CLEANABLE_PARTS.test(name) && !name.includes('/_rels/') && !referenced.has(name)
    );
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

/** What the package itself is missing or contradicts, read from a validation result. */
function packageStructureIssues(validation) {
  const issues = [];
  for (const missing of validation.missing) {
    issues.push({
      severity: 'error',
      code: 'missing_part',
      path: `/${missing}`,
      message: `Required package part is missing: ${missing}`,
    });
  }
  for (const unsafe of validation.unsafeEntries) {
    issues.push({
      severity: 'error',
      code: 'unsafe_zip_entry',
      path: `/${unsafe}`,
      message: `Unsafe ZIP entry path: ${unsafe}`,
    });
  }
  for (const malformed of validation.malformedXml) {
    issues.push({ severity: 'error', code: 'malformed_xml', path: `/${malformed.part}`, message: malformed.error });
  }
  for (const relationship of validation.missingRelationships) {
    issues.push({
      severity: 'error',
      code: 'missing_relationship_target',
      path: `/${relationship.relationship}`,
      message: `Relationship ${relationship.id || '(unnamed)'} targets missing part ${relationship.resolved || relationship.target}`,
    });
  }
  for (const relationship of validation.duplicateRelationshipIds) {
    issues.push({
      severity: 'error',
      code: 'duplicate_relationship_id',
      path: `/${relationship.relationship}`,
      message: `Relationship id is duplicated: ${relationship.id}`,
    });
  }
  for (const part of validation.missingContentTypes) {
    issues.push({
      severity: 'error',
      code: 'missing_content_type',
      path: `/${part}`,
      message: 'Package part has no matching content type declaration.',
    });
  }
  if (validation.mainContentTypeMissing) {
    issues.push({
      severity: 'error',
      code: 'missing_main_content_type',
      path: `/${validation.mainPart}`,
      message: 'The main Office document part needs an explicit content type override.',
    });
  }
  return issues;
}

/** What the source package carried and this copy must answer for: protected parts,
 *  signatures, macros, connections, embedded objects, external links. */
function packageProvenanceIssues(validation) {
  const issues = [];
  for (const part of validation.baseline.lostProtectedParts || []) {
    issues.push({
      severity: 'error',
      code: 'lost_protected_part',
      path: `/${part}`,
      message: 'A macro, master, layout, or theme part from the source package was removed.',
    });
  }
  for (const part of validation.baseline.changedProtectedParts || []) {
    issues.push({
      severity: 'error',
      code: 'changed_protected_part',
      path: `/${part.part}`,
      message:
        'A macro, signature, embedded object, external link, connection, master, layout, or theme part changed unexpectedly.',
    });
  }
  if (validation.security?.digitalSignatureInvalidated) {
    issues.push({
      severity: 'error',
      code: 'digital_signature_invalidated',
      path: '/',
      message: 'The source package was digitally signed and document changes invalidate that signature.',
    });
  }
  for (const macro of validation.macros) {
    issues.push({
      severity: 'warning',
      code: 'macro_present',
      path: `/${macro}`,
      message: 'VBA macro payload is present and is never executed by the portable backend.',
    });
  }
  for (const connection of validation.security?.dataConnections || []) {
    issues.push({
      severity: 'warning',
      code: 'data_connection_present',
      path: `/${connection}`,
      message: 'Workbook data connection is preserved but never refreshed automatically.',
    });
  }
  for (const embedded of validation.security?.embeddedObjects || []) {
    issues.push({
      severity: 'warning',
      code: 'embedded_object_present',
      path: `/${embedded}`,
      message: 'Embedded object is preserved but never activated by Mixdog.',
    });
  }
  for (const relationship of validation.externalRelationships) {
    issues.push({
      severity: 'warning',
      code: 'external_relationship',
      path: `/${relationship.relationship}`,
      message: `External relationship: ${relationship.target}`,
    });
  }
  return issues;
}

/** The workbook audits that read the sheet parts rather than a snapshot. */
async function sheetAuditIssues(zip) {
  const sheets = await workbookSheets(zip);
  return [
    // A percentage stored as a whole number is the shared formula audit's
    // finding (`percentage_stored_as_whole`, on both backends): read here too it
    // put one defect in the list twice.
    ...(await columnFitIssues(zip, sheets)),
    ...(await protectedInputIssues(zip, sheets)),
    ...(await cellInkIssues(zip, sheets)),
    ...(await formulaConsistencyIssues(zip, sheets)),
  ];
}

/** What the slides measure: fit, contrast, tracking, spacing, balance, structure, charts. */
async function presentationMetricIssues(zip) {
  const issues = [];
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
  for (const tracking of reviewCjkTracking(inspected.boxes)) {
    issues.push({ severity: 'warning', source: 'text-metrics', ...tracking });
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
  // The measured read that rides on author and batch sees the same geometry
  // the design review sees: an element a few points off an axis its
  // neighbours share, a margin breach, a collision. A defect is cheapest to
  // answer in the turn that wrote it, not one call later. Contrast stays with
  // the metrics pass above, which measures it against the resolved surface.
  for (const finding of reviewOfficeStructure({ format: 'pptx', document: await snapshotPptx(zip) })) {
    if (finding.code === 'low_contrast') continue;
    issues.push(finding);
  }
  for (const overflow of await tableCellOverflowIssues(zip)) issues.push(overflow);
  for (const fault of await chartFaultIssues(zip)) issues.push(fault);
  for (const fragment of reviewTextFragmentation(inspected.boxes)) {
    issues.push({ severity: 'warning', source: 'editability', ...fragment });
  }
  for (const dead of reviewDeadVectorChart(inspected.content, inspected.boxes)) {
    issues.push({ severity: 'warning', source: 'editability', ...dead });
  }
  return issues;
}

// A table this long crosses a page break under any ordinary page setup, and the
// continuation page carries columns with nothing naming them unless the header
// row is marked to repeat. Only a row that reads as a header — set in bold or
// shaded — is owed the mark; a table whose first row is data is not.
const DOCX_LONG_TABLE_ROWS = 25;

/** What the Word document says about itself: revisions, comments, lint, emptiness,
 *  tables wider than the text column or losing their header after a page break,
 *  ink, and pictures without a description. */
async function documentContentIssues(zip, validation) {
  const issues = [];
  const snapshot = await snapshotDocx(zip);
  if (snapshot.revisionCount || snapshot.propertyChangeCount) {
    issues.push({
      severity: 'info',
      code: 'unresolved_revisions',
      path: '/body',
      message: `${snapshot.revisionCount} tracked revision element(s)${snapshot.propertyChangeCount ? ` and ${snapshot.propertyChangeCount} formatting change record(s)` : ''} remain unresolved.`,
    });
  }
  // A resolved thread is settled and its replies belong to it: counting them
  // as outstanding tells a reviewer to answer comments Word already closed.
  const openThreads = (snapshot.comments || []).filter((comment) => !comment.replyTo && !comment.resolved);
  if (openThreads.length) {
    issues.push({
      severity: 'info',
      code: 'unresolved_comments',
      path: openThreads[0].path || '/body',
      message: `${openThreads.length} comment thread(s) remain unresolved.`,
    });
  }
  for (const finding of validation.documentLint || []) {
    issues.push({
      severity: finding.severity,
      code: finding.code,
      path: finding.part && finding.part !== 'word/document.xml' ? `/${finding.part}` : '/body',
      message: finding.message,
      source: 'document-lint',
    });
  }
  const document = await zipText(zip, 'word/document.xml');
  const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(document)?.[1] || '';
  const printable = body.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, '').replace(/<w:sectPr\b[^>]*\/>/g, '');
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
  const margins =
    /<w:pgMar\b[^>]*\bw:left="(\d+)"[^>]*\bw:right="(\d+)"/.exec(section) ||
    /<w:pgMar\b[^>]*\bw:right="(\d+)"[^>]*\bw:left="(\d+)"/.exec(section);
  const usable = (page ? Number(page[1]) : 12240) - (margins ? Number(margins[1]) + Number(margins[2]) : 2880);
  let ordinal = 0;
  for (const table of docxTables(document)) {
    ordinal += 1;
    const rowCount = [...table[0].matchAll(/<w:tr[\s>]/g)].length;
    const firstRow = /<w:tr[\s>][\s\S]*?<\/w:tr>/.exec(table[0])?.[0] || '';
    if (
      rowCount >= DOCX_LONG_TABLE_ROWS &&
      /<w:b\b[^>]*\/>|<w:shd\b/.test(firstRow) &&
      !/<w:tblHeader\b/.test(firstRow)
    ) {
      issues.push({
        severity: 'warning',
        code: 'table_header_not_repeated',
        path: `/body/table[${ordinal}]`,
        message: `Table runs ${rowCount} rows and its header row does not repeat, so every page after the break shows columns with nothing naming them; add_table properties.repeatHeader carries the first row onto each continuation page.`,
      });
    }
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
  for (const finding of documentInkIssues(document)) issues.push(finding);
  // A slide's picture is audited for a description; a Word report delivered
  // without one leaves the same reader with nothing. The snapshot's own
  // picture list is the reading, so the finding points at the element the
  // caller can look up — a header logo included.
  for (const picture of snapshot.images || []) {
    if (describesPicture(picture.altText)) continue;
    issues.push({
      severity: 'warning',
      code: 'missing_alt_text',
      path: picture.path,
      message: 'Picture has no alternative text; add_image takes altText.',
    });
  }
  return issues;
}

/** What the workbook's values say: formula errors, uncached formulas, how far the
 *  audit read, the profile's required sheets, pictures without a description. */
async function workbookContentIssues(zip, options) {
  const issues = [];
  const selective = Boolean(options.sheet || options.range);
  const snapshot = await snapshotXlsx(
    zip,
    selective
      ? {
          paged: true,
          sheet: options.sheet,
          range: options.range,
          offset: 0,
          limit: Number.MAX_SAFE_INTEGER,
        }
      : { full: true }
  );
  const errorPattern = /^(?:#REF!|#DIV\/0!|#VALUE!|#NAME\?|#N\/A|#NUM!|#NULL!)$/i;
  for (const sheet of snapshot.sheets) {
    // Past the audit's own ceiling the answer says how far it read, so a
    // clean report is never mistaken for a sheet that was read to the end.
    if (sheet.truncated) {
      issues.push({
        // How far the audit read is a fact about this call, not a defect in
        // the document: it is reported, never handed to a fix round.
        severity: 'info',
        code: 'audit_scope_limited',
        path: sheet.path,
        message: `Only the first ${sheet.cells.length} of ${sheet.cellCount} populated cells on this sheet were audited; audit the rest with issues sheet:'${sheet.name}' range:'…' in ranges of at most ${FULL_READ_CELL_LIMIT} cells.`,
      });
    }
    // One uncached formula and a thousand are the same fact about the sheet:
    // it has not been recalculated. Reported per cell, a model fills the
    // issue budget with that one fact and hides every other finding.
    const uncached = [];
    for (const cell of sheet.cells) {
      if (cell.formula && cell.cacheState === 'missing') uncached.push(cell);
      if (errorPattern.test(String(cell.value || ''))) {
        issues.push({
          severity: 'error',
          code: 'formula_error',
          path: cell.path,
          message: `Cell contains formula error ${cell.value}`,
        });
      }
    }
    if (uncached.length) {
      const shown = uncached
        .slice(0, 3)
        .map((cell) => cell.ref)
        .join(', ');
      issues.push({
        severity: 'warning',
        code: 'formula_cache_missing',
        path: uncached.length === 1 ? uncached[0].path : `/sheet[${sheet.name}]`,
        message: `${uncached.length} formula${uncached.length === 1 ? ' on this sheet has' : 's on this sheet have'} no cached value (${shown}${uncached.length > 3 ? ', …' : ''}); the workbook is marked for full recalculation on open.`,
        ...(uncached.length > 1
          ? { cells: uncached.slice(0, 20).map((cell) => cell.ref), cellCount: uncached.length }
          : {}),
      });
    }
  }
  // Sheet names come from the workbook, not the (possibly selective)
  // snapshot, so a cross-sheet reference to an unselected sheet still audits.
  const sheetNames = (await workbookSheets(zip)).map((sheet) => sheet.name);
  if (options.auditProfile === 'financial-model' && !sheetNames.some((name) => name.toLowerCase() === 'checks')) {
    issues.push({
      severity: 'warning',
      code: 'missing_checks_sheet',
      path: '/',
      message: 'Financial-model audit expects a Checks sheet with explicit tie-out formulas.',
    });
  }
  for (const sheet of snapshot.sheets) {
    for (const image of sheet.images || []) {
      if (describesPicture(image.altText)) continue;
      issues.push({
        severity: 'warning',
        code: 'missing_alt_text',
        path: image.path,
        message: 'Picture has no alternative text; add_image takes altText.',
      });
    }
  }
  issues.push(...auditXlsxFormulas(snapshot.sheets, { auditProfile: options.auditProfile, sheetNames }));
  return issues;
}

/** Slide pictures delivered without a description, on the requested pages. */
async function slidePictureIssues(zip, options) {
  const issues = [];
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
      if (describesPicture(descr)) continue;
      issues.push({
        severity: 'warning',
        code: 'missing_alt_text',
        path: `/slide[${slide}]/picture[${picture}]`,
        message: 'Picture has no alternative text; add_image takes altText.',
      });
    }
  }
  return issues;
}

// The order the findings arrive in is the order a reader meets them: what the
// package is, what the format measures, what the source package is owed, then
// what the content itself says.
export async function issuesPortableOoxml(path, format, options = {}) {
  const zip = await loadPackage(path);
  const validation = await validatePortableOoxml(path, format);
  const issues = packageStructureIssues(validation);
  issues.push(...(await placeholderIssues(zip, format)));
  issues.push(...(await imagePlacementIssues(zip, format)));
  if (format === 'xlsx') issues.push(...(await sheetAuditIssues(zip)));
  if (format === 'pptx') issues.push(...(await presentationMetricIssues(zip)));
  issues.push(...packageProvenanceIssues(validation));
  if (format === 'docx') issues.push(...(await documentContentIssues(zip, validation)));
  else if (format === 'xlsx') issues.push(...(await workbookContentIssues(zip, options)));
  else if (format === 'pptx') issues.push(...(await slidePictureIssues(zip, options)));
  return { ok: !issues.some((issue) => issue.severity === 'error'), format, issueCount: issues.length, issues };
}
