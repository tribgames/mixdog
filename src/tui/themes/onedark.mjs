/**
 * src/tui/themes/onedark.mjs — One Dark (the default theme).
 *
 * One Dark IS the base palette, so this theme simply re-exports the full base
 * key set under the `onedarkPalette` name expected by the registry.
 */
import { basePalette } from './base.mjs';

/** One Dark — identical to the base palette. */
export const onedarkPalette = { ...basePalette };
