import { extname, posix } from 'node:path';
import { resolveImageLayout } from './image-layout.mjs';
import { contrastRatio, shrinkFontSizeToFit } from './text-metrics.mjs';
import {
  EMU_PER_POINT,
  SLIDE_SHAPE_TAGS,
  fromEmu,
  pictureXml,
  resolveGeometry,
  shapeXml,
  supportedShapeTypes,
  tableXml,
  textBodyXml,
  toEmu,
} from './portable-slide-shapes.mjs';
import { readFile } from 'node:fs/promises';
import {
  addPackageRelationship,
  ensureDefaultContentType,
  imagePixelSize,
  partRelationshipPath,
  removePackageRelationship,
  zipText,
} from './portable-opc.mjs';
import {
  DRAWING_MAIN_NS,
  OFFICE_RELATIONSHIP_BASE,
  containerBody,
  containerInner,
  rebuildTextNodes,
  textNodes,
  topLevelElements,
  xmlAttribute,
  xmlEncode,
} from './portable-xml.mjs';
import { addSlideImage, slidePath } from './portable-pptx-package.mjs';
import {
  DEFAULT_TEXT_INSETS,
  appendSlideShape,
  nextShapeId,
  presentationSlideSize,
  selectedShapeSpans,
  setTableValues,
  shapeFrame,
  shapeParagraphs,
  updateShapeGeometry,
  writeShapeTree,
} from './portable-pptx-core.mjs';

export async function handleSetHyperlink(context, op) {
  const { zip } = context;
  const slide = await slideShapeTree(context, op);
  const { path, tree } = slide;
  const shape = slideShape(tree, op);
  const address = String(op.address || '').trim();
  if (!address && !op.subAddress) throw new Error('set_hyperlink requires address or subAddress');
  const relationshipId = address
    ? await addPackageRelationship(
        zip,
        partRelationshipPath(path),
        `${OFFICE_RELATIONSHIP_BASE}/hyperlink`,
        address,
        'External'
      )
    : '';
  const link =
    `<a:hlinkClick xmlns:a="${DRAWING_MAIN_NS}"` +
    `${relationshipId ? ` r:id="${relationshipId}"` : ' r:id=""'}` +
    `${op.subAddress ? ` action="ppaction://hlinksldjump"` : ''}/>`;
  const updated = shape.xml
    .replace(/<a:hlinkClick\b[^>]*?(?:\/>|>[\s\S]*?<\/a:hlinkClick>)/, '')
    .replace(/<p:cNvPr\b([^>]*?)(\/>|>)/, (_match, attrs, close) =>
      close === '/>' ? `<p:cNvPr${attrs}>${link}</p:cNvPr>` : `<p:cNvPr${attrs}>${link}`
    );
  writeSlideTree(context, slide, `${tree.inner.slice(0, shape.start)}${updated}${tree.inner.slice(shape.end)}`);
  return { op: op.op, changed: true, slide: Number(op.slide), shape: Number(op.shape), address };
}

export async function handleZOrder(context, op) {
  const { zip } = context;
  const { path, current, tree } = await slideShapeTree(context, op);
  const command = String(op.command || '').toLowerCase();
  if (!['front', 'back', 'forward', 'backward'].includes(command)) {
    throw new Error('z_order command must be front, back, forward, or backward');
  }
  const { shapes } = selectedShapeSpans(tree, [op.shape]);
  const index = Number(op.shape) - 1;
  const ordered = shapes.map((shape) => shape.xml);
  const [moved] = ordered.splice(index, 1);
  let destination;
  if (command === 'front') destination = ordered.length;
  else if (command === 'back') destination = 0;
  else destination = Math.max(0, Math.min(ordered.length, index + (command === 'forward' ? 1 : -1)));
  ordered.splice(destination, 0, moved);
  const preamble = tree.inner.slice(0, shapes[0]?.start ?? tree.inner.length);
  zip.file(path, writeShapeTree(current, tree, [preamble, ...ordered]));
  return { op: op.op, changed: true, slide: Number(op.slide), command };
}

