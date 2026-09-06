import { xmlEncode } from './portable-xml.mjs';

const SECTION_ORDER = Object.freeze([
  'numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs',
  'cellStyles', 'dxfs', 'tableStyles', 'colors', 'extLst',
]);
const EDITED_SECTIONS = Object.freeze(['numFmts', 'fonts', 'fills', 'borders', 'cellXfs']);
const FIRST_CUSTOM_NUMBER_FORMAT = 164;

const HORIZONTAL = Object.freeze({
  left: 'left',
  center: 'center',
  centre: 'center',
  right: 'right',
  justify: 'justify',
  fill: 'fill',
  distributed: 'distributed',
  general: 'general',
});
const VERTICAL = Object.freeze({
  top: 'top',
  center: 'center',
  centre: 'center',
  middle: 'center',
  bottom: 'bottom',
  justify: 'justify',
  distributed: 'distributed',
});

function decode(value = '') {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function sectionMatch(xml, name) {
  return new RegExp(`<${name}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${name}>)`).exec(xml);
}

function sectionBody(elementXml, name) {
  if (!elementXml || elementXml.endsWith('/>')) return '';
  return elementXml.slice(elementXml.indexOf('>') + 1, elementXml.lastIndexOf(`</${name}>`));
}

function childElements(body, name) {
  const items = [];
  const regex = new RegExp(`<${name}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${name}>)`, 'g');
  let match;
  while ((match = regex.exec(body))) items.push(match[0]);
  return items;
}

function collection(xml, container, item) {
  const found = sectionMatch(xml, container);
  return found ? childElements(sectionBody(found[0], container), item) : [];
}

function attribute(source, name) {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(source || '')?.[1] ?? '';
}

function flag(xml, tag) {
  const match = new RegExp(`<${tag}(\\s[^>]*?)?/>`).exec(xml);
  if (!match) return false;
  const value = attribute(match[1] || '', 'val');
  return value === '' || value === '1' || value === 'true';
}

export function normalizeColor(value) {
  const raw = String(value || '').trim().replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{8}$/.test(raw)) return raw;
  if (/^[0-9A-F]{6}$/.test(raw)) return `FF${raw}`;
  if (/^[0-9A-F]{3}$/.test(raw)) return `FF${raw.split('').map((digit) => `${digit}${digit}`).join('')}`;
  return '';
}

function parseFont(xml) {
  return {
    bold: flag(xml, 'b'),
    italic: flag(xml, 'i'),
    size: Number(attribute(/<sz\b([^>]*?)\/>/.exec(xml)?.[1], 'val')) || 11,
    color: normalizeColor(attribute(/<color\b([^>]*?)\/>/.exec(xml)?.[1], 'rgb')),
    name: decode(attribute(/<name\b([^>]*?)\/>/.exec(xml)?.[1], 'val')) || 'Calibri',
  };
}

function buildFont(font) {
  return '<font>'
    + (font.bold ? '<b/>' : '')
    + (font.italic ? '<i/>' : '')
    + `<sz val="${font.size}"/>`
    + (font.color ? `<color rgb="${font.color}"/>` : '')
    + `<name val="${xmlEncode(font.name)}"/><family val="2"/>`
    + '</font>';
}

function parseFill(xml) {
  const pattern = /<patternFill\b([^>]*?)(?:\/>|>[\s\S]*?<\/patternFill>)/.exec(xml);
  if (!pattern || attribute(pattern[1], 'patternType') !== 'solid') return '';
  return normalizeColor(attribute(/<fgColor\b([^>]*?)\/>/.exec(pattern[0])?.[1], 'rgb'));
}

function buildFill(color) {
  return color
    ? `<fill><patternFill patternType="solid"><fgColor rgb="${color}"/><bgColor indexed="64"/></patternFill></fill>`
    : '<fill><patternFill patternType="none"/></fill>';
}

function parseXf(xml) {
  const attrs = /^<xf\b([^>]*?)(?:\/>|>)/.exec(xml)?.[1] || '';
  const alignment = /<alignment\b([^>]*?)\/?>/.exec(xml)?.[1] || '';
  return {
    numFmtId: Number(attribute(attrs, 'numFmtId')) || 0,
    fontId: Number(attribute(attrs, 'fontId')) || 0,
    fillId: Number(attribute(attrs, 'fillId')) || 0,
    borderId: Number(attribute(attrs, 'borderId')) || 0,
    xfId: Number(attribute(attrs, 'xfId')) || 0,
    horizontal: attribute(alignment, 'horizontal'),
    vertical: attribute(alignment, 'vertical'),
    wrapText: attribute(alignment, 'wrapText') === '1',
  };
}

