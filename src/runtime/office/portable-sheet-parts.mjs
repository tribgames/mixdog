import { dirname, join, posix } from 'node:path';
import { columnNumber, parseCellRef } from './portable-cells.mjs';
import { addPackageRelationship, ensureContentTypeOverride, ensureDefaultContentType, partRelationshipPath, zipText } from './portable-opc.mjs';
import { DRAWING_MAIN_NS, OFFICE_RELATIONSHIP_BASE, SPREADSHEET_DRAWING_NS, SPREADSHEET_MAIN, XML_HEADER, xmlDecode, xmlEncode } from './portable-xml.mjs';
import { upsertWorksheetSection } from './portable-sheet-xml.mjs';

export function excelPasswordHash(password) {
  const text = String(password ?? '');
  let hash = 0;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    hash = ((hash >> 14) & 0x01) | ((hash << 1) & 0x7fff);
    hash ^= text.charCodeAt(index);
  }
  hash = ((hash >> 14) & 0x01) | ((hash << 1) & 0x7fff);
  hash ^= text.length;
  hash ^= 0xCE4B;
  return hash.toString(16).toUpperCase().padStart(4, '0');
}



export async function ensureWorksheetDrawing(zip, sheet, worksheetXml) {
  const relationships = partRelationshipPath(sheet.path);
  const linked = /<Relationship\b[^>]*\bType="[^"]*\/drawing"[^>]*\bTarget="([^"]+)"/
    .exec(await zipText(zip, relationships))?.[1];
  if (linked) {
    return {
      part: posix.normalize(posix.join(posix.dirname(sheet.path), linked)),
      worksheet: worksheetXml,
    };
  }
  let ordinal = 1;
  while (zip.file(`xl/drawings/drawing${ordinal}.xml`)) ordinal += 1;
  const part = `xl/drawings/drawing${ordinal}.xml`;
  zip.file(part, `${XML_HEADER}<xdr:wsDr xmlns:xdr="${SPREADSHEET_DRAWING_NS}" xmlns:a="${DRAWING_MAIN_NS}" xmlns:r="${OFFICE_RELATIONSHIP_BASE}"></xdr:wsDr>`);
  await ensureContentTypeOverride(zip, `/${part}`, 'application/vnd.openxmlformats-officedocument.drawing+xml');
  const relationshipId = await addPackageRelationship(
    zip,
    relationships,
    `${OFFICE_RELATIONSHIP_BASE}/drawing`,
    posix.relative(posix.dirname(sheet.path), part),
  );
  return {
    part,
    worksheet: upsertWorksheetSection(worksheetXml, 'drawing', `<drawing r:id="${relationshipId}"/>`),
  };
}



const SHEET_COMMENTS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml';


const VML_SHELL = '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"'
  + ' xmlns:x="urn:schemas-microsoft-com:office:excel">'
  + '<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout>'
  + '<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe">'
  + '<v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>'
  + '</xml>';



function vmlNoteShape(id, parsed) {
  const column = columnNumber(parsed.col) - 1;
  const row = parsed.row - 1;
  return `<v:shape id="_x0000_s${id}" type="#_x0000_t202"`
    + ' style="position:absolute;margin-left:60pt;margin-top:2pt;width:120pt;height:60pt;z-index:1;visibility:hidden"'
    + ' fillcolor="#ffffe1" o:insetmode="auto">'
    + '<v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/>'
    + '<v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox>'
    + '<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/>'
    + `<x:Anchor>${column + 1},15,${row},2,${column + 3},15,${row + 3},16</x:Anchor>`
    + `<x:AutoFill>False</x:AutoFill><x:Row>${row}</x:Row><x:Column>${column}</x:Column></x:ClientData>`
    + '</v:shape>';
}



async function ensureWorksheetComments(zip, sheet, worksheetXml) {
  const relationships = partRelationshipPath(sheet.path);
  const rels = await zipText(zip, relationships);
  const resolve = (target) => posix.normalize(posix.join(posix.dirname(sheet.path), target));
  let commentsPart = /<Relationship\b[^>]*\bType="[^"]*\/comments"[^>]*\bTarget="([^"]+)"/.exec(rels)?.[1];
  let vmlPart = /<Relationship\b[^>]*\bType="[^"]*\/vmlDrawing"[^>]*\bTarget="([^"]+)"/.exec(rels)?.[1];
  commentsPart = commentsPart ? resolve(commentsPart) : '';
  vmlPart = vmlPart ? resolve(vmlPart) : '';
  let worksheet = worksheetXml;
  if (!commentsPart) {
    let ordinal = 1;
    while (zip.file(`xl/comments${ordinal}.xml`)) ordinal += 1;
    commentsPart = `xl/comments${ordinal}.xml`;
    zip.file(commentsPart, `${XML_HEADER}<comments xmlns="${SPREADSHEET_MAIN}">`
      + '<authors><author>Mixdog</author></authors><commentList></commentList></comments>');
    await ensureContentTypeOverride(zip, `/${commentsPart}`, SHEET_COMMENTS_CONTENT_TYPE);
    await addPackageRelationship(
      zip,
      relationships,
      `${OFFICE_RELATIONSHIP_BASE}/comments`,
      posix.relative(posix.dirname(sheet.path), commentsPart),
    );
  }
  if (!vmlPart) {
    let ordinal = 1;
    while (zip.file(`xl/drawings/vmlDrawing${ordinal}.vml`)) ordinal += 1;
    vmlPart = `xl/drawings/vmlDrawing${ordinal}.vml`;
    zip.file(vmlPart, VML_SHELL);
    await ensureDefaultContentType(zip, 'vml', 'application/vnd.openxmlformats-officedocument.vmlDrawing');
    const relationshipId = await addPackageRelationship(
      zip,
      relationships,
      `${OFFICE_RELATIONSHIP_BASE}/vmlDrawing`,
      posix.relative(posix.dirname(sheet.path), vmlPart),
    );
    worksheet = upsertWorksheetSection(worksheet, 'legacyDrawing', `<legacyDrawing r:id="${relationshipId}"/>`);
  }
  return { commentsPart, vmlPart, worksheet };
}



export async function writeWorksheetNote(zip, sheet, worksheetXml, { cell, text, author = 'Mixdog', append = false }) {
  const parsed = parseCellRef(cell);
  const context = await ensureWorksheetComments(zip, sheet, worksheetXml);
  let comments = await zipText(zip, context.commentsPart);
  const authors = [...comments.matchAll(/<author>([\s\S]*?)<\/author>/g)].map((match) => xmlDecode(match[1]));
  let authorId = authors.indexOf(author);
  if (authorId < 0) {
    authors.push(author);
    authorId = authors.length - 1;
    comments = comments.replace(
      /<authors>[\s\S]*?<\/authors>/,
      `<authors>${authors.map((entry) => `<author>${xmlEncode(entry)}</author>`).join('')}</authors>`,
    );
  }
  const pattern = new RegExp(`<comment\\b[^>]*\\bref="${parsed.ref}"[^>]*>[\\s\\S]*?<\\/comment>`);
  const existing = pattern.exec(comments);
  const previous = existing
    ? [...existing[0].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => xmlDecode(match[1])).join('')
    : '';
  if (append && previous.includes(text)) return { worksheet: context.worksheet, changed: false };
  const body = append && previous ? `${previous}\n${text}` : text;
  if (existing) comments = comments.replace(pattern, '');
  const entry = `<comment ref="${parsed.ref}" authorId="${authorId}">`
    + `<text><r><t xml:space="preserve">${xmlEncode(body)}</t></r></text></comment>`;
  zip.file(context.commentsPart, comments.replace('</commentList>', `${entry}</commentList>`));
  if (!existing) {
    const vml = await zipText(zip, context.vmlPart);
    const shapeId = 1025 + (vml.match(/<v:shape\b/g) || []).length;
    zip.file(context.vmlPart, vml.replace('</xml>', `${vmlNoteShape(shapeId, parsed)}</xml>`));
  }
  return { worksheet: context.worksheet, changed: true, cell: parsed.ref };
}
