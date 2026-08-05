// The Windows min/max/close controls live in a NATIVE overlay (WCO): DOM
// scrims cannot paint over them, so a fullscreen modal used to dim the whole
// app EXCEPT that band, which stayed at the full-brightness theme color
// (user: 딤드도 안 먹고 색도 튀던데). While at least one fullscreen scrim
// holds a claim here, the scrim-composited band/symbol colors ride the
// native overlay itself; releasing the last claim restores the theme band.
type Rgba = { r: number; g: number; b: number; a: number };

type TitleBarDimBridge = {
  mixdogDesktop?: {
    setTitleBarDim?: (dim: { color: string; symbolColor: string } | null) => Promise<void>;
  };
};

function bridge() {
  return (window as unknown as TitleBarDimBridge).mixdogDesktop;
}

function parseColor(computed: string): Rgba | null {
  const legacy = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(computed);
  if (legacy) {
    return { r: +legacy[1], g: +legacy[2], b: +legacy[3], a: legacy[4] === undefined ? 1 : +legacy[4] };
  }
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(computed);
  if (!srgb) return null;
  return { r: +srgb[1] * 255, g: +srgb[2] * 255, b: +srgb[3] * 255, a: srgb[4] === undefined ? 1 : +srgb[4] };
}

// color-mix() variables resolve only on a live element, so a 1px offscreen
// probe turns the token into a concrete rgb()/color(srgb) value.
function resolveCssColor(value: string): Rgba | null {
  if (typeof document === 'undefined' || !document.body) return null;
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;pointer-events:none;';
  probe.style.backgroundColor = value;
  document.body.appendChild(probe);
  const computed = window.getComputedStyle(probe).backgroundColor;
  probe.remove();
  return parseColor(computed);
}

/** Every fullscreen scrim currently painting over the window band. Counting
 *  claims guessed one layer per modal; reading the LIVE layers makes the
 *  caption match whatever the DOM actually shows, nesting included. */
const SCRIM_LAYERS = '.onboarding-layer, .schedules-dialog-layer, .mixdog-settings-layer,'
  + ' .settings-confirm-layer, .mx-dialog-layer, .settings-oauth-layer';

/** Compact settings replaces the whole window instead of floating above it.
 *  Its layer still owns the normal modal scrim token, but that paint is fully
 *  covered by the opaque dialog and must not darken the native caption band. */
function fullBleedSettingsSurface(): HTMLElement | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  const layer = document.querySelector<HTMLElement>('.mixdog-settings-layer[data-surface-active="true"]');
  const dialog = layer?.querySelector<HTMLElement>('.mixdog-settings');
  if (!layer || !dialog || layer.getClientRects().length === 0) return null;
  const rect = dialog.getBoundingClientRect();
  const tolerance = 1;
  const coversViewport = rect.left <= tolerance && rect.top <= tolerance
    && rect.right >= window.innerWidth - tolerance
    && rect.bottom >= window.innerHeight - tolerance;
  return coversViewport
    ? dialog.querySelector<HTMLElement>('.mixdog-settings__panel') || dialog
    : null;
}

function visibleScrims(): Rgba[] {
  if (typeof document === 'undefined') return [];
  const fullBleedSettings = fullBleedSettingsSurface();
  return Array.from(document.querySelectorAll<HTMLElement>(SCRIM_LAYERS))
    .filter((element) => element.getClientRects().length > 0)
    .filter((element) => !(fullBleedSettings && element.matches('.mixdog-settings-layer')))
    .map((element) => {
      const style = window.getComputedStyle(element);
      const color = parseColor(style.backgroundColor);
      if (!color) return null;
      // A fading scrim animates ELEMENT opacity, not its background alpha:
      // fold it in so the native band tracks the fade instead of jumping to
      // the settled color a beat early (user: 딤드될 때 혼자 튀어 보임).
      const opacity = Number.parseFloat(style.opacity);
      return Number.isFinite(opacity) ? { ...color, a: color.a * opacity } : color;
    })
    .filter((color): color is Rgba => color !== null && color.a > 0);
}

