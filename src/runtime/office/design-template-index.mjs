import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import JSZip from 'jszip';
import { SCHEMA_VERSION, TEMPLATE_FORMATS, TEMPLATE_INSPECTOR_VERSION, canonicalPath, libraryPaths, loadConfig, plainObject, readJson, safeId, sha256, sha256File, writeJsonAtomic } from './design-library-core.mjs';
import { normalizeLayouts, normalizeLocalSamples } from './design-library-pack.mjs';
import { directPptxShapeBlocks, inferPptxSampleKind, officeTemplateCoverage, pptxSampleCapacity, pptxShapeMetadata, pptxSlideEntries, walkTemplateDirectory, xmlAttribute, xmlDecode } from './design-template-inspect.mjs';

export async function inspectOfficeTemplate(path, { format = '' } = {}) {
  const normalizedFormat = format || TEMPLATE_FORMATS[extname(path).toLowerCase()] || '';
  if (normalizedFormat !== 'pptx') return { sampleSlides: [], nativeLayouts: [], theme: null };
  const zip = await JSZip.loadAsync(await readFile(path));
  const names = Object.keys(zip.files);
  const numberFromPath = (value) => Number(/(\d+)(?=\.xml$)/.exec(value)?.[1] || 0);
  const slideEntries = await pptxSlideEntries(zip);
  const sampleSlides = [];
  for (const { name, slide, part } of slideEntries) {
    const xml = await zip.file(name).async('string');
    const shapes = directPptxShapeBlocks(xml).map((block, index) => pptxShapeMetadata(block, index + 1));
    const slots = shapes.flatMap((shape) => shape.slot ? [shape.slot] : []);
    const textChars = shapes.reduce((total, shape) => total + shape.text.length, 0);
    const title = shapes.find((shape) => ['title', 'ctrTitle'].includes(shape.placeholderType))?.text
      || shapes.find((shape) => shape.slot?.role === 'title')?.text
      || '';
    const capabilities = [...new Set(shapes.map((shape) => shape.type).filter((type) => type !== 'text'))];
    sampleSlides.push({
      slide,
      part,
      title,
      textChars,
      density: textChars > 340 || shapes.length > 16 ? 'dense' : textChars > 120 || shapes.length > 8 ? 'balanced' : 'light',
      shapes,
      slots,
      capabilities,
    });
  }
  for (const sample of sampleSlides) {
    sample.kind = inferPptxSampleKind(sample, sampleSlides.length);
    sample.capacity = pptxSampleCapacity(sample);
  }
  const layoutNames = names
    .filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(name))
    .sort((left, right) => numberFromPath(left) - numberFromPath(right));
  const nativeLayouts = [];
  for (const name of layoutNames) {
    const xml = await zip.file(name).async('string');
    const root = /<p:sldLayout\b[^>]*>/i.exec(xml)?.[0] || '';
    const common = /<p:cSld\b[^>]*>/i.exec(xml)?.[0] || '';
    const shapes = directPptxShapeBlocks(xml).map((block, index) => pptxShapeMetadata(block, index + 1));
    nativeLayouts.push({
      layout: numberFromPath(name),
      name: xmlAttribute(common, 'name'),
      type: xmlAttribute(root, 'type'),
      slots: shapes.flatMap((shape) => shape.slot ? [shape.slot] : []),
    });
  }
  const themeName = names.find((name) => /^ppt\/theme\/theme\d+\.xml$/i.test(name));
  let theme = null;
  if (themeName) {
    const xml = await zip.file(themeName).async('string');
    const root = /<a:theme\b[^>]*>/i.exec(xml)?.[0] || '';
    theme = {
      name: xmlAttribute(root, 'name'),
      fonts: [...new Set([...xml.matchAll(/<a:(?:latin|ea|cs)\b[^>]*\btypeface="([^"]*)"/gi)]
        .map((match) => xmlDecode(match[1]))
        .filter(Boolean))],
    };
  }
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


