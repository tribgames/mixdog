import { join } from 'node:path';
import { backgroundXml, shapeXml, solidFillXml, toEmu } from './portable-slide-shapes.mjs';
import { zipText } from './portable-opc.mjs';
import { containerBody, containerInner, elementSpans, rebuildTextNodes, textNodes, topLevelElements, xmlAttribute, xmlDecode, xmlEncode } from './portable-xml.mjs';
import { presentationSlides } from './portable-pptx-package.mjs';

export function balancedInner(xml, from, tag) {
  const opener = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g');
  opener.lastIndex = from;
  const open = opener.exec(xml);
  if (!open) return null;
  const scanner = new RegExp(`<${tag}(?:\\s[^>]*)?>|</${tag}>`, 'g');
  scanner.lastIndex = open.index + open[0].length;
  let depth = 1;
  let match;
  while ((match = scanner.exec(xml))) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth !== 0) continue;
    const start = open.index + open[0].length;
    return { start, end: match.index, inner: xml.slice(start, match.index) };
  }
  return null;
}




export const DEFAULT_TEXT_INSETS = Object.freeze({ left: 7.2, top: 3.6, right: 7.2, bottom: 3.6 });





export function shapeParagraphs(shapeXml) {
  const paragraphs = [];
  for (const match of shapeXml.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)) {
    const block = match[0];
    const text = [...block.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
      .map((node) => xmlDecode(node[1]))
      .join('');
    const runElement = /<a:rPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:rPr>)/.exec(block)?.[0] || '';
    const runProperties = /^<a:rPr\b([^>]*?)(?:\/>|>)/.exec(runElement)?.[1] || '';
    const size = Number(xmlAttribute(runProperties, 'sz'));
    if (!Number.isFinite(size) || size <= 0) return null;
    const lineSpacingPct = Number(/<a:lnSpc>\s*<a:spcPct\b[^>]*\bval="(\d+)"/.exec(block)?.[1] || 0);
    const spaceAfter = Number(/<a:spcAft>\s*<a:spcPts\b[^>]*\bval="(\d+)"/.exec(block)?.[1] || 0) / 100;
    const spaceBefore = Number(/<a:spcBef>\s*<a:spcPts\b[^>]*\bval="(\d+)"/.exec(block)?.[1] || 0) / 100;
    paragraphs.push({
      text,
      ...(lineSpacingPct > 0 ? { lineSpacing: lineSpacingPct / 100_000 } : {}),
      ...(spaceAfter > 0 ? { spaceAfter } : {}),
      ...(spaceBefore > 0 ? { spaceBefore } : {}),
      fontSize: size / 100,
      bold: xmlAttribute(runProperties, 'b') === '1',
      italic: xmlAttribute(runProperties, 'i') === '1',
      color: /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(runElement)?.[1] || '',
      fontName: /<a:latin\b[^>]*\btypeface="([^"]*)"/.exec(block)?.[1] || 'Calibri',
    });
  }
  return paragraphs;
}





