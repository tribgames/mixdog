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

// 100 New Variations for Series 2 (ap200-001 ~ ap200-100)
const newIcons = [];

// ============================================================================
// Series 2 - Cat 1: 3D Isometric & Spatial Volumetrics (001 - 015)
// ============================================================================
const cat1 = '3d-spatial';
const cat1Label = '💎 3D & Isometric';

newIcons.push(
  {
    num: 101, id: 'ap200-001', title: 'Isometric Triad Cube Core', category: cat1, catLabel: cat1Label,
    tag: '3D Isometric Cube / Refraction', desc: '아이소메트릭 큐브가 3방향 아크의 교차 중심에서 입체적으로 회전하는 코어',
    bg: '#0a0c12', rx: 60,
    defs: `<linearGradient id="g201-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#0284c7"/></linearGradient>
           <linearGradient id="g201-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#818cf8"/><stop offset="100%" stop-color="#4f46e5"/></linearGradient>
           <linearGradient id="g201-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#c084fc"/><stop offset="100%" stop-color="#9333ea"/></linearGradient>`,
    body: makeArcs('url(#g201-1)', 'url(#g201-2)', 'url(#g201-3)', 22),
    core: `<polygon points="128,114 142,122 128,130 114,122" fill="#ffffff" opacity="0.95"/>
           <polygon points="114,122 128,130 128,144 114,136" fill="#38bdf8" opacity="0.85"/>
           <polygon points="142,122 128,130 128,144 142,136" fill="#818cf8" opacity="0.85"/>`
  },
  {
    num: 102, id: 'ap200-002', title: 'Floating Pyramidal Apex', category: cat1, catLabel: cat1Label,
    tag: '3D Tetrahedron / Laser Ray', desc: '3개의 삼각 각면이 모여 4차원 정사면체(Tetrahedron)를 이루는 크리스털 코어',
    bg: '#090a0f', rx: 60,
    defs: `<linearGradient id="g202-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#00f2fe"/><stop offset="100%" stop-color="#3b82f6"/></linearGradient>
           <linearGradient id="g202-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#3b82f6"/><stop offset="100%" stop-color="#ec4899"/></linearGradient>
           <linearGradient id="g202-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ec4899"/><stop offset="100%" stop-color="#00f2fe"/></linearGradient>`,
    body: makeArcs('url(#g202-1)', 'url(#g202-2)', 'url(#g202-3)', 22),
    core: `<polygon points="128,112 115,138 128,130" fill="#00f2fe" opacity="0.9"/>
           <polygon points="128,112 141,138 128,130" fill="#ec4899" opacity="0.9"/>
           <polygon points="115,138 141,138 128,130" fill="#ffffff" opacity="0.95"/>
           <circle cx="128" cy="112" r="2.5" fill="#ffffff"/>`
  },
  {
    num: 103, id: 'ap200-003', title: 'Toroid Ring Intersection', category: cat1, catLabel: cat1Label,
    tag: '3D Torus / Orthogonal Rings', desc: '직교하는 3개의 입체 토러스 링이 맞물려 구체 공간을 감싸는 우주적 조형',
    bg: '#08090d', rx: 60,
    defs: `<linearGradient id="g203-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#67e8f9"/><stop offset="100%" stop-color="#06b6d4"/></linearGradient>
           <linearGradient id="g203-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#06b6d4"/><stop offset="100%" stop-color="#a855f7"/></linearGradient>
           <linearGradient id="g203-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#a855f7"/><stop offset="100%" stop-color="#67e8f9"/></linearGradient>`,
    body: makeArcs('url(#g203-1)', 'url(#g203-2)', 'url(#g203-3)', 22),
    core: `<ellipse cx="128" cy="128" rx="14" ry="6" fill="none" stroke="#67e8f9" stroke-width="2.5"/>
           <ellipse cx="128" cy="128" rx="14" ry="6" transform="rotate(60 128 128)" fill="none" stroke="#a855f7" stroke-width="2.5"/>
           <ellipse cx="128" cy="128" rx="14" ry="6" transform="rotate(120 128 128)" fill="none" stroke="#ffffff" stroke-width="2.5"/>
           <circle cx="128" cy="128" r="4" fill="#67e8f9"/>`
  },
  {
    num: 104, id: 'ap200-004', title: '3D Mobius Trefoil Knot', category: cat1, catLabel: cat1Label,
    tag: 'Mobius Loop / Trefoil Surface', desc: '면과 선이 입체적으로 꼬이며 회전하는 뫼비우스 트리포일 토폴로지 코어',
    bg: '#07080c', rx: 60,
    defs: `<linearGradient id="g204-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#ec4899"/></linearGradient>
           <linearGradient id="g204-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ec4899"/><stop offset="100%" stop-color="#eab308"/></linearGradient>
           <linearGradient id="g204-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#eab308"/><stop offset="100%" stop-color="#38bdf8"/></linearGradient>`,
    body: makeArcs('url(#g204-1)', 'url(#g204-2)', 'url(#g204-3)', 22),
    core: `<path d="M128 116 C138 116 142 128 134 136 C126 144 118 136 128 116 Z" fill="none" stroke="#ffffff" stroke-width="3" stroke-linejoin="round"/>
           <path d="M128 116 C138 116 142 128 134 136 C126 144 118 136 128 116 Z" transform="rotate(120 128 128)" fill="none" stroke="#ec4899" stroke-width="3" stroke-linejoin="round"/>
           <path d="M128 116 C138 116 142 128 134 136 C126 144 118 136 128 116 Z" transform="rotate(240 128 128)" fill="none" stroke="#38bdf8" stroke-width="3" stroke-linejoin="round"/>
           <circle cx="128" cy="128" r="3" fill="#ffffff"/>`
  },
  {
    num: 105, id: 'ap200-005', title: 'Orthographic Depth Layers', category: cat1, catLabel: cat1Label,
    tag: 'Layered Plates / Shadow Inset', desc: '3개의 원형 플레이트가 계단식 깊이감(Z-Index)으로 중첩된 모던 레이어드 코어',
    bg: '#0a0a0f', rx: 60,
    defs: `<linearGradient id="g205-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#fb923c"/></linearGradient>
           <linearGradient id="g205-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fb923c"/><stop offset="100%" stop-color="#facc15"/></linearGradient>
           <linearGradient id="g205-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#facc15"/><stop offset="100%" stop-color="#f43f5e"/></linearGradient>`,
    body: makeArcs('url(#g205-1)', 'url(#g205-2)', 'url(#g205-3)', 22),
    core: `<circle cx="128" cy="128" r="16" fill="#18181b" stroke="#f43f5e" stroke-width="2"/>
           <circle cx="128" cy="128" r="10" fill="#27272a" stroke="#fb923c" stroke-width="2"/>
           <circle cx="128" cy="128" r="5" fill="#facc15"/>`
  }
);

