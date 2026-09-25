import { posix } from 'node:path';
import sharp from 'sharp';
import {
  contrastRatio,
  measureTextWidth,
  reviewCjkTracking,
  reviewShapeSpacing,
  reviewStatLabelProximity,
  reviewTextBoxFit,
  reviewTextContrast,
  reviewVerticalBalance,
} from './text-metrics.mjs';
import { resolveSlideBackground } from './portable-pptx-core.mjs';
import { booleanXmlAttribute, sheetFormulaTotals, workbookCalculation, workbookSheets } from './portable-cells.mjs';
import { EMU_PER_POINT } from './portable-slide-shapes.mjs';
import {
  imagePixelSize,
  loadPackage,
  partRelationshipPath,
  relationshipMap,
  relationshipOwner,
  removeContentTypeOverride,
  zipText,
} from './portable-opc.mjs';
import { chartFaultIssues } from './portable-chart-faults.mjs';
import { reviewDeadVectorChart, reviewTextFragmentation } from './review-editability.mjs';
import { docxTables, sectionTextWidth } from './portable-docx-xml.mjs';
import { inspectPptxTextBoxes } from './portable-pptx.mjs';
import { FULL_READ_CELL_LIMIT, snapshotDocx, snapshotPptx, snapshotXlsx } from './portable-snapshot.mjs';
import { reviewOfficeStructure } from '../quality/assurance-structure.mjs';
import { auditXlsxFormulas, isChecksSheetName } from './xlsx-formula-audit.mjs';
import {
  cellInkIssues,
  columnFitIssues,
  formulaConsistencyIssues,
  protectedInputIssues,
} from './portable-sheet-audits.mjs';
import { paragraphTexts, topLevelElements, xmlAttribute, xmlDecode } from './portable-xml.mjs';
import { placeholderTextIssues } from './placeholder-scan.mjs';
import { validatePortableOoxml } from './portable-validation-package.mjs';
import { tableRowCells } from './pptx-table-fit.mjs';

export { validatePortableOoxml } from './portable-validation-package.mjs';

// Word's highlighter colours, by the names w:highlight stores.
const HIGHLIGHT_FILLS = Object.freeze({
  black: '000000',
  blue: '0000FF',
  cyan: '00FFFF',
  green: '00FF00',
  magenta: 'FF00FF',
  red: 'FF0000',
  yellow: 'FFFF00',
  white: 'FFFFFF',
  darkBlue: '000080',
  darkCyan: '008080',
  darkGreen: '008000',
  darkMagenta: '800080',
  darkRed: '800000',
  darkYellow: '808000',
  darkGray: '808080',
  lightGray: 'C0C0C0',
});

// A run's own shading or highlight is the field its letters sit on: white
// "inverse video" on a black run shade was measured against the page and
// reported as 1:1 ink nobody could read.
function runField(properties, fill) {
  const shade = /<w:shd\b[^>]*\bw:fill="([0-9A-Fa-f]{6})"/.exec(properties)?.[1];
  if (shade) return shade;
  const highlight = /<w:highlight\b[^>]*\bw:val="([A-Za-z]+)"/.exec(properties)?.[1];
  return HIGHLIGHT_FILLS[highlight] || fill;
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
    // defect about a working note no reader sees. A run that switches an
    // inherited vanish off — w:val="0", "false", "off" — is on the page, and
    // reading that flag as hidden left its ink unmeasured.
    const vanish = /<w:vanish\b([^>]*?)\/?>/.exec(properties)?.[1];
    if (vanish !== undefined && (!/\bw:val=/.test(vanish) || booleanXmlAttribute(vanish, 'w:val'))) continue;
    const color = /<w:color\b[^>]*\bw:val="([0-9A-Fa-f]{6})"/.exec(properties)?.[1] || '';
    if (!color) continue;
    const size = Number(/<w:sz\b[^>]*\bw:val="(\d+)"/.exec(properties)?.[1] || 0) / 2 || 11;
    const bold = /<w:b(?:\s[^>]*)?\/>/.test(properties);
    const ratio = contrastRatio(color, runField(properties, fill));
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

// Twenty findings of one kind are all a reader can act on in one pass; the
// audit keeps measuring past that, it just stops reporting.
const MAX_ISSUES = 20;

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
      if (issues.length >= MAX_ISSUES) return issues;
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
        if (issues.length >= MAX_ISSUES) return issues;
      }
    }
  }
  return issues;
}

