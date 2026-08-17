import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';

chdir(fileURLToPath(new URL('../..', import.meta.url)));

const outDir = 'design/logo-concepts';

// 24 Masterpiece 360° Seamless Continuous Gradient Variations for Aperture Triad
const loopVariations = [
  // 1. Full 360° Chromatic Spectrum (Pure Rainbow Cycle)
  {
    id: 'ap-360-01',
    title: '360° Full Chromatic Spectrum',
    category: 'Full Spectrum',
    tag: 'Red -> Green -> Blue -> Red',
    desc: '360도 전 영역을 순환하는 순수 HSL 스펙트럼. 빨강에서 에메랄드, 인디고 블루를 거쳐 다시 빨강으로 완벽하게 이어지는 무한 색상환 루프.',
    bg: '#08090d',
    defs: `
      <linearGradient id="l1-a" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#ff3b30"/><stop offset="50%" stop-color="#ff9500"/><stop offset="100%" stop-color="#34c759"/>
      </linearGradient>
      <linearGradient id="l1-b" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#34c759"/><stop offset="50%" stop-color="#00c7be"/><stop offset="100%" stop-color="#007aff"/>
      </linearGradient>
      <linearGradient id="l1-c" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#007aff"/><stop offset="50%" stop-color="#af52de"/><stop offset="100%" stop-color="#ff3b30"/>
      </linearGradient>
      <radialGradient id="l1-glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#007aff" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#08090d" stop-opacity="0"/>
      </radialGradient>
    `,
    extraBack: `<circle cx="128" cy="128" r="74" fill="url(#l1-glow)" opacity="0.6"/>`,
    paths: [
      { stroke: 'url(#l1-a)', transform: '' },
      { stroke: 'url(#l1-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#l1-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <circle cx="128" cy="128" r="12" fill="#ffffff"/>
      <circle cx="128" cy="128" r="6" fill="#ff3b30"/>
    `
  },

  // 2. Cyber Neon 360° Flow (Cyan -> Violet -> Magenta -> Cyan)
  {
    id: 'ap-360-02',
    title: 'Cyberpunk Neon 360° Endless Flow',
    category: 'Cyber Neon',
    tag: 'Cyan -> Violet -> Hot Pink -> Cyan',
    desc: '일렉트릭 사이언에서 네온 바이올렛, 핫 마젠타 핑크를 거쳐 다시 사이언으로 끊김 없이 연결되는 하이퍼 사이버네틱 360° 루프.',
    bg: '#07080f',
    defs: `
      <linearGradient id="l2-a" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#00f2fe"/><stop offset="100%" stop-color="#7c3aed"/>
      </linearGradient>
      <linearGradient id="l2-b" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#7c3aed"/><stop offset="100%" stop-color="#f43f5e"/>
      </linearGradient>
      <linearGradient id="l2-c" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#00f2fe"/>
      </linearGradient>
      <filter id="l2-glow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="8" result="blur"/>
        <feComposite in="SourceGraphic" in2="blur" operator="over"/>
      </filter>
    `,
    extraBack: ``,
    paths: [
      { stroke: 'url(#l2-a)', transform: '' },
      { stroke: 'url(#l2-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#l2-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 23,
    centerCore: `
      <circle cx="128" cy="128" r="14" fill="#00f2fe" filter="url(#l2-glow)"/>
      <circle cx="128" cy="128" r="9" fill="#7c3aed"/>
      <circle cx="128" cy="128" r="4" fill="#ffffff"/>
    `
  },

  // 3. Sunset Horizon 360° (Amber -> Coral -> Deep Indigo -> Gold)
  {
    id: 'ap-360-03',
    title: 'Sunset Horizon 360° Orbit',
    category: 'Sunset & Flame',
    tag: 'Gold -> Coral Red -> Royal Purple -> Gold',
    desc: '골든 아워의 찬란한 황금빛에서 노을빛 코랄 레드, 밤하늘의 딥 인디고를 지나 다시 태양의 금빛으로 수렴하는 360° 황혼 순환.',
    bg: '#0d0912',
    defs: `
      <linearGradient id="l3-a" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#fbbf24"/><stop offset="60%" stop-color="#f97316"/><stop offset="100%" stop-color="#ef4444"/>
      </linearGradient>
      <linearGradient id="l3-b" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#ef4444"/><stop offset="50%" stop-color="#ec4899"/><stop offset="100%" stop-color="#8b5cf6"/>
      </linearGradient>
      <linearGradient id="l3-c" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#8b5cf6"/><stop offset="50%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#fbbf24"/>
      </linearGradient>
    `,
    extraBack: ``,
    paths: [
      { stroke: 'url(#l3-a)', transform: '' },
      { stroke: 'url(#l3-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#l3-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <circle cx="128" cy="128" r="11" fill="#fbbf24"/>
      <circle cx="128" cy="128" r="4" fill="#ffffff"/>
    `
  },

  // 4. Apple Intelligence / Siri 360° Fluid Iridescent Swirl
  {
    id: 'ap-360-04',
    title: 'Apple Intelligence 360° Iridescent',
    category: 'Siri & Fluid',
    tag: 'Soft Pastel Spectrum 360°',
    desc: 'Apple Intelligence 감성의 유려한 파스텔 오로라. 핑크-퍼플-사이언-앰버가 부드러운 글래스 질감으로 360도 순환하며 산란.',
    bg: '#050608',
    defs: `
      <linearGradient id="l4-a" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#ff7eb6"/><stop offset="60%" stop-color="#be95ff"/><stop offset="100%" stop-color="#78a9ff"/>
      </linearGradient>
      <linearGradient id="l4-b" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#78a9ff"/><stop offset="50%" stop-color="#33b1ff"/><stop offset="100%" stop-color="#42be65"/>
      </linearGradient>
      <linearGradient id="l4-c" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#42be65"/><stop offset="50%" stop-color="#f1c21b"/><stop offset="100%" stop-color="#ff7eb6"/>
      </linearGradient>
      <radialGradient id="l4-glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#be95ff" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#050608" stop-opacity="0"/>
      </radialGradient>
    `,
    extraBack: `<circle cx="128" cy="128" r="80" fill="url(#l4-glow)"/>`,
    paths: [
      { stroke: 'url(#l4-a)', transform: '' },
      { stroke: 'url(#l4-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#l4-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 24,
    centerCore: `
      <circle cx="128" cy="128" r="13" fill="#ffffff" opacity="0.9"/>
      <circle cx="128" cy="128" r="7" fill="#be95ff"/>
    `
  },

  // 5. Deep Ocean Bioluminescence (Mint -> Aqua -> Cobalt -> Emerald)
  {
    id: 'ap-360-05',
    title: 'Bioluminescent Abyss 360°',
    category: 'Ocean & Nature',
    tag: 'Mint -> Deep Cyan -> Cobalt -> Mint',
    desc: '심해 생물 발광에서 영감을 얻은 쿨톤 360° 루프. 네온 민트에서 터키석 아쿠아, 깊은 코발트 블루로 이어져 다시 민트로 환원.',
    bg: '#040b11',
    defs: `
      <linearGradient id="l5-a" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#10b981"/><stop offset="100%" stop-color="#06b6d4"/>
      </linearGradient>
      <linearGradient id="l5-b" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#06b6d4"/><stop offset="100%" stop-color="#2563eb"/>
      </linearGradient>
      <linearGradient id="l5-c" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#2563eb"/><stop offset="60%" stop-color="#059669"/><stop offset="100%" stop-color="#10b981"/>
      </linearGradient>
    `,
    extraBack: ``,
    paths: [
      { stroke: 'url(#l5-a)', transform: '' },
      { stroke: 'url(#l5-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#l5-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <circle cx="128" cy="128" r="12" fill="#06b6d4"/>
      <circle cx="128" cy="128" r="5" fill="#ffffff"/>
    `
  },

  // 6. Plasma Ignition Flame 360° (Pure Yellow -> Magma Red -> Deep Purple -> Yellow)
  {
    id: 'ap-360-06',
    title: 'Plasma Ignition Heat Cycle 360°',
    category: 'Sunset & Flame',
    tag: 'Yellow -> Magma -> Purple -> Yellow',
    desc: '고에너지 플라즈마 점화 열역학 사이클. 레몬 옐로우에서 마그마 오렌지, 초고온 바이올렛 플라즈마로 전환되어 다시 옐로우로 폭발.',
    bg: '#0c0709',
    defs: `
      <linearGradient id="l6-a" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#facc15"/><stop offset="100%" stop-color="#ea580c"/>
      </linearGradient>
      <linearGradient id="l6-b" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#ea580c"/><stop offset="100%" stop-color="#9333ea"/>
      </linearGradient>
      <linearGradient id="l6-c" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#9333ea"/><stop offset="60%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#facc15"/>
      </linearGradient>
    `,
    extraBack: ``,
    paths: [
      { stroke: 'url(#l6-a)', transform: '' },
      { stroke: 'url(#l6-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#l6-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 23,
    centerCore: `
      <circle cx="128" cy="128" r="13" fill="#facc15"/>
      <circle cx="128" cy="128" r="6" fill="#ea580c"/>
      <circle cx="128" cy="128" r="2.5" fill="#ffffff"/>
    `
  },

  // 7. Anthropic Claude Warm Ember 360°
  {
    id: 'ap-360-07',
    title: 'Anthropic Claude Warm Ember 360°',
    category: 'Warm & Minimal',
    tag: 'Terracotta -> Coral -> Sand Gold -> Terracotta',
    desc: 'Claude의 인간적이고 따뜻한 인텔리전스. 웜 테라코타 오렌지에서 딥 코랄, 샌드 골드로 순환하는 360° 아늑한 온열 그라디언트.',
    bg: '#120f0d',
    defs: `
      <linearGradient id="l7-a" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#f97316"/><stop offset="100%" stop-color="#dc2626"/>
      </linearGradient>
      <linearGradient id="l7-b" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#dc2626"/><stop offset="100%" stop-color="#d97706"/>
      </linearGradient>
      <linearGradient id="l7-c" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#d97706"/><stop offset="100%" stop-color="#f97316"/>
      </linearGradient>
    `,
    extraBack: ``,
    paths: [
      { stroke: 'url(#l7-a)', transform: '' },
      { stroke: 'url(#l7-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#l7-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <path d="M128 116 L131 125 L140 128 L131 131 L128 140 L125 131 L116 128 L125 125 Z" fill="#f97316"/>
      <circle cx="128" cy="128" r="3" fill="#ffffff"/>
    `
  },

  // 8. Ghostty Zero-Latency Phosphor Green Loop
  {
    id: 'ap-360-08',
    title: 'Ghostty CRT Phosphor 360° Loop',
    category: 'Terminal & CLI',
    tag: 'Lime 400 -> Emerald 600 -> Jade -> Lime',
    desc: '터미널 해커의 상징 인광체 CRT 그린의 360° 연속 루프. 고휘도 라임 그린에서 딥 에메랄드를 지나 다시 생생한 형광 그린으로 순환.',
    bg: '#040d07',
    defs: `
      <linearGradient id="l8-a" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#a3e635"/><stop offset="100%" stop-color="#22c55e"/>
      </linearGradient>
      <linearGradient id="l8-b" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#22c55e"/><stop offset="100%" stop-color="#047857"/>
      </linearGradient>
      <linearGradient id="l8-c" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#047857"/><stop offset="60%" stop-color="#15803d"/><stop offset="100%" stop-color="#a3e635"/>
      </linearGradient>
      <radialGradient id="l8-glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#22c55e" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#040d07" stop-opacity="0"/>
      </radialGradient>
    `,
    extraBack: `<circle cx="128" cy="128" r="76" fill="url(#l8-glow)"/>`,
    paths: [
      { stroke: 'url(#l8-a)', transform: '' },
      { stroke: 'url(#l8-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#l8-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <rect x="120" y="120" width="16" height="16" rx="4" fill="#a3e635"/>
      <path d="M125 125 L129 128 L125 131" stroke="#040d07" stroke-width="2" fill="none" stroke-linecap="round"/>
    `
  },

  // 9. Comets in Flight / Motion Head-to-Tail 360° Flow
  {
    id: 'ap-360-09',
    title: 'Comet Velocity Head-to-Tail 360°',
    category: 'Motion & Velocity',
    tag: 'Bright Head -> Fading Tail -> Next Comet',
    desc: '3개의 혜성이 120° 시차를 두고 회전하며 에너지를 전달하는 다이내믹 루프. 각 아크의 빛나는 헤드가 다음 아크의 꼬리로 자연스럽게 연결.',
    bg: '#06070a',
    defs: `
      <linearGradient id="l9-a" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="40%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#6366f1" stop-opacity="0.25"/>
      </linearGradient>
      <linearGradient id="l9-b" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="40%" stop-color="#818cf8"/><stop offset="100%" stop-color="#ec4899" stop-opacity="0.25"/>
      </linearGradient>
      <linearGradient id="l9-c" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="40%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#38bdf8" stop-opacity="0.25"/>
      </linearGradient>
    `,
    extraBack: ``,
    paths: [
      { stroke: 'url(#l9-a)', transform: '' },
      { stroke: 'url(#l9-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#l9-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 23,
    centerCore: `
      <circle cx="128" cy="128" r="11" fill="#ffffff"/>
      <circle cx="128" cy="128" r="5" fill="#38bdf8"/>
    `
  },

  // 10. Liquid Titanium 360° Specular Light Sweep
  {
    id: 'ap-360-10',
    title: 'Liquid Titanium Specular 360°',
    category: 'Metallic & Chrome',
    tag: 'Specular Chrome -> Deep Shadow -> Platinum',
    desc: '원형 360도 광원 축을 따라 회전하는 액체 티타늄 크롬 반사. 100% 백열광 하이라이트에서 딥 건메탈 섀도우를 지나 다시 플래티넘으로 연결.',
    bg: '#0c0d12',
    defs: `
      <linearGradient id="l10-a" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="40%" stop-color="#cbd5e1"/><stop offset="100%" stop-color="#475569"/>
      </linearGradient>
      <linearGradient id="l10-b" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#475569"/><stop offset="50%" stop-color="#1e293b"/><stop offset="100%" stop-color="#94a3b8"/>
      </linearGradient>
      <linearGradient id="l10-c" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#94a3b8"/><stop offset="60%" stop-color="#e2e8f0"/><stop offset="100%" stop-color="#ffffff"/>
      </linearGradient>
    `,
    extraBack: ``,
    paths: [
      { stroke: 'url(#l10-a)', transform: '' },
      { stroke: 'url(#l10-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#l10-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <circle cx="128" cy="128" r="12" fill="#e2e8f0"/>
      <circle cx="126" cy="126" r="4" fill="#ffffff"/>
    `
  },

  // 11. Luxury Champagne Gold 360° Sweep
  {
    id: 'ap-360-11',
    title: 'Champagne Gold & Amber 360°',
    category: 'Metallic & Chrome',
    tag: 'White Gold -> Bronze Amber -> Rich Gold',
    desc: '최고급 시계 베젤을 연상시키는 360° 샴페인 골드 순환. 화이트 골드 광채에서 깊은 브론즈 앰버, 리치 골드로 매끄럽게 연결되는 프레스티지 엠블럼.',
    bg: '#0d0c0a',
    defs: `
      <linearGradient id="l11-a" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#fef08a"/><stop offset="100%" stop-color="#d97706"/>
      </linearGradient>
      <linearGradient id="l11-b" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#d97706"/><stop offset="100%" stop-color="#78350f"/>
      </linearGradient>
      <linearGradient id="l11-c" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#78350f"/><stop offset="50%" stop-color="#b45309"/><stop offset="100%" stop-color="#fef08a"/>
      </linearGradient>
    `,
    extraBack: ``,
    paths: [
      { stroke: 'url(#l11-a)', transform: '' },
      { stroke: 'url(#l11-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#l11-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <circle cx="128" cy="128" r="12" fill="#fef08a"/>
      <circle cx="128" cy="128" r="7" fill="#b45309"/>
      <circle cx="128" cy="128" r="3" fill="#ffffff"/>
    `
  },

  // 12. Monochrome Continuous Luminance 360°
  {
    id: 'ap-360-12',
    title: 'Monochrome Infinite Luminance 360°',
    category: 'Warm & Minimal',
    tag: '100% White -> 50% Gray -> 10% Charcoal -> 100% White',
    desc: '컬러를 완전히 배제하고 오직 명도(Luminance)의 360° 연속 변화만으로 조형미를 완성한 궁극의 미니멀리즘. 다크/라이트 모드 모두에 완벽 적응.',
    bg: '#0e0e11',
    defs: `
      <linearGradient id="l12-a" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#94a3b8"/>
      </linearGradient>
      <linearGradient id="l12-b" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#94a3b8"/><stop offset="100%" stop-color="#334155"/>
      </linearGradient>
      <linearGradient id="l12-c" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#334155"/><stop offset="60%" stop-color="#64748b"/><stop offset="100%" stop-color="#ffffff"/>
      </linearGradient>
    `,
    extraBack: ``,
    paths: [
      { stroke: 'url(#l12-a)', transform: '' },
      { stroke: 'url(#l12-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#l12-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <circle cx="128" cy="128" r="12" fill="none" stroke="#ffffff" stroke-width="3"/>
      <circle cx="128" cy="128" r="5" fill="#ffffff"/>
    `
  },

  // 13. Synthwave 80s Laser 360° (Neon Cyan -> Hot Magenta -> Bright Yellow)
  {
    id: 'ap-360-13',
    title: 'Retro Synthwave Laser 360°',
    category: 'Cyber Neon',
    tag: 'Neon Cyan -> Hot Pink -> Solar Yellow -> Cyan',
    desc: '80년대 레트로 신스웨이브 감성의 초고채도 레이저 360° 루프. 네온 사이언, 핫 핑크, 솔라 옐로우가 만들어내는 폭발적인 레트로퓨처리즘 에너지.',
    bg: '#0a0512',
    defs: `
      <linearGradient id="l13-a" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#00f2fe"/><stop offset="100%" stop-color="#ff007f"/>
      </linearGradient>
      <linearGradient id="l13-b" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#ff007f"/><stop offset="100%" stop-color="#ffe600"/>
      </linearGradient>
      <linearGradient id="l13-c" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#ffe600"/><stop offset="100%" stop-color="#00f2fe"/>
      </linearGradient>
    `,
    extraBack: ``,
    paths: [
      { stroke: 'url(#l13-a)', transform: '' },
      { stroke: 'url(#l13-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#l13-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 23,
    centerCore: `
      <polygon points="128,118 138,134 118,134" fill="#ff007f"/>
      <circle cx="128" cy="129" r="3" fill="#ffe600"/>
    `
  },

  // 14. Quantum Prism Refraction 360°
  {
    id: 'ap-360-14',
    title: 'Quantum Prism Refraction 360°',
    category: 'Full Spectrum',
    tag: 'Electric Blue -> Emerald -> Rose -> Blue',
    desc: '양자 광학 프리즘 굴절의 360° 순환. 고굴절 다이아몬드 코어와 3개 아크가 서로의 보색을 반사하며 무한 분광 스펙트럼 생성.',
    bg: '#060810',
    defs: `
      <linearGradient id="l14-a" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#10b981"/>
      </linearGradient>
      <linearGradient id="l14-b" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#10b981"/><stop offset="100%" stop-color="#f43f5e"/>
      </linearGradient>
      <linearGradient id="l14-c" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#3b82f6"/>
      </linearGradient>
    `,
    extraBack: ``,
    paths: [
      { stroke: 'url(#l14-a)', transform: '' },
      { stroke: 'url(#l14-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#l14-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <polygon points="128,117 137,128 128,139 119,128" fill="#ffffff"/>
      <polygon points="128,121 133,128 128,135 123,128" fill="#3b82f6"/>
    `
  },

  // 15. Slim Minimal Hairline 360° Flow (14px Ultra Sharp)
  {
    id: 'ap-360-15',
    title: 'Precision Hairline 360° (14px)',
    category: 'Warm & Minimal',
    tag: 'Ultra-Fine Line 360° Spectral Flow',
    desc: '극도로 정밀한 14px 슬림 헤어라인 아크 위로 360도 스펙트럼이 얇고 선명하게 흐르는 하이엔드 테크니컬 드로잉 에디션.',
    bg: '#08090d',
    defs: `
      <linearGradient id="l15-a" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#00f2fe"/><stop offset="100%" stop-color="#818cf8"/>
      </linearGradient>
      <linearGradient id="l15-b" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#818cf8"/><stop offset="100%" stop-color="#f43f5e"/>
      </linearGradient>
      <linearGradient id="l15-c" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#00f2fe"/>
      </linearGradient>
    `,
    extraBack: `<circle cx="128" cy="128" r="68" fill="none" stroke="#ffffff" stroke-width="0.8" opacity="0.1" stroke-dasharray="3 6"/>`,
    paths: [
      { stroke: 'url(#l15-a)', transform: '' },
      { stroke: 'url(#l15-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#l15-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 14,
    centerCore: `
      <circle cx="128" cy="128" r="8" fill="#00f2fe"/>
      <circle cx="128" cy="128" r="3" fill="#ffffff"/>
    `
  },

  // 16. Ultra Chunky Bold 360° Flow (30px Impact)
  {
    id: 'ap-360-16',
    title: 'Ultra Chunky Bold 360° (30px)',
    category: 'Full Spectrum',
    tag: 'Heavy Stroke 30px Impact Loop',
    desc: '30px의 극단적으로 묵직한 볼드 스트로크를 가득 채우는 360도 파워풀 그라디언트. 16px 파비콘이나 초소형 탭에서도 압도적인 시인성 발휘.',
    bg: '#0a0c12',
    defs: `
      <linearGradient id="l16-a" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#a855f7"/>
      </linearGradient>
      <linearGradient id="l16-b" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#a855f7"/><stop offset="100%" stop-color="#fb7185"/>
      </linearGradient>
      <linearGradient id="l16-c" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#fb7185"/><stop offset="100%" stop-color="#38bdf8"/>
      </linearGradient>
    `,
    extraBack: ``,
    paths: [
      { stroke: 'url(#l16-a)', transform: '' },
      { stroke: 'url(#l16-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#l16-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 30,
    centerCore: `
      <circle cx="128" cy="128" r="14" fill="#ffffff"/>
      <circle cx="128" cy="128" r="7" fill="#38bdf8"/>
    `
  },

  // 17. Light Ceramic Pure Clean 360° (Light Mode Specialist)
  {
    id: 'ap-360-17',
    title: 'Light Ceramic Pure Clean 360°',
    category: 'Warm & Minimal',
    tag: 'Light Tile / Pastel Spectrum 360°',
    desc: '순백의 세라믹 라이트 타일 위에서 청명하게 회전하는 360도 파스텔 스펙트럼. 라이트 모드 IDE 및 화이트 문서에 최적화된 화사한 비주얼.',
    bg: '#f8fafc',
    border: '#e2e8f0',
    defs: `
      <linearGradient id="l17-a" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#0284c7"/><stop offset="100%" stop-color="#7c3aed"/>
      </linearGradient>
      <linearGradient id="l17-b" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#7c3aed"/><stop offset="100%" stop-color="#e11d48"/>
      </linearGradient>
      <linearGradient id="l17-c" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#e11d48"/><stop offset="100%" stop-color="#0284c7"/>
      </linearGradient>
    `,
    extraBack: ``,
    paths: [
      { stroke: 'url(#l17-a)', transform: '' },
      { stroke: 'url(#l17-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#l17-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <circle cx="128" cy="128" r="12" fill="#0f172a"/>
      <circle cx="128" cy="128" r="5" fill="#f8fafc"/>
    `
  },

  // 18. Neon Triad Core / Multi-Segment Center Dot 360°
  {
    id: 'ap-360-18',
    title: 'Tri-Segment Multi-Core 360°',
    category: 'Cyber Neon',
    tag: '3-Piece Core matches 3 Outer Arcs',
    desc: '중앙 코어까지 3분할되어 3개 아크의 360도 컬러 흐름과 1:1로 정확히 조응하는 완벽한 기하학적 일체감의 마스터 에디션.',
    bg: '#08090e',
    defs: `
      <linearGradient id="l18-a" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#00f2fe"/><stop offset="100%" stop-color="#38bdf8"/>
      </linearGradient>
      <linearGradient id="l18-b" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#c084fc"/>
      </linearGradient>
      <linearGradient id="l18-c" x1="0%" y1="0%" x2="100%" y2="60%">
        <stop offset="0%" stop-color="#c084fc"/><stop offset="100%" stop-color="#00f2fe"/>
      </linearGradient>
    `,
    extraBack: ``,
    paths: [
      { stroke: 'url(#l18-a)', transform: '' },
      { stroke: 'url(#l18-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#l18-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <circle cx="128" cy="120" r="5" fill="#00f2fe"/>
      <circle cx="135" cy="132" r="5" fill="#38bdf8"/>
      <circle cx="121" cy="132" r="5" fill="#c084fc"/>
    `
  }
];

// Generate all individual SVGs
for (const v of loopVariations) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    ${v.defs}
  </defs>
  <rect width="256" height="256" rx="60" fill="${v.bg}" ${v.border ? `stroke="${v.border}" stroke-width="2"` : ''}/>
  ${v.extraBack || ''}
  <g fill="none" stroke-width="${v.strokeWidth}" stroke-linecap="round">
    <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="${v.paths[0].stroke}" ${v.paths[0].transform}/>
    <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="${v.paths[1].stroke}" ${v.paths[1].transform}/>
    <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="${v.paths[2].stroke}" ${v.paths[2].transform}/>
  </g>
  ${v.centerCore}
</svg>`;

  writeFileSync(join(outDir, `${v.id}.svg`), svg, 'utf8');
}

console.log(`Generated ${loopVariations.length} 360° Seamless Gradient Aperture Triad SVGs!`);

// Generate HTML Showcase
const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mixdog Aperture Triad 360° Seamless Gradient Lab</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #06070a;
      --bg-surface: #0c0e14;
      --bg-card: #11141e;
      --bg-card-hover: #171c2b;
      --border: rgba(255, 255, 255, 0.08);
      --border-accent: rgba(56, 189, 248, 0.5);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --cyan: #38bdf8;
      --indigo: #818cf8;
      --violet: #c084fc;
      --pink: #f43f5e;
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

    /* Ambient 360° Chromatic Halo Background */
    .bg-grid {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background-image: 
        radial-gradient(circle at 50% 0%, rgba(56, 189, 248, 0.15) 0%, transparent 60%),
        radial-gradient(circle at 85% 30%, rgba(244, 63, 94, 0.1) 0%, transparent 50%),
        radial-gradient(circle at 15% 40%, rgba(16, 185, 129, 0.1) 0%, transparent 50%),
        linear-gradient(rgba(255, 255, 255, 0.02) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.02) 1px, transparent 1px);
      background-size: 100% 100%, 100% 100%, 100% 100%, 40px 40px, 40px 40px;
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

    /* Header */
    header {
      text-align: center;
      margin-bottom: 48px;
    }

    .pill-badge {
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
      margin-bottom: 18px;
      box-shadow: 0 0 24px rgba(56, 189, 248, 0.2);
    }

    .pill-badge .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--cyan);
      box-shadow: 0 0 10px var(--cyan);
    }

    h1 {
      font-size: 46px;
      font-weight: 800;
      letter-spacing: -0.03em;
      line-height: 1.15;
      margin-bottom: 14px;
      background: linear-gradient(135deg, #ffffff 20%, #38bdf8 60%, #c084fc 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .subtitle {
      font-size: 17px;
      color: var(--text-muted);
      max-width: 860px;
      margin: 0 auto 28px;
    }

    /* Live Scale Tester Panel */
    .tester-panel {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      padding: 28px 36px;
      margin-bottom: 56px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
    }

    .tester-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 16px;
    }

    .tester-title {
      font-size: 16px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .scale-row {
      display: flex;
      align-items: center;
      justify-content: space-around;
      gap: 24px;
      flex-wrap: wrap;
      padding: 24px;
      background: #07080c;
      border-radius: var(--radius-lg);
      border: 1px solid rgba(255, 255, 255, 0.04);
    }

    .scale-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }

    .scale-item span {
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-dim);
    }

    /* Filter Bar */
    .filter-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 32px;
      flex-wrap: wrap;
      gap: 16px;
    }

    .filter-chips {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .chip {
      padding: 7px 16px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.2s;
    }

    .chip:hover, .chip.active {
      background: var(--cyan);
      color: #000;
      border-color: var(--cyan);
      font-weight: 700;
      box-shadow: 0 0 16px rgba(56, 189, 248, 0.3);
    }

    /* Grid */
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 24px;
    }

    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 24px;
      display: flex;
      flex-direction: column;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      cursor: pointer;
      position: relative;
      overflow: hidden;
    }

    .card:hover {
      transform: translateY(-6px);
      border-color: var(--border-accent);
      background: var(--bg-card-hover);
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6), 0 0 24px rgba(56, 189, 248, 0.15);
    }

    .card-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .badge-cat {
      font-size: 11px;
      font-weight: 700;
      padding: 3px 10px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--text-muted);
    }

    .badge-tag {
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      color: var(--cyan);
    }

    .img-wrap {
      background: #080a0f;
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: var(--radius-md);
      height: 200px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 18px;
    }

    .img-wrap img {
      width: 140px;
      height: 140px;
      transition: transform 0.3s ease;
      filter: drop-shadow(0 10px 20px rgba(0,0,0,0.5));
    }

    .card:hover .img-wrap img {
      transform: scale(1.08);
    }

    .card h3 {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 8px;
    }

    .card p {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.55;
      margin-bottom: 16px;
      flex-grow: 1;
    }

    .card-actions {
      display: flex;
      gap: 10px;
      margin-top: auto;
      padding-top: 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }

    .btn {
      flex: 1;
      padding: 8px 12px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
      text-align: center;
      text-decoration: none;
    }

    .btn-primary {
      background: rgba(56, 189, 248, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.3);
      color: var(--cyan);
    }

    .btn-primary:hover {
      background: var(--cyan);
      color: #000;
      font-weight: 700;
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--text-muted);
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
      color: var(--text);
    }

    /* Modal */
    .modal-backdrop {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(16px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 100;
      padding: 24px;
    }

    .modal-backdrop.open { display: flex; }

    .modal-card {
      background: #0f121a;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: var(--radius-xl);
      max-width: 760px;
      width: 100%;
      padding: 36px;
      position: relative;
      box-shadow: 0 32px 80px rgba(0,0,0,0.8);
    }

    .modal-close {
      position: absolute;
      top: 20px; right: 20px;
      background: rgba(255, 255, 255, 0.08);
      border: none;
      color: #fff;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      font-size: 16px;
      cursor: pointer;
      display: grid;
      place-items: center;
    }

    .modal-flex {
      display: flex;
      gap: 32px;
      align-items: center;
      flex-wrap: wrap;
    }

    .modal-hero {
      width: 220px;
      height: 220px;
      background: #07080c;
      border-radius: 20px;
      padding: 20px;
      border: 1px solid rgba(255,255,255,0.08);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .modal-hero img { width: 100%; height: 100%; }

    .modal-details {
      flex: 1;
      min-width: 280px;
    }
  </style>
</head>
<body>
  <div class="bg-grid"></div>

  <div class="container">
    <header>
      <div class="pill-badge">
        <div class="dot"></div>
        <span>360° Endless Chromatic Orbit Suite</span>
      </div>
      <h1>Aperture Triad 360° Seamless Gradient Lab</h1>
      <p class="subtitle">
        131번 Aperture Triad의 3개 아크가 120°씩 회전하며 <strong>360도 전 영역을 끊김 없이 하나로 이어지는 완벽한 폐곡선 컬러 루프</strong>로 연결된 에디션입니다.<br>
        (Arc 1: A &rarr; B, Arc 2: B &rarr; C, Arc 3: C &rarr; A 로 수렴하는 무한 순환 그라데이션)
      </p>
    </header>

    <!-- Scale & Legibility Live Inspector -->
    <div class="tester-panel">
      <div class="tester-header">
        <div class="tester-title">
          <span>🔍 실시간 멀티 스케일 시인성 뷰어:</span>
          <strong id="active-title" style="color: var(--cyan);">${loopVariations[0].title}</strong>
        </div>
      </div>
      <div class="scale-row">
        <div class="scale-item">
          <img id="scale-128" src="./${loopVariations[0].id}.svg" style="width: 128px; height: 128px;" />
          <span>128px (Hero App Tile)</span>
        </div>
        <div class="scale-item">
          <img id="scale-64" src="./${loopVariations[0].id}.svg" style="width: 64px; height: 64px;" />
          <span>64px (macOS Dock)</span>
        </div>
        <div class="scale-item">
          <img id="scale-32" src="./${loopVariations[0].id}.svg" style="width: 32px; height: 32px;" />
          <span>32px (Toolbar)</span>
        </div>
        <div class="scale-item">
          <img id="scale-24" src="./${loopVariations[0].id}.svg" style="width: 24px; height: 24px;" />
          <span>24px (Editor Tab)</span>
        </div>
        <div class="scale-item">
          <img id="scale-16" src="./${loopVariations[0].id}.svg" style="width: 16px; height: 16px;" />
          <span>16px (CLI Favicon)</span>
        </div>
      </div>
    </div>

    <!-- Filter Bar -->
    <div class="filter-bar">
      <div class="filter-chips">
        <button class="chip active" onclick="filterCategory('all', this)">전체 (${loopVariations.length})</button>
        <button class="chip" onclick="filterCategory('Full Spectrum', this)">🌈 Full Spectrum</button>
        <button class="chip" onclick="filterCategory('Cyber Neon', this)">⚡ Cyber Neon</button>
        <button class="chip" onclick="filterCategory('Sunset & Flame', this)">🔥 Sunset & Flame</button>
        <button class="chip" onclick="filterCategory('Siri & Fluid', this)">✨ Siri & Fluid</button>
        <button class="chip" onclick="filterCategory('Ocean & Nature', this)">🌊 Ocean & Nature</button>
        <button class="chip" onclick="filterCategory('Terminal & CLI', this)">💻 Terminal & CLI</button>
        <button class="chip" onclick="filterCategory('Metallic & Chrome', this)">🪙 Metallic Chrome</button>
        <button class="chip" onclick="filterCategory('Warm & Minimal', this)">☕ Warm & Minimal</button>
      </div>
    </div>

    <!-- 360 Variations Grid -->
    <div class="grid" id="card-grid">
      ${loopVariations.map(v => `
        <div class="card" data-cat="${v.category}" onclick="selectVariation('${v.id}', '${v.title}')">
          <div class="card-top">
            <span class="badge-cat">${v.category}</span>
            <span class="badge-tag">${v.tag}</span>
          </div>
          <div class="img-wrap">
            <img src="./${v.id}.svg" alt="${v.title}" />
          </div>
          <h3>${v.title}</h3>
          <p>${v.desc}</p>
          <div class="card-actions">
            <button class="btn btn-primary" onclick="event.stopPropagation(); copySvgCode('${v.id}.svg')">📋 SVG 복사</button>
            <a class="btn btn-secondary" href="./${v.id}.svg" download="${v.id}.svg" onclick="event.stopPropagation()">⬇️ 다운로드</a>
          </div>
        </div>
      `).join('')}
    </div>
  </div>

  <script>
    function selectVariation(id, title) {
      document.getElementById('active-title').innerText = title;
      const file = './' + id + '.svg';
      document.getElementById('scale-128').src = file;
      document.getElementById('scale-64').src = file;
      document.getElementById('scale-32').src = file;
      document.getElementById('scale-24').src = file;
      document.getElementById('scale-16').src = file;
      window.scrollTo({ top: 180, behavior: 'smooth' });
    }

    function filterCategory(cat, btn) {
      document.querySelectorAll('.filter-chips .chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');

      const cards = document.querySelectorAll('.card');
      cards.forEach(card => {
        const itemCat = card.getAttribute('data-cat');
        if (cat === 'all' || itemCat === cat) {
          card.style.display = 'flex';
        } else {
          card.style.display = 'none';
        }
      });
    }

    async function copySvgCode(filename) {
      try {
        const res = await fetch('./' + filename);
        const text = await res.text();
        await navigator.clipboard.writeText(text);
        alert(filename + ' SVG 코드가 클립보드에 복사되었습니다!');
      } catch (err) {
        alert('복사 실패: ' + err.message);
      }
    }
  </script>
</body>
</html>
`;

writeFileSync(join(outDir, 'aperture-360-loop.html'), html, 'utf8');
console.log('✅ Generated aperture-360-loop.html successfully!');
