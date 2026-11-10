/** Code-point string order (never locale-dependent), for stable listings. */
export function compareCodePoints(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
