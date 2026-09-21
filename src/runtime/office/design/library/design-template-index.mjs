import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import JSZip from 'jszip';
import {
  SCHEMA_VERSION,
  TEMPLATE_FORMATS,
  TEMPLATE_INSPECTOR_VERSION,
  canonicalPath,
  libraryPaths,
  loadConfig,
  readJson,
  safeId,
  sha256File,
  writeJsonAtomic,
} from './design-library-core.mjs';
import { normalizeLayouts, normalizeLocalSamples } from './design-library-pack.mjs';
import { inducePptxSampleRoles } from './design-template-induct.mjs';
import {
  directPptxShapeBlocks,
  inferPptxSampleKind,
  officeTemplateCoverage,
  pptxSampleCapacity,
  pptxShapeMetadata,
  pptxSlideEntries,
  pptxSlot,
  walkTemplateDirectory,
  xmlAttribute,
} from './design-template-inspect.mjs';
import { plainObject, sha256 } from '../../shared/values.mjs';
import { xmlDecode } from '../../portable/portable-xml.mjs';
import { zipText } from '../../portable/portable-opc.mjs';

function slideDensity(textChars, shapeCount) {
  if (textChars > 340 || shapeCount > 16) return 'dense';
  if (textChars > 120 || shapeCount > 8) return 'balanced';
  return 'light';
}

const numberFromPath = (value) => Number(/(\d+)(?=\.xml$)/.exec(value)?.[1] || 0);

const shapeSlots = (shapes) => shapes.flatMap((shape) => (shape.slot ? [shape.slot] : []));

function pptxSampleSlide({ slide, part }, xml) {
  const shapes = directPptxShapeBlocks(xml).map((block, index) => pptxShapeMetadata(block, index + 1));
  const textChars = shapes.reduce((total, shape) => total + shape.text.length, 0);
  const title =
    shapes.find((shape) => ['title', 'ctrTitle'].includes(shape.placeholderType))?.text ||
    shapes.find((shape) => shape.slot?.role === 'title')?.text ||
    '';
  return {
    slide,
    part,
    title,
    textChars,
    density: slideDensity(textChars, shapes.length),
    shapes,
    slots: shapeSlots(shapes),
    capabilities: [...new Set(shapes.map((shape) => shape.type).filter((type) => type !== 'text'))],
  };
}

// A drawn page answers with geometry where it has no placeholder to answer
// with; a role the file states itself always wins over the induced one.
function refinePptxSample(sample, canvas, sampleCount) {
  const induced = inducePptxSampleRoles(sample, canvas);
  for (const shape of sample.shapes) {
    const role = induced.get(shape.shape);
    if (!role || (shape.slot && !/^body-\d+$/.test(shape.slot.role))) continue;
    shape.slot = pptxSlot(shape, role);
  }
  sample.slots = shapeSlots(sample.shapes);
  sample.title ||= sample.shapes.find((shape) => shape.slot?.role === 'title')?.text || '';
  sample.kind = inferPptxSampleKind(sample, sampleCount);
  sample.capacity = pptxSampleCapacity(sample);
}

function pptxNativeLayout(name, xml) {
  const root = /<p:sldLayout\b[^>]*>/i.exec(xml)?.[0] || '';
  const common = /<p:cSld\b[^>]*>/i.exec(xml)?.[0] || '';
  const shapes = directPptxShapeBlocks(xml).map((block, index) => pptxShapeMetadata(block, index + 1));
  return {
    layout: numberFromPath(name),
    name: xmlAttribute(common, 'name'),
    type: xmlAttribute(root, 'type'),
    slots: shapeSlots(shapes),
  };
}

function pptxThemeSummary(xml) {
  const root = /<a:theme\b[^>]*>/i.exec(xml)?.[0] || '';
  const fonts = [...xml.matchAll(/<a:(?:latin|ea|cs)\b[^>]*\btypeface="([^"]*)"/gi)]
    .map((match) => xmlDecode(match[1]))
    .filter(Boolean);
  return { name: xmlAttribute(root, 'name'), fonts: [...new Set(fonts)] };
}