// Moves each placement onto the requested edge or centre line of `bounds`.
function alignPlacements(placements, bounds, op) {
  const align = String(op.align || '').toLowerCase();
  const horizontal = { left: 0, center: 0.5, right: 1 }[align];
  const vertical = { top: 0, middle: 0.5, center: 0.5, bottom: 1 }[align];
  if (horizontal == null && vertical == null) {
    throw new Error('align must be left, center, right, top, middle, or bottom');
  }
  for (const placement of placements) {
    if (['left', 'center', 'right'].includes(align)) {
      placement.left = bounds.left + (bounds.right - bounds.left - placement.width) * horizontal;
    } else {
      placement.top = bounds.top + (bounds.bottom - bounds.top - placement.height) * vertical;
    }
  }
}

// Spreads the placements along one axis of `bounds` with equal gaps.
function distributePlacements(placements, bounds, op) {
  const direction = String(op.direction || '').toLowerCase();
  if (!['horizontal', 'vertical'].includes(direction)) {
    throw new Error('distribute direction must be horizontal or vertical');
  }
  const order = placements
    .map((placement) => ({ placement }))
    .sort((left, right) =>
      direction === 'horizontal' ? left.placement.left - right.placement.left : left.placement.top - right.placement.top
    );
  const total =
    direction === 'horizontal'
      ? bounds.right - bounds.left - order.reduce((sum, entry) => sum + entry.placement.width, 0)
      : bounds.bottom - bounds.top - order.reduce((sum, entry) => sum + entry.placement.height, 0);
  const gap = total / Math.max(1, order.length - 1);
  let cursor = direction === 'horizontal' ? bounds.left : bounds.top;
  for (const entry of order) {
    if (direction === 'horizontal') {
      entry.placement.left = cursor;
      cursor += entry.placement.width + gap;
    } else {
      entry.placement.top = cursor;
      cursor += entry.placement.height + gap;
    }
  }
}

// The slide's shape tree with the slide XML it was read from.
async function slideShapeTree(context, op) {
  const path = slidePath(context.slides, op.slide);
  const current = await zipText(context.zip, path);
  const tree = containerInner(current, 'p:spTree');
  if (!tree) throw new Error('PPTX slide shape tree is missing');
  return { path, current, tree };
}

function slideShape(tree, op) {
  const shapes = topLevelElements(tree.inner, SLIDE_SHAPE_TAGS);
  const shape = shapes[Number(op.shape) - 1];
  if (!shape) throw new Error(`PPTX shape ${op.shape} not found on slide ${op.slide}`);
  return shape;
}

function writeSlideTree(context, { path, current, tree }, inner) {
  context.zip.file(path, `${current.slice(0, tree.start)}${inner}${current.slice(tree.end)}`);
}

// The tree's inner XML with the selected shapes rewritten: `replacementFor`
// answers with a shape's new XML, '' to drop it, or null to keep it as is.
function rewriteShapeTree(tree, shapes, replacementFor) {
  let inner = '';
  let cursor = 0;
  for (const shape of shapes) {
    const replacement = replacementFor(shape);
    if (replacement == null) continue;
    inner += tree.inner.slice(cursor, shape.start) + replacement;
    cursor = shape.end;
  }
  return inner + tree.inner.slice(cursor);
}

function framesExtent(frames) {
  return {
    left: Math.min(...frames.map((frame) => frame.left)),
    top: Math.min(...frames.map((frame) => frame.top)),
    right: Math.max(...frames.map((frame) => frame.left + frame.width)),
    bottom: Math.max(...frames.map((frame) => frame.top + frame.height)),
  };
}

export async function handleAlignShapesOrDistributeShapes(context, op) {
  const slide = await slideShapeTree(context, op);
  const numbers = Array.isArray(op.shapes) ? op.shapes.map(Number) : [];
  if (numbers.length < 2) throw new Error(`${op.op} requires at least two shapes`);
  const { shapes, selected } = selectedShapeSpans(slide.tree, numbers);
  const frames = selected.map((shape) => {
    const frame = shapeFrame(shape.xml);
    if (!frame) throw new Error(`PPTX shape has no explicit position; ${op.op} needs sized shapes`);
    return frame;
  });
  const slideSize = await presentationSlideSize(context.zip);
  const bounds =
    op.relativeToSlide === true
      ? { left: 0, top: 0, right: slideSize.width, bottom: slideSize.height }
      : framesExtent(frames);
  const placements = frames.map((frame) => ({ ...frame }));
  if (op.op === 'align_shapes') alignPlacements(placements, bounds, op);
  else distributePlacements(placements, bounds, op);
  const updates = new Map(
    selected.map((shape, index) => [
      shape.start,
      updateShapeGeometry(shape.xml, { left: placements[index].left, top: placements[index].top }),
    ])
  );
  writeSlideTree(
    context,
    slide,
    rewriteShapeTree(slide.tree, shapes, (shape) => updates.get(shape.start) ?? null)
  );
  return { op: op.op, changed: true, slide: Number(op.slide), shapes: numbers.length };
}