export async function indexOfficeTemplates({
  dataDir,
  config: configOverride = null,
} = {}) {
  const paths = libraryPaths(dataDir);
  const config = await loadConfig(dataDir, configOverride);
  await mkdir(paths.templates, { recursive: true });
  const previous = await readJson(paths.templateIndex, { templates: [] });
  const previousByPath = new Map((previous.templates || []).map((entry) => [canonicalPath(entry.path), entry]));
  const files = [];
  for (const directory of config.templateDirectories) await walkTemplateDirectory(directory, files);
  const templates = [];
  for (const path of files) {
    const canonical = canonicalPath(path);
    const details = await stat(path);
    const sidecarPath = `${path}.mixdog.json`;
    const sidecarDetails = await stat(sidecarPath).catch(() => null);
    const previousEntry = previousByPath.get(canonical);
    const unchanged = previousEntry
      && Number(previousEntry.bytes) === details.size
      && Number(previousEntry.mtimeMs) === details.mtimeMs
      && Number(previousEntry.sidecarMtimeMs || 0) === Number(sidecarDetails?.mtimeMs || 0)
      && Number(previousEntry.inspectionVersion || 0) === TEMPLATE_INSPECTOR_VERSION;
    if (unchanged) {
      templates.push(previousEntry);
      continue;
    }
    const digest = await sha256File(path);
    const metadata = normalizeLocalMetadata(await readJson(sidecarPath, {}), path);
    const id = metadata.id || `local-${sha256(canonical).slice(0, 16)}`;
    const format = TEMPLATE_FORMATS[extname(path).toLowerCase()];
    let inspected = {
      sampleSlides: [],
      nativeLayouts: [],
      theme: null,
      coverage: officeTemplateCoverage([]),
    };
    let inspectionWarning = '';
    try {
      inspected = await inspectOfficeTemplate(path, { format });
    } catch (error) {
      inspectionWarning = error?.message || String(error);
    }
    const autoLayouts = inspected.sampleSlides.map((sample) => {
      const sampleMetadata = metadata.samples.find((entry) => entry.slide === sample.slide);
      const slots = sampleMetadata && Object.keys(sampleMetadata.roles).length
        ? Object.entries(sampleMetadata.roles).map(([shapeIndex, role]) => {
            const shape = sample.shapes.find((entry) => entry.shape === Number(shapeIndex));
            if (!shape) {
              throw new Error(`Office local template sample ${sample.slide} references missing shape ${shapeIndex}`);
            }
            return {
              role,
              type: shape.type,
              shape: shape.shape,
              ...(shape.placeholderType ? { placeholderType: shape.placeholderType } : {}),
              ...(Number.isInteger(shape.placeholderIndex) ? { placeholderIndex: shape.placeholderIndex } : {}),
              geometry: shape.geometry,
              required: role === 'title',
            };
          })
        : sample.slots;
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
        slots,
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
    const layouts = metadata.layouts.length
      ? metadata.layouts.map((layout) => {
          const sample = inspected.sampleSlides.find((entry) => entry.slide === layout.sourceSlide);
          return {
            ...layout,
            templateId: layout.templateId || id,
            templatePath: path,
            slots: layout.slots.length ? layout.slots : sample?.slots || [],
            capacity: Object.keys(layout.capacity || {}).length ? layout.capacity : sample?.capacity || {},
            capabilities: layout.capabilities.length ? layout.capabilities : sample?.capabilities || [],
          };
        })
      : autoLayouts;
    const indexedSampleSlides = inspected.sampleSlides.map((sample) => {
      const layout = layouts.find((entry) => entry.sourceSlide === sample.slide);
      const titleShape = sample.shapes.find((shape) => (
        layout?.slots.some((slot) => slot.role === 'title' && slot.shape === shape.shape)
      ));
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
    const coverage = officeTemplateCoverage(indexedSampleSlides);
    templates.push({
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
      sampleSlides: indexedSampleSlides,
      coverage,
      nativeLayouts: inspected.nativeLayouts,
      theme: inspected.theme,
    });
  }
  templates.sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
  const revision = sha256(JSON.stringify(templates.map((entry) => [
    entry.id,
    entry.path,
    entry.sha256,
    entry.sidecarMtimeMs,
  ])));
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
