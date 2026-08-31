import { extname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { IMAGE_CONTENT_TYPES, addPackageRelationship, ensureContentTypeOverride, ensureDefaultContentType, imagePixelSize, partRelationshipPath, zipText } from './portable-opc.mjs';
import { docxBodyModel } from './portable-snapshot.mjs';
import { DRAWING_MAIN_NS, OFFICE_RELATIONSHIP_BASE, XML_HEADER, xmlEncode } from './portable-xml.mjs';

export const WORD_MAIN_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';


const HEADER_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml';


const FOOTER_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml';


const WORD_DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';


const PICTURE_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';


export async function addDocumentImage(zip, source) {
  const extension = extname(String(source || '')).replace(/^\./, '').toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES[extension];
  if (!contentType) {
    throw new Error(`Unsupported image type: .${extension || 'unknown'}. Use ${Object.keys(IMAGE_CONTENT_TYPES).join(', ')}`);
  }
  const data = await readFile(source);
  let ordinal = 1;
  while (zip.file(`word/media/image${ordinal}.${extension}`)) ordinal += 1;
  const part = `word/media/image${ordinal}.${extension}`;
  zip.file(part, data);
  await ensureDefaultContentType(zip, extension, contentType);
  const relationshipId = await addPackageRelationship(
    zip,
    partRelationshipPath('word/document.xml'),
    `${OFFICE_RELATIONSHIP_BASE}/image`,
    `media/image${ordinal}.${extension}`,
  );
  return { part, relationshipId, pixels: imagePixelSize(data), name: `image${ordinal}.${extension}` };
}



export function wordDrawingXml({ id, embedId, name, width, height }) {
  const cx = Math.max(1, Math.round(width * 12_700));
  const cy = Math.max(1, Math.round(height * 12_700));
  return `<w:drawing><wp:inline xmlns:wp="${WORD_DRAWING_NS}" distT="0" distB="0" distL="0" distR="0">`
    + `<wp:extent cx="${cx}" cy="${cy}"/>`
    + '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
    + `<wp:docPr id="${id}" name="${xmlEncode(name)}"/>`
    + `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${DRAWING_MAIN_NS}" noChangeAspect="1"/></wp:cNvGraphicFramePr>`
    + `<a:graphic xmlns:a="${DRAWING_MAIN_NS}"><a:graphicData uri="${PICTURE_NS}">`
    + `<pic:pic xmlns:pic="${PICTURE_NS}">`
    + `<pic:nvPicPr><pic:cNvPr id="${id}" name="${xmlEncode(name)}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip xmlns:a="${DRAWING_MAIN_NS}" r:embed="${embedId}"/>`
    + `<a:stretch xmlns:a="${DRAWING_MAIN_NS}"><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm xmlns:a="${DRAWING_MAIN_NS}"><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + `<a:prstGeom xmlns:a="${DRAWING_MAIN_NS}" prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>';
}



export function trailingSectionProperties(documentXml) {
  const model = docxBodyModel(documentXml);
  if (!model.body) throw new Error('DOCX document body is missing');
  const match = /<w:sectPr(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:sectPr>)\s*$/.exec(model.body.inner);
  return { model, match };
}



export function upsertSectionChild(sectionXml, tag, element, afterTags = []) {
  const pattern = new RegExp(`<w:${tag}\\b[^>]*\\/>`);
  if (pattern.test(sectionXml)) return sectionXml.replace(pattern, element);
  for (const anchor of afterTags) {
    const found = new RegExp(`<w:${anchor}\\b[^>]*\\/>`).exec(sectionXml);
    if (found) {
      const position = found.index + found[0].length;
      return `${sectionXml.slice(0, position)}${element}${sectionXml.slice(position)}`;
    }
  }
  const references = [...sectionXml.matchAll(/<w:(?:headerReference|footerReference)\b[^>]*\/>/g)];
  const position = references.length
    ? references.at(-1).index + references.at(-1)[0].length
    : sectionXml.indexOf('>') + 1;
  return `${sectionXml.slice(0, position)}${element}${sectionXml.slice(position)}`;
}



export function writeSectionProperties(documentXml, mutate) {
  const { model, match } = trailingSectionProperties(documentXml);
  const current = match ? match[0] : '<w:sectPr></w:sectPr>';
  const next = mutate(current);
  const inner = match
    ? `${model.body.inner.slice(0, match.index)}${next}${model.body.inner.slice(match.index + match[0].length)}`
    : `${model.body.inner}${next}`;
  return `${documentXml.slice(0, model.body.start)}${inner}${documentXml.slice(model.body.end)}`;
}



const COMMENTS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';



const COMMENTS_EXTENDED_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml';


const COMMENTS_EXTENDED_RELATIONSHIP = 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended';


export const WORD_2010_NS = 'http://schemas.microsoft.com/office/word/2010/wordml';


const WORD_2012_NS = 'http://schemas.microsoft.com/office/word/2012/wordml';



export function commentParagraphId(commentId) {
  return (0x10000000 + Number(commentId)).toString(16).toUpperCase().padStart(8, '0');
}



async function ensureCommentsExtendedPart(zip) {
  const part = 'word/commentsExtended.xml';
  const existing = await zipText(zip, part);
  if (existing) return { part, xml: existing };
  const xml = `${XML_HEADER}<w15:commentsEx xmlns:w15="${WORD_2012_NS}"></w15:commentsEx>`;
  zip.file(part, xml);
  await ensureContentTypeOverride(zip, `/${part}`, COMMENTS_EXTENDED_CONTENT_TYPE);
  await addPackageRelationship(
    zip,
    partRelationshipPath('word/document.xml'),
    COMMENTS_EXTENDED_RELATIONSHIP,
    'commentsExtended.xml',
  );
  return { part, xml };
}



export async function registerCommentThread(zip, { commentId, parentId = 0, done = false }) {
  const extended = await ensureCommentsExtendedPart(zip);
  const paraId = commentParagraphId(commentId);
  const pattern = new RegExp(`<w15:commentEx\\b[^>]*\\bw15:paraId="${paraId}"[^>]*\\/>`);
  const entry = `<w15:commentEx w15:paraId="${paraId}"`
    + `${parentId ? ` w15:paraIdParent="${commentParagraphId(parentId)}"` : ''}`
    + ` w15:done="${done ? 1 : 0}"/>`;
  const next = pattern.test(extended.xml)
    ? extended.xml.replace(pattern, entry)
    : extended.xml.replace('</w15:commentsEx>', `${entry}</w15:commentsEx>`);
  zip.file(extended.part, next);
  return paraId;
}



export async function ensureCommentsPart(zip) {
  const part = 'word/comments.xml';
  const existing = await zipText(zip, part);
  if (existing) return { part, xml: existing };
  const xml = `${XML_HEADER}<w:comments xmlns:w="${WORD_MAIN_NS}" xmlns:r="${OFFICE_RELATIONSHIP_BASE}"></w:comments>`;
  zip.file(part, xml);
  await ensureContentTypeOverride(zip, `/${part}`, COMMENTS_CONTENT_TYPE);
  await addPackageRelationship(
    zip,
    partRelationshipPath('word/document.xml'),
    `${OFFICE_RELATIONSHIP_BASE}/comments`,
    'comments.xml',
  );
  return { part, xml };
}



export function anchorDocxComment(paragraphXml, id) {
  const opening = /^<w:p(?:\s[^>]*)?>(?:<w:pPr(?:\s[^>]*)?>[\s\S]*?<\/w:pPr>)?/.exec(paragraphXml)?.[0] || '<w:p>';
  const body = paragraphXml.slice(opening.length);
  return `${opening}<w:commentRangeStart w:id="${id}"/>${body}`
    .replace(/<\/w:p>$/, `<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r></w:p>`);
}



export async function writeHeaderFooterPart(zip, { header, body }) {
  const tag = header ? 'hdr' : 'ftr';
  const prefix = header ? 'header' : 'footer';
  let ordinal = 1;
  while (zip.file(`word/${prefix}${ordinal}.xml`)) ordinal += 1;
  const part = `word/${prefix}${ordinal}.xml`;
  zip.file(part, `${XML_HEADER}<w:${tag} xmlns:w="${WORD_MAIN_NS}" xmlns:r="${OFFICE_RELATIONSHIP_BASE}">${body}</w:${tag}>`);
  await ensureContentTypeOverride(zip, `/${part}`, header ? HEADER_CONTENT_TYPE : FOOTER_CONTENT_TYPE);
  const relationshipId = await addPackageRelationship(
    zip,
    partRelationshipPath('word/document.xml'),
    `${OFFICE_RELATIONSHIP_BASE}/${prefix}`,
    `${prefix}${ordinal}.xml`,
  );
  return { part, relationshipId };
}



export function upsertSectionReference(sectionXml, tag, kind, relationshipId) {
  const element = `<w:${tag} w:type="${kind}" r:id="${relationshipId}"/>`;
  const pattern = new RegExp(`<w:${tag}\\b[^>]*\\bw:type="${kind}"[^>]*\\/>`);
  if (pattern.test(sectionXml)) return sectionXml.replace(pattern, element);
  const position = sectionXml.indexOf('>') + 1;
  return `${sectionXml.slice(0, position)}${element}${sectionXml.slice(position)}`;
}



const NUMBERING_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';



export const SETTINGS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml';


export const SETTINGS_ORDER = Object.freeze([
  'w:writeProtection', 'w:view', 'w:zoom', 'w:removePersonalInformation', 'w:removeDateAndTime',
  'w:proofState', 'w:attachedTemplate', 'w:linkStyles', 'w:stylePaneFormatFilter',
  'w:documentType', 'w:mailMerge', 'w:revisionView', 'w:trackRevisions', 'w:doNotTrackMoves',
  'w:doNotTrackFormatting', 'w:documentProtection', 'w:autoFormatOverride', 'w:styleLockTheme',
  'w:styleLockQFSet', 'w:defaultTabStop', 'w:autoHyphenation', 'w:characterSpacingControl',
  'w:compat', 'w:rsids', 'w:themeFontLang', 'w:clrSchemeMapping', 'w:decimalSymbol', 'w:listSeparator',
]);



export async function documentTracksChanges(zip) {
  return /<w:trackRevisions\b/.test(await zipText(zip, 'word/settings.xml') || '');
}



export function revisionAttributes(id, author) {
  return `w:id="${id}" w:author="${xmlEncode(author || 'Mixdog')}"`
    + ` w:date="${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}"`;
}



export function nextRevisionId(documentXml) {
  const ids = [...documentXml.matchAll(/<w:(?:ins|del)\b[^>]*\bw:id="(\d+)"/g)].map((match) => Number(match[1]));
  return Math.max(0, ...ids) + 1;
}



export function markRunsDeleted(paragraphXml, id, author) {
  const runs = [...paragraphXml.matchAll(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g)];
  if (!runs.length) return paragraphXml;
  let output = paragraphXml;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    const deleted = run[0]
      .replace(/<w:t(\s[^>]*)?>/g, (_match, attributes) => `<w:delText${attributes || ''}>`)
      .replace(/<\/w:t>/g, '</w:delText>');
    const wrapped = `<w:del ${revisionAttributes(id + index, author)}>${deleted}</w:del>`;
    output = `${output.slice(0, run.index)}${wrapped}${output.slice(run.index + run[0].length)}`;
  }
  return output;
}