// The parts whose visible text a review reads: every slide of a deck, the
// body, headers, and footers of a document (a header prints on every page),
// nothing for a workbook.
function textParts(zip, format) {
  let pattern;
  if (format === 'pptx') pattern = /^ppt\/slides\/slide\d+\.xml$/;
  else if (format === 'docx') pattern = /^word\/(?:document|header\d+|footer\d+)\.xml$/;
  else return [];
  return Object.keys(zip.files)
    .filter((name) => pattern.test(name))
    .sort();
}

async function placeholderIssues(zip, format) {
  const parts = textParts(zip, format);
  if (!parts.length) return [];
  const tag = format === 'pptx' ? 'a:t' : 'w:t';
  const issues = [];
  for (const part of parts) {
    const xml = await zipText(zip, part);
    if (!xml) continue;
    const text = paragraphTexts(xml, tag).join(' ');
    const slide = Number(/slide(\d+)\.xml$/.exec(part)?.[1]) || 0;
    const story = /^word\/(header|footer)\d+\.xml$/.exec(part)?.[1];
    let path = '/body';
    if (slide) path = `/slide[${slide}]`;
    else if (story) path = `/${story}`;
    issues.push(...placeholderTextIssues(text, path, story ? { part } : {}));
  }
  return issues;
}

// A header row on a dark fill with the body's dark ink is unreadable in
// exactly the way a shape's text would be; cells are measured the same way,
// against their own fill or the slide behind them.
function tableCellContrast(cellXml, body, slideSurface) {
  const properties = /<a:tcPr\b[^>]*>[\s\S]*?<\/a:tcPr>/.exec(cellXml)?.[0] || '';
  // The cell's own fill follows its border definitions, and each border
  // carries a colour of its own: read the fill after the lines are out.
  const surface = properties
    .replace(/<a:ln(?:L|R|T|B|TlToBr|BlToTr)\b[^>]*>[\s\S]*?<\/a:ln(?:L|R|T|B|TlToBr|BlToTr)>/g, '')
    .replace(/<a:ln(?:L|R|T|B|TlToBr|BlToTr)\b[^>]*\/>/g, '');
  const fill = /<a:solidFill>\s*<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/.exec(surface)?.[1] || slideSurface;
  const ink = /<a:rPr\b[^>]*>[\s\S]*?<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/.exec(body)?.[1] || '';
  return fill && ink ? contrastRatio(ink, fill) : null;
}

// Measures one table row's cells for contrast (pushing at most twenty reports in total) and collects the cells
// whose text needs more height than the row declares into overflows; returns the row's drawn height in EMU (the
// larger of its declared height and its tallest cell).
function auditTableRow(rowXml, { widths, pathPrefix, slideSurface }, issues, overflows) {
  const { cells, height } = tableRowCells(rowXml, widths);
  for (const { xml, body, size, bold, columnOrdinal, fit } of cells) {
    const cellPath = `${pathPrefix}/cell[${columnOrdinal}]`;
    const ratio = tableCellContrast(xml, body, slideSurface);
    const minimum = size >= 18 || (size >= 14 && bold) ? 3 : 4.5;
    // The cap is on the reports; the rows are still measured so the table's height is known.
    if (ratio != null && ratio < minimum && issues.length < MAX_ISSUES) {
      issues.push({
        severity: 'warning',
        code: 'low_contrast',
        path: cellPath,
        message: `Cell text contrast is ${ratio.toFixed(2)}:1 against its fill; ${minimum}:1 is the readable minimum at ${Math.round(size)}pt.`,
        source: 'text-metrics',
      });
    }
    if (!fit) continue;
    const { measured, available } = fit;
    if (measured.height > available * 1.08) overflows.push({ cellPath, measured, available });
  }
  return height;
}

