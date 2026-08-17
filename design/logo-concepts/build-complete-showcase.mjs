import { writeFileSync } from 'node:fs';
import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';

chdir(fileURLToPath(new URL('../..', import.meta.url)));

// 8 Fresh Ultra-Distinct Concepts + Top Metal Concepts
const concepts = [
  {
    id: 'metal-titanium',
    title: 'Machined Titanium M',
    tag: 'Hardware & Linear Style',
    desc: '정밀 45° CNC 챔퍼 가공된 스페이스 그레이 티타늄 M 바디. 백열광 엣지 반사와 상단 앰버 레이저 LED.',
    svgFile: 'metal-1-machined-titanium.svg',
    glyphSvg: `<path d="M 64 180 V 104 L 94 74 L 124 104 L 128 100 L 132 104 L 162 74 L 192 104 V 180" fill="none" stroke="currentColor" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/><path d="M 98 142 L 128 172 L 158 142" fill="none" stroke="currentColor" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>`
  },
  {
    id: 'cursor-prism',
    title: 'Isometric 3D Prism',
    tag: 'Cursor / Zed Benchmark',
    desc: 'Cursor 감성의 3D 아이소메트릭 큐브. 상단 삼각 프리즘 귀와 전면 코드 실행 화살표 각면의 조화.',
    svgFile: 'agent-ref-2-cursor-cube.svg',
    glyphSvg: `<polygon points="64,174 64,104 89,74 89,144" fill="currentColor" stroke="none"/><polygon points="192,174 192,104 167,74 167,144" fill="currentColor" stroke="none"/><polygon points="95,146 128,132 161,146 128,182" fill="currentColor" stroke="none"/>`
  },
  {
    id: 'fresh-origami',
    title: 'Origami Stealth Metal',
    tag: 'Teenage Engineering / Arc',
    desc: '접힌 메탈 평면의 명암 대비로 완성한 스텔스 하운드. 5개의 미니멀 기하학 평면으로 M 모노그램 완성.',
    svgFile: 'fresh-1-origami-fold.svg',
    glyphSvg: `<polygon points="60,178 60,105 88,70 88,145" fill="currentColor" opacity="0.4"/><polygon points="88,70 128,110 88,120" fill="currentColor"/><polygon points="196,178 196,105 168,70 168,145" fill="currentColor" opacity="0.4"/><polygon points="168,70 128,110 168,120" fill="currentColor"/><polygon points="98,155 128,145 158,155 128,183" fill="currentColor"/>`
  },
  {
    id: 'fresh-crt',
    title: 'CRT Phosphor Matrix',
    tag: 'Ghostty / Terminal CLI',
    desc: '초고해상도 도트 매트릭스와 그린 인광체 CRT 스캔라인 감성의 해커/터미널 코딩 에이전트 마크.',
    svgFile: 'fresh-2-crt-phosphor.svg',
    glyphSvg: `<g fill="currentColor"><rect x="70" y="70" width="14" height="14" rx="3"/><rect x="172" y="70" width="14" height="14" rx="3"/><rect x="70" y="88" width="14" height="14" rx="3"/><rect x="106" y="88" width="14" height="14" rx="3"/><rect x="136" y="88" width="14" height="14" rx="3"/><rect x="172" y="88" width="14" height="14" rx="3"/><rect x="70" y="106" width="14" height="14" rx="3"/><rect x="121" y="106" width="14" height="14" rx="3"/><rect x="172" y="106" width="14" height="14" rx="3"/><rect x="70" y="124" width="14" height="14" rx="3"/><rect x="106" y="124" width="14" height="14" rx="3"/><rect x="136" y="124" width="14" height="14" rx="3"/><rect x="172" y="124" width="14" height="14" rx="3"/><rect x="70" y="142" width="14" height="14" rx="3"/><rect x="121" y="142" width="14" height="14" rx="3"/><rect x="172" y="142" width="14" height="14" rx="3"/><rect x="70" y="160" width="14" height="14" rx="3"/><rect x="172" y="160" width="14" height="14" rx="3"/><rect x="70" y="178" width="14" height="14" rx="3"/><rect x="172" y="178" width="14" height="14" rx="3"/></g>`
  },
  {
    id: 'fresh-quantum',
    title: 'Quantum Orbital Core',
    tag: 'OpenAI Operator / Ring',
    desc: '3개의 맞물린 티타늄 궤도 링이 M-이어를 형성하고 중앙에 지능형 에이전트 퀀텀 코어가 박동하는 형태.',
    svgFile: 'fresh-3-quantum-orbit.svg',
    glyphSvg: `<ellipse cx="98" cy="120" rx="30" ry="55" transform="rotate(-25 98 120)" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round"/><ellipse cx="158" cy="120" rx="30" ry="55" transform="rotate(25 158 120)" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round"/><ellipse cx="128" cy="145" rx="36" ry="24" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round"/><circle cx="128" cy="128" r="7" fill="currentColor"/>`
  },
  {
    id: 'fresh-cyber',
    title: 'Cyber Laser Aperture',
    tag: 'Raycast / Visor HUD',
    desc: '암흑 유리 위를 가로지르는 수평 레이저 슬릿(&lt; // &gt;) 배열로 완성된 사이버네틱 HUD 바이저 마크.',
    svgFile: 'fresh-4-cyber-aperture.svg',
    glyphSvg: `<g stroke="currentColor" stroke-width="10" stroke-linecap="round"><line x1="70" y1="80" x2="100" y2="80"/><line x1="156" y1="80" x2="186" y2="80"/><line x1="60" y1="105" x2="115" y2="105"/><line x1="141" y1="105" x2="196" y2="105"/><line x1="70" y1="130" x2="186" y2="130" stroke-width="12"/><line x1="85" y1="155" x2="115" y2="155"/><line x1="141" y1="155" x2="171" y2="155"/><line x1="113" y1="180" x2="143" y2="180" stroke-width="12"/></g>`
  },
  {
    id: 'fresh-silicon',
    title: 'Silicon Die Circuit',
    tag: 'Groq / Apple Silicon',
    desc: '골드/플래티넘 회로 버스 트레이스와 IC 로직 노드가 결합된 M-하운드 실리콘 반도체 아키텍처.',
    svgFile: 'fresh-5-silicon-chip.svg',
    glyphSvg: `<g stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="13"><path d="M 60 178 V 105 L 88 77 L 112 101 L 128 85"/><circle cx="60" cy="178" r="5" fill="currentColor" stroke="none"/><circle cx="88" cy="77" r="5" fill="currentColor" stroke="none"/><path d="M 196 178 V 105 L 168 77 L 144 101 L 128 85"/><circle cx="196" cy="178" r="5" fill="currentColor" stroke="none"/><circle cx="168" cy="77" r="5" fill="currentColor" stroke="none"/><rect x="118" y="75" width="20" height="20" rx="4" fill="none" stroke-width="3"/><path d="M 98 142 L 128 172 L 158 142"/><circle cx="128" cy="172" r="5" fill="currentColor" stroke="none"/></g>`
  },
  {
    id: 'fresh-bauhaus',
    title: 'Swiss Bauhaus Grid',
    tag: 'Braun / Vercel Brutalist',
    desc: '원, 삼각형, 직사각형 등 순수 기하학 프리미티브로 설계된 시대를 초월하는 스위스 모더니즘 심볼.',
    svgFile: 'fresh-6-swiss-bauhaus.svg',
    glyphSvg: `<g fill="currentColor"><rect x="60" y="98" width="28" height="80" rx="6"/><polygon points="60,98 88,70 88,98"/><rect x="168" y="98" width="28" height="80" rx="6"/><polygon points="196,98 168,70 168,98"/><polygon points="102,106 154,106 128,148"/><circle cx="128" cy="168" r="11"/></g>`
  },
  {
    id: 'fresh-glass',
    title: 'Liquid Glass Aurora',
    tag: 'Apple Intelligence / Glow',
    desc: '깊은 프로스티드 글래스모피즘 속에 일렉트릭 시안/로즈/인디고 오로라 광원이 부드럽게 산란되는 디자인.',
    svgFile: 'fresh-7-liquid-glass.svg',
    glyphSvg: `<path d="M 68 174 V 98 C 68 75 87 63 103 76 L 128 97 L 153 76 C 169 63 188 75 188 98 V 174" fill="none" stroke="currentColor" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/><path d="M 97 137 L 128 166 L 159 137" fill="none" stroke="currentColor" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>`
  },
  {
    id: 'fresh-tokens',
    title: 'CLI Token Slash ($ // >)',
    tag: 'Claude Code / Hermes',
    desc: '명령줄 토큰 문법인 더블 슬래시(//)와 터미널 실행 셰브론(>>)이 만나 탄생한 극도로 날렵한 하운드 마크.',
    svgFile: 'fresh-8-token-syntax.svg',
    glyphSvg: `<g stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="80" y1="165" x2="110" y2="75" stroke-width="16"/><line x1="146" y1="75" x2="176" y2="165" stroke-width="16"/><path d="M 94 140 L 128 172 L 162 140" fill="none" stroke-width="15"/><circle cx="128" cy="105" r="5" fill="currentColor" stroke="none"/></g>`
  }
];

