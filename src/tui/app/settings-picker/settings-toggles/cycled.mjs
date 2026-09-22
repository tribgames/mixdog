// settings-picker/settings-toggles/cycled.mjs
/** Wrap-around step through `entries` from `currentIndex` (0 when unknown). */
export const cycled = (entries, currentIndex, direction) =>
  entries[(Math.max(0, currentIndex) + direction + entries.length) % entries.length];
