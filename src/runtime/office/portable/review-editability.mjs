// Editability review: the structural tells that make a deck a picture of a
// slide instead of a slide. Both checks run on the inspected shape geometry
// (points) that the text-fit review already collects.

const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

function bySlide(entries) {
  const slides = new Map();
  for (const entry of entries) {
    if (!slides.has(entry.slide)) slides.set(entry.slide, []);
    slides.get(entry.slide).push(entry);
  }
  return slides;
}

function singleLineText(box) {
  const paragraphs = Array.isArray(box.paragraphs) ? box.paragraphs : [];
  const filled = paragraphs.filter((paragraph) => String(paragraph.text || '').trim());
  if (filled.length !== 1) return null;
  const paragraph = filled[0];
  const size = Number(paragraph.fontSize) || 0;
  if (!size) return null;
  // A box taller than two lines holds a paragraph already; only line-sized boxes fragment.
  if (box.height > size * 1.2 * 2.2) return null;
  return { size, text: String(paragraph.text).trim(), bold: Boolean(paragraph.bold), font: paragraph.fontName || '' };
}

// Text fragmentation: a paragraph authored as a stack of single-line text boxes
// (same left edge, same size, line-step gaps). It reads fine and edits badly:
// nothing reflows, and every line is its own object.
export function reviewTextFragmentation(boxes = [], { minimumRun = 3 } = {}) {
  const issues = [];
  for (const [slide, shapes] of bySlide(boxes)) {
    const lines = shapes
      .map((box) => ({ box, line: singleLineText(box) }))
      .filter((entry) => entry.line)
      .sort((first, second) => first.box.top - second.box.top || first.box.left - second.box.left);
    const used = new Set();
    for (const start of lines) {
      if (used.has(start)) continue;
      const run = [start];
      let last = start;
      for (const candidate of lines) {
        if (candidate === start || used.has(candidate) || run.includes(candidate)) continue;
        const sameColumn = near(candidate.box.left, last.box.left, 4) && near(candidate.box.width, last.box.width, Math.max(12, last.box.width * 0.15));
        const sameRole = candidate.line.size === last.line.size && candidate.line.bold === last.line.bold && candidate.line.font === last.line.font;
        const step = candidate.box.top - last.box.top;
        const lineStep = last.line.size * 1.2;
        const consecutive = step > 0 && step <= Math.max(lineStep * 2.2, last.box.height + lineStep * 0.9);
        if (sameColumn && sameRole && consecutive) {
          run.push(candidate);
          last = candidate;
        }
      }
      if (run.length < minimumRun) continue;
      // Bulleted or numbered lines are a list drawn line by line: the same fault.
      run.forEach((entry) => used.add(entry));
      issues.push({
        code: 'text_fragmentation',
        path: `/slide[${slide}]/shape[${start.box.shape}]`,
        message: `${run.length} single-line text boxes are stacked as one paragraph (shapes ${run.map((entry) => entry.box.shape).join(', ')}); author them as one text box with paragraphs so the text reflows and edits as a unit.`,
        shapes: run.map((entry) => entry.box.shape),
      });
    }
  }
  return issues;
}

// Dead vector chart: a bar chart drawn from rectangles. Four or more filled,
// text-free shapes share a baseline (columns) or a left edge (bars), match in
// thickness, and vary in length, on a slide with no native chart frame.
export function reviewDeadVectorChart(content = [], boxes = [], { minimumBars = 4 } = {}) {
  const issues = [];
  const textShapes = new Set(boxes.map((box) => `${box.slide}:${box.shape}`));
  for (const [slide, entries] of bySlide(content)) {
    if (entries.some((entry) => entry.kind === 'p:graphicFrame')) continue;
    const solids = entries.filter((entry) => entry.kind === 'p:sp' && !textShapes.has(`${entry.slide}:${entry.shape}`) && entry.width > 4 && entry.height > 4);
    if (solids.length < minimumBars) continue;
    const series = (axisOf, thicknessOf, lengthOf) => {
      const groups = [];
      for (const shape of solids) {
        const group = groups.find((entry) => near(axisOf(shape), entry.axis, 3) && near(thicknessOf(shape), entry.thickness, Math.max(3, entry.thickness * 0.2)));
        if (group) group.shapes.push(shape);
        else groups.push({ axis: axisOf(shape), thickness: thicknessOf(shape), shapes: [shape] });
      }
      return groups.find((group) => {
        if (group.shapes.length < minimumBars) return false;
        const lengths = group.shapes.map(lengthOf);
        const distinct = new Set(lengths.map((value) => Math.round(value / 4))).size;
        return distinct >= 3 && Math.max(...lengths) / Math.max(1, Math.min(...lengths)) >= 1.3;
      });
    };
    const columns = series((shape) => shape.top + shape.height, (shape) => shape.width, (shape) => shape.height);
    const bars = columns ? null : series((shape) => shape.left, (shape) => shape.height, (shape) => shape.width);
    const found = columns || bars;
    if (!found) continue;
    issues.push({
      code: 'dead_vector_chart',
      path: `/slide[${slide}]/shape[${found.shapes[0].shape}]`,
      message: `${found.shapes.length} rectangles of varying ${columns ? 'height on one baseline' : 'width on one left edge'} draw a ${columns ? 'column' : 'bar'} chart by hand; use a native chart (addChart / the kit's chart()) so the data stays editable.`,
      shapes: found.shapes.map((shape) => shape.shape),
    });
  }
  return issues;
}
