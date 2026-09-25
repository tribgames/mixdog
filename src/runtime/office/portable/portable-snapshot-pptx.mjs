// Presentation snapshot: slide backgrounds, notes, shapes and text facts.
import { zipText } from './portable-opc.mjs';
import { pptxRelatedPart } from './portable-pptx-core.mjs';
import { EMU_PER_POINT, SLIDE_SHAPE_TAGS } from './portable-slide-shapes.mjs';
import { blockText, containerInner, paragraphTexts, topLevelElements, xmlDecode } from './portable-xml.mjs';
import { presentationSlides, slideLayoutParts } from './portable-pptx-package.mjs';
import { shapeIdentity } from './pptx-relations.mjs';
import { chartPartSnapshot, nextPageOffset, relatedPartById } from './portable-snapshot-shared.mjs';
import { tableDrawnHeight } from './pptx-table-fit.mjs';

const SLIDE_BACKGROUND = /<p:bg\b[^>]*>[\s\S]*?<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/;

// Microsoft Office reports a resolved background per slide, and the theme review
// abandons the whole deck as soon as one slide has none. Reading only the slide
// part would leave every template deck unreviewed, so inheritance is resolved
// through the layout and master exactly as PowerPoint does.
async function pptxSlideBackground(zip, slidePath, slideXml) {
  const own = SLIDE_BACKGROUND.exec(slideXml)?.[1];
  if (own) return { color: own.toUpperCase(), followMaster: false, source: 'slide' };
  const layoutPath = await pptxRelatedPart(zip, slidePath, '/slideLayout');
  if (layoutPath) {
    const layoutXml = await zipText(zip, layoutPath);
    const inherited = SLIDE_BACKGROUND.exec(layoutXml)?.[1];
    if (inherited) return { color: inherited.toUpperCase(), followMaster: true, source: 'layout' };
    const masterPath = await pptxRelatedPart(zip, layoutPath, '/slideMaster');
    if (masterPath) {
      const fromMaster = SLIDE_BACKGROUND.exec(await zipText(zip, masterPath))?.[1];
      if (fromMaster) return { color: fromMaster.toUpperCase(), followMaster: true, source: 'master' };
    }
  }
  return { color: '', followMaster: true, source: 'master' };
}

async function pptxSlideNotes(zip, slidePath) {
  const notesPath = await pptxRelatedPart(zip, slidePath, '/notesSlide');
  if (!notesPath) return '';
  const xml = await zipText(zip, notesPath);
  const tree = containerInner(xml, 'p:spTree');
  if (!tree) return '';
  for (const shape of topLevelElements(tree.inner, ['p:sp'])) {
    if (/<p:ph\b[^>]*\btype="body"/i.test(shape.xml)) {
      return blockText(shape.xml, 'a:t');
    }
  }
  return blockText(xml, 'a:t');
}

// The colour of the text itself — the first run that names one — as Microsoft Office reports it under font.color.
// Without it an agent adding a page to a deck could match the face and the size of the title it copied, never its
// colour: the new kicker came out black under a deck of blue kickers.
function runColor(shapeXml) {
  for (const run of shapeXml.matchAll(/<a:rPr\b[^>]*>([\s\S]*?)<\/a:rPr>/gi)) {
    const color = /^\s*<a:solidFill>\s*<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/i.exec(run[1])?.[1];
    if (color) return color.toUpperCase();
  }
  return '';
}

function fontFacts(fontSizes, bold, fonts, color = '') {
  if (!fontSizes.length) return {};
  return {
    font: {
      size: Math.max(...fontSizes),
      ...(bold ? { bold: true } : {}),
      ...(fonts.length ? { name: fonts[0] } : {}),
      ...(color ? { color } : {}),
    },
    sizes: [...new Set(fontSizes)].sort((a, b) => a - b),
  };
}

// The slides a read returns: the whole deck, one page of it, or the pages
// the caller named.
function selectPptxSlides(slidePaths, options) {
  const paged = options.paged === true;
  const offset = paged ? Math.max(0, Number(options.offset) || 0) : 0;
  const limit = paged ? Math.max(1, Number(options.limit) || 20) : slidePaths.length;
  let requested = slidePaths;
  if (paged && Array.isArray(options.pages) && options.pages.length) {
    requested = options.pages.map((page) => slidePaths[Number(page) - 1]).filter(Boolean);
  } else if (paged) {
    requested = slidePaths.slice(offset, offset + limit);
  }
  return { paged, offset, limit, requested };
}

