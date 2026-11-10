const CAPTURE_PATCH_SIZE = 28;
const MAX_CAPTURE_PATCHES = 1568;
const MAX_CAPTURE_EDGE = 1568;

/** Bind coordinates only after fitting the image inside the supported encoder budgets. */
export function computerCaptureSize(width, height, maxWidth = 1280) {
  if (![width, height, maxWidth].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('capture_geometry_invalid: positive integer dimensions are required');
  }
  const longest = Math.max(width, height);
  const at = (edge) => {
    const scale = Math.min(1, edge / longest);
    return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
  };
  const fits = (size) =>
    size.width <= maxWidth &&
    Math.ceil(size.width / CAPTURE_PATCH_SIZE) * Math.ceil(size.height / CAPTURE_PATCH_SIZE) <= MAX_CAPTURE_PATCHES;
  let low = 1;
  let high = Math.min(longest, MAX_CAPTURE_EDGE);
  while (low < high) {
    const edge = Math.ceil((low + high) / 2);
    if (fits(at(edge))) low = edge;
    else high = edge - 1;
  }
  return at(low);
}
