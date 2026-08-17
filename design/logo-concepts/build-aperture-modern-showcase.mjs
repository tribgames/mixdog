import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chdir } from 'node:process';

chdir(fileURLToPath(new URL('../..', import.meta.url)));

const outDir = 'design/logo-concepts';

// ============================================================================
// Modern Aperture Triad Variations with Rich Symbolic Center Cores
// ============================================================================

const modernConcepts = [
  // --- CATEGORY 1: HOUND & CANINE SYMBOLIC CORES ---
  {
    id: 'mod-ap-01',
    file: 'modern-aperture-01-hound-snout-prompt.svg',
    title: 'Hound Snout & Prompt Cursor',
    category: 'Hound & Canine Core',
    tag: 'Hound Snout > + Dual Eyes',
    desc: '조리개 회전 아크 중심에 강아지 코와 주둥이이자 터미널 실행 셰브론(>)이 자리하고, 상단에 두 개의 미니멀 AI 눈 노드가 배치된 마크.',
    bg: '#08090d',
    colorFlow: 'Electric Cyan (#00f2fe) → Indigo (#6366f1) → Hot Rose (#f43f5e) → Cyan',
    defs: `
      <linearGradient id="m01-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#00f2fe"/><stop offset="100%" stop-color="#38bdf8"/>
      </linearGradient>
      <linearGradient id="m01-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#818cf8"/>
      </linearGradient>
      <linearGradient id="m01-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#818cf8"/><stop offset="100%" stop-color="#00f2fe"/>
      </linearGradient>
      <linearGradient id="m01-snout" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#cbd5e1"/>
      </linearGradient>
    `,
    arcs: `
      <g fill="none" stroke-width="24" stroke-linecap="round">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#m01-a)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#m01-b)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#m01-c)"/>
      </g>
    `,
    core: `
      <!-- Symbolic Hound Eyes -->
      <circle cx="116" cy="116" r="4.5" fill="#38bdf8"/>
      <circle cx="140" cy="116" r="4.5" fill="#38bdf8"/>
      <!-- Snout / Terminal Prompt Chevron -->
      <path d="M 115 128 L 128 141 L 141 128" fill="none" stroke="url(#m01-snout)" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="128" cy="130" r="3" fill="#00f2fe"/>
    `
  },
  {
    id: 'mod-ap-02',
    file: 'modern-aperture-02-minimal-paw-core.svg',
    title: 'Minimal Geometric Dog Paw',
    category: 'Hound & Canine Core',
    tag: 'Geometric Paw Pad Matrix',
    desc: '360° 심리스 바이올렛-마젠타 휠 중앙에 정밀 기하학으로 다듬은 강아지 발바닥(메인 패드 1개 + 토 패드 3개)이 음각/발광하는 심볼.',
    bg: '#0a0910',
    colorFlow: 'Violet (#8b5cf6) → Magenta (#ec4899) → Coral (#f43f5e) → Violet',
    defs: `
      <linearGradient id="m02-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#c084fc"/>
      </linearGradient>
      <linearGradient id="m02-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#c084fc"/><stop offset="100%" stop-color="#ec4899"/>
      </linearGradient>
      <linearGradient id="m02-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ec4899"/><stop offset="100%" stop-color="#8b5cf6"/>
      </linearGradient>
      <radialGradient id="m02-glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ec4899" stop-opacity="0.4"/>
        <stop offset="100%" stop-color="#0a0910" stop-opacity="0"/>
      </radialGradient>
    `,
    arcs: `
      <g fill="none" stroke-width="23" stroke-linecap="round">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#m02-a)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#m02-b)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#m02-c)"/>
      </g>
    `,
    core: `
      <circle cx="128" cy="128" r="28" fill="url(#m02-glow)"/>
      <!-- Main Palm Pad -->
      <path d="M 120 134 C 120 128 125 125 128 125 C 131 125 136 128 136 134 C 136 139 132 141 128 141 C 124 141 120 139 120 134 Z" fill="#ffffff"/>
      <!-- 3 Toe Pads matching the Triad Symmetry -->
      <circle cx="118" cy="120" r="3.2" fill="#ec4899"/>
      <circle cx="128" cy="116" r="3.6" fill="#ffffff"/>
      <circle cx="138" cy="120" r="3.2" fill="#c084fc"/>
    `
  },
  {
    id: 'mod-ap-03',
    file: 'modern-aperture-03-hound-face-mask.svg',
    title: 'Stealth Hound Face Mask',
    category: 'Hound & Canine Core',
    tag: 'Minimal Hound Profile & Ears',
    desc: '스페이스 블랙 모놀리스 위에 세공된 3개의 챔퍼 아크와 중앙의 정밀 하운드 실루엣 마스크.',
    bg: '#07080a',
    colorFlow: 'Platinum White (#ffffff) → Space Slate (#94a3b8) → Gunmetal (#475569) → White',
    defs: `
      <linearGradient id="m03-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#cbd5e1"/>
      </linearGradient>
      <linearGradient id="m03-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#cbd5e1"/><stop offset="100%" stop-color="#64748b"/>
      </linearGradient>
      <linearGradient id="m03-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#64748b"/><stop offset="100%" stop-color="#ffffff"/>
      </linearGradient>
    `,
    arcs: `
      <g fill="none" stroke-width="22" stroke-linecap="round">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#m03-a)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#m03-b)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#m03-c)"/>
      </g>
    `,
    core: `
      <!-- Canine Mask Polygon -->
      <polygon points="118,118 128,110 138,118 134,138 128,144 122,138" fill="#1e293b" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
      <circle cx="124" cy="122" r="2" fill="#38bdf8"/>
      <circle cx="132" cy="122" r="2" fill="#38bdf8"/>
      <polygon points="126,134 130,134 128,137" fill="#38bdf8"/>
    `
  },
  {
    id: 'mod-ap-04',
    file: 'modern-aperture-04-code-bone-glyph.svg',
    title: 'Code Syntax Bone Glyph',
    category: 'Hound & Canine Core',
    tag: 'Bone Slash // + Node Endpoints',
    desc: '코드 주석(//) 각도로 정밀 기울어진 모던 본(Bone) 글리프가 중앙에 배치된 개발자 감성 하운드 마크.',
    bg: '#080d12',
    colorFlow: 'Emerald (#10b981) → Cyan (#06b6d4) → Teal (#14b8a6) → Emerald',
    defs: `
      <linearGradient id="m04-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#10b981"/><stop offset="100%" stop-color="#06b6d4"/>
      </linearGradient>
      <linearGradient id="m04-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#06b6d4"/><stop offset="100%" stop-color="#14b8a6"/>
      </linearGradient>
      <linearGradient id="m04-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#14b8a6"/><stop offset="100%" stop-color="#10b981"/>
      </linearGradient>
    `,
    arcs: `
      <g fill="none" stroke-width="24" stroke-linecap="round">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#m04-a)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#m04-b)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#m04-c)"/>
      </g>
    `,
    core: `
      <!-- 45-degree Minimal Modern Bone -->
      <g transform="rotate(45 128 128)">
        <line x1="116" y1="128" x2="140" y2="128" stroke="#ffffff" stroke-width="5" stroke-linecap="round"/>
        <circle cx="116" cy="125" r="3.5" fill="#10b981"/>
        <circle cx="116" cy="131" r="3.5" fill="#10b981"/>
        <circle cx="140" cy="125" r="3.5" fill="#06b6d4"/>
        <circle cx="140" cy="131" r="3.5" fill="#06b6d4"/>
        <circle cx="128" cy="128" r="2.5" fill="#ffffff"/>
      </g>
    `
  },

  // --- CATEGORY 2: AI SPARK, STARBURST & INTELLIGENCE ---
  {
    id: 'mod-ap-05',
    file: 'modern-aperture-05-claude-starburst-spark.svg',
    title: 'Anthropic 4-Point AI Spark',
    category: 'AI Spark & Intelligence',
    tag: 'Claude ✦ Spark + Warm Terracotta',
    desc: 'Claude Code 감성의 웜 테라코타/샌드 골드 360° 루프와 중앙의 날렵한 4각 지능형 스타버스트(✦) 다이아몬드 코어.',
    bg: '#0f0e0c',
    colorFlow: 'Warm Terracotta (#ea580c) → Sun Gold (#f59e0b) → Coral (#f43f5e) → Terracotta',
    defs: `
      <linearGradient id="m05-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ea580c"/><stop offset="100%" stop-color="#f59e0b"/>
      </linearGradient>
      <linearGradient id="m05-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#f43f5e"/>
      </linearGradient>
      <linearGradient id="m05-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#ea580c"/>
      </linearGradient>
      <radialGradient id="m05-glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.6"/>
        <stop offset="100%" stop-color="#0f0e0c" stop-opacity="0"/>
      </radialGradient>
    `,
    arcs: `
      <g fill="none" stroke-width="23" stroke-linecap="round">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#m05-a)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#m05-b)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#m05-c)"/>
      </g>
    `,
    core: `
      <circle cx="128" cy="128" r="26" fill="url(#m05-glow)"/>
      <!-- Precision 4-Point AI Spark ✦ -->
      <path d="M 128 108 Q 128 128 148 128 Q 128 128 128 148 Q 128 128 108 128 Q 128 128 128 108 Z" fill="#ffffff"/>
      <circle cx="128" cy="128" r="3.5" fill="#ea580c"/>
    `
  },
  {
    id: 'mod-ap-06',
    file: 'modern-aperture-06-hex-crystalline-prism.svg',
    title: 'Hexagonal Crystalline Spark',
    category: 'AI Spark & Intelligence',
    tag: '6-Point Precision Gem Core',
    desc: '3개의 사이언-퍼플 광학 굴절 아크가 수렴하는 중심에 위치한 6각 크리스털 다이아몬드 프리즘 젬.',
    bg: '#090a12',
    colorFlow: 'Electric Cyan (#00f2fe) → Royal Violet (#7c3aed) → Deep Magenta (#c026d3) → Cyan',
    defs: `
      <linearGradient id="m06-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#00f2fe"/><stop offset="100%" stop-color="#7c3aed"/>
      </linearGradient>
      <linearGradient id="m06-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#7c3aed"/><stop offset="100%" stop-color="#c026d3"/>
      </linearGradient>
      <linearGradient id="m06-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#c026d3"/><stop offset="100%" stop-color="#00f2fe"/>
      </linearGradient>
    `,
    arcs: `
      <g fill="none" stroke-width="24" stroke-linecap="round">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#m06-a)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#m06-b)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#m06-c)"/>
      </g>
    `,
    core: `
      <!-- 6-Point Faceted Diamond Core -->
      <polygon points="128,110 137,117 143,128 137,139 128,146 119,139 113,128 119,117" fill="#1e1b4b" stroke="#ffffff" stroke-width="2.5"/>
      <polygon points="128,110 143,128 128,146 113,128" fill="#00f2fe" opacity="0.6"/>
      <line x1="128" y1="110" x2="128" y2="146" stroke="#ffffff" stroke-width="2"/>
      <line x1="113" y1="128" x2="143" y2="128" stroke="#ffffff" stroke-width="2"/>
      <circle cx="128" cy="128" r="4" fill="#ffffff"/>
    `
  },
  {
    id: 'mod-ap-07',
    file: 'modern-aperture-07-quantum-singularity-orbit.svg',
    title: 'Quantum Orbital Singularity',
    category: 'AI Spark & Intelligence',
    tag: 'Concentric Ring + Singularity Star',
    desc: 'OpenAI Operator 스타일의 곡률 아크 중앙에 2중 동심원 궤도와 싱귤래리티 화이트 스타가 위치한 디자인.',
    bg: '#08080a',
    colorFlow: 'Pure White (#ffffff) → Cyan Glow (#38bdf8) → Deep Space (#1e293b) → White',
    defs: `
      <linearGradient id="m07-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#38bdf8"/>
      </linearGradient>
      <linearGradient id="m07-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#6366f1"/>
      </linearGradient>
      <linearGradient id="m07-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#ffffff"/>
      </linearGradient>
    `,
    arcs: `
      <g fill="none" stroke-width="22" stroke-linecap="round">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#m07-a)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#m07-b)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#m07-c)"/>
      </g>
    `,
    core: `
      <circle cx="128" cy="128" r="22" fill="none" stroke="#38bdf8" stroke-width="2" stroke-dasharray="3 4" opacity="0.8"/>
      <circle cx="128" cy="128" r="14" fill="none" stroke="#ffffff" stroke-width="2.5"/>
      <circle cx="128" cy="128" r="6" fill="#38bdf8"/>
      <circle cx="128" cy="128" r="2.5" fill="#ffffff"/>
    `
  },

  // --- CATEGORY 3: TERMINAL, CODE & CLI SYNTAX ---
  {
    id: 'mod-ap-08',
    file: 'modern-aperture-08-terminal-prompt-chevron.svg',
    title: 'CLI Prompt >_ Cursor Terminal',
    category: 'Terminal & Code Syntax',
    tag: 'Prompt Chevron > + Underscore _',
    desc: '개발자의 터미널 프롬프트 기호(`>_`)가 조리개 중심에서 빛나며 즉각적인 코드 실행 준비 상태를 나타내는 심볼.',
    bg: '#090a0f',
    colorFlow: 'Electric Cyan (#00f2fe) → Sky Blue (#38bdf8) → Royal Blue (#2563eb) → Cyan',
    defs: `
      <linearGradient id="m08-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#00f2fe"/><stop offset="100%" stop-color="#38bdf8"/>
      </linearGradient>
      <linearGradient id="m08-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#2563eb"/>
      </linearGradient>
      <linearGradient id="m08-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#2563eb"/><stop offset="100%" stop-color="#00f2fe"/>
      </linearGradient>
    `,
    arcs: `
      <g fill="none" stroke-width="24" stroke-linecap="round">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#m08-a)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#m08-b)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#m08-c)"/>
      </g>
    `,
    core: `
      <!-- Terminal Prompt Chevron > -->
      <path d="M 116 118 L 126 128 L 116 138" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      <!-- Cursor Underscore _ -->
      <line x1="131" y1="138" x2="142" y2="138" stroke="#00f2fe" stroke-width="4.5" stroke-linecap="round"/>
    `
  },
  {
    id: 'mod-ap-09',
    file: 'modern-aperture-09-code-brackets-core.svg',
    title: 'Code Brackets { • } Core',
    category: 'Terminal & Code Syntax',
    tag: '{ Core } Code Block Architecture',
    desc: '프로그래밍 코드 블록 브래킷(`{ }`) 사이에 인텔리전트 AI 싱귤래리티 노드가 깃든 모던 개발자 아키텍처.',
    bg: '#090b10',
    colorFlow: 'Lime Neon (#84cc16) → Emerald (#10b981) → Teal (#06b6d4) → Lime',
    defs: `
      <linearGradient id="m09-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#84cc16"/><stop offset="100%" stop-color="#10b981"/>
      </linearGradient>
      <linearGradient id="m09-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#10b981"/><stop offset="100%" stop-color="#06b6d4"/>
      </linearGradient>
      <linearGradient id="m09-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#06b6d4"/><stop offset="100%" stop-color="#84cc16"/>
      </linearGradient>
    `,
    arcs: `
      <g fill="none" stroke-width="23" stroke-linecap="round">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#m09-a)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#m09-b)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#m09-c)"/>
      </g>
    `,
    core: `
      <!-- Left Curly Bracket { -->
      <path d="M 118 116 C 114 116 114 122 110 124 C 114 126 114 132 118 132 C 118 136 118 140 114 140" fill="none" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round"/>
      <!-- Right Curly Bracket } -->
      <path d="M 138 116 C 142 116 142 122 146 124 C 142 126 142 132 138 132 C 138 136 138 140 142 140" fill="none" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round"/>
      <!-- Center AI Logic Core -->
      <circle cx="128" cy="128" r="5" fill="#84cc16"/>
      <circle cx="128" cy="128" r="2" fill="#ffffff"/>
    `
  },
  {
    id: 'mod-ap-10',
    file: 'modern-aperture-10-cursor-dart-execution.svg',
    title: 'Cursor Prism Execution Dart',
    category: 'Terminal & Code Syntax',
    tag: 'Cursor Diamond Dart Core',
    desc: 'Cursor 감성의 3D 다이아몬드 실행 화살표 셰브론이 중심에서 정밀 조준되는 고속 코드 생성 심볼.',
    bg: '#07090e',
    colorFlow: 'Electric Cyan (#38bdf8) → Indigo Blue (#6366f1) → Violet (#a855f7) → Cyan',
    defs: `
      <linearGradient id="m10-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#6366f1"/>
      </linearGradient>
      <linearGradient id="m10-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#a855f7"/>
      </linearGradient>
      <linearGradient id="m10-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#a855f7"/><stop offset="100%" stop-color="#38bdf8"/>
      </linearGradient>
    `,
    arcs: `
      <g fill="none" stroke-width="24" stroke-linecap="round">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#m10-a)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#m10-b)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#m10-c)"/>
      </g>
    `,
    core: `
      <!-- 3D Isometric Execution Diamond Dart -->
      <polygon points="128,110 144,124 128,146 112,124" fill="#0f172a" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
      <!-- Left Facet -->
      <polygon points="128,110 112,124 128,146" fill="#38bdf8" opacity="0.85"/>
      <!-- Right Facet -->
      <polygon points="128,110 144,124 128,146" fill="#6366f1" opacity="0.85"/>
      <!-- Seam Specular Line -->
      <line x1="128" y1="110" x2="128" y2="146" stroke="#ffffff" stroke-width="2"/>
      <circle cx="128" cy="128" r="3.5" fill="#ffffff"/>
    `
  },

  // --- CATEGORY 4: MULTI-MODEL NEXUS & SYNERGY ---
  {
    id: 'mod-ap-11',
    file: 'modern-aperture-11-tri-model-nexus-delta.svg',
    title: '3-Way Multi-Model Nexus Delta',
    category: 'Multi-Model Nexus & Synergy',
    tag: 'Triquetra 3-Model Fusion Delta',
    desc: '3개의 AI 모델(Claude, OpenAI, Gemini)이 교차하여 중앙에서 완전한 지능 합성을 이루는 역삼각 넥서스 코어.',
    bg: '#08080c',
    colorFlow: 'Rose Magenta (#f43f5e) → Royal Purple (#9333ea) → Cyan (#06b6d4) → Rose',
    defs: `
      <linearGradient id="m11-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#9333ea"/>
      </linearGradient>
      <linearGradient id="m11-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#9333ea"/><stop offset="100%" stop-color="#06b6d4"/>
      </linearGradient>
      <linearGradient id="m11-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#06b6d4"/><stop offset="100%" stop-color="#f43f5e"/>
      </linearGradient>
    `,
    arcs: `
      <g fill="none" stroke-width="24" stroke-linecap="round">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#m11-a)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#m11-b)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#m11-c)"/>
      </g>
    `,
    core: `
      <!-- 3-Way Tri-Color Interlocking Delta Ring -->
      <polygon points="128,112 144,140 112,140" fill="none" stroke="#ffffff" stroke-width="3" stroke-linejoin="round"/>
      <circle cx="128" cy="112" r="4.5" fill="#f43f5e"/>
      <circle cx="144" cy="140" r="4.5" fill="#9333ea"/>
      <circle cx="112" cy="140" r="4.5" fill="#06b6d4"/>
      <circle cx="128" cy="131" r="5" fill="#ffffff"/>
    `
  },
  {
    id: 'mod-ap-12',
    file: 'modern-aperture-12-silicon-die-chip.svg',
    title: 'Silicon IC Die Microchip',
    category: 'Multi-Model Nexus & Synergy',
    tag: 'Hardware IC Die + Bus Traces',
    desc: 'Groq/Apple Silicon 스타일의 정밀 IC 반도체 칩 다이와 골드 버스 트레이스가 중앙에 세공된 하드웨어 런타임 심볼.',
    bg: '#0a0a0d',
    colorFlow: 'Champagne Gold (#fbbf24) → Bronze Amber (#f59e0b) → Platinum (#e2e8f0) → Gold',
    defs: `
      <linearGradient id="m12-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#fbbf24"/><stop offset="100%" stop-color="#f59e0b"/>
      </linearGradient>
      <linearGradient id="m12-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#e2e8f0"/>
      </linearGradient>
      <linearGradient id="m12-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#e2e8f0"/><stop offset="100%" stop-color="#fbbf24"/>
      </linearGradient>
    `,
    arcs: `
      <g fill="none" stroke-width="23" stroke-linecap="round">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#m12-a)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#m12-b)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#m12-c)"/>
      </g>
    `,
    core: `
      <!-- IC Silicon Chip Body -->
      <rect x="115" y="115" width="26" height="26" rx="5" fill="#18181b" stroke="#fbbf24" stroke-width="2.5"/>
      <!-- Microchip Pins -->
      <line x1="121" y1="111" x2="121" y2="115" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"/>
      <line x1="128" y1="111" x2="128" y2="115" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"/>
      <line x1="135" y1="111" x2="135" y2="115" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"/>
      <line x1="121" y1="141" x2="121" y2="145" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"/>
      <line x1="128" y1="141" x2="128" y2="145" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"/>
      <line x1="135" y1="141" x2="135" y2="145" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"/>
      <!-- Silicon Core Die -->
      <circle cx="128" cy="128" r="4.5" fill="#ffffff"/>
    `
  },

  // --- CATEGORY 5: MODERN CHIEFLY MINIMAL & GEOMETRIC ARCHITECTURES ---
  {
    id: 'mod-ap-13',
    file: 'modern-aperture-13-aerofoil-tapered-fin.svg',
    title: 'Aerofoil Tapered Fin Flow',
    category: 'Modern Minimal & Aerodynamics',
    tag: 'Tapered Fin 36px → 12px',
    desc: '점점 날렵하게 좁아지는 테이퍼드 에어로포일 지느러미 형태의 모던 조리개 아크와 중앙의 초정밀 원형 렌즈.',
    bg: '#07080b',
    colorFlow: 'Electric Cyan (#00f2fe) → Sky Blue (#38bdf8) → Royal Violet (#6366f1) → Cyan',
    defs: `
      <linearGradient id="m13-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#00f2fe"/><stop offset="100%" stop-color="#38bdf8"/>
      </linearGradient>
      <linearGradient id="m13-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#6366f1"/>
      </linearGradient>
      <linearGradient id="m13-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#00f2fe"/>
      </linearGradient>
    `,
    arcs: `
      <!-- Tapered Aerofoil Fin Blades (3 Rotations) -->
      <g>
        <path d="M 116 58 C 145 58 178 78 194 104 C 182 108 160 92 136 82 C 122 76 116 68 116 58 Z" fill="url(#m13-a)"/>
        <path d="M 116 58 C 145 58 178 78 194 104 C 182 108 160 92 136 82 C 122 76 116 68 116 58 Z" transform="rotate(120 128 128)" fill="url(#m13-b)"/>
        <path d="M 116 58 C 145 58 178 78 194 104 C 182 108 160 92 136 82 C 122 76 116 68 116 58 Z" transform="rotate(240 128 128)" fill="url(#m13-c)"/>
      </g>
    `,
    core: `
      <circle cx="128" cy="128" r="14" fill="none" stroke="#ffffff" stroke-width="2.5"/>
      <circle cx="128" cy="128" r="6" fill="#00f2fe"/>
      <circle cx="128" cy="128" r="2.5" fill="#ffffff"/>
    `
  },
  {
    id: 'mod-ap-14',
    file: 'modern-aperture-14-apple-siri-glass-aurora.svg',
    title: 'Apple Intelligence Fluid Aurora',
    category: 'Modern Minimal & Aerodynamics',
    tag: 'Pastel Fluid Aurora + Refraction Lens',
    desc: '부드러운 파스텔 핑크/바이올렛/시안 오로라 광원이 매끄럽게 회전하는 최신 애플 인텔리전스 감성의 글래스모피즘 엠블럼.',
    bg: '#0c0d14',
    colorFlow: 'Soft Pink (#f472b6) → Lavender (#c084fc) → Sky Cyan (#38bdf8) → Amber (#fcd34d) → Pink',
    defs: `
      <linearGradient id="m14-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#f472b6"/><stop offset="100%" stop-color="#c084fc"/>
      </linearGradient>
      <linearGradient id="m14-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#c084fc"/><stop offset="100%" stop-color="#38bdf8"/>
      </linearGradient>
      <linearGradient id="m14-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#f472b6"/>
      </linearGradient>
      <radialGradient id="m14-glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#c084fc" stop-opacity="0.6"/>
        <stop offset="100%" stop-color="#0c0d14" stop-opacity="0"/>
      </radialGradient>
    `,
    arcs: `
      <g fill="none" stroke-width="26" stroke-linecap="round">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#m14-a)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#m14-b)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#m14-c)"/>
      </g>
    `,
    core: `
      <circle cx="128" cy="128" r="28" fill="url(#m14-glow)"/>
      <circle cx="128" cy="128" r="11" fill="#ffffff" opacity="0.9"/>
      <!-- Soft Pastel Quad Spark inside -->
      <path d="M 128 120 Q 128 128 136 128 Q 128 128 128 136 Q 128 128 120 128 Q 128 128 128 120 Z" fill="#c084fc"/>
    `
  },
  {
    id: 'mod-ap-15',
    file: 'modern-aperture-15-cnc-chamfer-titanium.svg',
    title: 'Teenage Eng. CNC Chamfer Hardware',
    category: 'Modern Minimal & Aerodynamics',
    tag: '45° CNC Chamfer + Crosshair LED',
    desc: '45도 CNC 챔퍼 가공된 스페이스 그레이 티타늄 바디와 중앙의 앰버 레이저 크로스헤어 타깃 LED.',
    bg: '#121316',
    colorFlow: 'Machined Titanium (#e2e8f0) → Industrial Slate (#64748b) → Dark Metal (#334155) → Titanium',
    defs: `
      <linearGradient id="m15-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#94a3b8"/>
      </linearGradient>
      <linearGradient id="m15-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#94a3b8"/><stop offset="100%" stop-color="#475569"/>
      </linearGradient>
      <linearGradient id="m15-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#475569"/><stop offset="100%" stop-color="#ffffff"/>
      </linearGradient>
    `,
    arcs: `
      <g fill="none" stroke-width="22" stroke-linecap="square">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#m15-a)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#m15-b)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#m15-c)"/>
      </g>
    `,
    core: `
      <!-- Precision Target Reticle & Amber Laser LED -->
      <circle cx="128" cy="128" r="16" fill="#1e293b" stroke="#64748b" stroke-width="2"/>
      <line x1="128" y1="108" x2="128" y2="148" stroke="#fbbf24" stroke-width="1.5"/>
      <line x1="108" y1="128" x2="148" y2="128" stroke="#fbbf24" stroke-width="1.5"/>
      <circle cx="128" cy="128" r="5" fill="#f59e0b"/>
      <circle cx="128" cy="128" r="2" fill="#ffffff"/>
    `
  },
  {
    id: 'mod-ap-16',
    file: 'modern-aperture-16-linear-hairline-wireframe.svg',
    title: 'Linear Technical Precision Wireframe',
    category: 'Modern Minimal & Aerodynamics',
    tag: '14px Precision Wireframe + Center Ring',
    desc: 'Linear / Swiss Grid 스타일의 정교한 14px 얇은 헤어라인 아크와 이중 동심원 도넛 보이드 코어.',
    bg: '#08080a',
    colorFlow: 'Laser Blue (#38bdf8) → Deep Indigo (#6366f1) → Pure White (#ffffff) → Laser Blue',
    defs: `
      <linearGradient id="m16-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#6366f1"/>
      </linearGradient>
      <linearGradient id="m16-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#ffffff"/>
      </linearGradient>
      <linearGradient id="m16-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#38bdf8"/>
      </linearGradient>
    `,
    arcs: `
      <g fill="none" stroke-width="14" stroke-linecap="round">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#m16-a)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#m16-b)"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#m16-c)"/>
      </g>
    `,
    core: `
      <circle cx="128" cy="128" r="16" fill="none" stroke="#38bdf8" stroke-width="2" stroke-dasharray="2 3"/>
      <circle cx="128" cy="128" r="9" fill="none" stroke="#ffffff" stroke-width="3"/>
      <circle cx="128" cy="128" r="3" fill="#38bdf8"/>
    `
  }
];

