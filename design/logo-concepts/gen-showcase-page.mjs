import { writeFileSync } from 'node:fs';
import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';

chdir(fileURLToPath(new URL('../..', import.meta.url)));

const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mixdog - Elite AI Coding Agent Visual Identity</title>
  <style>
    :root {
      --bg: #050608;
      --card-bg: #0d0f15;
      --card-inner: #07080b;
      --border: rgba(255, 255, 255, 0.08);
      --border-hover: rgba(56, 189, 248, 0.5);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.15);
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
      background: rgba(56, 189, 248, 0.08);
      border: 1px solid rgba(56, 189, 248, 0.25);
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 16px;
    }

    header h1 {
      font-size: 46px;
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

    /* Simulator Panel */
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
      flex-wrap: wrap;
    }

    .sim-btn-group {
      display: flex;
      gap: 6px;
      background: rgba(255, 255, 255, 0.04);
      padding: 4px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      flex-wrap: wrap;
    }

    .sim-btn {
      padding: 6px 14px;
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
      background: #0e0f14;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      height: 400px;
      display: flex;
      flex-direction: column;
      position: relative;
      overflow: hidden;
    }

    .mock-titlebar {
      height: 38px;
      background: #08090c;
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
      width: 250px;
      height: 250px;
      opacity: 0.065;
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
      gap: 40px;
      width: 280px;
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
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
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
      padding: 4px 12px;
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
      height: 240px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
    }

    .preview-container img {
      width: 168px;
      height: 168px;
      object-fit: contain;
      filter: drop-shadow(0 16px 32px rgba(0, 0, 0, 0.7));
    }

    .info h3 {
      font-size: 20px;
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
    <div class="badge">Next-Gen AI Coding Agent Visual Identity</div>
    <h1>Mixdog Sleek Tech Systems</h1>
    <p>동물 일러스트와 촌스러운 조형을 완전히 배제하고, <strong>Anthropic · Cursor · Linear · Windsurf · Vercel</strong> 급의 세련된 하이엔드 AI 코딩 에이전트 아이덴티티</p>
  </header>

  <div class="container">
    <!-- 1. VS Code Real-World Watermark Simulator -->
    <div class="simulator-panel">
      <div class="simulator-top">
        <div class="sim-title">
          VS Code Editor Watermark Simulator
          <span>(빈 에디터 중앙에 은은하게 투영되는 순수 단색 글리프 실시간 검증)</span>
        </div>
        <div class="sim-controls">
          <div class="sim-btn-group" id="watermark-switcher">
            <button class="sim-btn active" onclick="setWatermark('prism')">01. Crystalline Prism</button>
            <button class="sim-btn" onclick="setWatermark('nexus')">02. Parabolic Nexus</button>
            <button class="sim-btn" onclick="setWatermark('threads')">03. Thread Cascade</button>
            <button class="sim-btn" onclick="setWatermark('mobius')">04. Liquid Möbius</button>
            <button class="sim-btn" onclick="setWatermark('monolith')">05. Monolith Chasm</button>
            <button class="sim-btn" onclick="setWatermark('spark')">06. Spark Ligature</button>
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
          <div>Mixdog Studio — Autonomous Workspace</div>
          <div>UTF-8</div>
        </div>
        <div class="mock-content">
          <!-- Background Watermark SVG container -->
          <div class="editor-watermark" id="watermark-target">
            <!-- Default: 01. Crystalline Prism -->
            <svg viewBox="0 0 256 256" fill="currentColor">
              <polygon points="68,168 88,80 113,118 88,143" />
              <polygon points="88,80 128,110 113,118" opacity="0.7" />
              <polygon points="188,168 168,80 143,118 168,143" />
              <polygon points="168,80 128,110 143,118" opacity="0.7" />
              <polygon points="113,118 128,95 143,118 128,178" />
            </svg>
          </div>

          <!-- Foreground Shortcut HUD -->
          <div class="mock-shortcuts">
            <div class="shortcut-row"><span>New Task</span><span><kbd>Ctrl</kbd> + <kbd>N</kbd></span></div>
            <div class="shortcut-row"><span>Switch Tab</span><span><kbd>Ctrl</kbd> + <kbd>→</kbd></span></div>
            <div class="shortcut-row"><span>Toggle Agent Dock</span><span><kbd>Ctrl</kbd> + <kbd>B</kbd></span></div>
            <div class="shortcut-row"><span>Settings</span><span><kbd>Ctrl</kbd> + <kbd>,</kbd></span></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Section 1: 6 Sleek AI Coding Agent Concepts -->
    <div>
      <div class="section-header">
        <div class="section-title">
          Elite Coding Agent Concepts <span class="section-tag">2026 Unicorn Tier 6종</span>
        </div>
        <div class="section-desc">Anthropic의 스파크, Cursor의 3D 프리즘, Linear의 곡률 연속성, Windsurf의 캐스케이딩을 결합한 하이엔드 테크 심볼</div>
      </div>

      <div class="concepts-grid">
        <!-- Sleek 1: Crystalline Prism -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Sleek 01 • Anthropic * x Cursor 3D ⭐</span>
            <button class="btn-apply-watermark" onclick="setWatermark('prism')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./sleek-1-crystal-matrix.svg" alt="Crystalline Prism" />
          </div>
          <div class="info">
            <h3>Crystalline Matrix Prism</h3>
            <div class="meta">Multi-Model AI Asterisk / Neural Facets</div>
            <p><strong>Cursor와 Anthropic Spark의 융합</strong>. 멀티 모델 광선들이 굴절하며 형성하는 샤프한 프리즘 M과 중심의 다이아몬드 터미널 실행 다트.</p>
          </div>
        </div>

        <!-- Sleek 2: Parabolic Nexus -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Sleek 02 • Linear G2 Luxury</span>
            <button class="btn-apply-watermark" onclick="setWatermark('nexus')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./sleek-2-parabolic-nexus.svg" alt="Parabolic Nexus" />
          </div>
          <div class="info">
            <h3>Parabolic Arc Nexus</h3>
            <div class="meta">G2 Continuous Curvature / Autonomous Singularity</div>
            <p><strong>Linear 수준의 극한 곡률 연속성</strong>. 양쪽 코드 브래킷 포물선(&lt; &gt;)이 교차하여 중앙에 싱귤래리티 코어와 백색 실행 벡터를 투영.</p>
          </div>
        </div>

        <!-- Sleek 3: Thread Cascade -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Sleek 03 • Windsurf x Warp Architecture</span>
            <button class="btn-apply-watermark" onclick="setWatermark('threads')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./sleek-3-thread-cascade.svg" alt="Thread Cascade" />
          </div>
          <div class="info">
            <h3>Parallel Agent Thread Cascade</h3>
            <div class="meta">High-Throughput Multi-Lane Stream</div>
            <p><strong>병렬 서브에이전트 실행 파이프라인</strong>. 에메랄드와 시안의 다중 실행 스레드가 계단식으로 합류하여 하단의 consensus 실행 셰브론으로 분출.</p>
          </div>
        </div>

        <!-- Sleek 4: Liquid Möbius -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Sleek 04 • Paseo x Stripe Flow</span>
            <button class="btn-apply-watermark" onclick="setWatermark('mobius')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./sleek-4-liquid-mobius.svg" alt="Liquid Mobius" />
          </div>
          <div class="info">
            <h3>Liquid Möbius Stream</h3>
            <div class="meta">Continuous Autonomous Loop / Specular Seam</div>
            <p><strong>액체 티타늄 스펙트럼 리본</strong>. Plan-Act-Observe가 영구 순환하는 단일 폐곡선 M 리본과 내부 정밀 스펙큘러 화이트 엣지.</p>
          </div>
        </div>

        <!-- Sleek 5: Monolith Laser -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Sleek 05 • Raycast x Teenage Engineering</span>
            <button class="btn-apply-watermark" onclick="setWatermark('monolith')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./sleek-5-monolith-laser.svg" alt="Monolith Laser" />
          </div>
          <div class="info">
            <h3>Monolithic Laser Chasm</h3>
            <div class="meta">Heavy Obsidian Slabs / Amber Plasma Flare</div>
            <p><strong>중후한 티타늄 모놀리스</strong>. 샌드블라스트 금속 기둥 사이를 날카롭게 가르는 앰버 플라즈마 터미널 실행 다트.</p>
          </div>
        </div>

        <!-- Sleek 6: Spark Ligature -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Sleek 06 • v0.dev x Supabase Clean</span>
            <button class="btn-apply-watermark" onclick="setWatermark('spark')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./sleek-6-spark-ligature.svg" alt="Spark Ligature" />
          </div>
          <div class="info">
            <h3>mx. Generative Spark Ligature</h3>
            <div class="meta">Minimalist Modern Typographic Mark</div>
            <p><strong>소문자 'm'과 생성형 AI 4-Ray 스파크(✦)의 결합</strong>. 군더더기를 완전히 덜어낸 모던 웹/에디터 네이티브 레터마크.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Section 2: Horizontal Brand Lockups -->
    <div>
      <div class="section-header">
        <div class="section-title">Horizontal Brand Lockups</div>
        <div class="section-desc">공식 웹사이트 헤더, 깃허브 README, 릴리즈 스플래시 화면용 타이포그래피 조합</div>
      </div>
      <div class="lockup-grid">
        <div class="lockup-card">
          <img class="lockup-icon" src="./sleek-1-crystal-matrix.svg" />
          <div class="lockup-text">
            <div class="brand-name">mixdog<span class="accent-dot">.</span></div>
            <div class="brand-sub">AI Coding Agent</div>
          </div>
        </div>
        <div class="lockup-card">
          <img class="lockup-icon" src="./sleek-2-parabolic-nexus.svg" />
          <div class="lockup-text">
            <div class="brand-name">MIXDOG</div>
            <div class="brand-sub">Autonomous Runtime</div>
          </div>
        </div>
        <div class="lockup-card">
          <img class="lockup-icon" src="./sleek-3-thread-cascade.svg" />
          <div class="lockup-text">
            <div class="brand-name">&lt;mixdog/&gt;</div>
            <div class="brand-sub">Multi-Model Engine</div>
          </div>
        </div>
        <div class="lockup-card">
          <img class="lockup-icon" src="./sleek-5-monolith-laser.svg" />
          <div class="lockup-text">
            <div class="brand-name">mixdog</div>
            <div class="brand-sub">High-Performance Studio</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Section 3: Pure 1-Color Monochrome Glyphs -->
    <div>
      <div class="section-header">
        <div class="section-title">Monochrome 1-Color Glyphs</div>
        <div class="section-desc">에디터 타이틀바, TUI, CLI, 깃허브 README용 단색 벡터 (클릭 시 상단 워터마크에 즉시 적용)</div>
      </div>
      <div class="mono-grid">
        <div class="mono-box" onclick="setWatermark('prism')">
          <svg viewBox="0 0 256 256" fill="currentColor">
            <polygon points="68,168 88,80 113,118 88,143" />
            <polygon points="88,80 128,110 113,118" opacity="0.7" />
            <polygon points="188,168 168,80 143,118 168,143" />
            <polygon points="168,80 128,110 143,118" opacity="0.7" />
            <polygon points="113,118 128,95 143,118 128,178" />
          </svg>
          <span>01. Crystalline Prism</span>
        </div>

        <div class="mono-box" onclick="setWatermark('nexus')">
          <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round">
            <path d="M 68 174 C 68 100 90 74 116 94 C 128 103 128 122 128 122" stroke-width="18"/>
            <path d="M 188 174 C 188 100 166 74 140 94 C 128 103 128 122 128 122" stroke-width="18"/>
            <path d="M 102 143 L 128 172 L 154 143" stroke-width="16" stroke-linejoin="round"/>
            <circle cx="128" cy="118" r="5" fill="currentColor" stroke="none"/>
          </svg>
          <span>02. Parabolic Nexus</span>
        </div>

        <div class="mono-box" onclick="setWatermark('threads')">
          <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round">
            <rect x="62" y="105" width="18" height="68" rx="9" fill="currentColor" stroke="none"/>
            <path d="M 88 98 C 88 80 102 72 114 84 L 122 93" stroke-width="16"/>
            <path d="M 168 98 C 168 80 154 72 142 84 L 134 93" stroke-width="16"/>
            <rect x="176" y="105" width="18" height="68" rx="9" fill="currentColor" stroke="none"/>
            <path d="M 97 140 L 128 171 L 159 140" stroke-width="16" stroke-linejoin="round"/>
          </svg>
          <span>03. Thread Cascade</span>
        </div>

        <div class="mono-box" onclick="setWatermark('mobius')">
          <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="18" stroke-linecap="round" stroke-linejoin="round">
            <path d="M 70 174 C 58 135 60 80 89 72 C 113 65 122 98 128 113 C 134 98 143 65 167 72 C 196 80 198 135 186 174 M 98 138 L 128 168 L 158 138" />
          </svg>
          <span>04. Liquid Möbius</span>
        </div>

        <div class="mono-box" onclick="setWatermark('monolith')">
          <svg viewBox="0 0 256 256" fill="currentColor">
            <polygon points="60,178 60,102 88,70 118,102 93,127 93,178" />
            <polygon points="196,178 196,102 168,70 138,102 163,127 163,178" />
            <polygon points="104,142 128,118 152,142 128,171" fill="#38bdf8" />
          </svg>
          <span>05. Monolith Laser</span>
        </div>

        <div class="mono-box" onclick="setWatermark('spark')">
          <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round">
            <path d="M 60 172 V 106 C 60 89 72 80 87 80 C 102 80 112 89 112 106 V 172" stroke-width="16"/>
            <path d="M 112 120 C 118 91 134 80 150 80 C 167 80 178 91 178 110 V 172" stroke-width="16"/>
            <path d="M 198 126 Q 198 110 214 110 Q 198 110 198 94 Q 198 110 182 110 Q 198 110 198 126 Z" fill="currentColor" stroke="none"/>
          </svg>
          <span>06. Spark Ligature</span>
        </div>
      </div>
    </div>

    <!-- Section 4: Scale & Legibility Check -->
    <div>
      <div class="section-header">
        <div class="section-title">Scale & Legibility Check</div>
        <div class="section-desc">16px 파비콘부터 128px 앱 아이콘까지 실제 크기 축소 가독성 테스트</div>
      </div>
      <div class="scale-strip">
        <div class="scale-item">
          <img src="./sleek-1-crystal-matrix.svg" width="128" height="128" />
          <span>128px (App Tile)</span>
        </div>
        <div class="scale-item">
          <img src="./sleek-1-crystal-matrix.svg" width="64" height="64" />
          <span>64px (Dock)</span>
        </div>
        <div class="scale-item">
          <img src="./sleek-1-crystal-matrix.svg" width="48" height="48" />
          <span>48px (Taskbar)</span>
        </div>
        <div class="scale-item">
          <img src="./sleek-1-crystal-matrix.svg" width="32" height="32" />
          <span>32px (Titlebar)</span>
        </div>
        <div class="scale-item">
          <img src="./sleek-1-crystal-matrix.svg" width="24" height="24" />
          <span>24px (Tab Icon)</span>
        </div>
        <div class="scale-item">
          <img src="./sleek-1-crystal-matrix.svg" width="16" height="16" />
          <span>16px (Favicon/CLI)</span>
        </div>
      </div>
    </div>
  </div>

  <script>
    const watermarks = {
      prism: \`<svg viewBox="0 0 256 256" fill="currentColor">
              <polygon points="68,168 88,80 113,118 88,143" />
              <polygon points="88,80 128,110 113,118" opacity="0.7" />
              <polygon points="188,168 168,80 143,118 168,143" />
              <polygon points="168,80 128,110 143,118" opacity="0.7" />
              <polygon points="113,118 128,95 143,118 128,178" />
            </svg>\`,
      nexus: \`<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round">
              <path d="M 68 174 C 68 100 90 74 116 94 C 128 103 128 122 128 122" stroke-width="18"/>
              <path d="M 188 174 C 188 100 166 74 140 94 C 128 103 128 122 128 122" stroke-width="18"/>
              <path d="M 102 143 L 128 172 L 154 143" stroke-width="16" stroke-linejoin="round"/>
              <circle cx="128" cy="118" r="5" fill="currentColor" stroke="none"/>
            </svg>\`,
      threads: \`<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round">
              <rect x="62" y="105" width="18" height="68" rx="9" fill="currentColor" stroke="none"/>
              <path d="M 88 98 C 88 80 102 72 114 84 L 122 93" stroke-width="16"/>
              <path d="M 168 98 C 168 80 154 72 142 84 L 134 93" stroke-width="16"/>
              <rect x="176" y="105" width="18" height="68" rx="9" fill="currentColor" stroke="none"/>
              <path d="M 97 140 L 128 171 L 159 140" stroke-width="16" stroke-linejoin="round"/>
            </svg>\`,
      mobius: \`<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="18" stroke-linecap="round" stroke-linejoin="round">
              <path d="M 70 174 C 58 135 60 80 89 72 C 113 65 122 98 128 113 C 134 98 143 65 167 72 C 196 80 198 135 186 174 M 98 138 L 128 168 L 158 138" />
            </svg>\`,
      monolith: \`<svg viewBox="0 0 256 256" fill="currentColor">
              <polygon points="60,178 60,102 88,70 118,102 93,127 93,178" />
              <polygon points="196,178 196,102 168,70 138,102 163,127 163,178" />
              <polygon points="104,142 128,118 152,142 128,171" fill="#38bdf8" />
            </svg>\`,
      spark: \`<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round">
              <path d="M 60 172 V 106 C 60 89 72 80 87 80 C 102 80 112 89 112 106 V 172" stroke-width="16"/>
              <path d="M 112 120 C 118 91 134 80 150 80 C 167 80 178 91 178 110 V 172" stroke-width="16"/>
              <path d="M 198 126 Q 198 110 214 110 Q 198 110 198 94 Q 198 110 182 110 Q 198 110 198 126 Z" fill="currentColor" stroke="none"/>
            </svg>\`
    };

    function setWatermark(key) {
      const target = document.getElementById('watermark-target');
      if (watermarks[key]) {
        target.innerHTML = watermarks[key];
      }

      const buttons = document.querySelectorAll('#watermark-switcher .sim-btn');
      buttons.forEach(btn => btn.classList.remove('active'));
      const activeBtn = Array.from(buttons).find(b => b.getAttribute('onclick')?.includes(key));
      if (activeBtn) activeBtn.classList.add('active');
    }
  </script>
</body>
</html>`;

writeFileSync('design/logo-concepts/preview.html', html, 'utf8');
console.log('preview.html updated with Elite Sleek Agent concepts successfully!');
