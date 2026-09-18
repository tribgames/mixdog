export const overlayStyles = `
:root { --accent:#58a6ff;color-scheme:dark;font-family:"Segoe UI",system-ui,sans-serif; }
* { box-sizing:border-box; }
html,body { width:100%;height:100%;margin:0;overflow:hidden;background:transparent; }
body { display:flex;align-items:flex-start;justify-content:flex-end;padding:10px; }
#pill { position:relative;display:flex;align-items:center;justify-content:center;gap:8px;padding:11px 44px;border-radius:24px;
background:rgba(15,18,24,.96);box-shadow:0 6px 16px #0005;color:#f4f7fb;width:100%;max-width:100%;
transition:opacity 180ms ease,transform 180ms ease; }
body.hiding #pill { opacity:0;transform:translateY(-4px); }
#outline { position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none; }
#outline rect { x:1.5px;y:1.5px;width:calc(100% - 3px);height:calc(100% - 3px);rx:22px;fill:none; }
#outline .track { stroke:color-mix(in srgb, var(--accent) 55%, transparent);stroke-width:1; }
#outline .highlight { stroke:color-mix(in srgb, var(--accent) 35%, white);stroke-width:2.5;
stroke-linecap:round;stroke-dasharray:18 82;filter:drop-shadow(0 0 4px var(--accent));
animation:outline-loop 2.8s linear infinite; }
#status { min-width:0; }
/* The wording itself carries the "still working" pulse, slow enough to read as
   breathing rather than blinking. */
#title { font-size:17px;line-height:24px;font-weight:650;white-space:nowrap;text-align:center;
animation:title-breathe 3.6s ease-in-out infinite; }
button[hidden] { display:none; }
button { position:absolute;right:10px;top:50%;transform:translateY(-50%);
border:1px solid #ffffff33;border-radius:14px;background:#ffffff18;color:inherit;
width:30px;height:30px;padding:5px;cursor:pointer;flex-shrink:0;display:grid;place-items:center; }
button:hover { background:#ffffff30; }
button:disabled { opacity:.5;cursor:default; }
button[aria-busy="true"] { opacity:.6; }
body[data-error="true"] #title { color:#e3b341; }
button:focus-visible { outline:2px solid var(--accent);outline-offset:2px; }
button svg { width:18px;height:18px;fill:currentColor; }
body[data-paused="true"] #outline .highlight { display:none; }
body[data-paused="true"] #outline .highlight,body.hiding #outline .highlight { animation-play-state:paused; }
body[data-paused="true"] #title,body[data-error="true"] #title { animation:none;opacity:1; }
@keyframes title-breathe { 0%,100% { opacity:.7; } 50% { opacity:1; } }
@keyframes outline-loop { to { stroke-dashoffset:-100; } }
@media (prefers-reduced-motion:reduce) {
  #title { animation:none; }
  #outline .highlight { animation:none;stroke-dasharray:none; }
}
`;
