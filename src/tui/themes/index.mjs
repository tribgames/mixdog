/**
 * src/tui/themes/index.mjs — theme registry, order, and default id.
 *
 * Each theme lives in its own module and exports a COMPLETE palette built on
 * `basePalette` (One Dark). This index wires them into the registry consumed by
 * theme.mjs. The runtime singleton (`theme`) is seeded from the softened
 * `basicPalette` export below.
 */
import { basePalette } from './base.mjs';
import { basicPalette as rawBasicPalette } from './basic.mjs';
import { indigoPalette as rawIndigoPalette } from './indigo.mjs';
import { warmPalette as rawWarmPalette } from './warm.mjs';
import { lightPalette as rawLightPalette } from './light.mjs';
import { tealPalette as rawTealPalette } from './teal.mjs';
import { onedarkPalette as rawOnedarkPalette } from './onedark.mjs';
import { tokyonightPalette as rawTokyonightPalette } from './tokyonight.mjs';
import { kanagawaPalette as rawKanagawaPalette } from './kanagawa.mjs';
import { catppuccinPalette as rawCatppuccinPalette } from './catppuccin.mjs';
import { draculaPalette as rawDraculaPalette } from './dracula.mjs';
import { rosepinePalette as rawRosepinePalette } from './rosepine.mjs';
import { nordPalette as rawNordPalette } from './nord.mjs';
import { gruvboxPalette as rawGruvboxPalette } from './gruvbox.mjs';
import { everforestPalette as rawEverforestPalette } from './everforest.mjs';
import { softenTypographyColors } from './utils.mjs';

/** Default theme id (Basic — amber-gold default dark). */
export const DEFAULT_THEME_ID = 'basic';

/** Backward-compatible ids accepted from older persisted configs. */
export const THEME_ALIASES = {
  basicIndigo: 'indigo',
};

export const basicPalette = softenTypographyColors(rawBasicPalette);
const indigoPalette = softenTypographyColors(rawIndigoPalette);
const warmPalette = softenTypographyColors(rawWarmPalette);
const lightPalette = softenTypographyColors(rawLightPalette);
const tealPalette = softenTypographyColors(rawTealPalette);
const onedarkPalette = softenTypographyColors(rawOnedarkPalette);
const tokyonightPalette = softenTypographyColors(rawTokyonightPalette);
const kanagawaPalette = softenTypographyColors(rawKanagawaPalette);
const catppuccinPalette = softenTypographyColors(rawCatppuccinPalette);
const draculaPalette = softenTypographyColors(rawDraculaPalette);
const rosepinePalette = softenTypographyColors(rawRosepinePalette);
const nordPalette = softenTypographyColors(rawNordPalette);
const gruvboxPalette = softenTypographyColors(rawGruvboxPalette);
const everforestPalette = softenTypographyColors(rawEverforestPalette);

/** Theme registry: id -> { id, label, description, palette }. */
export const THEME_REGISTRY = {
  basic:      { id: 'basic',      label: 'Basic',        description: 'Amber-gold default dark with a hot orange live state.', palette: basicPalette },
  indigo:     { id: 'indigo',     label: 'Indigo',       description: 'Cool violet-blue brand dark with orange live state.', palette: indigoPalette },
  warm:       { id: 'warm',       label: 'Warm',         description: 'Terracotta / cream sunset dark.', palette: warmPalette },
  light:      { id: 'light',      label: 'Light',        description: 'GitHub Light — bright surface with high-contrast dark ink.', palette: lightPalette },
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
};

/** Display order for the theme picker. */
export const THEME_ORDER = ['basic', 'indigo', 'warm', 'light', 'teal', 'onedark', 'tokyonight', 'kanagawa', 'catppuccin', 'dracula', 'rosepine', 'nord', 'gruvbox', 'everforest'];

export { basePalette };
