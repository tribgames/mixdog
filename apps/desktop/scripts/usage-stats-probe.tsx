// Isolated rendering of the real command surface with synthetic accounting.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CommandSurface } from '../src/renderer/CommandSurface';
import { initUiLanguage, setUiLanguagePreference } from '../src/renderer/i18n';
import '@fontsource-variable/jetbrains-mono';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import '../src/renderer/ui/tokens.css';
import '../src/renderer/styles.css';
import '../src/renderer/desktop.css';
import '../src/renderer/pane-layout.css';
import '../src/renderer/mobile-web-runtime.css';

setUiLanguagePreference('ko');
await initUiLanguage();
let release: (() => void) | null = null;
const api = {
  async invokeCapability({ args = [] }: { args?: unknown[] }) {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = new URLSearchParams(args[0] as Record<string, string>);
    const response = await fetch(`/usage-stats?${query}`);
    if (!response.ok) throw new Error(await response.text());
    return { value: await response.json() };
  },
};
function Probe() {
  const [open, setOpen] = useState(true);
  const [compact, setCompact] = useState(false);
  return (
    <>
      <nav style={{ position: 'fixed', top: 0, left: 0, zIndex: 100000 }}>
        <button onClick={() => release?.()}>Load fixture</button>
        <button onClick={() => setOpen(true)}>Reopen fixture</button>
        <button onClick={() => setCompact(true)}>Compact fixture</button>
        <span> Synthetic usage layout fixture </span>
      </nav>
      {compact ? (
        <iframe title="Compact usage fixture" src="/" style={{ width: 600, height: 480, margin: '40px', border: 0 }} />
      ) : (
        <CommandSurface surface="stats" open={open} api={api as never} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Probe />);
const frames: unknown[] = [];
const geometry = new Map<string, { min: number[]; max: number[]; frames: number }>();
Object.assign(window, { usageProbeFrames: frames, usageProbeGeometry: geometry });
function sample() {
  const dialog = document.querySelector('.command-surface[data-surface="stats"]');
  if (dialog) {
    const box = dialog.getBoundingClientRect();
    const busy = dialog.getAttribute('aria-busy');
    const active = document.querySelector('.stats-controls .is-active')?.textContent;
    const sections = ['.stats-cards', '.stats-trend', '.usage-table-shell'].map((selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? { y: rect.y, height: rect.height } : null;
    });
    const cards = document.querySelector('.stats-cards');
    frames.push({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      busy,
      active,
      sections,
      models: document.querySelectorAll('.stats-model-row').length,
      cardsOpacity: cards ? getComputedStyle(cards).opacity : null,
    });
    const key = `${innerWidth}x${innerHeight}:${busy}:${active}`;
    const values = [box.x, box.y, box.width, box.height, ...sections.flatMap((s) => [s?.y ?? 0, s?.height ?? 0])];
    const measure = geometry.get(key) || { min: values.slice(), max: values.slice(), frames: 0 };
    measure.min = measure.min.map((v, i) => Math.min(v, values[i]));
    measure.max = measure.max.map((v, i) => Math.max(v, values[i]));
    measure.frames++;
    geometry.set(key, measure);
    if (frames.length > 1800) frames.shift();
  }
  requestAnimationFrame(sample);
}
requestAnimationFrame(sample);
