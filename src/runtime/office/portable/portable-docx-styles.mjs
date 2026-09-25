// A style as the document names it. Word writes its built-in styles under ids of its own language — Korean Word
// saves "heading 1" as w:styleId="1" and "Quote" as "a5" — and keeps the English name in w:name. Written as the
// English id alone, a Korean Word document edited here showed every heading, quote, and caption as body text.
import { zipText } from './portable-opc.mjs';
import { xmlDecode } from './portable-xml.mjs';
import { docxStyleId } from './portable-docx-xml.mjs';
import { wordStyles } from './portable-package.mjs';

const STYLES_PART = 'word/styles.xml';
const key = (value) => String(value || '').toLowerCase().replace(/\s+/g, '');

function styleEntries(stylesXml) {
  return [...String(stylesXml || '').matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)].map((match) => ({
    xml: match[0],
    type: /\bw:type="([^"]+)"/.exec(match[1])?.[1] || 'paragraph',
    id: xmlDecode(/\bw:styleId="([^"]+)"/.exec(match[1])?.[1] || ''),
    name: xmlDecode(/<w:name\s+w:val="([^"]*)"/.exec(match[2])?.[1] || ''),
  }));
}

// By the id asked for, then the English id Word's English template uses, then the style's name.
function findStyle(entries, requested, type) {
  const english = docxStyleId(requested);
  const ofType = entries.filter((entry) => entry.type === type);
  return (
    ofType.find((entry) => entry.id === requested) ||
    ofType.find((entry) => entry.id === english) ||
    ofType.find((entry) => key(entry.name) === key(requested)) ||
    ofType.find((entry) => key(entry.name) === key(english))
  );
}

/**
 * The id the document carries for a paragraph or table style asked for by name or id. A built-in style the
 * document has not defined yet (Word keeps "caption" and "Table Grid" latent until first used) is added from the
 * new-document styles under its English id, which Word reads as the built-in style by its name; found is false
 * only for a style neither defines.
 */
export async function documentStyleId(zip, requested, type = 'paragraph') {
  const wanted = String(requested || '').trim();
  if (!wanted) return { id: '', found: true };
  const styles = await zipText(zip, STYLES_PART);
  // A package without a styles part says nothing about which styles exist; its reference stands as written.
  if (!styles) return { id: docxStyleId(wanted), found: true };
  const entries = styleEntries(styles);
  const existing = findStyle(entries, wanted, type);
  if (existing) return { id: existing.id, found: true };
  const template = styleEntries(wordStyles());
  const borrowed = findStyle(template, wanted, type);
  if (!borrowed || entries.some((entry) => entry.id === borrowed.id)) {
    return { id: docxStyleId(wanted), found: false };
  }
  // The definition's own references follow the document's ids: Korean Word's Normal is "a", its Normal Table "a1".
  const definition = borrowed.xml.replace(/(<w:(?:basedOn|next|link)\s+w:val=")([^"]*)(")/g, (whole, open, ref, close) => {
    const name = template.find((entry) => entry.id === ref)?.name;
    const local = name && entries.find((entry) => key(entry.name) === key(name));
    return local ? `${open}${local.id}${close}` : whole;
  });
  zip.file(STYLES_PART, styles.replace('</w:styles>', `${definition}</w:styles>`));
  return { id: borrowed.id, found: true };
}
