// data-chart on a printed page. The deck route turns `data-chart='{…}'` into a native PowerPoint chart
// (pptx-html-build.mjs addChart); the browser that prints a PDF draws nothing there. This draws the same
// spec — type, labels, values or series, colors, min/max, format, labels, legend, grid, value axis,
// gap, stacked, hole, plot — as an inline SVG inside the element before the page prints, so one HTML
// chart reads the same in a deck and on paper.

/**
 * Runs inside the page (page.evaluate): self-contained. Fills every [data-chart] element with its SVG.
 * @returns {{ drawn: number, warnings: object[] }}
 */
function drawDataCharts() {
  const PALETTE = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'];
  const NS = 'http://www.w3.org/2000/svg';
  const warnings = [];
  let drawn = 0;
  const hex = (value, fallback) => `#${String(value || fallback).replace(/^#/, '')}`;

  // Excel number codes as the deck's charts read them: quoted and escaped literals, a number part of
  // 0 # , . (decimals from the zeros after the point, thousands from a comma), and % (value × 100).
  const formatter = (code) => {
    if (!code) return (value) => String(Number(value));
    let before = '';
    let after = '';
    let pattern = '';
    let percent = false;
    const text = String(code).split(';')[0];
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const literal = (value) => {
        if (pattern) after += value;
        else before += value;
      };
      if (char === '"') {
        const end = text.indexOf('"', index + 1);
        literal(text.slice(index + 1, end < 0 ? text.length : end));
        index = end < 0 ? text.length : end;
      } else if (char === '\\') {
        literal(text[index + 1] || '');
        index += 1;
      } else if ('#0,.'.includes(char) && !after) pattern += char;
      else {
        if (char === '%') percent = true;
        literal(char);
      }
    }
    const point = pattern.indexOf('.');
    const decimals = point < 0 ? 0 : (pattern.slice(point + 1).match(/0/g) || []).length;
    const optional = point < 0 ? 0 : (pattern.slice(point + 1).match(/#/g) || []).length;
    const grouped = (point < 0 ? pattern : pattern.slice(0, point)).includes(',');
    return (value) => {
      const number = Number(value) * (percent ? 100 : 1);
      let body = number.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals + optional,
        useGrouping: grouped,
      });
      if (number < 0) body = `\u2212${body.replace('-', '')}`;
      return `${before}${body}${after}`;
    };
  };

  // A scale PowerPoint would choose: zero-based, topped at a round step above the largest value.
  const niceStep = (span) => {
    const raw = span / 5;
    const power = 10 ** Math.floor(Math.log10(raw || 1));
    const unit = raw / power;
    return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power;
  };

  for (const element of document.querySelectorAll('[data-chart]')) {
    let spec;
    try {
      spec = JSON.parse(element.dataset.chart);
    } catch (error) {
      warnings.push({
        code: 'chart_invalid',
        severity: 'warning',
        message: `data-chart is not valid JSON (${error.message}); nothing was drawn there.`,
      });
      continue;
    }
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const W = box.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
    const H = box.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
    if (!(W > 0 && H > 0)) {
      warnings.push({
        code: 'chart_unsized',
        severity: 'warning',
        message: 'a data-chart element has no size; give it a width and a height.',
      });
      continue;
    }
    const type = String(spec.type || 'bar').toLowerCase();
    const round = type === 'pie' || type === 'doughnut';
    const horizontal = type === 'bar';
    const labels = Array.isArray(spec.labels) ? spec.labels.map(String) : [];
    const series = Array.isArray(spec.series)
      ? spec.series.map((entry) => ({ name: String(entry.name ?? ''), values: (entry.values || []).map(Number) }))
      : [{ name: String(spec.name || spec.unit || ''), values: (spec.values || []).map(Number) }];
    const single = series.length === 1;
    const colors = Array.isArray(spec.colors) && spec.colors.length ? spec.colors : PALETTE;
    const colorOf = (seriesIndex, category) =>
      hex(
        single && !['line', 'area'].includes(type)
          ? colors[category % colors.length]
          : colors[seriesIndex % colors.length]
      );
    const ink = hex(spec.labelColor, '333333');
    const font = spec.font || style.fontFamily;
    const size = (Number(spec.size) || 12) * (96 / 72); // pt → CSS px
    const format = formatter(spec.format);
    const showValues = spec.showValues !== false;
    const canvas = document.createElement('canvas').getContext('2d');
    const textWidth = (text, bold) => {
      canvas.font = `${bold ? 700 : 400} ${size}px ${font}`;
      return canvas.measureText(text).width;
    };
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', element.dataset.alt || element.getAttribute('aria-label') || 'chart');
    svg.style.display = 'block';
    svg.style.overflow = 'visible';
    const add = (tag, attributes, text) => {
      const node = document.createElementNS(NS, tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
      if (text != null) node.textContent = text;
      svg.appendChild(node);
      return node;
    };
    const label = (x, y, text, { anchor = 'middle', bold = false, color = ink, baseline = 'middle' } = {}) =>
      add(
        'text',
        {
          x,
          y,
          'text-anchor': anchor,
          'dominant-baseline': baseline,
          'font-family': font,
          'font-size': size,
          'font-weight': bold ? 700 : 400,
          fill: color,
        },
        text
      );

    // The legend sits under the plot, one swatch and name per entry, centred.
    const legendEntries = spec.legend
      ? round || single
        ? labels.map((name, index) => ({ name, color: colorOf(0, index) }))
        : series.map((entry, index) => ({ name: entry.name, color: colorOf(index, 0) }))
      : [];
    const legendHeight = legendEntries.length ? size * 2 : 0;
    if (legendEntries.length) {
      const swatch = size * 0.75;
      const widths = legendEntries.map((entry) => swatch + size * 0.4 + textWidth(entry.name) + size);
      let x = (W - widths.reduce((sum, value) => sum + value, 0) + size) / 2;
      const y = H - legendHeight / 2;
      legendEntries.forEach((entry, index) => {
        add('rect', { x, y: y - swatch / 2, width: swatch, height: swatch, fill: entry.color });
        label(x + swatch + size * 0.4, y, entry.name, { anchor: 'start' });
        x += widths[index];
      });
    }

    if (round) {
      const values = series[0].values;
      const total = values.reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
      const cx = W / 2;
      const cy = (H - legendHeight) / 2;
      const r = Math.min(W, H - legendHeight) / 2 - size * 0.5;
      const inner = type === 'doughnut' ? (r * (Number(spec.hole) || 60)) / 100 : 0;
      let angle = -Math.PI / 2;
      values.forEach((value, index) => {
        const sweep = (Math.max(0, value) / total) * Math.PI * 2;
        if (!sweep) return;
        const end = angle + sweep;
        const large = sweep > Math.PI ? 1 : 0;
        const point = (radius, at) => `${cx + radius * Math.cos(at)} ${cy + radius * Math.sin(at)}`;
        const d =
          sweep >= Math.PI * 2 - 1e-6
            ? inner
              ? `M ${point(r, 0)} A ${r} ${r} 0 1 1 ${point(r, Math.PI)} A ${r} ${r} 0 1 1 ${point(r, 0)} M ${point(inner, 0)} A ${inner} ${inner} 0 1 0 ${point(inner, Math.PI)} A ${inner} ${inner} 0 1 0 ${point(inner, 0)} Z`
              : `M ${point(r, 0)} A ${r} ${r} 0 1 1 ${point(r, Math.PI)} A ${r} ${r} 0 1 1 ${point(r, 0)} Z`
            : inner
              ? `M ${point(r, angle)} A ${r} ${r} 0 ${large} 1 ${point(r, end)} L ${point(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${point(inner, angle)} Z`
              : `M ${cx} ${cy} L ${point(r, angle)} A ${r} ${r} 0 ${large} 1 ${point(r, end)} Z`;
        add('path', { d, fill: colorOf(0, index), 'fill-rule': 'evenodd', stroke: '#FFFFFF', 'stroke-width': 1 });
        if (showValues) {
          const middle = angle + sweep / 2;
          const at = inner ? (r + inner) / 2 : r * 0.65;
          label(cx + at * Math.cos(middle), cy + at * Math.sin(middle), format(value), { bold: true });
        }
        angle = end;
      });
      element.replaceChildren(svg);
      drawn += 1;
      continue;
    }

    // Axis charts: the value scale, then the plot area the labels leave.
    const stacked = Boolean(spec.stacked) && ['bar', 'col', 'column', 'area'].includes(type);
    const n = Math.max(labels.length, ...series.map((entry) => entry.values.length));
    const extent = (pick) =>
      stacked
        ? Array.from({ length: n }, (_, i) =>
            series.reduce((sum, entry) => sum + (pick(entry.values[i] || 0) ? entry.values[i] || 0 : 0), 0)
          )
        : series.flatMap((entry) => entry.values).filter((value) => pick(value));
    const highest = Math.max(0, ...extent((value) => value > 0));
    const lowest = Math.min(0, ...extent((value) => value < 0));
    const below0 = niceStep(highest - lowest);
    const min = spec.min != null ? Number(spec.min) : lowest < 0 ? -Math.ceil(-lowest / below0) * below0 : 0;
    const step = niceStep((highest || 1) - min);
    const max = spec.max != null ? Number(spec.max) : Math.ceil((highest * 1.05 - min) / step) * step + min || 1;
    const ticks = [];
    for (let value = min; value <= max + step * 1e-6; value += step) ticks.push(Number(value.toPrecision(12)));
    const valueWidth = Math.max(
      ...[...ticks, ...series.flatMap((entry) => entry.values)].map((value) => textWidth(format(value), true))
    );
    const categoryWidth = Math.max(0, ...labels.map((name) => textWidth(name)));
    const showCategories = spec.categoryAxis !== false;
    const pad = size * 0.4;
    let plot;
    if (spec.plot) {
      plot = {
        x: (Number(spec.plot.x) || 0) * W,
        y: (Number(spec.plot.y) || 0) * H,
        w: (Number(spec.plot.w) || 1) * W,
        h: (Number(spec.plot.h) || 1) * H,
      };
    } else if (horizontal) {
      const left = showCategories ? categoryWidth + pad * 2 : pad;
      const right = showValues ? valueWidth + pad * 2 : pad;
      const bottom = (spec.valueAxis ? size * 1.6 : pad) + legendHeight;
      plot = { x: left, y: pad, w: Math.max(1, W - left - right), h: Math.max(1, H - pad - bottom) };
    } else {
      const left = spec.valueAxis ? valueWidth * 0.8 + pad * 2 : pad;
      const top = showValues ? size * 1.6 : pad;
      const bottom = (showCategories ? size * 2.2 : pad) + legendHeight;
      plot = { x: left, y: top, w: Math.max(1, W - left - pad), h: Math.max(1, H - top - bottom) };
    }
    const span = max - min || 1;
    // Value → position along the value axis: up the plot for columns and lines, rightward for bars.
    const valueAt = (value) =>
      horizontal
        ? plot.x + ((Math.min(max, Math.max(min, value)) - min) / span) * plot.w
        : plot.y + plot.h - ((Math.min(max, Math.max(min, value)) - min) / span) * plot.h;
    const zero = valueAt(Math.max(min, Math.min(max, 0)));
    const band = (horizontal ? plot.h : plot.w) / Math.max(1, n);
    // Category i's band centre: bars run top-down (PowerPoint's maxMin), columns and points left to right.
    const centre = (i) => (horizontal ? plot.y : plot.x) + (i + 0.5) * band;

    if (spec.grid) {
      for (const value of ticks) {
        const at = valueAt(value);
        add(
          'line',
          horizontal
            ? { x1: at, x2: at, y1: plot.y, y2: plot.y + plot.h, stroke: hex(spec.grid), 'stroke-width': 1 }
            : { x1: plot.x, x2: plot.x + plot.w, y1: at, y2: at, stroke: hex(spec.grid), 'stroke-width': 1 }
        );
      }
    }
    if (spec.valueAxis) {
      for (const value of ticks) {
        const at = valueAt(value);
        if (horizontal) label(at, plot.y + plot.h + size * 0.9, format(value));
        else label(plot.x - pad, at, format(value), { anchor: 'end' });
      }
    }

    if (['bar', 'col', 'column'].includes(type)) {
      const gap = Number(spec.gap ?? 60) / 100;
      const groups = stacked ? 1 : series.length;
      const thick = band / (groups + gap);
      for (let i = 0; i < n; i += 1) {
        let base = 0;
        let negativeBase = 0;
        series.forEach((entry, s) => {
          const value = entry.values[i];
          if (value == null || Number.isNaN(value)) return;
          const from = stacked ? (value < 0 ? negativeBase : base) : 0;
          const to = from + value;
          if (stacked) {
            if (value < 0) negativeBase = to;
            else base = to;
          }
          const offset = centre(i) - (groups * thick) / 2 + (stacked ? 0 : s * thick);
          const a = valueAt(from);
          const b = valueAt(to);
          const lo = Math.min(a, b);
          const length = Math.abs(b - a);
          add(
            'rect',
            horizontal
              ? { x: lo, y: offset, width: length, height: thick, fill: colorOf(s, i) }
              : { x: offset, y: lo, width: thick, height: length, fill: colorOf(s, i) }
          );
          if (!showValues) return;
          const text = format(value);
          if (stacked) {
            const mid = (a + b) / 2;
            if (horizontal) label(mid, offset + thick / 2, text, { bold: true });
            else label(offset + thick / 2, mid, text, { bold: true });
          } else if (horizontal) {
            label(value < 0 ? lo - pad : lo + length + pad, offset + thick / 2, text, {
              anchor: value < 0 ? 'end' : 'start',
              bold: true,
            });
          } else {
            label(offset + thick / 2, value < 0 ? lo + length + size * 0.8 : lo - size * 0.8, text, { bold: true });
          }
        });
      }
    } else {
      // line and area: one point per category at the band centre.
      const lineWidth = (Number(spec.lineSize) || 3) * (96 / 72);
      let below = Array.from({ length: n }, () => 0);
      series.forEach((entry, s) => {
        const color = colorOf(s, 0);
        const tops = Array.from({ length: n }, (_, i) => (stacked ? below[i] : 0) + (entry.values[i] || 0));
        const points = tops.map((value, i) => [centre(i), valueAt(value)]);
        if (type === 'area') {
          const floor = stacked
            ? below.map((value, i) => [centre(i), valueAt(value)]).reverse()
            : [
                [centre(n - 1), zero],
                [centre(0), zero],
              ];
          add('polygon', {
            points: [...points, ...floor].map((p) => p.join(',')).join(' '),
            fill: color,
            'fill-opacity': single ? 1 : 0.85,
          });
        } else {
          add('polyline', {
            points: points.map((p) => p.join(',')).join(' '),
            fill: 'none',
            stroke: color,
            'stroke-width': lineWidth,
            'stroke-linejoin': 'round',
          });
          if (spec.markers !== false) {
            for (const [x, y] of points) add('circle', { cx: x, cy: y, r: lineWidth * 1.4, fill: color });
          }
        }
        if (showValues) {
          entry.values.forEach((value, i) => {
            if (value == null || Number.isNaN(value)) return;
            label(points[i][0], points[i][1] - size * 0.9, format(value), { bold: true });
          });
        }
        if (stacked) below = tops;
      });
    }

    if (spec.axisLine) {
      add(
        'line',
        horizontal
          ? { x1: zero, x2: zero, y1: plot.y, y2: plot.y + plot.h, stroke: ink, 'stroke-width': 1 }
          : { x1: plot.x, x2: plot.x + plot.w, y1: zero, y2: zero, stroke: ink, 'stroke-width': 1 }
      );
    }
    if (showCategories) {
      labels.forEach((name, i) => {
        if (horizontal) label(plot.x - pad, centre(i), name, { anchor: 'end' });
        else label(centre(i), plot.y + plot.h + size * 1.15, name);
      });
    }
    element.replaceChildren(svg);
    drawn += 1;
  }
  return { drawn, warnings };
}
