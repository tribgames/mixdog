import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';

chdir(fileURLToPath(new URL('../..', import.meta.url)));
const outDir = 'design/logo-concepts';

// 48 ultra-rich Aperture Triad Variations
const palettes = [
  // 1. Cyber & Neon Loops
  { id: 'univ-01', title: 'Electric Cyan to Violet 360°', cat: 'Cyber Neon', colors: ['#00f2fe', '#6366f1', '#ec4899'], core: 'spark', bg: '#080a10' },
  { id: 'univ-02', title: 'Hyperpop Magenta & Cyan', cat: 'Cyber Neon', colors: ['#f43f5e', '#06b6d4', '#a855f7'], core: 'glow-dot', bg: '#0b0813' },
  { id: 'univ-03', title: 'Acid Lime & Cobalt Cyber', cat: 'Cyber Neon', colors: ['#a3e635', '#0284c7', '#8b5cf6'], core: 'hex', bg: '#070c0d' },
  { id: 'univ-04', title: 'Synthwave Sunset Neon', cat: 'Cyber Neon', colors: ['#ff007a', '#7928ca', '#ff4d4d'], core: 'ring', bg: '#0d0714' },
  { id: 'univ-05', title: 'Plasma Violet Energy', cat: 'Cyber Neon', colors: ['#c084fc', '#38bdf8', '#f43f5e'], core: 'diamond', bg: '#0a0812' },
  { id: 'univ-06', title: 'Laser Turquoise Arc', cat: 'Cyber Neon', colors: ['#2dd4bf', '#3b82f6', '#ec4899'], core: 'prompt', bg: '#060e12' },

  // 2. Continuous 360° Full Spectrum & Nature
  { id: 'univ-07', title: 'Pure HSL 360° Full Rainbow', cat: '360° Spectrum', colors: ['#ef4444', '#10b981', '#3b82f6'], core: 'spark', bg: '#09090b' },
  { id: 'univ-08', title: 'Aurora Borealis Arctic Flow', cat: '360° Spectrum', colors: ['#10b981', '#06b6d4', '#8b5cf6'], core: 'glow-dot', bg: '#061012' },
  { id: 'univ-09', title: 'Sunset Horizon Golden Glow', cat: '360° Spectrum', colors: ['#f59e0b', '#ef4444', '#7c3aed'], core: 'spark', bg: '#100a06' },
  { id: 'univ-10', title: 'Bioluminescent Deep Abyss', cat: '360° Spectrum', colors: ['#34d399', '#0284c7', '#6366f1'], core: 'ring', bg: '#040d14' },
  { id: 'univ-11', title: 'Solar Flare Magma Ignition', cat: '360° Spectrum', colors: ['#facc15', '#f97316', '#dc2626'], core: 'diamond', bg: '#140804' },
  { id: 'univ-12', title: 'Twilight Sky Pastel Bloom', cat: '360° Spectrum', colors: ['#f472b6', '#c084fc', '#60a5fa'], core: 'glow-dot', bg: '#0d0914' },

  // 3. AI Coding Agent Themes (Cursor, Claude, Ghostty, Linear, etc.)
  { id: 'univ-13', title: 'Claude Warm Terracotta ✦', cat: 'AI Agent Theme', colors: ['#f97316', '#ea580c', '#d97706'], core: 'spark', bg: '#140c08' },
  { id: 'univ-14', title: 'Cursor Prism Cyan & Indigo', cat: 'AI Agent Theme', colors: ['#38bdf8', '#818cf8', '#6366f1'], core: 'diamond', bg: '#080a14' },
  { id: 'univ-15', title: 'Ghostty CRT Phosphor Green', cat: 'AI Agent Theme', colors: ['#4ade80', '#22c55e', '#15803d'], core: 'prompt', bg: '#051008' },
  { id: 'univ-16', title: 'Devin Emerald Intelligence', cat: 'AI Agent Theme', colors: ['#34d399', '#10b981', '#059669'], core: 'hex', bg: '#04120c' },
  { id: 'univ-17', title: 'Copilot Neon Purple & Sky', cat: 'AI Agent Theme', colors: ['#c084fc', '#38bdf8', '#e879f9'], core: 'ring', bg: '#0f0817' },
  { id: 'univ-18', title: 'Windsurf Cascade Wave', cat: 'AI Agent Theme', colors: ['#06b6d4', '#3b82f6', '#4f46e5'], core: 'spark', bg: '#060d17' },

  // 4. Luxury Hardware & Metal
  { id: 'univ-19', title: 'Machined Titanium & Amber LED', cat: 'Luxury Metal', colors: ['#e2e8f0', '#94a3b8', '#64748b'], core: 'amber-led', bg: '#0f1115' },
  { id: 'univ-20', title: 'Champagne Gold Prestige', cat: 'Luxury Metal', colors: ['#fde047', '#d97706', '#b45309'], core: 'gold-cross', bg: '#120f08' },
  { id: 'univ-21', title: 'Liquid Chrome Prism Mirror', cat: 'Luxury Metal', colors: ['#ffffff', '#cbd5e1', '#64748b'], core: 'diamond', bg: '#090a0d' },
  { id: 'univ-22', title: 'Rose Gold & Copper Satin', cat: 'Luxury Metal', colors: ['#fda4af', '#f43f5e', '#be123c'], core: 'ring', bg: '#13080c' },
  { id: 'univ-23', title: 'Gunmetal Obsidian Stealth', cat: 'Luxury Metal', colors: ['#64748b', '#334155', '#1e293b'], core: 'red-laser', bg: '#07080a' },
  { id: 'univ-24', title: 'Platinum White & Ice Blue', cat: 'Luxury Metal', colors: ['#ffffff', '#e0f2fe', '#38bdf8'], core: 'spark', bg: '#080d14' },

  // 5. Minimalist Monochrome & High Contrast
  { id: 'univ-25', title: 'Pure White Minimalist Core', cat: 'Monochrome', colors: ['#ffffff', '#ffffff', '#ffffff'], core: 'solid-dot', bg: '#0c0d11' },
  { id: 'univ-26', title: 'Monochrome Shading Sequence', cat: 'Monochrome', colors: ['#ffffff', '#94a3b8', '#475569'], core: 'ring', bg: '#08090c' },
  { id: 'univ-27', title: 'Inverted Clean Ceramic Light', cat: 'Monochrome', colors: ['#0f172a', '#334155', '#64748b'], core: 'solid-dot', bg: '#f8fafc' },
  { id: 'univ-28', title: 'Duo-Tone Stark White & Cyan', cat: 'Monochrome', colors: ['#ffffff', '#ffffff', '#00f2fe'], core: 'cyan-dot', bg: '#0a0c10' },
  { id: 'univ-29', title: 'Hacker Terminal Black & Green', cat: 'Monochrome', colors: ['#22c55e', '#16a34a', '#15803d'], core: 'prompt', bg: '#020703' },
  { id: 'univ-30', title: 'Charcoal Minimalist Void', cat: 'Monochrome', colors: ['#cbd5e1', '#64748b', '#334155'], core: 'donut', bg: '#0b0c0e' },

  // 6. Stroke Weight & Architecture Specials
  { id: 'univ-31', title: 'Ultra-Bold Chunky 32px Arc', cat: 'Architecture', colors: ['#38bdf8', '#818cf8', '#f43f5e'], core: 'solid-dot', bg: '#08090f', strokeWidth: 32 },
  { id: 'univ-32', title: 'Precision Hairline 14px Arc', cat: 'Architecture', colors: ['#00f2fe', '#818cf8', '#c084fc'], core: 'crosshair', bg: '#080912', strokeWidth: 14 },
  { id: 'univ-33', title: 'Heavy Impact 36px Block', cat: 'Architecture', colors: ['#f97316', '#ef4444', '#ec4899'], core: 'spark', bg: '#10070a', strokeWidth: 36 },
  { id: 'univ-34', title: 'Micro-Serif Wireframe Arc', cat: 'Architecture', colors: ['#34d399', '#38bdf8', '#818cf8'], core: 'ring', bg: '#060d12', strokeWidth: 16 },
  { id: 'univ-35', title: 'Double Pulse Neon Trace', cat: 'Architecture', colors: ['#facc15', '#f43f5e', '#8b5cf6'], core: 'glow-dot', bg: '#0e0814', strokeWidth: 26 },
  { id: 'univ-36', title: 'Feather Line 12px Blueprint', cat: 'Architecture', colors: ['#38bdf8', '#0284c7', '#0369a1'], core: 'crosshair', bg: '#050c14', strokeWidth: 12 },

  // 7. Cosmic Phase
  { id: 'univ-37', title: 'Cosmic Nebula Supernova', cat: 'Cosmic', colors: ['#e879f9', '#6366f1', '#06b6d4'], core: 'supernova', bg: '#090614' },
  { id: 'univ-38', title: 'Black Hole Event Horizon', cat: 'Cosmic', colors: ['#f59e0b', '#dc2626', '#450a0a'], core: 'black-hole', bg: '#050203' },
  { id: 'univ-39', title: 'Starlight Andromeda Galaxy', cat: 'Cosmic', colors: ['#38bdf8', '#ec4899', '#fbbf24'], core: 'star-triad', bg: '#060812' },
  { id: 'univ-40', title: 'Quantum Entanglement Loop', cat: 'Cosmic', colors: ['#10b981', '#f43f5e', '#3b82f6'], core: 'quantum', bg: '#070910' },
  { id: 'univ-41', title: 'Interstellar Pulsar Beam', cat: 'Cosmic', colors: ['#a855f7', '#00f2fe', '#ffffff'], core: 'pulsar', bg: '#080713' },
  { id: 'univ-42', title: 'Dark Matter Void Shimmer', cat: 'Cosmic', colors: ['#475569', '#818cf8', '#38bdf8'], core: 'glow-dot', bg: '#040508' },

  // 8. Creative Gradients & Pastels
  { id: 'univ-43', title: 'Cotton Candy Pastel Cloud', cat: 'Pastel & Fresh', colors: ['#fbcfe8', '#c4b5fd', '#bae6fd'], core: 'solid-dot', bg: '#100d16' },
  { id: 'univ-44', title: 'Matcha Tea & Fresh Mint', cat: 'Pastel & Fresh', colors: ['#86efac', '#6ee7b7', '#93c5fd'], core: 'glow-dot', bg: '#08120e' },
  { id: 'univ-45', title: 'Warm Peach & Strawberry', cat: 'Pastel & Fresh', colors: ['#fdba74', '#fca5a5', '#f472b6'], core: 'spark', bg: '#150a0f' },
  { id: 'univ-46', title: 'Lemon Sorbet & Glacier', cat: 'Pastel & Fresh', colors: ['#fef08a', '#a7f3d0', '#7dd3fc'], core: 'diamond', bg: '#071214' },
  { id: 'univ-47', title: 'Lavender Breeze & Violet', cat: 'Pastel & Fresh', colors: ['#e9d5ff', '#c084fc', '#818cf8'], core: 'ring', bg: '#0c0a15' },
  { id: 'univ-48', title: 'Midnight Obsidian Opal', cat: 'Pastel & Fresh', colors: ['#38bdf8', '#34d399', '#f43f5e'], core: 'opal-core', bg: '#06080d' }
];