export async function inspectPptxTextBoxes(zip) {
  const slides = await presentationSlides(zip);
  const presentation = await zipText(zip, 'ppt/presentation.xml');
  const size = /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(presentation);
  const boxes = [];
  const content = [];
  for (let index = 0; index < slides.length; index += 1) {
    const xml = await zipText(zip, slides[index].path);
    const slideBackground = /<p:bg>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(xml)?.[1] || '';
    const tree = containerInner(xml, 'p:spTree');
    if (!tree) continue;
    const shapes = topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);
    const painted = [];
    for (let shapeIndex = 0; shapeIndex < shapes.length; shapeIndex += 1) {
      const shape = shapes[shapeIndex];
      const offset = /<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/.exec(shape.xml);
      const extent = /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(shape.xml);
      if (!offset || !extent) continue;
      const bounds = {
        left: Number(offset[1]) / 12_700,
        top: Number(offset[2]) / 12_700,
        width: Number(extent[1]) / 12_700,
        height: Number(extent[2]) / 12_700,
      };
      if (shape.name !== 'p:sp') {
        content.push({ slide: index + 1, shape: shapeIndex + 1, kind: shape.name, ...bounds });
        continue;
      }
      const ownFill = /<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"/
        .exec(containerInner(shape.xml, 'p:spPr')?.inner || '')?.[1] || '';
      if (ownFill) painted.push({ ...bounds, color: ownFill });
      const paragraphs = shapeParagraphs(shape.xml);
      const hasText = Boolean(paragraphs?.length)
        && paragraphs.some((paragraph) => String(paragraph.text || '').trim());
      if (ownFill || hasText) {
        content.push({ slide: index + 1, shape: shapeIndex + 1, kind: 'p:sp', ...bounds });
      }
      if (!paragraphs?.length) continue;
      const covering = [...painted].reverse().find((entry) => (
        entry.color !== ownFill
        && entry.left <= bounds.left + 1
        && entry.top <= bounds.top + 1
        && entry.left + entry.width >= bounds.left + bounds.width - 1
        && entry.top + entry.height >= bounds.top + bounds.height - 1
      ));
      const bodyProperties = /<a:bodyPr\b([^>]*?)\/?>/.exec(shape.xml)?.[1] || '';
      const inset = (name, fallback) => {
        const value = Number(xmlAttribute(bodyProperties, name));
        return Number.isFinite(value) ? value / 12_700 : fallback;
      };
      boxes.push({
        slide: index + 1,
        shape: shapeIndex + 1,
        left: Number(offset[1]) / 12_700,
        top: Number(offset[2]) / 12_700,
        width: Number(extent[1]) / 12_700,
        height: Number(extent[2]) / 12_700,
        insetLeft: inset('lIns', DEFAULT_TEXT_INSETS.left),
        insetTop: inset('tIns', DEFAULT_TEXT_INSETS.top),
        insetRight: inset('rIns', DEFAULT_TEXT_INSETS.right),
        insetBottom: inset('bIns', DEFAULT_TEXT_INSETS.bottom),
        wrap: xmlAttribute(bodyProperties, 'wrap') !== 'none',
        autofit: /<a:normAutofit\b/.test(shape.xml) || /<a:spAutoFit\b/.test(shape.xml),
        background: ownFill || covering?.color || slideBackground,
        paragraphs,
      });
    }
  }
  return {
    boxes,
    content,
    slideWidth: size ? Number(size[1]) / 12_700 : 0,
    slideHeight: size ? Number(size[2]) / 12_700 : 0,
  };
}





export function setTableCellText(cell, text) {
  const value = String(text ?? '');
  const nodes = textNodes(cell, 'a:t');
  if (nodes.length) {
    nodes[0].text = value;
    for (let index = 1; index < nodes.length; index += 1) nodes[index].text = '';
    return rebuildTextNodes(cell, 'a:t', nodes);
  }
  const run = `<a:r><a:rPr lang="en-US" dirty="0"/>`
    + `<a:t${/^\s|\s$/.test(value) ? ' xml:space="preserve"' : ''}>${xmlEncode(value)}</a:t></a:r>`;
  const paragraph = /<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/.exec(cell);
  if (paragraph) {
    const replaced = paragraph[0].replace(/<\/a:p>$/, `${run}</a:p>`);
    return `${cell.slice(0, paragraph.index)}${replaced}${cell.slice(paragraph.index + paragraph[0].length)}`;
  }
  if (!/<\/a:txBody>/.test(cell)) throw new Error('PPTX table cell has no text body');
  return cell.replace('</a:txBody>', `<a:p>${run}</a:p></a:txBody>`);
}





export function setTableValues(shapeXml, values) {
  const table = containerInner(shapeXml, 'a:tbl');
  if (!table) throw new Error('PPTX shape does not contain a table');
  const rows = elementSpans(table.inner, 'a:tr');
  if (!rows.length) throw new Error('PPTX table has no rows');
  let inner = table.inner;
  let filledRows = 0;
  let filledCells = 0;
  let removedRows = 0;
  for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const row = rows[rowIndex];
    const source = values[rowIndex];
    if (!Array.isArray(source)) {
      if (rowIndex >= values.length) {
        inner = `${inner.slice(0, row.start)}${inner.slice(row.end)}`;
        removedRows += 1;
      }
      continue;
    }
    const cells = elementSpans(containerBody(row.xml, 'a:tr'), 'a:tc');
    let body = containerBody(row.xml, 'a:tr');
    for (let cellIndex = cells.length - 1; cellIndex >= 0; cellIndex -= 1) {
      const cell = cells[cellIndex];
      const text = cellIndex < source.length ? source[cellIndex] : '';
      body = `${body.slice(0, cell.start)}${setTableCellText(cell.xml, text)}${body.slice(cell.end)}`;
      filledCells += 1;
    }
    const attrs = /^<a:tr\b([^>]*?)(?:\/>|>)/.exec(row.xml)?.[1] || '';
    inner = `${inner.slice(0, row.start)}<a:tr${attrs}>${body}</a:tr>${inner.slice(row.end)}`;
    filledRows += 1;
  }
  return {
    xml: `${shapeXml.slice(0, table.start)}${inner}${shapeXml.slice(table.end)}`,
    rows: filledRows,
    cells: filledCells,
    capacity: rows.length,
    ...(removedRows ? { removedRows } : {}),
  };
}





