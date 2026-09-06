import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { access } from 'node:fs/promises';
import { loadPackage, partRelationshipPath, zipText } from '../portable/portable-opc.mjs';
import { presentationSlides } from '../portable/portable-pptx-package.mjs';
import { xmlAttribute, xmlDecode } from '../portable/portable-xml.mjs';

const digest = (data) => createHash('sha256').update(data).digest('hex');

// All non-slide resources form a conservative global dependency. A chart,
// theme, font, layout or image edit invalidates every page rather than risk a
// stale visual. Slide-local edits are keyed by the persistent p:sldId.
export async function pptxPageSignatures(path) {
  const zip = await loadPackage(path);
  const slides = await presentationSlides(zip);
  const global = createHash('sha256');
  const slideParts = new Set(slides.flatMap((slide) => [slide.path, partRelationshipPath(slide.path)]));
  for (const name of Object.keys(zip.files).sort()) {
    if (zip.files[name].dir || slideParts.has(name) || name.startsWith('docProps/')) continue;
    global.update(name);
    global.update(await zip.files[name].async('nodebuffer'));
  }
  const seed = global.digest('hex');
  const locals = new Map();
  const links = new Map();
  for (const slide of slides) {
    const xml = await zipText(zip, slide.path);
    const rels = await zipText(zip, partRelationshipPath(slide.path));
    locals.set(slide.path, digest(xml + '\0' + rels));
    const linked = [];
    for (const match of rels.matchAll(/<Relationship\b([^>]+)\/?>/g)) {
      if (xmlAttribute(match[1], 'TargetMode') === 'External') continue;
      const target = xmlDecode(xmlAttribute(match[1], 'Target') || '');
      const resolved = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(posix.dirname(slide.path), target));
      if (slideParts.has(resolved)) linked.push(resolved);
    }
    links.set(slide.path, linked);
  }
  return slides.map((slide, index) => {
    const dependencies = new Set();
    const visit = (path) => {
      if (dependencies.has(path)) return;
      dependencies.add(path);
      for (const linked of links.get(path) || []) visit(linked);
    };
    visit(slide.path);
    return {
      page: index + 1, slideId: slide.id,
      signature: digest(JSON.stringify([seed, index, [...dependencies].sort().map((path) => [path, locals.get(path)])])),
    };
  });
}

export async function reusablePptxPages(cache, signatures, request) {
  const images = new Map();
  if (!cache || cache.maxWidth !== request.maxWidth || cache.output !== request.output) return images;
  for (const entry of signatures) {
    const prior = cache.pages.find((page) => page.slideId === entry.slideId && page.signature === entry.signature);
    if (!prior?.image?.data || !prior.image.path) continue;
    try { await access(prior.image.path); } catch { continue; }
    images.set(entry.page, { ...structuredClone(prior.image), page: entry.page });
  }
  return images;
}

export function completePageCoverage(total, pages) {
  const reviewedPages = [...new Set(pages)].sort((a, b) => a - b);
  const remainingPages = Array.from({ length: total }, (_, index) => index + 1).filter((page) => !reviewedPages.includes(page));
  return { mode: 'pages', total, reviewed: reviewedPages.length, reviewedPages, remainingPages, complete: remainingPages.length === 0 };
}
