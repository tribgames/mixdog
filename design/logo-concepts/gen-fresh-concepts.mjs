import { writeFileSync } from 'node:fs';
import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';

chdir(fileURLToPath(new URL('../..', import.meta.url)));

// 1. Origami Fold
const svg1 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="f1-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#15161c"/>
      <stop offset="50%" stop-color="#0a0a0e"/>
      <stop offset="100%" stop-color="#020204"/>
    </linearGradient>
    <linearGradient id="f1-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#64748b" stop-opacity="0.1"/>
    </linearGradient>
    <linearGradient id="f1-plane-1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#cbd5e1"/>
    </linearGradient>
    <linearGradient id="f1-plane-2" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#94a3b8"/><stop offset="100%" stop-color="#475569"/>
    </linearGradient>
    <linearGradient id="f1-plane-3" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#64748b"/><stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
    <linearGradient id="f1-plane-4" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#0284c7"/>
    </linearGradient>
    <filter id="f1-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#f1-bg)" filter="url(#f1-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#f1-rim)" stroke-width="1.5"/>
  <g id="origami-hound">
    <!-- Left Outer Fold -->
    <polygon points="120,356 120,210 176,140 176,290" fill="url(#f1-plane-3)"/>
    <!-- Left Top Ear Facet -->
    <polygon points="176,140 256,220 176,240" fill="url(#f1-plane-1)"/>
    <!-- Left Inward Fold -->
    <polygon points="176,240 256,220 256,290 196,310" fill="url(#f1-plane-2)"/>
    <!-- Right Outer Fold -->
    <polygon points="392,356 392,210 336,140 336,290" fill="url(#f1-plane-3)"/>
    <!-- Right Top Ear Facet -->
    <polygon points="336,140 256,220 336,240" fill="url(#f1-plane-1)"/>
    <!-- Right Inward Fold -->
    <polygon points="336,240 256,220 256,290 316,310" fill="url(#f1-plane-2)"/>
    <!-- Center Forward Snout Prism -->
    <polygon points="196,310 256,290 316,310 256,366" fill="url(#f1-plane-4)"/>
    <!-- Specular Crease Lines -->
    <line x1="176" y1="140" x2="256" y2="220" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="336" y1="140" x2="256" y2="220" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="256" y1="220" x2="256" y2="366" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
  </g>
</svg>`;

// 2. CRT Phosphor Dot Matrix
const svg2 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="f2-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0c120f"/>
      <stop offset="50%" stop-color="#050a08"/>
      <stop offset="100%" stop-color="#010302"/>
    </linearGradient>
    <linearGradient id="f2-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#10b981" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#047857" stop-opacity="0.1"/>
    </linearGradient>
    <filter id="f2-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="8" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
    <filter id="f2-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#f2-bg)" filter="url(#f2-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#f2-rim)" stroke-width="1.5"/>
  <!-- Matrix Grid Glow -->
  <g fill="#10b981" filter="url(#f2-glow)">
    <!-- Ears -->
    <rect x="140" y="140" width="28" height="28" rx="6" opacity="0.9"/>
    <rect x="176" y="140" width="28" height="28" rx="6" opacity="0.7"/>
    <rect x="308" y="140" width="28" height="28" rx="6" opacity="0.7"/>
    <rect x="344" y="140" width="28" height="28" rx="6" opacity="0.9"/>
    <!-- Head M Level 1 -->
    <rect x="140" y="176" width="28" height="28" rx="6"/>
    <rect x="212" y="176" width="28" height="28" rx="6" opacity="0.85"/>
    <rect x="272" y="176" width="28" height="28" rx="6" opacity="0.85"/>
    <rect x="344" y="176" width="28" height="28" rx="6"/>
    <!-- Head M Level 2 -->
    <rect x="140" y="212" width="28" height="28" rx="6"/>
    <rect x="176" y="212" width="28" height="28" rx="6" opacity="0.6"/>
    <rect x="242" y="212" width="28" height="28" rx="6" fill="#34d399"/>
    <rect x="308" y="212" width="28" height="28" rx="6" opacity="0.6"/>
    <rect x="344" y="212" width="28" height="28" rx="6"/>
    <!-- Terminal Prompt Snout (>_) -->
    <rect x="140" y="248" width="28" height="28" rx="6"/>
    <rect x="212" y="248" width="28" height="28" rx="6" fill="#ffffff"/>
    <rect x="272" y="248" width="28" height="28" rx="6" fill="#ffffff"/>
    <rect x="344" y="248" width="28" height="28" rx="6"/>
    <!-- Snout Apex -->
    <rect x="140" y="284" width="28" height="28" rx="6" opacity="0.8"/>
    <rect x="242" y="284" width="28" height="28" rx="6" fill="#34d399"/>
    <rect x="344" y="284" width="28" height="28" rx="6" opacity="0.8"/>
    <!-- Base Stems -->
    <rect x="140" y="320" width="28" height="28" rx="6" opacity="0.6"/>
    <rect x="344" y="320" width="28" height="28" rx="6" opacity="0.6"/>
    <rect x="140" y="356" width="28" height="28" rx="6" opacity="0.3"/>
    <rect x="344" y="356" width="28" height="28" rx="6" opacity="0.3"/>
  </g>
</svg>`;

