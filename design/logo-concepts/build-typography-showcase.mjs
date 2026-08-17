import { writeFileSync } from 'node:fs';
import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';

chdir(fileURLToPath(new URL('../..', import.meta.url)));

const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mixdog - Modern Tech & Lettering Typography System</title>
  <style>
    :root {
      --bg: #07080b;
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

    /* VS Code Watermark Simulator */
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

    /* Lettering & Typography Showcase Section */
    .type-specimen-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
      gap: 24px;
    }

    .type-specimen-card {
      background: #0f1118;
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 32px 28px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      transition: all 0.25s;
    }

    .type-specimen-card:hover {
      border-color: var(--border-hover);
      transform: translateY(-4px);
    }

    .type-display {
      height: 90px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #06070a;
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 14px;
      padding: 0 24px;
    }

    .wordmark-1 {
      font-family: "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 38px;
      font-weight: 800;
      letter-spacing: -0.05em;
      color: #ffffff;
      display: flex;
      align-items: baseline;
      gap: 2px;
    }
    .wordmark-1 .accent-x {
      color: var(--accent);
    }
    .wordmark-1 .dot {
      width: 8px;
      height: 8px;
      border-radius: 2px;
      background: #38bdf8;
      display: inline-block;
      margin-left: 2px;
    }

    .wordmark-2 {
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      font-size: 32px;
      font-weight: 700;
      letter-spacing: -0.04em;
      color: #f8fafc;
    }
    .wordmark-2 .slash { color: #38bdf8; }
    .wordmark-2 .cursor { color: #f59e0b; }

    .wordmark-3 {
      font-family: "SF Pro Display", sans-serif;
      font-size: 36px;
      font-weight: 900;
      letter-spacing: -0.06em;
      text-transform: uppercase;
      background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 50%, #64748b 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .wordmark-4 {
      font-family: "Inter", -apple-system, sans-serif;
      font-size: 34px;
      font-weight: 700;
      letter-spacing: -0.04em;
      color: #ffffff;
    }
    .wordmark-4 .code-tag { color: #818cf8; font-weight: 400; }

    .type-info h4 {
      font-size: 16px;
      font-weight: 700;
      color: #ffffff;
      margin-bottom: 4px;
    }
    .type-info p {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
    }

    /* Main Icon Concepts Grid */
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
      filter: drop-shadow(0 16px 32px rgba(0, 0, 0, 0.7));
    }

    .info h3 {
      font-size: 18px;
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
    <div class="badge">Modern Tech Typography & Lettering System</div>
    <h1>Mixdog Typography & Tech Logos</h1>
    <p>군더더기 없는 순수 모던 테크 톤의 타이포그래피 레터링, 미니멀 모노그램(mx, md, m.), 그리고 <strong>VS Code 에디터 배경 워터마크 실시간 시뮬레이션</strong></p>
  </header>

  <div class="container">
    <!-- 1. VS Code Watermark Simulator -->
    <div class="simulator-panel">
      <div class="simulator-top">
        <div class="sim-title">
          VS Code Editor Watermark Simulator
          <span>(빈 에디터 배경에 투영되는 단색 심볼 실시간 검증)</span>
        </div>
        <div class="sim-controls">
          <div class="sim-btn-group" id="watermark-switcher">
            <button class="sim-btn active" onclick="setWatermark('mx')">01. mx-Ligature</button>
            <button class="sim-btn" onclick="setWatermark('md')">02. md-Monogram</button>
            <button class="sim-btn" onclick="setWatermark('mprompt')">03. m. Dot</button>
            <button class="sim-btn" onclick="setWatermark('cross')">04. MIX-Cross</button>
            <button class="sim-btn" onclick="setWatermark('slash')">05. //md Slash</button>
            <button class="sim-btn" onclick="setWatermark('apex')">06. Linear Apex</button>
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
            <!-- Default: mx-Ligature -->
            <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <path d="M 64 176 V 104 C 64 86 78 74 96 74 C 114 74 126 88 126 106 V 176" stroke-width="20" />
              <path d="M 126 110 C 126 88 138 74 156 74 C 174 74 188 86 188 104 V 176" stroke-width="20" />
              <line x1="152" y1="122" x2="204" y2="176" stroke-width="20" />
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

    <!-- Section 1: Typographic Lettering & Wordmark Lockups -->
    <div>
      <div class="section-header">
        <div class="section-title">
          Typographic Wordmark & Lettering <span class="section-tag">레터링 & 타이포그래피</span>
        </div>
        <div class="section-desc">Linear, Vercel, Stripe, Resend 스타일의 극도로 정제된 모던 테크 레터링 시스템</div>
      </div>

      <div class="type-specimen-grid">
        <!-- Wordmark 1 -->
        <div class="type-specimen-card">
          <div class="type-display">
            <div class="wordmark-1">mixdog<span class="dot"></span></div>
          </div>
          <div class="type-info">
            <h4>01. Geometric Neo-Grotesk (mixdog.)</h4>
            <p><strong>Linear / Vercel 감성</strong>. 소문자 'mixdog'에 시안 터미널 도트 포인트가 찍힌 극도의 미니멀리즘 워드마크.</p>
          </div>
        </div>

        <!-- Wordmark 2 -->
        <div class="type-specimen-card">
          <div class="type-display">
            <div class="wordmark-2"><span class="slash">//</span>mixdog<span class="cursor">_</span></div>
          </div>
          <div class="type-info">
            <h4>02. Terminal Code Syntax (//mixdog_)</h4>
            <p><strong>Claude Code / Developer Native</strong>. 코드 주석 슬래시(//)와 깜빡이는 터미널 커서(_)가 결합된 개발자 아이덴티티.</p>
          </div>
        </div>

        <!-- Wordmark 3 -->
        <div class="type-specimen-card">
          <div class="type-display">
            <div class="wordmark-3">MIXDOG</div>
          </div>
          <div class="type-info">
            <h4>03. Precision Swiss Modernist (MIXDOG)</h4>
            <p><strong>Zed / Raycast All-Caps</strong>. 단단한 티타늄 메탈릭 그라데이션이 적용된 볼드 스위스 모더니스트 대문자 레터링.</p>
          </div>
        </div>

        <!-- Wordmark 4 -->
        <div class="type-specimen-card">
          <div class="type-display">
            <div class="wordmark-4"><span class="code-tag">&lt;</span>mixdog<span class="code-tag"> /&gt;</span></div>
          </div>
          <div class="type-info">
            <h4>04. JSX / Component Tag (&lt;mixdog /&gt;)</h4>
            <p><strong>React / AST Syntax</strong>. 소프트웨어 엔지니어링의 셀프 클로징 컴포넌트 태그 문법을 적용한 깔끔한 레터마크.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Section 2: 8 Clean Tech-Tone Icon Concepts -->
    <div>
      <div class="section-header">
        <div class="section-title">
          Modern Tech Monogram & Icon Marks <span class="section-tag">심플 테크 모노그램 8종</span>
        </div>
        <div class="section-desc">유치한 동물 일러스트를 완전히 배제하고, 순수 글꼴 기하학(mx, md, m.)과 코딩 에이전트 프롬프트로 완성한 아이콘</div>
      </div>

      <div class="concepts-grid">
        <!-- Concept 1: mx Ligature -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Type 01 • Recommended ⭐</span>
            <button class="btn-apply-watermark" onclick="setWatermark('mx')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./type-1-mx-ligature.svg" alt="mx Ligature" />
          </div>
          <div class="info">
            <h3>mx-Ligature Mark</h3>
            <div class="meta">Linear / Vercel Lettermark</div>
            <p>소문자 <strong>'m'</strong>이 <strong>'x' (Mix)</strong>의 교차 슬래시로 자연스럽게 이어지는 모던 테크 리가처. 16px 파비콘 및 워터마크에 최고로 적합.</p>
          </div>
        </div>

        <!-- Concept 2: md Monogram -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Type 02 • Raycast Grid</span>
            <button class="btn-apply-watermark" onclick="setWatermark('md')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./type-2-md-monogram.svg" alt="md Monogram" />
          </div>
          <div class="info">
            <h3>md-Monogram & Status LED</h3>
            <div class="meta">Interlocking M + D Geometry</div>
            <p><strong>'M'과 'D'</strong>가 단일 45° 기하학 그리드로 맞물리며 중앙 하단에 앰버 상태 표시등이 배치된 하드웨어 감성.</p>
          </div>
        </div>

        <!-- Concept 3: m. Prompt Dot -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Type 03 • Ultra-Minimal</span>
            <button class="btn-apply-watermark" onclick="setWatermark('mprompt')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./type-3-m-prompt.svg" alt="m. Prompt" />
          </div>
          <div class="info">
            <h3>m. (m-dot) Tech Mark</h3>
            <div class="meta">Pure Lowercase Letterpress</div>
            <p>완벽한 곡률의 소문자 <strong>'m'</strong> 우측 하단에 시안 터미널 스퀘어 픽셀이 찍힌 군더더기 제로의 미니멀리즘.</p>
          </div>
        </div>

        <!-- Concept 4: MIX Cross -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Type 04 • Warp / Zed Cross</span>
            <button class="btn-apply-watermark" onclick="setWatermark('cross')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./type-4-mix-cross.svg" alt="MIX Cross" />
          </div>
          <div class="info">
            <h3>MIX Orthogonal Bands</h3>
            <div class="meta">M + X Intersecting Vectors</div>
            <p>실버 M 셰브론 밴드와 전면으로 돌진하는 시안 실행 셰브론이 직교 교차하여 <strong>M과 X</strong>를 동시에 형성.</p>
          </div>
        </div>

        <!-- Concept 5: Heavy Grotesk -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Type 05 • Stripe / Figma</span>
            <button class="btn-apply-watermark" onclick="setWatermark('grotesk')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./type-5-heavy-grotesk.svg" alt="Heavy Grotesk" />
          </div>
          <div class="info">
            <h3>Heavy Grotesk M-Block</h3>
            <div class="meta">Solid Titanium Monolith</div>
            <p>두터운 볼드 산세리프 M의 중심을 깊게 파고든 챔퍼 V자 노치. 중후하고 신뢰감 있는 개발자 플랫폼 룩.</p>
          </div>
        </div>

        <!-- Concept 6: Slash Code //md -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Type 06 • Developer Native</span>
            <button class="btn-apply-watermark" onclick="setWatermark('slash')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./type-6-slash-code.svg" alt="Slash Code" />
          </div>
          <div class="info">
            <h3>//md Syntax Slash</h3>
            <div class="meta">Code Comments // + Terminal Cursor</div>
            <p>주석 슬래시(//) 두 개가 M의 기둥이 되고 우측 아치가 D로 이어지는 네이티브 코딩 에이전트 마크.</p>
          </div>
        </div>

        <!-- Concept 7: Bracket <M> -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Type 07 • Syntax Tag</span>
            <button class="btn-apply-watermark" onclick="setWatermark('bracket')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./type-7-bracket-m.svg" alt="Bracket M" />
          </div>
          <div class="info">
            <h3>&lt; M &gt; Syntax Bracket</h3>
            <div class="meta">AST Brackets + M Monogram</div>
            <p>여는 브래킷(&lt;)과 닫는 브래킷(&gt;)이 중앙 V 커넥터로 연결되어 완벽한 M을 형성하는 문법 심볼.</p>
          </div>
        </div>

        <!-- Concept 8: Linear Apex -->
        <div class="concept-card">
          <div class="card-top-bar">
            <span class="concept-tag">Type 08 • Precision Apex ⭐</span>
            <button class="btn-apply-watermark" onclick="setWatermark('apex')">Apply Watermark</button>
          </div>
          <div class="preview-container">
            <img src="./type-8-linear-apex.svg" alt="Linear Apex" />
          </div>
          <div class="info">
            <h3>Linear Apex & Prompt</h3>
            <div class="meta">45° Machined Titanium Precision</div>
            <p>정밀 45도 챔퍼 티타늄 M 프레임과 내부의 시안 터미널 프롬프트 셰브론(&gt;)의 조화.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Section 3: Pure 1-Color Monochrome Glyphs -->
    <div>
      <div class="section-header">
        <div class="section-title">Monochrome 1-Color Glyphs</div>
        <div class="section-desc">에디터 타이틀바, TUI, 워터마크용 순수 단색 벡터 검증 (클릭 시 워터마크에 즉시 적용)</div>
      </div>
      <div class="mono-grid">
        <div class="mono-box" onclick="setWatermark('mx')">
          <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
            <path d="M 64 176 V 104 C 64 86 78 74 96 74 C 114 74 126 88 126 106 V 176" stroke-width="20" />
            <path d="M 126 110 C 126 88 138 74 156 74 C 174 74 188 86 188 104 V 176" stroke-width="20" />
            <line x1="152" y1="122" x2="204" y2="176" stroke-width="20" />
          </svg>
          <span>01. mx-Ligature</span>
        </div>

        <div class="mono-box" onclick="setWatermark('md')">
          <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
            <path d="M 72 176 V 84 L 108 132 L 128 100" stroke-width="22" />
            <path d="M 128 100 L 148 132 L 184 84 V 176" stroke-width="22" />
            <circle cx="128" cy="158" r="7" fill="currentColor" stroke="none" />
          </svg>
          <span>02. md-Monogram</span>
        </div>

        <div class="mono-box" onclick="setWatermark('mprompt')">
          <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
            <path d="M 64 176 V 108 C 64 88 78 76 96 76 C 114 76 126 88 126 108 V 176 M 126 108 C 126 88 138 76 156 76 C 174 76 188 88 188 108 V 176" stroke-width="20" />
            <rect x="180" y="166" width="16" height="16" rx="3" fill="currentColor" stroke="none" />
          </svg>
          <span>03. m. Dot</span>
        </div>

        <div class="mono-box" onclick="setWatermark('cross')">
          <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
            <path d="M 64 176 V 98 L 104 74 L 128 98 L 152 74 L 192 98 V 176" stroke-width="20" />
            <path d="M 84 142 L 128 176 L 172 142" stroke-width="20" />
          </svg>
          <span>04. MIX-Cross</span>
        </div>

        <div class="mono-box" onclick="setWatermark('grotesk')">
          <svg viewBox="0 0 256 256" fill="currentColor">
            <path d="M 60 180 V 80 H 88 L 128 138 L 168 80 H 196 V 180 H 170 V 118 L 136 168 H 120 L 86 118 V 180 Z" />
          </svg>
          <span>05. Heavy Grotesk</span>
        </div>

        <div class="mono-box" onclick="setWatermark('slash')">
          <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
            <line x1="84" y1="178" x2="118" y2="78" stroke-width="20" />
            <line x1="124" y1="178" x2="158" y2="78" stroke-width="20" />
            <path d="M 118 78 C 138 78 150 91 150 110 V 178" stroke-width="20" />
            <line x1="168" y1="178" x2="190" y2="178" stroke-width="12" />
          </svg>
          <span>06. //md Slash</span>
        </div>

        <div class="mono-box" onclick="setWatermark('apex')">
          <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
            <path d="M 64 178 V 98 L 96 74 L 128 104 L 160 74 L 192 98 V 178" stroke-width="20" />
            <path d="M 98 142 L 128 172 L 158 142" stroke-width="18" />
          </svg>
          <span>07. Linear Apex</span>
        </div>
      </div>
    </div>

    <!-- Section 4: Real-World Scale Check -->
    <div>
      <div class="section-header">
        <div class="section-title">Scale & Legibility Check</div>
        <div class="section-desc">16px 파비콘/타이틀바부터 128px 앱 아이콘까지 실제 크기 축소 가독성 테스트</div>
      </div>
      <div class="scale-strip">
        <div class="scale-item">
          <img src="./type-1-mx-ligature.svg" width="128" height="128" />
          <span>128px (App Tile)</span>
        </div>
        <div class="scale-item">
          <img src="./type-1-mx-ligature.svg" width="64" height="64" />
          <span>64px (Dock)</span>
        </div>
        <div class="scale-item">
          <img src="./type-1-mx-ligature.svg" width="48" height="48" />
          <span>48px (Taskbar)</span>
        </div>
        <div class="scale-item">
          <img src="./type-1-mx-ligature.svg" width="32" height="32" />
          <span>32px (Titlebar)</span>
        </div>
        <div class="scale-item">
          <img src="./type-1-mx-ligature.svg" width="24" height="24" />
          <span>24px (Tab Icon)</span>
        </div>
        <div class="scale-item">
          <img src="./type-1-mx-ligature.svg" width="16" height="16" />
          <span>16px (Favicon/CLI)</span>
        </div>
      </div>
    </div>
  </div>

  <script>
    const watermarks = {
      mx: \`<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <path d="M 64 176 V 104 C 64 86 78 74 96 74 C 114 74 126 88 126 106 V 176" stroke-width="20" />
              <path d="M 126 110 C 126 88 138 74 156 74 C 174 74 188 86 188 104 V 176" stroke-width="20" />
              <line x1="152" y1="122" x2="204" y2="176" stroke-width="20" />
            </svg>\`,
      md: \`<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <path d="M 72 176 V 84 L 108 132 L 128 100" stroke-width="22" />
              <path d="M 128 100 L 148 132 L 184 84 V 176" stroke-width="22" />
              <circle cx="128" cy="158" r="7" fill="currentColor" stroke="none" />
            </svg>\`,
      mprompt: \`<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <path d="M 64 176 V 108 C 64 88 78 76 96 76 C 114 76 126 88 126 108 V 176 M 126 108 C 126 88 138 76 156 76 C 174 76 188 88 188 108 V 176" stroke-width="20" />
              <rect x="180" y="166" width="16" height="16" rx="3" fill="currentColor" stroke="none" />
            </svg>\`,
      cross: \`<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <path d="M 64 176 V 98 L 104 74 L 128 98 L 152 74 L 192 98 V 176" stroke-width="20" />
              <path d="M 84 142 L 128 176 L 172 142" stroke-width="20" />
            </svg>\`,
      grotesk: \`<svg viewBox="0 0 256 256" fill="currentColor">
              <path d="M 60 180 V 80 H 88 L 128 138 L 168 80 H 196 V 180 H 170 V 118 L 136 168 H 120 L 86 118 V 180 Z" />
            </svg>\`,
      slash: \`<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <line x1="84" y1="178" x2="118" y2="78" stroke-width="20" />
              <line x1="124" y1="178" x2="158" y2="78" stroke-width="20" />
              <path d="M 118 78 C 138 78 150 91 150 110 V 178" stroke-width="20" />
              <line x1="168" y1="178" x2="190" y2="178" stroke-width="12" />
            </svg>\`,
      bracket: \`<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <path d="M 102 74 L 66 125 L 102 176" stroke-width="20" />
              <path d="M 154 74 L 190 125 L 154 176" stroke-width="20" />
              <path d="M 102 74 L 128 122 L 154 74" stroke-width="20" />
            </svg>\`,
      apex: \`<svg viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <path d="M 64 178 V 98 L 96 74 L 128 104 L 160 74 L 192 98 V 178" stroke-width="20" />
              <path d="M 98 142 L 128 172 L 158 142" stroke-width="18" />
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
console.log('preview.html updated with Modern Tech Typography Showcase successfully!');
