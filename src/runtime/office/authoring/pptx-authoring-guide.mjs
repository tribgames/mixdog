// The design guide the model reads before authoring a deck as a pptxgenjs
// script. It carries taste (brief, style family, palette ladder, rhythm), the
// helper kit and layout menu the script builds on, and the library footguns
// that corrupt files; the runtime only checks what a script cannot see for
// itself (package integrity, rendered pages). Sections live in
// pptx-guide-design.mjs and pptx-guide-helpers.mjs; this module assembles.
import { PPTX_DESIGN_BRIEF_SECTION } from './pptx-guide-design.mjs';
import { PPTX_HELPER_KIT_SECTION } from './pptx-guide-helpers.mjs';

export const PPTX_AUTHORING_WORKFLOW = [
  'write the brief (style family, palette ladder, motif, rhythm, slide plan) as a comment at the top of the script.',
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

const SCRIPT_CONTRACT_SECTION = `## 0. Script contract
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
- Images: \`addImage({ data: 'image/png;base64,' + buffer.toString('base64') })\` or \`{ path }\`. Rasterize SVG with sharp at >= 256 px.`;

const TYPOGRAPHY_SECTION = `## 8. Typography
- Safe families that render true-to-width everywhere: Arial, Calibri, Cambria, Times New Roman, Courier New, Bookman Old Style, Century Schoolbook, Malgun Gothic. Pair a serif display with a sans body for contrast at zero risk; Korean text uses Malgun Gothic for body and may keep a Latin display face for numerals.
- Never Aptos; older Office lacks it and previews substitute it unpredictably. Georgia, Trebuchet, Impact, Garamond, Consolas preview approximately: give them ~10% extra room and do not trust fit checks on them.
- Ladder: cover title 40-44 pt bold, slide title 32-36 pt bold, section header 20-24 pt bold, card title 16 pt bold, body 14-16 pt, captions 11-12 pt muted, hero numerals 54-72 pt, kicker 11 pt bold uppercase with charSpacing 4 (Latin only). Use the fewest roles that still read at thumbnail size; titles need at least 2x the body size.
- Left-align body text and lists; center only titles on anchor slides and single callouts. Break lines at phrase boundaries; a stranded single word on the last line means the box is the wrong width.`;

const SPACING_SECTION = `## 9. Spacing
- 0.5 in minimum from every slide edge; 0.3-0.5 in between blocks, applied consistently; related items sit closer than unrelated ones so spacing carries hierarchy.
- Baseline step inside a paragraph 1.15-1.3x the font size; the step into a new paragraph visibly larger; list items in between.
- Peer elements share one grid: same x for a column, same baseline for a row, equal gaps in a card row (within 5%).
- Do not let text overflow its box. Shrink the type, widen the box, or split the slide.`;

const QA_SECTION = `## 10. QA before finalize
1. Render and inspect every slide image, in this order: out-of-bounds and clipped text; overflow past a container; overlapping text or shapes; elements closer than 0.3 in; margins under 0.5 in; misaligned columns and uneven card gaps; contrast; text over a busy image without a scrim; leftover placeholder copy; the wrong element dominating the page.
2. Severity: P0 (unreadable, collision, overflow, broken image) and P1 (visual-system drift, unsafe color pair, missing scrim, layout repeated back to back) block finalize. P2 (spacing drift, weak hierarchy) gets fixed when the change is local. P3 (polish) is noted in the critique's fixes.
3. Fix the script, not the file. Author again with overwrite:true and render again; one or two loops is normal.
4. Finalize with \`design: { reviewed: true, reviewToken, critique }\` where reviewToken comes from the last render and critique holds one entry per slide: slide, verdict ('pass'), five 1-5 scores as top-level fields (hierarchy, balance, legibility, cohesion, evidence), a slide-specific note of 40+ characters, and fixes. A score of 3 or lower on any axis marks the slide as still needing polish.`;

export const PPTX_AUTHORING_GUIDE = [
  '# PPTX authoring guide (pptxgenjs)',
  SCRIPT_CONTRACT_SECTION,
  PPTX_DESIGN_BRIEF_SECTION,
  PPTX_HELPER_KIT_SECTION,
  TYPOGRAPHY_SECTION,
  SPACING_SECTION,
  QA_SECTION,
].join('\n\n');

export function pptxAuthoringGuide() {
  return {
    guide: PPTX_AUTHORING_GUIDE,
    workflow: PPTX_AUTHORING_WORKFLOW,
    script: PPTX_SCRIPT_CONTRACT,
  };
}
