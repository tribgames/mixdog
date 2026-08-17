import { writeFileSync } from 'node:fs';
import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';

chdir(fileURLToPath(new URL('../..', import.meta.url)));

const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mixdog Ultimate Logo Design System</title>
  <style>
    :root {
      --bg: #060709;
      --card-bg: #0e1017;
      --card-inner: #07080c;
      --border: rgba(255, 255, 255, 0.08);
      --border-hover: rgba(56, 189, 248, 0.45);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --accent-amber: #f59e0b;
      --accent-emerald: #10b981;
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
      padding: 56px 24px 120px;
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
      padding: 5px 16px;
      border-radius: 999px;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.3);
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

    /* VS Code Watermark Simulator Section */
    .simulator-panel {
      background: #090a0f;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 24px;
      padding: 28px 32px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      box-shadow: 0 30px 60px rgba(0, 0, 0, 0.85);
    }

    .simulator-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 16px;
    }

    .sim-title {
      font-size: 18px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .sim-title span {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
    }

    .sim-controls {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .sim-btn-group {
      display: flex;
      gap: 8px;
      background: rgba(255, 255, 255, 0.04);
      padding: 4px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      flex-wrap: wrap;
    }

    .sim-btn {
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      border: none;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.2s;
    }

    .sim-btn.active, .sim-btn:hover {
      background: rgba(56, 189, 248, 0.2);
      color: #ffffff;
    }

    /* Mock Editor Frame */
    .mock-editor {
      background: #101116;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      height: 380px;
      display: flex;
      flex-direction: column;
      position: relative;
      overflow: hidden;
    }

    .mock-titlebar {
      height: 36px;
      background: #090a0d;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      display: flex;
      align-items: center;
      padding: 0 16px;
      justify-content: space-between;
      font-size: 12px;
      color: #64748b;
    }

    .window-dots {
      display: flex;
      gap: 6px;
    }

    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    .dot.r { background: #ff5f56; }
    .dot.y { background: #ffbd2e; }
    .dot.g { background: #27c93f; }

    .mock-content {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      flex-direction: column;
      gap: 24px;
    }

    /* Watermark in Editor Background */
    .editor-watermark {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 240px;
      height: 240px;
      opacity: 0.07;
      pointer-events: none;
      transition: all 0.3s ease;
      color: #ffffff;
      fill: currentColor;
    }

    .editor-watermark svg {
      width: 100%;
      height: 100%;
    }

    .mock-shortcuts {
      position: relative;
      z-index: 2;
      display: flex;
      flex-direction: column;
      gap: 12px;
      font-size: 13px;
      color: #94a3b8;
    }

    .shortcut-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 36px;
      width: 260px;
    }

    kbd {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-family: ui-monospace, monospace;
      color: #f8fafc;
    }

    /* Section Styles */
    .section-header {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 24px;
    }

    .section-title {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.03em;
      color: #ffffff;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .section-tag {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 4px 10px;
      border-radius: 6px;
      background: rgba(56, 189, 248, 0.15);
      color: var(--accent);
    }

    .section-desc {
      font-size: 14px;
      color: var(--text-muted);
    }

    /* Concepts Grid */
    .concepts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      gap: 28px;
    }

    .concept-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 28px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
    }

    .concept-card:hover {
      transform: translateY(-6px);
      border-color: var(--border-hover);
      box-shadow: 0 28px 56px rgba(0, 0, 0, 0.8), 0 0 30px rgba(56, 189, 248, 0.15);
    }

    .card-top-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .concept-tag {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
    }

    .btn-apply-watermark {
      font-size: 11px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #cbd5e1;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-apply-watermark:hover {
      background: rgba(56, 189, 248, 0.2);
      color: #ffffff;
      border-color: var(--accent);
    }

    .preview-container {
      background: var(--card-inner);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 18px;
      height: 230px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
    }

    .preview-container img {
      width: 160px;
      height: 160px;
      object-fit: contain;
      filter: drop-shadow(0 16px 32px rgba(0, 0, 0, 0.7));
    }

    .info h3 {
      font-size: 19px;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 6px;
      color: #ffffff;
    }

    .info .meta {
      font-size: 12px;
      font-weight: 600;
      color: var(--accent);
      margin-bottom: 10px;
    }

    .info p {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.55;
    }

    /* Lockups Grid */
    .lockup-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
    }

    .lockup-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 24px;
      display: flex;
      align-items: center;
      gap: 20px;
    }

    .lockup-icon {
      width: 48px;
      height: 48px;
      flex-shrink: 0;
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
      color: var(--accent);
    }

    .lockup-text .brand-sub {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    /* Monochrome Section */
    .mono-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
    }

    .mono-box {
      background: #000000;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 24px 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .mono-box:hover {
      border-color: var(--accent);
      transform: translateY(-2px);
    }

    .mono-box svg {
      width: 48px;
      height: 48px;
    }

    .mono-box span {
      font-size: 11px;
      font-weight: 600;
      color: #94a3b8;
      text-align: center;
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
    <div class="badge">Next-Gen Coding Agent Design System</div>
    <h1>Mixdog Brand & Watermark Showcase</h1>
    <p>완전히 다른 급진적 디렉션(Hexa-Runtime, Negative Monolith, Möbius Loop, Neural Starburst)과 초정밀 메탈톤, 그리고 <strong>VS Code 에디터 배경 워터마크 실시간 시뮬레이션</strong></p>
  </header>

  <div class="container">
    <!-- 1. VS Code Empty Editor Watermark Simulator -->
    <div class="simulator-panel">
      <div class="simulator-top">
        <div class="sim-title">
          VS Code Editor Watermark Simulator
          <span>(빈 에디터 화면에 투영되는 단색 글리프 실시간 검증)</span>
        </div>
        <div class="sim-controls">
          <div class="sim-btn-group" id="watermark-switcher">
            <button class="sim-btn active" onclick="setWatermark('hex')">01. Hex-Runtime</button>
            <button class="sim-btn" onclick="setWatermark('monolith')">02. Negative Monolith</button>
            <button class="sim-btn" onclick="setWatermark('mobius')">03. Möbius Loop</button>
            <button class="sim-btn" onclick="setWatermark('starburst')">04. Starburst</button>
            <button class="sim-btn" onclick="setWatermark('titanium')">05. Titanium M</button>
            <button class="sim-btn" onclick="setWatermark('prism')">06. Cursor Prism</button>
          </div>
        </div>
      </div>

      <div class="mock-editor">
        <div class="mock-titlebar">
          <div class="window-dots">
            <div class="dot r"></div>
            <div class="dot y"></div>
            <div class="dot g"></div>
          </div>
          <div>Mixdog Studio — Workspace</div>
          <div>UTF-8</div>
        </div>
        <div class="mock-content">
          <!-- Background Watermark SVG container -->
          <div class="editor-watermark" id="watermark-target">
            <!-- Default: Hex-Runtime -->
            <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="128,40 200,82 200,166 128,208 56,166 56,82" stroke-width="16" />
              <polygon points="128,96 164,120 128,144 92,120" stroke-width="14" />
              <line x1="128" y1="144" x2="128" y2="190" stroke-width="18" />
            </svg>
          </div>

          <!-- Foreground Shortcut HUD -->
          <div class="mock-shortcuts">
            <div class="shortcut-row"><span>New task</span><span><kbd>Ctrl</kbd> + <kbd>N</kbd></span></div>
            <div class="shortcut-row"><span>Switch tab</span><span><kbd>Ctrl</kbd> + <kbd>→</kbd></span></div>
            <div class="shortcut-row"><span>Toggle Agent Panel</span><span><kbd>Ctrl</kbd> + <kbd>B</kbd></span></div>
            <div class="shortcut-row"><span>Settings</span><span><kbd>Ctrl</kbd> + <kbd>,</kbd></span></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Section 1: 6 Radical New Concepts -->
    <div>
      <div class="section-header">
        <div class="section-title">
          Radical New Concepts <span class="section-tag">신규 급진적 디렉션 6종</span>
        </div>
        <div class="section-desc">기존 틀을 깨는 헥사곤 런타임, 네거티브 모놀리스, 무한 뫼비우스, AI 스타버스트, 조리개 옵틱, CLI 타이포그래피</div>
      </div>

      <div class="concepts-grid">
        <!-- Radical 1: Hexa-Runtime -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Radical 01 • Docker / Rust Vibe</span>
            <button class="btn-apply-watermark" onclick="setWatermark('hex')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./radical-1-hex-runtime.svg" alt="Hexa Runtime" />
          </div>
          <div class="info">
            <h3>Hexa-Runtime & Container</h3>
            <div class="meta">WebAssembly / Docker / Isometric Architecture</div>
            <p><strong>완전한 3D 헥사곤 컨테이너 블록</strong>. 60°/120° 각면 귀와 중앙 코어를 관통하는 터미널 실행 벡터. 워터마크에서도 가장 완벽한 밸런스.</p>
          </div>
        </div>

        <!-- Radical 2: Negative Monolith -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Radical 02 • Brutalist Vercel / Supabase</span>
            <button class="btn-apply-watermark" onclick="setWatermark('monolith')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./radical-2-negative-monolith.svg" alt="Negative Monolith" />
          </div>
          <div class="info">
            <h3>Negative Space Monolith</h3>
            <div class="meta">Brutalist Geometry / Amber Prompt Spark</div>
            <p><strong>네거티브 스페이스 절단 미학</strong>. 단 하나의 날렵한 번개/셰브론 컷아웃이 M과 강아지 실루엣을 완성하는 극강의 하이엔드 테크 마크.</p>
          </div>
        </div>

        <!-- Radical 3: Infinite Möbius -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Radical 03 • Infinite Agent Loop</span>
            <button class="btn-apply-watermark" onclick="setWatermark('mobius')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./radical-3-infinite-mobius.svg" alt="Infinite Möbius" />
          </div>
          <div class="info">
            <h3>Infinite Möbius Stream</h3>
            <div class="meta">Autonomous Loop / Continuous Metal Ribbon</div>
            <p><strong>단절 없는 무한 실행 루프</strong>. 계획(Plan)과 실행(Act)이 순환하는 뫼비우스 리본에 프롬프트 셰브론(&gt;)이 결합된 연속적 조형.</p>
          </div>
        </div>

        <!-- Radical 4: Neural Starburst -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Radical 04 • Anthropic / Gemini Spark</span>
            <button class="btn-apply-watermark" onclick="setWatermark('starburst')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./radical-4-neural-starburst.svg" alt="Neural Starburst" />
          </div>
          <div class="info">
            <h3>Neural Starburst & Flare</h3>
            <div class="meta">AI Intelligence Particle / 8-Ray Canine</div>
            <p><strong>차세대 AI 스타버스트 입자</strong>. 상단 2개의 긴 광선이 귀를 형성하고 중심에 터미널 프롬프트 셰브론과 시안 레이저 코어가 폭발하는 디자인.</p>
          </div>
        </div>

        <!-- Radical 5: Aperture Iris -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Radical 05 • Optical Sensor Lens</span>
            <button class="btn-apply-watermark" onclick="setWatermark('aperture')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./radical-5-aperture-iris.svg" alt="Aperture Iris" />
          </div>
          <div class="info">
            <h3>Aperture Multi-Model Iris</h3>
            <div class="meta">Machined Shutter Blades / Optical Core</div>
            <p><strong>카메라 조리개 & 시각 인지 에이전트</strong>. 5개의 금속 셔터 블레이드가 회전하며 중앙 조리개 렌즈와 귀 실루엣을 완성.</p>
          </div>
        </div>

        <!-- Radical 6: CLI Glyph -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Radical 06 • Panic / Teenage Engineering</span>
            <button class="btn-apply-watermark" onclick="setWatermark('cli')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./radical-6-cli-glyph.svg" alt="CLI Glyph" />
          </div>
          <div class="info">
            <h3>Cyberpunk CLI Glyph</h3>
            <div class="meta">Monospace Grammar // >> _ / Safety Amber</div>
            <p><strong>하드코어 터미널 문법</strong>. 주석 슬래시(//)와 파이프 리다이렉트(&gt;&gt;)를 순수 모노스페이스 타이포그래피 M으로 구축한 개발자 마크.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Section 2: Machined Metal & Titanium Edition -->
    <div>
      <div class="section-header">
        <div class="section-title">
          Machined Metal & Titanium <span class="section-tag">초정밀 메탈 에디션 4종</span>
        </div>
        <div class="section-desc">Apple Titanium, 리퀴드 다크 크롬, 건메탈 모놀리스, 머큐리 리본 등 절제된 금속 질감과 스펙큘러 엣지 라이트</div>
      </div>

      <div class="concepts-grid">
        <!-- Metal 1 -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Metal 01 • Recommended ⭐</span>
            <button class="btn-apply-watermark" onclick="setWatermark('titanium')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./metal-1-machined-titanium.svg" alt="Machined Titanium" />
          </div>
          <div class="info">
            <h3>Machined Titanium & Amber LED</h3>
            <div class="meta">Apple Titanium / Linear Chamfer</div>
            <p>정밀 45° CNC 챔퍼 가공 스페이스 그레이 M 프레임, 백열광 엣지 반사, 앰버 레이저 상태 표시등.</p>
          </div>
        </div>

        <!-- Metal 2 -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Metal 02 • Polished Obsidian</span>
            <button class="btn-apply-watermark" onclick="setWatermark('prism')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./metal-2-liquid-chrome-prism.svg" alt="Liquid Chrome" />
          </div>
          <div class="info">
            <h3>Liquid Chrome 3D Prism</h3>
            <div class="meta">Cursor & Zed 3D Chrome</div>
            <p>깊은 암흑 옵시디언 기판 위에 고반사 리퀴드 크롬 각면과 레이저 각인 스펙큘러 크리스가 빛나는 실행 화살표.</p>
          </div>
        </div>

        <!-- Metal 3 -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Metal 03 • Industrial Hardware</span>
            <button class="btn-apply-watermark" onclick="setWatermark('monolith')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./metal-3-gunmetal-monolith.svg" alt="Gunmetal" />
          </div>
          <div class="info">
            <h3>Gunmetal Monolith & Flare</h3>
            <div class="meta">Teenage Engineering & Raycast</div>
            <p>샌드블라스트 건메탈 솔리드 기둥과 중앙 네거티브 스페이스를 관통하는 오렌지 플라즈마 터미널 슬릿.</p>
          </div>
        </div>

        <!-- Metal 4 -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Metal 04 • Platinum Flow</span>
            <button class="btn-apply-watermark" onclick="setWatermark('mobius')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./metal-4-mercury-ribbon.svg" alt="Mercury Ribbon" />
          </div>
          <div class="info">
            <h3>Mercury Streamline Ribbon</h3>
            <div class="meta">Paseo & Orca Liquid Metal</div>
            <p>액체 백금/수은이 흐르듯 매끄러운 단일 폐곡선 M 리본에 일렉트릭 시안 레이저 프롬프트 주둥이가 얹어진 유선형 디자인.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Section 3: Wordmark & Horizontal Lockups -->
    <div>
      <div class="section-header">
        <div class="section-title">Horizontal Brand Lockups</div>
        <div class="section-desc">공식 웹사이트 헤더, 깃허브 README 상단, 릴리즈 스플래시 화면용 타이포그래피 조합</div>
      </div>
      <div class="lockup-grid">
        <div class="lockup-card">
          <img class="lockup-icon" src="./radical-1-hex-runtime.svg" />
          <div class="lockup-text">
            <div class="brand-name">mixdog<span class="accent-dot">.</span></div>
            <div class="brand-sub">AI Coding Agent</div>
          </div>
        </div>
        <div class="lockup-card">
          <img class="lockup-icon" src="./radical-2-negative-monolith.svg" />
          <div class="lockup-text">
            <div class="brand-name">MIXDOG</div>
            <div class="brand-sub">Autonomous Runtime</div>
          </div>
        </div>
        <div class="lockup-card">
          <img class="lockup-icon" src="./metal-1-machined-titanium.svg" />
          <div class="lockup-text">
            <div class="brand-name">&lt;mixdog/&gt;</div>
            <div class="brand-sub">Titanium Studio</div>
          </div>
        </div>
        <div class="lockup-card">
          <img class="lockup-icon" src="./radical-4-neural-starburst.svg" />
          <div class="lockup-text">
            <div class="brand-name">mixdog</div>
            <div class="brand-sub">Multi-Model Engine</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Section 4: Pure 1-Color Monochrome Glyphs -->
    <div>
      <div class="section-header">
        <div class="section-title">Monochrome 1-Color Glyphs</div>
        <div class="section-desc">에디터 타이틀바, TUI, CLI, 깃허브 README용 단색 벡터 검증 (클릭 시 워터마크에 즉시 적용)</div>
      </div>
      <div class="mono-grid">
        <div class="mono-box" onclick="setWatermark('hex')">
          <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="128,40 200,82 200,166 128,208 56,166 56,82" stroke-width="16" />
            <polygon points="128,96 164,120 128,144 92,120" stroke-width="14" />
            <line x1="128" y1="144" x2="128" y2="190" stroke-width="18" />
          </svg>
          <span>01. Hex-Runtime</span>
        </div>

        <div class="mono-box" onclick="setWatermark('monolith')">
          <svg viewBox="0 0 256 256" fill="currentColor">
            <path d="M 60 180 L 60 95 L 95 60 L 128 93 L 161 60 L 196 95 L 196 180 L 164 180 L 164 125 L 128 161 L 92 125 L 92 180 Z" />
            <polygon points="107,140 128,119 149,140 128,168" fill="#000000" />
          </svg>
          <span>02. Negative Monolith</span>
        </div>

        <div class="mono-box" onclick="setWatermark('mobius')">
          <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="20" stroke-linecap="round" stroke-linejoin="round">
            <path d="M 72 176 C 56 140 56 90 88 68 C 112 52 128 92 128 110 C 128 92 144 52 168 68 C 200 90 200 140 184 176 C 168 176 160 135 148 116 L 128 136 L 108 116 C 96 135 88 176 72 176 Z" />
          </svg>
          <span>03. Möbius Loop</span>
        </div>

        <div class="mono-box" onclick="setWatermark('starburst')">
          <svg viewBox="0 0 256 256" fill="currentColor">
            <polygon points="128,82 137,114 174,128 137,142 128,182 119,142 82,128 119,114" />
            <path d="M 90 60 L 113 108 L 97 128 L 60 128 Z" />
            <path d="M 166 60 L 196 128 L 159 128 L 143 108 Z" />
          </svg>
          <span>04. Starburst</span>
        </div>

        <div class="mono-box" onclick="setWatermark('titanium')">
          <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="22" stroke-linecap="round" stroke-linejoin="round">
            <path d="M 64 180 V 104 L 94 74 L 124 104 L 128 100 L 132 104 L 162 74 L 192 104 V 180" />
            <path d="M 98 142 L 128 172 L 158 142" />
          </svg>
          <span>05. Titanium M</span>
        </div>

        <div class="mono-box" onclick="setWatermark('prism')">
          <svg viewBox="0 0 256 256" fill="currentColor">
            <polygon points="64,174 64,104 89,74 89,144" />
            <polygon points="192,174 192,104 167,74 167,144" />
            <polygon points="95,146 128,132 161,146 128,182" />
          </svg>
          <span>06. Cursor Prism</span>
        </div>
      </div>
    </div>

    <!-- Section 5: Real-World Scale Check -->
    <div>
      <div class="section-header">
        <div class="section-title">Scale & Legibility Check</div>
        <div class="section-desc">16px 파비콘부터 128px 앱 아이콘까지 실제 크기 축소 가독성 테스트</div>
      </div>
      <div class="scale-strip">
        <div class="scale-item">
          <img src="./radical-1-hex-runtime.svg" width="128" height="128" />
          <span>128px (App Tile)</span>
        </div>
        <div class="scale-item">
          <img src="./radical-1-hex-runtime.svg" width="64" height="64" />
          <span>64px (Dock)</span>
        </div>
        <div class="scale-item">
          <img src="./radical-1-hex-runtime.svg" width="48" height="48" />
          <span>48px (Taskbar)</span>
        </div>
        <div class="scale-item">
          <img src="./radical-1-hex-runtime.svg" width="32" height="32" />
          <span>32px (Titlebar)</span>
        </div>
        <div class="scale-item">
          <img src="./radical-1-hex-runtime.svg" width="24" height="24" />
          <span>24px (Tab Icon)</span>
        </div>
        <div class="scale-item">
          <img src="./radical-1-hex-runtime.svg" width="16" height="16" />
          <span>16px (Favicon/CLI)</span>
        </div>
      </div>
    </div>
  </div>

  <script>
    const watermarks = {
      hex: \`<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="128,40 200,82 200,166 128,208 56,166 56,82" stroke-width="16" />
              <polygon points="128,96 164,120 128,144 92,120" stroke-width="14" />
              <line x1="128" y1="144" x2="128" y2="190" stroke-width="18" />
            </svg>\`,
      monolith: \`<svg viewBox="0 0 256 256" fill="currentColor">
              <path d="M 60 180 L 60 95 L 95 60 L 128 93 L 161 60 L 196 95 L 196 180 L 164 180 L 164 125 L 128 161 L 92 125 L 92 180 Z" />
              <polygon points="107,140 128,119 149,140 128,168" fill="#101116" />
            </svg>\`,
      mobius: \`<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="20" stroke-linecap="round" stroke-linejoin="round">
              <path d="M 72 176 C 56 140 56 90 88 68 C 112 52 128 92 128 110 C 128 92 144 52 168 68 C 200 90 200 140 184 176 C 168 176 160 135 148 116 L 128 136 L 108 116 C 96 135 88 176 72 176 Z" />
            </svg>\`,
      starburst: \`<svg viewBox="0 0 256 256" fill="currentColor">
              <polygon points="128,82 137,114 174,128 137,142 128,182 119,142 82,128 119,114" />
              <path d="M 90 60 L 113 108 L 97 128 L 60 128 Z" />
              <path d="M 166 60 L 196 128 L 159 128 L 143 108 Z" />
            </svg>\`,
      titanium: \`<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="22" stroke-linecap="round" stroke-linejoin="round">
              <path d="M 64 180 V 104 L 94 74 L 124 104 L 128 100 L 132 104 L 162 74 L 192 104 V 180" />
              <path d="M 98 142 L 128 172 L 158 142" />
            </svg>\`,
      prism: \`<svg viewBox="0 0 256 256" fill="currentColor">
              <polygon points="64,174 64,104 89,74 89,144" />
              <polygon points="192,174 192,104 167,74 167,144" />
              <polygon points="95,146 128,132 161,146 128,182" />
            </svg>\`,
      aperture: \`<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="128" cy="128" r="80" stroke-width="12" />
              <polygon points="60,166 60,102 92,68 122,98 92,128" fill="currentColor" stroke="none" />
              <polygon points="196,166 196,102 164,68 134,98 164,128" fill="currentColor" stroke="none" />
              <polygon points="106,148 128,124 150,148 128,178" fill="currentColor" stroke="none" />
            </svg>\`,
      cli: \`<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <path d="M 62 178 V 106 L 92 74 L 122 104 L 128 98 L 134 104 L 164 74 L 194 106 V 178" stroke-width="22" />
              <path d="M 98 140 L 128 170 L 158 140" stroke-width="20" />
              <line x1="118" y1="118" x2="138" y2="118" stroke-width="10" />
            </svg>\`
    };

    function setWatermark(key) {
      const target = document.getElementById('watermark-target');
      if (watermarks[key]) {
        target.innerHTML = watermarks[key];
      }

      // Update active button state
      const buttons = document.querySelectorAll('#watermark-switcher .sim-btn');
      buttons.forEach(btn => btn.classList.remove('active'));
      const activeBtn = Array.from(buttons).find(b => b.getAttribute('onclick')?.includes(key));
      if (activeBtn) activeBtn.classList.add('active');
    }
  </script>
</body>
</html>`;

writeFileSync('design/logo-concepts/preview.html', html, 'utf8');
console.log('preview.html updated with Ultimate Showcase successfully!');