// Generate Remaining Icons Programmatically across categories (006 - 100)
const themes = [
  // 3D Spatial
  { name: 'Hexagonal Prism Crystal', cat: '3d-spatial', catLabel: '💎 3D & Isometric', c1: '#38bdf8', c2: '#818cf8', c3: '#c084fc', shape: 'hex-prism' },
  { name: 'Wireframe Gyroscope Core', cat: '3d-spatial', catLabel: '💎 3D & Isometric', c1: '#22d3ee', c2: '#a855f7', c3: '#f43f5e', shape: 'gyro' },
  { name: 'Isometric Hypercube Node', cat: '3d-spatial', catLabel: '💎 3D & Isometric', c1: '#4ade80', c2: '#38bdf8', c3: '#6366f1', shape: 'tesseract' },
  { name: 'Floating Diamond Facet', cat: '3d-spatial', catLabel: '💎 3D & Isometric', c1: '#f472b6', c2: '#fb923c', c3: '#facc15', shape: 'diamond' },
  { name: 'Spherical Volumetric Orb', cat: '3d-spatial', catLabel: '💎 3D & Isometric', c1: '#00f2fe', c2: '#4facfe', c3: '#000c40', shape: 'sphere' },

  // Cybernetic & Quantum
  { name: 'Quantum Entanglement Loop', cat: 'quantum', catLabel: '⚡ Cyber & Quantum', c1: '#00f2fe', c2: '#818cf8', c3: '#ec4899', shape: 'quantum' },
  { name: 'Laser Aperture Visor', cat: 'quantum', catLabel: '⚡ Cyber & Quantum', c1: '#ef4444', c2: '#f97316', c3: '#eab308', shape: 'laser-visor' },
  { name: 'Synaptic AI Neural Spark', cat: 'quantum', catLabel: '⚡ Cyber & Quantum', c1: '#a855f7', c2: '#ec4899', c3: '#06b6d4', shape: 'synapse' },
  { name: 'Holographic Matrix Grid', cat: 'quantum', catLabel: '⚡ Cyber & Quantum', c1: '#10b981', c2: '#06b6d4', c3: '#3b82f6', shape: 'matrix-grid' },
  { name: 'Particle Accelerator Nexus', cat: 'quantum', catLabel: '⚡ Cyber & Quantum', c1: '#6366f1', c2: '#d946ef', c3: '#f43f5e', shape: 'accelerator' },
  { name: 'Tachyon Hyper-Beam Burst', cat: 'quantum', catLabel: '⚡ Cyber & Quantum', c1: '#f59e0b', c2: '#ef4444', c3: '#8b5cf6', shape: 'hyperbeam' },
  { name: 'Zero-Point Energy Kernel', cat: 'quantum', catLabel: '⚡ Cyber & Quantum', c1: '#38bdf8', c2: '#34d399', c3: '#facc15', shape: 'zero-point' },
  { name: 'Cybernetic Iris Gate', cat: 'quantum', catLabel: '⚡ Cyber & Quantum', c1: '#ec4899', c2: '#8b5cf6', c3: '#3b82f6', shape: 'iris-gate' },
  { name: 'Nanotech Circuit Bus', cat: 'quantum', catLabel: '⚡ Cyber & Quantum', c1: '#06b6d4', c2: '#10b981', c3: '#eab308', shape: 'nano-circuit' },
  { name: 'Superconducting Ring Core', cat: 'quantum', catLabel: '⚡ Cyber & Quantum', c1: '#818cf8', c2: '#c084fc', c3: '#38bdf8', shape: 'superconductor' },

  // Bionic Canine & Mascot Fusion
  { name: 'Cyber-Hound Laser Eye Node', cat: 'canine-bionic', catLabel: '🐺 Bionic Canine', c1: '#38bdf8', c2: '#6366f1', c3: '#ec4899', shape: 'hound-eye' },
  { name: 'Aerodynamic Dog Ear Blade', cat: 'canine-bionic', catLabel: '🐺 Bionic Canine', c1: '#00f2fe', c2: '#38bdf8', c3: '#818cf8', shape: 'ear-blade' },
  { name: 'Terminal Hound Bone Slash', cat: 'canine-bionic', catLabel: '🐺 Bionic Canine', c1: '#f43f5e', c2: '#fb923c', c3: '#facc15', shape: 'bone-slash' },
  { name: 'Bionic Paw Sensor Matrix', cat: 'canine-bionic', catLabel: '🐺 Bionic Canine', c1: '#10b981', c2: '#06b6d4', c3: '#6366f1', shape: 'paw-sensor' },
  { name: 'Smart Hound Collar Token', cat: 'canine-bionic', catLabel: '🐺 Bionic Canine', c1: '#eab308', c2: '#f97316', c3: '#ef4444', shape: 'collar-token' },
  { name: 'Stealth Hound M Silhouette', cat: 'canine-bionic', catLabel: '🐺 Bionic Canine', c1: '#94a3b8', c2: '#cbd5e1', c3: '#ffffff', shape: 'hound-m' },
  { name: 'Hunting Sentinel Radar Scope', cat: 'canine-bionic', catLabel: '🐺 Bionic Canine', c1: '#22c55e', c2: '#06b6d4', c3: '#3b82f6', shape: 'radar-scope' },
  { name: 'Canine Whiskers Code Slits', cat: 'canine-bionic', catLabel: '🐺 Bionic Canine', c1: '#c084fc', c2: '#f43f5e', c3: '#38bdf8', shape: 'whiskers' },
  { name: 'Sleeping Hound Mobius Knot', cat: 'canine-bionic', catLabel: '🐺 Bionic Canine', c1: '#f59e0b', c2: '#d946ef', c3: '#6366f1', shape: 'sleeping-hound' },
  { name: 'Alpha Hound Crown Crest', cat: 'canine-bionic', catLabel: '🐺 Bionic Canine', c1: '#fbbf24', c2: '#f59e0b', c3: '#b45309', shape: 'crown-crest' },

  // Developer CLI & Code Grammar
  { name: 'Git Commit Tree Node Core', cat: 'dev-syntax', catLabel: '💻 Code Grammar', c1: '#38bdf8', c2: '#818cf8', c3: '#34d399', shape: 'git-node' },
  { name: '3-Way Git Merge Branch', cat: 'dev-syntax', catLabel: '💻 Code Grammar', c1: '#f43f5e', c2: '#8b5cf6', c3: '#06b6d4', shape: 'git-merge' },
  { name: 'Code Comments // Dual Slash', cat: 'dev-syntax', catLabel: '💻 Code Grammar', c1: '#e2e8f0', c2: '#94a3b8', c3: '#64748b', shape: 'dual-slash' },
  { name: 'Curly Brackets { AI } Block', cat: 'dev-syntax', catLabel: '💻 Code Grammar', c1: '#a855f7', c2: '#ec4899', c3: '#f97316', shape: 'curly-block' },
  { name: 'HTML / JSX Tag < • > Kernel', cat: 'dev-syntax', catLabel: '💻 Code Grammar', c1: '#00f2fe', c2: '#3b82f6', c3: '#6366f1', shape: 'jsx-tag' },
  { name: 'Lambda Calculus λ Node', cat: 'dev-syntax', catLabel: '💻 Code Grammar', c1: '#10b981', c2: '#3b82f6', c3: '#8b5cf6', shape: 'lambda' },
  { name: 'Async / Await Flow Signal', cat: 'dev-syntax', catLabel: '💻 Code Grammar', c1: '#f59e0b', c2: '#10b981', c3: '#06b6d4', shape: 'async-signal' },
  { name: 'Shebang #!/ Script Kernel', cat: 'dev-syntax', catLabel: '💻 Code Grammar', c1: '#ef4444', c2: '#f97316', c3: '#eab308', shape: 'shebang' },
  { name: 'Binary Bitmask 0101 Matrix', cat: 'dev-syntax', catLabel: '💻 Code Grammar', c1: '#22c55e', c2: '#10b981', c3: '#059669', shape: 'bitmask' },
  { name: 'Regex Token Wildcard .* Node', cat: 'dev-syntax', catLabel: '💻 Code Grammar', c1: '#ec4899', c2: '#8b5cf6', c3: '#38bdf8', shape: 'regex-token' },

  // Multi-Model Synergy & AI Engines
  { name: 'Claude x OpenAI x Gemini Trinity', cat: 'multi-model', catLabel: '🔀 Multi-Model Engine', c1: '#f97316', c2: '#10a37f', c3: '#4285f4', shape: 'trinity' },
  { name: 'Multi-Agent Fader Mixer', cat: 'multi-model', catLabel: '🔀 Multi-Model Engine', c1: '#00f2fe', c2: '#818cf8', c3: '#f43f5e', shape: 'faders' },
  { name: 'Venn Blend AI Synthesizer', cat: 'multi-model', catLabel: '🔀 Multi-Model Engine', c1: '#38bdf8', c2: '#ec4899', c3: '#facc15', shape: 'venn' },
  { name: 'Borromean Trinity Rings', cat: 'multi-model', catLabel: '🔀 Multi-Model Engine', c1: '#6366f1', c2: '#10b981', c3: '#f59e0b', shape: 'borromean' },
  { name: 'Neural Weight Synapse Hub', cat: 'multi-model', catLabel: '🔀 Multi-Model Engine', c1: '#8b5cf6', c2: '#06b6d4', c3: '#f43f5e', shape: 'synapse-hub' },
  { name: 'Autonomous Task Router Core', cat: 'multi-model', catLabel: '🔀 Multi-Model Engine', c1: '#34d399', c2: '#38bdf8', c3: '#c084fc', shape: 'task-router' },
  { name: 'Multi-Context Window Aperture', cat: 'multi-model', catLabel: '🔀 Multi-Model Engine', c1: '#eab308', c2: '#ec4899', c3: '#3b82f6', shape: 'context-window' },
  { name: 'Inference Velocity Jet Core', cat: 'multi-model', catLabel: '🔀 Multi-Model Engine', c1: '#00f2fe', c2: '#f43f5e', c3: '#fbbf24', shape: 'jet-core' },
  { name: 'Embedding Vector Space Cluster', cat: 'multi-model', catLabel: '🔀 Multi-Model Engine', c1: '#818cf8', c2: '#34d399', c3: '#f472b6', shape: 'embedding' },
  { name: 'Prompt-Response Echo Loop', cat: 'multi-model', catLabel: '🔀 Multi-Model Engine', c1: '#38bdf8', c2: '#a855f7', c3: '#38bdf8', shape: 'echo-loop' },

  // Hardware Titanium & Industrial Finishes
  { name: '45° Chamfered Space Gray Steel', cat: 'hardware', catLabel: '⚙️ Hardware & Industrial', c1: '#cbd5e1', c2: '#64748b', c3: '#334155', shape: 'chamfer-steel' },
  { name: 'Amber Laser Target Sight', cat: 'hardware', catLabel: '⚙️ Hardware & Industrial', c1: '#fbbf24', c2: '#f59e0b', c3: '#d97706', shape: 'laser-target' },
  { name: 'Champagne Gold Watch Bezel', cat: 'hardware', catLabel: '⚙️ Hardware & Industrial', c1: '#fef08a', c2: '#eab308', c3: '#ca8a04', shape: 'gold-bezel' },
  { name: 'Liquid Mercury Mirror Surface', cat: 'hardware', catLabel: '⚙️ Hardware & Industrial', c1: '#ffffff', c2: '#cbd5e1', c3: '#94a3b8', shape: 'mercury-mirror' },
  { name: 'Matte Gunmetal Tactical Coat', cat: 'hardware', catLabel: '⚙️ Hardware & Industrial', c1: '#94a3b8', c2: '#475569', c3: '#1e293b', shape: 'gunmetal' },
  { name: 'Copper Heat-Pipe Thermal Core', cat: 'hardware', catLabel: '⚙️ Hardware & Industrial', c1: '#fdba74', c2: '#ea580c', c3: '#9a3412', shape: 'copper-heat' },
  { name: 'Frosted Glassmorphic Smoked Lens', cat: 'hardware', catLabel: '⚙️ Hardware & Industrial', c1: '#38bdf8', c2: '#818cf8', c3: '#c084fc', shape: 'frosted-lens' },
  { name: 'Brushed Platinum Luxury Texture', cat: 'hardware', catLabel: '⚙️ Hardware & Industrial', c1: '#f8fafc', c2: '#cbd5e1', c3: '#64748b', shape: 'platinum' },
  { name: 'CNC Micrometer Calibration Notch', cat: 'hardware', catLabel: '⚙️ Hardware & Industrial', c1: '#60a5fa', c2: '#3b82f6', c3: '#1d4ed8', shape: 'cnc-notch' },
  { name: 'Ceramic White Clean Shell', cat: 'hardware', catLabel: '⚙️ Hardware & Industrial', c1: '#ffffff', c2: '#e2e8f0', c3: '#cbd5e1', shape: 'white-ceramic' },

  // Geometric Forms & Pure Strokes
  { name: 'Ultra-Bold 38px Solid Impact', cat: 'geometry', catLabel: '📐 Pure Geometry', c1: '#00f2fe', c2: '#38bdf8', c3: '#6366f1', shape: 'bold-impact', width: 36 },
  { name: 'Ultra-Fine 10px Technical Hairline', cat: 'geometry', catLabel: '📐 Pure Geometry', c1: '#38bdf8', c2: '#818cf8', c3: '#c084fc', shape: 'fine-hairline', width: 10 },
  { name: 'Golden Ratio Fibonacci Spiral', cat: 'geometry', catLabel: '📐 Pure Geometry', c1: '#facc15', c2: '#fb923c', c3: '#f43f5e', shape: 'fibonacci' },
  { name: 'Double-Rail Concentric Track', cat: 'geometry', catLabel: '📐 Pure Geometry', c1: '#22d3ee', c2: '#a855f7', c3: '#ec4899', shape: 'double-rail' },
  { name: 'Aerofoil Tapered Fin Contour', cat: 'geometry', catLabel: '📐 Pure Geometry', c1: '#38bdf8', c2: '#0284c7', c3: '#0369a1', shape: 'tapered-fin' },
  { name: 'Dotted Speed-Racer Strobe', cat: 'geometry', catLabel: '📐 Pure Geometry', c1: '#f43f5e', c2: '#ec4899', c3: '#8b5cf6', shape: 'dotted-strobe' },
  { name: 'Inverted Negative-Space Hexagon', cat: 'geometry', catLabel: '📐 Pure Geometry', c1: '#ffffff', c2: '#94a3b8', c3: '#475569', shape: 'negative-hex' },
  { name: 'Micro-Serif Architectural Terminal', cat: 'geometry', catLabel: '📐 Pure Geometry', c1: '#67e8f9', c2: '#3b82f6', c3: '#1e3a8a', shape: 'micro-serif' },
  { name: 'Concentric Donut Void Core', cat: 'geometry', catLabel: '📐 Pure Geometry', c1: '#10b981', c2: '#06b6d4', c3: '#6366f1', shape: 'donut-void' },
  { name: 'Equilateral Prism Triangle Gate', cat: 'geometry', catLabel: '📐 Pure Geometry', c1: '#f97316', c2: '#eab308', c3: '#84cc16', shape: 'triangle-gate' },

  // Masterpiece Synthesis & Futuristic App Tiles
  { name: 'Mixdog Masterpiece: Quantum Hound', cat: 'masterpiece', catLabel: '👑 Masterpiece Suite', c1: '#00f2fe', c2: '#6366f1', c3: '#f43f5e', shape: 'masterpiece-quantum' },
  { name: 'Supreme CLI Terminal Orchestrator', cat: 'masterpiece', catLabel: '👑 Masterpiece Suite', c1: '#22c55e', c2: '#06b6d4', c3: '#3b82f6', shape: 'masterpiece-cli' },
  { name: 'Autonomous Multi-Agent Hivemind', cat: 'masterpiece', catLabel: '👑 Masterpiece Suite', c1: '#a855f7', c2: '#ec4899', c3: '#fbbf24', shape: 'masterpiece-hive' },
  { name: 'Ultra-Sleek macOS App Container Tile', cat: 'masterpiece', catLabel: '👑 Masterpiece Suite', c1: '#38bdf8', c2: '#818cf8', c3: '#c084fc', shape: 'masterpiece-app-tile' },
  { name: 'Mixdog Singularity Horizon Icon', cat: 'masterpiece', catLabel: '👑 Masterpiece Suite', c1: '#ffffff', c2: '#38bdf8', c3: '#f43f5e', shape: 'masterpiece-singularity' },

  // Additional 25 Extreme Center Core Innovations
  { name: 'Power Button Standby Glyph ⏻', cat: 'hardware', catLabel: '⚙️ Hardware & Industrial', c1: '#22c55e', c2: '#10b981', c3: '#34d399', shape: 'power-button' },
  { name: 'Ferris Crab Claw Rust Speed Node', cat: 'dev-syntax', catLabel: '💻 Code Grammar', c1: '#f97316', c2: '#ea580c', c3: '#c2410c', shape: 'rust-claw' },
  { name: 'Python Yin-Yang Dual Orbit', cat: 'dev-syntax', catLabel: '💻 Code Grammar', c1: '#38bdf8', c2: '#facc15', c3: '#3b82f6', shape: 'python-orbit' },
  { name: 'Winking Cyber-Hound Face (^_-)', cat: 'canine-bionic', catLabel: '🐺 Bionic Canine', c1: '#ec4899', c2: '#a855f7', c3: '#6366f1', shape: 'winking-hound' },
  { name: 'Tongue-Out Happy Doggo (=^.^=)', cat: 'canine-bionic', catLabel: '🐺 Bionic Canine', c1: '#fb923c', c2: '#f43f5e', c3: '#e11d48', shape: 'happy-doggo' },
  { name: 'Terminal Solid Block Cursor █', cat: 'dev-syntax', catLabel: '💻 Code Grammar', c1: '#4ade80', c2: '#22c55e', c3: '#15803d', shape: 'block-cursor' },
  { name: '3-Layer Neumorphic Emboss Core', cat: '3d-spatial', catLabel: '💎 3D & Isometric', c1: '#38bdf8', c2: '#818cf8', c3: '#c084fc', shape: 'neumorphic-emboss' },
  { name: 'Prism Facet Asteroid Core', cat: '3d-spatial', catLabel: '💎 3D & Isometric', c1: '#f43f5e', c2: '#fb923c', c3: '#facc15', shape: 'asteroid' },
  { name: 'Infinity Symbol Loop ∞ Hub', cat: 'quantum', catLabel: '⚡ Cyber & Quantum', c1: '#818cf8', c2: '#c084fc', c3: '#f472b6', shape: 'infinity' },
  { name: 'Dual Crossed Laser Beam Swords', cat: 'quantum', catLabel: '⚡ Cyber & Quantum', c1: '#00f2fe', c2: '#f43f5e', c3: '#ffffff', shape: 'laser-swords' },
  { name: 'Black Hole Event Horizon Singularity', cat: 'quantum', catLabel: '⚡ Cyber & Quantum', c1: '#a855f7', c2: '#6366f1', c3: '#000000', shape: 'black-hole' },
  { name: 'Diamond Shield Cyber Armor', cat: 'masterpiece', catLabel: '👑 Masterpiece Suite', c1: '#38bdf8', c2: '#0284c7', c3: '#0f172a', shape: 'shield-armor' },
  { name: 'Rotary Dial Knob Level Indicator', cat: 'hardware', catLabel: '⚙️ Hardware & Industrial', c1: '#e2e8f0', c2: '#94a3b8', c3: '#475569', shape: 'rotary-knob' },
  { name: 'Audio Spectrum Equalizer Bars', cat: 'multi-model', catLabel: '🔀 Multi-Model Engine', c1: '#22c55e', c2: '#eab308', c3: '#ef4444', shape: 'eq-bars' },
  { name: 'Multi-Core CPU Silicon Die Socket', cat: 'hardware', catLabel: '⚙️ Hardware & Industrial', c1: '#fbbf24', c2: '#d97706', c3: '#92400e', shape: 'cpu-socket' },
  { name: 'Binary Data Ring 010101', cat: 'dev-syntax', catLabel: '💻 Code Grammar', c1: '#34d399', c2: '#10b981', c3: '#065f46', shape: 'binary-ring' },
  { name: 'Hexagonal Honeycomb Mesh', cat: 'geometry', catLabel: '📐 Pure Geometry', c1: '#fbbf24', c2: '#f59e0b', c3: '#d97706', shape: 'honeycomb' },
  { name: 'Tri-Segment Biohazard Hazard Rune', cat: 'geometry', catLabel: '📐 Pure Geometry', c1: '#facc15', c2: '#eab308', c3: '#000000', shape: 'hazard-rune' },
  { name: 'Crosshair Sniper Precision Sight', cat: 'hardware', catLabel: '⚙️ Hardware & Industrial', c1: '#ef4444', c2: '#dc2626', c3: '#991b1b', shape: 'sniper-sight' },
  { name: 'Radar Pulse Sweep Sonar', cat: 'canine-bionic', catLabel: '🐺 Bionic Canine', c1: '#06b6d4', c2: '#0891b2', c3: '#164e63', shape: 'sonar-sweep' },
  { name: 'Minimalist Dot Pill Capsule', cat: 'geometry', catLabel: '📐 Pure Geometry', c1: '#ffffff', c2: '#cbd5e1', c3: '#64748b', shape: 'pill-capsule' },
  { name: 'Twin Helix DNA Strand Core', cat: 'quantum', catLabel: '⚡ Cyber & Quantum', c1: '#ec4899', c2: '#8b5cf6', c3: '#3b82f6', shape: 'dna-strand' },
  { name: 'Supercharged Lightning Spark ⚡', cat: 'quantum', catLabel: '⚡ Cyber & Quantum', c1: '#facc15', c2: '#eab308', c3: '#ca8a04', shape: 'lightning-spark' },
  { name: 'Mixdog Final Genesis Core', cat: 'masterpiece', catLabel: '👑 Masterpiece Suite', c1: '#00f2fe', c2: '#818cf8', c3: '#f43f5e', shape: 'genesis-core' },
  { name: 'Absolute Zero Superconductor Matrix', cat: 'masterpiece', catLabel: '👑 Masterpiece Suite', c1: '#ffffff', c2: '#38bdf8', c3: '#1e1b4b', shape: 'superconductor-matrix' }
];