export async function handleSetText(context, op) {
  const slide = await slideShapeTree(context, op);
  const { tree } = slide;
  const shape = slideShape(tree, op);
  const nodes = textNodes(shape.xml, 'a:t');
  if (!nodes.length) throw new Error(`PPTX shape ${op.shape} has no editable text`);
  nodes[0].text = String(op.text ?? '');
  for (let index = 1; index < nodes.length; index += 1) nodes[index].text = '';
  const nextShape = rebuildTextNodes(shape.xml, 'a:t', nodes);
  writeSlideTree(context, slide, `${tree.inner.slice(0, shape.start)}${nextShape}${tree.inner.slice(shape.end)}`);
  return { op: op.op, changed: true };
}

// The ink a filled shape can carry: white on a dark card, near-black on a light
// one, and nothing at all when the fill is a theme reference or absent, so the
// inherited colour keeps deciding.
function inkOnFill(fill) {
  const field = String(fill || '')
    .replace(/^#/, '')
    .toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(field)) return undefined;
  return (contrastRatio('FFFFFF', field) ?? 0) >= (contrastRatio('1F2429', field) ?? 0) ? 'FFFFFF' : '1F2429';
}

export async function handleAddTextboxOrAddShape(context, op) {
  const { zip } = context;
  const slides = context.slides;
  const path = slidePath(slides, op.slide);
  const current = await zipText(zip, path);
  const id = nextShapeId(current);
  const properties = op.properties || {};
  const textBox = op.op === 'add_textbox';
  const geometry = textBox ? 'rect' : resolveGeometry(op.shapeType);
  if (!geometry) {
    throw new Error(`Unsupported shapeType: ${op.shapeType}. Use one of: ${supportedShapeTypes().join(', ')}`);
  }
  const paragraphs =
    Array.isArray(op.paragraphs) && op.paragraphs.length ? op.paragraphs : [{ text: String(op.text ?? '') }];
  const shape = shapeXml({
    id,
    name: String(op.name || '').trim() || `Mixdog ${textBox ? 'TextBox' : 'Shape'} ${id}`,
    geometry,
    left: op.left ?? properties.left ?? 72,
    top: op.top ?? properties.top ?? 72,
    width: op.width ?? properties.width ?? 360,
    height: op.height ?? properties.height ?? 72,
    properties: {
      ...properties,
      ...(op.fillColor == null ? {} : { fillColor: op.fillColor }),
      ...(op.lineColor === undefined ? {} : { lineColor: op.lineColor }),
    },
    textBody: textBodyXml({
      paragraphs,
      defaults: {
        fontName: op.fontName ?? properties.fontName,
        fontSize: op.fontSize ?? properties.fontSize ?? 18,
        // A caller who fills a shape and says nothing about its text gets ink
        // the fill can carry. The default dark ink on a dark card was text the
        // runtime's own contrast check then reported as unreadable.
        color: op.color ?? properties.color ?? inkOnFill(op.fillColor ?? properties.fillColor),
        bold: properties.bold,
        italic: properties.italic,
        align: properties.align,
        paragraphSpacing: properties.paragraphSpacing,
      },
      anchor: properties.anchor || (textBox ? '' : 'center'),
      margins: properties,
      autofit: properties.autofit || 'none',
    }),
    textBox,
  });
  zip.file(path, appendSlideShape(current, shape));
  return { op: op.op, changed: true, shapeId: id };
}

export async function handleDeleteShape(context, op) {
  const slide = await slideShapeTree(context, op);
  const { tree } = slide;
  const shape = slideShape(tree, op);
  writeSlideTree(context, slide, `${tree.inner.slice(0, shape.start)}${tree.inner.slice(shape.end)}`);
  return { op: op.op, changed: true };
}

export async function handleAddTable(context, op) {
  const { zip } = context;
  const slides = context.slides;
  const path = slidePath(slides, op.slide);
  const current = await zipText(zip, path);
  const id = nextShapeId(current);
  const table = tableXml({
    id,
    values: Array.isArray(op.values) ? op.values : [],
    left: op.left ?? 72,
    top: op.top ?? 72,
    width: op.width ?? 480,
    height: op.height ?? 120,
    properties: op.properties || {},
  });
  zip.file(path, appendSlideShape(current, table));
  return { op: op.op, changed: true, shapeId: id };
}

