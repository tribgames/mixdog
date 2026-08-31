const EMU_PER_POINT = 12_700;

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

export function encodeXml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function toEmu(points, fallback = 0) {
  const value = Number(points);
  return Math.round((Number.isFinite(value) ? value : fallback) * EMU_PER_POINT);
}

export function normalizeHex(value) {
  const raw = String(value ?? '').trim().replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{6}$/.test(raw)) return raw;
  if (/^[0-9A-F]{3}$/.test(raw)) return raw.split('').map((digit) => `${digit}${digit}`).join('');
  return '';
}

export function resolveGeometry(shapeType) {
  const key = String(shapeType || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return GEOMETRY[key] || '';
}

export function supportedShapeTypes() {
  return Object.keys(GEOMETRY);
}

function solidFill(color, transparency) {
  const hex = normalizeHex(color);
  if (!hex) return '';
  const alpha = Number(transparency);
  const modifier = Number.isFinite(alpha) && alpha > 0
    ? `<a:alpha val="${Math.round(Math.max(0, Math.min(100, 100 - alpha)) * 1000)}"/>`
    : '';
  return `<a:solidFill><a:srgbClr val="${hex}">${modifier}</a:srgbClr></a:solidFill>`;
}

function outline(properties) {
  const color = normalizeHex(properties.lineColor);
  if (!color) return properties.lineColor === null ? '<a:ln><a:noFill/></a:ln>' : '';
  const width = Number(properties.lineWidth);
  return `<a:ln${Number.isFinite(width) && width > 0 ? ` w="${toEmu(width)}"` : ''}>`
    + `${solidFill(color, properties.lineTransparency)}</a:ln>`;
}

function runProperties(source, defaults) {
  const size = Number(source.fontSize ?? defaults.fontSize);
  const name = source.fontName ?? defaults.fontName;
  const color = normalizeHex(source.color ?? defaults.color);
  const bold = source.bold ?? defaults.bold;
  const italic = source.italic ?? defaults.italic;
  const attributes = ' lang="en-US"'
    + (Number.isFinite(size) && size > 0 ? ` sz="${Math.round(size * 100)}"` : '')
    + (bold === true ? ' b="1"' : '')
    + (italic === true ? ' i="1"' : '')
    + ' dirty="0"';
  const children = `${color ? solidFill(color) : ''}`
    + (name ? `<a:latin typeface="${encodeXml(name)}"/><a:ea typeface="${encodeXml(name)}"/><a:cs typeface="${encodeXml(name)}"/>` : '');
  return { attributes, children };
}

function paragraphXml(paragraph, defaults) {
  const level = Math.max(0, Math.min(8, Number(paragraph.level) || 0));
  const align = ALIGNMENT[String(paragraph.align ?? defaults.align ?? '').toLowerCase()] || '';
  const spacing = Number(paragraph.paragraphSpacing ?? defaults.paragraphSpacing);
  const bulleted = paragraph.bullet === true;
  const indent = bulleted ? Math.round(2.2 * EMU_PER_POINT * 10) : 0;
  const properties = `<a:pPr${level ? ` lvl="${level}"` : ''}`
    + `${bulleted ? ` marL="${indent}" indent="${-indent}"` : ' marL="0" indent="0"'}`
    + `${align ? ` algn="${align}"` : ''}>`
    + (Number.isFinite(spacing) && spacing > 0 ? `<a:spcBef><a:spcPts val="${Math.round(spacing * 100)}"/></a:spcBef>` : '')
    + (bulleted
      ? '<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>'
      : '<a:buNone/>')
    + '</a:pPr>';
  const text = String(paragraph.text ?? '');
  const run = runProperties(paragraph, defaults);
  const body = text
    ? `<a:r><a:rPr${run.attributes}>${run.children}</a:rPr>`
      + `<a:t${/^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''}>${encodeXml(text)}</a:t></a:r>`
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
  const anchorValue = ANCHOR[String(anchor || '').toLowerCase()] || '';
  const inset = ['Left', 'Top', 'Right', 'Bottom']
    .map((edge, index) => {
      const value = margins[`margin${edge}`];
      if (value == null) return '';
      return ` ${['lIns', 'tIns', 'rIns', 'bIns'][index]}="${toEmu(value)}"`;
    })
    .join('');
  const fit = autofit === 'shrink'
    ? '<a:normAutofit/>'
    : autofit === 'resize'
      ? '<a:spAutoFit/>'
      : '<a:noAutofit/>';
  const body = paragraphs.length
    ? paragraphs.map((paragraph) => paragraphXml(paragraph, defaults)).join('')
    : paragraphXml({ text: '' }, defaults);
  return `<a:bodyPr wrap="${wrap ? 'square' : 'none'}"${inset}${anchorValue ? ` anchor="${anchorValue}"` : ''}>${fit}</a:bodyPr>`
    + `<a:lstStyle/>${body}`;
}

function frame(left, top, width, height, rotation) {
  const angle = Number(rotation);
  return `<a:xfrm${Number.isFinite(angle) && angle ? ` rot="${Math.round(angle * 60_000)}"` : ''}>`
    + `<a:off x="${toEmu(left)}" y="${toEmu(top)}"/>`
    + `<a:ext cx="${Math.max(1, toEmu(width))}" cy="${Math.max(1, toEmu(height))}"/></a:xfrm>`;
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
  const fill = Object.hasOwn(properties, 'fillColor')
    ? solidFill(properties.fillColor, properties.fillTransparency) || '<a:noFill/>'
    : (textBox ? '<a:noFill/>' : '');
  const line = outline(properties) || (textBox ? '<a:ln><a:noFill/></a:ln>' : '');
  return `<p:sp><p:nvSpPr>`
    + `<p:cNvPr id="${id}" name="${encodeXml(name || `Shape ${id}`)}"/>`
    + `<p:cNvSpPr${textBox ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr>${frame(left, top, width, height, properties.rotation)}`
    + `<a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom>${fill}${line}</p:spPr>`
    + `<p:txBody>${textBody}</p:txBody></p:sp>`;
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
}) {
  return '<p:pic><p:nvPicPr>'
    + `<p:cNvPr id="${id}" name="${encodeXml(name || `Picture ${id}`)}"/>`
    + '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
    + `<p:blipFill><a:blip r:embed="${embedId}"/>${cropRectXml(crop)}<a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr>${frame(left, top, width, height)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`
    + '</p:pic>';
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
  const columnWidth = Math.max(1, Math.round(toEmu(width) / columns));
  const headerHeight = Number(properties.headerRowHeight) || 0;
  const bodyHeight = Number(properties.bodyRowHeight) || 0;
  const grid = Array.from({ length: columns }, () => `<a:gridCol w="${columnWidth}"/>`).join('');
  const headerFill = normalizeHex(properties.headerFillColor);
  const bodyFill = normalizeHex(properties.bodyFillColor);
  const body = rows.map((row, rowIndex) => {
    const header = rowIndex === 0;
    const rowHeight = header
      ? headerHeight || bodyHeight
      : bodyHeight || headerHeight;
    const cells = Array.from({ length: columns }, (_, columnIndex) => {
      const defaults = {
        fontName: properties.fontName,
        fontSize: properties.fontSize,
        color: header ? (properties.headerColor ?? properties.color) : properties.color,
        bold: header ? true : properties.bold,
      };
      const text = textBodyXml({
        paragraphs: [{ text: row[columnIndex] ?? '', align: header ? 'left' : properties.align }],
        defaults,
        anchor: 'center',
        margins: { marginLeft: 7, marginRight: 7, marginTop: 3, marginBottom: 3 },
      });
      const fill = header ? headerFill : bodyFill;
      return `<a:tc><a:txBody>${text}</a:txBody>`
        + `<a:tcPr anchor="ctr">${fill ? solidFill(fill) : ''}</a:tcPr></a:tc>`;
    }).join('');
    return `<a:tr h="${rowHeight ? toEmu(rowHeight) : Math.round(toEmu(height) / rows.length)}">${cells}</a:tr>`;
  }).join('');
  return '<p:graphicFrame><p:nvGraphicFramePr>'
    + `<p:cNvPr id="${id}" name="${encodeXml(name || `Table ${id}`)}"/>`
    + '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>'
    + `<p:xfrm><a:off x="${toEmu(left)}" y="${toEmu(top)}"/>`
    + `<a:ext cx="${Math.max(1, toEmu(width))}" cy="${Math.max(1, toEmu(height))}"/></p:xfrm>`
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">'
    + `<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${grid}</a:tblGrid>${body}</a:tbl>`
    + '</a:graphicData></a:graphic></p:graphicFrame>';
}

export function solidFillXml(color, transparency) {
  return solidFill(color, transparency);
}

export function backgroundXml(color) {
  const hex = normalizeHex(color);
  if (!hex) throw new Error('set_slide_background requires a hex color');
  return `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
}
