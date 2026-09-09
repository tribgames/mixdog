export const CURSOR_SIZE = 96;
export const CURSOR_HOTSPOT = 40;

/** Decorative halo and input feedback; the OS still owns the single physical pointer. */
export function cursorHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none}
#surface{width:100%;height:100%;opacity:0;transition:opacity 100ms linear;--accent:#58a6ff;--hotspot:${CURSOR_HOTSPOT}px;--soft:color-mix(in srgb,var(--accent) 22%,transparent);--glow:color-mix(in srgb,var(--accent) 40%,transparent)}
#surface.visible{opacity:1}
#halo,#ring,#echo{position:absolute;left:calc(var(--hotspot) - 18px);top:calc(var(--hotspot) - 18px);width:36px;height:36px;box-sizing:border-box;border-radius:50%;opacity:0;transform-origin:center}
#halo{border:1px solid color-mix(in srgb,var(--accent) 75%,white);background:radial-gradient(circle,transparent 38%,var(--soft) 70%,transparent 74%);box-shadow:0 0 0 1px #10203330,0 0 10px var(--soft),inset 0 0 5px #ffffff24}
#ring,#echo{border:1.5px solid var(--accent);box-shadow:0 0 5px var(--glow)}
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
.type #halo{animation:tap 240ms ease-out}
.type #ring{animation:press 280ms ease-out}
.scroll #halo{animation:tap 380ms ease-out}
.scroll #ring{animation:press 420ms ease-out}
@keyframes press{0%{opacity:0;transform:scale(.5)}12%{opacity:.9}100%{opacity:0;transform:scale(1.7)}}
@keyframes prepare{0%{opacity:.5;transform:scale(1)}100%{opacity:.95;transform:scale(.62)}}
@keyframes focus{from{transform:scale(.8)}to{transform:scale(.62)}}
@keyframes tap{0%{opacity:1;transform:scale(.55)}35%{opacity:.95;transform:scale(.9)}100%{opacity:0;transform:scale(.8)}}
@media(prefers-reduced-motion:reduce){
  #surface{transition:none}
  #surface #halo,#surface #ring,#surface #echo{animation:none}
  #surface:not(.move) #halo{opacity:.85;transform:scale(.7)}
  #surface:not(.move) #ring{opacity:.9;transform:scale(.7)}
  #surface #echo{opacity:0}
}
</style></head><body><div id="surface" aria-hidden="true"><div id="halo"></div><div id="ring"></div><div id="echo"></div>
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
