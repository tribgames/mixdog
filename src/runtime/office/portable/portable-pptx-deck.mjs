import { dirname, join, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { textBodyXml, toEmu } from './portable-slide-shapes.mjs';
import { readFile } from 'node:fs/promises';
import { addPackageRelationship, ensureContentTypeOverride, fillTemplateParts, nextRelationshipId, partRelationshipPath, provenanceCitation, zipText } from './portable-opc.mjs';
import { OFFICE_RELATIONSHIP_BASE, containerInner, replaceAcrossRuns, topLevelElements, xmlAttribute, xmlEncode } from './portable-xml.mjs';
import { SLIDE_CONTENT_TYPE, addPresentationSlide, deletePresentationSlide, ensureCommentAuthor, ensureSlideComments, importSlidesIntoPresentation, movePresentationSlide, presentationSlides, readSlideNotes, selectSlideLayout, setSlideNotes, slideIdEntries, slideLayoutParts, slidePath, writeSlideIdList } from './portable-pptx-package.mjs';
import JSZip from 'jszip';
import { nextShapeId, presentationSlideSize, setSlideBackground } from './portable-pptx-core.mjs';

export async function handleAddSlide(context, op) {
  const { zip } = context;
  let slides = context.slides;
  const created = await addPresentationSlide(zip, op);
  slides = context.slides = await presentationSlides(zip);
  return { op: op.op, changed: true, slide: created.position, layout: created.layout };
}


export async function handleDeleteSlide(context, op) {
  const { zip } = context;
  let slides = context.slides;
  await deletePresentationSlide(zip, slides, op.slide);
  slides = context.slides = await presentationSlides(zip);
  return { op: op.op, changed: true, slide: Number(op.slide) };
}


export async function handleMoveSlide(context, op) {
  const { zip } = context;
  let slides = context.slides;
  await movePresentationSlide(zip, slides, op.slide, op.index);
  slides = context.slides = await presentationSlides(zip);
  return { op: op.op, changed: true, slide: Number(op.slide), index: Number(op.index) };
}


export async function handleKeepSlides(context, op) {
  const { zip } = context;
  let slides = context.slides;
  const keep = new Set((Array.isArray(op.slides) ? op.slides : []).map(Number));
  if (!keep.size) throw new Error('keep_slides requires slides');
  let removed = 0;
  for (let index = slides.length; index >= 1; index -= 1) {
    if (keep.has(index)) continue;
    await deletePresentationSlide(zip, await presentationSlides(zip), index);
    removed += 1;
  }
  slides = context.slides = await presentationSlides(zip);
  return { op: op.op, changed: removed > 0, removed, remaining: slides.length };
}


export async function handleAddCommentOrDeleteComment(context, op) {
  const { zip } = context;
  const slides = context.slides;
  const slide = slides[Number(op.slide) - 1];
  if (!slide) throw new Error(`PPTX slide ${op.slide} not found`);
  if (op.op === 'delete_comment') {
    const target = /<Relationship\b[^>]*\bType="[^"]*\/comments"[^>]*\bTarget="([^"]+)"/
      .exec(await zipText(zip, partRelationshipPath(slide.path)))?.[1];
    if (!target) throw new Error(`PPTX slide ${op.slide} has no comments`);
    const part = posix.normalize(posix.join(posix.dirname(slide.path), target));
    const xml = await zipText(zip, part);
    const pattern = new RegExp(`<p:cm\\b[^>]*\\bidx="${Number(op.comment)}"[^>]*>[\\s\\S]*?<\\/p:cm>`);
    if (!pattern.test(xml)) throw new Error(`PPTX comment ${op.comment} not found on slide ${op.slide}`);
    zip.file(part, xml.replace(pattern, ''));
    return { op: op.op, changed: true, slide: Number(op.slide), comment: Number(op.comment) };
  }
  const text = String(op.text || '');
  if (!text) throw new Error('add_comment requires text');
  const authorId = await ensureCommentAuthor(zip, op.author || 'Mixdog', op.initials || 'MD');
  const part = await ensureSlideComments(zip, slide);
  const xml = await zipText(zip, part);
  const indices = [...xml.matchAll(/<p:cm\b[^>]*\bidx="(\d+)"/g)].map((match) => Number(match[1]));
  const index = Math.max(0, ...indices) + 1;
  const entry = `<p:cm authorId="${authorId}" dt="${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}" idx="${index}">`
    + `<p:pos x="${Math.max(0, toEmu(op.left ?? 12))}" y="${Math.max(0, toEmu(op.top ?? 12))}"/>`
    + `<p:text>${xmlEncode(text)}</p:text></p:cm>`;
  zip.file(part, xml.replace('</p:cmLst>', `${entry}</p:cmLst>`));
  return { op: op.op, changed: true, slide: Number(op.slide), comment: index };
}


export async function handleAddProvenance(context, op) {
  const { zip } = context;
  const slides = context.slides;
  const citation = provenanceCitation(op.source);
  if (!citation) throw new Error('add_provenance requires source with a document or label');
  const slide = slides[Number(op.slide) - 1];
  if (!slide) throw new Error(`PPTX slide ${op.slide} not found`);
  const existing = await readSlideNotes(zip, slide);
  if (existing.includes(citation)) {
    return { op: op.op, changed: false, slide: Number(op.slide), citation };
  }
  await setSlideNotes(zip, slides, op.slide, existing ? `${existing}\n${citation}` : citation);
  return {
    op: op.op,
    changed: true,
    slide: Number(op.slide),
    target: op.shape ? `/slide[${Number(op.slide)}]/shape[${Number(op.shape)}]` : `/slide[${Number(op.slide)}]`,
    citation,
  };
}


export async function handleDuplicateSlide(context, op) {
  const { zip } = context;
  let slides = context.slides;
  const source = slides[Number(op.slide) - 1];
  if (!source) throw new Error(`PPTX slide ${op.slide} not found`);
  let ordinal = 1;
  while (zip.file(`ppt/slides/slide${ordinal}.xml`)) ordinal += 1;
  const duplicated = `ppt/slides/slide${ordinal}.xml`;
  zip.file(duplicated, await zipText(zip, source.path));
  const sourceRelationships = await zipText(zip, partRelationshipPath(source.path));
  if (sourceRelationships) {
    zip.file(
      partRelationshipPath(duplicated),
      sourceRelationships.replace(/<Relationship\b[^>]*\bType="[^"]*\/notesSlide"[^>]*\/>/g, ''),
    );
  }
  await ensureContentTypeOverride(zip, `/${duplicated}`, SLIDE_CONTENT_TYPE);
  const relationshipId = await addPackageRelationship(
    zip,
    'ppt/_rels/presentation.xml.rels',
    `${OFFICE_RELATIONSHIP_BASE}/slide`,
    `slides/slide${ordinal}.xml`,
  );
  const presentation = await zipText(zip, 'ppt/presentation.xml');
  const entries = slideIdEntries(presentation);
  const ids = entries.map((entry) => Number(xmlAttribute(entry, 'id')) || 0);
  const position = Number(op.index) > 0
    ? Math.min(Number(op.index) - 1, entries.length)
    : Number(op.slide);
  entries.splice(position, 0, `<p:sldId id="${Math.max(255, ...ids) + 1}" r:id="${relationshipId}"/>`);
  zip.file('ppt/presentation.xml', writeSlideIdList(presentation, entries));
  slides = context.slides = await presentationSlides(zip);
  return { op: op.op, changed: true, slide: position + 1 };
}


export async function handleSetNotes(context, op) {
  const { zip } = context;
  const slides = context.slides;
  await setSlideNotes(zip, slides, op.slide, op.text);
  return { op: op.op, changed: true, slide: Number(op.slide) };
}


export async function handleFillTemplate(context, op) {
  const { zip } = context;
  const slides = context.slides;
  const paths = Object.keys(zip.files).filter((name) => /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(name));
  return await fillTemplateParts(zip, paths, 'a:t', op);
}


export async function handleReplaceText(context, op) {
  const { zip } = context;
  const slides = context.slides;
  let count = 0;
  const paths = Object.keys(zip.files).filter((name) => /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(name));
  for (const path of paths) {
    const current = await zipText(zip, path);
    const replaced = replaceAcrossRuns(current, 'a:t', String(op.find || ''), String(op.replace ?? ''));
    if (replaced.count) zip.file(path, replaced.xml);
    count += replaced.count;
  }
  return { op: op.op, changed: count > 0, count };
}


export async function handleImportSlides(context, op) {
  const { zip } = context;
  let slides = context.slides;
  const merged = await importSlidesIntoPresentation(zip, op.path, op.slides, op.after);
  slides = context.slides = await presentationSlides(zip);
  return { op: op.op, changed: merged.count > 0, count: merged.count, source: op.path };
}


export async function handleSetSlideBackground(context, op) {
  const { zip } = context;
  const slides = context.slides;
  const path = slidePath(slides, op.slide);
  const current = await zipText(zip, path);
  zip.file(path, setSlideBackground(current, op.color));
  return { op: op.op, changed: true, slide: Number(op.slide) };
}


export async function handleSetFooterOrSetSlideNumber(context, op) {
  const { zip } = context;
  const slides = context.slides;
  const path = slidePath(slides, op.slide);
  const current = await zipText(zip, path);
  const tree = containerInner(current, 'p:spTree');
  if (!tree) throw new Error('PPTX slide shape tree is missing');
  const placeholder = op.op === 'set_footer' ? 'ftr' : 'sldNum';
  const shapes = topLevelElements(tree.inner, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp']);
  let inner = tree.inner;
  for (let index = shapes.length - 1; index >= 0; index -= 1) {
    if (!new RegExp(`<p:ph\\b[^>]*\\btype="${placeholder}"`).test(shapes[index].xml)) continue;
    inner = `${inner.slice(0, shapes[index].start)}${inner.slice(shapes[index].end)}`;
  }
  const hidden = op.op === 'set_slide_number' && op.visible === false;
  if (!hidden) {
    const size = await presentationSlideSize(zip);
    const id = nextShapeId(current);
    const footer = op.op === 'set_footer';
    const body = footer
      ? textBodyXml({
        paragraphs: [{ text: String(op.text || '') }],
        defaults: { fontSize: 10, color: '7C838B' },
        anchor: 'center',
      })
      : '<a:bodyPr wrap="square"><a:noAutofit/></a:bodyPr><a:lstStyle/>'
        + `<a:p><a:pPr algn="r"/><a:fld id="{${randomUUID().toUpperCase()}}" type="slidenum">`
        + '<a:rPr lang="en-US" sz="1000"><a:solidFill><a:srgbClr val="7C838B"/></a:solidFill></a:rPr>'
        + `<a:t>${Number(op.slide)}</a:t></a:fld></a:p>`;
    const shape = `<p:sp><p:nvSpPr>`
      + `<p:cNvPr id="${id}" name="${footer ? 'Footer Placeholder' : 'Slide Number Placeholder'} ${id}"/>`
      + '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
      + `<p:nvPr><p:ph type="${placeholder}" sz="quarter" idx="${footer ? 10 : 12}"/></p:nvPr></p:nvSpPr>`
      + `<p:spPr><a:xfrm><a:off x="${toEmu(footer ? 58 : size.width - 158)}" y="${toEmu(size.height - 40)}"/>`
      + `<a:ext cx="${toEmu(footer ? size.width - 240 : 100)}" cy="${toEmu(24)}"/></a:xfrm>`
      + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
      + `<p:txBody>${body}</p:txBody></p:sp>`;
    inner = `${inner}${shape}`;
  }
  zip.file(path, `${current.slice(0, tree.start)}${inner}${current.slice(tree.end)}`);
  return { op: op.op, changed: true, slide: Number(op.slide), ...(hidden ? { visible: false } : {}) };
}


export async function handleApplyTheme(context, op) {
  const { zip } = context;
  const source = await JSZip.loadAsync(await readFile(op.path));
  const themePart = Object.keys(source.files)
    .find((name) => /^(?:ppt\/)?theme\/theme\d+\.xml$/i.test(name));
  if (!themePart) throw new Error(`apply_theme source has no theme part: ${op.path}`);
  const theme = await zipText(source, themePart);
  const masters = Object.keys(zip.files)
    .filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name));
  const targets = new Set();
  for (const master of masters) {
    const target = /<Relationship\b[^>]*\bType="[^"]*\/theme"[^>]*\bTarget="([^"]+)"/
      .exec(await zipText(zip, partRelationshipPath(master)))?.[1];
    if (target) targets.add(posix.normalize(posix.join(posix.dirname(master), target)));
  }
  if (!targets.size) targets.add('ppt/theme/theme1.xml');
  for (const part of targets) zip.file(part, theme);
  return { op: op.op, changed: true, theme: themePart, applied: [...targets] };
}


export async function handleSetLayout(context, op) {
  const { zip } = context;
  const slides = context.slides;
  const path = slidePath(slides, op.slide);
  const layout = selectSlideLayout(await slideLayoutParts(zip), op.layout);
  const relationships = partRelationshipPath(path);
  const rels = await zipText(zip, relationships);
  const target = posix.relative('ppt/slides', layout.path);
  const pattern = /<Relationship\b[^>]*\bType="[^"]*\/slideLayout"[^>]*\/>/;
  const next = pattern.test(rels)
    ? rels.replace(pattern, (block) => block.replace(/\bTarget="[^"]*"/, `Target="${xmlEncode(target)}"`))
    : rels.replace('</Relationships>', `<Relationship Id="${nextRelationshipId(rels)}" Type="${OFFICE_RELATIONSHIP_BASE}/slideLayout" Target="${xmlEncode(target)}"/></Relationships>`);
  zip.file(relationships, next);
  return { op: op.op, changed: true, slide: Number(op.slide), layout: layout.name || layout.type };
}


export async function handleSetTransition(context, op) {
  const { zip } = context;
  const slides = context.slides;
  const path = slidePath(slides, op.slide);
  const current = await zipText(zip, path);
  const effects = {
    fade: '<p:fade/>',
    cut: '<p:cut/>',
    push: '<p:push/>',
    wipe: '<p:wipe/>',
    split: '<p:split/>',
    dissolve: '<p:dissolve/>',
    cover: '<p:cover/>',
    zoom: '<p:zoom/>',
    none: '',
  };
  const requested = String(op.effect || 'fade').toLowerCase();
  if (!Object.hasOwn(effects, requested)) {
    throw new Error(`set_transition effect must be one of: ${Object.keys(effects).join(', ')}`);
  }
  const duration = Number(op.duration);
  const speed = Number.isFinite(duration) && duration > 0
    ? (duration >= 1500 ? 'slow' : duration <= 500 ? 'fast' : 'med')
    : 'med';
  const advance = op.advanceOnTime === true && Number(op.advanceTime) > 0
    ? ` advTm="${Math.round(Number(op.advanceTime))}"`
    : '';
  const element = requested === 'none'
    ? ''
    : `<p:transition spd="${speed}"${advance}>${effects[requested]}</p:transition>`;
  const stripped = current.replace(/<p:transition\b[^>]*?(?:\/>|>[\s\S]*?<\/p:transition>)/, '');
  const anchor = /<p:clrMapOvr\b[^>]*?(?:\/>|>[\s\S]*?<\/p:clrMapOvr>)/.exec(stripped);
  const next = element
    ? (anchor
      ? `${stripped.slice(0, anchor.index + anchor[0].length)}${element}${stripped.slice(anchor.index + anchor[0].length)}`
      : stripped.replace('</p:sld>', `${element}</p:sld>`))
    : stripped;
  zip.file(path, next);
  return { op: op.op, changed: true, slide: Number(op.slide), effect: requested };
}
