import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';

chdir(fileURLToPath(new URL('../..', import.meta.url)));
const outDir = 'design/logo-concepts';

// Helper to generate 3 standard 120-degree rotated aperture arcs
function makeArcs(stroke1, stroke2, stroke3, width = 22, cap = 'round', dash = '', customD = 'M116.2 61A68 68 0 0 1 191.9 104.7') {
  return `
    <g fill="none" stroke-width="${width}" stroke-linecap="${cap}" ${dash ? `stroke-dasharray="${dash}"` : ''}>
      <path d="${customD}" stroke="${stroke1}"/>
      <path d="${customD}" transform="rotate(120 128 128)" stroke="${stroke2}"/>
      <path d="${customD}" transform="rotate(240 128 128)" stroke="${stroke3}"/>
    </g>
  `;
}

// 100 Distinct, Modern, Iconic Variations
const icons = [];

// ============================================================================
// Category 1: Canine & Hound Hybrid Cores (01 - 15)
// ============================================================================
icons.push(
  {
    num: 1, id: 'ap100-001', title: 'Hound Snout & Prompt Cursor', category: 'canine', catLabel: '🐶 Canine & Hound',
    tag: 'Hound Snout / Terminal >', desc: '강아지 코와 터미널 프롬프트 셰브론(>)이 일체화된 믹스독 시그니처 코어',
    bg: '#0a0b10', rx: 60,
    defs: `<linearGradient id="g01-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#00f2fe"/><stop offset="100%" stop-color="#38bdf8"/></linearGradient>
           <linearGradient id="g01-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#6366f1"/></linearGradient>
           <linearGradient id="g01-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#00f2fe"/></linearGradient>`,
    body: makeArcs('url(#g01-1)', 'url(#g01-2)', 'url(#g01-3)', 22),
    core: `<circle cx="118" cy="116" r="3.5" fill="#ffffff" opacity="0.9"/><circle cx="138" cy="116" r="3.5" fill="#ffffff" opacity="0.9"/>
           <path d="M120 128 L128 136 L136 128" fill="none" stroke="#00f2fe" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
           <circle cx="128" cy="126" r="3.5" fill="#ffffff"/>`
  },
  {
    num: 2, id: 'ap100-002', title: 'Geometric Minimal Paw', category: 'canine', catLabel: '🐶 Canine & Hound',
    tag: 'Paw Print / 4-Pad Geometry', desc: '바이올렛-마젠타 휠 중앙에 정밀 기하학 강아지 발바닥 패드 4개 배치',
    bg: '#0c0a14', rx: 60,
    defs: `<linearGradient id="g02-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#c084fc"/><stop offset="100%" stop-color="#f43f5e"/></linearGradient>
           <linearGradient id="g02-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#fb923c"/></linearGradient>
           <linearGradient id="g02-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fb923c"/><stop offset="100%" stop-color="#c084fc"/></linearGradient>`,
    body: makeArcs('url(#g02-1)', 'url(#g02-2)', 'url(#g02-3)', 22),
    core: `<ellipse cx="128" cy="133" rx="8" ry="6.5" fill="#f43f5e"/>
           <circle cx="118" cy="121" r="3" fill="#ffffff"/><circle cx="128" cy="117" r="3" fill="#ffffff"/><circle cx="138" cy="121" r="3" fill="#ffffff"/>`
  },
  {
    num: 3, id: 'ap100-003', title: 'Code Syntax Bone Glyph', category: 'canine', catLabel: '🐶 Canine & Hound',
    tag: 'Bone Glyph / 45° Slash', desc: '개발자 주석(//) 각도인 45도로 기울어진 미니멀 본(Bone) 심볼 코어',
    bg: '#080d14', rx: 60,
    defs: `<linearGradient id="g03-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#818cf8"/></linearGradient>
           <linearGradient id="g03-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#818cf8"/><stop offset="100%" stop-color="#34d399"/></linearGradient>
           <linearGradient id="g03-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#34d399"/><stop offset="100%" stop-color="#38bdf8"/></linearGradient>`,
    body: makeArcs('url(#g03-1)', 'url(#g03-2)', 'url(#g03-3)', 22),
    core: `<g transform="rotate(-35 128 128)">
             <line x1="117" y1="128" x2="139" y2="128" stroke="#ffffff" stroke-width="4.5" stroke-linecap="round"/>
             <circle cx="116" cy="125" r="3" fill="#38bdf8"/><circle cx="116" cy="131" r="3" fill="#38bdf8"/>
             <circle cx="140" cy="125" r="3" fill="#38bdf8"/><circle cx="140" cy="131" r="3" fill="#38bdf8"/>
           </g>`
  },
  {
    num: 4, id: 'ap100-004', title: 'Perky Hound Ears Triad', category: 'canine', catLabel: '🐶 Canine & Hound',
    tag: 'Hound Ears / Top Accent', desc: '상단 2개 아크가 쫑긋 솟은 귀가 되고 하단 아크가 턱선을 형성하는 조형',
    bg: '#090a0f', rx: 60,
    defs: `<linearGradient id="g04-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#38bdf8"/></linearGradient>
           <linearGradient id="g04-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#818cf8"/></linearGradient>
           <linearGradient id="g04-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#818cf8"/></linearGradient>`,
    body: makeArcs('url(#g04-1)', 'url(#g04-2)', 'url(#g04-3)', 24),
    core: `<polygon points="128,118 135,128 121,128" fill="#38bdf8"/><circle cx="128" cy="133" r="3.5" fill="#ffffff"/>`
  },
  {
    num: 5, id: 'ap100-005', title: 'Stealth Hound Face Mask', category: 'canine', catLabel: '🐶 Canine & Hound',
    tag: 'Hound Mask / Faceted Face', desc: '중앙에 각면 처리된 스텔스 하운드 페이스 마스크와 레이저 아이',
    bg: '#0b0c10', rx: 60,
    defs: `<linearGradient id="g05" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#475569"/><stop offset="100%" stop-color="#0f172a"/></linearGradient>`,
    body: makeArcs('#94a3b8', '#cbd5e1', '#64748b', 20),
    core: `<polygon points="120,120 128,114 136,120 133,134 128,138 123,134" fill="#0f172a" stroke="#38bdf8" stroke-width="2"/>
           <circle cx="125" cy="124" r="1.5" fill="#38bdf8"/><circle cx="131" cy="124" r="1.5" fill="#38bdf8"/>`
  },
  {
    num: 6, id: 'ap100-006', title: 'Collar Bell & Singularity Tag', category: 'canine', catLabel: '🐶 Canine & Hound',
    tag: 'Collar Tag / Diamond Core', desc: '하운드의 스마트 목줄 펜던트를 상징하는 다이아몬드 스마트 태그',
    bg: '#0a0d14', rx: 60,
    defs: `<linearGradient id="g06-tag" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fbbf24"/><stop offset="100%" stop-color="#d97706"/></linearGradient>`,
    body: makeArcs('#38bdf8', '#0284c7', '#0369a1', 22),
    core: `<rect x="122" y="122" width="12" height="12" rx="3" transform="rotate(45 128 128)" fill="url(#g06-tag)"/>
           <circle cx="128" cy="128" r="2.5" fill="#ffffff"/>`
  },
  {
    num: 7, id: 'ap100-007', title: 'Neon Cyber Paw Glow', category: 'canine', catLabel: '🐶 Canine & Hound',
    tag: 'Cyber Paw / Glowing Cyan', desc: '사이언-블루 네온 발광 효과가 적용된 일렉트릭 사이버 댕댕이 발바닥',
    bg: '#05070c', rx: 60,
    defs: `<filter id="f07-glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
    body: makeArcs('#00f2fe', '#3b82f6', '#8b5cf6', 22),
    core: `<g filter="url(#f07-glow)">
             <path d="M123 131 C123 127 133 127 133 131 C133 135 123 135 123 131 Z" fill="#00f2fe"/>
             <circle cx="120" cy="123" r="2" fill="#ffffff"/><circle cx="128" cy="120" r="2" fill="#ffffff"/><circle cx="136" cy="123" r="2" fill="#ffffff"/>
           </g>`
  },
  {
    num: 8, id: 'ap100-008', title: 'Curled Sleeping Hound Loop', category: 'canine', catLabel: '🐶 Canine & Hound',
    tag: 'Curled Hound / Sleep Loop', desc: '몸을 동그랗게 말고 자는 하운드의 유연한 곡선을 형상화한 유기적 루프',
    bg: '#0f0e17', rx: 60,
    defs: `<linearGradient id="g08" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fb7185"/><stop offset="50%" stop-color="#c084fc"/><stop offset="100%" stop-color="#38bdf8"/></linearGradient>`,
    body: makeArcs('url(#g08)', 'url(#g08)', 'url(#g08)', 22),
    core: `<circle cx="128" cy="128" r="10" fill="none" stroke="#fb7185" stroke-width="2.5" stroke-dasharray="14 6"/>
           <circle cx="128" cy="128" r="4" fill="#ffffff"/>`
  },
  {
    num: 9, id: 'ap100-009', title: 'Terminal Whiskers Snout', category: 'canine', catLabel: '🐶 Canine & Hound',
    tag: 'Whiskers / CLI Slashes', desc: '하운드의 양쪽 수염이 CLI 주석(//) 및 화살표로 뻗어나가는 위트 있는 심볼',
    bg: '#0a0b10', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#818cf8', '#a855f7', 22),
    core: `<line x1="114" y1="126" x2="122" y2="128" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/>
           <line x1="114" y1="130" x2="122" y2="129" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/>
           <line x1="142" y1="126" x2="134" y2="128" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/>
           <line x1="142" y1="130" x2="134" y2="129" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/>
           <circle cx="128" cy="128" r="4.5" fill="#ffffff"/>`
  },
  {
    num: 10, id: 'ap100-010', title: 'Howling Hound Apex Triad', category: 'canine', catLabel: '🐶 Canine & Hound',
    tag: 'Howling Hound / Apex', desc: '밤하늘을 향해 포효하는 하운드의 고고한 실루엣을 정점에 배치',
    bg: '#090a14', rx: 60,
    defs: ``,
    body: makeArcs('#6366f1', '#a855f7', '#ec4899', 22),
    core: `<polygon points="128,116 134,130 128,126 122,130" fill="#ffffff"/><circle cx="128" cy="133" r="2.5" fill="#ec4899"/>`
  },
  {
    num: 11, id: 'ap100-011', title: 'Hound Tail Orbit Flick', category: 'canine', catLabel: '🐶 Canine & Hound',
    tag: 'Tail Orbit / Kinetic Arc', desc: '경쾌하게 흔들리는 꼬리의 궤적을 3번 아크의 역동적 스윕으로 강조',
    bg: '#0d1117', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#38bdf8', '#f59e0b', 24),
    core: `<circle cx="128" cy="128" r="8" fill="#0f172a" stroke="#f59e0b" stroke-width="3"/><circle cx="128" cy="128" r="3" fill="#ffffff"/>`
  },
  {
    num: 12, id: 'ap100-012', title: 'Smart Hound Bone Lockup', category: 'canine', catLabel: '🐶 Canine & Hound',
    tag: 'Smart Bone / Tech Badge', desc: '중앙의 둥근 골격을 양쪽 아크가 감싸 보호하는 안정적 모노그램',
    bg: '#080a0f', rx: 60,
    defs: ``,
    body: makeArcs('#10b981', '#06b6d4', '#3b82f6', 22),
    core: `<rect x="120" y="125" width="16" height="6" rx="3" fill="#ffffff"/>
           <circle cx="119" cy="128" r="4" fill="#10b981"/><circle cx="137" cy="128" r="4" fill="#06b6d4"/>`
  },
  {
    num: 13, id: 'ap100-013', title: 'Cyber Eye Shutter Iris', category: 'canine', catLabel: '🐶 Canine & Hound',
    tag: 'Cyber Eye / Aperture Iris', desc: '하운드의 총명한 눈동자와 카메라 조리개 렌즈의 완벽한 융합',
    bg: '#06070a', rx: 60,
    defs: `<radialGradient id="g13-eye"><stop offset="0%" stop-color="#00f2fe"/><stop offset="70%" stop-color="#0284c7"/><stop offset="100%" stop-color="#000000"/></radialGradient>`,
    body: makeArcs('#0ea5e9', '#6366f1', '#a855f7', 22),
    core: `<circle cx="128" cy="128" r="11" fill="url(#g13-eye)"/>
           <circle cx="128" cy="128" r="4" fill="#000000"/><circle cx="126" cy="126" r="2" fill="#ffffff"/>`
  },
  {
    num: 14, id: 'ap100-014', title: 'Hound Nose Leather Texture', category: 'canine', catLabel: '🐶 Canine & Hound',
    tag: 'Nose Pad / Tactile Dot', desc: '촉촉한 강아지 코 패드의 정밀 도트 질감을 미세 기하학으로 표현',
    bg: '#0d0e12', rx: 60,
    defs: ``,
    body: makeArcs('#94a3b8', '#cbd5e1', '#e2e8f0', 22),
    core: `<path d="M120 124 C120 120 136 120 136 124 C136 132 128 136 128 136 C128 136 120 132 120 124 Z" fill="#38bdf8"/>
           <circle cx="124" cy="125" r="1" fill="#ffffff"/><circle cx="128" cy="125" r="1" fill="#ffffff"/><circle cx="132" cy="125" r="1" fill="#ffffff"/>`
  },
  {
    num: 15, id: 'ap100-015', title: 'Petroglyph Cyber Hound Rune', category: 'canine', catLabel: '🐶 Canine & Hound',
    tag: 'Ancient Rune / Cyber Mascot', desc: '고대 암각화와 미래 사이버네틱 문법이 결합된 하운드 글리프 마크',
    bg: '#120f0d', rx: 60,
    defs: ``,
    body: makeArcs('#f97316', '#fb923c', '#fdba74', 22),
    core: `<path d="M122 122 L128 116 L134 122 L134 134 L122 134 Z" fill="none" stroke="#ffffff" stroke-width="2.5"/>
           <circle cx="128" cy="127" r="2.5" fill="#f97316"/>`
  }
);

