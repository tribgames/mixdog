import { writeFileSync } from 'node:fs';
import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';

chdir(fileURLToPath(new URL('../..', import.meta.url)));

const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mixdog - Fresh Paradigms & VS Code Watermark Showcase</title>
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
      font-size: 42px;
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

    .dot { width: 10px; height: 10px; border-radius: 50%; }
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
      opacity: 0.08;
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
    <div class="badge">Fresh Design Paradigms</div>
    <h1>Mixdog Fresh Visual Identities</h1>
    <p>기존의 단순 M자 대칭 틀을 탈피한 <strong>측면 사이버 하운드 실루엣, 코드 태그 발바닥, LED 도트 매트릭스, ⌘ 커맨드 룬, 개발자 본(Bone) 슬래시</strong>와 <strong>VS Code 배경 워터마크 실시간 시뮬레이션</strong></p>
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
            <button class="sim-btn active" onclick="setWatermark('profile')">01. Hound Profile</button>
            <button class="sim-btn" onclick="setWatermark('paw')">02. Code Tag Paw</button>
            <button class="sim-btn" onclick="setWatermark('dot')">03. LED Dot Matrix</button>
            <button class="sim-btn" onclick="setWatermark('rune')">04. Command Rune ⌘</button>
            <button class="sim-btn" onclick="setWatermark('bone')">05. Code Bone //</button>
            <button class="sim-btn" onclick="setWatermark('mixer')">06. Model Mixer</button>
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
            <!-- Default: Hound Profile -->
            <svg viewBox="0 0 256 256" fill="currentColor">
              <polygon points="66,182 108,124 84,72 124,94 172,124 194,124 202,134 174,156 128,182" />
              <polygon points="84,72 124,94 102,116" fill="#000000" />
              <polygon points="202,134 174,156 148,140 172,124 194,124" fill="#000000" />
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

    <!-- Section 1: 6 Fresh Distinct Concepts -->
    <div>
      <div class="section-header">
        <div class="section-title">
          Fresh Non-M Paradigms <span class="section-tag">완전히 새로운 조형 6종</span>
        </div>
        <div class="section-desc">M자 대칭을 벗어난 측면 스텔스 하운드, 코드 태그 발바닥, LED 도트 매트릭스, 커맨드 룬, 코드 본 슬래시, 멀티 모델 믹서</div>
      </div>

      <div class="concepts-grid">
        <!-- Fresh 1: Stealth Hound Side Profile -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Paradigm 01 • Dynamic Mascot ⭐</span>
            <button class="btn-apply-watermark" onclick="setWatermark('profile')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./different-1-hound-profile.svg" alt="Hound Profile" />
          </div>
          <div class="info">
            <h3>Stealth Cyber-Hound Profile</h3>
            <div class="meta">Aerodynamic Speed / Terminal Snout (>) / Laser Visor</div>
            <p><strong>날렵한 측면 실루엣</strong>. 앞을 향해 달리는 스텔스 하운드의 기하학적 형태. 주둥이가 터미널 프롬프트(&gt;)로 열리며 레이저 바이저가 빛나는 강렬한 아이덴티티.</p>
          </div>
        </div>

        <!-- Fresh 2: Code Tag Paw -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Paradigm 02 • Developer Culture</span>
            <button class="btn-apply-watermark" onclick="setWatermark('paw')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./different-2-code-paw.svg" alt="Code Tag Paw" />
          </div>
          <div class="info">
            <h3>Code Tag Paw & AST Nodes</h3>
            <div class="meta">Syntax Tag &lt; &gt; / Diamond Prompt / Node Toes</div>
            <p><strong>코드 브래킷과 발바닥의 위트있는 결합</strong>. 양쪽 발가락이 코드 태그(&lt; &gt;)와 AST 노드로 구성되고 중앙 패드가 프롬프트 셰브론 다이아몬드로 완성된 마크.</p>
          </div>
        </div>

        <!-- Fresh 3: LED Dot Matrix -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Paradigm 03 • Nothing & Teenage Eng</span>
            <button class="btn-apply-watermark" onclick="setWatermark('dot')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./different-3-dot-matrix.svg" alt="LED Dot Matrix" />
          </div>
          <div class="info">
            <h3>LED Dot-Matrix Cyber Face</h3>
            <div class="meta">Monospace TUI / Hardware Grid / Amber Status Point</div>
            <p><strong>초정밀 LED 도트 매트릭스 그리드</strong>. Nothing Phone / 하드웨어 신디사이저 감성으로 구현된 사이버네틱 강아지 페이스. TUI와 터미널에서 극강의 힙함.</p>
          </div>
        </div>

        <!-- Fresh 4: Command Rune Keycap -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Paradigm 04 • Mac Command ⌘</span>
            <button class="btn-apply-watermark" onclick="setWatermark('rune')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./different-4-command-rune.svg" alt="Command Rune" />
          </div>
          <div class="info">
            <h3>Command ⌘ Keycap Rune</h3>
            <div class="meta">Apple Command / Continuous Loop / Cyber Ear Antennas</div>
            <p><strong>개발자 단축키 ⌘ 기호의 진화</strong>. 4개의 연속 폐곡선 루프가 상단 강아지 귀 안테나와 중앙 시안 프롬프트 다이아몬드를 품은 순수 소프트웨어 심볼.</p>
          </div>
        </div>

        <!-- Fresh 5: Code Bone Slash -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Paradigm 05 • Syntax Pun</span>
            <button class="btn-apply-watermark" onclick="setWatermark('bone')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./different-5-code-bone.svg" alt="Code Bone" />
          </div>
          <div class="info">
            <h3>45° Code Bone & Token Slash //</h3>
            <div class="meta">Double Slash // / Git Branch Nodes / Chamfer Bone</div>
            <p><strong>강아지 뼈다귀 + 코드 주석 슬래시(//)</strong>. 45도 각도의 정밀 챔퍼 본(Bone) 중앙에 코드 주석 레이저 슬릿(//)이 각인된 개발자 유머와 미니멀리즘.</p>
          </div>
        </div>

        <!-- Fresh 6: Multi-Model Mixer -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Paradigm 06 • Orchestrator</span>
            <button class="btn-apply-watermark" onclick="setWatermark('mixer')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./different-6-model-mixer.svg" alt="Model Mixer" />
          </div>
          <div class="info">
            <h3>Dual-Lens Multi-Model Mixer</h3>
            <div class="meta">Intersecting LLM Lenses (Mix) / Neural Nexus</div>
            <p><strong>다중 AI 모델 믹스(Mix)의 시각화</strong>. 시안(Cyan)과 로즈(Rose) 두 모델 렌즈가 교차하며 중심에서 터미널 실행 셰브론과 강아지 얼굴을 투영하는 조형.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Section 2: Wordmark & Horizontal Lockups -->
    <div>
      <div class="section-header">
        <div class="section-title">Horizontal Brand Lockups</div>
        <div class="section-desc">공식 웹사이트 헤더, 깃허브 README 상단, 릴리즈 스플래시 화면용 타이포그래피 조합</div>
      </div>
      <div class="lockup-grid">
        <div class="lockup-card">
          <img class="lockup-icon" src="./different-1-hound-profile.svg" />
          <div class="lockup-text">
            <div class="brand-name">mixdog<span class="accent-dot">.</span></div>
            <div class="brand-sub">Autonomous AI Hound</div>
          </div>
        </div>
        <div class="lockup-card">
          <img class="lockup-icon" src="./different-2-code-paw.svg" />
          <div class="lockup-text">
            <div class="brand-name">MIXDOG</div>
            <div class="brand-sub">Code Agent Runtime</div>
          </div>
        </div>
        <div class="lockup-card">
          <img class="lockup-icon" src="./different-4-command-rune.svg" />
          <div class="lockup-text">
            <div class="brand-name">&lt;mixdog/&gt;</div>
            <div class="brand-sub">Command Studio</div>
          </div>
        </div>
        <div class="lockup-card">
          <img class="lockup-icon" src="./different-3-dot-matrix.svg" />
          <div class="lockup-text">
            <div class="brand-name">mixdog</div>
            <div class="brand-sub">Hardware & TUI Engine</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Section 3: Pure 1-Color Monochrome Glyphs -->
    <div>
      <div class="section-header">
        <div class="section-title">Monochrome 1-Color Glyphs</div>
        <div class="section-desc">에디터 타이틀바, TUI, CLI, 깃허브 README용 단색 벡터 검증 (클릭 시 워터마크에 즉시 적용)</div>
      </div>
      <div class="mono-grid">
        <div class="mono-box" onclick="setWatermark('profile')">
          <svg viewBox="0 0 256 256" fill="currentColor">
            <polygon points="66,182 108,124 84,72 124,94 172,124 194,124 202,134 174,156 128,182" />
            <polygon points="84,72 124,94 102,116" fill="#000000" />
            <polygon points="202,134 174,156 148,140 172,124 194,124" fill="#000000" />
          </svg>
          <span>01. Hound Profile</span>
        </div>

        <div class="mono-box" onclick="setWatermark('paw')">
          <svg viewBox="0 0 256 256" fill="currentColor">
            <polygon points="100,136 128,108 156,136 128,164" />
            <path d="M 108 164 L 128 184 L 148 164" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M 86 88 L 72 102 L 86 116" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />
            <circle cx="108" cy="74" r="11" />
            <circle cx="148" cy="74" r="11" />
            <path d="M 170 88 L 184 102 L 170 116" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>02. Code Tag Paw</span>
        </div>

        <div class="mono-box" onclick="setWatermark('dot')">
          <svg viewBox="0 0 256 256" fill="currentColor">
            <circle cx="76" cy="70" r="7"/><circle cx="94" cy="88" r="7"/>
            <circle cx="180" cy="70" r="7"/><circle cx="162" cy="88" r="7"/>
            <circle cx="112" cy="106" r="7"/><circle cx="128" cy="106" r="7"/><circle cx="144" cy="106" r="7"/>
            <circle cx="94" cy="124" r="7"/><circle cx="162" cy="124" r="7"/>
            <circle cx="94" cy="146" r="7"/><circle cx="162" cy="146" r="7"/>
            <circle cx="112" cy="164" r="7"/><circle cx="144" cy="164" r="7"/>
            <circle cx="128" cy="182" r="8"/>
          </svg>
          <span>03. LED Dot Matrix</span>
        </div>

        <div class="mono-box" onclick="setWatermark('rune')">
          <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round">
            <path d="M 108 96 C 108 74 90 74 80 84 C 70 94 70 112 92 112 L 164 112 C 186 112 186 94 176 84 C 166 74 148 74 148 96 L 148 144 C 148 166 166 166 176 156 C 186 146 186 128 164 128 L 92 128 C 70 128 70 146 80 156 C 90 166 108 166 108 144 Z" />
            <polygon points="128,110 138,120 128,130 118,120" fill="currentColor" stroke="none"/>
          </svg>
          <span>04. Command Rune</span>
        </div>

        <div class="mono-box" onclick="setWatermark('bone')">
          <svg viewBox="0 0 256 256" fill="currentColor">
            <rect x="98" y="118" width="60" height="20" rx="6" transform="rotate(-45 128 128)"/>
            <circle cx="74" cy="74" r="14"/><circle cx="94" cy="58" r="14"/><circle cx="58" cy="94" r="14"/>
            <circle cx="182" cy="182" r="14"/><circle cx="162" cy="198" r="14"/><circle cx="198" cy="162" r="14"/>
          </svg>
          <span>05. Code Bone //</span>
        </div>

        <div class="mono-box" onclick="setWatermark('mixer')">
          <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="102" cy="116" r="38" stroke-width="12" />
            <circle cx="154" cy="116" r="38" stroke-width="12" />
            <polygon points="76,90 92,56 108,90" fill="currentColor" stroke="none" />
            <polygon points="148,90 164,56 180,90" fill="currentColor" stroke="none" />
            <path d="M 108 132 L 128 158 L 148 132" stroke-width="12" />
          </svg>
          <span>06. Model Mixer</span>
        </div>
      </div>
    </div>

    <!-- Section 4: Real-World Scale Check -->
    <div>
      <div class="section-header">
        <div class="section-title">Scale & Legibility Check</div>
        <div class="section-desc">16px 파비콘부터 128px 앱 아이콘까지 실제 크기 축소 가독성 테스트</div>
      </div>
      <div class="scale-strip">
        <div class="scale-item">
          <img src="./different-1-hound-profile.svg" width="128" height="128" />
          <span>128px (App Tile)</span>
        </div>
        <div class="scale-item">
          <img src="./different-1-hound-profile.svg" width="64" height="64" />
          <span>64px (Dock)</span>
        </div>
        <div class="scale-item">
          <img src="./different-1-hound-profile.svg" width="48" height="48" />
          <span>48px (Taskbar)</span>
        </div>
        <div class="scale-item">
          <img src="./different-1-hound-profile.svg" width="32" height="32" />
          <span>32px (Titlebar)</span>
        </div>
        <div class="scale-item">
          <img src="./different-1-hound-profile.svg" width="24" height="24" />
          <span>24px (Tab Icon)</span>
        </div>
        <div class="scale-item">
          <img src="./different-1-hound-profile.svg" width="16" height="16" />
          <span>16px (Favicon/CLI)</span>
        </div>
      </div>
    </div>
  </div>

  <script>
    const watermarks = {
      profile: \`<svg viewBox="0 0 256 256" fill="currentColor">
              <polygon points="66,182 108,124 84,72 124,94 172,124 194,124 202,134 174,156 128,182" />
              <polygon points="84,72 124,94 102,116" fill="#101116" />
              <polygon points="202,134 174,156 148,140 172,124 194,124" fill="#101116" />
            </svg>\`,
      paw: \`<svg viewBox="0 0 256 256" fill="currentColor">
              <polygon points="100,136 128,108 156,136 128,164" />
              <path d="M 108 164 L 128 184 L 148 164" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />
              <path d="M 86 88 L 72 102 L 86 116" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />
              <circle cx="108" cy="74" r="11" />
              <circle cx="148" cy="74" r="11" />
              <path d="M 170 88 L 184 102 L 170 116" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>\`,
      dot: \`<svg viewBox="0 0 256 256" fill="currentColor">
              <circle cx="76" cy="70" r="7"/><circle cx="94" cy="88" r="7"/>
              <circle cx="180" cy="70" r="7"/><circle cx="162" cy="88" r="7"/>
              <circle cx="112" cy="106" r="7"/><circle cx="128" cy="106" r="7"/><circle cx="144" cy="106" r="7"/>
              <circle cx="94" cy="124" r="7"/><circle cx="162" cy="124" r="7"/>
              <circle cx="94" cy="146" r="7"/><circle cx="162" cy="146" r="7"/>
              <circle cx="112" cy="164" r="7"/><circle cx="144" cy="164" r="7"/>
              <circle cx="128" cy="182" r="8"/>
            </svg>\`,
      rune: \`<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round">
              <path d="M 108 96 C 108 74 90 74 80 84 C 70 94 70 112 92 112 L 164 112 C 186 112 186 94 176 84 C 166 74 148 74 148 96 L 148 144 C 148 166 166 166 176 156 C 186 146 186 128 164 128 L 92 128 C 70 128 70 146 80 156 C 90 166 108 166 108 144 Z" />
              <polygon points="128,110 138,120 128,130 118,120" fill="currentColor" stroke="none"/>
            </svg>\`,
      bone: \`<svg viewBox="0 0 256 256" fill="currentColor">
              <rect x="98" y="118" width="60" height="20" rx="6" transform="rotate(-45 128 128)"/>
              <circle cx="74" cy="74" r="14"/><circle cx="94" cy="58" r="14"/><circle cx="58" cy="94" r="14"/>
              <circle cx="182" cy="182" r="14"/><circle cx="162" cy="198" r="14"/><circle cx="198" cy="162" r="14"/>
            </svg>\`,
      mixer: \`<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="102" cy="116" r="38" stroke-width="12" />
              <circle cx="154" cy="116" r="38" stroke-width="12" />
              <polygon points="76,90 92,56 108,90" fill="currentColor" stroke="none" />
              <polygon points="148,90 164,56 180,90" fill="currentColor" stroke="none" />
              <path d="M 108 132 L 128 158 L 148 132" stroke-width="12" />
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
console.log('preview.html updated with Fresh Non-M Paradigms successfully!');
