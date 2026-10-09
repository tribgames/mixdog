// The HTML authoring path, second half: the measurement pptx-html-measure.mjs
// read from the browser becomes a deck of native PowerPoint objects — text
// boxes that keep the browser's line breaks, shapes, lines, tables, charts,
// and pictures — on the 13.333 × 7.5 in wide layout, or the sheet the measure names.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const PITCH = 1.2; // PowerPoint's single line pitch, in em
// Measured on PowerPoint renders of Noto Sans KR, its ExtraBold, Noto Serif KR, and Malgun Gothic from 20
// to 330 px at line heights 0.9-1.5: the first baseline's depth under the content top, in em, follows one
// line up to 100 % spacing (the written percentage, so exactly 100 % counts), another above it, and falls
// slower under 83 % (a display line set tighter than 1.0).
const firstBaseline = (spacing) => {
  if (Math.round(spacing * 100000) > 100000) return 0.93 * spacing - 0.03;
  return spacing < 0.833 ? 0.86 * spacing + 0.028 : 1.23 * spacing - 0.28;
};
// The browser's baseline within a glyph box (ascent over ascent + descent), per face.
const ASCENT_BY_FACE = { 'Malgun Gothic': 0.815, '맑은 고딕': 0.815 };
const ascentOf = (item) => ASCENT_BY_FACE[item.lines[0]?.runs[0]?.style.font] ?? 0.801;
const MIDDLE_LIFT = 0.09; // em a middle-anchored single line sits above the browser's centre
const middleBaseline = (spacing) => 1.02 * spacing - 0.09; // the same, for a middle-anchored block
const EDGE = 24; // px: text slack never carries a box past this margin

// The deck canvas lands on the 13.333 in wide layout; a measured sheet (a PDF's designed pages) carries its own inches.
const WIDE_INCHES = 13.333;
const pageInches = (measure) => ({
  width: measure.inchWidth || WIDE_INCHES,
  height: measure.inchHeight || (WIDE_INCHES * (measure.height || 1080)) / measure.width,
});

function units(measure) {
  const inches = pageInches(measure).width;
  const K = inches / measure.width; // inches per CSS px
  return {
    K,
    PT: 0.5 * (1920 / measure.width) * (inches / WIDE_INCHES),
    inch: (v) => v * K,
    W: measure.width,
    H: measure.height || 1080,
  };
}