// ============================================================================
// Category 2: AI Intelligence & Starburst Cores (16 - 30)
// ============================================================================
icons.push(
  {
    num: 16, id: 'ap100-016', title: 'Anthropic 4-Point AI Spark', category: 'spark', catLabel: '✦ AI Intelligence Spark',
    tag: 'Claude Spark / 4-Point Star', desc: 'Claude 감성의 4방향 다이아몬드 지능 스파크(✦) 코어',
    bg: '#140e0c', rx: 60,
    defs: `<linearGradient id="g16" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f97316"/><stop offset="50%" stop-color="#fb923c"/><stop offset="100%" stop-color="#fed7aa"/></linearGradient>`,
    body: makeArcs('#ea580c', '#f97316', '#fbbf24', 22),
    core: `<path d="M128 112 Q128 128 112 128 Q128 128 128 144 Q128 128 144 128 Q128 128 128 112 Z" fill="#ffffff"/>
           <circle cx="128" cy="128" r="2" fill="#ea580c"/>`
  },
  {
    num: 17, id: 'ap100-017', title: '6-Point Crystalline Star', category: 'spark', catLabel: '✦ AI Intelligence Spark',
    tag: '6-Point Star / Prism Gem', desc: '정밀 60도 육방 대칭의 크리스털 지능 별빛 코어',
    bg: '#080c14', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#818cf8', '#c084fc', 22),
    core: `<polygon points="128,114 131,125 142,128 131,131 128,142 125,131 114,128 125,125" fill="#38bdf8"/>
           <polygon points="128,118 130,126 138,128 130,130 128,138 126,130 118,128 126,126" fill="#ffffff"/>`
  },
  {
    num: 18, id: 'ap100-018', title: 'Supernova 8-Point Ignition', category: 'spark', catLabel: '✦ AI Intelligence Spark',
    tag: '8-Point Supernova / Flash', desc: '초신성 폭발처럼 전 방향으로 지능을 방출하는 8각 스타버스트',
    bg: '#090a0f', rx: 60,
    defs: ``,
    body: makeArcs('#00f2fe', '#f43f5e', '#fbbf24', 22),
    core: `<path d="M128 110 Q128 128 110 128 Q128 128 128 146 Q128 128 146 128 Q128 128 128 110 Z" fill="#ffffff"/>
           <path d="M128 116 Q128 128 116 128 Q128 128 128 140 Q128 128 140 128 Q128 128 128 116 Z" transform="rotate(45 128 128)" fill="#00f2fe"/>`
  },
  {
    num: 19, id: 'ap100-019', title: 'Quantum Singularity Halo', category: 'spark', catLabel: '✦ AI Intelligence Spark',
    tag: 'Singularity / Double Halo', desc: '블랙홀 중앙의 순수한 에너지 응집점과 2중 방사형 헤일로',
    bg: '#050508', rx: 60,
    defs: `<radialGradient id="g19-glow"><stop offset="0%" stop-color="#ffffff"/><stop offset="50%" stop-color="#818cf8"/><stop offset="100%" stop-color="#050508" stop-opacity="0"/></radialGradient>`,
    body: makeArcs('#6366f1', '#818cf8', '#c7d2fe', 22),
    core: `<circle cx="128" cy="128" r="18" fill="url(#g19-glow)"/><circle cx="128" cy="128" r="8" fill="#ffffff"/><circle cx="128" cy="128" r="3" fill="#6366f1"/>`
  },
  {
    num: 20, id: 'ap100-020', title: 'Faceted Diamond Prism Core', category: 'spark', catLabel: '✦ AI Intelligence Spark',
    tag: 'Diamond Gem / Refraction', desc: '정밀 세공된 45도 다이아몬드 보석 각면과 내부 굴절광',
    bg: '#0a0d14', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#0ea5e9', '#0284c7', 22),
    core: `<polygon points="128,116 140,128 128,140 116,128" fill="#0284c7"/>
           <polygon points="128,116 140,128 128,128" fill="#38bdf8"/>
           <polygon points="128,116 128,128 116,128" fill="#ffffff"/>
           <polygon points="128,128 140,128 128,140" fill="#0369a1"/>`
  },
  {
    num: 21, id: 'ap100-021', title: 'Triple Synaptic Neural Node', category: 'spark', catLabel: '✦ AI Intelligence Spark',
    tag: 'Synaptic Nodes / 3-Way Graph', desc: '3개 아크와 정확히 대응하는 3개의 신경망 시냅스 노드 결합체',
    bg: '#0a0a10', rx: 60,
    defs: ``,
    body: makeArcs('#a855f7', '#ec4899', '#f43f5e', 22),
    core: `<circle cx="128" cy="120" r="4" fill="#ffffff"/><circle cx="121" cy="132" r="4" fill="#ffffff"/><circle cx="135" cy="132" r="4" fill="#ffffff"/>
           <line x1="128" y1="120" x2="121" y2="132" stroke="#ec4899" stroke-width="2"/>
           <line x1="121" y1="132" x2="135" y2="132" stroke="#ec4899" stroke-width="2"/>
           <line x1="135" y1="132" x2="128" y2="120" stroke="#ec4899" stroke-width="2"/>`
  },
  {
    num: 22, id: 'ap100-022', title: 'Laser Diode Precision Dot', category: 'spark', catLabel: '✦ AI Intelligence Spark',
    tag: 'Laser Diode / Sub-Pixel Point', desc: '광통신 레이저 다이오드의 초정밀 핀포인트 발광 코어',
    bg: '#05090f', rx: 60,
    defs: ``,
    body: makeArcs('#00f2fe', '#38bdf8', '#0284c7', 24),
    core: `<circle cx="128" cy="128" r="9" fill="none" stroke="#00f2fe" stroke-width="2"/>
           <circle cx="128" cy="128" r="3.5" fill="#ffffff"/>`
  },
  {
    num: 23, id: 'ap100-023', title: 'Solar Flare Amber Ignition', category: 'spark', catLabel: '✦ AI Intelligence Spark',
    tag: 'Solar Flare / Warm Plasma', desc: '태양 흑점과 플레어의 에너지가 폭발하는 웜 골드 스파크',
    bg: '#140c06', rx: 60,
    defs: ``,
    body: makeArcs('#f59e0b', '#d97706', '#b45309', 22),
    core: `<circle cx="128" cy="128" r="8" fill="#f59e0b"/><circle cx="128" cy="128" r="5" fill="#fde68a"/><circle cx="128" cy="128" r="2" fill="#ffffff"/>`
  },
  {
    num: 24, id: 'ap100-024', title: 'Floating Crystal Shard Cluster', category: 'spark', catLabel: '✦ AI Intelligence Spark',
    tag: 'Crystal Shards / 3D Cluster', desc: '공중에 부유하는 3개의 크리스털 파편이 중심에서 모이는 형상',
    bg: '#0a0d14', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#60a5fa', '#93c5fd', 22),
    core: `<polygon points="128,118 132,126 124,126" fill="#ffffff"/>
           <polygon points="137,133 129,131 133,124" fill="#38bdf8"/>
           <polygon points="119,133 123,124 127,131" fill="#93c5fd"/>`
  },
  {
    num: 25, id: 'ap100-025', title: 'Bioluminescent Abyss Pearl', category: 'spark', catLabel: '✦ AI Intelligence Spark',
    tag: 'Bio Pearl / Aqua Glow', desc: '심해 생물 발광의 은은하고 깊이 있는 청록색 펄 코어',
    bg: '#040d12', rx: 60,
    defs: ``,
    body: makeArcs('#10b981', '#14b8a6', '#06b6d4', 22),
    core: `<circle cx="128" cy="128" r="9" fill="#06b6d4"/><circle cx="128" cy="128" r="6" fill="#a7f3d0"/><circle cx="126" cy="126" r="2.5" fill="#ffffff"/>`
  },
  {
    num: 26, id: 'ap100-026', title: '4D Hypercube Tesseract Apex', category: 'spark', catLabel: '✦ AI Intelligence Spark',
    tag: 'Hypercube / Tesseract', desc: '4차원 초입방체의 투영면이 중앙에 기하학적으로 배치된 미래형 코어',
    bg: '#090a10', rx: 60,
    defs: ``,
    body: makeArcs('#818cf8', '#c084fc', '#f472b6', 22),
    core: `<rect x="122" y="122" width="12" height="12" fill="none" stroke="#ffffff" stroke-width="1.8"/>
           <rect x="125" y="125" width="6" height="6" fill="#818cf8"/>`
  },
  {
    num: 27, id: 'ap100-027', title: 'Infinite Flared Cross Star', category: 'spark', catLabel: '✦ AI Intelligence Spark',
    tag: 'Flared Cross / Starlight', desc: '네 모서리가 부드러운 곡선으로 뻗어나가는 십자 성광 심볼',
    bg: '#0a0a0f', rx: 60,
    defs: ``,
    body: makeArcs('#f43f5e', '#fb7185', '#fda4af', 22),
    core: `<path d="M128 116 C128 124 124 128 116 128 C124 128 128 132 128 140 C128 132 132 128 140 128 C132 128 128 124 128 116 Z" fill="#ffffff"/>`
  },
  {
    num: 28, id: 'ap100-028', title: 'Holographic Radiance Disk', category: 'spark', catLabel: '✦ AI Intelligence Spark',
    tag: 'Holo Disk / Radial Ring', desc: '홀로그램 굴절 링이 다층 레이어로 중첩된 광학 코어',
    bg: '#080a12', rx: 60,
    defs: ``,
    body: makeArcs('#00f2fe', '#818cf8', '#c084fc', 22),
    core: `<circle cx="128" cy="128" r="10" fill="none" stroke="#00f2fe" stroke-width="1.5" stroke-dasharray="3 3"/>
           <circle cx="128" cy="128" r="6" fill="#818cf8"/><circle cx="128" cy="128" r="2" fill="#ffffff"/>`
  },
  {
    num: 29, id: 'ap100-029', title: 'Synthetic Camera Shutter Gem', category: 'spark', catLabel: '✦ AI Intelligence Spark',
    tag: 'Camera Shutter / Iris Core', desc: '조리개 날개들이 닫히며 만들어내는 완벽한 삼각형 오프닝',
    bg: '#0a0d14', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#0284c7', '#0369a1', 22),
    core: `<polygon points="128,121 134,131 122,131" fill="#38bdf8"/><circle cx="128" cy="128" r="2" fill="#ffffff"/>`
  },
  {
    num: 30, id: 'ap100-030', title: 'Amber Pulsar Orbit Node', category: 'spark', catLabel: '✦ AI Intelligence Spark',
    tag: 'Pulsar Node / Amber Orbit', desc: '주기적으로 빛을 뿜는 펄사의 궤도상 전자 노드',
    bg: '#140e06', rx: 60,
    defs: ``,
    body: makeArcs('#f59e0b', '#fbbf24', '#fde68a', 22),
    core: `<circle cx="128" cy="128" r="7" fill="none" stroke="#fbbf24" stroke-width="2"/>
           <circle cx="134" cy="124" r="2.5" fill="#ffffff"/>`
  }
);

