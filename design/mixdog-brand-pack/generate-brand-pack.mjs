import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ==========================================
// CONCEPT 1: Cyber Hound & 'M' Monogram (Tech Apex)
// 날렵한 AI 하운드 + 대문자 'M' + 터미널 프롬프트의 융합
// ==========================================
const icon1_svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="c1-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#14151a"/>
      <stop offset="60%" stop-color="#0a0a0d"/>
      <stop offset="100%" stop-color="#040405"/>
    </linearGradient>
    <linearGradient id="c1-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ff9a3c" stop-opacity="0.6"/>
      <stop offset="50%" stop-color="#38bdf8" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.08"/>
    </linearGradient>
    <linearGradient id="c1-ear-left" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ff7a00"/>
      <stop offset="100%" stop-color="#ea580c"/>
    </linearGradient>
    <linearGradient id="c1-ear-right" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#0284c7"/>
    </linearGradient>
    <linearGradient id="c1-snout" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="60%" stop-color="#f1f5f9"/>
      <stop offset="100%" stop-color="#cbd5e1"/>
    </linearGradient>
    <linearGradient id="c1-collar" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#ff7a00"/>
      <stop offset="50%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#38bdf8"/>
    </linearGradient>
    <radialGradient id="c1-glow" cx="50%" cy="45%" r="55%">
      <stop offset="0%" stop-color="#ff7a00" stop-opacity="0.22"/>
      <stop offset="45%" stop-color="#38bdf8" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <filter id="c1-shadow" x="-15%" y="-15%" width="130%" height="130%">
      <feDropShadow dx="0" dy="24" stdDeviation="30" flood-color="#000000" flood-opacity="0.95"/>
    </filter>
  </defs>

  <!-- Squircle App Container -->
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#c1-bg)" filter="url(#c1-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#c1-rim)" stroke-width="2"/>
  <circle cx="256" cy="240" r="170" fill="url(#c1-glow)"/>

  <!-- Cyber Hound + 'M' Monogram Symbol -->
  <g id="cyber-hound-glyph" transform="translate(0, 8)">
    <!-- Left Ear / Left M-Pillar -->
    <path d="M 124 336 L 158 136 C 160 124 175 118 184 127 L 236 182 L 196 336 Z" fill="url(#c1-ear-left)"/>
    <!-- Left Inner Facet Accent -->
    <polygon points="158,136 236,182 196,240 148,220" fill="#ffffff" fill-opacity="0.15"/>

    <!-- Right Ear / Right M-Pillar -->
    <path d="M 388 336 L 354 136 C 352 124 337 118 328 127 L 276 182 L 316 336 Z" fill="url(#c1-ear-right)"/>
    <!-- Right Inner Facet Accent -->
    <polygon points="354,136 276,182 316,240 364,220" fill="#ffffff" fill-opacity="0.12"/>

    <!-- Center Bridge (M-Apex & Hound Forehead) -->
    <polygon points="236,182 256,156 276,182 256,224" fill="#ffffff"/>
    
    <!-- Hound Snout / Terminal Prompt Nose Wedge -->
    <polygon points="214,242 298,242 256,338" fill="url(#c1-snout)"/>
    <!-- Tech Nose / Terminal Core Dot -->
    <polygon points="242,308 270,308 256,326" fill="#0f172a"/>

    <!-- Cyber Eyes (Angle Brackets & Quantum Slits) -->
    <polygon points="186,214 220,230 200,236" fill="#38bdf8"/>
    <polygon points="326,214 292,230 312,236" fill="#ff9a3c"/>

    <!-- Collar / Foundation High-Speed Data Bus Line -->
    <rect x="160" y="360" width="192" height="10" rx="5" fill="url(#c1-collar)"/>
    <circle cx="256" cy="365" r="7" fill="#ffffff"/>
    <circle cx="256" cy="365" r="3" fill="#ff7a00"/>
  </g>