export async function handleAddImage(context, op) {
  const { zip } = context;
  const slides = context.slides;
  const path = slidePath(slides, op.slide);
  const sourceSize = imagePixelSize(await readFile(op.path));
  const placement = resolveImageLayout({
    sourceWidth: sourceSize?.width,
    sourceHeight: sourceSize?.height,
    left: op.left ?? 72,
    top: op.top ?? 72,
    width: op.width ?? 240,
    height: op.height ?? 180,
    fit: op.fit,
    focusX: op.focusX,
    focusY: op.focusY,
  });
  const media = await addSlideImage(zip, path, op.path);
  const current = await zipText(zip, path);
  const id = nextShapeId(current);
  const picture = pictureXml({
    id,
    embedId: media.relationshipId,
    left: placement.left,
    top: placement.top,
    width: placement.width,
    height: placement.height,
    crop: placement.crop,
    altText: op.altText,
  });
  zip.file(path, appendSlideShape(current, picture));
  return {
    op: op.op,
    changed: true,
    shapeId: id,
    image: media.part,
    fit: placement.fit,
    placement: {
      left: placement.left,
      top: placement.top,
      width: placement.width,
      height: placement.height,
    },
  };
}

// The shape fit_text measures, with the slide text it sits in; a shape with no
// text run or no explicit size cannot be fitted.
async function measurableShape(context, op) {
  const { path, current, tree } = await slideShapeTree(context, op);
  const shape = slideShape(tree, op);
  const paragraphs = shapeParagraphs(shape.xml);
  if (!paragraphs?.length) throw new Error(`PPTX shape ${op.shape} has no measurable text run`);
  const extent = /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(shape.xml);
  if (!extent) throw new Error(`PPTX shape ${op.shape} has no explicit size`);
  return { path, current, tree, shape, paragraphs, extent };
}

// The text area inside the shape's own insets, in points.
function textAreaSize(shapeXml, extent) {
  const bodyProperties = /<a:bodyPr\b([^>]*?)\/?>/.exec(shapeXml)?.[1] || '';
  const inset = (name, fallback) => fromEmu(Number(xmlAttribute(bodyProperties, name)), fallback);
  return {
    width: Math.max(
      1,
      Number(extent[1]) / EMU_PER_POINT -
        inset('lIns', DEFAULT_TEXT_INSETS.left) -
        inset('rIns', DEFAULT_TEXT_INSETS.right)
    ),
    height: Math.max(
      1,
      Number(extent[2]) / EMU_PER_POINT -
        inset('tIns', DEFAULT_TEXT_INSETS.top) -
        inset('bIns', DEFAULT_TEXT_INSETS.bottom)
    ),
  };
}

export async function handleFitText(context, op) {
  const { path, current, tree, shape, paragraphs, extent } = await measurableShape(context, op);
  const minimumFontSize = Math.max(1, Number(op.minFontSize) || 8);
  const fitted = shrinkFontSizeToFit(paragraphs, { ...textAreaSize(shape.xml, extent), minimumFontSize });
  if (!fitted.scale) {
    throw new Error(`PPTX shape ${op.shape} on slide ${op.slide} cannot fit its text above ${minimumFontSize}pt`);
  }
  const changed = fitted.scale < 1;
  if (changed) {
    const updated = shape.xml.replace(
      /\bsz="(\d+)"/g,
      (_, size) => `sz="${Math.max(minimumFontSize * 100, Math.round(Number(size) * fitted.scale))}"`
    );
    const nextInner = `${tree.inner.slice(0, shape.start)}${updated}${tree.inner.slice(shape.end)}`;
    writeSlideTree(context, { path, current, tree }, nextInner);
  }
  return {
    op: op.op,
    changed,
    slide: Number(op.slide),
    shape: Number(op.shape),
    scale: Number(fitted.scale.toFixed(2)),
    // The size the copy now reads at: shrinking is the last repair, so the
    // author sees what it cost and can rewrite the line instead.
    fontSize: Math.max(...fitted.sizes.map((size) => Number(size) || 0), 0) || undefined,
  };
}