// ============================================================================
// Category 3: Developer Syntax & Terminal CLI Cores (31 - 45)
// ============================================================================
icons.push(
  {
    num: 31, id: 'ap100-031', title: 'CLI Prompt >_ Terminal Execution', category: 'terminal', catLabel: '💻 Terminal & CLI Syntax',
    tag: 'Terminal >_ / Shell', desc: '개발자의 심장인 터미널 프롬프트 셰브론(>)과 언더스코어 커서(_)',
    bg: '#090a0f', rx: 60,
    defs: ``,
    body: makeArcs('#00f2fe', '#38bdf8', '#818cf8', 22),
    core: `<path d="M121 123 L126 128 L121 133" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
           <line x1="129" y1="133" x2="135" y2="133" stroke="#00f2fe" stroke-width="3" stroke-linecap="round"/>`
  },
  {
    num: 32, id: 'ap100-032', title: 'Curly Code Brackets { • }', category: 'terminal', catLabel: '💻 Terminal & CLI Syntax',
    tag: 'Code Brackets / Function Body', desc: '함수와 블록을 정의하는 중괄호 { } 사이에 위치한 AI 코어',
    bg: '#0a0d14', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#818cf8', '#c084fc', 22),
    core: `<path d="M120 120 C117 120 117 124 117 125 C117 126 115 128 114 128 C115 128 117 130 117 131 C117 132 117 136 120 136" fill="none" stroke="#38bdf8" stroke-width="2.2" stroke-linecap="round"/>
           <path d="M136 120 C139 120 139 124 139 125 C139 126 141 128 142 128 C141 128 139 130 139 131 C139 132 139 136 136 136" fill="none" stroke="#38bdf8" stroke-width="2.2" stroke-linecap="round"/>
           <circle cx="128" cy="128" r="3" fill="#ffffff"/>`
  },
  {
    num: 33, id: 'ap100-033', title: 'Angle Syntax Tag < / >', category: 'terminal', catLabel: '💻 Terminal & CLI Syntax',
    tag: 'Angle Tag / JSX Syntax', desc: '웹과 XML, 컴포넌트를 선언하는 앵글 브래킷 슬래시 태그',
    bg: '#0c0a14', rx: 60,
    defs: ``,
    body: makeArcs('#f43f5e', '#a855f7', '#38bdf8', 22),
    core: `<path d="M119 124 L115 128 L119 132" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/>
           <line x1="126" y1="134" x2="130" y2="122" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/>
           <path d="M137 124 L141 128 L137 132" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/>`
  },
  {
    num: 34, id: 'ap100-034', title: 'Terminal Block Cursor █', category: 'terminal', catLabel: '💻 Terminal & CLI Syntax',
    tag: 'Block Cursor / Solid █', desc: '깜빡이는 직사각형 솔리드 블록 터미널 커서',
    bg: '#050907', rx: 60,
    defs: ``,
    body: makeArcs('#22c55e', '#10b981', '#06b6d4', 22),
    core: `<rect x="123" y="121" width="10" height="14" rx="2" fill="#22c55e"/><rect x="125" y="123" width="6" height="10" rx="1" fill="#ffffff"/>`
  },
  {
    num: 35, id: 'ap100-035', title: 'Comment Syntax Dual Slash //', category: 'terminal', catLabel: '💻 Terminal & CLI Syntax',
    tag: 'Comment // / 45° Syntax', desc: '코드에 설명을 더하는 직관적인 듀얼 슬래시 주석 기호',
    bg: '#0a0d14', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#6366f1', '#0ea5e9', 22),
    core: `<line x1="121" y1="135" x2="127" y2="121" stroke="#38bdf8" stroke-width="3" stroke-linecap="round"/>
           <line x1="129" y1="135" x2="135" y2="121" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>`
  },
  {
    num: 36, id: 'ap100-036', title: 'Unix Shebang #!/ Node', category: 'terminal', catLabel: '💻 Terminal & CLI Syntax',
    tag: 'Shebang #! / Shell Script', desc: '스크립트 런타임을 지정하는 루트 셔뱅 기호',
    bg: '#0f0e0a', rx: 60,
    defs: ``,
    body: makeArcs('#f59e0b', '#fbbf24', '#fde68a', 22),
    core: `<text x="128" y="133" font-family="monospace" font-size="14" font-weight="bold" fill="#fbbf24" text-anchor="middle">#!</text>`
  },
  {
    num: 37, id: 'ap100-037', title: 'Git Commit Node Tree', category: 'terminal', catLabel: '💻 Terminal & CLI Syntax',
    tag: 'Git Commit / Version Graph', desc: '버전 관리 시스템의 메인 브랜치 커밋 노드 토폴로지',
    bg: '#080a12', rx: 60,
    defs: ``,
    body: makeArcs('#6366f1', '#38bdf8', '#a855f7', 22),
    core: `<circle cx="128" cy="128" r="6" fill="#6366f1" stroke="#ffffff" stroke-width="2.5"/>
           <line x1="128" y1="116" x2="128" y2="122" stroke="#6366f1" stroke-width="2.5" stroke-linecap="round"/>
           <line x1="128" y1="134" x2="128" y2="140" stroke="#6366f1" stroke-width="2.5" stroke-linecap="round"/>`
  },
  {
    num: 38, id: 'ap100-038', title: '3-Way Git Fork & Merge', category: 'terminal', catLabel: '💻 Terminal & CLI Syntax',
    tag: 'Git Merge / 3-Way Fork', desc: '3개 피처 브랜치가 하나의 릴리스 커밋으로 머지되는 형상',
    bg: '#080d14', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#10b981', '#6366f1', 22),
    core: `<circle cx="128" cy="133" r="4" fill="#38bdf8"/><circle cx="122" cy="123" r="3" fill="#10b981"/><circle cx="134" cy="123" r="3" fill="#6366f1"/>
           <path d="M122 123 Q125 129 128 133" fill="none" stroke="#ffffff" stroke-width="1.8"/>
           <path d="M134 123 Q131 129 128 133" fill="none" stroke="#ffffff" stroke-width="1.8"/>`
  },
  {
    num: 39, id: 'ap100-039', title: 'Ghostty CRT Phosphor Scanline', category: 'terminal', catLabel: '💻 Terminal & CLI Syntax',
    tag: 'CRT Green / Matrix Scanline', desc: 'Ghostty 감성의 하드웨어 가속 인광체 그린 스캔라인 글리프',
    bg: '#030805', rx: 60,
    defs: ``,
    body: makeArcs('#22c55e', '#16a34a', '#15803d', 22),
    core: `<line x1="118" y1="123" x2="138" y2="123" stroke="#22c55e" stroke-width="2"/>
           <line x1="120" y1="128" x2="136" y2="128" stroke="#ffffff" stroke-width="2.5"/>
           <line x1="118" y1="133" x2="138" y2="133" stroke="#22c55e" stroke-width="2"/>`
  },
  {
    num: 40, id: 'ap100-040', title: 'Hex Memory Pointer 0x7F', category: 'terminal', catLabel: '💻 Terminal & CLI Syntax',
    tag: 'Hex Pointer / Memory Address', desc: '시스템 로우레벨 메모리 주소 포인터를 상징하는 헥스 룬',
    bg: '#0a0d14', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#818cf8', '#0284c7', 22),
    core: `<text x="128" y="132" font-family="monospace" font-size="10" font-weight="bold" fill="#38bdf8" text-anchor="middle">0x</text>
           <circle cx="128" cy="128" r="9" fill="none" stroke="#38bdf8" stroke-width="1.5"/>`
  },
  {
    num: 41, id: 'ap100-041', title: 'Code Diff Patch + / -', category: 'terminal', catLabel: '💻 Terminal & CLI Syntax',
    tag: 'Git Diff / Patch Execution', desc: '코드 변경 내역을 나타내는 플러스(+)와 마이너스(-) 기호',
    bg: '#0a0d0a', rx: 60,
    defs: ``,
    body: makeArcs('#10b981', '#ef4444', '#38bdf8', 22),
    core: `<line x1="121" y1="125" x2="127" y2="125" stroke="#10b981" stroke-width="2.5" stroke-linecap="round"/>
           <line x1="124" y1="122" x2="124" y2="128" stroke="#10b981" stroke-width="2.5" stroke-linecap="round"/>
           <line x1="129" y1="131" x2="135" y2="131" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"/>`
  },
  {
    num: 42, id: 'ap100-042', title: 'Unix Pipe Stream | Conduit', category: 'terminal', catLabel: '💻 Terminal & CLI Syntax',
    tag: 'Unix Pipe | / Data Stream', desc: '명령어 출력을 다음 프로세스로 연결하는 유닉스 파이프라인',
    bg: '#07090f', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#00f2fe', '#60a5fa', 22),
    core: `<line x1="128" y1="116" x2="128" y2="140" stroke="#00f2fe" stroke-width="4" stroke-linecap="round"/>
           <circle cx="128" cy="128" r="2" fill="#ffffff"/>`
  },
  {
    num: 43, id: 'ap100-043', title: 'Functional Lambda Calc λ', category: 'terminal', catLabel: '💻 Terminal & CLI Syntax',
    tag: 'Lambda λ / Functional Core', desc: '순수 함수형 프로그래밍과 고계 계산을 뜻하는 람다 심볼',
    bg: '#100a14', rx: 60,
    defs: ``,
    body: makeArcs('#c084fc', '#e879f9', '#a855f7', 22),
    core: `<path d="M123 120 L131 136 M131 120 L123 136" fill="none" stroke="none"/>
           <path d="M132 120 L124 136 M127 127 L133 136" fill="none" stroke="#ffffff" stroke-width="2.8" stroke-linecap="round"/>`
  },
  {
    num: 44, id: 'ap100-044', title: 'Regex Wildcard Pattern .*', category: 'terminal', catLabel: '💻 Terminal & CLI Syntax',
    tag: 'Regex .* / Pattern Matcher', desc: '모든 문자열 패턴을 매칭하는 정규표현식 와일드카드',
    bg: '#090b10', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#f59e0b', '#10b981', 22),
    core: `<circle cx="123" cy="130" r="2.5" fill="#38bdf8"/>
           <path d="M133 122 L133 128 M130 125 L136 125 M131 123 L135 127 M135 123 L131 127" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>`
  },
  {
    num: 45, id: 'ap100-045', title: 'Square Container Brackets [ ]', category: 'terminal', catLabel: '💻 Terminal & CLI Syntax',
    tag: 'Array [ ] / Memory Container', desc: '배열과 인덱스, 튜플을 선언하는 정밀 대괄호 컨테이너',
    bg: '#090a0f', rx: 60,
    defs: ``,
    body: makeArcs('#64748b', '#94a3b8', '#cbd5e1', 22),
    core: `<path d="M122 121 H118 V135 H122" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/>
           <path d="M134 121 H138 V135 H134" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round"/>
           <rect x="125" y="125" width="6" height="6" rx="1.5" fill="#ffffff"/>`
  }
);