</svg>`;

// ==========================================
// CONCEPT 2: Neural Fusion Prism (Tri-Model Dog)
// 다중 모델 에이전트 라우팅 & 기하학적 프리즘 뫼비우스
// ==========================================
const icon2_svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="c2-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f1015"/>
      <stop offset="100%" stop-color="#030304"/>
    </linearGradient>
    <linearGradient id="c2-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ec4899" stop-opacity="0.5"/>
      <stop offset="50%" stop-color="#8b5cf6" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#06b6d4" stop-opacity="0.4"/>
    </linearGradient>
    <linearGradient id="c2-g1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f43f5e"/>
      <stop offset="100%" stop-color="#fb923c"/>
    </linearGradient>
    <linearGradient id="c2-g2" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#8b5cf6"/>
      <stop offset="100%" stop-color="#3b82f6"/>
    </linearGradient>
    <linearGradient id="c2-g3" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#06b6d4"/>
      <stop offset="100%" stop-color="#10b981"/>
    </linearGradient>
    <radialGradient id="c2-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#8b5cf6" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#c2-bg)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#c2-rim)" stroke-width="1.8"/>
  <circle cx="256" cy="256" r="160" fill="url(#c2-glow)"/>

  <!-- 3-Way Model Fusion Geometric Dog Head -->
  <g transform="translate(256,256)">
    <!-- Top Left Ear Facet -->
    <path d="M 0,-120 L -90,-100 L -50,0 Z" fill="url(#c2-g1)"/>
    <!-- Top Right Ear Facet -->
    <path d="M 0,-120 L 90,-100 L 50,0 Z" fill="url(#c2-g2)"/>
    <!-- Center Face Diamond -->
    <polygon points="0,-120 -50,0 0,60 50,0" fill="#ffffff" fill-opacity="0.95"/>
    <!-- Left Cheek Shard -->
    <polygon points="-50,0 -100,50 -40,90 0,60" fill="url(#c2-g3)"/>
    <!-- Right Cheek Shard -->
    <polygon points="50,0 100,50 40,90 0,60" fill="url(#c2-g2)"/>
    <!-- Snout / Terminal Execution Node -->
    <polygon points="0,60 -40,90 0,140 40,90" fill="url(#c2-g1)"/>
    <circle cx="0" cy="105" r="8" fill="#ffffff"/>

    <!-- Sharp Specular Highlight Ridges -->
    <line x1="0" y1="-120" x2="0" y2="140" stroke="#ffffff" stroke-width="2.5" opacity="0.9"/>
    <line x1="-50" y1="0" x2="50" y2="0" stroke="#ffffff" stroke-width="2" opacity="0.6"/>
  </g>
</svg>`;

// ==========================================
// CONCEPT 3: Minimalist Developer Crest (Code Brackets x Hound)
// { >_ } 코드 브래킷과 날렵한 실루엣의 극강 미니멀리즘
// ==========================================
const icon3_svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="c3-bg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#18181b"/>
      <stop offset="100%" stop-color="#09090b"/>
    </linearGradient>
    <linearGradient id="c3-amber" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fbbf24"/>
      <stop offset="50%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#d97706"/>
    </linearGradient>
    <linearGradient id="c3-white" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#a1a1aa"/>
    </linearGradient>
  </defs>

  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#c3-bg)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="#27272a" stroke-width="2"/>
  
  <g transform="translate(0, -6)">
    <!-- Left Bracket Ear -->
    <path d="M 170 140 C 130 180 130 220 160 256 C 130 292 130 332 170 372" fill="none" stroke="url(#c3-amber)" stroke-width="22" stroke-linecap="round"/>
    
    <!-- Right Bracket Ear -->
    <path d="M 342 140 C 382 180 382 220 352 256 C 382 292 382 332 342 372" fill="none" stroke="url(#c3-amber)" stroke-width="22" stroke-linecap="round"/>

    <!-- Central Cyber Dog Mask & Terminal Prompt '> _' -->
    <!-- Prompt Arrow Forehead '>' -->
    <path d="M 232 200 L 272 236 L 232 272" fill="none" stroke="url(#c3-white)" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>
    
    <!-- Cursor Snout '_' -->
    <line x1="220" y1="324" x2="292" y2="324" stroke="url(#c3-white)" stroke-width="20" stroke-linecap="round"/>

    <!-- Glowing Amber Nose Point -->
    <circle cx="256" cy="296" r="9" fill="#f59e0b"/>
  </g>