// The picture frame keeps its place and size; only the image inside changes.
async function replacedPicture(zip, path, shape, op) {
  if (shape.name !== 'p:pic') throw new Error(`PPTX shape ${op.shape} on slide ${op.slide} is not a picture`);
  const previous = /<a:blip\b[^>]*\br:embed="([^"]*)"/.exec(shape.xml)?.[1];
  if (!previous) throw new Error(`PPTX picture ${op.shape} on slide ${op.slide} has no image reference`);
  const media = await addSlideImage(zip, path, op.path);
  let updated = shape.xml.replace(/(<a:blip\b[^>]*\br:embed=")[^"]*(")/, `$1${media.relationshipId}$2`);
  const detail = { image: media.part, replaced: previous };
  // The frame is the page's design and the new picture rarely shares its
  // ratio: stretched into it the photograph comes out squeezed (the audit's
  // image_aspect_distorted). It is centred and cropped to the frame, the way
  // add_image fit:'cover' places one, so the picture changes and the page does
  // not. A crop the old picture carried is replaced, never kept over the new one.
  const extent = /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(shape.xml);
  const sourceSize = imagePixelSize(await readFile(op.path));
  if (extent && sourceSize?.width && sourceSize?.height) {
    const { crop } = resolveImageLayout({
      sourceWidth: sourceSize.width,
      sourceHeight: sourceSize.height,
      width: Number(extent[1]) / EMU_PER_POINT,
      height: Number(extent[2]) / EMU_PER_POINT,
      fit: 'cover',
    });
    const edge = (value) => Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100_000);
    const cropped = crop && Object.values(crop).some((value) => value > 0);
    const rect = cropped
      ? `<a:srcRect l="${edge(crop.left)}" t="${edge(crop.top)}" r="${edge(crop.right)}" b="${edge(crop.bottom)}"/>`
      : '';
    updated = updated
      .replace(/<a:srcRect\b[^>]*\/>/, '')
      .replace(/(<a:blip\b[^>]*?(?:\/>|>[\s\S]*?<\/a:blip>))/, `$1${rect}`);
    detail.cropped = cropped;
  }
  // The frame keeps the description of the picture that used to be in it, so
  // a replaced photo is announced as the old one until the caller renames it.
  const altText = String(op.altText ?? '').trim();
  if (altText) {
    const encoded = xmlEncode(altText);
    updated = /<p:cNvPr\b[^>]*\bdescr="/.test(updated)
      ? updated.replace(/(<p:cNvPr\b[^>]*\bdescr=")[^"]*(")/, `$1${encoded}$2`)
      : updated.replace(/(<p:cNvPr\b[^>]*?)(\/?>)/, `$1 descr="${encoded}"$2`);
    detail.altText = altText;
  }
  return { updated, detail };
}

export async function handleSetTableDataOrReplaceImage(context, op) {
  const { zip } = context;
  const { path, current, tree } = await slideShapeTree(context, op);
  const shape = slideShape(tree, op);
  let updated;
  let detail = {};
  if (op.op === 'set_table_data') {
    const values = Array.isArray(op.values) ? op.values.filter((row) => Array.isArray(row)) : [];
    if (!values.length) throw new Error('set_table_data requires values as an array of rows');
    const filled = setTableValues(shape.xml, values);
    updated = filled.xml;
    detail = { rows: filled.rows, cells: filled.cells, capacity: filled.capacity };
    if (values.length > filled.capacity) {
      detail.droppedRows = values.length - filled.capacity;
    }
  } else {
    ({ updated, detail } = await replacedPicture(zip, path, shape, op));
  }
  const nextInner = `${tree.inner.slice(0, shape.start)}${updated}${tree.inner.slice(shape.end)}`;
  const nextSlide = `${current.slice(0, tree.start)}${nextInner}${current.slice(tree.end)}`;
  zip.file(path, nextSlide);
  if (detail.replaced && !nextSlide.includes(`r:embed="${detail.replaced}"`)) {
    await removePackageRelationship(zip, partRelationshipPath(path), detail.replaced);
  }
  return { op: op.op, changed: updated !== shape.xml, slide: Number(op.slide), ...detail };
}

function ungroupShape(context, op, slide) {
  const group = slideShape(slide.tree, op);
  if (group.name !== 'p:grpSp') throw new Error(`PPTX shape ${op.shape} on slide ${op.slide} is not a group`);
  const children = containerBody(group.xml, 'p:grpSp')
    .replace(/<p:nvGrpSpPr>[\s\S]*?<\/p:nvGrpSpPr>/, '')
    .replace(/<p:grpSpPr>[\s\S]*?<\/p:grpSpPr>/, '');
  writeSlideTree(
    context,
    slide,
    `${slide.tree.inner.slice(0, group.start)}${children}${slide.tree.inner.slice(group.end)}`
  );
  return { op: op.op, changed: true, slide: Number(op.slide), shape: Number(op.shape) };
}

function groupShapeXml(id, { left, top, right, bottom }, selected) {
  return (
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="Group ${id}"/>` +
    '<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    `<p:grpSpPr><a:xfrm><a:off x="${toEmu(left)}" y="${toEmu(top)}"/>` +
    `<a:ext cx="${Math.max(1, toEmu(right - left))}" cy="${Math.max(1, toEmu(bottom - top))}"/>` +
    `<a:chOff x="${toEmu(left)}" y="${toEmu(top)}"/>` +
    `<a:chExt cx="${Math.max(1, toEmu(right - left))}" cy="${Math.max(1, toEmu(bottom - top))}"/>` +
    '</a:xfrm></p:grpSpPr>' +
    selected.map((shape) => shape.xml).join('') +
    '</p:grpSp>'
  );
}

export async function handleGroupShapesOrUngroupShape(context, op) {
  const slide = await slideShapeTree(context, op);
  if (op.op === 'ungroup_shape') return ungroupShape(context, op, slide);
  const numbers = Array.isArray(op.shapes)
    ? [...new Set(op.shapes.map(Number))].sort((left, right) => left - right)
    : [];
  if (numbers.length < 2) throw new Error('group_shapes requires at least two shapes');
  const { shapes, selected } = selectedShapeSpans(slide.tree, numbers);
  const frames = selected.map((shape) => shapeFrame(shape.xml));
  if (frames.some((frame) => !frame)) throw new Error('group_shapes needs shapes with explicit geometry');
  const id = nextShapeId(slide.current);
  const anchors = new Set(selected.map((shape) => shape.start));
  const inner = rewriteShapeTree(slide.tree, shapes, (shape) => (anchors.has(shape.start) ? '' : null));
  writeSlideTree(context, slide, inner + groupShapeXml(id, framesExtent(frames), selected));
  return { op: op.op, changed: true, slide: Number(op.slide), shapes: numbers.length, shapeId: id };
}

const MEDIA_CONTENT_TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
};

function mediaFileType(op) {
  const kind = String(op.kind || 'video').toLowerCase();
  if (!['video', 'audio'].includes(kind)) throw new Error('add_media kind must be video or audio');
  const extension = extname(String(op.path || ''))
    .replace(/^\./, '')
    .toLowerCase();
  if (!extension) throw new Error('add_media requires a media file path');
  const contentType = MEDIA_CONTENT_TYPES[extension];
  if (!contentType) {
    throw new Error(`Unsupported media type: .${extension}. Use ${Object.keys(MEDIA_CONTENT_TYPES).join(', ')}`);
  }
  if (!op.poster) throw new Error('add_media requires poster for the preview frame');
  return { kind, extension, contentType };
}

// A media frame: the poster picture, the media link and embed relationships,
// and the click action that plays it.
function mediaPictureXml({ id, name, kind, op, linkId, mediaId, posterId }) {
  return (
    '<p:pic><p:nvPicPr>' +
    `<p:cNvPr id="${id}" name="${xmlEncode(name)}"${op.altText ? ` descr="${xmlEncode(String(op.altText))}"` : ''}>` +
    '<a:hlinkClick xmlns:a="' +
    DRAWING_MAIN_NS +
    '" r:id="" action="ppaction://media"/></p:cNvPr>' +
    '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>' +
    `<p:nvPr><a:${kind}File xmlns:a="${DRAWING_MAIN_NS}" r:link="${linkId}"/>` +
    `<p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}">` +
    `<p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="${mediaId}"/>` +
    '</p:ext></p:extLst></p:nvPr></p:nvPicPr>' +
    `<p:blipFill><a:blip r:embed="${posterId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${toEmu(op.left ?? 72)}" y="${toEmu(op.top ?? 72)}"/>` +
    `<a:ext cx="${Math.max(1, toEmu(op.width ?? 360))}" cy="${Math.max(1, toEmu(op.height ?? 240))}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
  );
}

export async function handleAddMedia(context, op) {
  const { zip } = context;
  const slides = context.slides;
  const path = slidePath(slides, op.slide);
  const current = await zipText(zip, path);
  const { kind, extension, contentType } = mediaFileType(op);
  let ordinal = 1;
  while (zip.file(`ppt/media/media${ordinal}.${extension}`)) ordinal += 1;
  const mediaPart = `ppt/media/media${ordinal}.${extension}`;
  zip.file(mediaPart, await readFile(op.path));
  await ensureDefaultContentType(zip, extension, contentType);
  const relative = posix.relative('ppt/slides', mediaPart);
  const mediaId = await addPackageRelationship(
    zip,
    partRelationshipPath(path),
    `http://schemas.microsoft.com/office/2007/relationships/media`,
    relative
  );
  const linkId = await addPackageRelationship(
    zip,
    partRelationshipPath(path),
    `${OFFICE_RELATIONSHIP_BASE}/${kind}`,
    relative
  );
  const poster = await addSlideImage(zip, path, op.poster);
  const shape = mediaPictureXml({
    id: nextShapeId(current),
    name: posix.basename(mediaPart),
    kind,
    op,
    linkId,
    mediaId,
    posterId: poster.relationshipId,
  });
  zip.file(path, appendSlideShape(await zipText(zip, path), shape));
  return { op: op.op, changed: true, slide: Number(op.slide), media: mediaPart, kind };
}

export async function handleCropImage(context, op) {
  const slide = await slideShapeTree(context, op);
  const { tree } = slide;
  const shape = slideShape(tree, op);
  if (shape.name !== 'p:pic') throw new Error(`PPTX shape ${op.shape} on slide ${op.slide} is not a picture`);
  const edge = (value) => Math.max(0, Math.min(100_000, Math.round((Number(value) || 0) * 1000)));
  const rect = `<a:srcRect l="${edge(op.left)}" t="${edge(op.top)}" r="${edge(op.right)}" b="${edge(op.bottom)}"/>`;
  const updated = shape.xml
    .replace(/<a:srcRect\b[^>]*\/>/, '')
    .replace(/(<a:blip\b[^>]*?(?:\/>|>[\s\S]*?<\/a:blip>))/, `$1${rect}`);
  writeSlideTree(context, slide, `${tree.inner.slice(0, shape.start)}${updated}${tree.inner.slice(shape.end)}`);
  return { op: op.op, changed: true, slide: Number(op.slide), shape: Number(op.shape) };
}

const ANIMATION_EFFECTS = {
  appear: { presetID: 1, filter: '' },
  fade: { presetID: 10, filter: 'fade' },
  wipe: { presetID: 22, filter: 'wipe(up)' },
  zoom: { presetID: 23, filter: 'fade' },
  fly: { presetID: 2, filter: 'slide(fromBottom)' },
  float: { presetID: 30, filter: 'slide(fromBottom)' },
};
const ANIMATION_TRIGGERS = { onclick: 'clickEffect', withprevious: 'withEffect', afterprevious: 'afterEffect' };

// Every other multiword value in this runtime is written with a separator
// (outside_end, section_next), so on_click and after_previous name the same
// triggers as onclick and afterprevious.
function animationName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function animationRequest(op) {
  const requested = animationName(op.effect) || 'fade';
  if (!Object.hasOwn(ANIMATION_EFFECTS, requested)) {
    throw new Error(`add_animation effect must be one of: ${Object.keys(ANIMATION_EFFECTS).join(', ')}`);
  }
  const trigger = animationName(op.trigger) || 'onclick';
  if (!Object.hasOwn(ANIMATION_TRIGGERS, trigger)) {
    throw new Error('add_animation trigger must be one of: on_click, with_previous, after_previous');
  }
  return {
    requested,
    effect: ANIMATION_EFFECTS[requested],
    trigger,
    duration: Math.max(1, Math.round((Number(op.duration) > 0 ? Number(op.duration) : 0.5) * 1000)),
    delay: Math.max(0, Math.round((Number(op.delay) > 0 ? Number(op.delay) : 0) * 1000)),
  };
}

// The entrance effect node for one shape and the click group that carries
// it; `id` hands out the next unused timing node id.
function animationNodes(shapeId, { effect, trigger, duration, delay }, id) {
  const target = `<p:tgtEl><p:spTgt spid="${shapeId}"/></p:tgtEl>`;
  const behaviour =
    `<p:set><p:cBhvr><p:cTn id="${id()}" dur="1" fill="hold">` +
    '<p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>' +
    `${target}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr>` +
    '<p:to><p:strVal val="visible"/></p:to></p:set>' +
    (effect.filter
      ? `<p:animEffect transition="in" filter="${effect.filter}"><p:cBhvr>` +
        `<p:cTn id="${id()}" dur="${duration}"/>${target}</p:cBhvr></p:animEffect>`
      : '');
  const node =
    `<p:par><p:cTn id="${id()}" presetID="${effect.presetID}" presetClass="entr"` +
    ` presetSubtype="0" fill="hold" grpId="0" nodeType="${ANIMATION_TRIGGERS[trigger]}">` +
    `<p:stCondLst><p:cond delay="${delay}"/></p:stCondLst>` +
    `<p:childTnLst>${behaviour}</p:childTnLst></p:cTn></p:par>`;
  const group =
    `<p:par><p:cTn id="${id()}" fill="hold">` +
    '<p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst>' +
    `<p:par><p:cTn id="${id()}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst>` +
    `<p:childTnLst>${node}</p:childTnLst></p:cTn></p:par>` +
    '</p:childTnLst></p:cTn></p:par>';
  return { node, group };
}

// The slide's timing tree with the animation added: a fresh main sequence
// when the slide has none, a new click group for on_click, or the effect
// joined to the last group for with/after_previous.
function timingWithAnimation(existing, { node, group }, trigger, id) {
  if (!existing) {
    return (
      '<p:timing><p:tnLst><p:par>' +
      `<p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>` +
      '<p:seq concurrent="1" nextAc="seek">' +
      `<p:cTn id="${id()}" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${group}</p:childTnLst></p:cTn>` +
      '<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>' +
      '<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>' +
      '</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'
    );
  }
  const head = /<p:cTn\b[^>]*\bnodeType="mainSeq"[^>]*>/.exec(existing);
  const sequence = head ? containerInner(existing, 'p:childTnLst', head.index + head[0].length) : null;
  if (!sequence) throw new Error('PPTX slide timing has no main animation sequence');
  const last = topLevelElements(sequence.inner, ['p:par']).at(-1);
  let nextInner;
  if (trigger === 'onclick' || !last) {
    nextInner = `${sequence.inner}${group}`;
  } else {
    const closes = [...last.xml.matchAll(/<\/p:childTnLst>/g)].map((match) => match.index);
    const insertAt = closes.length >= 2 ? closes.at(-2) : closes.at(-1);
    const merged = `${last.xml.slice(0, insertAt)}${node}${last.xml.slice(insertAt)}`;
    nextInner = `${sequence.inner.slice(0, last.start)}${merged}${sequence.inner.slice(last.end)}`;
  }
  return `${existing.slice(0, sequence.start)}${nextInner}${existing.slice(sequence.end)}`;
}

export async function handleAddAnimation(context, op) {
  const { zip } = context;
  const { path, current, tree } = await slideShapeTree(context, op);
  const shape = slideShape(tree, op);
  const shapeId = Number(/<p:cNvPr\b[^>]*\bid="(\d+)"/.exec(shape.xml)?.[1]);
  if (!shapeId) throw new Error(`PPTX shape ${op.shape} on slide ${op.slide} has no shape id`);
  const request = animationRequest(op);
  const existing = /<p:timing>[\s\S]*?<\/p:timing>/.exec(current)?.[0] || '';
  let nextId =
    Math.max(2, ...[...existing.matchAll(/<p:cTn\b[^>]*\bid="(\d+)"/g)].map((match) => Number(match[1]))) + 1;
  const id = () => nextId++;
  const timing = timingWithAnimation(existing, animationNodes(shapeId, request, id), request.trigger, id);
  const stripped = current.replace(/<p:timing>[\s\S]*?<\/p:timing>/, '');
  zip.file(path, stripped.replace('</p:sld>', `${timing}</p:sld>`));
  return {
    op: op.op,
    changed: true,
    slide: Number(op.slide),
    shape: Number(op.shape),
    effect: request.requested,
    trigger: request.trigger,
  };
}

export async function handleSetShape(context, op) {
  const slide = await slideShapeTree(context, op);
  const { tree } = slide;
  const shape = slideShape(tree, op);
  const updated = updateShapeGeometry(shape.xml, op.properties || {});
  writeSlideTree(context, slide, `${tree.inner.slice(0, shape.start)}${updated}${tree.inner.slice(shape.end)}`);
  return { op: op.op, changed: updated !== shape.xml };
}
