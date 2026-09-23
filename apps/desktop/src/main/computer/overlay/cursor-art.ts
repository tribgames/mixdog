/** Canvas is sized so the largest press ring (56px × 1.7) and its glow stay inside. */
export const CURSOR_SIZE = 136;
export const CURSOR_HOTSPOT = 60;

/** Both modes draw their own pointer at the action point, so the user's own cursor is never restyled. */
export function cursorHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none}
#surface{width:100%;height:100%;opacity:0;transition:opacity 100ms linear;--accent:#58a6ff;--hotspot:${CURSOR_HOTSPOT}px;--soft:color-mix(in srgb,var(--accent) 22%,transparent);--glow:color-mix(in srgb,var(--accent) 40%,transparent)}
#surface.visible{opacity:1}
#arrow{position:absolute;left:var(--hotspot);top:var(--hotspot);width:38px;height:49px;fill:url(#arrow-fill);stroke:#fff;stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round;filter:drop-shadow(0 1px 2px #0b1b2e77) drop-shadow(0 0 10px var(--glow))}
#arrow .sheen{stop-color:color-mix(in srgb,var(--accent) 40%,white)}
#arrow .core{stop-color:var(--accent)}
#halo,#ring,#echo{position:absolute;left:calc(var(--hotspot) - 28px);top:calc(var(--hotspot) - 28px);width:56px;height:56px;box-sizing:border-box;border-radius:50%;opacity:0;transform-origin:center}
#halo{border:1.5px solid color-mix(in srgb,var(--accent) 75%,white);background:radial-gradient(circle,transparent 38%,var(--soft) 70%,transparent 74%);box-shadow:0 0 0 1px #10203330,0 0 16px var(--soft),inset 0 0 8px #ffffff24}
#ring,#echo{border:3px solid var(--accent);box-shadow:0 0 10px var(--glow)}
#echo{border-color:color-mix(in srgb,var(--accent) 55%,white)}
.move #halo{opacity:.8;transform:scale(.8)}
.move #ring{opacity:.45;transform:scale(.8);border-width:1px;box-shadow:none}
.prepare #halo{opacity:1;animation:focus 120ms ease-out forwards}
.prepare #ring{animation:prepare 120ms ease-out forwards}
.press #halo,.drag #halo{opacity:1;transform:scale(.62);background:var(--soft)}
.press #ring,.drag #ring{opacity:.9;transform:scale(.62)}
.click #halo{animation:tap 460ms ease-out}
.click #ring{animation:press 520ms cubic-bezier(.16,1,.3,1)}
.click #echo{animation:press 520ms 90ms cubic-bezier(.16,1,.3,1) backwards}
.double_click #halo{animation:tap 280ms ease-out 2}
.double_click #ring{animation:press 280ms ease-out 2}
.double_click #echo{animation:press 280ms 70ms ease-out 2 backwards}
.type #halo{opacity:1;transform:scale(.66);animation:typing 1400ms ease-in-out infinite}
.type #ring{opacity:.55;transform:scale(.66);border-width:1.5px;box-shadow:none}
.scroll #halo{animation:tap 380ms ease-out}
.scroll #ring{animation:press 420ms ease-out}
@keyframes press{0%{opacity:0;transform:scale(.5)}12%{opacity:.9}100%{opacity:0;transform:scale(1.7)}}
@keyframes prepare{0%{opacity:.5;transform:scale(1)}100%{opacity:.95;transform:scale(.62)}}
@keyframes focus{from{transform:scale(.8)}to{transform:scale(.62)}}
@keyframes tap{0%{opacity:1;transform:scale(.55)}35%{opacity:.95;transform:scale(.9)}100%{opacity:0;transform:scale(.8)}}
@keyframes typing{0%,100%{opacity:.6;transform:scale(.6)}50%{opacity:1;transform:scale(.76)}}
@media(prefers-reduced-motion:reduce){
  #surface{transition:none}
  #surface #halo,#surface #ring,#surface #echo{animation:none}
  #surface:not(.move) #halo{opacity:.85;transform:scale(.7)}
  #surface:not(.move) #ring{opacity:.9;transform:scale(.7)}
  #surface #echo{opacity:0}
}
</style></head><body><div id="surface" aria-hidden="true"><div id="halo"></div><div id="ring"></div><div id="echo"></div>
<svg id="arrow" viewBox="0 0 22 28"><defs><linearGradient id="arrow-fill" x1="0" y1="0" x2=".4" y2="1"><stop class="sheen" offset="0"/><stop class="core" offset="1"/></linearGradient></defs><path d="M1 1L2 22L8 16L13 26L17 24L12 14L21 13Z"/></svg>
</div></body></html>`;
}

export function cursorScript(): string {
  return `(() => {
    const surface = document.getElementById('surface');
    window.mixdogAgentCursor = state => {
      surface.style.setProperty('--accent', state.accent || '#58a6ff');
      surface.dataset.mode = state.mode === 'background' ? 'background' : 'foreground';
      surface.className = 'visible';
      void surface.offsetWidth;
      surface.className = 'visible ' + (state.effect || 'move');
    };
  })();`;
}