// Helper to generate unique core SVG markup per shape
function generateCore(shape, c1, c2, c3) {
  switch (shape) {
    case 'hex-prism':
      return `<polygon points="128,114 140,121 140,135 128,142 116,135 116,121" fill="${c1}" opacity="0.85"/>
              <polygon points="128,114 140,121 128,128 116,121" fill="#ffffff" opacity="0.9"/>
              <circle cx="128" cy="128" r="3.5" fill="#ffffff"/>`;
    case 'gyro':
      return `<circle cx="128" cy="128" r="14" fill="none" stroke="${c1}" stroke-width="2" stroke-dasharray="4 3"/>
              <circle cx="128" cy="128" r="8" fill="none" stroke="${c2}" stroke-width="2"/>
              <circle cx="128" cy="128" r="3" fill="#ffffff"/>`;
    case 'tesseract':
      return `<rect x="116" y="116" width="24" height="24" rx="4" fill="none" stroke="${c1}" stroke-width="2"/>
              <rect x="122" y="122" width="12" height="12" rx="2" fill="${c2}" opacity="0.8"/>
              <circle cx="128" cy="128" r="2.5" fill="#ffffff"/>`;
    case 'diamond':
      return `<polygon points="128,112 144,128 128,144 112,128" fill="${c2}" opacity="0.85"/>
              <polygon points="128,116 140,128 128,140 116,128" fill="#ffffff" opacity="0.95"/>
              <circle cx="128" cy="128" r="3" fill="${c1}"/>`;
    case 'sphere':
      return `<circle cx="128" cy="128" r="12" fill="${c1}"/>
              <circle cx="124" cy="124" r="4" fill="#ffffff" opacity="0.8"/>`;
    case 'quantum':
      return `<ellipse cx="128" cy="128" rx="14" ry="5" transform="rotate(-30 128 128)" fill="none" stroke="${c1}" stroke-width="2"/>
              <ellipse cx="128" cy="128" rx="14" ry="5" transform="rotate(30 128 128)" fill="none" stroke="${c2}" stroke-width="2"/>
              <circle cx="128" cy="128" r="4" fill="#ffffff"/>`;
    case 'laser-visor':
      return `<line x1="112" y1="128" x2="144" y2="128" stroke="${c1}" stroke-width="4.5" stroke-linecap="round"/>
              <circle cx="128" cy="128" r="3.5" fill="#ffffff"/>`;
    case 'synapse':
      return `<circle cx="128" cy="128" r="4.5" fill="#ffffff"/>
              <line x1="128" y1="128" x2="128" y2="114" stroke="${c1}" stroke-width="2" stroke-linecap="round"/>
              <line x1="128" y1="128" x2="116" y2="138" stroke="${c2}" stroke-width="2" stroke-linecap="round"/>
              <line x1="128" y1="128" x2="140" y2="138" stroke="${c3}" stroke-width="2" stroke-linecap="round"/>
              <circle cx="128" cy="114" r="2.5" fill="${c1}"/><circle cx="116" cy="138" r="2.5" fill="${c2}"/><circle cx="140" cy="138" r="2.5" fill="${c3}"/>`;
    case 'matrix-grid':
      return `<g fill="${c1}">
                <rect x="118" y="118" width="5" height="5" rx="1.5"/><rect x="126" y="118" width="5" height="5" rx="1.5"/><rect x="134" y="118" width="5" height="5" rx="1.5"/>
                <rect x="118" y="126" width="5" height="5" rx="1.5"/><rect x="126" y="126" width="5" height="5" rx="1.5" fill="#fff"/><rect x="134" y="126" width="5" height="5" rx="1.5"/>
                <rect x="118" y="134" width="5" height="5" rx="1.5"/><rect x="126" y="134" width="5" height="5" rx="1.5"/><rect x="134" y="134" width="5" height="5" rx="1.5"/>
              </g>`;
    case 'accelerator':
      return `<circle cx="128" cy="128" r="14" fill="none" stroke="${c1}" stroke-width="2.5"/>
              <circle cx="128" cy="114" r="3" fill="#ffffff"/><circle cx="140" cy="135" r="3" fill="${c2}"/><circle cx="116" cy="135" r="3" fill="${c3}"/>
              <circle cx="128" cy="128" r="3" fill="#ffffff"/>`;
    case 'hound-eye':
      return `<path d="M120 124 L128 132 L136 124" fill="none" stroke="${c1}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="123" cy="118" r="2.5" fill="#ffffff"/><circle cx="133" cy="118" r="2.5" fill="#ffffff"/>`;
    case 'ear-blade':
      return `<polygon points="120,136 124,116 128,128" fill="${c1}"/>
              <polygon points="136,136 132,116 128,128" fill="${c2}"/>
              <circle cx="128" cy="132" r="2.5" fill="#ffffff"/>`;
    case 'bone-slash':
      return `<g transform="rotate(-45 128 128)">
                <line x1="116" y1="128" x2="140" y2="128" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/>
                <circle cx="116" cy="125" r="2.5" fill="${c1}"/><circle cx="116" cy="131" r="2.5" fill="${c1}"/>
                <circle cx="140" cy="125" r="2.5" fill="${c2}"/><circle cx="140" cy="131" r="2.5" fill="${c2}"/>
              </g>`;
    case 'paw-sensor':
      return `<circle cx="128" cy="132" r="6" fill="${c1}"/>
              <circle cx="120" cy="122" r="2.5" fill="#ffffff"/><circle cx="128" cy="118" r="2.5" fill="#ffffff"/><circle cx="136" cy="122" r="2.5" fill="#ffffff"/>`;
    case 'collar-token':
      return `<rect x="120" y="120" width="16" height="16" rx="4" fill="${c1}"/>
              <circle cx="128" cy="128" r="4" fill="#ffffff"/>`;
    case 'hound-m':
      return `<path d="M118 136 V122 L124 128 L128 120 L132 128 L138 122 V136" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'radar-scope':
      return `<circle cx="128" cy="128" r="14" fill="none" stroke="${c1}" stroke-width="2"/>
              <line x1="114" y1="128" x2="142" y2="128" stroke="${c1}" stroke-width="1.5"/>
              <line x1="128" y1="114" x2="128" y2="142" stroke="${c1}" stroke-width="1.5"/>
              <circle cx="134" cy="122" r="2" fill="#ffffff"/>`;
    case 'git-node':
      return `<circle cx="128" cy="128" r="6" fill="${c1}"/>
              <circle cx="128" cy="128" r="3" fill="#ffffff"/>
              <line x1="128" y1="112" x2="128" y2="122" stroke="${c1}" stroke-width="2.5"/>
              <line x1="128" y1="134" x2="128" y2="144" stroke="${c1}" stroke-width="2.5"/>`;
    case 'git-merge':
      return `<path d="M120 116 V140 M136 116 V128 C136 134 128 136 120 136" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
              <circle cx="120" cy="120" r="2.5" fill="${c1}"/><circle cx="136" cy="120" r="2.5" fill="${c2}"/><circle cx="120" cy="136" r="3" fill="${c3}"/>`;
    case 'dual-slash':
      return `<line x1="120" y1="138" x2="128" y2="118" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round"/>
              <line x1="128" y1="138" x2="136" y2="118" stroke="${c1}" stroke-width="3.5" stroke-linecap="round"/>`;
    case 'curly-block':
      return `<path d="M120 120 C118 120 116 122 116 124 V126 C116 127 114 128 112 128 C114 128 116 129 116 130 V132 C116 134 118 136 120 136" fill="none" stroke="${c1}" stroke-width="2.5" stroke-linecap="round"/>
              <path d="M136 120 C138 120 140 122 140 124 V126 C140 127 142 128 144 128 C142 128 140 129 140 130 V132 C140 134 138 136 136 136" fill="none" stroke="${c1}" stroke-width="2.5" stroke-linecap="round"/>
              <circle cx="128" cy="128" r="3.5" fill="#ffffff"/>`;
    case 'jsx-tag':
      return `<path d="M118 123 L113 128 L118 133" fill="none" stroke="${c1}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
              <line x1="126" y1="121" x2="130" y2="135" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/>
              <path d="M138 123 L143 128 L138 133" fill="none" stroke="${c1}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'lambda':
      return `<path d="M120 138 L130 118 M125 128 L136 138" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="130" cy="118" r="2" fill="${c1}"/>`;
    case 'trinity':
      return `<polygon points="128,114 140,136 116,136" fill="none" stroke="#ffffff" stroke-width="2.5"/>
              <circle cx="128" cy="114" r="3.5" fill="${c1}"/><circle cx="140" cy="136" r="3.5" fill="${c2}"/><circle cx="116" cy="136" r="3.5" fill="${c3}"/>
              <circle cx="128" cy="128" r="3" fill="#ffffff"/>`;
    case 'laser-target':
      return `<circle cx="128" cy="128" r="14" fill="none" stroke="${c1}" stroke-width="1.5" stroke-dasharray="3 3"/>
              <line x1="112" y1="128" x2="144" y2="128" stroke="${c1}" stroke-width="2"/>
              <line x1="128" y1="112" x2="128" y2="144" stroke="${c1}" stroke-width="2"/>
              <circle cx="128" cy="128" r="3.5" fill="#ffffff"/>`;
    case 'masterpiece-quantum':
      return `<polygon points="128,114 142,128 128,142 114,128" fill="${c1}" opacity="0.8"/>
              <path d="M120 124 L128 132 L136 124" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="128" cy="122" r="2.5" fill="#ffffff"/>
              <ellipse cx="128" cy="128" rx="16" ry="6" fill="none" stroke="${c2}" stroke-width="1.5" transform="rotate(-30 128 128)"/>`;
    case 'power-button':
      return `<path d="M123 120 A10 10 0 1 0 133 120" fill="none" stroke="${c1}" stroke-width="3" stroke-linecap="round"/>
              <line x1="128" y1="114" x2="128" y2="126" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>`;
    case 'rust-claw':
      return `<path d="M118 134 C114 126 122 116 128 122 C134 116 142 126 138 134" fill="none" stroke="${c1}" stroke-width="3.5" stroke-linecap="round"/>
              <circle cx="128" cy="130" r="3.5" fill="#ffffff"/>`;
    case 'python-orbit':
      return `<circle cx="124" cy="124" r="5" fill="${c1}"/><circle cx="124" cy="124" r="1.5" fill="#ffffff"/>
              <circle cx="132" cy="132" r="5" fill="${c2}"/><circle cx="132" cy="132" r="1.5" fill="#ffffff"/>`;
    case 'winking-hound':
      return `<circle cx="122" cy="120" r="2.5" fill="#ffffff"/>
              <path d="M131 120 L137 120" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/>
              <polygon points="128,126 125,130 131,130" fill="${c1}"/>`;
    case 'happy-doggo':
      return `<circle cx="122" cy="118" r="2" fill="#ffffff"/><circle cx="134" cy="118" r="2" fill="#ffffff"/>
              <path d="M125 124 Q128 128 131 124" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
              <path d="M126 126 Q128 134 130 126" fill="${c2}"/>`;
    case 'block-cursor':
      return `<rect x="121" y="116" width="14" height="24" rx="2" fill="${c1}"/>
              <text x="128" y="133" font-family="monospace" font-size="12" font-weight="bold" fill="#000" text-anchor="middle">&gt;</text>`;
    case 'neumorphic-emboss':
      return `<circle cx="128" cy="128" r="16" fill="#141722" stroke="${c1}" stroke-width="2"/>
              <circle cx="128" cy="128" r="10" fill="#1c2130" stroke="${c2}" stroke-width="1.5"/>
              <circle cx="128" cy="128" r="4" fill="#ffffff"/>`;
    case 'asteroid':
      return `<polygon points="128,114 138,120 142,132 134,142 120,138 116,124" fill="${c1}" opacity="0.9"/>
              <circle cx="128" cy="128" r="3" fill="#ffffff"/>`;
    case 'infinity':
      return `<path d="M121 128 C117 122 113 122 113 128 C113 134 117 134 121 128 C125 122 129 122 129 128 C129 134 125 134 121 128 Z" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="128" cy="128" r="2.5" fill="${c1}"/>`;
    case 'laser-swords':
      return `<line x1="114" y1="114" x2="142" y2="142" stroke="${c1}" stroke-width="3" stroke-linecap="round"/>
              <line x1="142" y1="114" x2="114" y2="142" stroke="${c2}" stroke-width="3" stroke-linecap="round"/>
              <circle cx="128" cy="128" r="3.5" fill="#ffffff"/>`;
    case 'black-hole':
      return `<circle cx="128" cy="128" r="15" fill="#000000" stroke="${c1}" stroke-width="3"/>
              <circle cx="128" cy="128" r="6" fill="#000000" stroke="#ffffff" stroke-width="1.5"/>
              <circle cx="128" cy="128" r="2" fill="${c1}"/>`;
    case 'shield-armor':
      return `<path d="M118 118 H138 V128 C138 136 128 142 128 142 C128 142 118 136 118 128 Z" fill="${c1}" opacity="0.85"/>
              <circle cx="128" cy="128" r="3.5" fill="#ffffff"/>`;
    case 'rotary-knob':
      return `<circle cx="128" cy="128" r="14" fill="#1e293b" stroke="${c1}" stroke-width="2"/>
              <line x1="128" y1="128" x2="136" y2="120" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/>
              <circle cx="128" cy="128" r="3" fill="${c1}"/>`;
    case 'eq-bars':
      return `<g fill="${c1}">
                <rect x="116" y="124" width="4" height="12" rx="1.5"/>
                <rect x="122" y="116" width="4" height="20" rx="1.5" fill="${c2}"/>
                <rect x="128" y="112" width="4" height="24" rx="1.5" fill="#ffffff"/>
                <rect x="134" y="120" width="4" height="16" rx="1.5" fill="${c3}"/>
              </g>`;
    case 'cpu-socket':
      return `<rect x="118" y="118" width="20" height="20" rx="3" fill="#0f172a" stroke="${c1}" stroke-width="2"/>
              <rect x="124" y="124" width="8" height="8" rx="1.5" fill="${c2}"/>
              <circle cx="128" cy="128" r="2" fill="#ffffff"/>`;
    case 'binary-ring':
      return `<circle cx="128" cy="128" r="14" fill="none" stroke="${c1}" stroke-width="2" stroke-dasharray="2 3 5 2"/>
              <circle cx="128" cy="128" r="5" fill="#ffffff"/>`;
    case 'honeycomb':
      return `<polygon points="128,116 136,121 136,131 128,136 120,131 120,121" fill="none" stroke="${c1}" stroke-width="2.5"/>
              <polygon points="128,120 133,123 133,129 128,132 123,129 123,123" fill="${c2}"/>
              <circle cx="128" cy="126" r="2" fill="#ffffff"/>`;
    case 'hazard-rune':
      return `<polygon points="128,116 138,136 118,136" fill="${c1}"/>
              <polygon points="128,122 133,132 123,132" fill="#000000"/>
              <circle cx="128" cy="128" r="2" fill="${c1}"/>`;
    case 'sniper-sight':
      return `<circle cx="128" cy="128" r="14" fill="none" stroke="${c1}" stroke-width="2"/>
              <circle cx="128" cy="128" r="6" fill="none" stroke="${c1}" stroke-width="1.5"/>
              <circle cx="128" cy="128" r="2" fill="#ffffff"/>`;
    case 'sonar-sweep':
      return `<circle cx="128" cy="128" r="14" fill="none" stroke="${c1}" stroke-width="1.5"/>
              <path d="M128 128 L142 120 A14 14 0 0 0 134 114 Z" fill="${c1}" opacity="0.6"/>
              <circle cx="128" cy="128" r="3" fill="#ffffff"/>`;
    case 'pill-capsule':
      return `<rect x="122" y="116" width="12" height="24" rx="6" fill="${c1}"/>
              <rect x="122" y="128" width="12" height="12" rx="0" fill="${c2}"/>
              <circle cx="128" cy="122" r="2" fill="#ffffff"/>`;
    case 'dna-strand':
      return `<path d="M120 114 Q128 128 136 142 M136 114 Q128 128 120 142" stroke="${c1}" stroke-width="2.5" stroke-linecap="round"/>
              <line x1="122" y1="120" x2="134" y2="120" stroke="#ffffff" stroke-width="2"/>
              <line x1="122" y1="136" x2="134" y2="136" stroke="#ffffff" stroke-width="2"/>
              <circle cx="128" cy="128" r="3" fill="${c2}"/>`;
    case 'lightning-spark':
      return `<polygon points="130,114 122,126 128,126 124,142 136,128 130,128" fill="${c1}"/>
              <polygon points="129,118 125,125 128,125 126,134 132,127 129,127" fill="#ffffff"/>`;
    case 'genesis-core':
      return `<polygon points="128,112 142,128 128,144 114,128" fill="${c1}" opacity="0.9"/>
              <path d="M120 125 L128 133 L136 125" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="128" cy="122" r="3" fill="#ffffff"/>`;
    case 'superconductor-matrix':
      return `<circle cx="128" cy="128" r="16" fill="none" stroke="${c1}" stroke-width="2" stroke-dasharray="6 3"/>
              <polygon points="128,118 138,128 128,138 118,128" fill="#ffffff"/>
              <circle cx="128" cy="128" r="3" fill="${c2}"/>`;
    default:
      return `<circle cx="128" cy="128" r="10" fill="${c1}"/><circle cx="128" cy="128" r="4" fill="#ffffff"/>`;
  }
}

