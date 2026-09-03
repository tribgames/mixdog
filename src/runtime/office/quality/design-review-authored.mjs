// Rules that must hold for authored (script) decks as well as composed ones.
// A composed deck carries slide plans and the design tokens it was drawn with;
// an authored deck carries neither, so these helpers read the deck's own
// ladder and geometry instead of the composer's plan.

const DEFAULT_SLIDE = { width: 960, height: 540 };  // LAYOUT_WIDE in points
const EDGE_ZONE = 60;                                 // pt from the slide edge that reads as page chrome
const UNDER_TITLE_GAP = 40;                           // pt below a title that reads as an accent rule
const HANGING_GUTTER = 40;                            // pt between a vertical rule and the text hanging from it
const TITLE_SIZE = 24;
const ROW_TOLERANCE = 6;                              // pt; same top or left means the same grid line
const CARD_MIN_HEIGHT = 60;                           // pt; anything shorter is a label, not a card
const CARD_MIN_TEXT = 20;                             // chars; cards carry copy, nodes carry names

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function slideSize(document) {
  const width = num(document?.slideWidth) || DEFAULT_SLIDE.width;
  const height = num(document?.slideHeight) || DEFAULT_SLIDE.height;
  return { width, height };
}

// The deck's own background ladder: the cover color is the inverse field and
// the most common remaining color is the canvas. Returns null when the deck
// shares any background with the design tokens, in which case the composer's
// plan applies instead.
export function authoredBackgroundLadder(backgrounds, tokenColors) {
  const tokens = new Set(Object.values(tokenColors || {}).map((color) => String(color || '').toUpperCase()).filter(Boolean));
  if (backgrounds.some((color) => tokens.has(color))) return null;
  const [cover, ...rest] = backgrounds;
  const counts = new Map();
  for (const color of rest) counts.set(color, (counts.get(color) || 0) + 1);
  const canvas = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || cover;
  return { inverse: cover, canvas };
}

// A thin rule is ornamentation when it hugs a slide edge or underlines a title;
// a hairline separating two rows of content is a separator, not a stripe.
export function isOrnamentalStripe(shape, shapes, size) {
  const width = num(shape.width);
  const height = num(shape.height);
  const left = num(shape.left);
  const top = num(shape.top);
  const vertical = width <= 14 && height >= 180;
  const horizontal = height <= 7 && width >= 320;
  if (!vertical && !horizontal) return false;
  if (vertical) {
    // A vertical rule that text hangs from (editorial carrier) is scoped to its
    // block: at most half the page tall, with text starting within a small
    // gutter and overlapping it. A page-height edge stripe is ornament.
    const hanging = height <= size.height * 0.5 && shapes.some((other) => {
      if (other === shape || !String(other.text || '').trim()) return false;
      const gutter = num(other.left) - (left + width);
      const overlap = Math.min(top + height, num(other.top) + num(other.height)) - Math.max(top, num(other.top));
      return gutter >= 0 && gutter <= HANGING_GUTTER && overlap > 0;
    });
    if (hanging) return false;
    return left < EDGE_ZONE || left + width > size.width - EDGE_ZONE;
  }
  if (top < EDGE_ZONE || top + height > size.height - EDGE_ZONE) return true;
  if (width >= size.width * 0.95) return true;
  return shapes.some((other) => {
    if (other === shape || !String(other.text || '').trim()) return false;
    if (num(other.font?.size) < TITLE_SIZE) return false;
    const bottom = num(other.top) + num(other.height);
    return top >= bottom - 4 && top <= bottom + UNDER_TITLE_GAP;
  });
}

// A card grid is three or more same-size filled surfaces on one grid line,
// each carrying copy (its own or a text box inside it). Nodes, hero numbers,
// stage labels, staggered blocks, and unfilled text columns share a size
// without being cards. Snapshots without fill data fall back to text blocks.
function contains(surface, shape) {
  return num(shape.left) >= num(surface.left) - 2
    && num(shape.top) >= num(surface.top) - 2
    && num(shape.left) + num(shape.width) <= num(surface.left) + num(surface.width) + 2
    && num(shape.top) + num(shape.height) <= num(surface.top) + num(surface.height) + 2;
}

export function isCardGridSlide(textShapes, allShapes = null) {
  const shapes = Array.isArray(allShapes) ? allShapes : textShapes;
  const fillKnown = shapes.some((shape) => shape.fill);
  const copy = (shape) => String(shape.text || '').trim().length >= CARD_MIN_TEXT;
  const cards = fillKnown
    ? shapes.filter((surface) => surface.fill && num(surface.height) >= CARD_MIN_HEIGHT
      && (copy(surface) || textShapes.some((shape) => shape !== surface && copy(shape) && contains(surface, shape))))
    : textShapes.filter((shape) => num(shape.height) >= CARD_MIN_HEIGHT && copy(shape));
  const groups = new Map();
  for (const shape of cards) {
    const key = `${Math.round(num(shape.width) / 12)}:${Math.round(num(shape.height) / 12)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(shape);
  }
  for (const members of groups.values()) {
    if (members.length < 3) continue;
    const aligned = (axis) => {
      const lines = new Map();
      for (const shape of members) {
        const value = Math.round(num(shape[axis]) / ROW_TOLERANCE);
        lines.set(value, (lines.get(value) || 0) + 1);
      }
      return Math.max(...lines.values()) >= 3;
    };
    if (aligned('top') || aligned('left')) return true;
  }
  return false;
}