// A chart frame carries only a relationship to its part, so the slide read
// alone says a chart is there and nothing about what it draws. The part is
// resolved here — the series, the legend, the labels — which is what the
// review needs to say whether a reader can tell the series apart. A part
// that cannot be resolved leaves the frame as it was, never as an empty chart.
async function slideChartParts(zip, slidePath, shapeBlocks) {
  const chartParts = new Map();
  for (let shapeIndex = 0; shapeIndex < shapeBlocks.length; shapeIndex += 1) {
    const id = /<c:chart\b[^>]*\br:id="([^"]+)"/i.exec(shapeBlocks[shapeIndex].xml)?.[1];
    if (!id) continue;
    const part = await relatedPartById(zip, slidePath, id);
    const partXml = part ? await zipText(zip, part) : '';
    if (partXml) chartParts.set(shapeIndex, { part, ...chartPartSnapshot(partXml) });
  }
  return chartParts;
}

// Typeface and color inventories feed the deck discipline review; a shape
// that mixes families or invents colors is otherwise invisible.
function shapeFonts(shapeXml) {
  return [
    ...new Set(
      [...shapeXml.matchAll(/<a:latin\b[^>]*\btypeface="([^"]+)"/gi)]
        .map((match) => xmlDecode(match[1]))
        .filter(Boolean)
    ),
  ];
}

function shapeColors(shapeXml) {
  return [
    ...new Set(
      [...shapeXml.matchAll(/<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/gi)].map((match) => match[1].toUpperCase())
    ),
  ];
}

// Preset geometry tells the diversity review which native structure a
// slide carries (chevron process, block-arc share, trapezoid tiers).
function shapeGeometry(shape) {
  if (shape.name !== 'p:sp') return '';
  if (/<a:custGeom\b/i.test(shape.xml)) return 'custGeom';
  return /<a:prstGeom\b[^>]*\bprst="([^"]+)"/i.exec(shape.xml)?.[1] || '';
}

// The shape's own surface color (spPr solidFill, or a gradient's first stop — the side the kit
// puts type on), distinct from text colors.
function shapeFill(shapeXml) {
  const spPr = /<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/i.exec(shapeXml)?.[1] || '';
  return (
    /<a:gradFill\b[\s\S]*?<a:gs\b[^>]*>\s*<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/i.exec(spPr)?.[1]?.toUpperCase() ||
    /<a:solidFill>\s*<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/i.exec(spPr)?.[1]?.toUpperCase() ||
    ''
  );
}

function shapeFrame(shapeXml) {
  const offset = /<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/i.exec(shapeXml);
  const extent = /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i.exec(shapeXml);
  if (!offset || !extent) return {};
  return {
    left: Number(offset[1]) / EMU_PER_POINT,
    top: Number(offset[2]) / EMU_PER_POINT,
    width: Number(extent[1]) / EMU_PER_POINT,
    height: Number(extent[2]) / EMU_PER_POINT,
  };
}