// The page clips what runs past it (section.slide is overflow: hidden); PowerPoint would keep the part past
// the edge in the editing view. A box is cut to the canvas, and null when nothing of it is on the page.
function onCanvas(box, u) {
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(u.W, box.x + box.w);
  const y1 = Math.min(u.H, box.y + box.h);
  return x1 - x0 < 0.5 || y1 - y0 < 0.5 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// A picture rendered for `box` keeps only the pixels on the page, placed at the part of the box that is.
async function cropToCanvas(sharp, png, box, u) {
  const visible = onCanvas(box, u);
  if (!visible) return null;
  if (visible.w === box.w && visible.h === box.h) return { png, box };
  const { width, height } = await sharp(png).metadata();
  const sx = width / box.w;
  const sy = height / box.h;
  const left = Math.min(width - 1, Math.max(0, Math.round((visible.x - box.x) * sx)));
  const top = Math.min(height - 1, Math.max(0, Math.round((visible.y - box.y) * sy)));
  const w = Math.max(1, Math.min(width - left, Math.round(visible.w * sx)));
  const h = Math.max(1, Math.min(height - top, Math.round(visible.h * sy)));
  const cut = await sharp(png).extract({ left, top, width: w, height: h }).png().toBuffer();
  return { png: cut, box: visible };
}

const transparency = (c) => (c && c.a < 1 ? Math.round((1 - c.a) * 100) : 0);
const fillOf = (c) => (c ? { color: c.hex, transparency: transparency(c) } : { type: 'none' });

function geometry(pres, inch, box, radius) {
  const short = Math.min(box.w, box.h);
  if (radius >= short / 2 - 0.5 && Math.abs(box.w - box.h) < 1) return { shape: pres.ShapeType.ellipse };
  if (radius > 0.5) return { shape: pres.ShapeType.roundRect, rectRadius: inch(Math.min(radius, short / 2)) };
  return { shape: pres.ShapeType.rect };
}

// One CSS box-shadow as PowerPoint's outer shadow. pptxgenjs reads blur 0 as unset and
// substitutes 8 pt, so a hard shadow carries a blur just above zero.
function shadowOf(shadow, PT) {
  if (!shadow?.color) return {};
  return {
    shadow: {
      type: 'outer',
      color: shadow.color.hex,
      opacity: shadow.color.a,
      blur: Math.max(0.01, shadow.blur * PT),
      offset: Math.hypot(shadow.x, shadow.y) * PT,
      angle: Math.round((Math.atan2(shadow.y, shadow.x) * 180) / Math.PI),
    },
  };
}

// CSS paints a border inside the box; PowerPoint strokes the outline on its centre. The outline shape
// stands half a stroke inside the CSS box so both reach the same outer edge.
function strokeInset(box, stroke, radius = 0) {
  const half = stroke ? stroke.w / 2 : 0;
  if (!half) return { box, radius };
  return {
    box: { x: box.x + half, y: box.y + half, w: Math.max(1, box.w - 2 * half), h: Math.max(1, box.h - 2 * half) },
    radius: Math.max(0, radius - half),
  };
}

function addRect(slide, pres, u, item) {
  // A plain square fill is cut at the page edge (a rounded or outlined one past the edge is captured).
  const plain = !item.stroke && !(item.radius > 0.5) && !item.rotate;
  const box = plain ? onCanvas(item.box, u) : item.box;
  if (!box) return;
  const { box: b, radius } = strokeInset(box, item.stroke, item.radius);
  const g = geometry(pres, u.inch, b, radius);
  slide.addShape(g.shape, {
    x: u.inch(b.x),
    y: u.inch(b.y),
    w: u.inch(b.w),
    h: u.inch(b.h),
    fill: fillOf(item.fill),
    line: item.stroke ? { color: item.stroke.hex, width: item.stroke.w * u.PT } : { type: 'none' },
    ...(g.rectRadius ? { rectRadius: g.rectRadius } : {}),
    ...(item.rotate ? { rotate: Math.round(item.rotate * 100) / 100 } : {}),
    ...shadowOf(item.shadow, u.PT),
  });
}

function addLine(slide, pres, u, item) {
  // Border sides are level or upright, so the page edge cuts them by clamping.
  const clamp = (v, max) => Math.min(max, Math.max(0, v));
  const [x1, y1, x2, y2] = [
    clamp(item.seg[0], u.W),
    clamp(item.seg[1], u.H),
    clamp(item.seg[2], u.W),
    clamp(item.seg[3], u.H),
  ];
  if (Math.hypot(x2 - x1, y2 - y1) < 0.5) return;
  slide.addShape(pres.ShapeType.line, {
    x: u.inch(Math.min(x1, x2)),
    y: u.inch(Math.min(y1, y2)),
    w: u.inch(Math.abs(x2 - x1)),
    h: u.inch(Math.abs(y2 - y1)),
    line: { color: item.color.hex, width: item.w * u.PT, transparency: transparency(item.color) },
  });
}

// Where a text item sits and how PowerPoint must set it so the glyphs land where the browser drew them.
export function textPlacement(item, canvasWidth) {
  const single = item.lines.length === 1;
  const b = item.box;
  const ins = { ...item.inset };
  let x = b.x;
  let y = b.y;
  let w = b.w;
  let h = b.h;
  const f = item.frame;
  // The browser already broke the lines. A single line never wraps; a multi-line block keeps the
  // browser's breaks, with a little room so PowerPoint's metrics add no break of their own.
  const extra = item.inkW * (single ? 1.05 : 1.04) + 4 - (b.w - ins.l - ins.r);
  if (extra > 0) {
    if (f) {
      const d = extra / 2;
      ins.l = Math.max(0, ins.l - d);
      ins.r = Math.max(0, ins.r - d);
    } else if (item.align === 'center') {
      x -= extra / 2;
      w += extra;
    } else if (item.align === 'right') {
      x -= extra;
      w += extra;
    } else w += extra;
  }
  // The slack never carries the box past the page margin (the authored box itself stands).
  const left = Math.max(x, Math.min(b.x, EDGE));
  w -= left - x;
  x = left;
  w = Math.min(w, Math.max(b.x + b.w, canvasWidth - EDGE) - x);
  const contentTop = b.y + ins.t;
  const contentHeight = b.h - ins.t - ins.b;
  const textTop = item.lines[0].top;
  const textBottom = item.lines[item.lines.length - 1].bottom;
  const chip = Boolean(f) && contentHeight <= item.lineHeight * item.lines.length * 1.25;
  // Text the browser laid out on its frame's middle (a disc, a stamp, a centred label) keeps
  // PowerPoint's middle anchor, whatever its padding. Unframed text is always placed by its baseline.
  const centred =
    Boolean(f) &&
    Math.abs((textTop + textBottom) / 2 - (contentTop + contentHeight / 2)) < Math.max(4, contentHeight * 0.05) &&
    contentHeight > textBottom - textTop + 2;
  const middle = chip || centred;
  // Line spacing: the pitch matches when the multiple is the browser's line height over PowerPoint's
  // single pitch. The first baseline does not follow the browser's half-leading: PowerPoint sets it
  // FIRST_BASELINE(spacing) em under the content top, so a top-anchored block is placed by baseline.
  const pitch = item.fontSize * PITCH;
  let spacing = item.lineHeight / pitch;
  let topInset = ins.t;
  if (middle) {
    ins.t = 0;
    ins.b = 0;
    topInset = 0;
    if (single) {
      spacing = 1;
      // PowerPoint centres a single line MIDDLE_LIFT em above where the browser centres it.
      topInset = 2 * MIDDLE_LIFT * item.fontSize;
    } else {
      // A centred block: PowerPoint's first baseline lands middleBaseline(spacing) em under the block's
      // nominal top; the inset moves the middle anchor by half of itself.
      const first = item.lines[0];
      const glyph = first.bottom - first.top;
      const browser = (item.lineHeight - glyph) / 2 + ascentOf(item) * glyph;
      const delta = middleBaseline(spacing) * item.fontSize - browser;
      if (delta < 0) topInset = -2 * delta;
      else ins.b = 2 * delta;
    }
  } else {
    const first = item.lines[0];
    const baseline = first.top + ascentOf(item) * (first.bottom - first.top);
    const offset = firstBaseline(spacing) * item.fontSize;
    if (f) topInset = Math.max(0, baseline - b.y - offset);
    else {
      const top = baseline - ins.t - offset;
      // PowerPoint's content is lines × the browser's line height at this multiple, tighter lines included;
      // it reads its text bounds about 0.035 em taller than that, so the box keeps 0.05 em of slack.
      h = Math.max(h + y - top, ins.t + ins.b + item.lines.length * item.lineHeight + 0.05 * item.fontSize);
      y = top;
    }
  }
  return {
    x,
    y: f ? b.y : y,
    w,
    h,
    inset: { ...ins, t: topInset },
    valign: middle ? 'middle' : 'top',
    // A chip its one line fills (a pill label) centres, so PowerPoint's wider or narrower glyphs keep
    // its padding even; a wider band keeps the alignment the browser used.
    centerAlign: chip && single && b.w - item.inset.l - item.inset.r - item.inkW < 4,
    wrap: !single,
    spacing,
  };
}

function addText(slide, pres, u, item, canvasWidth) {
  const runs = [];
  item.lines.forEach((line, li) => {
    line.runs.forEach((run, ri) => {
      runs.push({
        text: run.text,
        options: {
          fontFace: run.style.font,
          fontSize: run.style.size * u.PT,
          bold: run.style.bold,
          italic: run.style.italic,
          color: run.style.color.hex,
          ...(run.style.color.a < 1 ? { transparency: transparency(run.style.color) } : {}),
          charSpacing: run.style.ls * u.PT,
          ...(run.style.hl ? { highlight: run.style.hl } : {}),
          ...(li > 0 && ri === 0 ? { softBreakBefore: true } : {}),
        },
      });
    });
  });
  const place = textPlacement(item, canvasWidth);
  const f = item.frame;
  // A framed box's outline stands half its stroke inside, and its words keep their place.
  const half = f?.stroke ? f.stroke.w / 2 : 0;
  const framed = f ? strokeInset(item.box, f.stroke, f.radius) : null;
  const g = f ? geometry(pres, u.inch, framed.box, framed.radius) : null;
  // A rounded rectangle's own text rectangle already stands 0.29289 of its corner radius inside the shape.
  const corner =
    g?.shape === pres.ShapeType.roundRect
      ? 0.29289 * Math.min(framed.radius, Math.min(framed.box.w, framed.box.h) / 2)
      : 0;
  const m = (v) => Math.max(0, v - corner - half) * u.PT;
  const frameLine = f?.stroke ? { color: f.stroke.hex, width: f.stroke.w * u.PT } : { type: 'none' };
  slide.addText(runs, {
    x: u.inch(place.x + half),
    y: u.inch(place.y + half),
    w: u.inch(Math.max(1, place.w - 2 * half)),
    h: u.inch(Math.max(1, place.h - 2 * half)),
    margin: [m(place.inset.l), m(place.inset.r), m(place.inset.b), m(place.inset.t)],
    valign: place.valign,
    align: place.centerAlign || g?.shape === pres.ShapeType.ellipse ? 'center' : item.align,
    wrap: place.wrap,
    lineSpacingMultiple: place.spacing,
    ...(item.rotate ? { rotate: Math.round(item.rotate * 100) / 100 } : {}),
    ...(f
      ? {
          shape: g.shape,
          fill: fillOf(f.fill),
          line: frameLine,
          ...shadowOf(f.shadow, u.PT),
        }
      : {}),
    ...(g?.rectRadius ? { rectRadius: g.rectRadius } : {}),
  });
}

function addTable(slide, u, item) {
  const edge = (e) => (e ? { type: 'solid', pt: e.w * u.PT, color: e.c } : { type: 'none' });
  const rows = item.rows.map((row) =>
    row.map((cell) => ({
      text: cell.text,
      options: {
        fontFace: cell.font,
        fontSize: cell.size * u.PT,
        bold: cell.bold,
        color: cell.color.hex,
        fill: { color: cell.fill?.hex || 'FFFFFF' },
        align: cell.align,
        valign: 'middle',
        margin: [u.inch(cell.pad.t), u.inch(cell.pad.r), u.inch(cell.pad.b), u.inch(cell.pad.l)],
        border: [edge(cell.border.t), edge(cell.border.r), edge(cell.border.b), edge(cell.border.l)],
        ...(cell.span > 1 ? { colspan: cell.span } : {}),
      },
    }))
  );
  const widest = item.rows.reduce((best, row) => (row.length > best.length ? row : best), item.rows[0] || []);
  const rowHeights = item.rows.map((row) => u.inch(row[0].box.h));
  slide.addTable(rows, {
    x: u.inch(item.box.x),
    y: u.inch(item.box.y),
    w: u.inch(item.box.w),
    // The frame carries the whole table height: a frame sized to its first row reads as a hollow
    // band to every geometry check below it.
    h: rowHeights.reduce((sum, value) => sum + value, 0),
    colW: widest.map((cell) => u.inch(cell.box.w)),
    rowH: rowHeights,
  });
}

const CHART_TYPES = {
  bar: 'bar',
  col: 'bar',
  column: 'bar',
  line: 'line',
  area: 'area',
  pie: 'pie',
  doughnut: 'doughnut',
};

// data-chart spec → a native, editable chart (see the pptx skill's html reference).
function addChart(slide, pres, u, item) {
  const b = item.box;
  const spec = item.spec || {};
  const kind = CHART_TYPES[String(spec.type || 'bar').toLowerCase()] || 'bar';
  const data = Array.isArray(spec.series)
    ? spec.series.map((series) => ({ name: series.name, labels: spec.labels, values: series.values }))
    : [{ name: spec.name || spec.unit || 'Value', labels: spec.labels, values: spec.values }];
  const ink = spec.labelColor || '333333';
  const font = spec.font || item.font || 'Noto Sans KR';
  const size = Number(spec.size) || 12;
  const round = kind === 'pie' || kind === 'doughnut';
  const column = String(spec.type || '').toLowerCase() === 'col' || String(spec.type || '').toLowerCase() === 'column';
  slide.addChart(pres.ChartType[kind], data, {
    x: u.inch(b.x),
    y: u.inch(b.y),
    w: u.inch(b.w),
    h: u.inch(b.h),
    chartColors: spec.colors,
    showLegend: Boolean(spec.legend),
    legendPos: spec.legendPos || 'b',
    legendFontFace: font,
    legendFontSize: size,
    legendColor: ink,
    showTitle: false,
    // plot: the inner plot area as fractions of the chart box, so an overlay (a shaded band, a threshold, a
    // callout) drawn in the HTML lands on the data: category i of n sits at x + (i + 0.5) / n of the plot width.
    ...(spec.plot
      ? {
          layout: {
            x: Number(spec.plot.x) || 0,
            y: Number(spec.plot.y) || 0,
            w: Number(spec.plot.w) || 1,
            h: Number(spec.plot.h) || 1,
          },
        }
      : {}),
    showValue: spec.showValues !== false,
    dataLabelColor: ink,
    dataLabelFontFace: font,
    dataLabelFontSize: size,
    dataLabelFontBold: true,
    ...(spec.format ? { dataLabelFormatCode: spec.format } : {}),
    ...(round
      ? { showPercent: false, holeSize: Number(spec.hole) || 60, dataLabelPosition: spec.labelPosition || 'bestFit' }
      : axisChartOptions(kind, spec, column, { ink, font, size })),
  });
}

function axisLabelPosition(kind, spec) {
  if (spec.labelPosition) return spec.labelPosition;
  if (spec.stacked) return 'ctr';
  return kind === 'line' ? 't' : 'outEnd';
}

// The options a bar / line / area chart adds to the shared ones: series geometry, axes and grid.
function axisChartOptions(kind, spec, column, { ink, font, size }) {
  const series = {};
  if (kind === 'bar') {
    series.barDir = column ? 'col' : 'bar';
    series.barGapWidthPct = Number(spec.gap ?? 60);
    series.barGrouping = spec.stacked ? 'stacked' : 'clustered';
  }
  if (kind === 'line') {
    series.lineSize = Number(spec.lineSize) || 3;
    series.lineDataSymbol = spec.markers === false ? 'none' : 'circle';
  }
  return {
    ...series,
    dataLabelPosition: axisLabelPosition(kind, spec),
    catAxisOrientation: kind === 'bar' && !column ? 'maxMin' : 'minMax',
    catAxisLabelFrequency: 1,
    ...(spec.categoryAxis === false ? { catAxisHidden: true } : {}),
    catAxisLabelColor: ink,
    catAxisLabelFontFace: font,
    catAxisLabelFontSize: size,
    catAxisLineShow: Boolean(spec.axisLine),
    valAxisHidden: spec.valueAxis !== true,
    valAxisLabelColor: ink,
    valAxisLabelFontFace: font,
    valAxisLabelFontSize: size,
    ...(spec.min != null ? { valAxisMinVal: Number(spec.min) } : { valAxisMinVal: 0 }),
    ...(spec.max != null ? { valAxisMaxVal: Number(spec.max) } : {}),
    valGridLine: spec.grid ? { color: spec.grid, size: 1 } : { style: 'none' },
    catGridLine: { style: 'none' },
  };
}

async function addSvg(slide, u, item, sharp) {
  const scale = 2.5;
  const drawn = await sharp(Buffer.from(item.markup), { density: 72 * scale })
    .resize(Math.max(1, Math.round(item.box.w * scale)), Math.max(1, Math.round(item.box.h * scale)), { fit: 'fill' })
    .png()
    .toBuffer();
  const placed = await cropToCanvas(sharp, drawn, item.box, u);
  if (!placed) return;
  const { png, box: b } = placed;
  slide.addImage({
    data: `image/png;base64,${png.toString('base64')}`,
    x: u.inch(b.x),
    y: u.inch(b.y),
    w: u.inch(b.w),
    h: u.inch(b.h),
    altText: item.alt || 'drawing',
    ...pictureAlpha(item),
    ...(await drawingName(sharp, png)),
  });
}

const pictureAlpha = (item) => (item.alpha < 1 ? { transparency: Math.round((1 - item.alpha) * 100) } : {});

// A drawing that leaves most of its frame clear (a band, a ring, an arrow) is not the rectangle it is placed
// in: it is named as a motif, so review that reads frames leaves its shape to the HTML geometry read.
const DRAWING_OPAQUE_SHARE = 0.6;
async function drawingName(sharp, png) {
  const { channels } = await sharp(png).ensureAlpha().stats();
  return channels[3].mean / 255 < DRAWING_OPAQUE_SHARE ? { objectName: 'Mixdog Motif drawing' } : {};
}

// Paint the browser drew and PowerPoint cannot (gradients, clip paths, masks, filters, pseudo-elements,
// turned or dashed boxes), placed as the picture it is. A box of text keeps a native fill underneath in
// the picture's mean colour, so its words are read against the background they stand on.
// The mean colour a picture paints inside a canvas box, and the share of that box it covers opaquely
// (a point the picture does not reach counts as uncovered).
async function meanColour(sharp, png, draw, box, inset = 0) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const s = info.width / draw.w;
  const pad = Math.ceil(inset * s);
  const x0 = Math.round((box.x - draw.x) * s) + pad,
    y0 = Math.round((box.y - draw.y) * s) + pad;
  const x1 = Math.round((box.x + box.w - draw.x) * s) - pad,
    y1 = Math.round((box.y + box.h - draw.y) * s) - pad;
  const step = Math.max(2, Math.round(Math.sqrt(Math.max(1, (x1 - x0) * (y1 - y0)) / 40000)));
  let r = 0,
    g = 0,
    b = 0,
    n = 0,
    total = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      total += 1;
      if (x < 0 || y < 0 || x >= info.width || y >= info.height) continue;
      const i = (y * info.width + x) * 4;
      if (data[i + 3] < 250) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
  }
  const hex = n
    ? [r, g, b]
        .map((v) =>
          Math.round(v / n)
            .toString(16)
            .padStart(2, '0')
        )
        .join('')
        .toUpperCase()
    : null;
  return { hex, coverage: total ? n / total : 0 };
}