function getCoreSvg(type, c1, c2, c3) {
  switch (type) {
    case 'spark':
      return `<path d="M128 112 Q128 128 112 128 Q128 128 128 144 Q128 128 144 128 Q128 128 128 112 Z" fill="#ffffff"/><circle cx="128" cy="128" r="3" fill="${c1}"/>`;
    case 'diamond':
      return `<polygon points="128,114 140,128 128,142 116,128" fill="#ffffff"/><polygon points="128,118 136,128 128,138 120,128" fill="${c1}"/>`;
    case 'ring':
      return `<circle cx="128" cy="128" r="14" fill="none" stroke="#ffffff" stroke-width="4"/><circle cx="128" cy="128" r="5" fill="${c1}"/>`;
    case 'donut':
      return `<circle cx="128" cy="128" r="13" fill="none" stroke="#ffffff" stroke-width="5"/>`;
    case 'hex':
      return `<polygon points="128,115 139,121 139,135 128,141 117,135 117,121" fill="${c1}" stroke="#ffffff" stroke-width="2.5"/><circle cx="128" cy="128" r="3" fill="#ffffff"/>`;
    case 'prompt':
      return `<path d="M121 120 L128 128 L121 136" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><line x1="131" y1="136" x2="137" y2="136" stroke="${c1}" stroke-width="3" stroke-linecap="round"/>`;
    case 'glow-dot':
      return `<circle cx="128" cy="128" r="20" fill="${c1}" opacity="0.4" filter="url(#core-blur)"/><circle cx="128" cy="128" r="11" fill="${c1}"/><circle cx="128" cy="128" r="4.5" fill="#ffffff"/>`;
    case 'amber-led':
      return `<circle cx="128" cy="128" r="10" fill="#fbbf24"/><circle cx="128" cy="128" r="4" fill="#ffffff"/><circle cx="128" cy="128" r="18" fill="none" stroke="#fbbf24" stroke-width="1.5" opacity="0.6"/>`;
    case 'gold-cross':
      return `<circle cx="128" cy="128" r="10" fill="#fde047"/><line x1="128" y1="110" x2="128" y2="146" stroke="#ffffff" stroke-width="2"/><line x1="110" y1="128" x2="146" y2="128" stroke="#ffffff" stroke-width="2"/>`;
    case 'red-laser':
      return `<circle cx="128" cy="128" r="8" fill="#ef4444"/><circle cx="128" cy="128" r="3" fill="#ffffff"/><circle cx="128" cy="128" r="16" fill="none" stroke="#ef4444" stroke-width="2" stroke-dasharray="3 3"/>`;
    case 'crosshair':
      return `<circle cx="128" cy="128" r="12" fill="none" stroke="#ffffff" stroke-width="2"/><line x1="128" y1="112" x2="128" y2="144" stroke="#ffffff" stroke-width="1.5"/><line x1="112" y1="128" x2="144" y2="128" stroke="#ffffff" stroke-width="1.5"/><circle cx="128" cy="128" r="3.5" fill="${c1}"/>`;
    case 'supernova':
      return `<circle cx="128" cy="128" r="14" fill="#ffffff"/><circle cx="128" cy="128" r="22" fill="${c2}" opacity="0.45" filter="url(#core-blur)"/><line x1="128" y1="102" x2="128" y2="154" stroke="#ffffff" stroke-width="2"/><line x1="102" y1="128" x2="154" y2="128" stroke="#ffffff" stroke-width="2"/>`;
    case 'black-hole':
      return `<circle cx="128" cy="128" r="14" fill="#000000" stroke="${c1}" stroke-width="3"/><circle cx="128" cy="128" r="6" fill="#000000"/>`;
    case 'star-triad':
      return `<circle cx="128" cy="118" r="3" fill="${c1}"/><circle cx="137" cy="133" r="3" fill="${c2}"/><circle cx="119" cy="133" r="3" fill="${c3}"/><circle cx="128" cy="128" r="2" fill="#ffffff"/>`;
    case 'quantum':
      return `<ellipse cx="128" cy="128" rx="14" ry="6" fill="none" stroke="${c1}" stroke-width="1.5" transform="rotate(30 128 128)"/><ellipse cx="128" cy="128" rx="14" ry="6" fill="none" stroke="${c2}" stroke-width="1.5" transform="rotate(-30 128 128)"/><circle cx="128" cy="128" r="4" fill="#ffffff"/>`;
    case 'pulsar':
      return `<circle cx="128" cy="128" r="7" fill="#ffffff"/><circle cx="128" cy="128" r="16" fill="none" stroke="${c1}" stroke-width="2" opacity="0.8"/>`;
    case 'opal-core':
      return `<circle cx="128" cy="128" r="11" fill="url(#core-opal)"/><circle cx="128" cy="128" r="4" fill="#ffffff"/>`;
    case 'cyan-dot':
      return `<circle cx="128" cy="128" r="11" fill="#00f2fe"/><circle cx="128" cy="128" r="4" fill="#ffffff"/>`;
    case 'solid-dot':
    default:
      return `<circle cx="128" cy="128" r="11" fill="${c1 === '#0f172a' ? '#0f172a' : '#ffffff'}"/>`;
  }
}