// Write individual SVGs
for (const item of modernConcepts) {
  const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    ${item.defs}
  </defs>
  <rect width="256" height="256" rx="60" fill="${item.bg}"/>
  ${item.arcs}
  ${item.core}
</svg>`;

  writeFileSync(`${outDir}/${item.file}`, svgContent, 'utf8');
}

console.log(`Generated ${modernConcepts.length} Modern Aperture Triad SVGs with Symbolic Cores!`);

// Generate Modern Showcase HTML
const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mixdog Modern Aperture Triad & Symbolic Core System</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #060709;
      --bg-surface: #0c0e14;
      --bg-card: #11141d;
      --bg-card-hover: #171b26;
      --border: rgba(255, 255, 255, 0.08);
      --border-accent: rgba(56, 189, 248, 0.45);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --cyan: #38bdf8;
      --indigo: #818cf8;
      --violet: #c084fc;
      --rose: #f43f5e;
      --emerald: #10b981;
      --amber: #fbbf24;
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
      overflow-x: hidden;
      line-height: 1.5;
    }

    .bg-grid {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background-image: 
        radial-gradient(circle at 50% 0%, rgba(56, 189, 248, 0.15) 0%, transparent 60%),
        radial-gradient(circle at 85% 20%, rgba(192, 132, 252, 0.1) 0%, transparent 50%),
        radial-gradient(circle at 15% 40%, rgba(244, 63, 94, 0.08) 0%, transparent 45%);
      pointer-events: none;
      z-index: 0;
    }

    .container {
      position: relative;
      z-index: 1;
      max-width: 1440px;
      margin: 0 auto;
      padding: 48px 32px 120px;
    }

    header {
      text-align: center;
      margin-bottom: 48px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 18px;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.3);
      border-radius: 999px;
      color: var(--cyan);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 16px;
      box-shadow: 0 0 20px rgba(56, 189, 248, 0.2);
    }

    h1 {
      font-size: 44px;
      font-weight: 800;
      letter-spacing: -0.03em;
      margin-bottom: 14px;
      background: linear-gradient(135deg, #ffffff 30%, #cbd5e1 70%, #94a3b8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .subtitle {
      font-size: 16px;
      color: var(--text-muted);
      max-width: 820px;
      margin: 0 auto;
      line-height: 1.6;
    }

    /* Multi-Scale Interactive Test Stage */
    .stage-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      padding: 32px;
      margin-bottom: 48px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.5);
    }

    .stage-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 16px;
    }

    .stage-title {
      font-size: 18px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .stage-scale-strip {
      display: flex;
      align-items: center;
      justify-content: space-around;
      background: #07080c;
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: var(--radius-lg);
      padding: 24px 16px;
      flex-wrap: wrap;
      gap: 20px;
    }

    .scale-box {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }

    .scale-box img {
      border-radius: 20%;
      box-shadow: 0 10px 24px rgba(0,0,0,0.6);
      transition: transform 0.2s;
    }

    .scale-box img:hover {
      transform: scale(1.15);
    }

    .scale-label {
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-dim);
    }

    /* Grid Layout */
    .category-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 48px 0 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }

    .category-title h2 {
      font-size: 20px;
      font-weight: 700;
      color: #ffffff;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 24px;
      margin-bottom: 32px;
    }

    .mod-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 24px;
      display: flex;
      flex-direction: column;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      cursor: pointer;
      position: relative;
    }

    .mod-card:hover {
      transform: translateY(-5px);
      border-color: var(--border-accent);
      background: var(--bg-card-hover);
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.6), 0 0 24px rgba(56, 189, 248, 0.15);
    }

    .card-img-wrap {
      background: #08090d;
      border-radius: var(--radius-md);
      border: 1px solid rgba(255, 255, 255, 0.04);
      height: 200px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 18px;
      position: relative;
    }

    .card-img-wrap img {
      width: 130px;
      height: 130px;
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .mod-card:hover .card-img-wrap img {
      transform: scale(1.08);
    }

    .card-header-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }

    .card-tag {
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      padding: 3px 8px;
      border-radius: 4px;
      background: rgba(56, 189, 248, 0.1);
      color: var(--cyan);
      border: 1px solid rgba(56, 189, 248, 0.2);
    }

    .mod-card h3 {
      font-size: 17px;
      font-weight: 700;
      color: #ffffff;
      margin-bottom: 6px;
    }

    .mod-card .flow-text {
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      color: var(--indigo);
      margin-bottom: 10px;
    }

    .mod-card p {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
      margin-bottom: 16px;
      flex-grow: 1;
    }

    .card-actions {
      display: flex;
      gap: 8px;
      margin-top: auto;
      padding-top: 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }

    .btn {
      flex: 1;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }

    .btn-primary {
      background: rgba(56, 189, 248, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.3);
      color: var(--cyan);
    }

    .btn-primary:hover {
      background: var(--cyan);
      color: #040810;
      font-weight: 700;
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--text-muted);
      text-decoration: none;
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.12);
      color: #ffffff;
    }
  </style>
</head>
<body>
  <div class="bg-grid"></div>

  <div class="container">
    <header>
      <div class="badge">✨ 2026 Modern Aperture Triad & Symbolic Core System</div>
      <h1>Mixdog Modern Aperture & Symbolic Icons</h1>
      <p class="subtitle">
        131번 Aperture Triad의 기하학적 120° 360도 연속 회전 루프를 모던 미니멀리즘으로 재해석하고,<br>
        중앙에 <strong>하운드 페이스/스나우트(>), ✦ AI 스타버스트, 터미널 프롬프트(>_), 3-Way 멀티모델 델타</strong> 등 의미 있는 독창적 심볼을 결합했습니다.
      </p>
    </header>

    <!-- Interactive Multi-Scale Test Stage -->
    <div class="stage-card">
      <div class="stage-header">
        <div class="stage-title">
          <span>🔬 실시간 멀티 스케일 시인성 뷰어</span>
          <span id="active-title" style="font-size: 14px; color: var(--cyan); font-weight: 600;">(Hound Snout & Prompt Cursor)</span>
        </div>
        <span style="font-size: 12px; color: var(--text-dim);">아래 카드를 클릭하면 즉시 모든 스케일에서 실시간 테스트됩니다.</span>
      </div>

      <div class="stage-scale-strip">
        <div class="scale-box">
          <img id="stage-128" src="./modern-aperture-01-hound-snout-prompt.svg" style="width: 128px; height: 128px;" />
          <span class="scale-label">128px (App Tile)</span>
        </div>
        <div class="scale-box">
          <img id="stage-64" src="./modern-aperture-01-hound-snout-prompt.svg" style="width: 64px; height: 64px;" />
          <span class="scale-label">64px (Dock)</span>
        </div>
        <div class="scale-box">
          <img id="stage-48" src="./modern-aperture-01-hound-snout-prompt.svg" style="width: 48px; height: 48px;" />
          <span class="scale-label">48px (Taskbar)</span>
        </div>
        <div class="scale-box">
          <img id="stage-32" src="./modern-aperture-01-hound-snout-prompt.svg" style="width: 32px; height: 32px;" />
          <span class="scale-label">32px (Toolbar)</span>
        </div>
        <div class="scale-box">
          <img id="stage-24" src="./modern-aperture-01-hound-snout-prompt.svg" style="width: 24px; height: 24px;" />
          <span class="scale-label">24px (Editor Tab)</span>
        </div>
        <div class="scale-box">
          <img id="stage-16" src="./modern-aperture-01-hound-snout-prompt.svg" style="width: 16px; height: 16px;" />
          <span class="scale-label">16px (Favicon/CLI)</span>
        </div>
      </div>
    </div>

    <!-- Category 1: Hound & Canine Symbolic Cores -->
    <div class="category-title">
      <h2>🐶 1. Hound & Canine Symbolic Cores (강아지/하운드 심볼화 코어)</h2>
      <span style="font-size: 13px; color: var(--text-muted);">강아지 코/주둥이(>), 기하학 발바닥, 본(Bone) 슬래시, 하운드 마스크</span>
    </div>
    <div class="cards-grid">
      ${modernConcepts.filter(c => c.category === 'Hound & Canine Core').map(c => renderCard(c)).join('')}
    </div>

    <!-- Category 2: AI Spark, Starburst & Intelligence -->
    <div class="category-title">
      <h2>✦ 2. AI Spark & Starburst Intelligence (AI 지능 스파크 & 프리즘 코어)</h2>
      <span style="font-size: 13px; color: var(--text-muted);">Claude ✦ 4각 스타버스트, 6각 크리스털 다이아몬드, 퀀텀 싱귤래리티 오빗</span>
    </div>
    <div class="cards-grid">
      ${modernConcepts.filter(c => c.category === 'AI Spark & Intelligence').map(c => renderCard(c)).join('')}
    </div>

    <!-- Category 3: Terminal, Code & CLI Syntax -->
    <div class="category-title">
      <h2>💻 3. Terminal, Code & CLI Syntax (개발자 터미널 & 코드 문법 코어)</h2>
      <span style="font-size: 13px; color: var(--text-muted);">CLI 프롬프트 >_, 코드 브래킷 { • }, Cursor 실행 다이아몬드 다트</span>
    </div>
    <div class="cards-grid">
      ${modernConcepts.filter(c => c.category === 'Terminal & Code Syntax').map(c => renderCard(c)).join('')}
    </div>

    <!-- Category 4: Multi-Model Nexus & Synergy -->
    <div class="category-title">
      <h2>🔀 4. Multi-Model Nexus & Synergy (멀티모델 넥서스 & 실리콘 IC 칩)</h2>
      <span style="font-size: 13px; color: var(--text-muted);">3-Way 모델 융합 델타, 하드웨어 실리콘 IC 칩 다이 & 골드 버스 트레이스</span>
    </div>
    <div class="cards-grid">
      ${modernConcepts.filter(c => c.category === 'Multi-Model Nexus & Synergy').map(c => renderCard(c)).join('')}
    </div>

    <!-- Category 5: Modern Minimal & Aerodynamics -->
    <div class="category-title">
      <h2>🚀 5. Modern Minimal & Aerodynamics (테이퍼드 에어로포일 & 티타늄 CNC)</h2>
      <span style="font-size: 13px; color: var(--text-muted);">테이퍼드 지느러미 플로우, Apple 인텔리전스 오로라, 45° CNC 챔퍼, Linear 와이어프레임</span>
    </div>
    <div class="cards-grid">
      ${modernConcepts.filter(c => c.category === 'Modern Minimal & Aerodynamics').map(c => renderCard(c)).join('')}
    </div>
  </div>

  <script>
    function selectLogo(file, title) {
      document.getElementById('active-title').innerText = '(' + title + ')';
      ['128', '64', '48', '32', '24', '16'].forEach(size => {
        document.getElementById('stage-' + size).src = './' + file;
      });
    }

    async function copySvg(file, event) {
      if (event) event.stopPropagation();
      try {
        const res = await fetch('./' + file);
        const text = await res.text();
        await navigator.clipboard.writeText(text);
        alert('SVG 소스코드가 클립보드에 복사되었습니다: ' + file);
      } catch (err) {
        alert('복사 실패: ' + err.message);
      }
    }
  </script>
</body>
</html>
`;

function renderCard(c) {
  return `
    <div class="mod-card" onclick="selectLogo('${c.file}', '${c.title}')">
      <div class="card-header-top">
        <span class="card-tag">${c.tag}</span>
      </div>
      <div class="card-img-wrap">
        <img src="./${c.file}" alt="${c.title}" />
      </div>
      <h3>${c.title}</h3>
      <div class="flow-text">// ${c.colorFlow}</div>
      <p>${c.desc}</p>
      <div class="card-actions">
        <button class="btn btn-primary" onclick="copySvg('${c.file}', event)">📋 SVG 복사</button>
        <a class="btn btn-secondary" href="./${c.file}" download onclick="event.stopPropagation()">⬇️ 다운로드</a>
      </div>
    </div>
  `;
}

writeFileSync('design/logo-concepts/aperture-modern-showcase.html', html, 'utf8');
console.log('✅ Generated aperture-modern-showcase.html successfully!');