async function addCapture(slide, pres, u, item, sharp) {
  const png = Buffer.from(item.png, 'base64');
  // The page's own drawn background also sets the slide colour, the one the contrast read stands on.
  if (item.slide) {
    const mean = await meanColour(sharp, png, item.draw, item.draw);
    if (mean.hex && mean.coverage > 0.98) slide.background = { color: mean.hex };
  }
  // Under a box the picture covers opaquely, read inside the element's own box (not its shadow).
  if (item.underlay) {
    const mean = await meanColour(sharp, png, item.draw, item.underlay.box, item.underlay.radius);
    if (mean.hex && mean.coverage > 0.98) {
      addRect(slide, pres, u, {
        box: item.underlay.box,
        radius: item.underlay.radius,
        rotate: item.underlay.rotate,
        fill: { hex: mean.hex, a: 1 },
        stroke: null,
        shadow: null,
      });
    }
  }
  const d = item.draw;
  slide.addImage({
    data: `image/png;base64,${item.png}`,
    x: u.inch(d.x),
    y: u.inch(d.y),
    w: u.inch(d.w),
    h: u.inch(d.h),
    altText: item.alt || 'decoration',
    ...(item.slide ? {} : await drawingName(sharp, png)),
  });
}

async function imageBytes(src) {
  const data = /^data:[^;]+;base64,(.*)$/.exec(src);
  if (data) return Buffer.from(data[1], 'base64');
  if (src.startsWith('file:')) return readFile(fileURLToPath(src));
  throw new Error(`<img src="${src.slice(0, 80)}"> is not local; use a file beside the deck or a data: URI.`);
}