export async function inspectOfficeTemplate(path, { format = '' } = {}) {
  const normalizedFormat = format || TEMPLATE_FORMATS[extname(path).toLowerCase()] || '';
  if (normalizedFormat !== 'pptx') return { sampleSlides: [], nativeLayouts: [], theme: null };
  const zip = await JSZip.loadAsync(await readFile(path));
  const names = Object.keys(zip.files);
  const sampleSlides = [];
  for (const entry of await pptxSlideEntries(zip)) {
    sampleSlides.push(pptxSampleSlide(entry, await zip.file(entry.name).async('string')));
  }
  const slideSize = /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i.exec(await zipText(zip, 'ppt/presentation.xml'));
  const canvas = slideSize ? { width: Number(slideSize[1]), height: Number(slideSize[2]) } : undefined;
  for (const sample of sampleSlides) refinePptxSample(sample, canvas, sampleSlides.length);
  const layoutNames = names
    .filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(name))
    .sort((left, right) => numberFromPath(left) - numberFromPath(right));
  const nativeLayouts = [];
  for (const name of layoutNames) nativeLayouts.push(pptxNativeLayout(name, await zip.file(name).async('string')));
  const themeName = names.find((name) => /^ppt\/theme\/theme\d+\.xml$/i.test(name));
  const theme = themeName ? pptxThemeSummary(await zip.file(themeName).async('string')) : null;
  return {
    sampleSlides,
    nativeLayouts,
    theme,
    coverage: officeTemplateCoverage(sampleSlides),
  };
}

function normalizeLocalMetadata(value, path) {
  if (!plainObject(value)) return {};
  return {
    ...(value.id ? { id: safeId(value.id, 'local template id') } : {}),
    label: String(value.label || ''),
    profile: value.profile ? safeId(value.profile, 'local template profile') : '',
    version: String(value.version || ''),
    layouts: normalizeLayouts(value.layouts || [], { templatePath: path }),
    samples: normalizeLocalSamples(value.samples || []),
  };
}

// A previous index entry still describes the file when neither the file, its
// sidecar, nor the inspector changed.
function templateEntryUnchanged(previousEntry, details, sidecarDetails) {
  return (
    previousEntry &&
    Number(previousEntry.bytes) === details.size &&
    Number(previousEntry.mtimeMs) === details.mtimeMs &&
    Number(previousEntry.sidecarMtimeMs || 0) === Number(sidecarDetails?.mtimeMs || 0) &&
    Number(previousEntry.inspectionVersion || 0) === TEMPLATE_INSPECTOR_VERSION
  );
}

// Sidecar role assignments name the slots by shape index; without them the
// inspected slots stand.
function sampleSlots(sample, sampleMetadata) {
  if (!sampleMetadata || !Object.keys(sampleMetadata.roles).length) return sample.slots;
  return Object.entries(sampleMetadata.roles).map(([shapeIndex, role]) => {
    const shape = sample.shapes.find((entry) => entry.shape === Number(shapeIndex));
    if (!shape) {
      throw new Error(`Office local template sample ${sample.slide} references missing shape ${shapeIndex}`);
    }
    return pptxSlot(shape, role);
  });
}

// One layout per inspected sample slide, overlaid with its sidecar sample.
function sampleLayouts(inspected, metadata, { id, path }) {
  return inspected.sampleSlides.map((sample) => {
    const sampleMetadata = metadata.samples.find((entry) => entry.slide === sample.slide);
    return {
      id: sampleMetadata?.id || `${id}-slide-${sample.slide}`,
      format: 'pptx',
      kind: sampleMetadata?.kind || sample.kind,
      profile: metadata.profile,
      density: sampleMetadata?.density || sample.density,
      variant: sampleMetadata?.variant || 'native',
      purposes: sampleMetadata?.purposes || [],
      expressionModes: sampleMetadata?.expressionModes || [],
      templateId: id,
      templatePath: path,
      sourceSlide: sample.slide,
      sourceLayout: 0,
      slots: sampleSlots(sample, sampleMetadata),
      capacity: {
        ...sample.capacity,
        ...(sampleMetadata?.capacity || {}),
      },
      capabilities: sample.capabilities,
      priority: sampleMetadata?.priority || 0,
      strict: sampleMetadata?.strict || false,
      defaults: sampleMetadata?.defaults || {},
    };
  });
}

// Sidecar-declared layouts, filled from their source slide where they leave
// slots, capacity or capabilities unspecified.
function declaredLayouts(metadata, inspected, { id, path }) {
  return metadata.layouts.map((layout) => {
    const sample = inspected.sampleSlides.find((entry) => entry.slide === layout.sourceSlide);
    return {
      ...layout,
      templateId: layout.templateId || id,
      templatePath: path,
      slots: layout.slots.length ? layout.slots : sample?.slots || [],
      capacity: Object.keys(layout.capacity || {}).length ? layout.capacity : sample?.capacity || {},
      capabilities: layout.capabilities.length ? layout.capabilities : sample?.capabilities || [],
    };
  });
}

