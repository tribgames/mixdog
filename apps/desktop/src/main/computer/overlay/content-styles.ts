export const overlayStyles = `
:root { --accent:#58a6ff;color-scheme:dark;font-family:"Segoe UI",system-ui,sans-serif; }
* { box-sizing:border-box; }
html,body { width:100%;height:100%;margin:0;overflow:hidden;background:transparent; }
body { display:flex;align-items:flex-start;justify-content:center;padding:10px; }
#pill { position:relative;display:flex;align-items:center;gap:10px;padding:11px 13px;border-radius:24px;
background:rgba(15,18,24,.96);box-shadow:0 6px 16px #0005;color:#f4f7fb;width:100%;max-width:100%;
transition:opacity 180ms ease,transform 180ms ease; }
body.hiding #pill { opacity:0;transform:translateY(-4px); }
#outline { position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none; }
#outline rect { x:1.5px;y:1.5px;width:calc(100% - 3px);height:calc(100% - 3px);rx:22px;fill:none; }
#outline .track { stroke:color-mix(in srgb, var(--accent) 55%, transparent);stroke-width:1; }
#outline .highlight { stroke:color-mix(in srgb, var(--accent) 35%, white);stroke-width:2.5;
stroke-linecap:round;stroke-dasharray:18 82;filter:drop-shadow(0 0 4px var(--accent));
animation:outline-loop 2.8s linear infinite; }
#dot { width:10px;height:10px;flex-shrink:0;border-radius:50%;background:var(--accent);
animation:breathe 1.8s ease-in-out infinite; }
#status { min-width:0;flex:1; }
#title { font-size:15px;font-weight:650;white-space:nowrap; }
button { border:1px solid #ffffff33;border-radius:14px;background:#ffffff18;color:inherit;
width:30px;height:30px;padding:5px;cursor:pointer;flex-shrink:0;display:grid;place-items:center; }
button:hover { background:#ffffff30; }
button:disabled { opacity:.5;cursor:default; }
button:focus-visible { outline:2px solid var(--accent);outline-offset:2px; }
button svg { width:18px;height:18px;fill:currentColor; }
body[data-paused="true"] #dot { animation:none;opacity:.4; }
body[data-paused="true"] #outline .highlight,body.hiding #outline .highlight { animation-play-state:paused; }
body[data-error="true"] #dot { animation:none;background:#e3b341;opacity:1; }
@keyframes breathe { 0%,100% { opacity:.45; } 50% { opacity:1; } }
@keyframes outline-loop { to { stroke-dashoffset:-100; } }
@media (prefers-reduced-motion:reduce) {
  #dot { animation:none; }
  #outline .highlight { animation:none;stroke-dasharray:none; }
}
`;