// 3. Quantum Orbital Rings
const svg3 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="f3-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#12131a"/>
      <stop offset="50%" stop-color="#08080d"/>
      <stop offset="100%" stop-color="#020205"/>
    </linearGradient>
    <linearGradient id="f3-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#6366f1" stop-opacity="0.2"/>
    </linearGradient>
    <linearGradient id="f3-ring-1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#0284c7"/>
    </linearGradient>
    <linearGradient id="f3-ring-2" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#a855f7"/><stop offset="100%" stop-color="#6366f1"/>
    </linearGradient>
    <linearGradient id="f3-ring-3" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#94a3b8"/>
    </linearGradient>
    <filter id="f3-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="8" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
    <filter id="f3-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#f3-bg)" filter="url(#f3-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#f3-rim)" stroke-width="1.5"/>
  <g id="quantum-rings" transform="translate(0, 0)">
    <!-- Left Orbital Ring (Left Ear & Stride) -->
    <ellipse cx="196" cy="240" rx="60" ry="110" transform="rotate(-25 196 240)" fill="none" stroke="url(#f3-ring-1)" stroke-width="24" stroke-linecap="round"/>
    <!-- Right Orbital Ring (Right Ear & Stride) -->
    <ellipse cx="316" cy="240" rx="60" ry="110" transform="rotate(25 316 240)" fill="none" stroke="url(#f3-ring-2)" stroke-width="24" stroke-linecap="round"/>
    <!-- Center Interlocking Chevrons / Snout Core -->
    <ellipse cx="256" cy="290" rx="72" ry="48" fill="none" stroke="url(#f3-ring-3)" stroke-width="20" stroke-linecap="round"/>
    <!-- Quantum Nucleus (Agent Core) -->
    <circle cx="256" cy="256" r="14" fill="#ffffff" filter="url(#f3-glow)"/>
    <circle cx="256" cy="256" r="6" fill="#38bdf8"/>
  </g>
</svg>`;

// 4. Cyber Laser Aperture
const svg4 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="f4-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#141419"/>
      <stop offset="50%" stop-color="#0a0a0c"/>
      <stop offset="100%" stop-color="#020204"/>
    </linearGradient>
    <linearGradient id="f4-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#f43f5e" stop-opacity="0.2"/>
    </linearGradient>
    <linearGradient id="f4-laser-left" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#6366f1"/>
    </linearGradient>
    <linearGradient id="f4-laser-right" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#fb923c"/>
    </linearGradient>
    <filter id="f4-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="8" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
    <filter id="f4-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#f4-bg)" filter="url(#f4-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#f4-rim)" stroke-width="1.5"/>
  <g id="cyber-aperture">
    <!-- Horizontal Slit Matrix forming M-Hound -->
    <!-- Top Ears -->
    <line x1="140" y1="160" x2="200" y2="160" stroke="url(#f4-laser-left)" stroke-width="20" stroke-linecap="round"/>
    <line x1="312" y1="160" x2="372" y2="160" stroke="url(#f4-laser-right)" stroke-width="20" stroke-linecap="round"/>
    <!-- Mid Slits -->
    <line x1="120" y1="210" x2="230" y2="210" stroke="url(#f4-laser-left)" stroke-width="20" stroke-linecap="round"/>
    <line x1="282" y1="210" x2="392" y2="210" stroke="url(#f4-laser-right)" stroke-width="20" stroke-linecap="round"/>
    <!-- Visor Eye Core -->
    <line x1="140" y1="260" x2="372" y2="260" stroke="#ffffff" stroke-width="22" stroke-linecap="round" filter="url(#f4-glow)"/>
    <!-- Terminal Prompt Chevron Slits (Snout) -->
    <line x1="170" y1="310" x2="230" y2="310" stroke="url(#f4-laser-left)" stroke-width="20" stroke-linecap="round"/>
    <line x1="282" y1="310" x2="342" y2="310" stroke="url(#f4-laser-right)" stroke-width="20" stroke-linecap="round"/>
    <!-- Chin Slit -->
    <line x1="226" y1="360" x2="286" y2="360" stroke="#38bdf8" stroke-width="22" stroke-linecap="round" filter="url(#f4-glow)"/>
  </g>
</svg>`;

