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
