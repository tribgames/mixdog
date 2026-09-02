import { dirname, extname, join, posix } from 'node:path';
import { textBodyXml } from './portable-slide-shapes.mjs';
import { readFile } from 'node:fs/promises';
import { IMAGE_CONTENT_TYPES, PACKAGE_RELATIONSHIP_NS, addPackageRelationship, ensureContentTypeOverride, ensureDefaultContentType, loadPackage, partRelationshipPath, relationshipMap, removeContentTypeOverride, removePackageRelationship, rewriteImportedRelationships, savePackage, zipText } from './portable-opc.mjs';
import { OFFICE_RELATIONSHIP_BASE, XML_HEADER, paragraphTexts, tagPattern, xmlAttribute, xmlDecode, xmlEncode } from './portable-xml.mjs';
import JSZip from 'jszip';

const PRESENTATION_NAMESPACES = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
  + ` xmlns:r="${OFFICE_RELATIONSHIP_BASE}"`
  + ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';


export const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';


const NOTES_SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';


const NOTES_MASTER_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml';


const THEME_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.theme+xml';


function emptyGroupShape() {
  return '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
    + '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
}



export async function presentationSlides(zip) {
  const presentation = await zipText(zip, 'ppt/presentation.xml');
  const rels = relationshipMap(await zipText(zip, 'ppt/_rels/presentation.xml.rels'));
  const slides = [];
  for (const match of presentation.matchAll(/<p:sldId\b([^>]*?)\/>/g)) {
    const rid = /\br:id="([^"]+)"/.exec(match[1])?.[1] || '';
    const target = rid ? rels.get(rid) : '';
    if (!target) continue;
    slides.push({
      id: Number(/\bid="(\d+)"/.exec(match[1])?.[1]) || 0,
      rid,
      path: target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('ppt', target)),
    });
  }
  if (slides.length) return slides;
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => Number(/(\d+)\.xml$/.exec(left)[1]) - Number(/(\d+)\.xml$/.exec(right)[1]))
    .map((path) => ({ id: 0, rid: '', path }));
}



export function slidePath(slides, number) {
  const slide = slides[Number(number) - 1];
  if (!slide) throw new Error(`PPTX slide ${number} not found`);
  return slide.path;
}



export async function slideLayoutParts(zip) {
  const paths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name))
    .sort((left, right) => Number(/(\d+)\.xml$/.exec(left)[1]) - Number(/(\d+)\.xml$/.exec(right)[1]));
  const layouts = [];
  for (const path of paths) {
    const xml = await zipText(zip, path);
    layouts.push({
      path,
      name: xmlDecode(/<p:cSld\b[^>]*\bname="([^"]*)"/.exec(xml)?.[1] || ''),
      type: /<p:sldLayout\b[^>]*\btype="([^"]*)"/.exec(xml)?.[1] || '',
    });
  }
  return layouts;
}



export function selectSlideLayout(layouts, requested) {
  if (!layouts.length) throw new Error('Presentation has no slide layout for a new slide');
  const value = String(requested ?? '').trim();
  if (!value) return layouts.find((layout) => layout.type === 'blank') || layouts[0];
  if (/^\d+$/.test(value)) {
    const found = layouts[Number(value) - 1];
    if (!found) throw new Error(`Slide layout ${value} not found`);
    return found;
  }
  const matched = layouts.find((layout) => layout.name.toLowerCase() === value.toLowerCase())
    || layouts.find((layout) => layout.type.toLowerCase() === value.toLowerCase());
  if (!matched) {
    throw new Error(`Slide layout not found: ${value}. Available: ${layouts.map((layout) => layout.name || layout.type || '(unnamed)').join(', ')}`);
  }
  return matched;
}



export function writeSlideIdList(presentation, entries) {
  const element = `<p:sldIdLst>${entries.join('')}</p:sldIdLst>`;
  const existing = /<p:sldIdLst\b[^>]*?(?:\/>|>[\s\S]*?<\/p:sldIdLst>)/.exec(presentation);
  if (existing) {
    return `${presentation.slice(0, existing.index)}${element}${presentation.slice(existing.index + existing[0].length)}`;
  }
  const size = /<p:sldSz\b/.exec(presentation);
  if (size) return `${presentation.slice(0, size.index)}${element}${presentation.slice(size.index)}`;
  return presentation.replace('</p:presentation>', `${element}</p:presentation>`);
}