// The crop origin of a covered picture from its computed object-position ("27% 50%", "-40px 10px"):
// a percentage places that share of the overflow before the box, a length moves the picture by itself.
export function coverOffset(position, overflowX, overflowY, scale) {
  const [x = '50%', y = '50%'] = String(position || '50% 50%')
    .trim()
    .split(/\s+/);
  const along = (value, overflow) => {
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return Math.round(overflow / 2);
    const offset = value.endsWith('%') ? (n / 100) * overflow : -n * scale;
    return Math.min(overflow, Math.max(0, Math.round(offset)));
  };
  return [along(x, overflowX), along(y, overflowY)];
}

// A picture keeps its CSS crop (object-fit: cover, at its object-position) and corner radius, baked into the placed PNG.
async function addImage(slide, u, item, sharp) {
  const b = item.box;
  const scale = 2;
  const outW = Math.max(1, Math.round(b.w * scale));
  const outH = Math.max(1, Math.round(b.h * scale));
  let image = sharp(await imageBytes(item.src)).rotate();
  if (item.fit === 'cover' || !['contain', 'fill'].includes(item.fit)) {
    // Cover crops where object-position puts the picture, not at its centre.
    const { width: nw, height: nh } = await image.metadata();
    const s = Math.max(outW / nw, outH / nh);
    const sw = Math.max(outW, Math.round(nw * s));
    const sh = Math.max(outH, Math.round(nh * s));
    const [px, py] = coverOffset(item.position, sw - outW, sh - outH, scale);
    image = sharp(await image.resize(sw, sh).toBuffer()).extract({ left: px, top: py, width: outW, height: outH });
  } else {
    image = image.resize(outW, outH, { fit: item.fit, background: { r: 0, g: 0, b: 0, alpha: 0 } });
  }
  if (item.radius > 0.5) {
    const r = Math.round(item.radius * scale);
    const mask = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}"><rect width="${outW}" height="${outH}" rx="${r}" ry="${r}"/></svg>`
    );
    image = sharp(await image.png().toBuffer()).composite([{ input: mask, blend: 'dest-in' }]);
  }
  const placed = await cropToCanvas(sharp, await image.png().toBuffer(), b, u);
  if (!placed) return;
  slide.addImage({
    data: `image/png;base64,${placed.png.toString('base64')}`,
    x: u.inch(placed.box.x),
    y: u.inch(placed.box.y),
    w: u.inch(placed.box.w),
    h: u.inch(placed.box.h),
    altText: item.alt || 'picture',
    ...pictureAlpha(item),
  });
}

