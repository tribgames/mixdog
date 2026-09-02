// The design guide the model reads before authoring a deck as a pptxgenjs
// script. It carries taste (palette, hierarchy, layout variety) and the
// library footguns that corrupt files; the runtime only checks what a script
// cannot see for itself (package integrity, rendered pages).

export const PPTX_AUTHORING_WORKFLOW = [
  'author with a pptxgenjs script (one `new pptxgen()`; finish with `await pres.writeFile({ fileName: OUTPUT })`).',
  'render every slide and look at each image before judging anything.',
  'fix defects in the script, author again with overwrite:true, render again.',
  'finalize with design: { reviewed: true, reviewToken, critique: [one entry per slide] }.',
];

export const PPTX_SCRIPT_CONTRACT = {
  runtime: 'CommonJS body executed in-process; top-level await is allowed.',
  globals: ['require', 'OUTPUT', 'console', 'Buffer', 'process.env'],
  require: ['pptxgenjs', 'sharp', 'node:fs', 'node:path', 'node:buffer'],
  output: 'Write exactly one file at OUTPUT; the runtime opens it as the session document.',
  timeoutMs: 90_000,
};

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

export const PPTX_AUTHORING_GUIDE = `# PPTX authoring guide (pptxgenjs)

## Script contract
- \`const pptxgen = require('pptxgenjs'); const pres = new pptxgen();\` once per file.
- Set \`pres.layout = 'LAYOUT_WIDE'\` (13.33 x 7.5 in) before adding slides. Coordinates are inches; anything past the edge is written but invisible.
- End with \`await pres.writeFile({ fileName: OUTPUT });\`. OUTPUT is injected; never hard-code a path.
- Speaker notes: \`slide.addNotes('...')\`. Never put notes in a text box.

## Library footguns (each one corrupts or silently breaks the file)
- Colors are 6 hex digits without '#'. Alpha in the hex corrupts the file; use \`transparency: 0-100\` on fills.
- Build a fresh options object for every add* call; the library rewrites option objects in place.
- Shadow \`offset\` must be >= 0. Cast upward with \`angle: 270\`.
- \`letterSpacing\` is ignored; the option is \`charSpacing\`.
- Bullets: \`bullet: true\` per item and \`breakLine: true\` on every item but the last. Never type a literal bullet character. Space paragraphs with \`paraSpaceAfter\`, not \`lineSpacing\`.
- \`rectRadius\` only applies to \`ROUNDED_RECTANGLE\`.
- Gradient fills are unsupported; use a gradient image as background.
- Text boxes carry internal padding; set \`margin: 0\` when text must align with a shape edge.
- Charts stay native via \`addChart\`. Style them: \`showTitle\`, \`showValue\`, \`dataLabelPosition\`, \`chartColors\`, quiet axes and gridlines, \`showLegend:false\` for one series.
- Stacked bar/column \`dataLabelPosition\` must be \`ctr\`, \`inEnd\`, or \`inBase\`; \`outEnd\` corrupts the file.
- A combo series on a secondary axis needs both \`valAxes\` and \`catAxes\` with two entries each, or PowerPoint drops the chart.
- Images: \`addImage({ data: 'image/png;base64,' + buffer.toString('base64') })\` or \`{ path }\`. Rasterize SVG with sharp at >= 256 px.

## Design direction
- Pick a palette that belongs to this topic. If the colors would work on any other deck, choose again. Starting points (primary / secondary / accent): ${PALETTES.map(([name, a, b, c]) => `${name} ${a}/${b}/${c}`).join('; ')}.
- One color carries 60-70% of the visual weight, one or two support it, one sharp accent appears rarely.
- Sandwich the deck: dark cover and closing, light content slides; or commit to dark throughout.
- Choose one visual motif (rounded image frames, icons in tinted circles, an oversized numeral) and repeat it on every anchor slide. A color bar or edge stripe is not a motif.
- Every slide carries a visual: image, native chart, icon, or a composed shape. A title plus bullets is a draft, not a slide.
- Vary layouts: two-column text/visual, icon rows, 2x2 or 2x3 grids, half-bleed image with overlay, hero stat callouts (60-72 pt numerals with small labels), comparison columns, numbered timelines.
- Fill the canvas with intent. Content occupies the width and height of the safe area; leftover blank space in one corner is a defect, deliberate whitespace around a focal element is not.

## Typography
- Safe families that render true-to-width everywhere: Arial, Calibri, Cambria, Times New Roman, Courier New, Bookman Old Style, Century Schoolbook, Malgun Gothic. Pair a serif display with a sans body for contrast at zero risk.
- Never Aptos; older Office lacks it and previews substitute it unpredictably. Georgia, Trebuchet, Impact, Garamond, Consolas preview approximately: give them ~10% extra room and do not trust fit checks on them.
- Sizes: title 36-44 pt bold, section header 20-24 pt bold, body 14-16 pt, captions 10-12 pt muted. Titles need at least 2x the body size.
- Left-align body text and lists; center only titles and single callouts.

## Spacing
- 0.5 in minimum from every slide edge; 0.3-0.5 in between blocks, applied consistently.
- Do not let text overflow its box. Shrink the type, widen the box, or split the slide.

## Avoid
- Accent lines under titles, header/footer bars, sidebar stripes, single-side card borders: these read as machine-made filler. Separate a card with a tint, a shadow, or an icon instead.
- Cream or beige default backgrounds (F5F5DC, FAF0E6, FAEBD7, FFF8E1). Default to FFFFFF or the brand palette.
- The same layout twice in a row; text-only slides; centered paragraphs; low-contrast text or icons; one styled slide beside plain ones.

## QA before finalize
1. Render and inspect every slide image. Look for overflow or clipped text first, then overlaps, elements closer than 0.3 in, uneven gaps, margins under 0.5 in, misaligned columns, weak contrast, leftover placeholder text.
2. Fix the script, not the file. Author again with overwrite:true and render again.
3. Finalize with \`design: { reviewed: true, reviewToken, critique }\` where reviewToken comes from the last render and critique holds one entry per slide: slide, verdict ('pass'), five 1-5 scores (hierarchy, balance, legibility, cohesion, evidence), a slide-specific note of 40+ characters, and fixes.
`;

export function pptxAuthoringGuide() {
  return {
    guide: PPTX_AUTHORING_GUIDE,
    workflow: PPTX_AUTHORING_WORKFLOW,
    script: PPTX_SCRIPT_CONTRACT,
  };
}
