/**
 * src/tui/themes/index.mjs — theme registry, order, and default id.
 *
 * Each theme lives in its own module and exports a COMPLETE palette built on
 * `basePalette` (One Dark). This index wires them into the registry consumed by
 * theme.mjs. The runtime singleton (`theme`) is seeded from `basePalette`.
 */
import { basePalette } from './base.mjs';
import { basicPalette } from './basic.mjs';
import { basicIndigoPalette } from './basicIndigo.mjs';
import { warmPalette } from './warm.mjs';
import { tealPalette } from './teal.mjs';
import { onedarkPalette } from './onedark.mjs';
import { tokyonightPalette } from './tokyonight.mjs';
import { kanagawaPalette } from './kanagawa.mjs';
import { catppuccinPalette } from './catppuccin.mjs';
import { draculaPalette } from './dracula.mjs';
import { rosepinePalette } from './rosepine.mjs';
import { nordPalette } from './nord.mjs';
import { gruvboxPalette } from './gruvbox.mjs';
import { everforestPalette } from './everforest.mjs';
import { lightPalette } from './light.mjs';

/** Default theme id (Basic — the Mixdog house theme). */
export const DEFAULT_THEME_ID = 'basic';

/** Theme registry: id -> { id, label, description, palette }. */
export const THEME_REGISTRY = {
  basic:       { id: 'basic',       label: 'Basic',        description: 'Mixdog warm orange + blue brand dark.', palette: basicPalette },
  basicIndigo: { id: 'basicIndigo', label: 'Basic Indigo', description: 'Google Indigo Material dark — unified indigo accent.', palette: basicIndigoPalette },
  warm:       { id: 'warm',       label: 'Warm',          description: 'Claude-style warm orange accent with bright body text.', palette: warmPalette },
  teal:       { id: 'teal',       label: 'Teal',          description: 'pi-style teal accent with soft body text.', palette: tealPalette },
  onedark:    { id: 'onedark',    label: 'One Dark',      description: 'Atom One Dark — blue accent on slate, balanced syntax.', palette: onedarkPalette },
  tokyonight: { id: 'tokyonight', label: 'Tokyo Night',   description: 'Storm variant — soft blue/purple dark with neon markdown.', palette: tokyonightPalette },
  kanagawa:   { id: 'kanagawa',   label: 'Kanagawa',      description: 'Wave variant — muted ink dark with crystal-blue accent.', palette: kanagawaPalette },
  catppuccin: { id: 'catppuccin', label: 'Catppuccin',    description: 'Mocha — gentle pastel violet/blue dark.', palette: catppuccinPalette },
  dracula:    { id: 'dracula',    label: 'Dracula',       description: 'Classic purple/pink accents with cyan links.', palette: draculaPalette },
  rosepine:   { id: 'rosepine',   label: 'Rosé Pine',     description: 'Muted rose/pine dark with soho elegance.', palette: rosepinePalette },
  nord:       { id: 'nord',       label: 'Nord',          description: 'Cool arctic blue/teal frost dark.', palette: nordPalette },
  gruvbox:    { id: 'gruvbox',    label: 'Gruvbox',       description: 'Retro warm earthy dark with green/orange accents.', palette: gruvboxPalette },
  everforest: { id: 'everforest', label: 'Everforest',    description: 'Soft natural green dark, easy on the eyes.', palette: everforestPalette },
  light:      { id: 'light',      label: 'GitHub Light',   description: 'Bright white surface with high-contrast dark ink.', palette: lightPalette },
};

/** Display order for the theme picker. */
export const THEME_ORDER = ['basic', 'basicIndigo', 'warm', 'teal', 'onedark', 'tokyonight', 'kanagawa', 'catppuccin', 'dracula', 'rosepine', 'nord', 'gruvbox', 'everforest', 'light'];

export { basePalette, basicPalette };