// 5. Silicon Die & Microchip Traces
const svg5 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="f5-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#13141b"/>
      <stop offset="50%" stop-color="#08080d"/>
      <stop offset="100%" stop-color="#010103"/>
    </linearGradient>
    <linearGradient id="f5-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fbbf24" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#d97706" stop-opacity="0.1"/>
    </linearGradient>
    <linearGradient id="f5-gold" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fef08a"/><stop offset="50%" stop-color="#fbbf24"/><stop offset="100%" stop-color="#b45309"/>
    </linearGradient>
    <filter id="f5-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#f5-bg)" filter="url(#f5-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#f5-rim)" stroke-width="1.5"/>
  <g id="silicon-die" stroke="url(#f5-gold)" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <!-- Left Trace Stem & Ear -->
    <path d="M 120 356 V 210 L 176 154 L 224 202 L 256 170" stroke-width="26"/>
    <circle cx="120" cy="356" r="10" fill="#fbbf24" stroke="none"/>
    <circle cx="176" cy="154" r="10" fill="#fbbf24" stroke="none"/>
    <!-- Right Trace Stem & Ear -->
    <path d="M 392 356 V 210 L 336 154 L 288 202 L 256 170" stroke-width="26"/>
    <circle cx="392" cy="356" r="10" fill="#fbbf24" stroke="none"/>
    <circle cx="336" cy="154" r="10" fill="#fbbf24" stroke="none"/>
    <!-- Center IC Chip (Neural Node) -->
    <rect x="236" y="150" width="40" height="40" rx="8" fill="#1e293b" stroke="#fbbf24" stroke-width="4"/>
    <circle cx="256" cy="170" r="6" fill="#ffffff" stroke="none"/>
    <!-- Bus Line to Prompt Snout -->
    <path d="M 196 284 L 256 344 L 316 284" stroke="#ffffff" stroke-width="26"/>
    <circle cx="196" cy="284" r="8" fill="#ffffff" stroke="none"/>
    <circle cx="316" cy="284" r="8" fill="#ffffff" stroke="none"/>
    <circle cx="256" cy="344" r="10" fill="#fbbf24" stroke="none"/>
  </g>
</svg>`;

// 6. Swiss Bauhaus Brutalist
const svg6 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <filter id="f6-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="#09090b" filter="url(#f6-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="#27272a" stroke-width="1.5"/>
  <g id="swiss-bauhaus">
    <!-- Left Stride Pillar (Solid White) -->
    <rect x="120" y="196" width="56" height="160" rx="12" fill="#ffffff"/>
    <!-- Left Triangular Ear Wedge -->
    <polygon points="120,196 176,140 176,196" fill="#ffffff"/>
    <!-- Right Stride Pillar (Solid White) -->
    <rect x="336" y="196" width="56" height="160" rx="12" fill="#ffffff"/>
    <!-- Right Triangular Ear Wedge -->
    <polygon points="392,196 336,140 336,196" fill="#ffffff"/>
    <!-- Center Inverted Triangle (M-Apex & Snout) -->
    <polygon points="204,212 308,212 256,296" fill="#ffffff"/>
    <!-- Single Pure Electric Blue Geometric Dot (The Agent Nexus) -->
    <circle cx="256" cy="336" r="22" fill="#2563eb"/>
  </g>
</svg>`;

