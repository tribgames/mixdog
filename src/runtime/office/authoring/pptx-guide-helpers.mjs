// Code half of the authoring guide: a small helper kit the script defines once
// so every slide draws the same kicker, title, card, stat, and badge, plus one
// sketch per layout in the menu. Sketches are starting points, not templates:
// the brief decides sizes and colors, the sketch only fixes the geometry.

export const PPTX_HELPER_KIT_SECTION = `## 6. Helper kit (define once at the top of the script)
Consistency comes from drawing every repeated element through one function. Adapt the tokens to the brief, keep the functions:
\`\`\`js
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const W = 13.33, H = 7.5, M = 0.6;           // canvas + outer margin (inches)
const T = {                                   // palette ladder from the brief
  ink: '1B2430', body: '2E3A48', muted: '5B6B7A', line: 'D6DEE5',
  paper: 'FFFFFF', paperAlt: 'EEF3F6', dark: '0F1B26',
  accent: '0E7C86', accentDeep: '0A5A62',
  display: 'Cambria', sans: 'Calibri', data: 'Arial',
};
const box = (x, y, w, h) => ({ x, y, w, h });
function kicker(slide, text, x, y, color = T.accent) {
  slide.addText(text.toUpperCase(), { ...box(x, y, 6, 0.3), fontFace: T.data, fontSize: 11, bold: true, color, charSpacing: 4, margin: 0 });
}
function title(slide, text, { y = 0.6, w = W - 2 * M, size = 34, color = T.ink } = {}) {
  slide.addText(text, { ...box(M, y, w, 0.9), fontFace: T.display, fontSize: size, bold: true, color, margin: 0 });
}
function card(slide, x, y, w, h, tint = T.paperAlt) {
  slide.addShape(pres.ShapeType.rect, { ...box(x, y, w, h), fill: { color: tint }, line: { color: tint } });
}
function hairline(slide, x, y, w, color = T.line) {
  slide.addShape(pres.ShapeType.line, { ...box(x, y, w, 0), line: { color, width: 1 } });
}
function stat(slide, x, y, w, value, label, color = T.accent) {
  slide.addText(value, { ...box(x, y, w, 1.1), fontFace: T.display, fontSize: 60, bold: true, color, margin: 0 });
  slide.addText(label, { ...box(x, y + 1.15, w, 0.4), fontFace: T.sans, fontSize: 13, color: T.muted, margin: 0 });
}
function iconCircle(slide, x, y, glyph, { d = 0.7, tint = T.paperAlt, color = T.accent } = {}) {
  slide.addShape(pres.ShapeType.ellipse, { ...box(x, y, d, d), fill: { color: tint }, line: { color: tint } });
  slide.addText(glyph, { ...box(x, y, d, d), fontFace: T.data, fontSize: 16, bold: true, color, align: 'center', valign: 'middle', margin: 0 });
}
function badge(slide, n, total) {
  slide.addText(n + '/' + total, { ...box(W - M - 1, H - 0.5, 1, 0.3), fontFace: T.data, fontSize: 9, color: T.muted, align: 'right', margin: 0 });
}
function body(slide, x, y, w, h, lines, size = 14) {
  slide.addText(lines.map((text, i) => ({ text, options: { bullet: true, breakLine: i < lines.length - 1, paraSpaceAfter: 8 } })),
    { ...box(x, y, w, h), fontFace: T.sans, fontSize: size, color: T.body, valign: 'top', margin: 0 });
}
\`\`\`
Glyphs for iconCircle come from the fonts already present (arrows, numerals, ✓ ✕ ● ◆ ▲); for a real icon rasterize an SVG string with sharp and addImage it inside the circle.

## 7. Layout menu (geometry sketches on the 13.33 x 7.5 canvas)
- Cover (anchor, dark): \`slide.background = { color: T.dark }\`; kicker at (M, 2.2); title 44 pt at (M, 2.6) width 7.5; subtitle 18 pt muted-on-dark at (M, 4.0); motif shape on the right third (e.g. two concentric ellipses at x 9.2-12.8); meta line 12 pt at (M, H-1.0).
- Hero stat + chart (dense): title; \`addChart\` at box(M, 1.7, 7.6, 5.2) with quiet axes (\`valAxisHidden: true, valGridLine: { style: 'none' }, catAxisLineShow: false, showLegend: false, showValue: true, chartColors: [T.accent]\`); two stat() blocks stacked on the right at x 8.8 width 3.9, each on a card() tint.
- Two-column text/visual: title; body() at box(M, 1.7, 5.4, 5.0); visual at box(6.6, 1.7, 6.1, 5.0) (image, chart, or a composed figure); a hairline between the columns only if the family is swiss-grid.
- Icon row / three cards: cards at x = M + i * 4.1, y 2.0, w 3.9, h 4.4; iconCircle at the card's top-left inset 0.3; card title 16 pt bold at +1.2; text 12 pt below. Vary card content length so the row does not read as three identical boxes.
- Numbered timeline: hairline across y 3.9 from M to W-M; four ellipses d 0.55 centered on it at x = M + 0.3 + i * 3.2 with the step number; step title 15 pt bold under each at y 4.4; one-line detail 12 pt at y 4.9.
- Comparison / matrix: \`slide.addTable(rows, { x: M, y: 1.7, w: W - 2 * M, colW: [...], fontFace: T.sans, fontSize: 12, color: T.body, border: { type: 'solid', pt: 1, color: T.line }, fill: { color: T.paper } })\`; header row cells get \`{ fill: { color: T.accent }, color: 'FFFFFF', bold: true }\`; alternate body rows with T.paperAlt; put the verdict in its own emphasized column, never color-only.
- Breathing quote / thesis: one statement 28-32 pt in the display face at box(M, 2.4, 9.5, 2.2), left aligned; attribution 12 pt muted below; no cards, one small motif mark.
- Closing (anchor, dark): statement 36 pt at (M, 2.5) width 9; one accent line stating the ask 18 pt; contact/meta 12 pt at (M, H-1.0); the cover motif repeated smaller.
Every content slide calls badge() when the brief chose page chrome; cover and closing never do.`;
