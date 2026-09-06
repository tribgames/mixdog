// The offline icon set an authoring script reaches through ICON(name): a
// curated Lucide subset (scripts/office/build-pptx-icons.mjs) stored as inner
// SVG markup, so the kit rasterizes it with sharp at any color and size and the
// deck never needs a network or an icon library at runtime.
import { readFileSync } from 'node:fs';

let set = null;
function icons() {
  if (!set) set = JSON.parse(readFileSync(new URL('./pptx-icons.json', import.meta.url), 'utf8'));
  return set;
}

function nearest(name, names) {
  const wanted = String(name || '').toLowerCase();
  const parts = wanted.split(/[-_ ]+/).filter(Boolean);
  const compact = wanted.replace(/[-_ ]/g, '');
  const scored = names.map((candidate) => {
    let score = 0;
    const flat = candidate.replace(/-/g, '');
    if (candidate.includes(wanted) || wanted.includes(candidate) || flat.includes(compact) || compact.includes(flat)) score += 3;
    for (const part of parts) if (candidate.split('-').includes(part)) score += 2; else if (candidate.includes(part)) score += 1;
    return { candidate, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate));
  return scored.slice(0, 8).map((entry) => entry.candidate);
}

function iconMarkup(name) {
  const { icons: table } = icons();
  const key = String(name || '').trim().toLowerCase();
  const markup = table[key];
  if (markup) return markup;
  const names = Object.keys(table);
  const hint = nearest(key, names);
  throw new Error(`ICON('${name}') is not in the icon set (${names.length} Lucide icons).${hint.length ? ` Nearest: ${hint.join(', ')}.` : ''} ICON.names lists them all.`);
}

// Whole SVG at a pixel size: stroke icons take the color as stroke.
function iconSvg(name, { color = '000000', size = 96, strokeWidth = 2 } = {}) {
  const hex = String(color).replace(/^#/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${icons().viewBox}" fill="none" stroke="#${hex}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${iconMarkup(name)}</svg>`;
}

// The script-facing global.
export function iconGlobal() {
  const fn = (name) => iconMarkup(name);
  fn.svg = iconSvg;
  Object.defineProperty(fn, 'names', { get: () => Object.keys(icons().icons) });
  fn.source = `${icons().source} ${icons().version} (${icons().license})`;
  return fn;
}