// 7. Liquid Glass Aurora SMR
const svg7 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="f7-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#13141f"/>
      <stop offset="50%" stop-color="#090a10"/>
      <stop offset="100%" stop-color="#020204"/>
    </linearGradient>
    <linearGradient id="f7-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="50%" stop-color="#38bdf8" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="#ec4899" stop-opacity="0.25"/>
    </linearGradient>
    <!-- Iridescent Aurora Mesh Inside Glass -->
    <radialGradient id="f7-aurora-1" cx="30%" cy="30%" r="60%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="f7-aurora-2" cx="70%" cy="30%" r="60%">
      <stop offset="0%" stop-color="#ec4899" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="#ec4899" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="f7-aurora-3" cx="50%" cy="70%" r="60%">
      <stop offset="0%" stop-color="#8b5cf6" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#8b5cf6" stop-opacity="0"/>
    </radialGradient>
    <filter id="f7-blur" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="16" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
    <filter id="f7-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#f7-bg)" filter="url(#f7-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#f7-rim)" stroke-width="1.5"/>
  <!-- Aurora Subsurface Core -->
  <circle cx="200" cy="200" r="100" fill="url(#f7-aurora-1)" filter="url(#f7-blur)"/>
  <circle cx="312" cy="200" r="100" fill="url(#f7-aurora-2)" filter="url(#f7-blur)"/>
  <circle cx="256" cy="300" r="100" fill="url(#f7-aurora-3)" filter="url(#f7-blur)"/>
  <!-- Liquid Frosted Glass Monogram -->
  <g id="glass-m">
    <path d="M 136 348 V 196 C 136 150 174 126 206 152 L 256 194 L 306 152 C 338 126 376 150 376 196 V 348"
          fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M 194 274 L 256 332 L 318 274"
          fill="none" stroke="#ffffff" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="256" cy="302" r="10" fill="#38bdf8"/>
  </g>
</svg>`;

// 8. CLI Token Slash
const svg8 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="f8-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#16171e"/>
      <stop offset="50%" stop-color="#0b0c10"/>
      <stop offset="100%" stop-color="#030305"/>
    </linearGradient>
    <linearGradient id="f8-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#f97316" stop-opacity="0.25"/>
    </linearGradient>
    <linearGradient id="f8-slash-1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#cbd5e1"/>
    </linearGradient>
    <linearGradient id="f8-slash-2" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffedd5"/><stop offset="50%" stop-color="#f97316"/><stop offset="100%" stop-color="#ea580c"/>
    </linearGradient>
    <filter id="f8-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#f8-bg)" filter="url(#f8-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#f8-rim)" stroke-width="1.5"/>
  <g id="cli-token-hound">
    <!-- Double Code Slashes (//) forming Ears -->
    <line x1="160" y1="330" x2="220" y2="150" stroke="url(#f8-slash-1)" stroke-width="32" stroke-linecap="round"/>
    <line x1="292" y1="150" x2="352" y2="330" stroke="url(#f8-slash-1)" stroke-width="32" stroke-linecap="round"/>
    <!-- Terminal Prompt >> Snout -->
    <path d="M 188 280 L 256 344 L 324 280" fill="none" stroke="url(#f8-slash-2)" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>
    <!-- Token Execution Dot -->
    <circle cx="256" cy="210" r="10" fill="#f97316"/>
  </g>
</svg>`;

// Write all SVGs
writeFileSync('design/logo-concepts/fresh-1-origami-fold.svg', svg1);
writeFileSync('design/logo-concepts/fresh-2-crt-phosphor.svg', svg2);
writeFileSync('design/logo-concepts/fresh-3-quantum-orbit.svg', svg3);
writeFileSync('design/logo-concepts/fresh-4-cyber-aperture.svg', svg4);
writeFileSync('design/logo-concepts/fresh-5-silicon-chip.svg', svg5);
writeFileSync('design/logo-concepts/fresh-6-swiss-bauhaus.svg', svg6);
writeFileSync('design/logo-concepts/fresh-7-liquid-glass.svg', svg7);
writeFileSync('design/logo-concepts/fresh-8-token-syntax.svg', svg8);

console.log('8 Fresh Concept SVGs generated successfully!');