const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mixdog - High-Tech Coding Agent Logo Suite & VS Code Watermark</title>
  <style>
    :root {
      --bg: #06070a;
      --card-bg: #0e1017;
      --card-inner: #07080c;
      --border: rgba(255, 255, 255, 0.08);
      --border-hover: rgba(56, 189, 248, 0.45);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --accent-orange: #f97316;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 56px 24px 100px;
    }

    header {
      text-align: center;
      max-width: 860px;
      margin-bottom: 48px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 14px;
      border-radius: 999px;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.25);
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 16px;
    }

    header h1 {
      font-size: 44px;
      font-weight: 800;
      letter-spacing: -0.04em;
      line-height: 1.15;
      background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 45%, #94a3b8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 14px;
    }

    header p {
      color: var(--text-muted);
      font-size: 16px;
      line-height: 1.6;
    }

    .container {
      width: 100%;
      max-width: 1280px;
      display: flex;
      flex-direction: column;
      gap: 64px;
    }

    /* Section Headings */
    .section-header {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 24px;
    }

    .section-title {
      font-size: 22px;
      font-weight: 800;
      letter-spacing: -0.03em;
      color: #ffffff;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .section-desc {
      font-size: 14px;
      color: var(--text-muted);
    }

    /* Concept Cards Grid */
    .concepts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 24px;
    }

    .concept-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 22px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 18px;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
    }

    .concept-card:hover {
      transform: translateY(-5px);
      border-color: var(--border-hover);
      box-shadow: 0 24px 48px rgba(0, 0, 0, 0.75), 0 0 25px rgba(56, 189, 248, 0.12);
    }

    .concept-tag {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
    }

    .preview-container {
      background: var(--card-inner);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 16px;
      height: 210px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
    }

    .preview-container img {
      width: 148px;
      height: 148px;
      object-fit: contain;
      filter: drop-shadow(0 14px 28px rgba(0, 0, 0, 0.6));
    }

    .info h3 {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.01em;
      margin-bottom: 6px;
      color: #ffffff;
    }

    .info p {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
    }

    /* VS CODE WATERMARK SIMULATOR */
    .vscode-sim-container {
      background: #141416;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 20px;
      overflow: hidden;
      box-shadow: 0 32px 64px rgba(0, 0, 0, 0.85);
    }

    .vscode-titlebar {
      background: #0f1013;
      padding: 12px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }

    .vscode-dots {
      display: flex;
      gap: 8px;
    }

    .vscode-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
    }
    .dot-red { background: #ff5f56; }
    .dot-yellow { background: #ffbd2e; }
    .dot-green { background: #27c93f; }

    .vscode-title-text {
      font-size: 12px;
      color: #94a3b8;
      font-family: monospace;
    }

    .vscode-body {
      height: 380px;
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #141416;
    }

    .vscode-watermark {
      position: absolute;
      width: 190px;
      height: 190px;
      color: rgba(255, 255, 255, 0.06);
      pointer-events: none;
      transition: all 0.3s ease;
    }

    .vscode-shortcuts {
      position: relative;
      z-index: 2;
      display: flex;
      flex-direction: column;
      gap: 12px;
      color: #94a3b8;
      font-size: 13px;
    }

    .shortcut-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 320px;
    }

    .shortcut-keys {
      display: flex;
      gap: 4px;
      align-items: center;
    }

    .shortcut-keys kbd {
      background: #1e1f26;
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #e2e8f0;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-family: inherit;
    }

    .watermark-selector {
      display: flex;
      gap: 8px;
      padding: 16px 20px;
      background: #0b0c0f;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      overflow-x: auto;
    }

    .wm-btn {
      background: #181922;
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #94a3b8;
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.2s ease;
    }

    .wm-btn:hover, .wm-btn.active {
      background: rgba(56, 189, 248, 0.15);
      border-color: var(--accent);
      color: #ffffff;
    }

    /* Scale Strip */
    .scale-strip {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 28px 36px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 24px;
    }

    .scale-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }

    .scale-item span {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <header>
    <div class="badge">Comprehensive Coding Agent Logo Suite</div>
    <h1>Mixdog Creative Directions</h1>
    <p>오리가미 스텔스, CRT 인광체, 퀀텀 링, 실리콘 IC 등 완전히 다른 8가지 스타일과 <strong>VS Code 스타일 에디터 배경 워터마크 실시간 시뮬레이션</strong></p>
  </header>

  <div class="container">
    <!-- 1. VS CODE BACKGROUND WATERMARK SIMULATOR -->
    <div>
      <div class="section-header">
        <div class="section-title">VS Code Empty Editor Watermark Simulation <span>(에디터 배경 워터마크 검증)</span></div>
        <div class="section-desc">VS Code / Cursor처럼 작업창 배경에 은은하게 투영되는 단색 워터마크 글리프 가독성 테스트</div>
      </div>

      <div class="vscode-sim-container">
        <div class="vscode-titlebar">
          <div class="vscode-dots">
            <div class="vscode-dot dot-red"></div>
            <div class="vscode-dot dot-yellow"></div>
            <div class="vscode-dot dot-green"></div>
          </div>
          <div class="vscode-title-text">Mixdog Studio — Empty Workspace</div>
          <div style="width: 50px;"></div>
        </div>

        <div class="vscode-body">
          <!-- Central Watermark SVG -->
          <svg id="watermark-svg" class="vscode-watermark" viewBox="0 0 256 256">
            ${concepts[0].glyphSvg}
          </svg>

          <!-- Standard Shortcuts Overlay -->
          <div class="vscode-shortcuts">
            <div class="shortcut-row">
              <span>Show All Commands</span>
              <div class="shortcut-keys"><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd></div>
            </div>
            <div class="shortcut-row">
              <span>New Agent Session</span>
              <div class="shortcut-keys"><kbd>Ctrl</kbd> + <kbd>N</kbd></div>
            </div>
            <div class="shortcut-row">
              <span>Open Project Folder</span>
              <div class="shortcut-keys"><kbd>Ctrl</kbd> + <kbd>O</kbd></div>
            </div>
            <div class="shortcut-row">
              <span>Toggle Sidebar Dock</span>
              <div class="shortcut-keys"><kbd>Ctrl</kbd> + <kbd>B</kbd></div>
            </div>
          </div>
        </div>

        <!-- Interactive Watermark Switcher Buttons -->
        <div class="watermark-selector">
          ${concepts.map((c, i) => `
            <button class="wm-btn ${i === 0 ? 'active' : ''}" onclick="switchWatermark('${c.id}')">${c.title}</button>
          `).join('')}
        </div>
      </div>
    </div>

    <!-- 2. FULL APP ICON GRID (8 DISTINCT STYLES) -->
    <div>
      <div class="section-header">
        <div class="section-title">8 Fresh Style Concepts (다채로운 8대 디자인 시안)</div>
        <div class="section-desc">완전히 다른 소재와 기하학 구조로 제작된 코딩 에이전트 앱 아이콘</div>
      </div>

      <div class="concepts-grid">
        ${concepts.map(c => `
          <div class="concept-card">
            <span class="concept-tag">${c.tag}</span>
            <div class="preview-container">
              <img src="./${c.svgFile}" alt="${c.title}" />
            </div>
            <div class="info">
              <h3>${c.title}</h3>
              <p>${c.desc}</p>
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- 3. SCALE & FAVICON CHECK -->
    <div>
      <div class="section-header">
        <div class="section-title">Scale & Favicon Check</div>
        <div class="section-desc">16px 파비콘/타이틀바부터 128px 앱 타일까지 실제 크기 축소 선명도 테스트</div>
      </div>
      <div class="scale-strip">
        <div class="scale-item">
          <img src="./metal-1-machined-titanium.svg" width="128" height="128" />
          <span>128px (App Tile)</span>
        </div>
        <div class="scale-item">
          <img src="./metal-1-machined-titanium.svg" width="64" height="64" />
          <span>64px (Dock)</span>
        </div>
        <div class="scale-item">
          <img src="./metal-1-machined-titanium.svg" width="48" height="48" />
          <span>48px (Taskbar)</span>
        </div>
        <div class="scale-item">
          <img src="./metal-1-machined-titanium.svg" width="32" height="32" />
          <span>32px (Titlebar)</span>
        </div>
        <div class="scale-item">
          <img src="./metal-1-machined-titanium.svg" width="24" height="24" />
          <span>24px (Tab Icon)</span>
        </div>
        <div class="scale-item">
          <img src="./metal-1-machined-titanium.svg" width="16" height="16" />
          <span>16px (Favicon/CLI)</span>
        </div>
      </div>
    </div>
  </div>

  <script>
    const glyphs = {
      ${concepts.map(c => `'${c.id}': \`${c.glyphSvg}\``).join(',\n')}
    };

    function switchWatermark(id) {
      document.getElementById('watermark-svg').innerHTML = glyphs[id];
      document.querySelectorAll('.wm-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('onclick').includes(id));
      });
    }
  </script>
</body>
</html>`;

writeFileSync('design/logo-concepts/preview.html', html, 'utf8');
console.log('Complete showcase with VS Code watermark simulator generated!');
