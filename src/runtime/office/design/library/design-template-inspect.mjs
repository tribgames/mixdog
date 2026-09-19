import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import JSZip from 'jszip';
import { MAX_LOCAL_TEMPLATE_COUNT, MAX_SCAN_DEPTH, TEMPLATE_FORMATS } from './design-library-core.mjs';
import { xmlDecode } from '../../portable/portable-xml.mjs';

export async function walkTemplateDirectory(root, output, depth = 0) {
  if (depth > MAX_SCAN_DEPTH || output.length >= MAX_LOCAL_TEMPLATE_COUNT) return;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (output.length >= MAX_LOCAL_TEMPLATE_COUNT) break;
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walkTemplateDirectory(path, output, depth + 1);
    else if (
      entry.isFile() &&
      !/\.mixdog-edit\.[^.]+$/i.test(entry.name) &&
      TEMPLATE_FORMATS[extname(entry.name).toLowerCase()]
    )
      output.push(path);
  }
}

export function xmlAttribute(source, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(String(source || ''));
  return match ? xmlDecode(match[1]) : '';
}

function xmlTexts(source) {
  return [...String(source || '').matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi)]
    .map((match) => xmlDecode(match[1]).trim())
    .filter(Boolean);
}

function pptxPartPath(target) {
  const raw = String(target || '')
    .replaceAll('\\', '/')
    .replace(/^\/+/, '');
  const segments = (raw.startsWith('ppt/') ? raw : `ppt/${raw}`).split('/');
  const normalized = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') normalized.pop();
    else normalized.push(segment);
  }
  return normalized.join('/');
}

export async function pptxSlideEntries(zip) {
  const names = Object.keys(zip.files);
  const numberFromPath = (value) => Number(/(\d+)(?=\.xml$)/.exec(value)?.[1] || 0);
  const fallback = names
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => numberFromPath(left) - numberFromPath(right));
  const presentationFile = zip.file('ppt/presentation.xml');
  const relationshipsFile = zip.file('ppt/_rels/presentation.xml.rels');
  if (!presentationFile || !relationshipsFile) {
    return fallback.map((name, index) => ({ name, slide: index + 1, part: numberFromPath(name) }));
  }
  const presentationXml = await presentationFile.async('string');
  const relationshipsXml = await relationshipsFile.async('string');
  const targetsById = new Map(
    [...relationshipsXml.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/?>/gi)]
      .map((match) => [xmlAttribute(match[0], 'Id'), xmlAttribute(match[0], 'Target')])
      .filter(([id, target]) => id && /(?:^|\/)slides\/slide\d+\.xml$/i.test(target))
  );
  const ordered = [...presentationXml.matchAll(/<(?:\w+:)?sldId\b[^>]*\/?>/gi)]
    .map((match) => ({
      relationshipId: xmlAttribute(match[0], 'r:id'),
      name: pptxPartPath(targetsById.get(xmlAttribute(match[0], 'r:id'))),
    }))
    .filter((entry) => zip.file(entry.name));
  const slideEntries = ordered.length ? ordered : fallback.map((name) => ({ relationshipId: '', name }));
  return slideEntries.map((entry, index) => ({
    ...entry,
    slide: index + 1,
    part: numberFromPath(entry.name),
  }));
}

function xmlSetAttribute(source, name, value) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(source).replace(new RegExp(`(\\b${escaped}=")[^"]*(")`, 'i'), `$1${String(value)}$2`);
}

function relationshipType(block, suffix) {
  return xmlAttribute(block, 'Type').toLowerCase().endsWith(`/${suffix.toLowerCase()}`);
}