function buildXf(xf) {
  const aligned = Boolean(xf.horizontal || xf.vertical || xf.wrapText);
  const alignment = aligned
    ? `<alignment${xf.horizontal ? ` horizontal="${xf.horizontal}"` : ''}`
      + `${xf.vertical ? ` vertical="${xf.vertical}"` : ''}`
      + `${xf.wrapText ? ' wrapText="1"' : ''}/>`
    : '';
  const head = `<xf numFmtId="${xf.numFmtId}" fontId="${xf.fontId}" fillId="${xf.fillId}"`
    + ` borderId="${xf.borderId}" xfId="${xf.xfId}"`
    + `${xf.numFmtId ? ' applyNumberFormat="1"' : ''}`
    + `${xf.fontId ? ' applyFont="1"' : ''}`
    + `${xf.fillId ? ' applyFill="1"' : ''}`
    + `${xf.borderId ? ' applyBorder="1"' : ''}`
    + `${aligned ? ' applyAlignment="1"' : ''}`;
  return aligned ? `${head}>${alignment}</xf>` : `${head}/>`;
}

function register(items, candidate) {
  const found = items.indexOf(candidate);
  if (found >= 0) return found;
  items.push(candidate);
  return items.length - 1;
}

function registerNumberFormat(numFmts, code) {
  const normalized = String(code || '').trim();
  if (!normalized || normalized.toLowerCase() === 'general') return 0;
  for (const entry of numFmts) {
    if (decode(attribute(entry, 'formatCode')) === normalized) return Number(attribute(entry, 'numFmtId')) || 0;
  }
  const used = numFmts.map((entry) => Number(attribute(entry, 'numFmtId')) || 0);
  const id = Math.max(FIRST_CUSTOM_NUMBER_FORMAT - 1, ...used) + 1;
  numFmts.push(`<numFmt numFmtId="${id}" formatCode="${xmlEncode(normalized)}"/>`);
  return id;
}

function serialize(xml, sections) {
  const root = /^([\s\S]*?<styleSheet\b[^>]*>)/.exec(xml);
  if (!root) throw new Error('Workbook styles are missing a styleSheet root');
  const counted = new Set(['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles', 'dxfs']);
  const body = SECTION_ORDER.map((name) => {
    const items = sections[name];
    if (Array.isArray(items)) {
      if (!items.length) return '';
      return `<${name}${counted.has(name) ? ` count="${items.length}"` : ''}>${items.join('')}</${name}>`;
    }
    return items || '';
  }).join('');
  return `${root[1]}${body}</styleSheet>`;
}

function parseStyleSheet(xml) {
  const sections = {
    numFmts: collection(xml, 'numFmts', 'numFmt'),
    fonts: collection(xml, 'fonts', 'font'),
    fills: collection(xml, 'fills', 'fill'),
    borders: collection(xml, 'borders', 'border'),
    cellXfs: collection(xml, 'cellXfs', 'xf'),
  };
  for (const name of SECTION_ORDER) {
    if (EDITED_SECTIONS.includes(name)) continue;
    sections[name] = sectionMatch(xml, name)?.[0] || '';
  }
  if (!sections.fonts.length) sections.fonts.push('<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>');
  if (!sections.fills.length) sections.fills.push(buildFill(''), '<fill><patternFill patternType="gray125"/></fill>');
  if (!sections.borders.length) sections.borders.push('<border><left/><right/><top/><bottom/><diagonal/></border>');
  if (!sections.cellXfs.length) sections.cellXfs.push('<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>');
  return sections;
}