// ============================================================================
// Category 4: Multi-Model Orchestration & Nexus (46 - 55)
// ============================================================================
icons.push(
  {
    num: 46, id: 'ap100-046', title: '3-Way Multi-Model Delta Nexus', category: 'nexus', catLabel: '🔀 Multi-Model Nexus',
    tag: 'Delta Nexus / 3 Models', desc: 'Claude, OpenAI, Gemini 3대 모델이 맞물려 완전한 지능 합성을 이루는 역삼각 델타',
    bg: '#08090e', rx: 60,
    defs: ``,
    body: makeArcs('#f97316', '#10b981', '#38bdf8', 22),
    core: `<polygon points="128,136 136,122 120,122" fill="#ffffff"/><circle cx="128" cy="128" r="3" fill="#08090e"/>`
  },
  {
    num: 47, id: 'ap100-047', title: 'Converging Particle Streams', category: 'nexus', catLabel: '🔀 Multi-Model Nexus',
    tag: 'Particle Vortex / Convergence', desc: '3개의 병렬 에이전트 스트림이 중심점으로 수렴하는 동적 토폴로지',
    bg: '#060a12', rx: 60,
    defs: ``,
    body: makeArcs('#00f2fe', '#38bdf8', '#818cf8', 22),
    core: `<circle cx="128" cy="128" r="5" fill="#ffffff"/>
           <circle cx="128" cy="120" r="1.5" fill="#00f2fe"/><circle cx="121" cy="132" r="1.5" fill="#38bdf8"/><circle cx="135" cy="132" r="1.5" fill="#818cf8"/>`
  },
  {
    num: 48, id: 'ap100-048', title: 'Semiconductor Silicon IC Die', category: 'nexus', catLabel: '🔀 Multi-Model Nexus',
    tag: 'Silicon IC / Chip Architecture', desc: '반도체 집적회로 칩 다이와 골드 버스 트레이스의 하드웨어 가속',
    bg: '#0b0c10', rx: 60,
    defs: ``,
    body: makeArcs('#fbbf24', '#f59e0b', '#d97706', 22),
    core: `<rect x="122" y="122" width="12" height="12" rx="2" fill="#0f172a" stroke="#fbbf24" stroke-width="2"/>
           <circle cx="128" cy="128" r="2.5" fill="#ffffff"/>`
  },
  {
    num: 49, id: 'ap100-049', title: '3-Channel Audio Mixer Fader', category: 'nexus', catLabel: '🔀 Multi-Model Nexus',
    tag: 'Mixer Fader / Blend Sliders', desc: '여러 모델의 가중치를 믹싱하는 3트랙 페이더 슬라이더',
    bg: '#0a0d14', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#818cf8', '#c084fc', 22),
    core: `<line x1="122" y1="120" x2="122" y2="136" stroke="#ffffff" stroke-width="1.5"/>
           <line x1="128" y1="120" x2="128" y2="136" stroke="#ffffff" stroke-width="1.5"/>
           <line x1="134" y1="120" x2="134" y2="136" stroke="#ffffff" stroke-width="1.5"/>
           <circle cx="122" cy="125" r="2.5" fill="#38bdf8"/>
           <circle cx="128" cy="131" r="2.5" fill="#818cf8"/>
           <circle cx="134" cy="123" r="2.5" fill="#c084fc"/>`
  },
  {
    num: 50, id: 'ap100-050', title: 'Translucent Venn Fusion Rings', category: 'nexus', catLabel: '🔀 Multi-Model Nexus',
    tag: 'Venn Diagram / Model Fusion', desc: '3개 모델의 교집합 영역이 중심에서 완전한 시너지를 내는 벤다이어그램',
    bg: '#0a0b12', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#f43f5e', '#fbbf24', 22),
    core: `<circle cx="128" cy="124" r="5" fill="#38bdf8" opacity="0.6"/>
           <circle cx="124" cy="131" r="5" fill="#f43f5e" opacity="0.6"/>
           <circle cx="132" cy="131" r="5" fill="#fbbf24" opacity="0.6"/>
           <circle cx="128" cy="128" r="2" fill="#ffffff"/>`
  },
  {
    num: 51, id: 'ap100-051', title: 'Borromean Trinity Knot', category: 'nexus', catLabel: '🔀 Multi-Model Nexus',
    tag: 'Trinity Knot / Borromean Ring', desc: '하나라도 풀리면 성립하지 않는 완벽한 3중 결속 토폴로지',
    bg: '#090a0f', rx: 60,
    defs: ``,
    body: makeArcs('#818cf8', '#6366f1', '#4f46e5', 24),
    core: `<path d="M128 120 A8 8 0 0 1 135 132 A8 8 0 0 1 121 132 Z" fill="none" stroke="#ffffff" stroke-width="2"/>`
  },
  {
    num: 52, id: 'ap100-052', title: 'Turbine Impeller Synergy', category: 'nexus', catLabel: '🔀 Multi-Model Nexus',
    tag: 'Turbine Blade / Jet Impeller', desc: '초고속 공기 흡입과 추력을 생성하는 제트 엔진 터빈 블레이드',
    bg: '#0a0c10', rx: 60,
    defs: ``,
    body: makeArcs('#00f2fe', '#38bdf8', '#0284c7', 22),
    core: `<circle cx="128" cy="128" r="8" fill="#0284c7"/><polygon points="128,122 134,131 122,131" fill="#ffffff"/>`
  },
  {
    num: 53, id: 'ap100-053', title: 'Intelligent Routing Crossroad', category: 'nexus', catLabel: '🔀 Multi-Model Nexus',
    tag: 'Routing Hub / Crossroad', desc: '작업의 난이도에 따라 최적의 모델로 요청을 라우팅하는 지능형 허브',
    bg: '#080a14', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#10b981', '#f59e0b', 22),
    core: `<circle cx="128" cy="128" r="9" fill="#0f172a" stroke="#ffffff" stroke-width="2"/>
           <path d="M124 128 H132 M128 124 V132" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/>`
  },
  {
    num: 54, id: 'ap100-054', title: 'Distributed Load Balancer Ring', category: 'nexus', catLabel: '🔀 Multi-Model Nexus',
    tag: 'Load Balancer / Runtime Ring', desc: '분산 환경에서 부하를 균등 분배하는 서큘러 링 버퍼',
    bg: '#090d14', rx: 60,
    defs: ``,
    body: makeArcs('#06b6d4', '#0284c7', '#3b82f6', 22),
    core: `<circle cx="128" cy="128" r="10" fill="none" stroke="#06b6d4" stroke-width="2" stroke-dasharray="6 4"/>
           <circle cx="128" cy="128" r="3" fill="#ffffff"/>`
  },
  {
    num: 55, id: 'ap100-055', title: 'Consensus Quorum Engine', category: 'nexus', catLabel: '🔀 Multi-Model Nexus',
    tag: 'Consensus Engine / Quorum', desc: '3개 모델의 합의(Quorum)를 통해 코드 오류를 0%로 수렴시키는 엔진',
    bg: '#0a0a12', rx: 60,
    defs: ``,
    body: makeArcs('#10b981', '#38bdf8', '#818cf8', 22),
    core: `<polygon points="128,120 135,132 121,132" fill="none" stroke="#10b981" stroke-width="2"/>
           <circle cx="128" cy="128" r="2.5" fill="#ffffff"/>`
  }
);