</svg>`;

// ==========================================
// FULL HORIZONTAL LOGO (Symbol + Wordmark)
// ==========================================
const full_logo_horizontal_svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 360" width="1200" height="360">
  <defs>
    <linearGradient id="fl-ear-l" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ff7a00"/>
      <stop offset="100%" stop-color="#ea580c"/>
    </linearGradient>
    <linearGradient id="fl-ear-r" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#0284c7"/>
    </linearGradient>
    <linearGradient id="fl-snout" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#cbd5e1"/>
    </linearGradient>
    <linearGradient id="fl-text-grad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="70%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#94a3b8"/>
    </linearGradient>
    <linearGradient id="fl-tagline-grad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#ff7a00"/>
      <stop offset="50%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#38bdf8"/>
    </linearGradient>
  </defs>

  <!-- Background Dark Canvas -->
  <rect width="1200" height="360" rx="28" fill="#090a0f"/>

  <!-- Left Logo Symbol (Scaled down inside 240x240 box at x=60, y=60) -->
  <g transform="translate(60, 48)">
    <rect x="0" y="0" width="264" height="264" rx="64" fill="#14151a" stroke="#ff9a3c" stroke-opacity="0.3" stroke-width="1.5"/>
    
    <!-- Cyber Hound Monogram (Scaled 0.58 from 512) -->
    <g transform="translate(-16, -16) scale(0.58)">
      <path d="M 124 336 L 158 136 C 160 124 175 118 184 127 L 236 182 L 196 336 Z" fill="url(#fl-ear-l)"/>
      <polygon points="158,136 236,182 196,240 148,220" fill="#ffffff" fill-opacity="0.15"/>

      <path d="M 388 336 L 354 136 C 352 124 337 118 328 127 L 276 182 L 316 336 Z" fill="url(#fl-ear-r)"/>
      <polygon points="354,136 276,182 316,240 364,220" fill="#ffffff" fill-opacity="0.12"/>

      <polygon points="236,182 256,156 276,182 256,224" fill="#ffffff"/>
      <polygon points="214,242 298,242 256,338" fill="url(#fl-snout)"/>
      <polygon points="242,308 270,308 256,326" fill="#0f172a"/>

      <polygon points="186,214 220,230 200,236" fill="#38bdf8"/>
      <polygon points="326,214 292,230 312,236" fill="#ff9a3c"/>

      <rect x="160" y="360" width="192" height="10" rx="5" fill="#ff7a00"/>
      <circle cx="256" cy="365" r="7" fill="#ffffff"/>
    </g>
  </g>

  <!-- Wordmark & Typographic Identity -->
  <g transform="translate(370, 0)">
    <!-- Brand Title: MIXDOG -->
    <text x="0" y="195" font-family="-apple-system, BlinkMacSystemFont, 'Inter', 'SF Pro Display', 'Segoe UI', Roboto, sans-serif" font-size="114" font-weight="900" letter-spacing="-2" fill="url(#fl-text-grad)">MIXDOG</text>
    
    <!-- Accent Dot / Cyber Pulse -->
    <circle cx="510" cy="128" r="10" fill="#ff7a00"/>

    <!-- Subtitle / Tagline -->
    <text x="4" y="248" font-family="-apple-system, BlinkMacSystemFont, 'JetBrains Mono', 'Fira Code', monospace" font-size="25" font-weight="600" letter-spacing="4.5" fill="url(#fl-tagline-grad)">MULTI-PROVIDER AI CODING AGENT</text>
  </g>
</svg>`;

// Write SVG Files
writeFileSync('design/mixdog-brand-pack/mixdog-icon-cyber-hound.svg', icon1_svg);
writeFileSync('design/mixdog-brand-pack/mixdog-icon-neural-prism.svg', icon2_svg);
writeFileSync('design/mixdog-brand-pack/mixdog-icon-minimal-crest.svg', icon3_svg);
writeFileSync('design/mixdog-brand-pack/mixdog-logo-horizontal.svg', full_logo_horizontal_svg);

