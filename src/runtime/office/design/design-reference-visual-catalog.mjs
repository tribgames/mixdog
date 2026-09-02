import { extname } from 'node:path';
import { compact, plainObject } from '../shared/values.mjs';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_REFERENCES = 200;

function strings(value) {
  return [...new Set((Array.isArray(value) ? value : [value])
    .map((entry) => compact(entry, 80).toLowerCase())
    .filter(Boolean))];
}

function overlap(left, right) {
  const expected = new Set(right);
  if (!expected.size) return 0;
  return left.filter((entry) => expected.has(entry)).length / expected.size;
}

function normalizedSemantic(raw = {}) {
  const source = plainObject(raw) ? raw : {};
  return {
    roles: strings(source.roles || source.role),
    visualTypes: strings(source.visualTypes || source.visualType),
    densities: strings(source.densities || source.density),
    domains: strings(source.domains || source.domain),
    tags: strings(source.tags),
  };
}

function normalizedEntry(raw, index, resolvePath) {
  if (!plainObject(raw)) throw new Error(`PPTX reference ${index + 1} must be an object.`);
  const id = compact(raw.id || `reference-${index + 1}`, 80);
  const requestedPath = compact(raw.imagePath || raw.path, 1_000);
  if (!requestedPath) throw new Error(`PPTX reference "${id}" requires imagePath.`);
  const imagePath = typeof resolvePath === 'function' ? resolvePath(requestedPath) : requestedPath;
  if (!IMAGE_EXTENSIONS.has(extname(imagePath).toLowerCase())) {
    throw new Error(`PPTX reference "${id}" must use a PNG, JPEG, or WebP slide image.`);
  }
  const semantic = normalizedSemantic(raw.semantic || raw);
  if (!semantic.roles.length || !semantic.visualTypes.length) {
    throw new Error(`PPTX reference "${id}" requires semantic role and visualType metadata.`);
  }
  return {
    id,
    imagePath,
    source: compact(raw.source || raw.deck || '', 240),
    slide: Math.max(1, Number(raw.slide) || 1),
    semantic,
    quality: Math.min(1, Math.max(0, Number(raw.quality) || 0.5)),
    provenance: compact(raw.provenance || raw.license || '', 240),
    coordinatePolicy: 'inspiration-only',
  };
}

export function compilePptxReferenceVisualCatalog(input = [], {
  resolvePath = null,
} = {}) {
  const rawEntries = Array.isArray(input)
    ? input
    : plainObject(input) && Array.isArray(input.entries)
      ? input.entries
      : [];
  if (!rawEntries.length) {
    throw new Error('Reference-assisted PPTX design requires at least one rendered slide image with semantic metadata.');
  }
  if (rawEntries.length > MAX_REFERENCES) {
    throw new Error(`PPTX reference catalog accepts at most ${MAX_REFERENCES} entries per preview.`);
  }
  const entries = rawEntries.map((entry, index) => normalizedEntry(entry, index, resolvePath));
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`PPTX reference id is duplicated: ${entry.id}`);
    ids.add(entry.id);
  }
  return {
    version: 1,
    contract: 'reference-visual-catalog-v1',
    coordinatePolicy: 'inspiration-only',
    entryCount: entries.length,
    entries,
  };
}

export function retrievePptxVisualReferences(catalog, query = {}, {
  limit = 3,
} = {}) {
  const semantic = normalizedSemantic(query);
  const scored = (catalog?.entries || []).map((entry, index) => {
    const role = overlap(entry.semantic.roles, semantic.roles);
    const visual = overlap(entry.semantic.visualTypes, semantic.visualTypes);
    const density = overlap(entry.semantic.densities, semantic.densities);
    const domain = overlap(entry.semantic.domains, semantic.domains);
    const tags = overlap(entry.semantic.tags, semantic.tags);
    const score = (
      (role * 0.3)
      + (visual * 0.3)
      + (domain * 0.15)
      + (density * 0.1)
      + (tags * 0.1)
      + (entry.quality * 0.05)
    );
    return { entry, score, index };
  }).sort((left, right) => (
    right.score - left.score
      || right.entry.quality - left.entry.quality
      || left.index - right.index
      || left.entry.id.localeCompare(right.entry.id)
  ));
  return scored.slice(0, Math.max(1, Math.min(3, Number(limit) || 3))).map(({ entry, score }) => ({
    ...entry,
    matchScore: Number(score.toFixed(4)),
  }));
}

export function summarizePptxReferenceVisualCatalog(catalog) {
  return {
    version: catalog?.version || 1,
    contract: catalog?.contract || 'reference-visual-catalog-v1',
    coordinatePolicy: 'inspiration-only',
    entryCount: catalog?.entries?.length || 0,
    entries: (catalog?.entries || []).map((entry) => ({
      id: entry.id,
      source: entry.source,
      slide: entry.slide,
      semantic: entry.semantic,
      quality: entry.quality,
      provenance: entry.provenance,
    })),
  };
}