/** Source-over composite of a translucent layer onto an opaque base. */
function over(top: Rgba, base: Rgba): Rgba {
  const channel = (t: number, b: number) => t * top.a + b * (1 - top.a);
  return { r: channel(top.r, base.r), g: channel(top.g, base.g), b: channel(top.b, base.b), a: 1 };
}

function hex(color: Rgba): string {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value)))
    .toString(16).padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

let holds = 0;
let followFrame = 0;
let followUntil = 0;

function handleViewportChange(): void {
  // Crossing the compact width/height breakpoint changes settings from a
  // floating modal into a replacement surface while it remains mounted.
  sendCaption();
  followCaption(180);
}

/** Track the scrim motion frame-by-frame: WCO colors cannot transition, so
 *  the band re-samples the DOM's animated opacity until the fade settles. */
function followCaption(durationMs = 450): void {
  if (typeof requestAnimationFrame !== 'function') return;
  followUntil = performance.now() + durationMs;
  if (followFrame) return;
  const step = (): void => {
    sendCaption();
    followFrame = performance.now() < followUntil ? requestAnimationFrame(step) : 0;
  };
  followFrame = requestAnimationFrame(step);
}

/** The caption band is native chrome, so its colors are PUSHED from the theme
 *  tokens: pure black/white symbols read heavier than the DOM icons beside
 *  them (user: 아이콘이랑 최대최소닫기 색감이 동떨어져 있다). While a modal
 *  holds a claim, the same scrim is composited on top of both. */
function sendCaption(): void {
  // Prefer the ACTUAL painted titlebar over the token: the caption band must
  // read as one surface with the strip beside it (user: 배경이랑 완전히
  // 동화됐으면), even if a surface tweak moves the token. Full-bleed settings
  // replaces that strip, so its panel becomes the native caption surface.
  const fullBleedSettings = fullBleedSettingsSurface();
  const topbar = typeof document === 'undefined'
    ? null : document.querySelector<HTMLElement>('header.topbar');
  const captionSurface = fullBleedSettings || topbar;
  const painted = captionSurface
    ? parseColor(window.getComputedStyle(captionSurface).backgroundColor)
    : null;
  const band = painted && painted.a === 1 ? painted : resolveCssColor('var(--mx-window-band)');
  if (!band) return;
  const light = window.getComputedStyle(document.documentElement).colorScheme === 'light';
  // Caption symbols share the EXACT ink of the DOM cluster beside them
  // (user: 그쪽만 혼자 다르게 튀어 보임): the native strokes are hairline,
  // so full cluster ink does not read heavier.
  const ink = resolveCssColor('var(--mx-icon)')
    ?? (light ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 });
  let plate = over(band, band);
  let symbol = over(ink, plate);
  // Stacked scrims darken the caption exactly as they darken the DOM: a
  // confirmation over the wizard paints TWO (user: 왜 - ㅁ x 는 딤드에 포함
  // 안 되는거야 — 한 겹만 먹고 있었다).
  for (const scrim of visibleScrims()) {
    plate = over(scrim, plate);
    symbol = over(scrim, symbol);
  }
  bridge()?.setTitleBarDim?.({ color: hex(plate), symbolColor: hex(symbol) })?.catch?.(() => undefined);
}

/** One fullscreen-scrim claim; the returned release drops it (idempotent). */
export function acquireTitleBarDim(): () => void {
  holds += 1;
  if (holds === 1 && typeof window !== 'undefined') {
    window.addEventListener('resize', handleViewportChange);
  }
  // Every claim re-composites: nested modals deepen the band, releasing one
  // lifts it back a layer.
  sendCaption();
  followCaption();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds === 0 && typeof window !== 'undefined') {
      window.removeEventListener('resize', handleViewportChange);
    }
    // Resting colors are themed too, so the band never snaps back to the
    // main process's black/white fallback.
    sendCaption();
    followCaption();
  };
}

/** Re-send the caption colors after a theme swap (dimmed or not). */
export function refreshTitleBarDim(): void {
  sendCaption();
}
