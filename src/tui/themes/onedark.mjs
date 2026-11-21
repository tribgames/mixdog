import { basePalette } from './base.mjs';

/** One Dark — base palette with a hot coral-red spinner (most-emphasized live state). */
export const onedarkPalette = {
  ...basePalette,
  spinnerGlyph: 'rgb(224,108,117)', // most-emphasized: coral red
  spinnerText: 'rgb(224,108,117)',
  spinnerShimmer: 'rgb(240,140,148)',
  syntaxComment: 'rgb(118,126,142)', // lifted grey for code-block readability
};