export function slideIdEntries(presentation) {
  const list = /<p:sldIdLst\b[^>]*?(?:\/>|>[\s\S]*?<\/p:sldIdLst>)/.exec(presentation);
  return list ? [...list[0].matchAll(/<p:sldId\b[^>]*?\/>/g)].map((match) => match[0]) : [];
}



export async function addPresentationSlide(zip, op) {
  const layout = selectSlideLayout(await slideLayoutParts(zip), op.layout);
  let ordinal = 1;
  while (zip.file(`ppt/slides/slide${ordinal}.xml`)) ordinal += 1;
  const part = `ppt/slides/slide${ordinal}.xml`;
  zip.file(part, `${XML_HEADER}<p:sld ${PRESENTATION_NAMESPACES}><p:cSld><p:spTree>${emptyGroupShape()}`
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>');
  zip.file(partRelationshipPath(part), `${XML_HEADER}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}">`
    + `<Relationship Id="rId1" Type="${OFFICE_RELATIONSHIP_BASE}/slideLayout" Target="${posix.relative('ppt/slides', layout.path)}"/>`
    + '</Relationships>');
  await ensureContentTypeOverride(zip, `/${part}`, SLIDE_CONTENT_TYPE);
  const relationshipId = await addPackageRelationship(
    zip,
    'ppt/_rels/presentation.xml.rels',
    `${OFFICE_RELATIONSHIP_BASE}/slide`,
    `slides/slide${ordinal}.xml`,
  );
  const presentationPath = 'ppt/presentation.xml';
  const presentation = await zipText(zip, presentationPath);
  const entries = slideIdEntries(presentation);
  const ids = entries.map((entry) => Number(xmlAttribute(entry, 'id')) || 0);
  const position = Number(op.index) > 0 ? Math.min(Number(op.index) - 1, entries.length) : entries.length;
  entries.splice(position, 0, `<p:sldId id="${Math.max(255, ...ids) + 1}" r:id="${relationshipId}"/>`);
  zip.file(presentationPath, writeSlideIdList(presentation, entries));
  return { part, position: position + 1, layout: layout.name || layout.type || layout.path };
}



export async function deletePresentationSlide(zip, slides, number) {
  if (slides.length <= 1) throw new Error('A presentation must keep at least one slide');
  const slide = slides[Number(number) - 1];
  if (!slide) throw new Error(`PPTX slide ${number} not found`);
  const presentationPath = 'ppt/presentation.xml';
  const presentation = await zipText(zip, presentationPath);
  const entries = slideIdEntries(presentation)
    .filter((entry) => xmlAttribute(entry, 'r:id') !== slide.rid);
  zip.file(presentationPath, writeSlideIdList(presentation, entries));
  await removePackageRelationship(zip, 'ppt/_rels/presentation.xml.rels', slide.rid);
  const relsPath = partRelationshipPath(slide.path);
  const rels = await zipText(zip, relsPath);
  const notes = /<Relationship\b[^>]*\bType="[^"]*\/notesSlide"[^>]*\bTarget="([^"]+)"/.exec(rels)?.[1];
  if (notes) {
    const notesPart = posix.normalize(posix.join(posix.dirname(slide.path), notes));
    zip.remove(notesPart);
    if (zip.file(partRelationshipPath(notesPart))) zip.remove(partRelationshipPath(notesPart));
    await removeContentTypeOverride(zip, `/${notesPart}`);
  }
  zip.remove(slide.path);
  if (zip.file(relsPath)) zip.remove(relsPath);
  await removeContentTypeOverride(zip, `/${slide.path}`);
}



export async function movePresentationSlide(zip, slides, number, index) {
  const slide = slides[Number(number) - 1];
  if (!slide) throw new Error(`PPTX slide ${number} not found`);
  const target = Number(index);
  if (!Number.isFinite(target) || target < 1 || target > slides.length) {
    throw new Error(`move_slide index must be between 1 and ${slides.length}`);
  }
  const presentationPath = 'ppt/presentation.xml';
  const presentation = await zipText(zip, presentationPath);
  const entries = slideIdEntries(presentation);
  const from = entries.findIndex((entry) => xmlAttribute(entry, 'r:id') === slide.rid);
  if (from < 0) throw new Error(`PPTX slide ${number} is not listed in the presentation`);
  const [moved] = entries.splice(from, 1);
  entries.splice(target - 1, 0, moved);
  zip.file(presentationPath, writeSlideIdList(presentation, entries));
}



async function ensureNotesMaster(zip) {
  const part = 'ppt/notesMasters/notesMaster1.xml';
  if (zip.file(part)) return part;
  const theme = Object.keys(zip.files).find((name) => /^ppt\/theme\/theme\d+\.xml$/.test(name));
  if (!theme) throw new Error('Presentation is missing a theme for the notes master');
  // PowerPoint rejects a package whose notes master shares the slide master's
  // theme part outright — it reports the whole file as corrupt and unreadable,
  // so every deck carrying speaker notes failed to open. Each master owns a
  // theme, so copy the presentation theme into one for the notes master.
  let themeOrdinal = 1;
  while (zip.file(`ppt/theme/theme${themeOrdinal}.xml`)) themeOrdinal += 1;
  const notesTheme = `ppt/theme/theme${themeOrdinal}.xml`;
  zip.file(notesTheme, await zipText(zip, theme));
  await ensureContentTypeOverride(zip, `/${notesTheme}`, THEME_CONTENT_TYPE);
  const colorMap = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2"'
    + ' accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';
  zip.file(part, `${XML_HEADER}<p:notesMaster ${PRESENTATION_NAMESPACES}>`
    + `<p:cSld><p:spTree>${emptyGroupShape()}</p:spTree></p:cSld>`
    + `<p:clrMap ${colorMap}/>`
    + '<p:notesStyle><a:lvl1pPr><a:defRPr sz="1200"/></a:lvl1pPr></p:notesStyle>'
    + '</p:notesMaster>');
  zip.file(partRelationshipPath(part), `${XML_HEADER}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}">`
    + `<Relationship Id="rId1" Type="${OFFICE_RELATIONSHIP_BASE}/theme" Target="${posix.relative('ppt/notesMasters', notesTheme)}"/>`
    + '</Relationships>');
  await ensureContentTypeOverride(zip, `/${part}`, NOTES_MASTER_CONTENT_TYPE);
  const relationshipId = await addPackageRelationship(
    zip,
    'ppt/_rels/presentation.xml.rels',
    `${OFFICE_RELATIONSHIP_BASE}/notesMaster`,
    'notesMasters/notesMaster1.xml',
  );
  const presentationPath = 'ppt/presentation.xml';
  const presentation = await zipText(zip, presentationPath);
  if (!/<p:notesMasterIdLst\b/.test(presentation)) {
    const element = `<p:notesMasterIdLst><p:notesMasterId r:id="${relationshipId}"/></p:notesMasterIdLst>`;
    const anchor = /<p:sldIdLst\b/.exec(presentation) || /<p:sldSz\b/.exec(presentation);
    zip.file(presentationPath, anchor
      ? `${presentation.slice(0, anchor.index)}${element}${presentation.slice(anchor.index)}`
      : presentation.replace('</p:presentation>', `${element}</p:presentation>`));
  }
  return part;
}



const PPTX_COMMENTS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.comments+xml';


const PPTX_COMMENT_AUTHORS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml';



export async function ensureCommentAuthor(zip, author, initials) {
  const part = 'ppt/commentAuthors.xml';
  let xml = await zipText(zip, part);
  if (!xml) {
    xml = `${XML_HEADER}<p:cmAuthorLst ${PRESENTATION_NAMESPACES}></p:cmAuthorLst>`;
    zip.file(part, xml);
    await ensureContentTypeOverride(zip, `/${part}`, PPTX_COMMENT_AUTHORS_CONTENT_TYPE);
    await addPackageRelationship(
      zip,
      'ppt/_rels/presentation.xml.rels',
      `${OFFICE_RELATIONSHIP_BASE}/commentAuthors`,
      'commentAuthors.xml',
    );
  }
  const existing = new RegExp(`<p:cmAuthor\\b[^>]*\\bname="${tagPattern(xmlEncode(author))}"[^>]*\\/>`).exec(xml);
  if (existing) return Number(xmlAttribute(existing[0], 'id')) || 0;
  const ids = [...xml.matchAll(/<p:cmAuthor\b[^>]*\bid="(\d+)"/g)].map((match) => Number(match[1]));
  const id = Math.max(-1, ...ids) + 1;
  const entry = `<p:cmAuthor id="${id}" name="${xmlEncode(author)}" initials="${xmlEncode(initials)}"`
    + ` lastIdx="1" clrIdx="${id}"/>`;
  zip.file(part, xml.replace('</p:cmAuthorLst>', `${entry}</p:cmAuthorLst>`));
  return id;
}



export async function ensureSlideComments(zip, slide) {
  const relationships = partRelationshipPath(slide.path);
  const target = /<Relationship\b[^>]*\bType="[^"]*\/comments"[^>]*\bTarget="([^"]+)"/
    .exec(await zipText(zip, relationships))?.[1];
  if (target) return posix.normalize(posix.join(posix.dirname(slide.path), target));
  let ordinal = 1;
  while (zip.file(`ppt/comments/comment${ordinal}.xml`)) ordinal += 1;
  const part = `ppt/comments/comment${ordinal}.xml`;
  zip.file(part, `${XML_HEADER}<p:cmLst ${PRESENTATION_NAMESPACES}></p:cmLst>`);
  await ensureContentTypeOverride(zip, `/${part}`, PPTX_COMMENTS_CONTENT_TYPE);
  await addPackageRelationship(
    zip,
    relationships,
    `${OFFICE_RELATIONSHIP_BASE}/comments`,
    posix.relative(posix.dirname(slide.path), part),
  );
  return part;
}



export async function readSlideNotes(zip, slide) {
  const relationships = await zipText(zip, partRelationshipPath(slide.path));
  const linked = /<Relationship\b[^>]*\bType="[^"]*\/notesSlide"[^>]*\bTarget="([^"]+)"/.exec(relationships)?.[1];
  if (!linked) return '';
  const part = posix.normalize(posix.join(posix.dirname(slide.path), linked));
  const xml = await zipText(zip, part);
  if (!xml) return '';
  const body = /<p:sp>[\s\S]*?<p:ph type="body"[\s\S]*?<\/p:sp>/.exec(xml)?.[0] || xml;
  return [...body.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)]
    .map((paragraph) => paragraphTexts(paragraph[0], 'a:t').join(''))
    .join('\n')
    .trim();
}



export async function setSlideNotes(zip, slides, number, text) {
  const slide = slides[Number(number) - 1];
  if (!slide) throw new Error(`PPTX slide ${number} not found`);
  await ensureNotesMaster(zip);
  const slideRelsPath = partRelationshipPath(slide.path);
  const slideRels = await zipText(zip, slideRelsPath);
  const linked = /<Relationship\b[^>]*\bType="[^"]*\/notesSlide"[^>]*\bTarget="([^"]+)"/.exec(slideRels)?.[1];
  const ordinal = Number(/slide(\d+)\.xml$/.exec(slide.path)?.[1]) || Number(number);
  const part = linked
    ? posix.normalize(posix.join(posix.dirname(slide.path), linked))
    : `ppt/notesSlides/notesSlide${ordinal}.xml`;
  const paragraphs = String(text ?? '').split(/\r?\n/).map((line) => ({ text: line }));
  const body = textBodyXml({ paragraphs, defaults: { fontSize: 12 } });
  zip.file(part, `${XML_HEADER}<p:notes ${PRESENTATION_NAMESPACES}><p:cSld><p:spTree>${emptyGroupShape()}`
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/>'
    + '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
    + '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>'
    + `<p:spPr/><p:txBody>${body}</p:txBody></p:sp>`
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>');
  if (!zip.file(partRelationshipPath(part))) {
    zip.file(partRelationshipPath(part), `${XML_HEADER}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}">`
      + `<Relationship Id="rId1" Type="${OFFICE_RELATIONSHIP_BASE}/slide" Target="${posix.relative(posix.dirname(part), slide.path)}"/>`
      + `<Relationship Id="rId2" Type="${OFFICE_RELATIONSHIP_BASE}/notesMaster" Target="${posix.relative(posix.dirname(part), 'ppt/notesMasters/notesMaster1.xml')}"/>`
      + '</Relationships>');
  }
  await ensureContentTypeOverride(zip, `/${part}`, NOTES_SLIDE_CONTENT_TYPE);
  if (!linked) {
    await addPackageRelationship(
      zip,
      slideRelsPath,
      `${OFFICE_RELATIONSHIP_BASE}/notesSlide`,
      posix.relative(posix.dirname(slide.path), part),
    );
  }
}



export async function addSlideImage(zip, slidePart, source) {
  const extension = extname(String(source || '')).replace(/^\./, '').toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES[extension];
  if (!contentType) {
    throw new Error(`Unsupported image type: .${extension || 'unknown'}. Use ${Object.keys(IMAGE_CONTENT_TYPES).join(', ')}`);
  }
  const data = await readFile(source);
  let ordinal = 1;
  while (zip.file(`ppt/media/image${ordinal}.${extension}`)) ordinal += 1;
  const part = `ppt/media/image${ordinal}.${extension}`;
  zip.file(part, data);
  await ensureDefaultContentType(zip, extension, contentType);
  const relationshipId = await addPackageRelationship(
    zip,
    partRelationshipPath(slidePart),
    `${OFFICE_RELATIONSHIP_BASE}/image`,
    posix.relative(posix.dirname(slidePart), part),
  );
  return { part, relationshipId };
}



export async function importSlidesIntoPresentation(zip, sourcePath, slideNumbers, after) {
  const source = await JSZip.loadAsync(await readFile(sourcePath));
  const sourceSlides = await presentationSlides(source);
  if (!sourceSlides.length) throw new Error('import_slides source has no slides');
  const requested = Array.isArray(slideNumbers) && slideNumbers.length
    ? slideNumbers.map(Number)
    : sourceSlides.map((_, index) => index + 1);
  const cache = new Map();
  let position = Math.max(0, Number(after) || 0);
  const imported = [];
  for (const number of requested) {
    const entry = sourceSlides[number - 1];
    if (!entry) throw new Error(`import_slides source has no slide ${number}`);
    let ordinal = 1;
    while (zip.file(`ppt/slides/slide${ordinal}.xml`)) ordinal += 1;
    const targetPath = `ppt/slides/slide${ordinal}.xml`;
    zip.file(targetPath, await zipText(source, entry.path));
    cache.set(`slide:${entry.path}`, targetPath);
    await ensureContentTypeOverride(zip, `/${targetPath}`, SLIDE_CONTENT_TYPE);
    const relationships = await zipText(source, partRelationshipPath(entry.path));
    if (relationships) {
      zip.file(
        partRelationshipPath(targetPath),
        await rewriteImportedRelationships(source, zip, entry.path, targetPath, relationships, cache),
      );
    }
    const relationshipId = await addPackageRelationship(
      zip,
      'ppt/_rels/presentation.xml.rels',
      `${OFFICE_RELATIONSHIP_BASE}/slide`,
      `slides/slide${ordinal}.xml`,
    );
    const presentation = await zipText(zip, 'ppt/presentation.xml');
    const entries = slideIdEntries(presentation);
    const ids = entries.map((item) => Number(xmlAttribute(item, 'id')) || 0);
    const index = Math.min(position, entries.length);
    entries.splice(index, 0, `<p:sldId id="${Math.max(255, ...ids) + 1}" r:id="${relationshipId}"/>`);
    zip.file('ppt/presentation.xml', writeSlideIdList(presentation, entries));
    position = index + 1;
    imported.push(number);
  }
  return { count: imported.length, slides: imported };
}



export async function clearPortablePresentationSlides(path) {
  const zip = await loadPackage(path);
  const slides = await presentationSlides(zip);
  const presentation = await zipText(zip, 'ppt/presentation.xml');
  zip.file('ppt/presentation.xml', writeSlideIdList(presentation, []));
  for (const slide of slides) {
    if (slide.rid) await removePackageRelationship(zip, 'ppt/_rels/presentation.xml.rels', slide.rid);
    const relationships = partRelationshipPath(slide.path);
    const notes = /<Relationship\b[^>]*\bType="[^"]*\/notesSlide"[^>]*\bTarget="([^"]+)"/
      .exec(await zipText(zip, relationships))?.[1];
    if (notes) {
      const notesPart = posix.normalize(posix.join(posix.dirname(slide.path), notes));
      zip.remove(notesPart);
      if (zip.file(partRelationshipPath(notesPart))) zip.remove(partRelationshipPath(notesPart));
      await removeContentTypeOverride(zip, `/${notesPart}`);
    }
    zip.remove(slide.path);
    if (zip.file(relationships)) zip.remove(relationships);
    await removeContentTypeOverride(zip, `/${slide.path}`);
  }
  await savePackage(zip, path);
  return { removed: slides.length };
}