function indexedSampleSlides(inspected, layouts) {
  return inspected.sampleSlides.map((sample) => {
    const layout = layouts.find((entry) => entry.sourceSlide === sample.slide);
    const titleShape = sample.shapes.find((shape) =>
      layout?.slots.some((slot) => slot.role === 'title' && slot.shape === shape.shape)
    );
    return {
      ...sample,
      title: sample.title || titleShape?.text || '',
      kind: layout?.kind || sample.kind,
      density: layout?.density || sample.density,
      purposes: layout?.purposes || [],
      expressionModes: layout?.expressionModes || [],
      slots: layout?.slots || sample.slots,
      capacity: layout?.capacity || sample.capacity,
    };
  });
}

async function inspectTemplateFile(path, format) {
  try {
    return { inspected: await inspectOfficeTemplate(path, { format }), inspectionWarning: '' };
  } catch (error) {
    return {
      inspected: { sampleSlides: [], nativeLayouts: [], theme: null, coverage: officeTemplateCoverage([]) },
      inspectionWarning: error?.message || String(error),
    };
  }
}

// A fresh index entry for one template file.
async function indexTemplateFile(path, { details, sidecarPath, sidecarDetails }) {
  const canonical = canonicalPath(path);
  const digest = await sha256File(path);
  const metadata = normalizeLocalMetadata(await readJson(sidecarPath, {}), path);
  const id = metadata.id || `local-${sha256(canonical).slice(0, 16)}`;
  const format = TEMPLATE_FORMATS[extname(path).toLowerCase()];
  const { inspected, inspectionWarning } = await inspectTemplateFile(path, format);
  const layouts = metadata.layouts.length
    ? declaredLayouts(metadata, inspected, { id, path })
    : sampleLayouts(inspected, metadata, { id, path });
  const sampleSlides = indexedSampleSlides(inspected, layouts);
  return {
    id,
    label: metadata.label || path.split(/[\\/]/).at(-1),
    format,
    fileKind: extname(path).slice(1).toLowerCase(),
    path: resolve(path),
    source: 'local-template',
    bytes: details.size,
    mtimeMs: details.mtimeMs,
    sidecarMtimeMs: Number(sidecarDetails?.mtimeMs || 0),
    inspectionVersion: TEMPLATE_INSPECTOR_VERSION,
    inspectionWarning,
    sha256: digest,
    version: metadata.version ? `${metadata.version}+${digest.slice(0, 12)}` : digest.slice(0, 16),
    profile: metadata.profile,
    layouts,
    sampleSlides,
    coverage: officeTemplateCoverage(sampleSlides),
    nativeLayouts: inspected.nativeLayouts,
    theme: inspected.theme,
  };
}

export async function indexOfficeTemplates({ dataDir, config: configOverride = null } = {}) {
  const paths = libraryPaths(dataDir);
  const config = await loadConfig(dataDir, configOverride);
  await mkdir(paths.templates, { recursive: true });
  const previous = await readJson(paths.templateIndex, { templates: [] });
  const previousByPath = new Map((previous.templates || []).map((entry) => [canonicalPath(entry.path), entry]));
  const files = [];
  for (const directory of config.templateDirectories) await walkTemplateDirectory(directory, files);
  const templates = [];
  for (const path of files) {
    const details = await stat(path);
    const sidecarPath = `${path}.mixdog.json`;
    const sidecarDetails = await stat(sidecarPath).catch(() => null);
    const previousEntry = previousByPath.get(canonicalPath(path));
    if (templateEntryUnchanged(previousEntry, details, sidecarDetails)) {
      templates.push(previousEntry);
      continue;
    }
    templates.push(await indexTemplateFile(path, { details, sidecarPath, sidecarDetails }));
  }
  templates.sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
  const revision = sha256(
    JSON.stringify(templates.map((entry) => [entry.id, entry.path, entry.sha256, entry.sidecarMtimeMs]))
  );
  const changed = revision !== previous.revision;
  const index = {
    schemaVersion: SCHEMA_VERSION,
    indexedAt: new Date().toISOString(),
    revision,
    directories: config.templateDirectories,
    templates,
  };
  if (changed || !previous.revision) await writeJsonAtomic(paths.templateIndex, index);
  return {
    ...index,
    changed,
    count: templates.length,
  };
}

export async function readTemplateIndex(paths) {
  return await readJson(paths.templateIndex, {
    schemaVersion: SCHEMA_VERSION,
    revision: '',
    templates: [],
  });
}

export async function writeState(paths, state) {
  await writeJsonAtomic(paths.state, {
    schemaVersion: SCHEMA_VERSION,
    ...state,
  });
}