// ============================================================================
// Category 5: 360° Seamless Flow & Gradient Spectra (56 - 70)
// ============================================================================
icons.push(
  {
    num: 56, id: 'ap100-056', title: '360° Full Spectral Rainbow', category: 'gradient', catLabel: '🌈 360° Seamless Gradients',
    tag: 'Pure Rainbow / Red-Green-Blue', desc: '0도에서 360도까지 순수 HSL 색상환이 완벽하게 순환하는 무지개 스펙트럼',
    bg: '#090a0f', rx: 60,
    defs: `<linearGradient id="g56-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ef4444"/><stop offset="100%" stop-color="#10b981"/></linearGradient>
           <linearGradient id="g56-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#10b981"/><stop offset="100%" stop-color="#3b82f6"/></linearGradient>
           <linearGradient id="g56-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#ef4444"/></linearGradient>`,
    body: makeArcs('url(#g56-1)', 'url(#g56-2)', 'url(#g56-3)', 22),
    core: `<circle cx="128" cy="128" r="10" fill="#ffffff"/>`
  },
  {
    num: 57, id: 'ap100-057', title: 'Cyberpunk Neon Tri-Loop', category: 'gradient', catLabel: '🌈 360° Seamless Gradients',
    tag: 'Cyan / Magenta / Purple', desc: '일렉트릭 사이언 -> 마젠타 -> 인디고 -> 사이언으로 끝없이 흐르는 네온 루프',
    bg: '#07080f', rx: 60,
    defs: `<linearGradient id="g57-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#00f2fe"/><stop offset="100%" stop-color="#ec4899"/></linearGradient>
           <linearGradient id="g57-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ec4899"/><stop offset="100%" stop-color="#8b5cf6"/></linearGradient>
           <linearGradient id="g57-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#00f2fe"/></linearGradient>`,
    body: makeArcs('url(#g57-1)', 'url(#g57-2)', 'url(#g57-3)', 22),
    core: `<circle cx="128" cy="128" r="11" fill="#00f2fe"/><circle cx="128" cy="128" r="4" fill="#ffffff"/>`
  },
  {
    num: 58, id: 'ap100-058', title: 'Sunset Solstice Horizon', category: 'gradient', catLabel: '🌈 360° Seamless Gradients',
    tag: 'Amber / Coral / Midnight', desc: '황혼의 앰버 골드에서 산호초 레드, 밤하늘 퍼플로 이어지는 일몰 루프',
    bg: '#0f0a0d', rx: 60,
    defs: `<linearGradient id="g58-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fbbf24"/><stop offset="100%" stop-color="#f43f5e"/></linearGradient>
           <linearGradient id="g58-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#7c3aed"/></linearGradient>
           <linearGradient id="g58-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#7c3aed"/><stop offset="100%" stop-color="#fbbf24"/></linearGradient>`,
    body: makeArcs('url(#g58-1)', 'url(#g58-2)', 'url(#g58-3)', 22),
    core: `<circle cx="128" cy="128" r="10" fill="#fbbf24"/><circle cx="128" cy="128" r="4" fill="#ffffff"/>`
  },
  {
    num: 59, id: 'ap100-059', title: 'Apple Intelligence Fluid Glow', category: 'gradient', catLabel: '🌈 360° Seamless Gradients',
    tag: 'Soft Pastel / Fluid Glow', desc: '부드러운 파스텔 핑크, 바이올렛, 스카이블루가 은은하게 산란되는 프리미엄 글래스',
    bg: '#0b0c12', rx: 60,
    defs: `<linearGradient id="g59-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f472b6"/><stop offset="100%" stop-color="#c084fc"/></linearGradient>
           <linearGradient id="g59-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#c084fc"/><stop offset="100%" stop-color="#38bdf8"/></linearGradient>
           <linearGradient id="g59-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#f472b6"/></linearGradient>`,
    body: makeArcs('url(#g59-1)', 'url(#g59-2)', 'url(#g59-3)', 24),
    core: `<circle cx="128" cy="128" r="12" fill="#ffffff" opacity="0.95"/>`
  },
  {
    num: 60, id: 'ap100-060', title: 'Bioluminescent Ocean Trench', category: 'gradient', catLabel: '🌈 360° Seamless Gradients',
    tag: 'Mint / Deep Aqua / Cobalt', desc: '형광 민트에서 심해 아쿠아, 코발트 블루로 이어지는 차분한 쿨톤 루프',
    bg: '#050d12', rx: 60,
    defs: `<linearGradient id="g60-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#6ee7b7"/><stop offset="100%" stop-color="#06b6d4"/></linearGradient>
           <linearGradient id="g60-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#06b6d4"/><stop offset="100%" stop-color="#2563eb"/></linearGradient>
           <linearGradient id="g60-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#2563eb"/><stop offset="100%" stop-color="#6ee7b7"/></linearGradient>`,
    body: makeArcs('url(#g60-1)', 'url(#g60-2)', 'url(#g60-3)', 22),
    core: `<circle cx="128" cy="128" r="9" fill="#6ee7b7"/><circle cx="128" cy="128" r="4" fill="#ffffff"/>`
  },
  {
    num: 61, id: 'ap100-061', title: 'Magma Thermal Plasma Flare', category: 'gradient', catLabel: '🌈 360° Seamless Gradients',
    tag: 'Yellow / Orange / Purple', desc: '태양 흑점과 마그마 플라즈마의 뜨거운 열기가 회전하는 익스트림 웜톤',
    bg: '#120806', rx: 60,
    defs: `<linearGradient id="g61-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fde047"/><stop offset="100%" stop-color="#ea580c"/></linearGradient>
           <linearGradient id="g61-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ea580c"/><stop offset="100%" stop-color="#9333ea"/></linearGradient>
           <linearGradient id="g61-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#9333ea"/><stop offset="100%" stop-color="#fde047"/></linearGradient>`,
    body: makeArcs('url(#g61-1)', 'url(#g61-2)', 'url(#g61-3)', 22),
    core: `<circle cx="128" cy="128" r="10" fill="#fde047"/><circle cx="128" cy="128" r="4" fill="#ffffff"/>`
  },
  {
    num: 62, id: 'ap100-062', title: 'Claude Terracotta & Sandstone', category: 'gradient', catLabel: '🌈 360° Seamless Gradients',
    tag: 'Terracotta / Sand / Rust', desc: '인간적이고 친근한 웜 테라코타, 러스티 오렌지, 샌드스톤 골드 루프',
    bg: '#140e0a', rx: 60,
    defs: `<linearGradient id="g62-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ea580c"/><stop offset="100%" stop-color="#c2410c"/></linearGradient>
           <linearGradient id="g62-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#c2410c"/><stop offset="100%" stop-color="#d97706"/></linearGradient>
           <linearGradient id="g62-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#d97706"/><stop offset="100%" stop-color="#ea580c"/></linearGradient>`,
    body: makeArcs('url(#g62-1)', 'url(#g62-2)', 'url(#g62-3)', 22),
    core: `<circle cx="128" cy="128" r="9" fill="#ea580c"/><circle cx="128" cy="128" r="4" fill="#ffffff"/>`
  },
  {
    num: 63, id: 'ap100-063', title: 'Ghostty Toxic Lime Matrix', category: 'gradient', catLabel: '🌈 360° Seamless Gradients',
    tag: 'Lime / Forest / Neon Jade', desc: '어두운 터미널 배경을 뚫고 나오는 토식 라임 인광체 360도 순환',
    bg: '#040905', rx: 60,
    defs: `<linearGradient id="g63-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#a3e635"/><stop offset="100%" stop-color="#16a34a"/></linearGradient>
           <linearGradient id="g63-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#16a34a"/><stop offset="100%" stop-color="#047857"/></linearGradient>
           <linearGradient id="g63-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#047857"/><stop offset="100%" stop-color="#a3e635"/></linearGradient>`,
    body: makeArcs('url(#g63-1)', 'url(#g63-2)', 'url(#g63-3)', 22),
    core: `<circle cx="128" cy="128" r="9" fill="#a3e635"/><circle cx="128" cy="128" r="4" fill="#ffffff"/>`
  },
  {
    num: 64, id: 'ap100-064', title: 'Deep Space Andromeda Nebula', category: 'gradient', catLabel: '🌈 360° Seamless Gradients',
    tag: 'Deep Indigo / Magenta / Cyan', desc: '심우주 안드로메다 은하의 성운 가스가 소용돌이치는 코스믹 스펙트럼',
    bg: '#060610', rx: 60,
    defs: `<linearGradient id="g64-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#d946ef"/></linearGradient>
           <linearGradient id="g64-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#d946ef"/><stop offset="100%" stop-color="#06b6d4"/></linearGradient>
           <linearGradient id="g64-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#06b6d4"/><stop offset="100%" stop-color="#6366f1"/></linearGradient>`,
    body: makeArcs('url(#g64-1)', 'url(#g64-2)', 'url(#g64-3)', 22),
    core: `<circle cx="128" cy="128" r="10" fill="#ffffff"/>`
  },
  {
    num: 65, id: 'ap100-065', title: 'Miami Vice Retro Synthwave', category: 'gradient', catLabel: '🌈 360° Seamless Gradients',
    tag: 'Hot Pink / Tangerine / Blue', desc: '80년대 레트로퓨처리즘 핫핑크, 탠저린 오렌지, 로열블루 루프',
    bg: '#0d0714', rx: 60,
    defs: `<linearGradient id="g65-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#fb923c"/></linearGradient>
           <linearGradient id="g65-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fb923c"/><stop offset="100%" stop-color="#3b82f6"/></linearGradient>
           <linearGradient id="g65-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#f43f5e"/></linearGradient>`,
    body: makeArcs('url(#g65-1)', 'url(#g65-2)', 'url(#g65-3)', 22),
    core: `<circle cx="128" cy="128" r="10" fill="#f43f5e"/><circle cx="128" cy="128" r="4" fill="#ffffff"/>`
  },
  {
    num: 66, id: 'ap100-066', title: 'Holographic Iridescent Foil', category: 'gradient', catLabel: '🌈 360° Seamless Gradients',
    tag: 'Holo Sheen / Opal Light', desc: '각도에 따라 무지개빛으로 반사되는 프리미엄 오팔 홀로그램 박',
    bg: '#0a0d14', rx: 60,
    defs: `<linearGradient id="g66-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#a5f3fc"/><stop offset="100%" stop-color="#fbcfe8"/></linearGradient>
           <linearGradient id="g66-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fbcfe8"/><stop offset="100%" stop-color="#fef08a"/></linearGradient>
           <linearGradient id="g66-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fef08a"/><stop offset="100%" stop-color="#a5f3fc"/></linearGradient>`,
    body: makeArcs('url(#g66-1)', 'url(#g66-2)', 'url(#g66-3)', 24),
    core: `<circle cx="128" cy="128" r="10" fill="#ffffff"/>`
  },
  {
    num: 67, id: 'ap100-067', title: 'Electric Ultraviolet Plasma', category: 'gradient', catLabel: '🌈 360° Seamless Gradients',
    tag: 'Ultraviolet / Deep Plum', desc: '고전압 자외선 플라즈마 방전의 신비로운 딥 바이올렛 스펙트럼',
    bg: '#080512', rx: 60,
    defs: `<linearGradient id="g67-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#c084fc"/><stop offset="100%" stop-color="#7e22ce"/></linearGradient>
           <linearGradient id="g67-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#7e22ce"/><stop offset="100%" stop-color="#3b0764"/></linearGradient>
           <linearGradient id="g67-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#3b0764"/><stop offset="100%" stop-color="#c084fc"/></linearGradient>`,
    body: makeArcs('url(#g67-1)', 'url(#g67-2)', 'url(#g67-3)', 22),
    core: `<circle cx="128" cy="128" r="9" fill="#c084fc"/><circle cx="128" cy="128" r="4" fill="#ffffff"/>`
  },
  {
    num: 68, id: 'ap100-068', title: 'Hyper Citrus Lime & Teal', category: 'gradient', catLabel: '🌈 360° Seamless Gradients',
    tag: 'Lime / Chartreuse / Teal', desc: '상큼하고 경쾌한 에너지의 시트러스 라임, 샤르트뢰즈, 딥 틸 루프',
    bg: '#040c0b', rx: 60,
    defs: `<linearGradient id="g68-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#bef264"/><stop offset="100%" stop-color="#14b8a6"/></linearGradient>
           <linearGradient id="g68-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#14b8a6"/><stop offset="100%" stop-color="#0f766e"/></linearGradient>
           <linearGradient id="g68-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#0f766e"/><stop offset="100%" stop-color="#bef264"/></linearGradient>`,
    body: makeArcs('url(#g68-1)', 'url(#g68-2)', 'url(#g68-3)', 22),
    core: `<circle cx="128" cy="128" r="9" fill="#bef264"/><circle cx="128" cy="128" r="4" fill="#ffffff"/>`
  },
  {
    num: 69, id: 'ap100-069', title: 'Rose Gold & Champagne Luxury', category: 'gradient', catLabel: '🌈 360° Seamless Gradients',
    tag: 'Rose Gold / Warm Copper', desc: '로즈골드에서 샴페인 플래티넘, 웜 코퍼로 수렴하는 최고급 럭셔리 루프',
    bg: '#140c0e', rx: 60,
    defs: `<linearGradient id="g69-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fda4af"/><stop offset="100%" stop-color="#fb7185"/></linearGradient>
           <linearGradient id="g69-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fb7185"/><stop offset="100%" stop-color="#f59e0b"/></linearGradient>
           <linearGradient id="g69-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#fda4af"/></linearGradient>`,
    body: makeArcs('url(#g69-1)', 'url(#g69-2)', 'url(#g69-3)', 22),
    core: `<circle cx="128" cy="128" r="9" fill="#fda4af"/><circle cx="128" cy="128" r="4" fill="#ffffff"/>`
  },
  {
    num: 70, id: 'ap100-070', title: 'Monochrome Grayscale Luminance', category: 'gradient', catLabel: '🌈 360° Seamless Gradients',
    tag: '100% White / Charcoal Luma', desc: '화이트에서 슬레이트 그레이, 차콜로 이어지는 완벽한 흑백 명도 순환',
    bg: '#050505', rx: 60,
    defs: `<linearGradient id="g70-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#94a3b8"/></linearGradient>
           <linearGradient id="g70-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#94a3b8"/><stop offset="100%" stop-color="#334155"/></linearGradient>
           <linearGradient id="g70-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#334155"/><stop offset="100%" stop-color="#ffffff"/></linearGradient>`,
    body: makeArcs('url(#g70-1)', 'url(#g70-2)', 'url(#g70-3)', 24),
    core: `<circle cx="128" cy="128" r="10" fill="#ffffff"/>`
  }
);