// Assemble the 95 remaining icons
themes.forEach((t, i) => {
  const num = 106 + i;
  if (num > 200) return;
  const idStr = `ap200-${String(num - 100).padStart(3, '0')}`;
  const defs = `<linearGradient id="g${num}-1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${t.c1}"/><stop offset="100%" stop-color="${t.c2}"/></linearGradient>
               <linearGradient id="g${num}-2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${t.c2}"/><stop offset="100%" stop-color="${t.c3}"/></linearGradient>
               <linearGradient id="g${num}-3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${t.c3}"/><stop offset="100%" stop-color="${t.c1}"/></linearGradient>`;

  newIcons.push({
    num,
    id: idStr,
    title: t.name,
    category: t.cat,
    catLabel: t.catLabel,
    tag: `${t.name.split(' ')[0]} / ${t.catLabel.split(' ')[1]}`,
    desc: `2026 차세대 비주얼 테마: ${t.name} & 360° 연속 회전 아크 시스템`,
    bg: '#08090d',
    rx: 60,
    defs,
    body: makeArcs(`url(#g${num}-1)`, `url(#g${num}-2)`, `url(#g${num}-3)`, t.width || 22),
    core: generateCore(t.shape, t.c1, t.c2, t.c3)
  });
});

console.log(`Generated ${newIcons.length} new Series-2 icon specifications.`);

