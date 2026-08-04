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
  const legacy = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(computed);
  if (legacy) {
    return { r: +legacy[1], g: +legacy[2], b: +legacy[3], a: legacy[4] === undefined ? 1 : +legacy[4] };
  }
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(computed);
  if (!srgb) return null;
  return { r: +srgb[1] * 255, g: +srgb[2] * 255, b: +srgb[3] * 255, a: srgb[4] === undefined ? 1 : +srgb[4] };
}

/** Source-over composite of the translucent scrim onto an opaque base. */
function over(top: Rgba, base: Rgba): string {
  const channel = (t: number, b: number) =>
    Math.max(0, Math.min(255, Math.round(t * top.a + b * (1 - top.a))))
      .toString(16).padStart(2, '0');
  return `#${channel(top.r, base.r)}${channel(top.g, base.g)}${channel(top.b, base.b)}`;
}

let holds = 0;

function sendDim(): void {
  const scrim = resolveCssColor('var(--mx-scrim)');
  const band = resolveCssColor('var(--mx-window-band)');
  if (!scrim || !band) return;
  const light = window.getComputedStyle(document.documentElement).colorScheme === 'light';
  const symbol: Rgba = light ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  bridge()?.setTitleBarDim?.({ color: over(scrim, band), symbolColor: over(scrim, symbol) })
    ?.catch?.(() => undefined);
}

/** One fullscreen-scrim claim; the returned release drops it (idempotent). */
export function acquireTitleBarDim(): () => void {
  holds += 1;
  if (holds === 1) sendDim();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds === 0) bridge()?.setTitleBarDim?.(null)?.catch?.(() => undefined);
  };
}

/** Re-send the composite after a theme swap while a modal stays open. */
export function refreshTitleBarDim(): void {
  if (holds > 0) sendDim();
}