// ============================================================================
// Category 6: Geometric & Architectural Stroke Profiles (71 - 85)
// ============================================================================
icons.push(
  {
    num: 71, id: 'ap100-071', title: 'Ultra-Chunky 36px Power Stroke', category: 'geometry', catLabel: '📐 Architecture & Geometry',
    tag: 'Heavy Bold 36px / Max Legibility', desc: '16px 극소형 탭에서도 압도적인 시인성을 발휘하는 36px 울트라 볼드 아크',
    bg: '#090a10', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#818cf8', '#c084fc', 36),
    core: `<circle cx="128" cy="128" r="14" fill="#ffffff"/>`
  },
  {
    num: 72, id: 'ap100-072', title: 'Precision Technical 10px Hairline', category: 'geometry', catLabel: '📐 Architecture & Geometry',
    tag: 'Ultra-Thin 10px / Blueprint Line', desc: '스위스 청사진과 테크니컬 드로잉 감성의 초정밀 10px 헤어라인',
    bg: '#07090e', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#00f2fe', '#818cf8', 10),
    core: `<circle cx="128" cy="128" r="5" fill="#38bdf8"/><circle cx="128" cy="128" r="2" fill="#ffffff"/>`
  },
  {
    num: 73, id: 'ap100-073', title: 'Aerodynamic Tapered Fins', category: 'geometry', catLabel: '📐 Architecture & Geometry',
    tag: 'Tapered Fins / Aerodynamics', desc: '앞머리는 두껍고 꼬리는 칼날처럼 날렵하게 좁아지는 테이퍼드 지느러미',
    bg: '#080c14', rx: 60,
    defs: `<linearGradient id="g73" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#00f2fe"/><stop offset="100%" stop-color="#0369a1"/></linearGradient>`,
    body: `
      <g fill="none">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="url(#g73)" stroke-width="26" stroke-linecap="round"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="url(#g73)" stroke-width="20" stroke-linecap="round"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="url(#g73)" stroke-width="14" stroke-linecap="round"/>
      </g>
    `,
    core: `<circle cx="128" cy="128" r="9" fill="#00f2fe"/><circle cx="128" cy="128" r="3.5" fill="#ffffff"/>`
  },
  {
    num: 74, id: 'ap100-074', title: '45° CNC Chamfer Cut Ends', category: 'geometry', catLabel: '📐 Architecture & Geometry',
    tag: '45° Chamfer / Flat Cut', desc: '아크의 양 끝단을 둥글리지 않고 정밀 45도 각도로 칼같이 절삭한 모더니즘',
    bg: '#0a0b10', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#818cf8', '#c084fc', 22, 'butt'),
    core: `<rect x="122" y="122" width="12" height="12" fill="#ffffff"/>`
  },
  {
    num: 75, id: 'ap100-075', title: 'Square Butt Architectural Cut', category: 'geometry', catLabel: '📐 Architecture & Geometry',
    tag: 'Square Butt / Bauhaus', desc: '직각으로 단호하게 끝나는 바우하우스 건축 스타일의 사각 단면',
    bg: '#0a0a0f', rx: 60,
    defs: ``,
    body: makeArcs('#f43f5e', '#fbbf24', '#38bdf8', 24, 'square'),
    core: `<rect x="123" y="123" width="10" height="10" rx="2" fill="#ffffff"/>`
  },
  {
    num: 76, id: 'ap100-076', title: 'Calibrated Tech Dash-Array', category: 'geometry', catLabel: '📐 Architecture & Geometry',
    tag: 'Dash-Array / Tech Scale', desc: '정밀 측정 계측기와 게이지 눈금을 재현한 점선 대시 스트로크',
    bg: '#060a10', rx: 60,
    defs: ``,
    body: makeArcs('#00f2fe', '#38bdf8', '#818cf8', 20, 'butt', '8 4'),
    core: `<circle cx="128" cy="128" r="8" fill="#00f2fe"/><circle cx="128" cy="128" r="3" fill="#ffffff"/>`
  },
  {
    num: 77, id: 'ap100-077', title: 'Double-Rail Concentric Wire', category: 'geometry', catLabel: '📐 Architecture & Geometry',
    tag: 'Double Rail / Dual Wire', desc: '동심원을 이루는 2중 평행 와이어 레일 아크',
    bg: '#080d14', rx: 60,
    defs: ``,
    body: `
      <g fill="none" stroke-linecap="round">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="#38bdf8" stroke-width="8"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="#818cf8" stroke-width="8"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="#c084fc" stroke-width="8"/>
        <path d="M119.5 73A56 56 0 0 1 180.5 108.5" stroke="#38bdf8" stroke-width="6"/>
        <path d="M119.5 73A56 56 0 0 1 180.5 108.5" transform="rotate(120 128 128)" stroke="#818cf8" stroke-width="6"/>
        <path d="M119.5 73A56 56 0 0 1 180.5 108.5" transform="rotate(240 128 128)" stroke="#c084fc" stroke-width="6"/>
      </g>
    `,
    core: `<circle cx="128" cy="128" r="7" fill="#ffffff"/>`
  },
  {
    num: 78, id: 'ap100-078', title: 'Nested Triple Concentric Triad', category: 'geometry', catLabel: '📐 Architecture & Geometry',
    tag: 'Triple Layer / Concentric', desc: '대·중·소 3개의 조리개 아크가 겹겹이 중첩된 다층 심도 구조',
    bg: '#090a12', rx: 60,
    defs: ``,
    body: `
      <g fill="none" stroke-linecap="round">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="#38bdf8" stroke-width="12"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" stroke="#818cf8" stroke-width="12"/>
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" stroke="#c084fc" stroke-width="12"/>
        <path d="M122 83A46 46 0 0 1 169 112" stroke="#ffffff" stroke-width="8"/>
        <path d="M122 83A46 46 0 0 1 169 112" transform="rotate(120 128 128)" stroke="#ffffff" stroke-width="8"/>
        <path d="M122 83A46 46 0 0 1 169 112" transform="rotate(240 128 128)" stroke="#ffffff" stroke-width="8"/>
      </g>
    `,
    core: `<circle cx="128" cy="128" r="5" fill="#38bdf8"/>`
  },
  {
    num: 79, id: 'ap100-079', title: 'Golden Ratio Logarithmic Spiral', category: 'geometry', catLabel: '📐 Architecture & Geometry',
    tag: 'Log Spiral / Golden Ratio', desc: '황금비율 로그 나선형 궤적으로 안쪽을 향해 파고드는 아크',
    bg: '#0a0d14', rx: 60,
    defs: ``,
    body: makeArcs('#00f2fe', '#38bdf8', '#818cf8', 20),
    core: `<circle cx="128" cy="128" r="7" fill="#ffffff"/>`
  },
  {
    num: 80, id: 'ap100-080', title: 'Outward Rocket Thruster Flare', category: 'geometry', catLabel: '📐 Architecture & Geometry',
    tag: 'Thruster Flare / Rocket Nozzle', desc: '로켓 노즐의 배기 화염처럼 바깥쪽으로 시원하게 확장되는 형상',
    bg: '#0e0a14', rx: 60,
    defs: ``,
    body: makeArcs('#f43f5e', '#fb7185', '#fda4af', 24),
    core: `<polygon points="128,122 133,132 123,132" fill="#ffffff"/>`
  },
  {
    num: 81, id: 'ap100-081', title: 'Stepped Modular Notches', category: 'geometry', catLabel: '📐 Architecture & Geometry',
    tag: 'Modular Notches / Pixel Grid', desc: '계단형으로 깎여나간 모듈러 블록 홈이 새겨진 디지털 아크',
    bg: '#090a0f', rx: 60,
    defs: ``,
    body: makeArcs('#10b981', '#38bdf8', '#6366f1', 22, 'round', '12 6'),
    core: `<rect x="123" y="123" width="10" height="10" fill="#10b981"/>`
  },
  {
    num: 82, id: 'ap100-082', title: '3D Beveled Facet Split', category: 'geometry', catLabel: '📐 Architecture & Geometry',
    tag: '3D Bevel / Light & Shadow', desc: '빛과 그림자가 반반씩 나뉘는 3차원 베벨 각면 입체 아크',
    bg: '#0d0e14', rx: 60,
    defs: ``,
    body: makeArcs('#ffffff', '#94a3b8', '#475569', 24),
    core: `<polygon points="128,118 138,128 128,138 118,128" fill="#ffffff"/>`
  },
  {
    num: 83, id: 'ap100-083', title: 'Chevron Pointed Arrow Caps', category: 'geometry', catLabel: '📐 Architecture & Geometry',
    tag: 'Arrowhead Caps / Chevron Tip', desc: '아크의 끝단이 화살촉 셰브론 형태로 마감된 방향성 심볼',
    bg: '#080a14', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#818cf8', '#c084fc', 22),
    core: `<polygon points="128,120 134,130 128,127 122,130" fill="#ffffff"/>`
  },
  {
    num: 84, id: 'ap100-084', title: 'Horizontal Strobe Slit Cutouts', category: 'geometry', catLabel: '📐 Architecture & Geometry',
    tag: 'Strobe Slits / Laser Cut', desc: '수평 방향의 레이저 슬릿이 교차하며 아크를 분할하는 하이테크 스타일',
    bg: '#06070a', rx: 60,
    defs: ``,
    body: makeArcs('#00f2fe', '#38bdf8', '#0284c7', 22, 'butt', '16 4'),
    core: `<circle cx="128" cy="128" r="8" fill="#00f2fe"/><circle cx="128" cy="128" r="3" fill="#ffffff"/>`
  },
  {
    num: 85, id: 'ap100-085', title: 'Negative Space Carved Monolith', category: 'geometry', catLabel: '📐 Architecture & Geometry',
    tag: 'Negative Cut / Monolith Disc', desc: '원형 블랙 디스크 내부를 음각으로 파내어 완성한 네거티브 스페이스',
    bg: '#000000', rx: 128,
    defs: ``,
    body: makeArcs('#38bdf8', '#ffffff', '#818cf8', 26),
    core: `<circle cx="128" cy="128" r="10" fill="#ffffff"/>`
  }
);

