export const CURSOR_SIZE = 96;
export const CURSOR_HOTSPOT = 40;

/** Effects only: the OS owns the single physical pointer. No arrow or text. */
export function cursorHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none}
#surface{width:100%;height:100%;opacity:0;transition:opacity 100ms linear;--accent:#58a6ff;--hotspot:${CURSOR_HOTSPOT}px}
#surface.visible{opacity:1}
#ring{position:absolute;left:calc(var(--hotspot) - 20px);top:calc(var(--hotspot) - 20px);width:40px;height:40px;box-sizing:border-box;border:2px solid var(--accent);border-radius:50%;opacity:0;transform-origin:center}
.click #ring{animation:press 260ms ease-out}
.move #ring{opacity:.75;transform:scale(.8);background:color-mix(in srgb,var(--accent) 16%,transparent);box-shadow:0 0 8px color-mix(in srgb,var(--accent) 45%,transparent)}
.prepare #ring{animation:prepare 120ms ease-out forwards}
.press #ring{opacity:.95;transform:scale(.45);background:var(--accent)}
.double_click #ring{animation:press 200ms ease-out 2}
.drag #ring{opacity:.6;transform:scale(.65)}
.type #ring{animation:press 180ms ease-out}
.scroll #ring{animation:press 380ms ease-out}
@keyframes press{0%{opacity:.85;transform:scale(.35)}100%{opacity:0;transform:scale(1.65)}}
@keyframes prepare{0%{opacity:.5;transform:scale(1.2)}100%{opacity:.95;transform:scale(.55)}}
</style></head><body><div id="surface"><div id="ring"></div>
</div></body></html>`;
}

export function cursorScript(): string {
  return `(() => {
    let fade;
    const surface = document.getElementById('surface');
    window.mixdogAgentCursor = state => {
      clearTimeout(fade);
      surface.style.setProperty('--accent', state.accent || '#58a6ff');
      surface.className = 'visible';
      void surface.offsetWidth;
      surface.className = 'visible ' + (state.effect || 'move');
      if (state.effect !== 'move') fade = setTimeout(() => { surface.className = ''; }, 1000);
    };
  })();`;
}