// Write Series-2 SVGs to disk
for (const icon of newIcons) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    ${icon.defs}
  </defs>
  <rect width="256" height="256" rx="${icon.rx}" fill="${icon.bg}"/>
  ${icon.body}
  ${icon.core}
</svg>`;
  writeFileSync(join(outDir, `${icon.id}.svg`), svg, 'utf8');
}

console.log(`Wrote all ap200-*.svg files to disk.`);

// Read 100 series 1 icons from ap100-*.svg or construct 200 icons catalog
const all200Icons = [];

// Push Series 1 (1 to 100)
for (let i = 1; i <= 100; i++) {
  const idStr = `ap100-${String(i).padStart(3, '0')}`;
  all200Icons.push({
    num: i,
    id: idStr,
    file: `${idStr}.svg`,
    title: `Series 1: Icon #${String(i).padStart(3, '0')}`,
    series: 'Series 1 (Core Suite)',
    category: i <= 15 ? 'canine' : i <= 30 ? 'spark' : i <= 45 ? 'cli' : i <= 55 ? 'multi-model' : i <= 70 ? 'gradient-360' : i <= 85 ? 'geometry' : i <= 95 ? 'hardware' : 'masterpiece'
  });
}

// Push Series 2 (101 to 200)
for (const icon of newIcons) {
  all200Icons.push({
    num: icon.num,
    id: icon.id,
    file: `${icon.id}.svg`,
    title: icon.title,
    series: 'Series 2 (2026 Next-Gen)',
    category: icon.category,
    catLabel: icon.catLabel,
    desc: icon.desc
  });
}