// ============================================================================
// Category 7: Luxury Hardware & Metallic Finishes (86 - 95)
// ============================================================================
icons.push(
  {
    num: 86, id: 'ap100-086', title: 'Machined Space Grey Titanium', category: 'hardware', catLabel: '⚙️ Hardware & Materials',
    tag: 'CNC Titanium / Amber Laser', desc: 'Teenage Engineering 감성의 45도 CNC 챔퍼 가공 스페이스 그레이 티타늄',
    bg: '#12141a', rx: 60,
    defs: `<linearGradient id="g86" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ffffff"/><stop offset="50%" stop-color="#94a3b8"/><stop offset="100%" stop-color="#334155"/></linearGradient>`,
    body: makeArcs('url(#g86)', 'url(#g86)', 'url(#g86)', 24),
    core: `<circle cx="128" cy="128" r="7" fill="#fbbf24"/><circle cx="128" cy="128" r="2.5" fill="#ffffff"/>`
  },
  {
    num: 87, id: 'ap100-087', title: 'Liquid Chrome Mirror Reflection', category: 'hardware', catLabel: '⚙️ Hardware & Materials',
    tag: 'Liquid Chrome / Mirror Specular', desc: '거울처럼 주변 빛을 반사하는 초고반사 액체 수은 크롬 리본',
    bg: '#050508', rx: 60,
    defs: `<linearGradient id="g87" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ffffff"/><stop offset="30%" stop-color="#cbd5e1"/><stop offset="70%" stop-color="#475569"/><stop offset="100%" stop-color="#ffffff"/></linearGradient>`,
    body: makeArcs('url(#g87)', 'url(#g87)', 'url(#g87)', 26),
    core: `<circle cx="128" cy="128" r="10" fill="#ffffff"/>`
  },
  {
    num: 88, id: 'ap100-088', title: 'Champagne Gold Swiss Watch Bezel', category: 'hardware', catLabel: '⚙️ Hardware & Materials',
    tag: 'Champagne Gold / Crosshair', desc: '스위스 오트 오를로제리 최고급 시계 베젤 감성의 샴페인 골드 & 십자선 타깃',
    bg: '#14120c', rx: 60,
    defs: `<linearGradient id="g88" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fef08a"/><stop offset="50%" stop-color="#eab308"/><stop offset="100%" stop-color="#a16207"/></linearGradient>`,
    body: makeArcs('url(#g88)', 'url(#g88)', 'url(#g88)', 22),
    core: `<circle cx="128" cy="128" r="8" fill="none" stroke="#fef08a" stroke-width="2"/>
           <line x1="128" y1="118" x2="128" y2="138" stroke="#fef08a" stroke-width="1.5"/>
           <line x1="118" y1="128" x2="138" y2="128" stroke="#fef08a" stroke-width="1.5"/>
           <circle cx="128" cy="128" r="2.5" fill="#ffffff"/>`
  },
  {
    num: 89, id: 'ap100-089', title: 'Matte Stealth Blackout', category: 'hardware', catLabel: '⚙️ Hardware & Materials',
    tag: 'Matte Black / Gloss Rim', desc: '빛을 100% 흡수하는 무광 매트 블랙 바디와 유광 글로스 엣지',
    bg: '#000000', rx: 60,
    defs: ``,
    body: makeArcs('#262626', '#404040', '#171717', 24),
    core: `<circle cx="128" cy="128" r="7" fill="#ffffff"/>`
  },
  {
    num: 90, id: 'ap100-090', title: 'Frosted Glassmorphism Glow', category: 'hardware', catLabel: '⚙️ Hardware & Materials',
    tag: 'Glassmorphism / Frosted Acrylic', desc: '반투명 프로스티드 아크릴 글래스와 내부에서 피어나는 코스틱 광원',
    bg: '#0f172a', rx: 60,
    defs: ``,
    body: makeArcs('rgba(255,255,255,0.75)', 'rgba(56,189,248,0.7)', 'rgba(129,140,248,0.7)', 24),
    core: `<circle cx="128" cy="128" r="10" fill="#38bdf8" opacity="0.9"/>`
  },
  {
    num: 91, id: 'ap100-091', title: 'Raw Copper Heatsink Fin', category: 'hardware', catLabel: '⚙️ Hardware & Materials',
    tag: 'Industrial Copper / Heatsink', desc: '고성능 GPU 쿨러 히트싱크의 순동(Copper) 메탈릭 질감',
    bg: '#140c08', rx: 60,
    defs: `<linearGradient id="g91" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fdba74"/><stop offset="50%" stop-color="#ea580c"/><stop offset="100%" stop-color="#9a3412"/></linearGradient>`,
    body: makeArcs('url(#g91)', 'url(#g91)', 'url(#g91)', 22),
    core: `<rect x="123" y="123" width="10" height="10" rx="2" fill="#fdba74"/>`
  },
  {
    num: 92, id: 'ap100-092', title: 'Cybernetic Carbon Fiber Weave', category: 'hardware', catLabel: '⚙️ Hardware & Materials',
    tag: 'Carbon Weave / High-Tech Rig', desc: '초경량 고강도 카본 컴포지트 위브 패턴 감성의 에셋',
    bg: '#0a0a0c', rx: 60,
    defs: ``,
    body: makeArcs('#38bdf8', '#334155', '#64748b', 22),
    core: `<circle cx="128" cy="128" r="8" fill="#00f2fe"/><circle cx="128" cy="128" r="3" fill="#ffffff"/>`
  },
  {
    num: 93, id: 'ap100-093', title: 'Pristine Ceramic White Inverted', category: 'hardware', catLabel: '⚙️ Hardware & Materials',
    tag: 'Ceramic White / Light Tile', desc: '애플 세라믹 에디션 감성의 순백 바탕 위 청명한 일렉트릭 블루 아크',
    bg: '#f8fafc', rx: 60,
    defs: ``,
    body: makeArcs('#0284c7', '#2563eb', '#7c3aed', 24),
    core: `<circle cx="128" cy="128" r="10" fill="#0f172a"/>`
  },
  {
    num: 94, id: 'ap100-094', title: 'Gunmetal Heavy Ordnance', category: 'hardware', catLabel: '⚙️ Hardware & Materials',
    tag: 'Gunmetal / Crimson LED', desc: '묵직한 밀리터리 그레이 건메탈 합금과 크림슨 레드 비콘 LED',
    bg: '#0d0f12', rx: 60,
    defs: ``,
    body: makeArcs('#475569', '#64748b', '#334155', 24),
    core: `<circle cx="128" cy="128" r="7" fill="#ef4444"/><circle cx="128" cy="128" r="2.5" fill="#ffffff"/>`
  },
  {
    num: 95, id: 'ap100-095', title: 'Celestial Astrolabe Antique Brass', category: 'hardware', catLabel: '⚙️ Hardware & Materials',
    tag: 'Astrolabe Brass / Celestial', desc: '천체를 관측하던 앤틱 천문 시계 아스트롤라베 브라스',
    bg: '#141008', rx: 60,
    defs: ``,
    body: makeArcs('#d97706', '#b45309', '#92400e', 22),
    core: `<circle cx="128" cy="128" r="9" fill="none" stroke="#d97706" stroke-width="2"/>
           <circle cx="128" cy="128" r="4" fill="#fbbf24"/>`
  }
);

// ============================================================================
// Category 8: App Store Badges & Iconic Lockups (96 - 100)
// ============================================================================
icons.push(
  {
    num: 96, id: 'ap100-096', title: 'macOS Squircle Cyan App Tile', category: 'apptile', catLabel: '📱 App Tiles & Containers',
    tag: 'macOS Squircle / Cyan Rim', desc: 'macOS/iOS 표준 스퀘어클 타일에 인셋 네온 림 라이팅이 적용된 앱 아이콘',
    bg: '#0a0b12', rx: 60,
    defs: `<linearGradient id="g96-rim" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.4"/><stop offset="50%" stop-color="#00f2fe" stop-opacity="0.3"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/></linearGradient>`,
    body: `
      <rect x="1" y="1" width="254" height="254" rx="59" fill="none" stroke="url(#g96-rim)" stroke-width="2"/>
      ${makeArcs('#00f2fe', '#38bdf8', '#818cf8', 22)}
    `,
    core: `<circle cx="128" cy="128" r="10" fill="#00f2fe"/><circle cx="128" cy="128" r="4" fill="#ffffff"/>`
  },
  {
    num: 97, id: 'ap100-097', title: 'Hexagonal Agent Runtime Pod', category: 'apptile', catLabel: '📱 App Tiles & Containers',
    tag: 'Hexagon Pod / Container', desc: '도커 컨테이너와 쿠버네티스 포드를 상징하는 6각 프레임 배지',
    bg: '#07090f', rx: 60,
    defs: ``,
    body: `
      <polygon points="128,20 220,72 220,184 128,236 36,184 36,72" fill="none" stroke="#38bdf8" stroke-width="2" opacity="0.3"/>
      ${makeArcs('#38bdf8', '#818cf8', '#c084fc', 22)}
    `,
    core: `<circle cx="128" cy="128" r="8" fill="#38bdf8"/><circle cx="128" cy="128" r="3" fill="#ffffff"/>`
  },
  {
    num: 98, id: 'ap100-098', title: 'Diamond Shield Developer Crest', category: 'apptile', catLabel: '📱 App Tiles & Containers',
    tag: 'Diamond Badge / Shield Crest', desc: '45도 회전된 다이아몬드 실드 프레임 안의 조리개 트라이어드',
    bg: '#090a10', rx: 60,
    defs: ``,
    body: `
      <rect x="36" y="36" width="184" height="184" rx="28" transform="rotate(45 128 128)" fill="none" stroke="#ffffff" stroke-width="1.5" opacity="0.25"/>
      ${makeArcs('#f43f5e', '#fbbf24', '#00f2fe', 22)}
    `,
    core: `<polygon points="128,120 136,128 128,136 120,128" fill="#ffffff"/>`
  },
  {
    num: 99, id: 'ap100-099', title: 'Grooved Token Medallion', category: 'apptile', catLabel: '📱 App Tiles & Containers',
    tag: 'Token Medal / Circular Coin', desc: '외곽에 정밀 그루브 널링이 들어간 원형 다크 메달리온 토큰',
    bg: '#06070a', rx: 128,
    defs: ``,
    body: `
      <circle cx="128" cy="128" r="118" fill="none" stroke="#38bdf8" stroke-width="2" stroke-dasharray="4 6"/>
      ${makeArcs('#38bdf8', '#00f2fe', '#818cf8', 22)}
    `,
    core: `<circle cx="128" cy="128" r="9" fill="#00f2fe"/><circle cx="128" cy="128" r="3.5" fill="#ffffff"/>`
  },
  {
    num: 100, id: 'ap100-100', title: 'Mixdog Supreme Masterpiece', category: 'apptile', catLabel: '📱 App Tiles & Containers',
    tag: 'Mixdog Supreme / Masterpiece #100', desc: '하운드 스나우트 + 터미널 프롬프트 + 360° 오로라 루프 + AI 스파크의 궁극적 융합',
    bg: '#06070b', rx: 60,
    defs: `<linearGradient id="g100-rim" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.5"/><stop offset="50%" stop-color="#00f2fe" stop-opacity="0.4"/><stop offset="100%" stop-color="#818cf8" stop-opacity="0.1"/></linearGradient>
           <linearGradient id="g100-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#00f2fe"/><stop offset="100%" stop-color="#38bdf8"/></linearGradient>
           <linearGradient id="g100-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#818cf8"/></linearGradient>
           <linearGradient id="g100-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#818cf8"/><stop offset="100%" stop-color="#00f2fe"/></linearGradient>`,
    body: `
      <rect x="1.5" y="1.5" width="253" height="253" rx="58.5" fill="none" stroke="url(#g100-rim)" stroke-width="2"/>
      ${makeArcs('url(#g100-1)', 'url(#g100-2)', 'url(#g100-3)', 24)}
    `,
    core: `<circle cx="128" cy="128" r="18" fill="none" stroke="#00f2fe" stroke-width="1.5" stroke-dasharray="3 3"/>
           <path d="M128 114 Q128 128 114 128 Q128 128 128 142 Q128 128 142 128 Q128 128 128 114 Z" fill="#ffffff"/>
           <circle cx="128" cy="128" r="3.5" fill="#00f2fe"/>`
  }
);

console.log(`Prepared ${icons.length} icon specifications.`);

// Generate All 100 SVGs
for (const item of icons) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    ${item.defs || ''}
  </defs>
  <rect width="256" height="256" rx="${item.rx}" fill="${item.bg}"/>
  ${item.body}
  <g id="center-core">
    ${item.core}
  </g>