function ensureContentTypeOverride(xml, partName, contentType) {
  if (!xml || new RegExp(`\\bPartName="${String(partName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i').test(xml)) {
    return xml;
  }
  return xml.replace(/<\/Types>/i, `<Override PartName="${partName}" ContentType="${contentType}"/></Types>`);
}

const RELATIONSHIP_BLOCK = /<(?:\w+:)?Relationship\b[^>]*\/?>/gi;

function relationshipBlocks(xml) {
  return [...xml.matchAll(RELATIONSHIP_BLOCK)].map((match) => match[0]);
}

// One relationship id per selected slide: the source deck's slide ids in
// order where they are free, fresh rId numbers where they would collide with
// a non-slide relationship or an earlier pick.
function selectedSlideRelationshipIds(entries, relationshipsXml, count) {
  const slideRelationshipIds = entries.map((entry) => entry.relationshipId).filter(Boolean);
  const nonSlideRelationshipIds = new Set(
    relationshipBlocks(relationshipsXml)
      .filter((block) => !relationshipType(block, 'slide'))
      .map((block) => xmlAttribute(block, 'Id'))
  );
  const relationshipIds = [];
  let nextRelationshipId = 2;
  for (let index = 0; index < count; index += 1) {
    let id = slideRelationshipIds[index] || '';
    while (!id || nonSlideRelationshipIds.has(id) || relationshipIds.includes(id)) {
      id = `rId${nextRelationshipId}`;
      nextRelationshipId += 1;
    }
    relationshipIds.push(id);
  }
  return relationshipIds;
}

// The slide part, its relationships, and its notes slide with theirs.
async function readSlideParts(zip, entry) {
  const slideXml = await zip.file(entry.name).async('string');
  const slideRelationshipsPath = `ppt/slides/_rels/slide${entry.part}.xml.rels`;
  const slideRelationshipsXml = (await zip.file(slideRelationshipsPath)?.async('string')) || '';
  const notesRelationship = relationshipBlocks(slideRelationshipsXml).find((block) =>
    relationshipType(block, 'notesSlide')
  );
  const notesTarget = notesRelationship ? xmlAttribute(notesRelationship, 'Target') : '';
  const notesPart = Number(/notesSlide(\d+)\.xml$/i.exec(notesTarget)?.[1] || 0);
  const notesXml = notesPart
    ? (await zip.file(`ppt/notesSlides/notesSlide${notesPart}.xml`)?.async('string')) || ''
    : '';
  const notesRelationshipsXml = notesPart
    ? (await zip.file(`ppt/notesSlides/_rels/notesSlide${notesPart}.xml.rels`)?.async('string')) || ''
    : '';
  return { slideXml, slideRelationshipsXml, notesXml, notesRelationshipsXml };
}

function presentationWithSlideList(presentationXml, relationshipIds) {
  const slideListPattern = /<((?:\w+:)?)sldIdLst\b[^>]*>[\s\S]*?<\/\1sldIdLst>/i;
  const slideListMatch = slideListPattern.exec(presentationXml);
  if (!slideListMatch) throw new Error('PPTX presentation slide list is missing');
  const prefix = slideListMatch[1] || '';
  const slideIds = relationshipIds.map((id, index) => `<${prefix}sldId id="${256 + index}" r:id="${id}"/>`).join('');
  return presentationXml.replace(slideListPattern, `<${prefix}sldIdLst>${slideIds}</${prefix}sldIdLst>`);
}

function presentationRelationshipsWithSlides(relationshipsXml, relationshipIds) {
  const slideRelationships = relationshipIds
    .map(
      (id, index) =>
        `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`
    )
    .join('');
  return relationshipsXml
    .replace(RELATIONSHIP_BLOCK, (block) => (relationshipType(block, 'slide') ? '' : block))
    .replace(/<\/Relationships>/i, `${slideRelationships}</Relationships>`);
}

// Writes one selected slide (and its notes) under its new ordinal, retargeting
// the slide<->notes relationships to each other; returns the content types
// with both parts declared.
function writeSelectedSlide(zip, part, target, contentTypesXml) {
  zip.file(`ppt/slides/slide${target}.xml`, part.slideXml);
  if (part.slideRelationshipsXml) {
    const slideRels = part.slideRelationshipsXml.replace(RELATIONSHIP_BLOCK, (block) =>
      relationshipType(block, 'notesSlide')
        ? xmlSetAttribute(block, 'Target', `../notesSlides/notesSlide${target}.xml`)
        : block
    );
    zip.file(`ppt/slides/_rels/slide${target}.xml.rels`, slideRels);
  } else {
    zip.remove(`ppt/slides/_rels/slide${target}.xml.rels`);
  }
  let contentTypes = ensureContentTypeOverride(
    contentTypesXml,
    `/ppt/slides/slide${target}.xml`,
    'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'
  );
  if (!part.notesXml) return contentTypes;
  zip.file(`ppt/notesSlides/notesSlide${target}.xml`, part.notesXml);
  const notesRels = part.notesRelationshipsXml.replace(RELATIONSHIP_BLOCK, (block) =>
    relationshipType(block, 'slide') ? xmlSetAttribute(block, 'Target', `../slides/slide${target}.xml`) : block
  );
  if (notesRels) zip.file(`ppt/notesSlides/_rels/notesSlide${target}.xml.rels`, notesRels);
  contentTypes = ensureContentTypeOverride(
    contentTypes,
    `/ppt/notesSlides/notesSlide${target}.xml`,
    'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml'
  );
  return contentTypes;
}

export async function createPptxSlideSelection(sourcePath, slides, outputPath) {
  const selected = (Array.isArray(slides) ? slides : []).map(Number);
  if (!selected.length || selected.some((slide) => !Number.isInteger(slide) || slide < 1)) {
    throw new Error('PPTX slide selection requires positive integer slide numbers');
  }
  const zip = await JSZip.loadAsync(await readFile(sourcePath));
  const entries = await pptxSlideEntries(zip);
  if (selected.some((slide) => slide > entries.length)) {
    throw new Error(`PPTX slide selection is outside source deck range 1-${entries.length}`);
  }
  const presentationFile = zip.file('ppt/presentation.xml');
  const relationshipsFile = zip.file('ppt/_rels/presentation.xml.rels');
  if (!presentationFile || !relationshipsFile) throw new Error('PPTX presentation relationships are missing');
  const presentationXml = await presentationFile.async('string');
  const relationshipsXml = await relationshipsFile.async('string');
  const relationshipIds = selectedSlideRelationshipIds(entries, relationshipsXml, selected.length);
  const selectedParts = [];
  for (const slide of selected) selectedParts.push(await readSlideParts(zip, entries[slide - 1]));
  zip.file('ppt/presentation.xml', presentationWithSlideList(presentationXml, relationshipIds));
  zip.file('ppt/_rels/presentation.xml.rels', presentationRelationshipsWithSlides(relationshipsXml, relationshipIds));
  let contentTypesXml = (await zip.file('[Content_Types].xml')?.async('string')) || '';
  for (const [index, part] of selectedParts.entries()) {
    contentTypesXml = writeSelectedSlide(zip, part, index + 1, contentTypesXml);
  }
  if (contentTypesXml) zip.file('[Content_Types].xml', contentTypesXml);
  await writeSlideCount(zip, selected.length);
  await writePackage(zip, outputPath);
  return {
    output: outputPath,
    source: sourcePath,
    slides: selected,
    count: selected.length,
  };
}

async function writeSlideCount(zip, count) {
  const appFile = zip.file('docProps/app.xml');
  if (!appFile) return;
  const appXml = await appFile.async('string');
  zip.file('docProps/app.xml', appXml.replace(/<Slides>\d+<\/Slides>/i, `<Slides>${count}</Slides>`));
}

// A package that fails to serialize leaves no half-written file behind.
async function writePackage(zip, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await writeFile(
      outputPath,
      await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      })
    );
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function directPptxShapeBlocks(xml) {
  const tree = /<p:spTree\b[^>]*>([\s\S]*?)<\/p:spTree>/i.exec(String(xml || ''))?.[1] || '';
  const tags = /<\/?p:(sp|pic|graphicFrame|grpSp)\b[^>]*>/gi;
  const stack = [];
  const output = [];
  let start = -1;
  let rootType = '';
  for (const match of tree.matchAll(tags)) {
    const token = match[0];
    const type = match[1];
    const closing = token.startsWith('</');
    if (!closing) {
      if (!stack.length) {
        start = match.index;
        rootType = type;
      }
      stack.push(type);
    } else {
      const current = stack.pop();
      if (current !== type) {
        stack.length = 0;
        start = -1;
        rootType = '';
        continue;
      }
      if (!stack.length && start >= 0) {
        output.push({ type: rootType, xml: tree.slice(start, match.index + token.length) });
        start = -1;
        rootType = '';
      }
    }
  }
  return output;
}

function tokenSlotRole(text) {
  const token = /\{\{([A-Z0-9_]+)\}\}/.exec(String(text || ''))?.[1] || '';
  if (!token) return '';
  const metric = /^METRIC_(\d+)_(VALUE|LABEL|DETAIL)$/.exec(token);
  if (metric) return `metric-${metric[2].toLowerCase()}-${metric[1]}`;
  const column = /^COLUMN_(\d+)_(TITLE|BODY)$/.exec(token);
  if (column) return `column-${column[2].toLowerCase()}-${column[1]}`;
  const step = /^STEP_(\d+)_(TITLE|DETAIL)$/.exec(token);
  if (step) return `step-${step[2].toLowerCase()}-${step[1]}`;
  return token.toLowerCase().replaceAll('_', '-');
}

export function pptxSlot(metadata, role) {
  if (!role) return null;
  return {
    role,
    type: metadata.type,
    shape: metadata.shape,
    ...(metadata.placeholderType ? { placeholderType: metadata.placeholderType } : {}),
    ...(Number.isInteger(metadata.placeholderIndex) ? { placeholderIndex: metadata.placeholderIndex } : {}),
    geometry: metadata.geometry,
    required: role === 'title',
  };
}

export function pptxShapeMetadata(block, shape) {
  const cNvPr = /<p:cNvPr\b[^>]*>/i.exec(block.xml)?.[0] || '';
  const placeholder = /<p:ph\b[^>]*\/?>/i.exec(block.xml)?.[0] || '';
  const placeholderType = xmlAttribute(placeholder, 'type') || '';
  const placeholderIndex = Number(xmlAttribute(placeholder, 'idx'));
  const texts = xmlTexts(block.xml);
  const text = texts.join('\n');
  const off = /<a:off\b[^>]*>/i.exec(block.xml)?.[0] || '';
  const ext = /<a:ext\b[^>]*>/i.exec(block.xml)?.[0] || '';
  const geometry = {
    left: Number(xmlAttribute(off, 'x')) || 0,
    top: Number(xmlAttribute(off, 'y')) || 0,
    width: Number(xmlAttribute(ext, 'cx')) || 0,
    height: Number(xmlAttribute(ext, 'cy')) || 0,
  };
  let type = 'text';
  if (block.type === 'pic') type = 'image';
  else if (block.type === 'graphicFrame' && /<c:chart\b/i.test(block.xml)) type = 'chart';
  else if (block.type === 'graphicFrame' && /<a:tbl\b/i.test(block.xml)) type = 'table';
  else if (block.type === 'graphicFrame' || block.type === 'grpSp') type = 'diagram';
  // A page someone drew carries no placeholder and no token, so the only
  // evidence of which box is the title and which row reads as steps is the
  // type size it was set in and the outline it was drawn with.
  const fontSizes = [...block.xml.matchAll(/<a:rPr\b[^>]*\bsz="(\d+)"/gi)]
    .map((match) => Number(match[1]) / 100)
    .filter((size) => size > 0);
  const preset = block.type === 'sp' ? /<a:prstGeom\b[^>]*\bprst="([^"]+)"/i.exec(block.xml)?.[1] || '' : '';
  const metadata = {
    shape,
    name: xmlAttribute(cNvPr, 'name'),
    type,
    text,
    placeholderType,
    ...(Number.isInteger(placeholderIndex) ? { placeholderIndex } : {}),
    geometry,
    ...(fontSizes.length ? { fontSize: Math.max(...fontSizes) } : {}),
    ...(preset ? { preset } : {}),
  };
  let role = tokenSlotRole(text);
  if (!role) {
    if (['title', 'ctrTitle'].includes(placeholderType)) role = 'title';
    else if (placeholderType === 'subTitle') role = 'subtitle';
    else if (placeholderType === 'pic' || type === 'image') role = 'image';
    else if (type === 'chart') role = 'chart';
    else if (type === 'table') role = 'table';
    else if (placeholderType) role = `body-${shape}`;
  }
  const slot = pptxSlot(metadata, role);
  return slot ? { ...metadata, slot } : metadata;
}

export function inferPptxSampleKind(sample, total) {
  const roles = new Set(sample.slots.map((slot) => slot.role));
  const title = String(sample.title || '').toLowerCase();
  // The first page is the cover unless it carries a structure no cover has: a
  // flow of steps, or columns with their bodies under them. A deck that opens on
  // its comparison page says so instead of being read as a title page.
  const structured = [...roles].some((role) => role.startsWith('step-') || role.startsWith('column-body-'));
  if (sample.slide === 1 && !structured) return 'cover';
  if (sample.slide === total && /(thank|next|close|감사|다음)/i.test(title)) return 'closing';
  if ([...roles].some((role) => role.startsWith('step-'))) return 'process';
  if ([...roles].some((role) => role.startsWith('column-'))) return 'comparison';
  // A table carries quantities the same way a chart does, and the page that
  // holds one does the same job. Without it such a page fell through to the
  // statement reading (a table's words live in the table, so the page looks
  // wordless) and was offered as a page for one thesis and air.
  if (roles.has('chart') || roles.has('table') || [...roles].some((role) => role.startsWith('metric-')))
    return 'metrics';
  if (roles.has('image')) return 'split';
  if (sample.textChars < 90 && sample.shapes.length <= 6) return 'statement';
  return 'content';
}

function numberedRoleGroups(slots, prefix) {
  return new Set(
    (slots || []).flatMap((slot) => {
      const match = new RegExp(`^${prefix}-(?:value|label|detail|title|body)-(\\d+)$`).exec(String(slot.role || ''));
      return match ? [Number(match[1])] : [];
    })
  ).size;
}

export function pptxSampleCapacity(sample) {
  const slots = Array.isArray(sample?.slots) ? sample.slots : [];
  return {
    sampleTextChars: Number(sample?.textChars) || 0,
    shapeCount: Array.isArray(sample?.shapes) ? sample.shapes.length : 0,
    textSlots: slots.filter((slot) => slot.type === 'text').length,
    metricGroups: numberedRoleGroups(slots, 'metric'),
    columnGroups: numberedRoleGroups(slots, 'column'),
    stepGroups: numberedRoleGroups(slots, 'step'),
    textArea: Math.round(
      slots
        .filter((slot) => slot.type === 'text')
        .reduce(
          (total, slot) =>
            total + Math.max(0, Number(slot.geometry?.width) || 0) * Math.max(0, Number(slot.geometry?.height) || 0),
          0
        )
    ),
  };
}

export function officeTemplateCoverage(sampleSlides = []) {
  const samples = Array.isArray(sampleSlides) ? sampleSlides : [];
  const kinds = [...new Set(samples.map((sample) => String(sample.kind || '')).filter(Boolean))].sort();
  const densities = [...new Set(samples.map((sample) => String(sample.density || '')).filter(Boolean))].sort();
  const purposes = [...new Set(samples.flatMap((sample) => sample.purposes || []))].sort();
  const expressionModes = [...new Set(samples.flatMap((sample) => sample.expressionModes || []))].sort();
  const capabilities = [...new Set(samples.flatMap((sample) => sample.capabilities || []))].sort();
  const recommendedKinds = ['cover', 'content', 'statement', 'comparison', 'process', 'metrics', 'split', 'closing'];
  const recommendedDensities = ['light', 'balanced', 'dense'];
  const recommendedPurposes = ['compare', 'decide', 'explain', 'monitor'];
  const recommendedExpressionModes = ['conservative', 'strong-fit', 'divergent'];
  return {
    sampleCount: samples.length,
    kinds,
    densities,
    purposes,
    expressionModes,
    capabilities,
    missingKinds: recommendedKinds.filter((kind) => !kinds.includes(kind)),
    missingDensities: recommendedDensities.filter((density) => !densities.includes(density)),
    missingPurposes: recommendedPurposes.filter((purpose) => !purposes.includes(purpose)),
    missingExpressionModes: recommendedExpressionModes.filter((mode) => !expressionModes.includes(mode)),
    nativeObjectCoverage: {
      image: capabilities.includes('image'),
      chart: capabilities.includes('chart'),
      table: capabilities.includes('table'),
      diagram: capabilities.includes('diagram'),
    },
    complete:
      recommendedKinds.every((kind) => kinds.includes(kind)) &&
      recommendedDensities.every((density) => densities.includes(density)) &&
      ['image', 'chart', 'table'].every((capability) => capabilities.includes(capability)),
  };
}