for (const p of palettes) {
  const c1 = p.colors[0];
  const c2 = p.colors[1];
  const c3 = p.colors[2];
  const strokeW = p.strokeWidth || 22;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="${p.id}-g1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient>
    <linearGradient id="${p.id}-g2" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${c2}"/>
      <stop offset="100%" stop-color="${c3}"/>
    </linearGradient>
    <linearGradient id="${p.id}-g3" x1="0%" y1="100%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${c3}"/>
      <stop offset="100%" stop-color="${c1}"/>
    </linearGradient>
    <radialGradient id="${p.id}-bg-radial" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="${c1}" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="${p.bg}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="core-opal" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${c1}"/><stop offset="50%" stop-color="${c2}"/><stop offset="100%" stop-color="${c3}"/>
    </linearGradient>
    <filter id="core-blur" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="6"/>
    </filter>
  </defs>

  <rect width="256" height="256" rx="60" fill="${p.bg}"/>
  <rect width="256" height="256" rx="60" fill="url(#${p.id}-bg-radial)"/>

  <g fill="none" stroke-width="${strokeW}" stroke-linecap="round">
    <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#${p.id}-g1)"/>
    <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#${p.id}-g2)"/>
    <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#${p.id}-g3)"/>
  </g>

  <g id="center-core">
    ${getCoreSvg(p.core, c1, c2, c3)}
  </g>
</svg>`;

  writeFileSync(join(outDir, `${p.id}.svg`), svg, 'utf8');
}

console.log(`Generated ${palettes.length} Aperture Universe SVGs!`);

const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mixdog Aperture Triad Universe — 48 Variations</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #06070a;
      --bg-surface: #0c0e14;
      --bg-card: #11141d;
      --bg-card-hover: #181d2a;
      --border: rgba(255, 255, 255, 0.08);
      --border-accent: rgba(56, 189, 248, 0.4);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --cyan: #38bdf8;
      --radius-sm: 8px;
      --radius-md: 14px;
      --radius-lg: 20px;
      --radius-xl: 28px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.5;
    }

    .bg-grid {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background-image:
        radial-gradient(circle at 50% 0%, rgba(56, 189, 248, 0.15) 0%, transparent 60%),
        radial-gradient(circle at 85% 20%, rgba(236, 72, 153, 0.08) 0%, transparent 50%),
        radial-gradient(circle at 15% 40%, rgba(16, 185, 129, 0.08) 0%, transparent 50%);
      pointer-events: none;
      z-index: 0;
    }

    .container {
      position: relative;
      z-index: 1;
      max-width: 1560px;
      margin: 0 auto;
      padding: 48px 24px 120px;
    }

    header {
      text-align: center;
      max-width: 920px;
      margin: 0 auto 48px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 18px;
      border-radius: 999px;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.3);
      color: var(--cyan);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 20px;
      box-shadow: 0 0 20px rgba(56, 189, 248, 0.2);
    }

    header h1 {
      font-size: 44px;
      font-weight: 800;
      letter-spacing: -0.03em;
      line-height: 1.15;
      margin-bottom: 16px;
      background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 50%, #94a3b8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    header p {
      font-size: 16px;
      color: var(--text-muted);
    }

    .inspector-box {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      padding: 32px;
      margin-bottom: 48px;
      display: flex;
      flex-direction: column;
      gap: 24px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.5);
    }

    .inspector-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
    }

    .scale-strip {
      display: flex;
      align-items: center;
      gap: 32px;
      padding: 24px;
      background: #06080c;
      border-radius: var(--radius-lg);
      border: 1px solid rgba(255, 255, 255, 0.05);
      overflow-x: auto;
    }

    .scale-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }

    .scale-item span {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--text-dim);
    }

    .filter-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 32px;
      flex-wrap: wrap;
    }

    .search-input {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 16px;
      color: #fff;
      font-size: 13px;
      min-width: 280px;
      outline: none;
    }

    .search-input:focus {
      border-color: var(--cyan);
    }

    .filter-chips {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .chip {
      font-size: 12px;
      padding: 7px 14px;
      border-radius: 8px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.2s;
    }

    .chip:hover, .chip.active {
      background: var(--cyan);
      color: #000;
      border-color: var(--cyan);
      font-weight: 700;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
      gap: 20px;
    }

    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      cursor: pointer;
      position: relative;
    }

    .card:hover {
      transform: translateY(-5px);
      border-color: var(--border-accent);
      background: var(--bg-card-hover);
      box-shadow: 0 16px 36px rgba(0,0,0,0.6), 0 0 24px rgba(56, 189, 248, 0.15);
    }

    .card img {
      width: 140px;
      height: 140px;
      margin-bottom: 16px;
      transition: transform 0.3s ease;
      filter: drop-shadow(0 10px 20px rgba(0,0,0,0.5));
    }

    .card:hover img {
      transform: scale(1.08);
    }

    .card-title {
      font-size: 14px;
      font-weight: 700;
      text-align: center;
      margin-bottom: 4px;
      color: #ffffff;
    }

    .card-cat {
      font-size: 11px;
      color: var(--cyan);
      font-family: 'JetBrains Mono', monospace;
      margin-bottom: 12px;
    }

    .color-dots {
      display: flex;
      gap: 6px;
      margin-top: auto;
    }

    .color-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }

    .card-btn {
      margin-top: 12px;
      width: 100%;
      padding: 6px 0;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .card-btn:hover {
      background: var(--cyan);
      color: #000;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <div class="bg-grid"></div>

  <div class="container">
    <header>
      <div class="badge">🌀 Aperture Triad Universe — 48 Massive Variations</div>
      <h1>Aperture Triad (131번) 확장 스펙트럼 랩</h1>
      <p>
        120° 3개 아크가 하나로 연결되는 <strong>360° Seamless Continuous Loop</strong>와<br>
        다채로운 중심부 코어 디자인(✦ Spark, Diamond, Terminal >_, Donut Ring, Hexagon IC, Laser 등)을 적용한 48종 에디션입니다.
      </p>
    </header>

    <div class="inspector-box">
      <div class="inspector-top">
        <div>
          <strong id="current-title" style="font-size: 18px;">${palettes[0].title}</strong>
          <span id="current-cat" style="margin-left: 10px; font-size: 12px; color: var(--cyan); font-family: 'JetBrains Mono';">${palettes[0].cat}</span>
        </div>
        <button class="chip active" onclick="copyCurrentSvg()">📋 현재 선택된 SVG 코드 복사</button>
      </div>

      <div class="scale-strip">
        <div class="scale-item">
          <img id="scale-128" src="./${palettes[0].id}.svg" style="width: 128px; height: 128px;" />
          <span>128px (Tile)</span>
        </div>
        <div class="scale-item">
          <img id="scale-64" src="./${palettes[0].id}.svg" style="width: 64px; height: 64px;" />
          <span>64px (Dock)</span>
        </div>
        <div class="scale-item">
          <img id="scale-48" src="./${palettes[0].id}.svg" style="width: 48px; height: 48px;" />
          <span>48px (Taskbar)</span>
        </div>
        <div class="scale-item">
          <img id="scale-32" src="./${palettes[0].id}.svg" style="width: 32px; height: 32px;" />
          <span>32px (Toolbar)</span>
        </div>
        <div class="scale-item">
          <img id="scale-24" src="./${palettes[0].id}.svg" style="width: 24px; height: 24px;" />
          <span>24px (Tab)</span>
        </div>
        <div class="scale-item">
          <img id="scale-16" src="./${palettes[0].id}.svg" style="width: 16px; height: 16px;" />
          <span>16px (CLI)</span>
        </div>
      </div>
    </div>

    <div class="filter-bar">
      <input type="text" class="search-input" id="search-input" placeholder="🔍 색상, 스타일, 코어 검색..." oninput="filterGrid()" />
      <div class="filter-chips">
        <button class="chip active" onclick="setFilter('all', this)">전체 (48)</button>
        <button class="chip" onclick="setFilter('Cyber Neon', this)">Cyber Neon (6)</button>
        <button class="chip" onclick="setFilter('360° Spectrum', this)">360° Spectrum (6)</button>
        <button class="chip" onclick="setFilter('AI Agent Theme', this)">AI Agent Theme (6)</button>
        <button class="chip" onclick="setFilter('Luxury Metal', this)">Luxury Metal (6)</button>
        <button class="chip" onclick="setFilter('Monochrome', this)">Monochrome (6)</button>
        <button class="chip" onclick="setFilter('Architecture', this)">Architecture (6)</button>
        <button class="chip" onclick="setFilter('Cosmic', this)">Cosmic (6)</button>
        <button class="chip" onclick="setFilter('Pastel & Fresh', this)">Pastel & Fresh (6)</button>
      </div>
    </div>

    <div class="grid" id="card-grid">
      ${palettes.map(p => `
        <div class="card" data-cat="${p.cat}" data-title="${p.title.toLowerCase()}" onclick="selectItem('${p.id}', '${p.title}', '${p.cat}')">
          <img src="./${p.id}.svg" alt="${p.title}" />
          <div class="card-title">${p.title}</div>
          <div class="card-cat">// ${p.cat}</div>
          <div class="color-dots">
            ${p.colors.map(c => `<div class="color-dot" style="background: ${c};"></div>`).join('')}
          </div>
          <button class="card-btn" onclick="event.stopPropagation(); quickCopy('${p.id}.svg')">📋 SVG 복사</button>
        </div>
      `).join('')}
    </div>
  </div>

  <script>
    let activeId = '${palettes[0].id}';
    let currentFilter = 'all';

    function selectItem(id, title, cat) {
      activeId = id;
      document.getElementById('current-title').innerText = title;
      document.getElementById('current-cat').innerText = cat;
      ['scale-128', 'scale-64', 'scale-48', 'scale-32', 'scale-24', 'scale-16'].forEach(elId => {
        document.getElementById(elId).src = './' + id + '.svg';
      });
    }

    async function copyCurrentSvg() {
      await quickCopy(activeId + '.svg');
    }

    async function quickCopy(file) {
      try {
        const res = await fetch('./' + file);
        const text = await res.text();
        await navigator.clipboard.writeText(text);
        alert('SVG 코드가 클립보드에 복사되었습니다! (' + file + ')');
      } catch (err) {
        alert('복사 실패: ' + err.message);
      }
    }

    function setFilter(cat, btn) {
      currentFilter = cat;
      document.querySelectorAll('.filter-chips .chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      filterGrid();
    }

    function filterGrid() {
      const q = document.getElementById('search-input').value.toLowerCase().trim();
      const cards = document.querySelectorAll('.card');

      cards.forEach(card => {
        const cat = card.getAttribute('data-cat');
        const title = card.getAttribute('data-title');

        const matchCat = (currentFilter === 'all') || (cat === currentFilter);
        const matchSearch = !q || title.includes(q) || cat.toLowerCase().includes(q);

        if (matchCat && matchSearch) {
          card.style.display = 'flex';
        } else {
          card.style.display = 'none';
        }
      });
    }
  </script>
</body>
</html>`;

writeFileSync(join(outDir, 'aperture-universe.html'), html, 'utf8');
console.log('✅ Generated aperture-universe.html successfully!');