function numberingDefinition(abstractId, kind) {
  const levels = [0, 1, 2].map((level) => {
    const indent = 720 * (level + 1);
    if (kind === 'bullet') {
      const marks = ['\u2022', '\u25E6', '\u25AA'];
      return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>`
        + `<w:lvlText w:val="${marks[level]}"/><w:lvlJc w:val="left"/>`
        + `<w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr>`
        + '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:hint="default"/></w:rPr></w:lvl>';
    }
    const formats = ['decimal', 'lowerLetter', 'lowerRoman'];
    return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${formats[level]}"/>`
      + `<w:lvlText w:val="%${level + 1}."/><w:lvlJc w:val="left"/>`
      + `<w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr></w:lvl>`;
  }).join('');
  return `<w:abstractNum w:abstractNumId="${abstractId}"><w:multiLevelType w:val="hybridMultilevel"/>${levels}</w:abstractNum>`;
}



export async function ensureNumbering(zip, kind) {
  const part = 'word/numbering.xml';
  let xml = await zipText(zip, part);
  if (!xml) {
    xml = `${XML_HEADER}<w:numbering xmlns:w="${WORD_MAIN_NS}"></w:numbering>`;
    await ensureContentTypeOverride(zip, `/${part}`, NUMBERING_CONTENT_TYPE);
    await addPackageRelationship(
      zip,
      partRelationshipPath('word/document.xml'),
      `${OFFICE_RELATIONSHIP_BASE}/numbering`,
      'numbering.xml',
    );
  }
  const marker = kind === 'bullet' ? 'w:numFmt w:val="bullet"' : 'w:numFmt w:val="decimal"';
  for (const match of xml.matchAll(/<w:abstractNum\b[^>]*\bw:abstractNumId="(\d+)"[^>]*>[\s\S]*?<\/w:abstractNum>/g)) {
    if (!match[0].includes(marker)) continue;
    const reuse = new RegExp(`<w:num\\b[^>]*\\bw:numId="(\\d+)"[^>]*>\\s*<w:abstractNumId w:val="${match[1]}"\\/>`).exec(xml);
    if (reuse) return { xml, numId: Number(reuse[1]), created: false };
  }
  const abstractIds = [...xml.matchAll(/\bw:abstractNumId="(\d+)"/g)].map((match) => Number(match[1]));
  const numIds = [...xml.matchAll(/<w:num\b[^>]*\bw:numId="(\d+)"/g)].map((match) => Number(match[1]));
  const abstractId = Math.max(-1, ...abstractIds) + 1;
  const numId = Math.max(0, ...numIds) + 1;
  const abstract = numberingDefinition(abstractId, kind);
  const definition = `<w:num w:numId="${numId}"><w:abstractNumId w:val="${abstractId}"/></w:num>`;
  const abstracts = [...xml.matchAll(/<w:abstractNum\b[^>]*>[\s\S]*?<\/w:abstractNum>/g)];
  const position = abstracts.length
    ? abstracts.at(-1).index + abstracts.at(-1)[0].length
    : xml.indexOf('>', xml.indexOf('<w:numbering')) + 1;
  const next = `${xml.slice(0, position)}${abstract}${xml.slice(position)}`
    .replace('</w:numbering>', `${definition}</w:numbering>`);
  zip.file(part, next);
  return { xml: next, numId, created: true };
}
