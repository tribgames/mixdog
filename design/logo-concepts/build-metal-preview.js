import { writeFileSync } from 'node:fs';
import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';

chdir(fileURLToPath(new URL('../..', import.meta.url)));

const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mixdog - High-Tech Metallic Coding Agent Logos</title>
  <style>
    :root {
      --bg: #07080b;
      --card-bg: #0f1118;
      --card-inner: #07080c;
      --border: rgba(255, 255, 255, 0.08);
      --border-hover: rgba(248, 250, 252, 0.4);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent-metal: #cbd5e1;
      --accent-amber: #f97316;
      --accent-cyan: #38bdf8;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 56px 24px 80px;
    }

    header {
      text-align: center;
      max-width: 820px;
      margin-bottom: 56px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 14px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #e2e8f0;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 16px;
    }

    header h1 {
      font-size: 42px;
      font-weight: 800;
      letter-spacing: -0.04em;
      line-height: 1.15;
      background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 40%, #64748b 80%, #ffffff 100%);
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
      max-width: 1240px;
      display: flex;
      flex-direction: column;
      gap: 56px;
    }

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
      gap: 20px;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
    }

    .concept-card:hover {
      transform: translateY(-4px);
      border-color: var(--border-hover);
      box-shadow: 0 24px 48px rgba(0, 0, 0, 0.8), 0 0 20px rgba(255, 255, 255, 0.05);
    }

    .concept-tag {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #94a3b8;
    }

    .concept-tag.featured {
      color: #38bdf8;
    }

    .preview-container {
      background: var(--card-inner);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 16px;
      height: 220px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
    }

    .preview-container img {
      width: 156px;
      height: 156px;
      object-fit: contain;
      filter: drop-shadow(0 16px 28px rgba(0, 0, 0, 0.6));
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

    /* Horizontal Lockup Section */
    .lockup-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
    }

    .lockup-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px;
      display: flex;
      align-items: center;
      gap: 18px;
    }

    .lockup-icon {
      width: 44px;
      height: 44px;
      flex-shrink: 0;
    }

    .lockup-text {
      display: flex;
      flex-direction: column;
    }

    .lockup-text .brand-name {
      font-size: 22px;
      font-weight: 800;
      letter-spacing: -0.04em;
      color: #ffffff;
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .lockup-text .brand-name .accent-dot {
      color: #38bdf8;
    }

    .lockup-text .brand-sub {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    /* Monoline 1-Color Verification */
    .mono-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
    }

    .mono-box {
      background: #000000;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 14px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }

    .mono-box svg {
      width: 48px;
      height: 48px;
      stroke: #ffffff;
    }

    .mono-box span {
      font-size: 12px;
      font-weight: 600;
      color: #94a3b8;
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
    <div class="badge">Precision Hardware & Titanium Edition</div>
    <h1>Mixdog Metal-Tone Coding Agent Logos</h1>
    <p>Apple Titanium, Linear, Zed, Teenage Engineering 감성의 초정밀 하드웨어 CNC 메탈톤과 코딩 에이전트 문법을 결합한 하이엔드 테크 로고 컬렉션</p>
  </header>

  <div class="container">
    <!-- 4 High-Tech Metal Concepts -->
    <div>
      <div class="section-header">
        <div class="section-title">Metal-Tone Concepts (초정밀 메탈 에디션)</div>
        <div class="section-desc">브러시드 티타늄, 리퀴드 다크 크롬, 건메탈 모놀리스, 머큐리 리본 등 절제된 금속 질감과 스펙큘러 엣지 라이트</div>
      </div>
      <div class="concepts-grid">
        <!-- Metal 1: Machined Titanium -->
        <div class="concept-card">
          <span class="concept-tag featured">Metal 01 • Machined Titanium ⭐</span>
          <div class="preview-container">
            <img src="./metal-1-machined-titanium.svg" alt="Machined Titanium" />
          </div>
          <div class="info">
            <h3>Machined Titanium & Amber LED</h3>
            <p><strong>Apple Titanium & Linear 감성</strong>. 정밀 45° CNC 챔퍼 가공된 스페이스 그레이 M 프레임, 백열광 엣지 반사, 앰버 레이저 상태 표시등.</p>
          </div>
        </div>

        <!-- Metal 2: Liquid Chrome Prism -->
        <div class="concept-card">
          <span class="concept-tag">Metal 02 • Polished Obsidian</span>
          <div class="preview-container">
            <img src="./metal-2-liquid-chrome-prism.svg" alt="Liquid Chrome Prism" />
          </div>
          <div class="info">
            <h3>Liquid Chrome 3D Prism</h3>
            <p><strong>Cursor & Zed 3D 감성</strong>. 깊은 암흑 옵시디언 기판 위에 고반사 리퀴드 크롬 각면과 레이저 각인 스펙큘러 크리스가 빛나는 초고속 실행 벡터.</p>
          </div>
        </div>

        <!-- Metal 3: Gunmetal Monolith -->
        <div class="concept-card">
          <span class="concept-tag">Metal 03 • Industrial Hardware</span>
          <div class="preview-container">
            <img src="./metal-3-gunmetal-monolith.svg" alt="Gunmetal Monolith" />
          </div>
          <div class="info">
            <h3>Gunmetal Monolith & Flare</h3>
            <p><strong>Teenage Engineering & Raycast</strong>. 샌드블라스트 건메탈 솔리드 기둥과 중앙 네거티브 스페이스를 관통하는 오렌지 플라즈마 터미널 슬릿.</p>
          </div>
        </div>

        <!-- Metal 4: Mercury Streamline Ribbon -->
        <div class="concept-card">
          <span class="concept-tag">Metal 04 • Liquid Mercury</span>
          <div class="preview-container">
            <img src="./metal-4-mercury-ribbon.svg" alt="Mercury Ribbon" />
          </div>
          <div class="info">
            <h3>Platinum Mercury Ribbon</h3>
            <p><strong>Paseo & Orca 감성</strong>. 액체 백금/수은이 흐르듯 매끄러운 단일 폐곡선 M 리본에 일렉트릭 시안 레이저 프롬프트 주둥이가 얹어진 유선형 디자인.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Wordmark & Horizontal Lockup Preview -->
    <div>
      <div class="section-header">
        <div class="section-title">Metal Brand Lockups</div>
        <div class="section-desc">웹사이트 헤더, 공식 문서 README, 릴리즈 스플래시 화면용 타이포그래피 조합</div>
      </div>
      <div class="lockup-grid">
        <div class="lockup-card">
          <img class="lockup-icon" src="./metal-1-machined-titanium.svg" />
          <div class="lockup-text">
            <div class="brand-name">mixdog<span class="accent-dot">.</span></div>
            <div class="brand-sub">Titanium Runtime</div>
          </div>
        </div>
        <div class="lockup-card">
          <img class="lockup-icon" src="./metal-2-liquid-chrome-prism.svg" />
          <div class="lockup-text">
            <div class="brand-name">MIXDOG</div>
            <div class="brand-sub">Neural Code Agent</div>
          </div>
        </div>
        <div class="lockup-card">
          <img class="lockup-icon" src="./metal-3-gunmetal-monolith.svg" />
          <div class="lockup-text">
            <div class="brand-name">&lt;mixdog/&gt;</div>
            <div class="brand-sub">Autonomous Engine</div>
          </div>
        </div>
        <div class="lockup-card">
          <img class="lockup-icon" src="./metal-4-mercury-ribbon.svg" />
          <div class="lockup-text">
            <div class="brand-name">mixdog</div>
            <div class="brand-sub">High-Performance Studio</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 1-Color Pure Minimalist Glyphs (TUI / Titlebar / Monochrome) -->
    <div>
      <div class="section-header">
        <div class="section-title">Monochrome 1-Color Glyphs</div>
        <div class="section-desc">에디터 타이틀바, TUI, 워터마크, 깃허브 README용 단색 벡터 검증</div>
      </div>
      <div class="mono-grid">
        <div class="mono-box">
          <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="24" stroke-linecap="round" stroke-linejoin="round">
            <path d="M 64 180 V 104 L 94 74 L 124 104 L 128 100 L 132 104 L 162 74 L 192 104 V 180" />
            <path d="M 98 142 L 128 172 L 158 142" />
          </svg>
          <span>01. Machined Titanium</span>
        </div>

        <div class="mono-box">
          <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="24" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="64,174 64,104 89,74 89,144" fill="currentColor" stroke="none"/>
            <polygon points="192,174 192,104 167,74 167,144" fill="currentColor" stroke="none"/>
            <polygon points="95,146 128,132 161,146 128,182" fill="currentColor" stroke="none"/>
          </svg>
          <span>02. Liquid Chrome</span>
        </div>

        <div class="mono-box">
          <svg viewBox="0 0 256 256" fill="currentColor">
            <polygon points="60,180 60,107 88,74 116,107 92,132 92,180" />
            <polygon points="196,180 196,107 168,74 140,107 164,132 164,180" />
            <polygon points="104,144 128,120 152,144 128,172" />
          </svg>
          <span>03. Gunmetal Monolith</span>
        </div>

        <div class="mono-box">
          <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="24" stroke-linecap="round" stroke-linejoin="round">
            <path d="M 68 174 V 96 C 68 74 87 62 103 75 L 128 96 L 153 75 C 169 62 188 74 188 96 V 174 M 94 140 L 128 172 L 162 140" />
          </svg>
          <span>04. Mercury Ribbon</span>
        </div>
      </div>
    </div>

    <!-- Scale & Legibility Test Strip -->
    <div>
      <div class="section-header">
        <div class="section-title">Scale & Legibility Check</div>
        <div class="section-desc">16px 파비콘부터 128px 앱 아이콘까지 실제 크기 가독성 테스트</div>
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
</body>
</html>`;

writeFileSync('design/logo-concepts/preview.html', html, 'utf8');
console.log('preview.html updated with Metal-Tone concepts successfully!');