console.log(`Total 200-icon catalog ready: ${all200Icons.length} items.`);

// Build the Mega 200 Showcase HTML
const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mixdog Aperture Triad 200 Mega Icon System</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #06070a;
      --bg-surface: #0e1118;
      --bg-card: #131722;
      --bg-card-hover: #1b2130;
      --border: rgba(255, 255, 255, 0.08);
      --border-accent: rgba(56, 189, 248, 0.4);
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
        radial-gradient(circle at 85% 20%, rgba(217, 70, 239, 0.08) 0%, transparent 50%),
        radial-gradient(circle at 15% 40%, rgba(16, 185, 129, 0.08) 0%, transparent 50%);
      pointer-events: none;
      z-index: 0;
    }

    .container {
      position: relative;
      z-index: 1;
      max-width: 1560px;
      margin: 0 auto;
      padding: 40px 24px 120px;
    }

    /* Header */
    header {
      text-align: center;
      margin-bottom: 36px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 18px;
      border-radius: 999px;
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.3);
      color: var(--cyan);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 16px;
      box-shadow: 0 0 20px rgba(56, 189, 248, 0.2);
    }

    header h1 {
      font-size: 44px;
      font-weight: 800;
      letter-spacing: -0.03em;
      line-height: 1.15;
      margin-bottom: 12px;
      background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 50%, #94a3b8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    header p {
      font-size: 15px;
      color: var(--text-muted);
      max-width: 820px;
      margin: 0 auto;
    }

    /* Live Multi-Scale Strip (Sticky Inspector) */
    .sticky-viewer {
      position: sticky;
      top: 16px;
      z-index: 100;
      background: rgba(14, 17, 24, 0.92);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border-accent);
      border-radius: var(--radius-xl);
      padding: 16px 24px;
      margin-bottom: 32px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      flex-wrap: wrap;
    }

    .viewer-info {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .viewer-badge {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      font-weight: 700;
      color: var(--cyan);
      background: rgba(56, 189, 248, 0.12);
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid rgba(56, 189, 248, 0.3);
    }

    .viewer-title {
      font-size: 16px;
      font-weight: 700;
      color: #fff;
    }

    .viewer-scales {
      display: flex;
      align-items: center;
      gap: 18px;
      background: #08090d;
      padding: 8px 18px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    .scale-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    }

    .scale-item span {
      font-size: 10px;
      color: var(--text-dim);
      font-family: 'JetBrains Mono', monospace;
    }

    .viewer-actions {
      display: flex;
      gap: 10px;
    }

    .btn-copy {
      background: var(--cyan);
      color: #000;
      font-size: 12px;
      font-weight: 700;
      padding: 8px 16px;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      transition: transform 0.15s;
    }

    .btn-copy:hover {
      transform: scale(1.04);
    }

    /* Filter Bar */
    .filter-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 24px;
      flex-wrap: wrap;
    }

    .search-input {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 16px;
      color: #fff;
      font-size: 13px;
      min-width: 280px;
      outline: none;
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
      padding: 6px 12px;
      border-radius: 6px;
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
      font-weight: 600;
    }

    /* 200 Icons Mega Grid */
    .mega-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 16px;
    }

    .icon-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      cursor: pointer;
      transition: all 0.2s;
      position: relative;
    }

    .icon-card:hover {
      transform: translateY(-4px);
      border-color: var(--border-accent);
      background: var(--bg-card-hover);
      box-shadow: 0 12px 24px rgba(0, 0, 0, 0.5), 0 0 16px rgba(56, 189, 248, 0.15);
    }

    .icon-card.selected {
      border-color: var(--cyan);
      background: rgba(56, 189, 248, 0.08);
    }

    .icon-num {
      position: absolute;
      top: 10px; left: 10px;
      font-size: 10px;
      font-weight: 700;
      color: var(--text-dim);
      font-family: 'JetBrains Mono', monospace;
    }

    .icon-fav {
      position: absolute;
      top: 8px; right: 8px;
      background: none;
      border: none;
      color: var(--text-dim);
      font-size: 14px;
      cursor: pointer;
      transition: transform 0.2s, color 0.2s;
    }

    .icon-fav:hover, .icon-fav.active {
      color: #f43f5e;
      transform: scale(1.2);
    }

    .icon-img-wrap {
      width: 100px;
      height: 100px;
      margin: 12px 0 10px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .icon-img-wrap img {
      width: 90px;
      height: 90px;
      transition: transform 0.2s;
    }

    .icon-card:hover .icon-img-wrap img {
      transform: scale(1.08);
    }

    .icon-title {
      font-size: 12px;
      font-weight: 600;
      text-align: center;
      color: #e2e8f0;
      width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 2px;
    }

    .icon-category {
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
      <div class="badge">🚀 200 Mega Icon System • Aperture Triad 2.0</div>
      <h1>Mixdog Aperture Triad 200 Mega Suite</h1>
      <p>131번 Aperture Triad 120° 회전 대칭 기하학을 기반으로 설계된 200개의 완벽한 독립 모던 아이콘 컬렉션입니다.</p>
    </header>

    <!-- Sticky Live Viewer -->
    <div class="sticky-viewer" id="viewer">
      <div class="viewer-info">
        <span class="viewer-badge" id="v-num">#101</span>
        <div>
          <div class="viewer-title" id="v-title">Isometric Triad Cube Core</div>
          <div style="font-size: 11px; color: var(--text-muted);" id="v-desc">아이소메트릭 큐브가 3방향 아크의 교차 중심에서 입체적으로 회전하는 코어</div>
        </div>
      </div>

      <div class="viewer-scales">
        <div class="scale-item"><img id="s-64" src="./ap200-001.svg" width="64" height="64" /><span>64px</span></div>
        <div class="scale-item"><img id="s-32" src="./ap200-001.svg" width="32" height="32" /><span>32px</span></div>
        <div class="scale-item"><img id="s-24" src="./ap200-001.svg" width="24" height="24" /><span>24px</span></div>
        <div class="scale-item"><img id="s-16" src="./ap200-001.svg" width="16" height="16" /><span>16px</span></div>
      </div>

      <div class="viewer-actions">
        <button class="btn-copy" onclick="copyCurrentSvg()">📋 SVG 코드 복사</button>
      </div>
    </div>

    <!-- Filter Bar -->
    <div class="filter-bar">
      <input type="text" class="search-input" id="search-input" placeholder="🔍 200개 아이콘 검색 (이름, 번호, 태그)..." oninput="filterGrid()" />
      <div class="filter-chips">
        <button class="chip active" onclick="setFilter('all', this)">전체 (200)</button>
        <button class="chip" onclick="setFilter('fav', this)">♥ 찜한 목록 (<span id="fav-count">0</span>)</button>
        <button class="chip" onclick="setFilter('3d-spatial', this)">💎 3D & Spatial</button>
        <button class="chip" onclick="setFilter('quantum', this)">⚡ Cyber & Quantum</button>
        <button class="chip" onclick="setFilter('canine-bionic', this)">🐺 Bionic Canine</button>
        <button class="chip" onclick="setFilter('dev-syntax', this)">💻 Code Grammar</button>
        <button class="chip" onclick="setFilter('multi-model', this)">🔀 Multi-Model</button>
        <button class="chip" onclick="setFilter('hardware', this)">⚙️ Hardware Metal</button>
        <button class="chip" onclick="setFilter('geometry', this)">📐 Pure Geometry</button>
        <button class="chip" onclick="setFilter('masterpiece', this)">👑 Masterpiece</button>
      </div>
    </div>

    <!-- 200 Mega Grid -->
    <div class="mega-grid" id="grid">
      ${all200Icons.map(icon => `
        <div class="icon-card ${icon.num === 101 ? 'selected' : ''}" id="card-${icon.id}" data-id="${icon.id}" data-num="${icon.num}" data-cat="${icon.category}" data-title="${icon.title.toLowerCase()}" onclick="selectIcon('${icon.id}', '${icon.title}', '${icon.desc || icon.series}', '${icon.num}')">
          <span class="icon-num">#${String(icon.num).padStart(3, '0')}</span>
          <button class="icon-fav" onclick="toggleFav('${icon.id}', event)">♥</button>
          <div class="icon-img-wrap">
            <img src="./${icon.file}" loading="lazy" alt="${icon.title}" />
          </div>
          <div class="icon-title">${icon.title}</div>
          <div class="icon-category">${icon.catLabel || icon.series}</div>
        </div>
      `).join('')}
    </div>
  </div>

  <script>
    let currentSvg = 'ap200-001.svg';
    let favorites = new Set();

    function selectIcon(id, title, desc, num) {
      currentSvg = id + '.svg';
      document.getElementById('v-num').innerText = '#' + String(num).padStart(3, '0');
      document.getElementById('v-title').innerText = title;
      document.getElementById('v-desc').innerText = desc;

      document.getElementById('s-64').src = './' + currentSvg;
      document.getElementById('s-32').src = './' + currentSvg;
      document.getElementById('s-24').src = './' + currentSvg;
      document.getElementById('s-16').src = './' + currentSvg;

      document.querySelectorAll('.icon-card').forEach(c => c.classList.remove('selected'));
      const activeCard = document.getElementById('card-' + id);
      if (activeCard) activeCard.classList.add('selected');
    }

    function toggleFav(id, e) {
      e.stopPropagation();
      const btn = e.target;
      if (favorites.has(id)) {
        favorites.delete(id);
        btn.classList.remove('active');
      } else {
        favorites.add(id);
        btn.classList.add('active');
      }
      document.getElementById('fav-count').innerText = favorites.size;
    }

    async function copyCurrentSvg() {
      try {
        const res = await fetch('./' + currentSvg);
        const text = await res.text();
        await navigator.clipboard.writeText(text);
        alert('✅ ' + currentSvg + ' 소스코드가 클립보드에 복사되었습니다!');
      } catch (err) {
        alert('복사 실패: ' + err.message);
      }
    }

    let currentFilter = 'all';

    function setFilter(filter, btn) {
      currentFilter = filter;
      document.querySelectorAll('.filter-chips .chip').forEach(c => c.classList.remove('active'));
      if (btn) btn.classList.add('active');
      filterGrid();
    }

    function filterGrid() {
      const q = document.getElementById('search-input').value.toLowerCase().trim();
      const cards = document.querySelectorAll('.icon-card');

      cards.forEach(card => {
        const id = card.getAttribute('data-id');
        const num = card.getAttribute('data-num');
        const cat = card.getAttribute('data-cat');
        const title = card.getAttribute('data-title');

        let matchFilter = false;
        if (currentFilter === 'all') matchFilter = true;
        else if (currentFilter === 'fav') matchFilter = favorites.has(id);
        else matchFilter = (cat === currentFilter);

        let matchSearch = !q || title.includes(q) || id.includes(q) || num.includes(q);

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

writeFileSync(join(outDir, 'aperture-200-mega-gallery.html'), html, 'utf8');
console.log('✅ Generated aperture-200-mega-gallery.html successfully!');
