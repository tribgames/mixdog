// Built-in skin data. accent/cast were computed once from the shipped
// pictures (the same extraction setCustomSkin still runs for a user's image)
// and are hard-coded; `focal` keeps the subject clear of the centred text
// column. Swapping a picture keeps its file name; refresh accent/cast then.
import type { SkinCast, SkinPlate } from './skin-color';

export type SkinManifestEntry = {
  id: string;
  /** i18n key of the display name. */
  label: string;
  /** File name under skins/: the picture, which is also the loop's poster. */
  file: string;
  /** Moving background under skins/: a seamless 12 s VP9 loop of the picture
      with drawn light over it, made by scripts/generate-skin-loops.py (rerun
      it after swapping a picture). */
  loop: string;
  /** CSS background-position of the picture ('x% y%'). */
  focal: string;
  accent: string;
  cast: SkinCast;
  /** Average colour of the picture: the contrast guards judge plates against it. */
  picture: string;
  /** Default plate tone; the user may override it per device. */
  plate: SkinPlate;
};

/** Preset accents offered next to "from the picture". The contrast guard
    (fitAccent) still adjusts whichever one is chosen to the plate. */
export const ACCENT_SWATCHES: ReadonlyArray<{ color: string; label: string }> = [
  { color: '#5bb0ff', label: 'Blue accent' },
  { color: '#6fcf8e', label: 'Green accent' },
  { color: '#f2a33a', label: 'Orange accent' },
  { color: '#e9799a', label: 'Pink accent' },
  { color: '#9b8cff', label: 'Violet accent' },
];

export const SKIN_MANIFEST: ReadonlyArray<SkinManifestEntry> = [
  {
    id: 'glass-flow',
    label: 'Glass flow',
    file: 'glass-flow.jpg',
    loop: 'glass-flow.webm',
    focal: '85% 60%',
    accent: '#3a73de',
    cast: { hue: 222, sat: 72 },
    picture: '#b1c4ef',
    plate: 'light',
  },
  {
    id: 'spring-window',
    label: 'Spring window',
    file: 'spring-window.jpg',
    loop: 'spring-window.webm',
    focal: '85% 50%',
    accent: '#cb834d',
    cast: { hue: 32, sat: 53 },
    picture: '#e1ccb5',
    plate: 'light',
  },
  {
    id: 'tech-studio',
    label: 'Tech studio',
    file: 'tech-studio.jpg',
    loop: 'tech-studio.webm',
    focal: '85% 60%',
    accent: '#4d62cb',
    cast: { hue: 237, sat: 38 },
    picture: '#636793',
    plate: 'dark',
  },
  {
    id: 'night-city',
    label: 'Night city',
    file: 'night-city.jpg',
    loop: 'night-city.webm',
    focal: '50% 80%',
    accent: '#4d5bcb',
    cast: { hue: 242, sat: 47 },
    picture: '#272446',
    plate: 'dark',
  },
];
