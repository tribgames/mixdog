// Compact constructors for hand-authored executive scene elements. Coordinates are
// percent-of-canvas; `style` is only emitted when it carries at least one key.
export function element(id, type, role, x, y, w, h, style = {}, extra = {}) {
  return {
    id,
    type,
    ...(role ? { role } : {}),
    x,
    y,
    w,
    h,
    ...(Object.keys(style).length ? { style } : {}),
    ...extra,
  };
}

export function text(id, role, x, y, w, h, style = {}) {
  return element(id, 'text', role, x, y, w, h, style);
}

export function line(id, role, x, y, w, h, style = {}) {
  return element(id, 'line', role, x, y, w, h, style);
}

export function source(colorRole) {
  return text('source', 'source', 6, 91, 88, 3, { fontSize: 12, colorRole });
}
