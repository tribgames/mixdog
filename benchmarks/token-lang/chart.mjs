// Tech-site figures from results.json, rendered as HTML (Inter + JetBrains Mono)
// and captured to PNG with headless Edge:
//   results/chart.html|png   – per-language range chart (cheapest / most expensive model named)
//   results/heatmap.html|png – model × language heatmap (English first, averages last)
// Usage: node benchmarks/token-lang/chart.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'results');
const { sentences, results } = JSON.parse(readFileSync(join(OUT, 'results.json'), 'utf8'));

const LANGS = Object.keys(results[0].net);
const OTHERS = LANGS.filter((lang) => lang !== 'English');
const NATIVE = {
  Chinese: '中文',
  Japanese: '日本語',
  Korean: '한국어',
  Spanish: 'Español',
  French: 'Français',
  German: 'Deutsch',
  Russian: 'Русский',
  Arabic: 'العربية',
  Hindi: 'हिन्दी',
};
// Categorical palette (Observable 10 family), mapped loosely to each lab's identity.
const COLOR = {
  'GPT 6.1': '#3ca951',
  'Opus 5.5': '#ff725c',
  'Gemini 3.8 Flash': '#4269d0',
  'DeepSeek V4.1 Flash': '#6cc5b0',
  'Kimi K3': '#efb118',
  'GLM 5.3 Flash': '#a463f2',
  'Qwen 3.8 Flash': '#9c6b4e',
  'Muse Spark 1.3': '#ff8ab7',
  'Grok 4.7': '#3f3f46',
};
const X_MIN = 0.8;
const X_MAX = 4.5;

const ratio = (r, lang) => r.net[lang] / r.net.English;
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const f2 = (v) => `${v.toFixed(2)}×`;
const pct = (v) => (((v - X_MIN) / (X_MAX - X_MIN)) * 100).toFixed(2);
const dot = (name) => `<i class="dot" style="background:${COLOR[name] || '#a1a1aa'}"></i>`;

const BASE_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#fff}
body{width:1440px;padding:48px 56px;font-family:Inter,'Segoe UI',system-ui,sans-serif;color:#09090b;
  -webkit-font-smoothing:antialiased;font-feature-settings:'cv11' 1,'ss01' 1}
