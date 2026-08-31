import { join } from 'node:path';

export const OOXML_REQUIRED = {
  docx: ['[Content_Types].xml', 'word/document.xml'],
  xlsx: ['[Content_Types].xml', 'xl/workbook.xml'],
  pptx: ['[Content_Types].xml', 'ppt/presentation.xml'],
};


export const SPREADSHEET_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

export const SPREADSHEET_DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';

export const DRAWING_MAIN_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

export const OFFICE_RELATIONSHIP_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';


export function xmlDecode(value = '') {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}


export function xmlEncode(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}


export function tagPattern(tag) {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


export function textNodes(xml, tag) {
  const regex = new RegExp(`<${tagPattern(tag)}(\\s[^>]*)?>([\\s\\S]*?)</${tagPattern(tag)}>`, 'g');
  const nodes = [];
  let match;
  while ((match = regex.exec(xml))) {
    nodes.push({
      start: match.index,
      end: regex.lastIndex,
      attrs: match[1] || '',
      text: xmlDecode(match[2]),
    });
  }
  return nodes;
}


export function rebuildTextNodes(xml, tag, nodes) {
  let cursor = 0;
  const chunks = [];
  for (const node of nodes) {
    chunks.push(xml.slice(cursor, node.start));
    let attrs = node.attrs;
    if (/^\s|\s$/.test(node.text) && !/\bxml:space=/.test(attrs)) attrs += ' xml:space="preserve"';
    chunks.push(`<${tag}${attrs}>${xmlEncode(node.text)}</${tag}>`);
    cursor = node.end;
  }
  chunks.push(xml.slice(cursor));
  return chunks.join('');
}


function nodeAtOffset(nodes, offset, usePreviousAtBoundary = false) {
  let current = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const next = current + nodes[index].text.length;
    if (offset < next || (usePreviousAtBoundary && offset === next && next > current)) {
      return { index, offset: Math.max(0, offset - current) };
    }
    current = next;
  }
  return nodes.length ? { index: nodes.length - 1, offset: nodes.at(-1).text.length } : null;
}


export function replaceAcrossRuns(xml, tag, find, replacement) {
  if (!find) throw new Error('replace_text requires non-empty find');
  const nodes = textNodes(xml, tag);
  if (!nodes.length) return { xml, count: 0 };
  const joined = nodes.map((node) => node.text).join('');
  const occurrences = [];
  let cursor = 0;
  while (cursor <= joined.length - find.length) {
    const index = joined.indexOf(find, cursor);
    if (index < 0) break;
    occurrences.push(index);
    cursor = index + Math.max(1, find.length);
  }
  for (let occurrence = occurrences.length - 1; occurrence >= 0; occurrence -= 1) {
    const start = nodeAtOffset(nodes, occurrences[occurrence]);
    const end = nodeAtOffset(nodes, occurrences[occurrence] + find.length, true);
    if (!start || !end) continue;
    if (start.index === end.index) {
      const source = nodes[start.index].text;
      nodes[start.index].text = `${source.slice(0, start.offset)}${replacement}${source.slice(end.offset)}`;
      continue;
    }
    const first = nodes[start.index];
    const last = nodes[end.index];
    first.text = `${first.text.slice(0, start.offset)}${replacement}`;
    for (let index = start.index + 1; index < end.index; index += 1) nodes[index].text = '';
    last.text = last.text.slice(end.offset);
  }
  return { xml: rebuildTextNodes(xml, tag, nodes), count: occurrences.length };
}


export function paragraphTexts(xml, tag) {
  return textNodes(xml, tag).map((node) => node.text).filter(Boolean);
}


export function topLevelElements(fragment, acceptedTags) {
  const accepted = new Set(acceptedTags);
  const elements = [];
  const stack = [];
  let tracked = null;
  const regex = /<([/]?)([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?([/]?)>/g;
  let match;
  while ((match = regex.exec(fragment))) {
    const closing = match[1] === '/';
    const name = match[2];
    const selfClosing = match[3] === '/';
    if (closing) {
      const opened = stack.pop();
      if (tracked && stack.length === 0 && opened === tracked.name) {
        elements.push({
          name: tracked.name,
          start: tracked.start,
          end: regex.lastIndex,
          xml: fragment.slice(tracked.start, regex.lastIndex),
        });
        tracked = null;
      }
      continue;
    }
    if (stack.length === 0 && accepted.has(name)) {
      if (selfClosing) {
        elements.push({ name, start: match.index, end: regex.lastIndex, xml: match[0] });
      } else {
        tracked = { name, start: match.index };
      }
    }
    if (!selfClosing) stack.push(name);
  }
  return elements;
}


export function containerInner(xml, tag, from = 0) {
  const opener = new RegExp(`<${tagPattern(tag)}(?:\\s[^>]*?)?(/?)>`, 'g');
  opener.lastIndex = from;
  let open = opener.exec(xml);
  while (open && open[1] === '/') open = opener.exec(xml);
  if (!open) return null;
  const scanner = new RegExp(`<${tagPattern(tag)}(?:\\s[^>]*?)?(/?)>|</${tagPattern(tag)}>`, 'g');
  scanner.lastIndex = open.index + open[0].length;
  let depth = 1;
  let match;
  while ((match = scanner.exec(xml))) {
    if (match[0].startsWith('</')) {
      depth -= 1;
      if (depth > 0) continue;
      const start = open.index + open[0].length;
      return { start, end: match.index, inner: xml.slice(start, match.index) };
    }
    if (match[1] !== '/') depth += 1;
  }
  return null;
}


export function setXmlAttribute(attributes, name, value) {
  const pattern = new RegExp(`\\b${name}="[^"]*"`, 'i');
  return pattern.test(attributes)
    ? attributes.replace(pattern, `${name}="${value}"`)
    : `${attributes} ${name}="${value}"`;
}


export function elementSpans(fragment, tag) {
  const spans = [];
  const regex = new RegExp(`<${tagPattern(tag)}\\b([^>]*?)(\\/>|>[\\s\\S]*?<\\/${tagPattern(tag)}>)`, 'g');
  let match;
  while ((match = regex.exec(fragment))) {
    spans.push({
      start: match.index,
      end: regex.lastIndex,
      attrs: match[1],
      xml: match[0],
    });
  }
  return spans;
}


export function containerBody(xml, tag) {
  if (xml.endsWith('/>')) return '';
  return xml.slice(xml.indexOf('>') + 1, xml.lastIndexOf(`</${tag}>`));
}


export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';


export function upsertOrderedChild(xml, order, tag, element) {
  const pattern = new RegExp(`<${tagPattern(tag)}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${tagPattern(tag)}>)`);
  const stripped = xml.replace(pattern, '');
  if (!element) return stripped;
  for (const candidate of order.slice(order.indexOf(tag) + 1)) {
    const found = new RegExp(`<${tagPattern(candidate)}\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${tagPattern(candidate)}>)`).exec(stripped);
    if (found) return `${stripped.slice(0, found.index)}${element}${stripped.slice(found.index)}`;
  }
  return stripped.replace(/<\/[A-Za-z:]+>\s*$/, (close) => `${element}${close}`);
}


export function xmlAttribute(attributes, name) {
  return new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(attributes)?.[1] || '';
}
