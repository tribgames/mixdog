import { writeFileSync } from 'node:fs';

const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mixdog - Benchmark Logos (Orca, Cursor, Codex, Paseo)</title>
  <style>
    :root {
      --bg: #07080b;
      --card-bg: #0e1017;
      --card-inner: #08090d;
      --border: rgba(255, 255, 255, 0.08);
      --border-hover: rgba(56, 189, 248, 0.45);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent-cyan: #38bdf8;
      --accent-emerald: #10b981;
      --accent-purple: #a855f7;
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
      padding: 56px 24px 96px;
    }

    header {
      text-align: center;
      max-width: 840px;
      margin-bottom: 56px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 14px;
      border-radius: 999px;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.25);
      color: var(--accent-cyan);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-bottom: 16px;
    }

    header h1 {
      font-size: 42px;
      font-weight: 800;
      letter-spacing: -0.035em;
      line-height: 1.15;
      background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 50%, #94a3b8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 16px;
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

    .ref-bar {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 32px;
      padding: 16px 28px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: 16px;
      font-size: 13px;
      color: var(--text-muted);
      flex-wrap: wrap;
    }

    .ref-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .ref-item strong {
      color: #ffffff;
      font-weight: 600;
    }

    .concepts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 24px;
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
      box-shadow: 0 24px 48px rgba(0, 0, 0, 0.7), 0 0 30px rgba(56, 189, 248, 0.15);
    }

    .concept-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .concept-tag {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 4px 10px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--accent-cyan);
    }

    .concept-tag.rec {
      background: rgba(56, 189, 248, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.3);
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
      filter: drop-shadow(0 14px 28px rgba(0, 0, 0, 0.6));
    }

    .info h3 {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 6px;
      color: #ffffff;
    }

    .info .bench {
      font-size: 12px;
      font-weight: 600;
      color: var(--accent-cyan);
      margin-bottom: 10px;
    }

    .info p {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.55;
    }

    /* Section Headers */
    .section-title {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .section-title span {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
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
      width: 46px;
      height: 46px;
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
      color: var(--accent-cyan);
    }

    .lockup-text .brand-sub {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    /* Monochrome Row */
    .mono-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 20px;
    }

    .mono-box {
      background: #000000;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 24px 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
    }

    .mono-box svg {
      width: 52px;
      height: 52px;
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
    <div class="badge">Next-Gen Coding Agent Benchmark</div>
    <h1>Mixdog Agent Logo System</h1>
    <p>글로벌 탑급 코딩 에이전트(<strong>Orca, Cursor, Codex, Paseo</strong>)의 핵심 디자인 문법과 기하학을 분석하여 재해석한 4대 심플 테크 로고</p>
  </header>

  <div class="container">
    <!-- Design Benchmark Reference Bar -->
    <div class="ref-bar">
      <div class="ref-item">🐋 <strong>Orca</strong>: 유선형 실루엣 & 네거티브 스페이스</div>
      <div class="ref-item">🧊 <strong>Cursor</strong>: 정밀 3D 아이소메트릭 각면 & 빛 굴절</div>
      <div class="ref-item">⚡ <strong>Codex</strong>: 회전 대칭 토폴로지 & 헥사곤 노드</div>
      <div class="ref-item">➰ <strong>Paseo</strong>: 유연한 연속 단일 폐곡선 리본</div>
    </div>

    <!-- 4 Main Concepts Grid -->
    <div class="concepts-grid">
      <!-- Concept 1: Orca Style -->
      <div class="concept-card">
        <div class="concept-header">
          <span class="concept-tag">01 • Orca Benchmark</span>
        </div>
        <div class="preview-container">
          <img src="./agent-ref-1-orca-streamline.svg" alt="Orca Streamline" />
        </div>
        <div class="info">
          <h3>Streamline Hound</h3>
          <div class="bench">Orca Style • Aerodynamic Silhouette</div>
          <p><strong>Orca의 유선형 디자인 철학</strong>. 범고래의 날렵한 지느러미 곡선처럼 매끄럽게 흐르는 M 하운드 실루엣과 중앙의 터미널 셰브론 네거티브 컷.</p>
        </div>
      </div>

      <!-- Concept 2: Cursor Style -->
      <div class="concept-card">
        <div class="concept-header">
          <span class="concept-tag rec">02 • Cursor Benchmark</span>
        </div>
        <div class="preview-container">
          <img src="./agent-ref-2-cursor-cube.svg" alt="Cursor Prism" />
        </div>
        <div class="info">
          <h3>Isometric Prism</h3>
          <div class="bench">Cursor Style • 3D Geometric Facets</div>
          <p><strong>Cursor의 3D Isometric 큐브 감성</strong>. 상단 귀를 형성하는 2개의 삼각 프리즘과 코드를 즉각 실행하는 전면 화살표 셰브론 각면의 완벽한 결합.</p>
        </div>
      </div>

      <!-- Concept 3: Codex Style -->
      <div class="concept-card">
        <div class="concept-header">
          <span class="concept-tag">03 • Codex Benchmark</span>
        </div>
        <div class="preview-container">
          <img src="./agent-ref-3-codex-vortex.svg" alt="Codex Vortex" />
        </div>
        <div class="info">
          <h3>Radial Code Vortex</h3>
          <div class="bench">OpenAI Codex • Symmetrical Topology</div>
          <p><strong>OpenAI Codex의 회전 대칭 토폴로지</strong>. 6개의 정밀 코드 블레이드가 맞물리며 중앙에 M 모노그램과 터미널 프롬프트를 형성하는 에이전트 마크.</p>
        </div>
      </div>

      <!-- Concept 4: Modern Dual-Slash (Copilot/Linear) -->
      <div class="concept-card">
        <div class="concept-header">
          <span class="concept-tag rec">04 • Modern Hybrid</span>
        </div>
        <div class="preview-container">
          <img src="./agent-ref-4-dual-slash.svg" alt="Dual Slash" />
        </div>
        <div class="info">
          <h3>Dual-Slash M</h3>
          <div class="bench">Linear / Copilot • 45° Chamfer Precision</div>
          <p><strong>개발자 코드 문법</strong>. 코드 주석 슬래시(//)와 터미널 실행 셰브론(&gt;)이 만나 강아지의 쫑긋한 귀를 완성하는 극도로 절제된 모던 미니멀리즘.</p>
        </div>
      </div>
    </div>

    <!-- Wordmark & Horizontal Lockup Preview -->
    <div>
      <div class="section-title">
        Horizontal Brand Lockups <span>웹사이트 헤더, 깃허브 README, 에디터 상단용 텍스트 조합</span>
      </div>
      <div class="lockup-grid">
        <div class="lockup-card">
          <img class="lockup-icon" src="./agent-ref-2-cursor-cube.svg" />
          <div class="lockup-text">
            <div class="brand-name">mixdog<span class="accent-dot">.</span></div>
            <div class="brand-sub">AI Coding Agent</div>
          </div>
        </div>
        <div class="lockup-card">
          <img class="lockup-icon" src="./agent-ref-4-dual-slash.svg" />
          <div class="lockup-text">
            <div class="brand-name">MIXDOG</div>
            <div class="brand-sub">Multi-Model Orchestrator</div>
          </div>
        </div>
        <div class="lockup-card">
          <img class="lockup-icon" src="./agent-ref-1-orca-streamline.svg" />
          <div class="lockup-text">
            <div class="brand-name">mixdog</div>
            <div class="brand-sub">Autonomous Workspace</div>
          </div>
        </div>
        <div class="lockup-card">
          <img class="lockup-icon" src="./agent-ref-3-codex-vortex.svg" />
          <div class="lockup-text">
            <div class="brand-name">&lt;mixdog/&gt;</div>
            <div class="brand-sub">Runtime Core</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Monochrome 1-Color Pure Glyphs -->
    <div>
      <div class="section-title">
        Monochrome 1-Color Glyphs <span>에디터 타이틀바, TUI, 단색 워터마크, 깃허브 README용 단색 마크</span>
      </div>
      <div class="mono-grid">
        <!-- 1. Orca mono -->
        <div class="mono-box">
          <svg viewBox="0 0 256 256" fill="#ffffff">
            <path d="M 64 176 C 64 116 78 72 104 72 C 120 72 126 92 130 110 C 134 92 140 72 156 72 C 182 72 196 116 196 176 C 174 176 168 132 154 110 C 144 95 137 130 130 148 C 123 130 116 95 106 110 C 92 132 86 176 64 176 Z"/>
            <path d="M 108 148 L 130 174 L 152 148" fill="none" stroke="#000000" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>01. Streamline (Orca)</span>
        </div>

        <!-- 2. Cursor mono -->
        <div class="mono-box">
          <svg viewBox="0 0 256 256" fill="none" stroke="#ffffff" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="64,174 64,104 89,74 89,144" fill="#334155" stroke="none" />
            <polygon points="89,74 122,104 89,118" fill="#ffffff" stroke="none" />
            <polygon points="192,174 192,104 167,74 167,144" fill="#334155" stroke="none" />
            <polygon points="167,74 134,104 167,118" fill="#ffffff" stroke="none" />
            <polygon points="95,146 128,132 161,146 128,182" fill="#ffffff" stroke="none" />
          </svg>
          <span>02. Isometric (Cursor)</span>
        </div>

        <!-- 3. Codex mono -->
        <div class="mono-box">
          <svg viewBox="0 0 256 256" fill="none" stroke="#ffffff" stroke-linecap="round" stroke-linejoin="round">
            <path d="M 70 172 L 70 108 L 102 76 L 128 102 L 102 128 L 90 128 L 90 172 Z" fill="#ffffff" stroke="none"/>
            <path d="M 186 172 L 186 108 L 154 76 L 128 102 L 154 128 L 166 128 L 166 172 Z" fill="#ffffff" stroke="none"/>
            <path d="M 98 140 L 128 170 L 158 140" stroke="#ffffff" stroke-width="16"/>
          </svg>
          <span>03. Vortex (Codex)</span>
        </div>

        <!-- 4. Dual Slash mono -->
        <div class="mono-box">
          <svg viewBox="0 0 256 256" fill="none" stroke="#ffffff" stroke-linecap="round" stroke-linejoin="round">
            <path d="M 74 174 L 74 106 L 108 72 L 128 92" stroke-width="20"/>
            <path d="M 182 174 L 182 106 L 148 72 L 128 92" stroke-width="20"/>
            <path d="M 97 140 L 128 171 L 159 140" stroke-width="18"/>
            <circle cx="128" cy="121" r="5" fill="#ffffff" stroke="none"/>
          </svg>
          <span>04. Dual-Slash (Hybrid)</span>
        </div>
      </div>
    </div>

    <!-- Scale & Legibility Test Strip -->
    <div>
      <div class="section-title">
        Scale & Legibility Check <span>Cursor / Dual-Slash 스타일의 16px부터 128px까지 실제 크기 테스트</span>
      </div>
      <div class="scale-strip">
        <div class="scale-item">
          <img src="./agent-ref-2-cursor-cube.svg" width="128" height="128" />
          <span>128px (App Tile)</span>
        </div>
        <div class="scale-item">
          <img src="./agent-ref-2-cursor-cube.svg" width="64" height="64" />
          <span>64px (Dock)</span>
        </div>
        <div class="scale-item">
          <img src="./agent-ref-2-cursor-cube.svg" width="48" height="48" />
          <span>48px (Taskbar)</span>
        </div>
        <div class="scale-item">
          <img src="./agent-ref-2-cursor-cube.svg" width="32" height="32" />
          <span>32px (Titlebar)</span>
        </div>
        <div class="scale-item">
          <img src="./agent-ref-2-cursor-cube.svg" width="24" height="24" />
          <span>24px (Tab Icon)</span>
        </div>
        <div class="scale-item">
          <img src="./agent-ref-2-cursor-cube.svg" width="16" height="16" />
          <span>16px (Favicon/CLI)</span>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
`;

writeFileSync("design/logo-concepts/preview.html", html, "utf8");
console.log("preview.html successfully generated!");
