/**
 * src/tui/themes/onedark.mjs — One Dark (the default theme).
 *
 * One Dark IS the base palette, so this theme simply re-exports the full base
 * key set under the `onedarkPalette` name expected by the registry.
 */
import { basePalette } from './base.mjs';

/** One Dark — base palette with a hot coral-red spinner (most-emphasized live state). */
export const onedarkPalette = {
  ...basePalette,
  spinnerGlyph: 'rgb(224,108,117)', // most-emphasized: coral red
  spinnerText: 'rgb(224,108,117)',
  spinnerShimmer: 'rgb(240,140,148)',
};