/** Writes the measured deck to `output` as a .pptx. */
export async function buildPptxFromMeasure(measure, output) {
  const PptxGenJS = require('pptxgenjs');
  const sharp = require('sharp');
  const pres = new PptxGenJS();
  const page = pageInches(measure);
  if (page.width === WIDE_INCHES && Math.abs(page.height - 7.5) < 0.01) pres.layout = 'LAYOUT_WIDE';
  else {
    pres.defineLayout({ name: 'MIXDOG_SHEET', width: page.width, height: page.height });
    pres.layout = 'MIXDOG_SHEET';
  }
  const u = units(measure);
  for (const measured of measure.slides) {
    const slide = pres.addSlide();
    if (measured.bg) slide.background = { color: measured.bg.hex };
    for (const item of measured.items) {
      if (item.kind === 'rect') addRect(slide, pres, u, item);
      else if (item.kind === 'line') addLine(slide, pres, u, item);
      else if (item.kind === 'text') addText(slide, pres, u, item, measure.width);
      else if (item.kind === 'table') addTable(slide, u, item);
      else if (item.kind === 'chart') addChart(slide, pres, u, item);
      else if (item.kind === 'svg') await addSvg(slide, u, item, sharp);
      else if (item.kind === 'image') await addImage(slide, u, item, sharp);
      else if (item.kind === 'capture') await addCapture(slide, pres, u, item, sharp);
    }
    if (measured.notes) slide.addNotes(measured.notes);
  }
  await pres.writeFile({ fileName: output });
}