// Design review reads evidence from the same fields Microsoft Office
// reports. Publishing only the raw element name left every chart, table,
// group, picture, and type-scale rule blind on portable decks.
function pptxShapeSnapshot(shape, shapeIndex, slideIndex, chartParts) {
  const shapePath = `/slide[${slideIndex}]/shape[${shapeIndex + 1}]`;
  const fontSizes = [...shape.xml.matchAll(/<a:rPr\b[^>]*\bsz="(\d+)"/gi)]
    .map((match) => Number(match[1]) / 100)
    .filter((size) => size > 0);
  // Weight is a type-scale step of its own: a specimen ladder sets one size in light / regular / bold.
  const bold = /<a:rPr\b[^>]*\bb="1"/i.test(shape.xml);
  const tableRows = [...shape.xml.matchAll(/<a:tr\b/gi)].length;
  const tableColumns = [...shape.xml.matchAll(/<a:gridCol\b/gi)].length;
  const fonts = shapeFonts(shape.xml);
  const colors = shapeColors(shape.xml);
  const shapeName = xmlDecode(/<p:cNvPr\b[^>]*\bname="([^"]*)"/i.exec(shape.xml)?.[1] || '');
  const geometry = shapeGeometry(shape);
  // What a reader who cannot see the picture is told about it; the
  // audit asks for it, so the snapshot shows whether it is there.
  const altText = xmlDecode(/<p:cNvPr\b[^>]*\bdescr="([^"]*)"/i.exec(shape.xml)?.[1] || '');
  const fill = shapeFill(shape.xml);
  // A table stands as tall as its rows draw, as PowerPoint reports it: rows grow to their text past the frame the
  // file declares, and a source line under a table that ran long read as clear of it.
  const frame = shapeFrame(shape.xml);
  if (tableRows && frame.height != null) {
    frame.height = Math.max(frame.height, tableDrawnHeight(shape.xml) / EMU_PER_POINT);
  }
  return {
    path: shapePath,
    index: shapeIndex + 1,
    ...shapeIdentity(shape.xml),
    type: shape.name,
    ...(shapeName ? { name: shapeName } : {}),
    // PowerPoint's selection pane can hide a shape: it stays in the file
    // and the slide does not show it, so it is neither measured nor read
    // as what the page says.
    ...(/<p:cNvPr\b[^>]*\bhidden="(?:1|true)"/i.test(shape.xml) ? { hidden: true } : {}),
    ...(altText ? { altText } : {}),
    ...(geometry ? { geometry } : {}),
    ...(fill ? { fill: { color: fill } } : {}),
    // A table's cells are separate strings a reader never runs together
    // ("4:3" beside "8.8초" is not "4:38.8초"), so they join on a space;
    // a text body keeps its runs together and its breaks — a soft break
    // (a:br, which the kit writes between Hangul words) and a paragraph
    // end — as newlines, so "4주차" + "잔존율" never reads "4주차잔존율".
    text: tableRows ? paragraphTexts(shape.xml, 'a:t').join(' ') : blockText(shape.xml, 'a:t'),
    ...(shape.name === 'p:grpSp' ? { group: true } : {}),
    ...(/<p:ph\b/i.test(shape.xml) ? { placeholder: true } : {}),
    ...(/<c:chart\b/i.test(shape.xml)
      ? { chart: { path: `${shapePath}/chart`, ...(chartParts.get(shapeIndex) || {}) } }
      : {}),
    ...(tableRows ? { table: { rows: tableRows, columns: tableColumns } } : {}),
    ...fontFacts(fontSizes, bold, fonts, runColor(shape.xml)),
    ...(fonts.length ? { fonts } : {}),
    ...(colors.length ? { colors } : {}),
    ...frame,
  };
}

async function snapshotSlide(zip, path, index, slideId) {
  const xml = await zipText(zip, path);
  const tree = containerInner(xml, 'p:spTree');
  const shapeBlocks = tree ? topLevelElements(tree.inner, SLIDE_SHAPE_TAGS) : [];
  const chartParts = await slideChartParts(zip, path, shapeBlocks);
  return {
    path: `/slide[${index}]`,
    index,
    slideId,
    // A hidden slide stays in the file and is skipped when the deck is shown;
    // read as an ordinary page it puts a withdrawn page back in the argument.
    hidden: /<p:sld\b[^>]*\bshow="0"/.test(xml),
    background: await pptxSlideBackground(zip, path, xml),
    notes: await pptxSlideNotes(zip, path),
    text: paragraphTexts(xml, 'a:t'),
    shapes: shapeBlocks.map((shape, shapeIndex) => pptxShapeSnapshot(shape, shapeIndex, index, chartParts)),
  };
}

async function pptxLayouts(zip) {
  const layouts = await slideLayoutParts(zip);
  return layouts.map((layout, index) => ({
    path: `/layout[${index + 1}]`,
    index: index + 1,
    name: layout.name,
    packagePart: layout.path,
  }));
}

export async function snapshotPptx(zip, options = {}) {
  const roster = await presentationSlides(zip);
  const slidePaths = roster.map((slide) => slide.path);
  const { paged, offset, limit, requested } = selectPptxSlides(slidePaths, options);
  const slides = [];
  for (const path of requested) {
    const index = slidePaths.indexOf(path) + 1;
    slides.push(await snapshotSlide(zip, path, index, roster[index - 1].id));
  }
  const layouts = await pptxLayouts(zip);
  const presentationXml = await zipText(zip, 'ppt/presentation.xml');
  const slideSize = /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i.exec(presentationXml);
  const pagesRequested = Array.isArray(options.pages) && options.pages.length;
  const slidePagination = {
    unit: 'slide',
    offset,
    limit,
    returned: slides.length,
    total: pagesRequested ? requested.length : slidePaths.length,
    nextOffset: options.pages?.length ? null : nextPageOffset(offset, slides.length, slidePaths.length),
  };
  return {
    format: 'pptx',
    slideCount: slidePaths.length,
    slideWidth: slideSize ? Number(slideSize[1]) / EMU_PER_POINT : 0,
    slideHeight: slideSize ? Number(slideSize[2]) / EMU_PER_POINT : 0,
    slides,
    layoutCount: layouts.length,
    layouts,
    ...(paged ? { pagination: slidePagination } : {}),
  };
}