export function shapeFrame(shapeXml) {
  const offset = /<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/.exec(shapeXml);
  const extent = /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(shapeXml);
  if (!offset || !extent) return null;
  return {
    left: Number(offset[1]) / 12_700,
    top: Number(offset[2]) / 12_700,
    width: Number(extent[1]) / 12_700,
    height: Number(extent[2]) / 12_700,
  };
}





export async function presentationSlideSize(zip) {
  const presentation = await zipText(zip, 'ppt/presentation.xml');
  const size = /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(presentation);
  return {
    width: size ? Number(size[1]) / 12_700 : 960,
    height: size ? Number(size[2]) / 12_700 : 540,
  };
}





export function selectedShapeSpans(tree, numbers) {
  const shapes = topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);
  const selected = [];
  for (const number of numbers) {
    const shape = shapes[Number(number) - 1];
    if (!shape) throw new Error(`PPTX shape ${number} not found`);
    selected.push(shape);
  }
  return { shapes, selected };
}





export function writeShapeTree(slideXml, tree, shapes) {
  return `${slideXml.slice(0, tree.start)}${shapes.join('')}${slideXml.slice(tree.end)}`;
}





export function appendSlideShape(xml, shape) {
  if (!/<\/p:spTree>/.test(xml)) throw new Error('PPTX slide shape tree is missing');
  return xml.replace('</p:spTree>', `${shape}</p:spTree>`);
}





export function setSlideBackground(xml, color) {
  const background = backgroundXml(color);
  const existing = /<p:bg\b[^>]*?(?:\/>|>[\s\S]*?<\/p:bg>)/.exec(xml);
  if (existing) {
    return `${xml.slice(0, existing.index)}${background}${xml.slice(existing.index + existing[0].length)}`;
  }
  const common = /<p:cSld\b[^>]*?>/.exec(xml);
  if (!common) throw new Error('PPTX slide is missing its common slide data');
  const position = common.index + common[0].length;
  return `${xml.slice(0, position)}${background}${xml.slice(position)}`;
}





export function updateShapeGeometry(shape, properties) {
  let next = shape;
  if (['left', 'top', 'width', 'height', 'rotation'].some((key) => properties[key] != null)) {
    const current = /<a:xfrm\b[^>]*?(?:\/>|>[\s\S]*?<\/a:xfrm>)/.exec(next);
    const offset = current ? /<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/.exec(current[0]) : null;
    const extent = current ? /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(current[0]) : null;
    const rotation = properties.rotation != null
      ? Math.round(Number(properties.rotation) * 60_000)
      : Number(current ? xmlAttribute(current[0], 'rot') : 0) || 0;
    const frame = `<a:xfrm${rotation ? ` rot="${rotation}"` : ''}>`
      + `<a:off x="${properties.left != null ? toEmu(properties.left) : Number(offset?.[1] || 0)}"`
      + ` y="${properties.top != null ? toEmu(properties.top) : Number(offset?.[2] || 0)}"/>`
      + `<a:ext cx="${properties.width != null ? toEmu(properties.width) : Number(extent?.[1] || 1)}"`
      + ` cy="${properties.height != null ? toEmu(properties.height) : Number(extent?.[2] || 1)}"/></a:xfrm>`;
    next = current
      ? `${next.slice(0, current.index)}${frame}${next.slice(current.index + current[0].length)}`
      : next.replace(/<p:spPr(?:\s[^>]*)?>/, `$&${frame}`);
  }
  if (properties.fillColor != null) {
    const shapeProperties = containerInner(next, 'p:spPr');
    const fill = solidFillXml(properties.fillColor, properties.fillTransparency);
    if (shapeProperties && fill) {
      const cleaned = shapeProperties.inner
        .replace(/<a:solidFill\b[^>]*?(?:\/>|>[\s\S]*?<\/a:solidFill>)/, '')
        .replace(/<a:noFill\s*\/>/, '');
      const geometry = /<a:prstGeom\b[^>]*?(?:\/>|>[\s\S]*?<\/a:prstGeom>)/.exec(cleaned);
      const position = geometry ? geometry.index + geometry[0].length : cleaned.length;
      const inner = `${cleaned.slice(0, position)}${fill}${cleaned.slice(position)}`;
      next = `${next.slice(0, shapeProperties.start)}${inner}${next.slice(shapeProperties.end)}`;
    }
  }
  return next;
}





export function nextShapeId(xml) {
  const ids = [...xml.matchAll(/\bcNvPr\s+id="(\d+)"/g)].map((match) => Number(match[1]));
  return Math.max(1, ...ids) + 1;
}