// One report per table for the cells that outgrow their rows: a frame declared too short for its ten rows named every
// one of its cells, twenty reports of one fault. The first cell names the place; the count names the extent.
function tableOverflowIssue(overflows) {
  if (!overflows.length) return null;
  const [first] = overflows;
  const tallest = overflows.reduce((top, entry) => (entry.measured.height > top.measured.height ? entry : top), first);
  const message =
    overflows.length === 1
      ? `Cell text needs about ${Math.round(first.measured.height)}pt across ${first.measured.lines} line(s)` +
        ` but the row offers ${Math.round(first.available)}pt; shorten the text or widen the column.`
      : `${overflows.length} cells need more height than their rows give (the tallest about` +
        ` ${Math.round(tallest.measured.height)}pt in a ${Math.round(tallest.available)}pt row); each row grows to` +
        ' its text, so the table draws taller than its frame — widen the columns, shorten the text, or give the frame' +
        ' the height.';
  return { severity: 'warning', code: 'table_cell_overflow', path: first.cellPath, message, source: 'text-metrics' };
}

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
      const widths = [...table[0].matchAll(/<a:gridCol\b[^>]*\bw="(\d+)"/g)].map((match) => Number(match[1]));
      if (!widths.length) continue;
      const tablePath = `/slide[${slide}]/table[${tableOrdinal}]`;
      let predicted = 0;
      let rowOrdinal = 0;
      const overflows = [];
      for (const row of table[0].matchAll(/<a:tr\b[^>]*>[\s\S]*?<\/a:tr>/g)) {
        rowOrdinal += 1;
        predicted += auditTableRow(
          row[0],
          { widths, pathPrefix: `${tablePath}/row[${rowOrdinal}]`, slideSurface },
          issues,
          overflows
        );
      }
      const overflow = tableOverflowIssue(overflows);
      if (overflow && issues.length < MAX_ISSUES) issues.push(overflow);
      // The lower safe margin is 0.4 in (a source line or page number may sit there; a table may not).
      const room = slideHeight - 0.4 * 914400 - frameTop;
      if (slideHeight && frameTop >= 0 && predicted > room) {
        issues.push({
          severity: 'warning',
          code: 'table_exceeds_canvas',
          path: tablePath,
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

// The fraction of the raster a pptx crop leaves visible on each axis.
function visibleFraction(picture, format) {
  const sourceRect = format === 'pptx' ? /<a:srcRect\b([^>]*)\/?>/.exec(picture)?.[1] : '';
  if (!sourceRect) return { width: 1, height: 1 };
  const side = (name) => Number(xmlAttribute(sourceRect, name)) || 0;
  return { width: 1 - (side('l') + side('r')) / 100000, height: 1 - (side('t') + side('b')) / 100000 };
}

function lowResolutionIssue({ source, extent, picture, visible, path }) {
  const inchesWide = Number(extent[1]) / EMU_PER_INCH;
  const inchesTall = Number(extent[2]) / EMU_PER_INCH;
  const drawnAt = Math.min(
    (source.width * visible.width) / Math.max(inchesWide, 0.01),
    (source.height * visible.height) / Math.max(inchesTall, 0.01)
  );
  const enlarged =
    !/svgBlip/.test(picture) &&
    source.width >= IMAGE_SPACER_PX &&
    source.height >= IMAGE_SPACER_PX &&
    drawnAt < IMAGE_MIN_PPI;
  if (!enlarged) return null;
  return {
    severity: 'warning',
    code: 'image_low_resolution',
    path,
    message:
      `Image carries ${source.width}x${source.height} px for a ${inchesWide.toFixed(1)}x${inchesTall.toFixed(1)} in frame` +
      ` (${Math.round(drawnAt)} px per inch); it is enlarged past its own detail and draws soft.` +
      ` Supply about ${Math.round(inchesWide * IMAGE_TARGET_PPI)}x${Math.round(inchesTall * IMAGE_TARGET_PPI)} px, or place it smaller.`,
    source: 'image-audit',
  };
}

function aspectDistortionIssue({ source, extent, visible, path }) {
  const placed = Number(extent[1]) / Number(extent[2]);
  const visibleAspect = ((source.width / source.height) * visible.width) / visible.height;
  if (!Number.isFinite(placed) || !Number.isFinite(visibleAspect) || visibleAspect <= 0) return null;
  const drift = Math.abs(placed - visibleAspect) / visibleAspect;
  if (drift <= 0.1) return null;
  return {
    severity: 'warning',
    code: 'image_aspect_distorted',
    path,
    message:
      `Image is stretched ${Math.round(drift * 100)}% off its visible ${source.width}x${source.height} aspect ratio;` +
      ' set only width or height to keep the original proportions.',
    source: 'image-audit',
  };
}

// The findings for one placed picture: a blank raster ends that picture's
// audit; otherwise enlargement past its own detail, then aspect distortion.
async function pictureIssues({ bytes, source, extent, picture, format, path }) {
  if (await drawsNothing(bytes)) {
    return [
      {
        severity: 'error',
        code: 'blank_image',
        path,
        message:
          'Picture draws nothing: every pixel of the raster is transparent, so the page keeps the frame and its caption while the reader sees an empty box.',
        source: 'image-audit',
      },
    ];
  }
  const visible = visibleFraction(picture, format);
  return [
    lowResolutionIssue({ source, extent, picture, visible, path }),
    aspectDistortionIssue({ source, extent, visible, path }),
  ].filter(Boolean);
}

async function imagePlacementIssues(zip, format) {
  const parts = textParts(zip, format);
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
      const path = slide ? `/slide[${slide}]/picture[${ordinal}]` : `/body/picture[${ordinal}]`;
      for (const issue of await pictureIssues({ bytes, source, extent, picture: picture[0], format, path })) {
        issues.push(issue);
        if (issues.length >= MAX_ISSUES) return issues;
      }
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

const packageError = (code, path, message) => ({ severity: 'error', code, path, message });
const packageWarning = (code, path, message) => ({ severity: 'warning', code, path, message });

/** What the package itself is missing or contradicts, read from a validation result. */
function packageStructureIssues(validation) {
  return [
    ...validation.missing.map((missing) =>
      packageError('missing_part', `/${missing}`, `Required package part is missing: ${missing}`)
    ),
    ...validation.unsafeEntries.map((unsafe) =>
      packageError('unsafe_zip_entry', `/${unsafe}`, `Unsafe ZIP entry path: ${unsafe}`)
    ),
    ...validation.malformedXml.map((malformed) => packageError('malformed_xml', `/${malformed.part}`, malformed.error)),
    ...validation.missingRelationships.map((relationship) =>
      packageError(
        'missing_relationship_target',
        `/${relationship.relationship}`,
        `Relationship ${relationship.id || '(unnamed)'} targets missing part ${relationship.resolved || relationship.target}`
      )
    ),
    ...validation.duplicateRelationshipIds.map((relationship) =>
      packageError(
        'duplicate_relationship_id',
        `/${relationship.relationship}`,
        `Relationship id is duplicated: ${relationship.id}`
      )
    ),
    ...(validation.presentationFaults || []).map((fault) => packageError(fault.code, `/${fault.part}`, fault.message)),
    ...validation.missingContentTypes.map((part) =>
      packageError('missing_content_type', `/${part}`, 'Package part has no matching content type declaration.')
    ),
    ...(validation.mainContentTypeMissing
      ? [
          packageError(
            'missing_main_content_type',
            `/${validation.mainPart}`,
            'The main Office document part needs an explicit content type override.'
          ),
        ]
      : []),
  ];
}

/** What the source package carried and this copy must answer for: protected parts,
 *  signatures, macros, connections, embedded objects, external links. */
function packageProvenanceIssues(validation) {
  const security = validation.security || {};
  return [
    ...(validation.baseline.lostProtectedParts || []).map((part) =>
      packageError(
        'lost_protected_part',
        `/${part}`,
        'A macro, master, layout, or theme part from the source package was removed.'
      )
    ),
    ...(validation.baseline.changedProtectedParts || []).map((part) =>
      packageError(
        'changed_protected_part',
        `/${part.part}`,
        'A macro, signature, embedded object, external link, connection, master, layout, or theme part changed unexpectedly.'
      )
    ),
    ...(security.digitalSignatureInvalidated
      ? [
          packageError(
            'digital_signature_invalidated',
            '/',
            'The source package was digitally signed and document changes invalidate that signature.'
          ),
        ]
      : []),
    ...validation.macros.map((macro) =>
      packageWarning(
        'macro_present',
        `/${macro}`,
        'VBA macro payload is present and is never executed by the portable backend.'
      )
    ),
    ...(security.dataConnections || []).map((connection) =>
      packageWarning(
        'data_connection_present',
        `/${connection}`,
        'Workbook data connection is preserved but never refreshed automatically.'
      )
    ),
    ...(security.embeddedObjects || []).map((embedded) =>
      packageWarning(
        'embedded_object_present',
        `/${embedded}`,
        'Embedded object is preserved but never activated by Mixdog.'
      )
    ),
    ...validation.externalRelationships.map((relationship) =>
      packageWarning(
        'external_relationship',
        `/${relationship.relationship}`,
        `External relationship: ${relationship.target}`
      )
    ),
  ];
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

// Word's default cell padding, left and right, when the table names none.
const DOCX_DEFAULT_CELL_MARGIN = 108;
// Hangul and CJK break between any two characters; only a Latin or numeric word has a width it cannot be broken below.
const UNBREAKABLE_WORD = /^[^\s\u1100-\u11FF\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]+$/;

// A word wider than its cell is broken between letters: "Sun" set as "Su / n", a date "11" stacked as "1 / 1".
// Word and LibreOffice both do it without a warning, so the column reads as a typo on the printed page.
function brokenCellWord(table) {
  const grid = /<w:tblGrid(?:\s[^>]*)?>[\s\S]*?<\/w:tblGrid>/.exec(table)?.[0] || '';
  const columns = [...grid.matchAll(/<w:gridCol\b[^>]*\bw:w="(\d+)"/g)].map((match) => Number(match[1]));
  if (!columns.length) return null;
  const margins = /<w:tblCellMar\b[^>]*>[\s\S]*?<\/w:tblCellMar>/.exec(table)?.[0] || '';
  // A cell's own w:tcMar wins over the table's, which wins over Word's default.
  const side = (name, own = '') => {
    const found =
      new RegExp(`<w:${name}\\b[^>]*\\bw:w="(\\d+)"`).exec(own) || new RegExp(`<w:${name}\\b[^>]*\\bw:w="(\\d+)"`).exec(margins);
    return found ? Number(found[1]) : DOCX_DEFAULT_CELL_MARGIN;
  };
  let rowOrdinal = 0;
  for (const row of table.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)) {
    rowOrdinal += 1;
    let column = 0;
    let cellOrdinal = 0;
    for (const cell of row[0].matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/g)) {
      cellOrdinal += 1;
      const span = Math.max(1, Number(/<w:gridSpan\b[^>]*\bw:val="(\d+)"/.exec(cell[0])?.[1]) || 1);
      const width = columns.slice(column, column + span).reduce((total, value) => total + value, 0);
      column += span;
      if (!width || /<w:tbl[\s>]/.test(cell[0])) continue;
      const own = /<w:tcMar\b[^>]*>[\s\S]*?<\/w:tcMar>/.exec(cell[0])?.[0] || '';
      const room = (width - side('left', own) - side('right', own)) / 20;
      for (const paragraph of cell[0].matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
        const run = /<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/.exec(paragraph[0])?.[0] || '';
        const font = {
          fontName: /<w:rFonts\b[^>]*\bw:ascii="([^"]+)"/.exec(run)?.[1] || 'Calibri',
          fontSize: Number(/<w:sz\b[^>]*\bw:val="(\d+)"/.exec(run)?.[1] || 22) / 2,
          bold: /<w:b(?:\s+w:val="(?:1|true|on)")?\s*\/>/.test(run),
        };
        const indent = /<w:pPr\b[^>]*>[\s\S]*?<w:ind\b([^>]*)\/>/.exec(paragraph[0])?.[1] || '';
        const inset = ['left', 'start', 'right', 'end', 'firstLine'].reduce(
          (total, name) => total + (Number(new RegExp(`\\bw:${name}="(\\d+)"`).exec(indent)?.[1]) || 0),
          0
        );
        const words = paragraphTexts(paragraph[0], 'w:t').join('').split(/\s+/).filter((word) => UNBREAKABLE_WORD.test(word));
        const widest = words.map((word) => ({ word, width: measureTextWidth(word, font) })).sort((a, b) => b.width - a.width)[0];
        const line = room - inset / 20;
        if (widest && widest.width > Math.max(0, line) * 1.05) return { rowOrdinal, cellOrdinal, room: line, ...widest };
      }
    }
  }
  return null;
}

// Tables wider than the text column, and long tables whose styled header
// row does not repeat after a page break.
function documentTableIssues(document) {
  const issues = [];
  let ordinal = 0;
  for (const table of docxTables(document)) {
    ordinal += 1;
    const usable = sectionTextWidth(document, table.index + table[0].length);
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
    const broken = brokenCellWord(table[0]);
    if (broken) {
      issues.push({
        severity: 'warning',
        code: 'table_cell_word_broken',
        path: `/body/table[${ordinal}]/row[${broken.rowOrdinal}]/cell[${broken.cellOrdinal}]`,
        message: `"${broken.word}" needs ${broken.width.toFixed(0)}pt and its cell leaves ${Math.max(0, broken.room).toFixed(0)}pt, so the word breaks between letters; give that column more of the width (add_table properties.columnWidths), shorten the word, or set it smaller.`,
        source: 'text-metrics',
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
  return issues;
}

function reviewStateIssues(snapshot) {
  const issues = [];
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
  return issues;
}

function emptyDocumentIssues(document) {
  const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(document)?.[1] || '';
  const printable = body.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, '').replace(/<w:sectPr\b[^>]*\/>/g, '');
  if (/<w:t[\s>]/.test(printable) || /<w:tbl>/.test(printable) || /<w:drawing>/.test(printable)) return [];
  return [
    {
      severity: 'error',
      code: 'empty_document',
      path: '/body',
      message: 'The document body carries no text, table, or image; the requested content never reached the file.',
    },
  ];
}

// A slide's picture is audited for a description; a Word report delivered
// without one leaves the same reader with nothing. The snapshot's own
// picture list is the reading, so the finding points at the element the
// caller can look up — a header logo included.
function missingAltTextIssue(path) {
  return {
    severity: 'warning',
    code: 'missing_alt_text',
    path,
    message: 'Picture has no alternative text; add_image takes altText.',
  };
}

export function pictureDescriptionIssues(snapshot) {
  return (snapshot.images || [])
    .filter((picture) => !describesPicture(picture.altText))
    .map((picture) => missingAltTextIssue(picture.path));
}

// The serif faces, Latin and Korean, a document is likely to name; any other face reads as a sans here.
const SERIF_FACE =
  /^(?:cambria|georgia|times new roman|garamond|book antiqua|palatino linotype|constantia|bookman old style|noto serif(?: kr)?|batang|바탕|바탕체|gungsuh|궁서|nanummyeongjo|나눔명조)$/i;
const faceClass = (face) => (SERIF_FACE.test(String(face).trim()) ? 'serif' : 'sans');

// A run that sets Hangul beside Latin letters or digits in two classes of face — Cambria digits in a Malgun Gothic
// sentence, the setting a serif `name` without its `nameEastAsia` falls into — reads as two typefaces in one line.
// Only a Latin face the run names is judged; its Korean face is the run's own or the document default.
function documentFontPairingIssues(document, styles) {
  const defaults = /<w:rPrDefault\b[\s\S]*?<\/w:rPrDefault>/.exec(styles)?.[0] || '';
  const defaultEastAsia = xmlDecode(/<w:rFonts\b[^>]*\bw:eastAsia="([^"]+)"/.exec(defaults)?.[1] || 'Malgun Gothic');
  const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(document)?.[1] || '';
  const mixed = [];
  let paragraphOrdinal = 0;
  for (const block of topLevelElements(body, ['w:p', 'w:tbl'])) {
    if (block.name === 'w:p') paragraphOrdinal += 1;
    for (const run of block.xml.matchAll(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g)) {
      const text = paragraphTexts(run[0], 'w:t').join('');
      if (!/[\uAC00-\uD7A3]/.test(text) || !/[A-Za-z0-9]/.test(text)) continue;
      const fonts = /<w:rFonts\b[^>]*>/.exec(run[0])?.[0] || '';
      const latin = xmlDecode(/\bw:ascii="([^"]+)"/.exec(fonts)?.[1] || '');
      const eastAsia = xmlDecode(/\bw:eastAsia="([^"]+)"/.exec(fonts)?.[1] || '') || defaultEastAsia;
      if (!latin || faceClass(latin) === faceClass(eastAsia)) continue;
      mixed.push({ path: block.name === 'w:p' ? `/body/p[${paragraphOrdinal}]` : '/body', latin, eastAsia });
      break;
    }
  }
  if (!mixed.length) return [];
  const [first] = mixed;
  return [
    {
      severity: 'info',
      code: 'font_pairing_mismatch',
      path: first.path,
      message: `${mixed.length} block${mixed.length > 1 ? 's set' : ' sets'} Hangul in ${first.eastAsia} beside Latin and digits in ${first.latin}, a ${faceClass(first.eastAsia)} and a ${faceClass(first.latin)}: the line reads as two typefaces. Pair the faces by class (nameEastAsia beside name, fontNameEastAsia on a table) — Cambria with Batang, Calibri with Malgun Gothic.`,
      source: 'document-lint',
    },
  ];
}

/** What the Word document says about itself: revisions, comments, lint, emptiness,
 *  tables wider than the text column or losing their header after a page break,
 *  ink, font pairing, and pictures without a description. */
async function documentContentIssues(zip, validation) {
  const snapshot = await snapshotDocx(zip);
  const document = await zipText(zip, 'word/document.xml');
  return [
    ...reviewStateIssues(snapshot),
    ...(validation.documentLint || []).map((finding) => ({
      severity: finding.severity,
      code: finding.code,
      path: finding.part && finding.part !== 'word/document.xml' ? `/${finding.part}` : '/body',
      message: finding.message,
      source: 'document-lint',
    })),
    ...emptyDocumentIssues(document),
    ...documentTableIssues(document),
    ...documentInkIssues(document),
    ...documentFontPairingIssues(document, await zipText(zip, 'word/styles.xml')),
    ...pictureDescriptionIssues(snapshot),
  ];
}

const FORMULA_ERROR_PATTERN = /^(?:#REF!|#DIV\/0!|#VALUE!|#NAME\?|#N\/A|#NUM!|#NULL!)$/i;

// One sheet's values: how far the audit read, formula errors, and formulas
// without a cached value.
function sheetValueIssues(sheet) {
  const issues = [];
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
    if (FORMULA_ERROR_PATTERN.test(String(cell.value || ''))) {
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
  for (const sheet of snapshot.sheets) issues.push(...sheetValueIssues(sheet));
  // Sheet names come from the workbook, not the (possibly selective)
  // snapshot, so a cross-sheet reference to an unselected sheet still audits.
  const workbookSheetList = await workbookSheets(zip);
  const sheetNames = workbookSheetList.map((sheet) => sheet.name);
  // Every formula carries a cached value and the workbook is still marked for a
  // full calculation: the numbers on this page are the ones from before the
  // edit that set the mark. A successful recalculation clears it, and a
  // workbook whose formulas were never calculated at all is already reported as
  // formula_cache_missing, so this is the case a clean-looking cache hides.
  let cachedFormulas = 0;
  let uncachedFormulas = 0;
  for (const sheet of workbookSheetList) {
    const totals = sheetFormulaTotals(await zipText(zip, sheet.path));
    cachedFormulas += totals.formulaCount - totals.formulaCacheMissing;
    uncachedFormulas += totals.formulaCacheMissing;
  }
  if (
    cachedFormulas > 0 &&
    uncachedFormulas === 0 &&
    workbookCalculation(await zipText(zip, 'xl/workbook.xml')).fullCalcOnLoad === true
  ) {
    issues.push({
      severity: options.auditProfile === 'financial-model' ? 'error' : 'warning',
      code: 'stale_calculation',
      path: '/',
      message:
        'Formulas were edited and have not been recalculated since, so the cached values predate the edit. Recalculate (render, or qa with LibreOffice available) before reading the numbers.',
    });
  }
  if (options.auditProfile === 'financial-model' && !sheetNames.some(isChecksSheetName)) {
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
      issues.push(missingAltTextIssue(image.path));
    }
  }
  issues.push(
    ...auditXlsxFormulas(snapshot.sheets, {
      auditProfile: options.auditProfile,
      sheetNames,
      definedNames: snapshot.definedNames,
    })
  );
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
      issues.push(missingAltTextIssue(`/slide[${slide}]/picture[${picture}]`));
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
