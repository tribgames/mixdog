// First-paint snapshot of the skin and the user JSON theme. The bundle paints
// both only after it has run, so a launch, reload or window re-creation showed
// the default theme (and the picture without its plates) first. Whenever
// desktop-skin.ts / appearance/user-theme.ts finish painting they record
// exactly what they set on <html> here; public/boot.js (generated from
// scripts/i18n/boot.template.js) replays it synchronously before the first
// paint, so the bundle's later paint writes identical values.
//
// One localStorage record: { v, sig, inputs, themeId, skin, userTheme }.
//  - sig: window.mixdogBootSig, a hash of this build's chunk list; another
//    build (an update changes the picture URL) ignores the record.
//  - inputs: window.mixdogThemeInputs(), what boot resolves the light/dark
//    mode from; when it differs the recorded vars were computed for another
//    appearance and the record is ignored.
//  - skin: the data-mixdog-skin* attributes, the --mx-skin-* inline values
//    and the picture (a built-in's URL, or the key the custom picture is
//    already stored under; it is never copied here).
//  - userTheme: the active theme's id and the injected style sheet's text.
const SKIN_BOOT_KEY = 'mixdog.desktop.skin-boot.v1';
/** desktop-skin.ts's key of the custom picture (a data URL, too large to copy). */
export const SKIN_BOOT_CUSTOM_IMAGE_KEY = 'mixdog.desktop.skin-custom-image.v1';
const USER_THEME_STYLE_ID = 'mixdog-user-theme';
const SKIN_ATTRIBUTES = ['data-mixdog-skin', 'data-mixdog-skin-plate', 'data-mixdog-skin-photo'];
const IMAGE_VAR = '--mx-skin-image';

type BootSkin = {
  attributes: Record<string, string>;
  vars: Record<string, string>;
  image: { url: string } | { custom: string } | null;
};
type BootUserTheme = { id: string; css: string };
export type SkinBootSnapshot = {
  v: 1;
  sig: string;
  inputs: string;
  themeId: string;
  skin: BootSkin | null;
  userTheme: BootUserTheme | null;
};

type BootHost = Window & { mixdogBootSig?: string; mixdogThemeInputs?: () => string };

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read(): SkinBootSnapshot | null {
  try {
    const parsed = JSON.parse(storage()?.getItem(SKIN_BOOT_KEY) || 'null') as Partial<SkinBootSnapshot> | null;
    return parsed && parsed.v === 1 ? (parsed as SkinBootSnapshot) : null;
  } catch {
    return null;
  }
}

function skinSection(root: HTMLElement): BootSkin | null {
  if (!root.dataset.mixdogSkin) return null;
  const attributes: Record<string, string> = {};
  for (const name of SKIN_ATTRIBUTES) {
    const value = root.getAttribute(name);
    if (value !== null) attributes[name] = value;
  }
  const vars: Record<string, string> = {};
  for (let index = 0; index < root.style.length; index += 1) {
    const name = root.style[index];
    if (name.startsWith('--mx-skin-')) vars[name] = root.style.getPropertyValue(name);
  }
  const picture = vars[IMAGE_VAR];
  delete vars[IMAGE_VAR];
  let image: BootSkin['image'] = null;
  if (picture && picture !== 'none')
    image = picture.startsWith('url("data:') ? { custom: SKIN_BOOT_CUSTOM_IMAGE_KEY } : { url: picture };
  return { attributes, vars, image };
}

function write(update: (current: SkinBootSnapshot) => SkinBootSnapshot): void {
  const store = storage();
  if (!store) return;
  const host = window as BootHost;
  const themeId = document.documentElement.dataset.mixdogTheme;
  const current = read() ?? { v: 1 as const, sig: '', inputs: '', themeId: '', skin: null, userTheme: null };
  const next = update(current);
  next.sig = host.mixdogBootSig ?? '';
  next.inputs = host.mixdogThemeInputs?.() ?? '';
  // Only the appearances boot can reproduce without the palette registry.
  if (themeId === 'basic' || themeId === 'light') next.themeId = themeId;
  try {
    if (!next.skin && !next.userTheme) store.removeItem(SKIN_BOOT_KEY);
    else {
      const text = JSON.stringify(next);
      if (store.getItem(SKIN_BOOT_KEY) !== text) store.setItem(SKIN_BOOT_KEY, text);
    }
  } catch {
    // A full store only loses the first-paint head start.
  }
}

/** desktop-skin.ts calls this after every paint (skin on or off). */
export function syncSkinBootSnapshot(): void {
  write((current) => ({ ...current, skin: skinSection(document.documentElement) }));
}

/** appearance/user-theme.ts calls this after every paint (theme on or off). */
export function syncUserThemeBootSnapshot(): void {
  const root = document.documentElement;
  const css = document.getElementById(USER_THEME_STYLE_ID)?.textContent ?? '';
  const id = root.dataset.mixdogUserTheme;
  write((current) => ({ ...current, userTheme: id && css ? { id, css } : null }));
}