.mono{font-family:'JetBrains Mono',Consolas,monospace;font-feature-settings:'zero' 0}
.eyebrow{font-size:12px;font-weight:500;letter-spacing:.04em;color:#6366f1;height:16px}
.eyebrow span{color:#a1a1aa}
h1{font-size:30px;line-height:36px;font-weight:650;letter-spacing:-.025em;margin-top:10px}
.sub{font-size:15px;line-height:22px;color:#71717a;margin-top:8px}
.meta{display:flex;gap:8px;margin-top:18px;height:26px}
.meta span{font-size:11.5px;color:#3f3f46;background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;padding:4px 9px;line-height:16px}
.dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:8px;flex:none}
footer{margin-top:24px;font-size:12px;line-height:18px;color:#a1a1aa}
`;
const header = (path, title, sub) => `
<div class="eyebrow mono"><span>benchmarks /</span> tokenizer / ${path}</div>
<h1>${title}</h1>
<p class="sub">${sub}</p>
<div class="meta mono"><span>models=${results.length}</span><span>languages=${OTHERS.length}</span><span>dataset=flores-200 · n=${sentences}</span><span>system_prompt=none</span></div>`;
const footer = `<footer>Same ${sentences} parallel FLORES-200 devtest sentences per language, sent as one user message with no system prompt or tools. Fixed per-request overhead is measured with a one-character message and subtracted; values are each model's input tokens divided by its English input tokens.</footer>`;
const page = (css, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`;

// ---------- 1. Range chart ----------
// One row per language: a min–max range across models, the cheapest (green)
// and most expensive (red) model named at the ends, other models as grey dots
// and the average as a dark tick. Rows sorted by average.
const rangeCss = `
.legend{display:flex;gap:22px;margin-top:22px;height:18px;align-items:center;font-size:12.5px;color:#52525b}
.legend span{display:inline-flex;align-items:center}
.legend i{display:inline-block;margin-right:8px}
.k-b,.k-w{width:11px;height:11px;border-radius:50%}
.k-b{background:#059669}.k-w{background:#e11d48}
.k-o{width:8px;height:8px;border-radius:50%;background:#d4d4d8}
.k-m{width:2px;height:14px;border-radius:1px;background:#09090b}
.rp{margin-top:20px;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden}
.rr{display:grid;grid-template-columns:210px 1fr 110px;height:54px;align-items:center;border-bottom:1px solid #f4f4f5}
.rr:last-child{border-bottom:0}
.rr.ax{height:40px;background:#fafafa;border-bottom:1px solid #e4e4e7}
.lc{padding-left:24px;font-size:14.5px;font-weight:600}
.lc span{font-size:12.5px;font-weight:400;color:#a1a1aa;margin-left:8px}
.pc{position:relative;height:100%;margin:0 160px 0 170px}
.ac{text-align:right;padding-right:24px;font-size:15px;font-weight:600}
.ax .ac{font-size:11px;font-weight:500;color:#a1a1aa}
.g{position:absolute;top:0;bottom:0;width:1px;background:#f4f4f5}
.g.one{background:repeating-linear-gradient(to bottom,#a1a1aa 0 2px,transparent 2px 5px)}
.tk{position:absolute;top:50%;transform:translate(-50%,-50%);font-size:11px;color:#a1a1aa;white-space:nowrap}
.rg{position:absolute;top:50%;height:6px;margin-top:-3px;border-radius:3px;background:#e4e4e7}
.o{position:absolute;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:#d4d4d8}
.m{position:absolute;top:50%;width:2px;height:22px;margin:-11px 0 0 -1px;border-radius:1px;background:#09090b}
.b,.w{position:absolute;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2.5px solid #fff}
.b{background:#059669}.w{background:#e11d48}
.lb,.lw{position:absolute;top:50%;transform:translateY(-50%);white-space:nowrap;font-size:12.5px;color:#71717a;background:#fff;padding:2px 4px;border-radius:4px}
.lb b,.lw b{font-family:'JetBrains Mono',monospace;font-weight:700}
.lb b{color:#059669;margin-left:7px}.lw b{color:#e11d48;margin-right:7px}
`;
const grid = [1, 2, 3, 4].map((g) => `<i class="g${g === 1 ? ' one' : ''}" style="left:${pct(g)}%"></i>`).join('');
const axisRow = `<div class="rr ax"><div></div><div class="pc mono">${[1, 2, 3, 4]
  .map((g) => `<span class="tk" style="left:${pct(g)}%">${g === 1 ? 'EN 1×' : `${g}×`}</span>`)
  .join('')}</div><div class="ac mono">AVG</div></div>`;
const rangeRows = OTHERS.map((lang) => {
  const vals = results.map((r) => ({ name: r.name, v: ratio(r, lang) })).sort((a, b) => a.v - b.v);
  return { lang, vals, mean: avg(vals.map((d) => d.v)) };
})
  .sort((a, b) => a.mean - b.mean)
  .map(({ lang, vals, mean }) => {
    const best = vals[0];
    const worst = vals.at(-1);
    const others = vals
      .slice(1, -1)
      .map((d) => `<i class="o" style="left:${pct(d.v)}%" title="${d.name} ${f2(d.v)}"></i>`)
      .join('');
    return `<div class="rr"><div class="lc">${lang}<span>${NATIVE[lang] || ''}</span></div><div class="pc">${grid}<i class="rg" style="left:${pct(best.v)}%;width:${(pct(worst.v) - pct(best.v)).toFixed(2)}%"></i>${others}<i class="m" style="left:${pct(mean)}%"></i><i class="b" style="left:${pct(best.v)}%"></i><i class="w" style="left:${pct(worst.v)}%"></i><span class="lb" style="right:calc(${(100 - pct(best.v)).toFixed(2)}% + 15px)">${best.name}<b>${best.v.toFixed(2)}</b></span><span class="lw" style="left:calc(${pct(worst.v)}% + 15px)"><b>${worst.v.toFixed(2)}</b>${worst.name}</span></div><div class="ac mono">${f2(mean)}</div></div>`;
  })
  .join('');
const legend = `<div class="legend"><span><i class="k-b"></i>Most efficient model</span><span><i class="k-w"></i>Least efficient model</span><span><i class="k-o"></i>Other models</span><span><i class="k-m"></i>Average</span></div>`;
writeFileSync(
  join(OUT, 'chart.html'),
  page(
    rangeCss,
    `${header('by-language', 'Token cost by language', `Input tokens for the same text relative to English (1×), across ${results.length} models. Lower is better. Languages ordered by average.`)}${legend}<div class="rp">${axisRow}${rangeRows}</div>${footer}`
  )
);

// ---------- 2. Heatmap ----------
// Diverging-into-sequential scale: teal below 1× (cheaper than English),
// near-white at 1×, then amber → orange → crimson → deep wine.
const STOPS = [
  [0.85, [13, 118, 110]],
  [1.0, [248, 250, 252]],
  [1.2, [254, 240, 199]],
  [1.4, [252, 211, 77]],
  [1.65, [251, 146, 60]],
  [1.95, [234, 88, 12]],
  [2.4, [190, 18, 60]],
  [3.2, [127, 29, 29]],
  [4.3, [69, 10, 10]],
];
const rgbAt = (v) => {
  if (v <= STOPS[0][0]) return STOPS[0][1];
  for (let i = 1; i < STOPS.length; i++) {
    const [x1, c1] = STOPS[i];
    const [x0, c0] = STOPS[i - 1];
    if (v <= x1) return c0.map((c, k) => Math.round(c + (c1[k] - c) * ((v - x0) / (x1 - x0))));
  }
  return STOPS.at(-1)[1];
};
const css = (rgb) => `rgb(${rgb.join(',')})`;
const ink = ([r, g, b]) => ((0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.58 ? '#ffffff' : '#18181b');
const tile = (v, extra = '') => {
  const rgb = rgbAt(v);
  return `<div class="c mono${extra}" style="background:${css(rgb)};color:${ink(rgb)}">${f2(v)}</div>`;
};

const heatCss = `
.hm{margin-top:32px;display:grid;grid-template-columns:200px repeat(${results.length},1fr) 14px 118px;gap:5px}
.hh{height:64px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:8px;padding:0 4px 10px;text-align:center;font-size:12.5px;font-weight:600;color:#3f3f46;line-height:16px}
.hh .dot{margin:0}
.hh.l{align-items:flex-start;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:500;color:#a1a1aa}
.hh.a{color:#09090b}
.rl{height:50px;display:flex;align-items:center;font-size:14px;font-weight:600}
.rl span{font-size:12.5px;font-weight:400;color:#a1a1aa;margin-left:8px}
.c{height:50px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600}
.c.en{background:#fafafa !important;color:#a1a1aa !important;font-weight:500;border:1px dashed #e4e4e7}
.c.avg{box-shadow:inset 0 0 0 1.5px rgba(9,9,11,.6)}
.gap{height:50px}
.sep{grid-column:1/-1;height:6px}
.scale{display:flex;align-items:center;gap:16px;margin-top:28px;margin-bottom:34px}
.scale .lbl{font-size:12px;color:#71717a}
.bar{position:relative;width:420px;height:10px;border-radius:3px;background:linear-gradient(90deg,__GRAD__)}
.bar span{position:absolute;top:15px;transform:translateX(-50%);font-size:10.5px;color:#71717a}
`;
const SCALE_MIN = STOPS[0][0];
const SCALE_MAX = STOPS.at(-1)[0];
const pos = (v) => `${(((v - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100).toFixed(2)}%`;
const grad = STOPS.map(([v, rgb]) => `${css(rgb)} ${pos(v)}`).join(',');

const colAvg = (r) => avg(OTHERS.map((lang) => ratio(r, lang)));
const cells = [
  `<div class="hh l">language \\ model</div>`,
  ...results.map((r) => `<div class="hh">${dot(r.name)}<span>${r.name}</span></div>`),
  `<div></div>`,
  `<div class="hh a">Avg</div>`,
];
for (const lang of LANGS) {
  const en = lang === 'English';
  const vals = results.map((r) => ratio(r, lang));
  cells.push(`<div class="rl">${lang}<span>${NATIVE[lang] || ''}</span></div>`);
  cells.push(...vals.map((v) => (en ? `<div class="c mono en">${f2(v)}</div>` : tile(v))));
  cells.push(`<div class="gap"></div>`, en ? `<div class="c mono en">${f2(1)}</div>` : tile(avg(vals), ' avg'));
}
const totals = results.map(colAvg);
cells.push(
  `<div class="sep"></div>`,
  `<div class="rl">Avg<span>excl. English</span></div>`,
  ...totals.map((v) => tile(v, ' avg')),
  `<div class="gap"></div>`,
  tile(avg(totals), ' avg')
);
const scale = `<div class="scale"><span class="lbl">fewer tokens</span><div class="bar mono">${[1, 1.5, 2, 3, 4]
  .map((v) => `<span style="left:${pos(v)}">${v}×</span>`)
  .join('')}</div><span class="lbl">more tokens than English</span></div>`;
writeFileSync(
  join(OUT, 'heatmap.html'),
  page(
    heatCss.replace('__GRAD__', grad),
    `${header('heatmap', 'Token multiplier vs English', 'Input tokens for the same text divided by English input tokens, per model and language. Lower is better.')}<div class="hm">${cells.join('')}</div>${scale}${footer}`
  )
);

// ---------- PNG capture ----------
for (const [name, height] of [
  ['chart', 872],
  ['heatmap', 1056],
]) {
  execFileSync(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    '--virtual-time-budget=6000',
    `--window-size=1440,${height}`,
    `--screenshot=${join(OUT, `${name}.png`)}`,
    pathToFileURL(join(OUT, `${name}.html`)).href,
  ]);
  console.log(join(OUT, `${name}.png`));
}
