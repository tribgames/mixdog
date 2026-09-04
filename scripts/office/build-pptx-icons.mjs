// Builds the offline icon set the pptx authoring runtime injects as ICON(name):
// a curated subset of Lucide (ISC) read from the lucide-static dev dependency,
// stored as the icons' inner SVG markup so the kit can render them at any color.
//   node scripts/office/build-pptx-icons.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('lucide-static/package.json'));
const { version, license } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const out = join(dirname(fileURLToPath(import.meta.url)), '../../src/runtime/office/authoring/pptx-icons.json');

// One line per family so a reader can see what the deck can reach for. Names are Lucide's.
export const ICON_NAMES = [
  // direction and process
  'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down', 'arrow-up-right', 'arrow-down-right', 'move-right', 'chevron-right', 'chevrons-right', 'corner-down-right', 'repeat', 'refresh-cw', 'rotate-cw', 'route', 'workflow', 'git-branch', 'git-merge', 'git-fork', 'milestone', 'flag', 'goal', 'target', 'crosshair', 'compass', 'map', 'map-pin', 'navigation', 'footprints', 'play', 'pause', 'square', 'circle', 'timer', 'hourglass', 'clock', 'calendar', 'calendar-check', 'history',
  // data and evidence
  'bar-chart-3', 'bar-chart-4', 'chart-bar', 'chart-column', 'chart-line', 'chart-pie', 'chart-area', 'chart-scatter', 'chart-no-axes-combined', 'trending-up', 'trending-down', 'activity', 'gauge', 'percent', 'hash', 'sigma', 'table', 'table-2', 'database', 'server', 'hard-drive', 'file-text', 'file-check', 'file-search', 'file-bar-chart', 'clipboard-list', 'clipboard-check', 'list-checks', 'list-ordered', 'scale', 'ruler', 'binary', 'calculator',
  // people and organisation
  'user', 'users', 'user-check', 'user-plus', 'user-round', 'users-round', 'contact', 'building', 'building-2', 'factory', 'landmark', 'store', 'briefcase', 'handshake', 'crown', 'award', 'medal', 'trophy', 'graduation-cap', 'presentation', 'megaphone', 'speech', 'message-circle', 'message-square', 'messages-square', 'mail', 'phone', 'headphones', 'mic', 'vote', 'heart-handshake',
  // money and value
  'coins', 'banknote', 'wallet', 'credit-card', 'piggy-bank', 'receipt', 'shopping-cart', 'shopping-bag', 'tag', 'tags', 'ticket', 'badge-dollar-sign', 'circle-dollar-sign', 'dollar-sign', 'euro', 'landmark',
  // technology and product
  'cpu', 'microchip', 'circuit-board', 'bot', 'brain', 'brain-circuit', 'sparkles', 'wand-2', 'code', 'code-2', 'terminal', 'braces', 'bug', 'cloud', 'cloud-upload', 'cloud-download', 'wifi', 'radio', 'satellite', 'smartphone', 'tablet', 'laptop', 'monitor', 'tv', 'camera', 'image', 'video', 'layers', 'layout-grid', 'layout-dashboard', 'component', 'boxes', 'box', 'package', 'container', 'plug', 'zap', 'battery-charging', 'settings', 'settings-2', 'sliders-horizontal', 'wrench', 'hammer', 'cog', 'puzzle', 'blocks', 'link', 'unlink', 'globe', 'network', 'share-2',
  // safety, status, judgement
  'check', 'check-check', 'circle-check', 'circle-x', 'x', 'circle-alert', 'triangle-alert', 'octagon-alert', 'info', 'circle-help', 'shield', 'shield-check', 'shield-alert', 'lock', 'lock-open', 'key', 'key-round', 'eye', 'eye-off', 'fingerprint', 'scan', 'search', 'filter', 'thumbs-up', 'thumbs-down', 'star', 'heart', 'bookmark', 'bell', 'siren', 'life-buoy', 'ban', 'minus', 'plus', 'equal', 'lightbulb', 'flame', 'rocket', 'anchor', 'scale-3d',
  // nature, place, matter
  'sun', 'moon', 'cloud-rain', 'snowflake', 'wind', 'droplet', 'leaf', 'sprout', 'trees', 'mountain', 'waves', 'earth', 'recycle', 'thermometer', 'home', 'warehouse', 'truck', 'ship', 'plane', 'train-front', 'car', 'bike', 'fuel', 'utensils', 'coffee', 'pill', 'stethoscope', 'heart-pulse', 'syringe', 'dna', 'atom', 'flask-conical', 'microscope', 'book-open', 'library', 'pen-line', 'pencil', 'paintbrush', 'palette', 'scissors', 'shapes', 'type', 'quote', 'gem', 'gift', 'umbrella', 'infinity', 'orbit',
];

const icons = {};
const missing = [];
for (const name of [...new Set(ICON_NAMES)]) {
  let svg;
  try { svg = await readFile(join(root, 'icons', `${name}.svg`), 'utf8'); } catch { missing.push(name); continue; }
  const inner = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '')
    .replace(/\s+/g, ' ').replace(/> </g, '><').trim();
  if (!inner) { missing.push(name); continue; }
  icons[name] = inner;
}
if (missing.length) {
  console.error(`missing in lucide-static ${version}: ${missing.join(', ')}`);
  process.exit(1);
}
await writeFile(out, `${JSON.stringify({ source: 'lucide-static', version, license, viewBox: '0 0 24 24', stroke: true, icons }, null, 0)}\n`);
console.log(`${Object.keys(icons).length} icons → ${out}`);