// HTML Interactive Showcase Viewer
const htmlViewer = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mixdog Brand & Logo Assets Showcase</title>
  <style>
    :root {
      --bg: #090a0f;
      --card-bg: #12131a;
      --card-border: #1e212d;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --primary-orange: #ff7a00;
      --primary-cyan: #38bdf8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif;
      padding: 48px 24px;
      line-height: 1.6;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    header {
      margin-bottom: 48px;
      text-align: center;
    }
    header h1 {
      font-size: 2.75rem;
      font-weight: 900;
      letter-spacing: -1px;
      background: linear-gradient(135deg, #fff 40%, var(--primary-orange) 80%, var(--primary-cyan) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 8px;
    }
    header p {
      color: var(--text-muted);
      font-size: 1.15rem;
    }
    
    .section-title {
      font-size: 1.5rem;
      font-weight: 700;
      margin: 40px 0 20px;
      display: flex;
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 12px;
    }
    .badge {
      font-size: 0.75rem;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(255, 122, 0, 0.15);
      color: var(--primary-orange);
      border: 1px solid rgba(255, 122, 0, 0.3);
      text-transform: uppercase;
      font-weight: 700;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 28px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      padding: 28px;
      display: flex;
      flex-direction: column;
      align-items: center;
      transition: transform 0.2s, border-color 0.2s;
    }
    .card:hover {
      transform: translateY(-4px);
      border-color: rgba(255, 122, 0, 0.4);
    }
    .card-preview {
      width: 220px;
      height: 220px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 24px;
      filter: drop-shadow(0 20px 30px rgba(0,0,0,0.6));
    }
    .card-preview svg {
      width: 100%;
      height: 100%;
    }
    .card h3 {
      font-size: 1.25rem;
      margin-bottom: 8px;
    }
    .card p {
      color: var(--text-muted);
      font-size: 0.92rem;
      text-align: center;
      margin-bottom: 20px;
      flex-grow: 1;
    }
    .btn-group {
      display: flex;
      gap: 10px;
      width: 100%;
    }
    .btn {
      flex: 1;
      padding: 10px 16px;
      border-radius: 10px;
      font-size: 0.88rem;
      font-weight: 600;
      text-align: center;
      text-decoration: none;
      cursor: pointer;
      border: none;
      transition: 0.15s;
    }
    .btn-primary {
      background: var(--primary-orange);
      color: #000;
    }
    .btn-primary:hover {
      background: #ff8e24;
    }
    .btn-secondary {
      background: #1e212d;
      color: #fff;
      border: 1px solid #2d3345;
    }
    .btn-secondary:hover {
      background: #282c3c;
    }

    .full-logo-container {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      padding: 32px;
      margin-top: 24px;
      text-align: center;
    }
    .full-logo-container svg {
      max-width: 100%;
      height: auto;
      border-radius: 16px;
    }
    
    .size-test {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 32px;
      background: #14151e;
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 24px;
      margin-top: 20px;
    }
    .size-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }
    .size-item span {
      font-size: 0.75rem;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>MIXDOG BRAND ASSETS</h1>
      <p>Multi-Provider AI Coding Agent Identity & Icon Pack</p>
    </header>

    <div class="section-title">
      <span>1. 앱 아이콘 콘셉트 3종</span>
      <span class="badge">Master Concepts</span>
    </div>

    <div class="grid">
      <!-- Concept 1 -->
      <div class="card">
        <div class="card-preview">
          ${icon1_svg}
        </div>
        <h3>1. Cyber Hound & 'M'</h3>
        <p>날렵한 AI 하운드 + 대문자 'M' 모노그램 + 터미널 프롬프트의 유기적 결합. 앰버 & 사이언 듀얼 악센트.</p>
        <div class="btn-group">
          <a href="mixdog-icon-cyber-hound.svg" download="mixdog-icon-cyber-hound.svg" class="btn btn-primary">SVG 저장</a>
        </div>
      </div>

      <!-- Concept 2 -->
      <div class="card">
        <div class="card-preview">
          ${icon2_svg}
        </div>
        <h3>2. Neural Fusion Prism</h3>
        <p>복수의 LLM 모델이 유기적으로 융합되는 3방향 넥서스 & 크리스탈 글래스모피즘 도그 페이스.</p>
        <div class="btn-group">
          <a href="mixdog-icon-neural-prism.svg" download="mixdog-icon-neural-prism.svg" class="btn btn-primary">SVG 저장</a>
        </div>
      </div>

      <!-- Concept 3 -->
      <div class="card">
        <div class="card-preview">
          ${icon3_svg}
        </div>
        <h3>3. Developer Crest { >_ }</h3>
        <p>코드 브래킷과 터미널 프롬프트 기호로 직관화한 하이엔드 미니멀리즘 로고마크.</p>
        <div class="btn-group">
          <a href="mixdog-icon-minimal-crest.svg" download="mixdog-icon-minimal-crest.svg" class="btn btn-primary">SVG 저장</a>
        </div>
      </div>
    </div>

    <div class="section-title">
      <span>2. 공식 가로형 브랜드 로고 (Wordmark Combo)</span>
    </div>

    <div class="full-logo-container">
      ${full_logo_horizontal_svg}
      <div style="margin-top: 20px;">
        <a href="mixdog-logo-horizontal.svg" download="mixdog-logo-horizontal.svg" class="btn btn-primary" style="display:inline-block; max-width: 240px;">가로형 로고 SVG 저장</a>
      </div>
    </div>

    <div class="section-title">
      <span>3. 아이콘 스케일 가독성 테스트 (Icon Scaling)</span>
    </div>

    <div class="size-test">
      <div class="size-item">
        <div style="width: 128px; height: 128px;">${icon1_svg}</div>
        <span>128px (Dock / Launcher)</span>
      </div>
      <div class="size-item">
        <div style="width: 64px; height: 64px;">${icon1_svg}</div>
        <span>64px (Desktop Tile)</span>
      </div>
      <div class="size-item">
        <div style="width: 32px; height: 32px;">${icon1_svg}</div>
        <span>32px (Menu / Titlebar)</span>
      </div>
      <div class="size-item">
        <div style="width: 16px; height: 16px;">${icon1_svg}</div>
        <span>16px (Favicon / Tray)</span>
      </div>
    </div>
  </div>
</body>
</html>
`;

writeFileSync('design/mixdog-brand-pack/index.html', htmlViewer);
console.log('Mixdog brand pack generated successfully in design/mixdog-brand-pack!');
