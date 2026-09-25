// Paper sizes in points (72 per inch), portrait. One table serves the PDF
// writer and Word's set_page, so `letter` means the same sheet in both.
const PAGE_SIZES = Object.freeze({
  a3: [841.89, 1190.55],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008],
  tabloid: [792, 1224],
});

/** `[width, height]` in points for a named size or a `[width, height]` pair; throws naming the choices. */
export function pageSizePoints(value, label) {
  let size;
  if (Array.isArray(value) && value.length === 2) {
    size = value.map(Number);
  } else {
    const named = String(value).toLowerCase();
    if (!PAGE_SIZES[named]) {
      throw new Error(
        `Unknown ${label}: ${value}; use ${Object.keys(PAGE_SIZES).join(', ')} or [width, height] in points`
      );
    }
    size = [...PAGE_SIZES[named]];
  }
  if (!size.every((side) => Number.isFinite(side) && side > 0)) {
    throw new Error(`${label} must be two positive numbers in points`);
  }
  return size;
}
