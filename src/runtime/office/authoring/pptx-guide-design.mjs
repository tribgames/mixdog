// Design half of the authoring guide: how a deck decides its look before a
// single shape is placed. Ordered the way the model should work: brief, style
// family, palette ladder, page rhythm, then what to refuse.

const PALETTES = [
  ['Midnight Executive', '1E2761', 'CADCFC', 'FFFFFF'],
  ['Forest & Moss', '2C5F2D', '97BC62', 'F5F5F5'],
  ['Coral Energy', 'F96167', 'F9E795', '2F3C7E'],
  ['Warm Terracotta', 'B85042', 'E7E8D1', 'A7BEAE'],
  ['Ocean Gradient', '065A82', '1C7293', '21295C'],
  ['Charcoal Minimal', '36454F', 'F2F2F2', '212121'],
  ['Teal Trust', '028090', '00A896', '02C39A'],
  ['Berry & Cream', '6D2E46', 'A26769', 'ECE2D0'],
  ['Sage Calm', '84B59F', '69A297', '50808E'],
  ['Cherry Bold', '990011', 'FCF6F5', '2F3C7E'],
];

export const PPTX_DESIGN_BRIEF_SECTION = `## 1. Write the brief before the script
Decide the whole visual system first and paste it as a comment block at the top of the script, so every re-author keeps the same decisions:
\`\`\`
// BRIEF
// subject/audience/action: <what this deck must make someone do>
// style family: <one of the families below>
// hue: <angle or name> · ladder: ink/body/muted/paper/paperAlt/line · accent: <hex> (accentDeep <hex>)
// motif: <one repeated device> · page chrome: <kicker? page badge? none?>
// density: low|medium|high · rhythm: anchor, dense, breathing, dense, ... , anchor
// slide plan: 1 cover · 2 <layout> · 3 <layout> · ... · N closing
\`\`\`
A deck without a brief drifts into a different look on every slide. If the request is thin, invent a defensible brief from the subject; never leave fields blank.

## 2. Style families (pick one, vary only inside it)
- swiss-grid: strict columns, restrained type, one saturated accent, hairline separators, no decoration off the grid. Technical decks, research, product briefs.
- editorial-contrast: serif display + sans body, asymmetric column split, oversized numerals or crops crossing a column edge, generous outer margins. Narratives, strategy, thought pieces.
- dark-launch: deep background throughout, large type, one luminous accent, images with a 40-55% dark overlay. Keynotes, launches, closing calls to action.
- soft-brief: neutral surfaces, quiet tinted cards, simple diagrams, low saturation. Business introductions, onboarding, status updates.
- matrix-analysis: tables, 2x2s, comparison columns, high label clarity, little illustration. Frameworks, evaluations, decisions.
An 8-10 slide deck uses at most five distinct layouts; the same layout never appears twice in a row.

## 3. Palette ladder
- One hue family per deck. Backgrounds and text sit within ±20° of the main hue; a second hue is allowed only as the accent or a ≤15% area support color.
- Build a neutral ladder plus one accent: ink (titles, L 10-20%), body (L 25-35%), muted (captions, L 40-55%), paperAlt (zebra rows, soft cards, L 88-93%), paper (content background, L 95-98%), line (1 pt hairlines). Then accent (S 60-90%, the only saturated color) and accentDeep (its darker sibling).
- Adjacent ladder steps differ by 10-25% lightness; closer is invisible, wider looks like a jump.
- Saturation by area: large fields ≤20%, text ≤25%, accent 60-90% on ≤10% of the canvas. Pure 000000/FFFFFF pairs read harsh; tint the dark toward the hue (e.g. 0B1B2B) and the light likewise (e.g. F4F7F9).
- Contrast: body text ≥4.5:1, text ≥18 pt or bold ≥14 pt ≥3:1, white on an accent block ≥3:1. Accent is never body text. Meaning never rides on color alone: label or shape it too.
- Temperature by subject: tech/finance cool blues (210-240°), education/growth greens (100-160°), health cyans (170-190°), creative/marketing warm oranges and pinks (10-40°), academic indigos (230-260°). Starting points (primary / secondary / accent): ${PALETTES.map(([name, a, b, c]) => `${name} ${a}/${b}/${c}`).join('; ')}. If the colors would work on any other deck, choose again.

## 4. Page rhythm and canvas
- Assign each slide a role: anchor (cover, section, closing: one statement, lots of air), dense (evidence, tables, grids), breathing (one hero number or one quote, no card grid). Alternate dense and breathing; open and close with anchors; sandwich dark anchors around light content or commit to dark throughout.
- Every slide carries a visual: native chart, image, an icon built from shapes, or a composed figure. Title plus bullets is a draft.
- Fill the frame with intent. Content spans the safe area's width and height; residual blank in one corner is a defect, while air around a focal element is design.
- Choose one motif (rounded frames, icons in tinted circles, an oversized numeral, a bracketed kicker) and repeat it on anchor slides. Repeated page chrome (kicker, footer label, page badge) is fine; a color bar or edge stripe alone is not a motif.
- Hierarchy is carried by size, weight, position, and space together; the most prominent element on the page must be the one the slide is about.

## 5. Refuse
- Cards inside cards, framed panels that carry no information, equal card grids on a breathing page.
- Accent lines under titles, header/footer bars, sidebar stripes, single-side card borders: machine-made filler. Separate with a tint, a hairline, a shadow, or an icon.
- Purple-blue SaaS gradients as the default answer; cream/beige defaults (F5F5DC, FAF0E6, FAEBD7, FFF8E1); rainbow decks with a new color per slide.
- A full-bleed image under title text without a 40-55% scrim; an image that is merely decorative.
- Text-only slides, centered paragraphs, low-contrast text, one styled slide beside plain ones, leftover placeholder copy.
- charSpacing on Hangul or CJK text (it looks broken); keep it for Latin kickers only.`;
