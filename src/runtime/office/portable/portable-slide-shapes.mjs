import { xmlEncode } from './portable-xml.mjs';

export const EMU_PER_POINT = 12_700;

// The top-level objects of a slide's shape tree, in the order PowerPoint
// numbers them: a shape, a picture, a framed chart or table, and a group.
export const SLIDE_SHAPE_TAGS = Object.freeze(['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);

export function fromEmu(value, fallback) {
  return Number.isFinite(value) ? value / EMU_PER_POINT : fallback;
}

const GEOMETRY = Object.freeze({
  rectangle: 'rect',
  rect: 'rect',
  square: 'rect',
  rounded_rectangle: 'roundRect',
  rounded_rect: 'roundRect',
  roundrect: 'roundRect',
  oval: 'ellipse',
  ellipse: 'ellipse',
  circle: 'ellipse',
  triangle: 'triangle',
  right_triangle: 'rtTriangle',
  diamond: 'diamond',
  pentagon: 'homePlate',
  hexagon: 'hexagon',
  octagon: 'octagon',
  chevron: 'chevron',
  arrow: 'rightArrow',
  right_arrow: 'rightArrow',
  left_arrow: 'leftArrow',
  up_arrow: 'upArrow',
  down_arrow: 'downArrow',
  line: 'line',
  star: 'star5',
  parallelogram: 'parallelogram',
  trapezoid: 'trapezoid',
  can: 'can',
  cloud: 'cloud',
  donut: 'donut',
  plus: 'mathPlus',
  minus: 'mathMinus',
  callout: 'wedgeRectCallout',
});

const ALIGNMENT = Object.freeze({
  left: 'l',
  center: 'ctr',
  centre: 'ctr',
  right: 'r',
  justify: 'just',
  distributed: 'dist',
});

const ANCHOR = Object.freeze({
  top: 't',
  center: 'ctr',
  centre: 'ctr',
  middle: 'ctr',
  bottom: 'b',
});

export function toEmu(points, fallback = 0) {
  const value = Number(points);
  return Math.round((Number.isFinite(value) ? value : fallback) * EMU_PER_POINT);
}

function normalizeHex(value) {
  const raw = String(value ?? '')
    .trim()
    .replace(/^#/, '')
    .toUpperCase();
  if (/^[0-9A-F]{6}$/.test(raw)) return raw;
  if (/^[0-9A-F]{3}$/.test(raw))
    return raw
      .split('')
      .map((digit) => `${digit}${digit}`)
      .join('');
  return '';
}

export function resolveGeometry(shapeType) {
  const key = String(shapeType || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return Object.hasOwn(GEOMETRY, key) ? GEOMETRY[key] : '';
}

export function supportedShapeTypes() {
  return Object.keys(GEOMETRY);
}

function solidFill(color, transparency) {
  const hex = normalizeHex(color);
  if (!hex) return '';
  const alpha = Number(transparency);
  const modifier =
    Number.isFinite(alpha) && alpha > 0
      ? `<a:alpha val="${Math.round(Math.max(0, Math.min(100, 100 - alpha)) * 1000)}"/>`
      : '';
  return `<a:solidFill><a:srgbClr val="${hex}">${modifier}</a:srgbClr></a:solidFill>`;
}

function outline(properties) {
  const color = normalizeHex(properties.lineColor);
  if (!color) return properties.lineColor === null ? '<a:ln><a:noFill/></a:ln>' : '';
  const width = Number(properties.lineWidth);
  return (
    `<a:ln${Number.isFinite(width) && width > 0 ? ` w="${toEmu(width)}"` : ''}>` +
    `${solidFill(color, properties.lineTransparency)}</a:ln>`
  );
}

function runProperties(source, defaults) {
  const size = Number(source.fontSize ?? defaults.fontSize);
  const name = source.fontName ?? defaults.fontName;
  const color = normalizeHex(source.color ?? defaults.color);
  const bold = source.bold ?? defaults.bold;
  const italic = source.italic ?? defaults.italic;
  const attributes =
    ' lang="en-US"' +
    (Number.isFinite(size) && size > 0 ? ` sz="${Math.round(size * 100)}"` : '') +
    (bold === true ? ' b="1"' : '') +
    (italic === true ? ' i="1"' : '') +
    ' dirty="0"';
  const children =
    `${color ? solidFill(color) : ''}` +
    (name
      ? `<a:latin typeface="${xmlEncode(name)}"/><a:ea typeface="${xmlEncode(name)}"/><a:cs typeface="${xmlEncode(name)}"/>`
      : '');
  return { attributes, children };
}

function paragraphXml(paragraph, defaults) {
  const level = Math.max(0, Math.min(8, Number(paragraph.level) || 0));
  const alignKey = String(paragraph.align ?? defaults.align ?? '').toLowerCase();
  const align = Object.hasOwn(ALIGNMENT, alignKey) ? ALIGNMENT[alignKey] : '';
  const spacing = Number(paragraph.paragraphSpacing ?? defaults.paragraphSpacing);
  const bulleted = paragraph.bullet === true;
  // A bullet hangs 22 pt and each level steps in by as much again, as the Office backend sets it: one margin for
  // every level set a sub-point flush with the point it belongs to.
  const indent = bulleted ? Math.round(2.2 * EMU_PER_POINT * 10) : 0;
  const properties =
    `<a:pPr${level ? ` lvl="${level}"` : ''}` +
    `${bulleted ? ` marL="${indent * (level + 1)}" indent="${-indent}"` : ' marL="0" indent="0"'}` +
    `${align ? ` algn="${align}"` : ''}>` +
    (Number.isFinite(spacing) && spacing > 0
      ? `<a:spcBef><a:spcPts val="${Math.round(spacing * 100)}"/></a:spcBef>`
      : '') +
    (bulleted ? '<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>' : '<a:buNone/>') +
    '</a:pPr>';
  const text = String(paragraph.text ?? '');
  const run = runProperties(paragraph, defaults);
  const preserveSpace = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  const body = text
    ? `<a:r><a:rPr${run.attributes}>${run.children}</a:rPr>` + `<a:t${preserveSpace}>${xmlEncode(text)}</a:t></a:r>`
    : `<a:endParaRPr${run.attributes}>${run.children}</a:endParaRPr>`;
  return `<a:p>${properties}${body}</a:p>`;
}

export function textBodyXml({
  paragraphs = [],
  defaults = {},
  anchor = '',
  wrap = true,
  margins = {},
  autofit = 'none',
} = {}) {
  const anchorKey = String(anchor || '').toLowerCase();
  const anchorValue = Object.hasOwn(ANCHOR, anchorKey) ? ANCHOR[anchorKey] : '';
  const inset = ['Left', 'Top', 'Right', 'Bottom']
    .map((edge, index) => {
      const value = margins[`margin${edge}`];
      if (value == null) return '';
      return ` ${['lIns', 'tIns', 'rIns', 'bIns'][index]}="${toEmu(value)}"`;
    })
    .join('');
  let fit = '<a:noAutofit/>';
  if (autofit === 'shrink') fit = '<a:normAutofit/>';
  else if (autofit === 'resize') fit = '<a:spAutoFit/>';
  const body = paragraphs.length
    ? paragraphs.map((paragraph) => paragraphXml(paragraph, defaults)).join('')
    : paragraphXml({ text: '' }, defaults);
  return (
    `<a:bodyPr wrap="${wrap ? 'square' : 'none'}"${inset}${anchorValue ? ` anchor="${anchorValue}"` : ''}>${fit}</a:bodyPr>` +
    `<a:lstStyle/>${body}`
  );
}

function frame(left, top, width, height, rotation) {
  const angle = Number(rotation);
  return (
    `<a:xfrm${Number.isFinite(angle) && angle ? ` rot="${Math.round(angle * 60_000)}"` : ''}>` +
    `<a:off x="${toEmu(left)}" y="${toEmu(top)}"/>` +
    `<a:ext cx="${Math.max(1, toEmu(width))}" cy="${Math.max(1, toEmu(height))}"/></a:xfrm>`
  );
}

export function shapeXml({
  id,
  name = '',
  geometry = 'rect',
  left = 0,
  top = 0,
  width = 100,
  height = 50,
  properties = {},
  textBody = '',
  textBox = false,
}) {
  let fill = textBox ? '<a:noFill/>' : '';
  if (Object.hasOwn(properties, 'fillColor')) {
    fill = solidFill(properties.fillColor, properties.fillTransparency) || '<a:noFill/>';
  }
  const line = outline(properties) || (textBox ? '<a:ln><a:noFill/></a:ln>' : '');
  // The shadow and the description set_shape writes; a new shape dropped both on both backends.
  const effects = properties.shadow ? `<a:effectLst>${shadowXml(properties.shadow)}</a:effectLst>` : '';
  const description = properties.altText ? ` descr="${xmlEncode(String(properties.altText))}"` : '';
  return (
    `<p:sp><p:nvSpPr>` +
    `<p:cNvPr id="${id}" name="${xmlEncode(name || `Shape ${id}`)}"${description}/>` +
    `<p:cNvSpPr${textBox ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${frame(left, top, width, height, properties.rotation)}` +
    `<a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom>${fill}${line}${effects}</p:spPr>` +
    `<p:txBody>${textBody}</p:txBody></p:sp>`
  );
}

function cropRectXml(crop) {
  if (!crop) return '';
  const values = {
    l: Math.round(Math.max(0, Math.min(1, Number(crop.left) || 0)) * 100000),
    t: Math.round(Math.max(0, Math.min(1, Number(crop.top) || 0)) * 100000),
    r: Math.round(Math.max(0, Math.min(1, Number(crop.right) || 0)) * 100000),
    b: Math.round(Math.max(0, Math.min(1, Number(crop.bottom) || 0)) * 100000),
  };
  if (!Object.values(values).some((value) => value > 0)) return '';
  return `<a:srcRect l="${values.l}" t="${values.t}" r="${values.r}" b="${values.b}"/>`;
}

export function pictureXml({
  id,
  name = '',
  embedId,
  left = 0,
  top = 0,
  width = 100,
  height = 100,
  crop = null,
  altText = '',
}) {
  return (
    '<p:pic><p:nvPicPr>' +
    `<p:cNvPr id="${id}" name="${xmlEncode(name || `Picture ${id}`)}"${altText ? ` descr="${xmlEncode(altText)}"` : ''}/>` +
    '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
    `<p:blipFill><a:blip r:embed="${embedId}"/>${cropRectXml(crop)}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${frame(left, top, width, height)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    '</p:pic>'
  );
}

// A table the caller did not style reads the way the Word writer's does: a rule under the header, hairlines between
// the rows, no verticals. Left to the reader, the same table came out as a black grid in LibreOffice and bare text in
// PowerPoint (no style, no borders), neither of them the deck it sat in.
const TABLE_HEADER_RULE = '9AA3AD';
const TABLE_ROW_RULE = 'D8DCE0';
const tableLine = (side, color, width) =>
  color
    ? `<a:${side} w="${width}" cap="flat" cmpd="sng"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:prstDash val="solid"/></a:${side}>`
    : `<a:${side} w="0"><a:noFill/></a:${side}>`;
function tableCellLines(header) {
  return (
    tableLine('lnL') +
    tableLine('lnR') +
    tableLine('lnT') +
    (header ? tableLine('lnB', TABLE_HEADER_RULE, 12700) : tableLine('lnB', TABLE_ROW_RULE, 6350))
  );
}

// A figure sits on the right edge of its column, and its header over it: "1,420", "−12", "8.4", "94.1%", "2,840원".
const TABLE_FIGURE = /^[\s~+\-−–$€₩£(]*[\d.,]+\s*(?:[%xXKMBT]|배|건|억|조|만|천|원|시간|일|개월|개|명|대|곳|분|초|회|점|년)*[)]?\s*$|^[-–—]$/;

function tableCellXml(text, header, properties, fill, align) {
  const defaults = {
    fontName: properties.fontName,
    fontSize: properties.fontSize,
    color: header ? (properties.headerColor ?? properties.color) : properties.color,
    bold: header ? true : properties.bold,
  };
  const body = textBodyXml({
    paragraphs: [{ text, align: properties.align ?? align ?? 'left' }],
    defaults,
    anchor: 'center',
    margins: { marginLeft: 7, marginRight: 7, marginTop: 3, marginBottom: 3 },
  });
  return `<a:tc><a:txBody>${body}</a:txBody><a:tcPr anchor="ctr">${tableCellLines(header)}${fill ? solidFill(fill) : ''}</a:tcPr></a:tc>`;
}

function tableRowXml(row, { header, columns, properties, fill, height, alignments }) {
  const cells = Array.from({ length: columns }, (_, columnIndex) =>
    tableCellXml(row[columnIndex] ?? '', header, properties, fill, alignments[columnIndex])
  ).join('');
  return `<a:tr h="${height}">${cells}</a:tr>`;
}

export function tableXml({
  id,
  name = '',
  values = [],
  left = 0,
  top = 0,
  width = 400,
  height = 200,
  properties = {},
}) {
  const rows = values.filter((row) => Array.isArray(row));
  if (!rows.length) throw new Error('add_table requires values as a non-empty array of rows');
  const columns = Math.max(...rows.map((row) => row.length));
  if (!columns) throw new Error('add_table requires at least one column');
  // columnWidths (points, one per column) share the frame's width in their proportions; without them the columns
  // are equal.
  const declared = Array.isArray(properties.columnWidths) ? properties.columnWidths.map(Number) : [];
  const shares =
    declared.length === columns && declared.every((value) => value > 0)
      ? declared.map((value) => value / declared.reduce((sum, entry) => sum + entry, 0))
      : Array(columns).fill(1 / columns);
  const headerHeight = Number(properties.headerRowHeight) || 0;
  const bodyHeight = Number(properties.bodyRowHeight) || 0;
  const grid = shares.map((share) => `<a:gridCol w="${Math.max(1, Math.round(toEmu(width) * share))}"/>`).join('');
  const headerFill = normalizeHex(properties.headerFillColor);
  const bodyFill = normalizeHex(properties.bodyFillColor);
  const alignments = Array.from({ length: columns }, (_, column) => {
    const cells = rows.slice(1).map((row) => String(row[column] ?? '').trim()).filter(Boolean);
    return column > 0 && cells.length > 0 && cells.every((cell) => TABLE_FIGURE.test(cell)) ? 'right' : 'left';
  });
  const body = rows
    .map((row, rowIndex) => {
      const header = rowIndex === 0;
      const rowHeight = header ? headerHeight || bodyHeight : bodyHeight || headerHeight;
      return tableRowXml(row, {
        header,
        columns,
        properties,
        fill: header ? headerFill : bodyFill,
        height: rowHeight ? toEmu(rowHeight) : Math.round(toEmu(height) / rows.length),
        alignments,
      });
    })
    .join('');
  return (
    '<p:graphicFrame><p:nvGraphicFramePr>' +
    `<p:cNvPr id="${id}" name="${xmlEncode(name || `Table ${id}`)}"/>` +
    '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>' +
    `<p:xfrm><a:off x="${toEmu(left)}" y="${toEmu(top)}"/>` +
    `<a:ext cx="${Math.max(1, toEmu(width))}" cy="${Math.max(1, toEmu(height))}"/></p:xfrm>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
    `<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${grid}</a:tblGrid>${body}</a:tbl>` +
    '</a:graphicData></a:graphic></p:graphicFrame>'
  );
}

// An attribute list with one attribute set (or added) to a value.
function withAttribute(attributes, name, value) {
  const stripped = attributes.replace(new RegExp(`\\s${name}="[^"]*"`), '');
  return `${stripped} ${name}="${value}"`;
}

// One run property element (a:rPr or a:endParaRPr) restyled: size and weight on the tag, the colour first among its
// children and the faces after it, as the schema orders them.
function restyledRun(tag, attributes, children, properties) {
  let attrs = attributes;
  const size = Number(properties.fontSize);
  if (Number.isFinite(size) && size > 0) attrs = withAttribute(attrs, 'sz', Math.round(size * 100));
  if (properties.bold != null) attrs = withAttribute(attrs, 'b', properties.bold ? '1' : '0');
  if (properties.italic != null) attrs = withAttribute(attrs, 'i', properties.italic ? '1' : '0');
  let body = children;
  const fill = solidFill(properties.color);
  if (fill) {
    body = `${fill}${body.replace(/<a:(?:solidFill|gradFill)\b[\s\S]*?<\/a:(?:solidFill|gradFill)>|<a:noFill\/>/g, '')}`;
  }
  if (properties.fontName) {
    const face = xmlEncode(properties.fontName);
    const faces = `<a:latin typeface="${face}"/><a:ea typeface="${face}"/><a:cs typeface="${face}"/>`;
    body = body.replace(/<a:(?:latin|ea|cs)\b[^>]*\/>/g, '');
    const tail = /<a:(?:sym|hlinkClick|hlinkMouseOver|rtl|extLst)\b/.exec(body);
    body = tail ? `${body.slice(0, tail.index)}${faces}${body.slice(tail.index)}` : `${body}${faces}`;
  }
  return body ? `<a:${tag}${attrs}>${body}</a:${tag}>` : `<a:${tag}${attrs}/>`;
}

// A shadow as the Office backend's Shape.Shadow writes it: true is PowerPoint's own (black, a 5 pt blur, 2.08 pt
// down and right); an object names its colour, transparency (0-1, as Shadow.Transparency), blur and offsets in points.
// set_shape answered "no change" here for a shadow the Office backend drew.
function shadowXml(shadow) {
  const spec = shadow === true ? {} : shadow;
  const offsetX = Number(spec.offsetX ?? 2.08);
  const offsetY = Number(spec.offsetY ?? 2.08);
  const degrees = ((Math.atan2(offsetY, offsetX) * 180) / Math.PI + 360) % 360;
  const transparency = Math.max(0, Math.min(1, Number(spec.transparency) || 0));
  const alpha = transparency ? `<a:alpha val="${Math.round((1 - transparency) * 100_000)}"/>` : '';
  return (
    `<a:outerShdw blurRad="${toEmu(Math.max(0, Number(spec.blur ?? 5)))}"` +
    ` dist="${toEmu(Math.hypot(offsetX, offsetY))}" dir="${Math.round(degrees * 60_000)}" rotWithShape="0">` +
    `<a:srgbClr val="${normalizeHex(spec.color) || '000000'}">${alpha}</a:srgbClr></a:outerShdw>`
  );
}

// The shape's outer shadow set, its other effects kept in the schema's order.
function withShadow(shape, shadow) {
  const spPr = /<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/.exec(shape);
  if (!spPr) return shape;
  const existing = /<a:effectLst\b[^>]*?(?:\/>|>([\s\S]*?)<\/a:effectLst>)/.exec(spPr[1]);
  const kept = (existing?.[1] || '').replace(/<a:outerShdw\b[\s\S]*?<\/a:outerShdw>/, '');
  const later = /<a:(?:prstShdw|reflection|softEdge)\b/.exec(kept);
  const at = later ? later.index : kept.length;
  const list = `<a:effectLst>${kept.slice(0, at)}${shadowXml(shadow)}${kept.slice(at)}</a:effectLst>`;
  let inner;
  if (existing) {
    inner = `${spPr[1].slice(0, existing.index)}${list}${spPr[1].slice(existing.index + existing[0].length)}`;
  } else {
    const after = /<a:(?:effectDag|scene3d|sp3d|extLst)\b/.exec(spPr[1]);
    const position = after ? after.index : spPr[1].length;
    inner = `${spPr[1].slice(0, position)}${list}${spPr[1].slice(position)}`;
  }
  const start = spPr.index + spPr[0].indexOf('>') + 1;
  return `${shape.slice(0, start)}${inner}${shape.slice(start + spPr[1].length)}`;
}

// A shape's text restyled the way the Office backend sets it through the text frame — every paragraph's alignment,
// every run's face, size, weight, and colour, the frame's anchor and insets — and its outline. set_shape used to move
// and fill the box and leave its words as they were.
export function restyleShapeText(shape, properties) {
  let next = shape;
  const spPr = /<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/.exec(next);
  // A width or transparency alone restyles the outline the shape has, and a new colour keeps its width, as the
  // Office backend's Line does; both were dropped here unless a colour came with them.
  const existingLine = /<a:ln\b[^>]*?(?:\/>|>[\s\S]*?<\/a:ln>)/.exec(spPr?.[1] || '')?.[0] || '';
  const existingAlpha = /<a:alpha val="(\d+)"/.exec(existingLine)?.[1];
  const line = {
    lineColor:
      properties.lineColor !== undefined
        ? properties.lineColor
        : /<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/.exec(existingLine)?.[1],
    lineWidth: properties.lineWidth ?? (Number(/\bw="(\d+)"/.exec(existingLine)?.[1]) / EMU_PER_POINT || undefined),
    lineTransparency: properties.lineTransparency ?? (existingAlpha ? 100 - Number(existingAlpha) / 1000 : undefined),
  };
  const lineRequested = ['lineColor', 'lineWidth', 'lineTransparency'].some((key) => properties[key] !== undefined);
  if (spPr && lineRequested && (normalizeHex(line.lineColor) || line.lineColor === null)) {
    // The outline follows the fill and precedes any effects in the shape properties.
    const stripped = spPr[1].replace(/<a:ln\b[^>]*?(?:\/>|>[\s\S]*?<\/a:ln>)/, '');
    const effects = /<a:(?:effectLst|effectDag|scene3d|sp3d|extLst)\b/.exec(stripped);
    const at = effects ? effects.index : stripped.length;
    const inner = `${stripped.slice(0, at)}${outline(line)}${stripped.slice(at)}`;
    const start = spPr.index + spPr[0].indexOf('>') + 1;
    next = `${next.slice(0, start)}${inner}${next.slice(start + spPr[1].length)}`;
  }
  if (properties.shadow) next = withShadow(next, properties.shadow);
  const body = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(next);
  if (!body) return next;
  let inner = body[1];
  const anchorKey = String(properties.verticalAlignment || '').toLowerCase();
  const insets = { marginLeft: 'lIns', marginTop: 'tIns', marginRight: 'rIns', marginBottom: 'bIns' };
  inner = inner.replace(/<a:bodyPr\b([^>]*?)(\/?)>/, (_match, attributes, selfClosing) => {
    let attrs = attributes;
    if (Object.hasOwn(ANCHOR, anchorKey)) attrs = withAttribute(attrs, 'anchor', ANCHOR[anchorKey]);
    for (const [name, attribute] of Object.entries(insets)) {
      if (properties[name] != null) attrs = withAttribute(attrs, attribute, toEmu(properties[name]));
    }
    return `<a:bodyPr${attrs}${selfClosing}>`;
  });
  const alignKey = String(properties.alignment || '').toLowerCase();
  if (Object.hasOwn(ALIGNMENT, alignKey)) {
    inner = inner
      .replace(/<a:p>(?!<a:pPr)/g, '<a:p><a:pPr/>')
      .replace(
        /<a:pPr\b([^>]*?)(\/?)>/g,
        (_match, attributes, selfClosing) =>
          `<a:pPr${withAttribute(attributes, 'algn', ALIGNMENT[alignKey])}${selfClosing}>`
      );
  }
  const spacing = Number(properties.paragraphSpacing);
  if (properties.paragraphSpacing != null && Number.isFinite(spacing)) {
    // Space before every paragraph, as add_shape writes it and the Office backend sets it; set_shape ignored it.
    const before = spacing > 0 ? `<a:spcBef><a:spcPts val="${Math.round(spacing * 100)}"/></a:spcBef>` : '';
    inner = inner
      .replace(/<a:p>(?!<a:pPr)/g, '<a:p><a:pPr/>')
      .replace(/<a:pPr\b([^>]*?)\/>/g, '<a:pPr$1></a:pPr>')
      .replace(/(<a:pPr\b[^>]*>)([\s\S]*?)<\/a:pPr>/g, (_match, head, children) => {
        const rest = children.replace(/<a:spcBef>[\s\S]*?<\/a:spcBef>/, '');
        // lnSpc is the one child the schema puts before spcBef.
        const lineSpacing = /^<a:lnSpc>[\s\S]*?<\/a:lnSpc>/.exec(rest)?.[0] || '';
        return `${head}${lineSpacing}${before}${rest.slice(lineSpacing.length)}</a:pPr>`;
      });
  }
  if (['fontName', 'fontSize', 'bold', 'italic', 'color'].some((name) => properties[name] != null)) {
    inner = inner
      .replace(/<a:r>(?!<a:rPr)/g, '<a:r><a:rPr/>')
      .replace(/<a:(rPr|endParaRPr)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:\1>)/g, (_match, tag, attributes, children) =>
        restyledRun(tag, attributes, children || '', properties)
      );
  }
  return `${next.slice(0, body.index)}<p:txBody>${inner}</p:txBody>${next.slice(body.index + body[0].length)}`;
}

export function solidFillXml(color, transparency) {
  return solidFill(color, transparency);
}

export function backgroundXml(color) {
  const hex = normalizeHex(color);
  if (!hex) throw new Error('set_slide_background requires a hex color');
  return `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
}
