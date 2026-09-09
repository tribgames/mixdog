import { topLevelElements, xmlEncode, xmlDecode } from './portable-xml.mjs';
import { paragraphFormatXml, wordRunProperties } from './portable-docx-xml.mjs';

const ORDERS = {
  pPr: 'pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers pBdr shd tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr sectPr pPrChange'.split(' '),
  rPr: 'rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath rPrChange'.split(' '),
};

function elements(xml) {
  const names = [...xml.matchAll(/<([A-Za-z_][\w:.-]*)\b/g)].map((match) => match[1]);
  return topLevelElements(xml, names);
}

function attributes(xml) {
  return new Map([...xml.matchAll(/([\w:]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
}

function mergeAttributes(previous, patch, name) {
  const values = attributes(previous.split('>')[0]);
  const updates = attributes(patch.split('>')[0]);
  if (name === 'w:rFonts') {
    for (const slot of ['ascii', 'hAnsi', 'eastAsia', 'cs']) {
      if (updates.has(`w:${slot}`)) values.delete(`w:${slot === 'cs' ? 'cstheme' : `${slot}Theme`}`);
    }
  }
  for (const [key, value] of updates) values.set(key, value);
  return `<${name}${[...values].map(([key, value]) => ` ${key}="${value}"`).join('')}/>`;
}

/** Patch only supplied properties; preserve unrelated settings and revision metadata. */
export function patchWordFormat(xml, owner, tag, patch) {
  if (!patch) return xml;
  const open = new RegExp(`^<w:${owner}(?:\\s[^>]*)?>`).exec(xml)?.[0];
  if (!open) throw new Error(`Missing Word ${owner} element`);
  const children = elements(xml.slice(open.length, xml.lastIndexOf(`</w:${owner}>`)));
  const existing = children.find((child) => child.name === `w:${tag}`);
  const inner = existing?.xml.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>$/, '') || '';
  const entries = elements(inner).map((entry) => ({ name: entry.name, xml: entry.xml }));
  const order = ORDERS[tag] || [];
  for (const entry of elements(patch)) {
    const index = entries.findIndex((value) => value.name === entry.name);
    const value = index >= 0 && ['w:spacing', 'w:rFonts', 'w:lang', 'w:ind'].includes(entry.name)
      ? mergeAttributes(entries[index].xml, entry.xml, entry.name)
      : entry.xml;
    if (index >= 0) entries[index].xml = value;
    else {
      const rank = order.indexOf(entry.name.slice(2));
      const next = rank < 0 ? -1 : entries.findIndex((item) => order.indexOf(item.name.slice(2)) > rank);
      entries.splice(next < 0 ? entries.length : next, 0, { name: entry.name, xml: value });
    }
  }
  const properties = `<w:${tag}>${entries.map((entry) => entry.xml).join('')}</w:${tag}>`;
  if (!existing) return open + properties + xml.slice(open.length);
  const start = open.length + existing.start;
  return xml.slice(0, start) + properties + xml.slice(open.length + existing.end);
}

export function patchParagraphFormat(xml, properties, numbering = null) {
  return patchWordFormat(xml, 'p', 'pPr', paragraphFormatXml(properties, numbering));
}

/** Search the first body phrase, across text runs, without touching headers or footers.
 *  Only matching characters change; fields, drawings and breaks are search barriers. */
export function formatFirstBodyPhrase(documentXml, find, properties) {
  if (!find || find.includes('\0')) throw new Error('set_font requires non-empty searchable text');
  const patch = wordRunProperties(properties);
  if (!patch) throw new Error('set_font requires at least one font property');
  let matched = false;
  let changed = false;
  const xml = documentXml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
    if (matched) return paragraph;
    const runs = [...paragraph.matchAll(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g)].map((match) => {
      const open = /^<w:r(?:\s[^>]*)?>/.exec(match[0])[0];
      const inner = match[0].slice(open.length, -6);
      const rPr = /^\s*(?:<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>|<w:rPr\s*\/>)/.exec(inner)?.[0] || '';
      const content = inner.slice(rPr.length);
      const textOnly = /^(?:\s*<w:t\b[^>]*>[\s\S]*?<\/w:t>\s*)+$/.test(content);
      return {
        start: match.index, end: match.index + match[0].length, xml: match[0], open, rPr,
        text: textOnly ? [...content.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => xmlDecode(m[1])).join('') : '\0',
      };
    });
    const joined = runs.map((run) => run.text).join('');
    const start = joined.indexOf(find);
    if (start < 0) return paragraph;
    matched = true;
    const end = start + find.length;
    let offset = 0;
    let cursor = 0;
    let result = '';
    const textRun = (run, text) => `${run.open}${run.rPr}<w:t xml:space="preserve">${xmlEncode(text)}</w:t></w:r>`;
    for (const run of runs) {
      result += paragraph.slice(cursor, run.start);
      cursor = run.end;
      const from = Math.max(0, start - offset);
      const to = Math.min(run.text.length, end - offset);
      offset += run.text.length;
      if (to <= from) { result += run.xml; continue; }
      const updated = patchWordFormat(run.xml, 'r', 'rPr', patch);
      if (updated === run.xml) { result += run.xml; continue; }
      changed = true;
      if (from) result += textRun(run, run.text.slice(0, from));
      result += patchWordFormat(textRun(run, run.text.slice(from, to)), 'r', 'rPr', patch);
      if (to < run.text.length) result += textRun(run, run.text.slice(to));
    }
    return result + paragraph.slice(cursor);
  });
  if (!matched) throw new Error(`Font target not found in document body: ${find}`);
  return { xml, changed };
}
