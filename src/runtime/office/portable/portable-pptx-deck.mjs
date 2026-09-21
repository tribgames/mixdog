import { posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SLIDE_SHAPE_TAGS, textBodyXml, toEmu } from './portable-slide-shapes.mjs';
import { readFile } from 'node:fs/promises';
import {
  addPackageRelationship,
  cloneOwnedSlideParts,
  ensureContentTypeOverride,
  fillTemplateParts,
  nextRelationshipId,
  partRelationshipPath,
  provenanceCitation,
  relationshipTargetByType,
  zipText,
} from './portable-opc.mjs';
import {
  OFFICE_RELATIONSHIP_BASE,
  containerInner,
  replaceAcrossRuns,
  topLevelElements,
  xmlAttribute,
  xmlEncode,
} from './portable-xml.mjs';
import {
  SLIDE_CONTENT_TYPE,
  addPresentationSlide,
  deletePresentationSlide,
  ensureCommentAuthor,
  ensureSlideComments,
  importSlidesIntoPresentation,
  movePresentationSlide,
  presentationSlides,
  readSlideNotes,
  selectSlideLayout,
  setSlideNotes,
  slideIdEntries,
  slideLayoutParts,
  slidePath,
  writeSlideIdList,
} from './portable-pptx-package.mjs';
import JSZip from 'jszip';
import {
  nextShapeId,
  presentationSlideSize,
  resolveSlideBackground,
  setSlideBackground,
} from './portable-pptx-core.mjs';
import { contrastRatio, relativeLuminance } from './text-metrics.mjs';

export async function handleAddSlide(context, op) {
  const { zip } = context;
  const created = await addPresentationSlide(zip, op);
  context.slides = await presentationSlides(zip);
  return { op: op.op, changed: true, slide: created.position, layout: created.layout };
}

export async function handleDeleteSlide(context, op) {
  const { zip } = context;
  const slides = context.slides;
  await deletePresentationSlide(zip, slides, op.slide);
  context.slides = await presentationSlides(zip);
  return { op: op.op, changed: true, slide: Number(op.slide) };
}

export async function handleMoveSlide(context, op) {
  const { zip } = context;
  const slides = context.slides;
  await movePresentationSlide(zip, slides, op.slide, op.index);
  context.slides = await presentationSlides(zip);
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
    const target = relationshipTargetByType(await zipText(zip, partRelationshipPath(slide.path)), 'comments');
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
  const entry =
    `<p:cm authorId="${authorId}" dt="${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}" idx="${index}">` +
    `<p:pos x="${Math.max(0, toEmu(op.left ?? 12))}" y="${Math.max(0, toEmu(op.top ?? 12))}"/>` +
    `<p:text>${xmlEncode(text)}</p:text></p:cm>`;
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
  const slides = context.slides;
  const source = slides[Number(op.slide) - 1];
  if (!source) throw new Error(`PPTX slide ${op.slide} not found`);
  let ordinal = 1;
  while (zip.file(`ppt/slides/slide${ordinal}.xml`)) ordinal += 1;
  const duplicated = `ppt/slides/slide${ordinal}.xml`;
  zip.file(duplicated, await zipText(zip, source.path));
  const sourceRelationships = await zipText(zip, partRelationshipPath(source.path));
  let copiedParts = [];
  if (sourceRelationships) {
    zip.file(
      partRelationshipPath(duplicated),
      sourceRelationships.replace(/<Relationship\b[^>]*\bType="[^"]*\/notesSlide"[^>]*\/>/g, '')
    );
    // A copy that still pointed at the source's chart or diagram turned one
    // edit into two changed pages, with nothing in the result saying so.
    copiedParts = await cloneOwnedSlideParts(zip, partRelationshipPath(duplicated));
  }
  await ensureContentTypeOverride(zip, `/${duplicated}`, SLIDE_CONTENT_TYPE);
  const relationshipId = await addPackageRelationship(
    zip,
    'ppt/_rels/presentation.xml.rels',
    `${OFFICE_RELATIONSHIP_BASE}/slide`,
    `slides/slide${ordinal}.xml`
  );
  const presentation = await zipText(zip, 'ppt/presentation.xml');
  const entries = slideIdEntries(presentation);
  const ids = entries.map((entry) => Number(xmlAttribute(entry, 'id')) || 0);
  const position = Number(op.index) > 0 ? Math.min(Number(op.index) - 1, entries.length) : Number(op.slide);
  entries.splice(position, 0, `<p:sldId id="${Math.max(255, ...ids) + 1}" r:id="${relationshipId}"/>`);
  zip.file('ppt/presentation.xml', writeSlideIdList(presentation, entries));
  context.slides = await presentationSlides(zip);
  return {
    op: op.op,
    changed: true,
    slide: position + 1,
    ...(copiedParts.length ? { ownParts: copiedParts } : {}),
  };
}