export function applyCellStyle(stylesXml, baseIndex, properties = {}) {
  const sections = parseStyleSheet(stylesXml);
  const base = parseXf(sections.cellXfs[Number(baseIndex) || 0] || sections.cellXfs[0]);
  const font = parseFont(sections.fonts[base.fontId] || sections.fonts[0]);
  const fill = parseFill(sections.fills[base.fillId] || '');
  const next = { ...base };

  const fontColor = Object.hasOwn(properties, 'color') ? normalizeColor(properties.color) : font.color;
  const nextFont = {
    bold: Object.hasOwn(properties, 'bold') ? properties.bold === true : font.bold,
    italic: Object.hasOwn(properties, 'italic') ? properties.italic === true : font.italic,
    size: Number(properties.fontSize) > 0 ? Number(properties.fontSize) : font.size,
    color: fontColor,
    name: properties.fontName ? String(properties.fontName) : font.name,
  };
  next.fontId = register(sections.fonts, buildFont(nextFont));

  if (Object.hasOwn(properties, 'fillColor')) {
    const color = normalizeColor(properties.fillColor);
    next.fillId = color ? register(sections.fills, buildFill(color)) : 0;
  } else if (fill) {
    next.fillId = register(sections.fills, buildFill(fill));
  }

  if (Object.hasOwn(properties, 'numberFormat')) {
    next.numFmtId = registerNumberFormat(sections.numFmts, properties.numberFormat);
  }
  if (Object.hasOwn(properties, 'horizontalAlignment')) {
    next.horizontal = HORIZONTAL[String(properties.horizontalAlignment).toLowerCase()] || '';
  }
  if (Object.hasOwn(properties, 'verticalAlignment')) {
    next.vertical = VERTICAL[String(properties.verticalAlignment).toLowerCase()] || '';
  }
  if (Object.hasOwn(properties, 'wrapText')) next.wrapText = properties.wrapText === true;

  const index = register(sections.cellXfs, buildXf(next));
  return { xml: serialize(stylesXml, sections), index };
}

// Implicit number formats (ECMA-376 §18.8.30); a workbook never writes these
// into numFmts, so a cell carrying one reads back as its id alone.
const BUILT_IN_NUMBER_FORMATS = Object.freeze({
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
  9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'mm-dd-yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yy h:mm',
  37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
});

// Excel reports a cell's colors as BGR integers (black font 0, no fill
// 16777215) and its number format as General on every cell; the portable
// snapshot reports RRGGBB and omits defaults. One shape for both readers.
export function normalizeExcelCellStyle(style) {
  if (!style || typeof style !== 'object') return style;
  const hex = (value, blank) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return normalizeColor(value).slice(-6) || '';
    const number = Math.max(0, Math.round(value));
    if (number === blank) return '';
    return [number & 0xff, (number >> 8) & 0xff, (number >> 16) & 0xff]
      .map((channel) => channel.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  };
  const color = hex(style.color, 0);
  const fillColor = hex(style.fillColor, 16777215);
  const numberFormat = String(style.numberFormat || '').trim();
  // A localized Excel reports the General format in its own language
  // (Korean G/표준, Japanese G/標準, German Standard); none is a format.
  const general = /^(?:general|g\/표준|g\/標準|standard|standaard|général|generale|estándar|padrão|общий|常规|通用格式)$/i.test(numberFormat);
  const { color: _color, fillColor: _fill, numberFormat: _format, bold, italic, ...rest } = style;
  return {
    ...rest,
    ...(bold === true ? { bold: true } : {}),
    ...(italic === true ? { italic: true } : {}),
    ...(numberFormat && !general ? { numberFormat } : {}),
    ...(color && color !== '000000' ? { color } : {}),
    ...(fillColor && fillColor !== 'FFFFFF' ? { fillColor } : {}),
  };
}

// The cell-style table (cellXfs index → resolved style) a snapshot attaches to
// each styled cell, so a reader can see number formats, input colors, and
// fills without Excel. Colors are RRGGBB; theme colors are not resolved.
export function resolveCellStyles(stylesXml) {
  if (!stylesXml) return [];
  const sections = parseStyleSheet(stylesXml);
  const numberFormats = new Map();
  for (const entry of sections.numFmts) {
    numberFormats.set(Number(attribute(entry, 'numFmtId')) || 0, decode(attribute(entry, 'formatCode')));
  }
  return sections.cellXfs.map((xfXml) => {
    const xf = parseXf(xfXml);
    const font = parseFont(sections.fonts[xf.fontId] || sections.fonts[0]);
    const fill = parseFill(sections.fills[xf.fillId] || '');
    const numberFormat = numberFormats.get(xf.numFmtId) ?? BUILT_IN_NUMBER_FORMATS[xf.numFmtId] ?? 'General';
    return {
      ...(numberFormat !== 'General' ? { numberFormat } : {}),
      fontName: font.name,
      fontSize: font.size,
      ...(font.bold ? { bold: true } : {}),
      ...(font.italic ? { italic: true } : {}),
      ...(font.color ? { color: font.color.slice(-6) } : {}),
      ...(fill ? { fillColor: fill.slice(-6) } : {}),
      ...(xf.horizontal ? { horizontalAlignment: xf.horizontal } : {}),
    };
  });
}