</svg>`;

  writeFileSync(join(outDir, `${item.id}-${item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.svg`), svg, 'utf8');
}

console.log(`✅ Generated 100 SVG icon files in ${outDir}!`);

// Build Ultra-Slick 100-Icon Showcase HTML
const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mixdog Aperture 100 Icons Mega System</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #06070a;
      --bg-surface: #0c0e15;
      --bg-card: #111420;
      --bg-card-hover: #181d2e;
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
      line-height: 1.5;
      padding-bottom: 120px;
    }

    .bg-grid {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background-image:
        radial-gradient(circle at 50% 0%, rgba(56, 189, 248, 0.12) 0%, transparent 60%),
        radial-gradient(circle at 85% 20%, rgba(129, 140, 248, 0.08) 0%, transparent 50%),
        radial-gradient(circle at 15% 40%, rgba(244, 63, 94, 0.06) 0%, transparent 45%);
      pointer-events: none;
      z-index: 0;
    }

    .container {
      position: relative;
      z-index: 1;
      max-width: 1540px;
      margin: 0 auto;
      padding: 48px 24px 0;
    }

    /* Header */
    header {
      text-align: center;
      max-width: 960px;
      margin: 0 auto 40px;
    }

    .pill-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 18px;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.25);
      border-radius: 999px;
      color: var(--cyan);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-bottom: 16px;
    }

    h1 {
      font-size: 46px;
      font-weight: 800;
      letter-spacing: -0.03em;
      line-height: 1.15;
      margin-bottom: 14px;
      background: linear-gradient(135deg, #ffffff 30%, #cbd5e1 70%, #94a3b8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .subtitle {
      font-size: 16px;
      color: var(--text-muted);
      line-height: 1.6;
      margin-bottom: 24px;
    }

    /* Live Multi-Scale Floating Preview Bar */
    .floating-scale-bar {
      position: sticky;
      top: 16px;
      z-index: 100;
      background: rgba(12, 14, 21, 0.88);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border-accent);
      border-radius: var(--radius-lg);
      padding: 16px 24px;
      margin-bottom: 32px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.8), 0 0 24px rgba(56, 189, 248, 0.15);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      flex-wrap: wrap;
    }

    .scale-left {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .scale-title {
      font-size: 14px;
      font-weight: 700;
      color: #ffffff;
      white-space: nowrap;
    }

    .scale-tag {
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      color: var(--cyan);
      background: rgba(56, 189, 248, 0.1);
      padding: 3px 8px;
      border-radius: 4px;
    }

    .scale-items {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .scale-box {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    }

    .scale-box img {
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      transition: transform 0.2s;
    }

    .scale-lbl {
      font-size: 10px;
      color: var(--text-dim);
      font-family: 'JetBrains Mono', monospace;
    }

    .scale-actions {
      display: flex;
      gap: 8px;
    }

    .btn-action {
      padding: 8px 16px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
    }

    .btn-copy {
      background: var(--cyan);
      color: #040810;
    }

    .btn-copy:hover {
      box-shadow: 0 0 14px rgba(56, 189, 248, 0.5);
    }

    .btn-fav {
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      border: 1px solid var(--border);
    }

    .btn-fav.active {
      background: rgba(244, 63, 94, 0.2);
      border-color: #f43f5e;
      color: #f43f5e;
    }

    /* Filter & Search Bar */
    .filter-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 28px;
      flex-wrap: wrap;
    }

    .search-input {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 18px;
      color: #fff;
      font-size: 13px;
      min-width: 280px;
      outline: none;
      transition: border-color 0.2s;
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
      font-weight: 500;
    }

    .chip:hover, .chip.active {
      background: var(--cyan);
      color: #040810;
      border-color: var(--cyan);
      font-weight: 700;
    }

    .chip.fav-chip.active {
      background: #f43f5e;
      color: #fff;
      border-color: #f43f5e;
    }

    /* 100-Icon Responsive Grid */
    .icons-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 18px;
    }

    .icon-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 20px 16px 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      cursor: pointer;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
    }

    .icon-card:hover {
      transform: translateY(-5px);
      border-color: var(--border-accent);
      background: var(--bg-card-hover);
      box-shadow: 0 16px 32px rgba(0, 0, 0, 0.6), 0 0 20px rgba(56, 189, 248, 0.12);
    }

    .icon-card.selected {
      border-color: var(--cyan);
      box-shadow: 0 0 24px rgba(56, 189, 248, 0.3);
    }

    .icon-num {
      position: absolute;
      top: 10px; left: 12px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      font-weight: 700;
      color: var(--text-dim);
    }

    .icon-fav-btn {
      position: absolute;
      top: 8px; right: 8px;
      background: transparent;
      border: none;
      color: var(--text-dim);
      font-size: 14px;
      cursor: pointer;
      padding: 4px;
      transition: color 0.2s;
    }

    .icon-fav-btn:hover, .icon-fav-btn.favorited {
      color: #f43f5e;
    }

    .icon-preview-wrap {
      width: 100px;
      height: 100px;
      margin: 12px 0 14px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .icon-preview-wrap img {
      width: 100%;
      height: 100%;
      transition: transform 0.2s;
    }

    .icon-card:hover .icon-preview-wrap img {
      transform: scale(1.08);
    }

    .icon-title {
      font-size: 12px;
      font-weight: 700;
      text-align: center;
      color: #ffffff;
      margin-bottom: 4px;
      width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .icon-category-tag {
      font-size: 10px;
      color: var(--text-dim);
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="bg-grid"></div>

  <div class="container">
    <header>
      <div class="pill-badge">⚡ 100 Modern Aperture Icons Edition</div>
      <h1>Mixdog Aperture 100 Icons Mega System</h1>
      <p class="subtitle">
        131번 Aperture Triad를 기반으로 제작된 100가지의 모던 아이콘 아카이브입니다.<br>
        강아지/하운드 심볼, AI 지능 스파크, 터미널 CLI 문법, 360도 연속 그라데이션, 하드웨어 럭셔리 등 8대 카테고리로 구성되었습니다.
      </p>
    </header>

    <!-- Floating Live Multi-Scale Preview Bar -->
    <div class="floating-scale-bar" id="scale-bar">
      <div class="scale-left">
        <div>
          <div class="scale-title" id="cur-title">#001 • Hound Snout & Prompt Cursor</div>
          <span class="scale-tag" id="cur-tag">Hound Snout / Terminal ></span>
        </div>
      </div>

      <div class="scale-items">
        <div class="scale-box">
          <img id="sc-128" src="./ap100-001-hound-snout-prompt-cursor.svg" style="width: 56px; height: 56px;" />
          <span class="scale-lbl">128px</span>
        </div>
        <div class="scale-box">
          <img id="sc-64" src="./ap100-001-hound-snout-prompt-cursor.svg" style="width: 44px; height: 44px;" />
          <span class="scale-lbl">64px</span>
        </div>
        <div class="scale-box">
          <img id="sc-32" src="./ap100-001-hound-snout-prompt-cursor.svg" style="width: 32px; height: 32px;" />
          <span class="scale-lbl">32px</span>
        </div>
        <div class="scale-box">
          <img id="sc-24" src="./ap100-001-hound-snout-prompt-cursor.svg" style="width: 24px; height: 24px;" />
          <span class="scale-lbl">24px</span>
        </div>
        <div class="scale-box">
          <img id="sc-16" src="./ap100-001-hound-snout-prompt-cursor.svg" style="width: 16px; height: 16px;" />
          <span class="scale-lbl">16px</span>
        </div>
      </div>

      <div class="scale-actions">
        <button class="btn-action btn-copy" onclick="copyCurrentSvg()">📋 SVG 복사</button>
        <button class="btn-action btn-fav" id="cur-fav-btn" onclick="toggleCurrentFav()">♥ 찜하기</button>
      </div>
    </div>

    <!-- Filter & Search Bar -->
    <div class="filter-bar">
      <input type="text" class="search-input" id="search-input" placeholder="🔍 100개 아이콘 검색 (이름, 번호, 태그)..." oninput="filterGrid()" />
      <div class="filter-chips">
        <button class="chip active" onclick="setFilter('all', this)">전체 100개</button>
        <button class="chip fav-chip" onclick="setFilter('fav', this)">♥ 찜한 목록 (<span id="fav-count">0</span>)</button>
        <button class="chip" onclick="setFilter('canine', this)">🐶 하운드/강아지 (15)</button>
        <button class="chip" onclick="setFilter('spark', this)">✦ AI 스파크 (15)</button>
        <button class="chip" onclick="setFilter('terminal', this)">💻 터미널 CLI (15)</button>
        <button class="chip" onclick="setFilter('nexus', this)">🔀 멀티모델 (10)</button>
        <button class="chip" onclick="setFilter('gradient', this)">🌈 360° 루프 (15)</button>
        <button class="chip" onclick="setFilter('geometry', this)">📐 조형/스트로크 (15)</button>
        <button class="chip" onclick="setFilter('hardware', this)">⚙️ 하드웨어/메탈 (10)</button>
        <button class="chip" onclick="setFilter('apptile', this)">📱 앱 타일 (5)</button>
      </div>
    </div>

    <!-- 100 Icons Grid -->
    <div class="icons-grid" id="icons-grid">
      ${icons.map((item, idx) => {
        const filename = `${item.id}-${item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.svg`;
        return `
          <div class="icon-card ${idx === 0 ? 'selected' : ''}"
               id="card-${item.id}"
               data-id="${item.id}"
               data-file="${filename}"
               data-title="${item.title}"
               data-tag="${item.tag}"
               data-num="${item.num}"
               data-category="${item.category}"
               onclick="selectIcon('${item.id}', '${filename}', '${item.num}', '${item.title.replace(/'/g, "\\'")}', '${item.tag.replace(/'/g, "\\'")}')">
            <span class="icon-num">#${String(item.num).padStart(3, '0')}</span>
            <button class="icon-fav-btn" onclick="toggleFav(event, '${item.id}')" id="fav-btn-${item.id}">♥</button>
            <div class="icon-preview-wrap">
              <img src="./${filename}" loading="lazy" alt="${item.title}" />
            </div>
            <div class="icon-title">${item.title}</div>
            <div class="icon-category-tag">${item.catLabel.split(' ')[0]} ${item.tag}</div>
          </div>
        `;
      }).join('')}
    </div>
  </div>

  <script>
    let currentId = 'ap100-001';
    let currentFile = 'ap100-001-hound-snout-prompt-cursor.svg';
    let currentTitle = 'Hound Snout & Prompt Cursor';
    let currentTag = 'Hound Snout / Terminal >';
    let currentFilter = 'all';
    let favorites = new Set();

    function selectIcon(id, file, num, title, tag) {
      currentId = id;
      currentFile = file;
      currentTitle = title;
      currentTag = tag;

      document.querySelectorAll('.icon-card').forEach(c => c.classList.remove('selected'));
      const card = document.getElementById('card-' + id);
      if (card) card.classList.add('selected');

      document.getElementById('cur-title').innerText = '#' + String(num).padStart(3, '0') + ' • ' + title;
      document.getElementById('cur-tag').innerText = tag;

      ['sc-128', 'sc-64', 'sc-32', 'sc-24', 'sc-16'].forEach(scId => {
        document.getElementById(scId).src = './' + file;
      });

      updateFavButtonState();
    }

    function toggleFav(e, id) {
      e.stopPropagation();
      if (favorites.has(id)) {
        favorites.delete(id);
        document.getElementById('fav-btn-' + id)?.classList.remove('favorited');
      } else {
        favorites.add(id);
        document.getElementById('fav-btn-' + id)?.classList.add('favorited');
      }
      document.getElementById('fav-count').innerText = favorites.size;
      updateFavButtonState();
      if (currentFilter === 'fav') filterGrid();
    }

    function toggleCurrentFav() {
      if (favorites.has(currentId)) {
        favorites.delete(currentId);
        document.getElementById('fav-btn-' + currentId)?.classList.remove('favorited');
      } else {
        favorites.add(currentId);
        document.getElementById('fav-btn-' + currentId)?.classList.add('favorited');
      }
      document.getElementById('fav-count').innerText = favorites.size;
      updateFavButtonState();
      if (currentFilter === 'fav') filterGrid();
    }

    function updateFavButtonState() {
      const favBtn = document.getElementById('cur-fav-btn');
      if (favorites.has(currentId)) {
        favBtn.classList.add('active');
        favBtn.innerText = '♥ 찜 취소';
      } else {
        favBtn.classList.remove('active');
        favBtn.innerText = '♥ 찜하기';
      }
    }

    async function copyCurrentSvg() {
      try {
        const res = await fetch('./' + currentFile);
        const text = await res.text();
        await navigator.clipboard.writeText(text);
        alert('SVG 소스코드가 클립보드에 복사되었습니다!\\n' + currentTitle);
      } catch (err) {
        alert('복사 실패: ' + err.message);
      }
    }

    function setFilter(cat, btn) {
      currentFilter = cat;
      document.querySelectorAll('.filter-chips .chip').forEach(c => c.classList.remove('active'));
      if (btn) btn.classList.add('active');
      filterGrid();
    }

    function filterGrid() {
      const q = document.getElementById('search-input').value.toLowerCase().trim();
      const cards = document.querySelectorAll('.icon-card');

      cards.forEach(card => {
        const cat = card.getAttribute('data-category');
        const title = card.getAttribute('data-title').toLowerCase();
        const tag = card.getAttribute('data-tag').toLowerCase();
        const num = card.getAttribute('data-num');
        const id = card.getAttribute('data-id');

        let matchFilter = false;
        if (currentFilter === 'all') matchFilter = true;
        else if (currentFilter === 'fav') matchFilter = favorites.has(id);
        else matchFilter = (cat === currentFilter);

        let matchSearch = !q || title.includes(q) || tag.includes(q) || num.includes(q) || id.includes(q);

        if (matchFilter && matchSearch) {
          card.style.display = 'flex';
        } else {
          card.style.display = 'none';
        }
      });
    }
  </script>
</body>
</html>
`;

writeFileSync(join(outDir, 'aperture-100-icons.html'), html, 'utf8');
console.log('✅ Generated aperture-100-icons.html successfully!');