export async function handleSetNotes(context, op) {
  const { zip } = context;
  const slides = context.slides;
  await setSlideNotes(zip, slides, op.slide, op.text);
  return { op: op.op, changed: true, slide: Number(op.slide) };
}

export async function handleFillTemplate(context, op) {
  const { zip } = context;
  const paths = Object.keys(zip.files).filter((name) =>
    /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(name)
  );
  return await fillTemplateParts(zip, paths, 'a:t', op);
}

export async function handleReplaceText(context, op) {
  const { zip } = context;
  let count = 0;
  const paths = Object.keys(zip.files).filter((name) =>
    /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(name)
  );
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
  const merged = await importSlidesIntoPresentation(zip, op.path, op.slides, op.after);
  context.slides = await presentationSlides(zip);
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

// Secondary ink for a footer or page number: grey enough to recede, dark (or
// light) enough against its own field to clear the 4.5:1 the audit asks of any
// text. A field we cannot read leaves the neutral that suits a white slide.
const QUIET_INK_ON_LIGHT = Object.freeze(['6A7179', '5A616A', '474D55']);
const QUIET_INK_ON_DARK = Object.freeze(['A9B1B9', 'C2C9D0', 'D9DEE3']);

function quietInk(background) {
  const field = String(background || '')
    .replace(/^#/, '')
    .slice(-6)
    .toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(field)) return QUIET_INK_ON_LIGHT[0];
  const light = (relativeLuminance(field) ?? 1) >= 0.4;
  const ladder = light ? QUIET_INK_ON_LIGHT : QUIET_INK_ON_DARK;
  return ladder.find((candidate) => (contrastRatio(candidate, field) ?? 0) >= 4.5) || (light ? '1F2429' : 'FFFFFF');
}

export async function handleSetFooterOrSetSlideNumber(context, op) {
  const { zip } = context;
  const slides = context.slides;
  const path = slidePath(slides, op.slide);
  const current = await zipText(zip, path);
  const tree = containerInner(current, 'p:spTree');
  if (!tree) throw new Error('PPTX slide shape tree is missing');
  const placeholder = op.op === 'set_footer' ? 'ftr' : 'sldNum';
  const shapes = topLevelElements(tree.inner, SLIDE_SHAPE_TAGS);
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
    // A footer is quiet, not unreadable: the tone steps away from the field the
    // slide actually shows and stops at the contrast a reader needs.
    const ink = quietInk(await resolveSlideBackground(zip, path, current));
    const body = footer
      ? textBodyXml({
          paragraphs: [{ text: String(op.text || '') }],
          defaults: { fontSize: 10, color: ink },
          anchor: 'center',
        })
      : '<a:bodyPr wrap="square"><a:noAutofit/></a:bodyPr><a:lstStyle/>' +
        `<a:p><a:pPr algn="r"/><a:fld id="{${randomUUID().toUpperCase()}}" type="slidenum">` +
        `<a:rPr lang="en-US" sz="1000"><a:solidFill><a:srgbClr val="${ink}"/></a:solidFill></a:rPr>` +
        `<a:t>${Number(op.slide)}</a:t></a:fld></a:p>`;
    const shape =
      `<p:sp><p:nvSpPr>` +
      `<p:cNvPr id="${id}" name="${footer ? 'Footer Placeholder' : 'Slide Number Placeholder'} ${id}"/>` +
      '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
      `<p:nvPr><p:ph type="${placeholder}" sz="quarter" idx="${footer ? 10 : 12}"/></p:nvPr></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${toEmu(footer ? 58 : size.width - 158)}" y="${toEmu(size.height - 40)}"/>` +
      `<a:ext cx="${toEmu(footer ? size.width - 240 : 100)}" cy="${toEmu(24)}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
      `<p:txBody>${body}</p:txBody></p:sp>`;
    inner = `${inner}${shape}`;
  }
  zip.file(path, `${current.slice(0, tree.start)}${inner}${current.slice(tree.end)}`);
  return { op: op.op, changed: true, slide: Number(op.slide), ...(hidden ? { visible: false } : {}) };
}

export async function handleApplyTheme(context, op) {
  const { zip } = context;
  const source = await JSZip.loadAsync(await readFile(op.path));
  const themePart = Object.keys(source.files).find((name) => /^(?:ppt\/)?theme\/theme\d+\.xml$/i.test(name));
  if (!themePart) throw new Error(`apply_theme source has no theme part: ${op.path}`);
  const theme = await zipText(source, themePart);
  const masters = Object.keys(zip.files).filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name));
  const targets = new Set();
  for (const master of masters) {
    const target = relationshipTargetByType(await zipText(zip, partRelationshipPath(master)), 'theme');
    if (target) targets.add(posix.normalize(posix.join(posix.dirname(master), target)));
  }
  if (!targets.size) targets.add('ppt/theme/theme1.xml');
  // A theme identical to the one already in the deck restyles nothing. Saying
  // "changed" there tells the caller the deck was restyled and leaves them
  // looking for a difference the file does not carry.
  const applied = [];
  for (const part of targets) {
    if ((await zipText(zip, part)) === theme) continue;
    zip.file(part, theme);
    applied.push(part);
  }
  return {
    op: op.op,
    changed: applied.length > 0,
    theme: themePart,
    applied,
    ...(applied.length ? {} : { unchangedReason: 'the deck already uses this theme' }),
  };
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
    : rels.replace(
        '</Relationships>',
        `<Relationship Id="${nextRelationshipId(rels)}" Type="${OFFICE_RELATIONSHIP_BASE}/slideLayout" Target="${xmlEncode(target)}"/></Relationships>`
      );
  zip.file(relationships, next);
  return { op: op.op, changed: true, slide: Number(op.slide), layout: layout.name || layout.type };
}

// PowerPoint keeps a hidden slide in the file and skips it when presenting, which
// is how an appendix rides along with the deck it belongs to. The state lives on
// the slide element itself, so a deck can carry it without a notes convention.
export async function handleSetSlideVisibility(context, op) {
  const { zip } = context;
  const path = slidePath(context.slides, op.slide);
  if (typeof op.visible !== 'boolean') throw new Error('set_slide_visibility requires visible: true or false');
  const current = await zipText(zip, path);
  const open = /<p:sld\b[^>]*>/.exec(current);
  if (!open) throw new Error(`Slide part is not a presentation slide: ${path}`);
  const stripped = open[0].replace(/\s*\bshow="[^"]*"/, '');
  const attributes = op.visible ? stripped : stripped.replace(/>$/, ' show="0">');
  zip.file(path, `${current.slice(0, open.index)}${attributes}${current.slice(open.index + open[0].length)}`);
  return { op: op.op, changed: true, slide: Number(op.slide), visible: op.visible };
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
  let speed = 'med';
  if (Number.isFinite(duration) && duration >= 1500) speed = 'slow';
  else if (Number.isFinite(duration) && duration > 0 && duration <= 500) speed = 'fast';
  const advance =
    op.advanceOnTime === true && Number(op.advanceTime) > 0 ? ` advTm="${Math.round(Number(op.advanceTime))}"` : '';
  const element =
    requested === 'none' ? '' : `<p:transition spd="${speed}"${advance}>${effects[requested]}</p:transition>`;
  const stripped = current.replace(/<p:transition\b[^>]*?(?:\/>|>[\s\S]*?<\/p:transition>)/, '');
  const anchor = /<p:clrMapOvr\b[^>]*?(?:\/>|>[\s\S]*?<\/p:clrMapOvr>)/.exec(stripped);
  let next = stripped;
  if (element && anchor) {
    const anchorEnd = anchor.index + anchor[0].length;
    next = `${stripped.slice(0, anchorEnd)}${element}${stripped.slice(anchorEnd)}`;
  } else if (element) {
    next = stripped.replace('</p:sld>', `${element}</p:sld>`);
  }
  zip.file(path, next);
  return { op: op.op, changed: true, slide: Number(op.slide), effect: requested };
}
