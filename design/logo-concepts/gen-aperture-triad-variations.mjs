import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';

chdir(fileURLToPath(new URL('../..', import.meta.url)));

// ============================================================================
// 12 High-End Diverse Variations of "Aperture Triad" (3-Blade AI Camera & Vortex)
// ============================================================================

// 1. Classic Refined: Precision Swept Arcs & Multi-Model Core
const svg1 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="at1-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#14151b"/>
      <stop offset="50%" stop-color="#090a0e"/>
      <stop offset="100%" stop-color="#020204"/>
    </linearGradient>
    <linearGradient id="at1-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="50%" stop-color="#38bdf8" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="at1-arc-1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#38bdf8"/>
    </linearGradient>
    <linearGradient id="at1-arc-2" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#818cf8"/>
    </linearGradient>
    <linearGradient id="at1-arc-3" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#818cf8"/>
      <stop offset="100%" stop-color="#c084fc"/>
    </linearGradient>
    <filter id="at1-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#at1-bg)" filter="url(#at1-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#at1-rim)" stroke-width="1.5"/>

  <!-- Precision Guideline Ring -->
  <circle cx="256" cy="256" r="148" fill="none" stroke="#ffffff" stroke-width="1" opacity="0.08" stroke-dasharray="4 8"/>

  <!-- 3 Precision Swept Aperture Arcs -->
  <g fill="none" stroke-width="36" stroke-linecap="round">
    <path d="M 232 122 A 136 136 0 0 1 384 210" stroke="url(#at1-arc-1)"/>
    <path d="M 232 122 A 136 136 0 0 1 384 210" stroke="url(#at1-arc-2)" transform="rotate(120 256 256)"/>
    <path d="M 232 122 A 136 136 0 0 1 384 210" stroke="url(#at1-arc-3)" transform="rotate(240 256 256)"/>
  </g>

  <!-- Central Singularity Iris Kernel -->
  <circle cx="256" cy="256" r="20" fill="#ffffff" filter="drop-shadow(0 0 12px rgba(56, 189, 248, 0.8))"/>
  <circle cx="256" cy="256" r="8" fill="#090a0e"/>
</svg>`;

// 2. Solid Geometric Shutter Blades (Camera Iris Diaphragm)
const svg2 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="at2-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#121319"/>
      <stop offset="50%" stop-color="#08090d"/>
      <stop offset="100%" stop-color="#020203"/>
    </linearGradient>
    <linearGradient id="at2-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="at2-blade-1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="40%" stop-color="#e2e8f0"/>
      <stop offset="100%" stop-color="#64748b"/>
    </linearGradient>
    <linearGradient id="at2-blade-2" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#cbd5e1"/>
      <stop offset="60%" stop-color="#475569"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
    <linearGradient id="at2-blade-3" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#94a3b8"/>
      <stop offset="60%" stop-color="#334155"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
    <filter id="at2-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#at2-bg)" filter="url(#at2-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#at2-rim)" stroke-width="1.5"/>

  <!-- Outer Shutter Track -->
  <circle cx="256" cy="256" r="162" fill="none" stroke="#ffffff" stroke-width="1.5" opacity="0.15"/>

  <!-- 3 Interlocking Geometric Shutter Blades -->
  <g id="shutter-triad">
    <!-- Blade 1 -->
    <path d="M 256 104 C 330 104 394 158 406 232 L 316 232 C 298 232 284 218 284 200 L 284 106 Z" fill="url(#at2-blade-1)"/>
    <!-- Blade 2 (Rotated 120) -->
    <path d="M 256 104 C 330 104 394 158 406 232 L 316 232 C 298 232 284 218 284 200 L 284 106 Z" fill="url(#at2-blade-2)" transform="rotate(120 256 256)"/>
    <!-- Blade 3 (Rotated 240) -->
    <path d="M 256 104 C 330 104 394 158 406 232 L 316 232 C 298 232 284 218 284 200 L 284 106 Z" fill="url(#at2-blade-3)" transform="rotate(240 256 256)"/>
  </g>

  <!-- Central Glowing Triangle Aperture / AI Eye -->
  <polygon points="256,224 284,272 228,272" fill="#00f2fe" filter="drop-shadow(0 0 10px #00f2fe)"/>
  <circle cx="256" cy="256" r="4" fill="#ffffff"/>
</svg>`;

// 3. Hound / Canine Iris Hybrid (M & Ears meet 3-Way Aperture)
const svg3 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="at3-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#14151c"/>
      <stop offset="50%" stop-color="#08090d"/>
      <stop offset="100%" stop-color="#010203"/>
    </linearGradient>
    <linearGradient id="at3-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="50%" stop-color="#f43f5e" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="at3-ear-l" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#0284c7"/>
    </linearGradient>
    <linearGradient id="at3-ear-r" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#f43f5e"/>
      <stop offset="100%" stop-color="#be123c"/>
    </linearGradient>
    <linearGradient id="at3-snout" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#94a3b8"/>
    </linearGradient>
    <filter id="at3-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#at3-bg)" filter="url(#at3-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#at3-rim)" stroke-width="1.5"/>

  <!-- Hound-Aperture Triad Synthesis -->
  <g id="hound-aperture-triad">
    <!-- Top-Left Aperture Blade (Hound Left Ear) -->
    <path d="M 256 220 C 230 160 170 120 124 160 C 100 180 110 240 180 270"
          fill="none" stroke="url(#at3-ear-l)" stroke-width="32" stroke-linecap="round"/>

    <!-- Top-Right Aperture Blade (Hound Right Ear) -->
    <path d="M 256 220 C 282 160 342 120 388 160 C 412 180 402 240 332 270"
          fill="none" stroke="url(#at3-ear-r)" stroke-width="32" stroke-linecap="round"/>

    <!-- Bottom Aperture Blade (Hound Snout & Terminal Chevron >) -->
    <path d="M 180 286 L 256 362 L 332 286"
          fill="none" stroke="url(#at3-snout)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>

    <!-- Central Aperture AI Focal Point -->
    <circle cx="256" cy="272" r="14" fill="#00f2fe" filter="drop-shadow(0 0 10px #00f2fe)"/>
    <circle cx="256" cy="272" r="5" fill="#ffffff"/>
  </g>
</svg>`;

// 4. Code Chevrons Triad (3x Terminal > Prompt Iris)
const svg4 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="at4-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#111218"/>
      <stop offset="50%" stop-color="#08090d"/>
      <stop offset="100%" stop-color="#010203"/>
    </linearGradient>
    <linearGradient id="at4-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#10b981" stop-opacity="0.2"/>
    </linearGradient>
    <linearGradient id="at4-chev-1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00f2fe"/>
      <stop offset="100%" stop-color="#0284c7"/>
    </linearGradient>
    <linearGradient id="at4-chev-2" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#10b981"/>
      <stop offset="100%" stop-color="#047857"/>
    </linearGradient>
    <linearGradient id="at4-chev-3" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fbbf24"/>
      <stop offset="100%" stop-color="#d97706"/>
    </linearGradient>
    <filter id="at4-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#at4-bg)" filter="url(#at4-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#at4-rim)" stroke-width="1.5"/>

  <!-- Command Line Prompts in 120° Triad Orbit -->
  <g stroke-linecap="round" stroke-linejoin="round" fill="none">
    <!-- Chevron 1 (Top) -->
    <path d="M 216 110 L 296 160 L 216 210" stroke="url(#at4-chev-1)" stroke-width="32"/>
    <line x1="316" y1="210" x2="356" y2="210" stroke="#00f2fe" stroke-width="16"/>

    <!-- Chevron 2 (Bottom Right - 120deg) -->
    <g transform="rotate(120 256 256)">
      <path d="M 216 110 L 296 160 L 216 210" stroke="url(#at4-chev-2)" stroke-width="32"/>
      <line x1="316" y1="210" x2="356" y2="210" stroke="#10b981" stroke-width="16"/>
    </g>

    <!-- Chevron 3 (Bottom Left - 240deg) -->
    <g transform="rotate(240 256 256)">
      <path d="M 216 110 L 296 160 L 216 210" stroke="url(#at4-chev-3)" stroke-width="32"/>
      <line x1="316" y1="210" x2="356" y2="210" stroke="#fbbf24" stroke-width="16"/>
    </g>
  </g>

  <!-- Central Singularity Cursor -->
  <circle cx="256" cy="256" r="14" fill="#ffffff" filter="drop-shadow(0 0 8px #ffffff)"/>
</svg>`;

// 5. Neon Cyber Vortex (Speed Trails & Particle Tracks)
const svg5 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="at5-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f1016"/>
      <stop offset="50%" stop-color="#06070a"/>
      <stop offset="100%" stop-color="#010102"/>
    </linearGradient>
    <linearGradient id="at5-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="50%" stop-color="#c084fc" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="at5-neon-1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00f2fe" stop-opacity="0.1"/>
      <stop offset="50%" stop-color="#00f2fe"/>
      <stop offset="100%" stop-color="#ffffff"/>
    </linearGradient>
    <linearGradient id="at5-neon-2" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f43f5e" stop-opacity="0.1"/>
      <stop offset="50%" stop-color="#f43f5e"/>
      <stop offset="100%" stop-color="#ffffff"/>
    </linearGradient>
    <linearGradient id="at5-neon-3" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#a855f7" stop-opacity="0.1"/>
      <stop offset="50%" stop-color="#a855f7"/>
      <stop offset="100%" stop-color="#ffffff"/>
    </linearGradient>
    <filter id="at5-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="8" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
    <filter id="at5-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#at5-bg)" filter="url(#at5-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#at5-rim)" stroke-width="1.5"/>

  <!-- Radial Speed Lines -->
  <circle cx="256" cy="256" r="150" fill="none" stroke="#ffffff" stroke-width="1" opacity="0.08" stroke-dasharray="2 12"/>
  <circle cx="256" cy="256" r="100" fill="none" stroke="#ffffff" stroke-width="1" opacity="0.05" stroke-dasharray="4 8"/>

  <!-- 3 Neon Cyber Speed Vortex Trails -->
  <g fill="none" stroke-width="26" stroke-linecap="round" filter="url(#at5-glow)">
    <!-- Trail 1 -->
    <path d="M 170 120 C 260 90 360 140 380 230 C 390 270 370 310 330 330" stroke="url(#at5-neon-1)"/>
    <!-- Trail 2 -->
    <path d="M 170 120 C 260 90 360 140 380 230 C 390 270 370 310 330 330" stroke="url(#at5-neon-2)" transform="rotate(120 256 256)"/>
    <!-- Trail 3 -->
    <path d="M 170 120 C 260 90 360 140 380 230 C 390 270 370 310 330 330" stroke="url(#at5-neon-3)" transform="rotate(240 256 256)"/>
  </g>

  <!-- Comet Head Nodes -->
  <circle cx="330" cy="330" r="10" fill="#ffffff" filter="drop-shadow(0 0 10px #00f2fe)"/>
  <circle cx="330" cy="330" r="10" fill="#ffffff" transform="rotate(120 256 256)" filter="drop-shadow(0 0 10px #f43f5e)"/>
  <circle cx="330" cy="330" r="10" fill="#ffffff" transform="rotate(240 256 256)" filter="drop-shadow(0 0 10px #a855f7)"/>

  <!-- Central Supernova Spark -->
  <circle cx="256" cy="256" r="12" fill="#ffffff"/>
  <circle cx="256" cy="256" r="28" fill="none" stroke="#00f2fe" stroke-width="2" opacity="0.6"/>
</svg>`;

// 6. Machined Titanium & Laser Engraved Hardware Aperture
const svg6 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="at6-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#181920"/>
      <stop offset="50%" stop-color="#0c0d12"/>
      <stop offset="100%" stop-color="#030406"/>
    </linearGradient>
    <linearGradient id="at6-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#475569" stop-opacity="0.2"/>
    </linearGradient>
    <linearGradient id="at6-titanium" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f1f5f9"/>
      <stop offset="30%" stop-color="#cbd5e1"/>
      <stop offset="70%" stop-color="#64748b"/>
      <stop offset="100%" stop-color="#334155"/>
    </linearGradient>
    <filter id="at6-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#at6-bg)" filter="url(#at6-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#at6-rim)" stroke-width="1.5"/>

  <!-- Calibrated Metric Dial Scale Ring -->
  <circle cx="256" cy="256" r="165" fill="none" stroke="#94a3b8" stroke-width="1" opacity="0.3"/>
  <circle cx="256" cy="256" r="155" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.15" stroke-dasharray="2 10"/>

  <!-- 3 CNC Chamfered Titanium Blades -->
  <g id="titanium-shutter">
    <!-- Blade 1 -->
    <path d="M 256 110 L 370 176 L 330 246 L 270 212 L 256 110 Z" fill="url(#at6-titanium)" stroke="#ffffff" stroke-width="1.5"/>
    <!-- Blade 2 (120) -->
    <path d="M 256 110 L 370 176 L 330 246 L 270 212 L 256 110 Z" fill="url(#at6-titanium)" stroke="#ffffff" stroke-width="1.5" transform="rotate(120 256 256)"/>
    <!-- Blade 3 (240) -->
    <path d="M 256 110 L 370 176 L 330 246 L 270 212 L 256 110 Z" fill="url(#at6-titanium)" stroke="#ffffff" stroke-width="1.5" transform="rotate(240 256 256)"/>
  </g>

  <!-- Precision Pivot Hardware Screws -->
  <circle cx="330" cy="246" r="6" fill="#1e293b" stroke="#94a3b8" stroke-width="1.5"/>
  <circle cx="330" cy="246" r="6" fill="#1e293b" stroke="#94a3b8" stroke-width="1.5" transform="rotate(120 256 256)"/>
  <circle cx="330" cy="246" r="6" fill="#1e293b" stroke="#94a3b8" stroke-width="1.5" transform="rotate(240 256 256)"/>

  <!-- Center Amber Laser Sensor Indicator -->
  <circle cx="256" cy="256" r="16" fill="#f59e0b" filter="drop-shadow(0 0 12px #f59e0b)"/>
  <circle cx="256" cy="256" r="6" fill="#ffffff"/>
</svg>`;

// 7. Liquid Triquetra (3D Continuous Trefoil Mobius Ribbon)
const svg7 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="at7-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#13141a"/>
      <stop offset="50%" stop-color="#08080c"/>
      <stop offset="100%" stop-color="#010203"/>
    </linearGradient>
    <linearGradient id="at7-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="50%" stop-color="#38bdf8" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="at7-loop-1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="50%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#a855f7"/>
    </linearGradient>
    <linearGradient id="at7-loop-2" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#a855f7"/>
      <stop offset="50%" stop-color="#f43f5e"/>
      <stop offset="100%" stop-color="#fb923c"/>
    </linearGradient>
    <linearGradient id="at7-loop-3" x1="0%" y1="100%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#fb923c"/>
      <stop offset="50%" stop-color="#34d399"/>
      <stop offset="100%" stop-color="#38bdf8"/>
    </linearGradient>
    <filter id="at7-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#at7-bg)" filter="url(#at7-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#at7-rim)" stroke-width="1.5"/>

  <!-- 3D Liquid Triquetra Loop -->
  <g fill="none" stroke-width="34" stroke-linecap="round" stroke-linejoin="round">
    <!-- Strand 1 -->
    <path d="M 256 128 C 340 128 380 200 380 270 C 380 340 320 384 256 384 C 192 384 132 340 132 270" stroke="url(#at7-loop-1)"/>
    <!-- Strand 2 (Rotated 120) -->
    <path d="M 256 128 C 340 128 380 200 380 270 C 380 340 320 384 256 384 C 192 384 132 340 132 270" stroke="url(#at7-loop-2)" transform="rotate(120 256 256)"/>
    <!-- Strand 3 (Rotated 240) -->
    <path d="M 256 128 C 340 128 380 200 380 270 C 380 340 320 384 256 384 C 192 384 132 340 132 270" stroke="url(#at7-loop-3)" transform="rotate(240 256 256)"/>
  </g>

  <!-- Overlapping Specular Highlights -->
  <circle cx="256" cy="256" r="16" fill="#ffffff" filter="drop-shadow(0 0 12px #ffffff)"/>
  <circle cx="256" cy="256" r="6" fill="#090a0f"/>
</svg>`;

// 8. Ghostty / CLI Phosphor Green Dot-Matrix Triad
const svg8 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="at8-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0a120c"/>
      <stop offset="50%" stop-color="#050a06"/>
      <stop offset="100%" stop-color="#010302"/>
    </linearGradient>
    <linearGradient id="at8-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#22c55e" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <filter id="at8-phosphor-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="6" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
    <filter id="at8-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#at8-bg)" filter="url(#at8-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#at8-rim)" stroke-width="1.5"/>

  <!-- Segmented CRT Phosphor Matrix Track -->
  <g fill="#22c55e" filter="url(#at8-phosphor-glow)">
    <!-- Arm 1 (0 deg) -->
    <g id="dot-arm">
      <rect x="246" y="100" width="20" height="20" rx="4"/>
      <rect x="274" y="108" width="20" height="20" rx="4"/>
      <rect x="302" y="122" width="20" height="20" rx="4"/>
      <rect x="326" y="142" width="20" height="20" rx="4"/>
      <rect x="344" y="168" width="20" height="20" rx="4"/>
      <rect x="354" y="198" width="20" height="20" rx="4"/>
      <rect x="354" y="228" width="20" height="20" rx="4"/>
    </g>

    <!-- Arm 2 (120 deg) -->
    <use href="#dot-arm" transform="rotate(120 256 256)"/>

    <!-- Arm 3 (240 deg) -->
    <use href="#dot-arm" transform="rotate(240 256 256)"/>
  </g>

  <!-- Center Terminal Prompt Glyph >_ -->
  <g stroke="#4ade80" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" fill="none" filter="url(#at8-phosphor-glow)">
    <path d="M 236 236 L 260 256 L 236 276"/>
    <line x1="268" y1="276" x2="284" y2="276"/>
  </g>
</svg>`;

// 9. Prism Refraction & Translucent Glass Blades (Cyan / Rose / Amber Multi-Model)
const svg9 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="at9-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#14151e"/>
      <stop offset="50%" stop-color="#090a10"/>
      <stop offset="100%" stop-color="#020204"/>
    </linearGradient>
    <linearGradient id="at9-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="at9-cyan" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00f2fe" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#0284c7" stop-opacity="0.2"/>
    </linearGradient>
    <linearGradient id="at9-rose" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f43f5e" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#881337" stop-opacity="0.2"/>
    </linearGradient>
    <linearGradient id="at9-amber" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fbbf24" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#b45309" stop-opacity="0.2"/>
    </linearGradient>
    <filter id="at9-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#at9-bg)" filter="url(#at9-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#at9-rim)" stroke-width="1.5"/>

  <!-- 3 Overlapping Optical Glass Petals (Cyan / Rose / Amber) -->
  <g style="mix-blend-mode: screen;">
    <!-- Petal 1: Cyan -->
    <path d="M 256 120 C 340 120 380 180 380 256 C 380 290 350 320 310 320 C 260 320 220 270 220 220 Z"
          fill="url(#at9-cyan)" stroke="#ffffff" stroke-width="1.5" stroke-opacity="0.4"/>

    <!-- Petal 2: Rose (120) -->
    <path d="M 256 120 C 340 120 380 180 380 256 C 380 290 350 320 310 320 C 260 320 220 270 220 220 Z"
          fill="url(#at9-rose)" stroke="#ffffff" stroke-width="1.5" stroke-opacity="0.4" transform="rotate(120 256 256)"/>

    <!-- Petal 3: Amber (240) -->
    <path d="M 256 120 C 340 120 380 180 380 256 C 380 290 350 320 310 320 C 260 320 220 270 220 220 Z"
          fill="url(#at9-amber)" stroke="#ffffff" stroke-width="1.5" stroke-opacity="0.4" transform="rotate(240 256 256)"/>
  </g>

  <!-- Central High-Refraction Prism Core -->
  <circle cx="256" cy="256" r="18" fill="#ffffff" filter="drop-shadow(0 0 14px #ffffff)"/>
  <circle cx="256" cy="256" r="8" fill="#00f2fe"/>
</svg>`;

// 10. Linear & Swiss Bauhaus Concentric Wireframe Triad
const svg10 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="at10-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#121316"/>
      <stop offset="50%" stop-color="#08080a"/>
      <stop offset="100%" stop-color="#020203"/>
    </linearGradient>
    <linearGradient id="at10-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <filter id="at10-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#at10-bg)" filter="url(#at10-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#at10-rim)" stroke-width="1.5"/>

  <!-- Blueprint Layout Grid Substrate -->
  <circle cx="256" cy="256" r="160" fill="none" stroke="#ffffff" stroke-width="1" opacity="0.1"/>
  <circle cx="256" cy="256" r="110" fill="none" stroke="#ffffff" stroke-width="1" opacity="0.06"/>
  <circle cx="256" cy="256" r="60" fill="none" stroke="#ffffff" stroke-width="1" opacity="0.04"/>

  <!-- Double Concentric Wireframe Arcs (Linear Precision) -->
  <g fill="none" stroke="#ffffff" stroke-linecap="round">
    <!-- Outer Arc Track (Stroke 16) -->
    <path d="M 236 106 A 150 150 0 0 1 396 200" stroke-width="16"/>
    <path d="M 236 106 A 150 150 0 0 1 396 200" stroke-width="16" transform="rotate(120 256 256)"/>
    <path d="M 236 106 A 150 150 0 0 1 396 200" stroke-width="16" transform="rotate(240 256 256)" stroke="#38bdf8"/>

    <!-- Inner Parallel Line (Stroke 6) -->
    <path d="M 244 140 A 116 116 0 0 1 368 214" stroke-width="6" opacity="0.7"/>
    <path d="M 244 140 A 116 116 0 0 1 368 214" stroke-width="6" opacity="0.7" transform="rotate(120 256 256)"/>
    <path d="M 244 140 A 116 116 0 0 1 368 214" stroke-width="6" stroke="#38bdf8" transform="rotate(240 256 256)"/>
  </g>

  <!-- Precision Crosshair Center -->
  <line x1="256" y1="236" x2="256" y2="276" stroke="#ffffff" stroke-width="2"/>
  <line x1="236" y1="256" x2="276" y2="256" stroke="#ffffff" stroke-width="2"/>
  <circle cx="256" cy="256" r="6" fill="#38bdf8"/>
</svg>`;

// 11. Cyberpunk Hexagonal Iris Diaphragm (60°/120° Angle Aperture)
const svg11 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="at11-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#13141a"/>
      <stop offset="50%" stop-color="#08090d"/>
      <stop offset="100%" stop-color="#010204"/>
    </linearGradient>
    <linearGradient id="at11-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="50%" stop-color="#00f2fe" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="at11-hex-1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00f2fe"/>
      <stop offset="100%" stop-color="#0284c7"/>
    </linearGradient>
    <linearGradient id="at11-hex-2" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#94a3b8"/>
    </linearGradient>
    <filter id="at11-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#at11-bg)" filter="url(#at11-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#at11-rim)" stroke-width="1.5"/>

  <!-- Hexagonal Substrate Frame -->
  <polygon points="256,96 394,176 394,336 256,416 118,336 118,176" fill="none" stroke="#ffffff" stroke-width="1" opacity="0.12" stroke-dasharray="6 8"/>

  <!-- 3 Angular Chevron Shutter Plates -->
  <g id="hex-shutter">
    <!-- Plate 1 -->
    <polygon points="256,128 360,188 320,248 240,202" fill="url(#at11-hex-1)"/>
    <!-- Plate 2 (120) -->
    <polygon points="256,128 360,188 320,248 240,202" fill="url(#at11-hex-2)" transform="rotate(120 256 256)"/>
    <!-- Plate 3 (240) -->
    <polygon points="256,128 360,188 320,248 240,202" fill="url(#at11-hex-1)" transform="rotate(240 256 256)"/>
  </g>

  <!-- Central Hexagonal Aperture Core -->
  <polygon points="256,226 282,241 282,271 256,286 230,271 230,241" fill="#00f2fe" filter="drop-shadow(0 0 10px #00f2fe)"/>
  <circle cx="256" cy="256" r="5" fill="#ffffff"/>
</svg>`;

// 12. Gold & Obsidian Luxury Stealth Crest
const svg12 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="at12-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#161512"/>
      <stop offset="50%" stop-color="#0a0907"/>
      <stop offset="100%" stop-color="#020202"/>
    </linearGradient>
    <linearGradient id="at12-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fbbf24" stop-opacity="0.4"/>
      <stop offset="50%" stop-color="#d97706" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="at12-gold-1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fef08a"/>
      <stop offset="50%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#b45309"/>
    </linearGradient>
    <linearGradient id="at12-gold-2" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#fef9c3"/>
      <stop offset="60%" stop-color="#d97706"/>
      <stop offset="100%" stop-color="#78350f"/>
    </linearGradient>
    <filter id="at12-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#at12-bg)" filter="url(#at12-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#at12-rim)" stroke-width="1.5"/>

  <!-- Luxury Ring Accent -->
  <circle cx="256" cy="256" r="150" fill="none" stroke="url(#at12-gold-1)" stroke-width="1" opacity="0.3"/>

  <!-- 3 Swept Champagne Gold Aperture Arcs -->
  <g fill="none" stroke-width="32" stroke-linecap="round">
    <path d="M 236 116 A 140 140 0 0 1 390 206" stroke="url(#at12-gold-1)"/>
    <path d="M 236 116 A 140 140 0 0 1 390 206" stroke="url(#at12-gold-2)" transform="rotate(120 256 256)"/>
    <path d="M 236 116 A 140 140 0 0 1 390 206" stroke="url(#at12-gold-1)" transform="rotate(240 256 256)"/>
  </g>

  <!-- Solid Champagne Gold Kernel -->
  <circle cx="256" cy="256" r="18" fill="url(#at12-gold-1)" filter="drop-shadow(0 0 14px rgba(245, 158, 11, 0.7))"/>
  <circle cx="256" cy="256" r="6" fill="#161512"/>
</svg>`;

// Write all Aperture Triad Variations
const apertureList = [
  {
    file: 'aperture-triad-1-classic-refined.svg',
    title: 'Aperture Triad • Classic Refined',
    category: 'aperture',
    categoryName: 'Aperture Triad',
    tag: 'Rotational Iris',
    style: '정밀 120° 회전 대칭 스웹트 아크 & 사이언/바이올렛 그라디언트 코어',
    content: svg1,
    accent: '#38bdf8'
  },
  {
    file: 'aperture-triad-2-solid-blades.svg',
    title: 'Aperture Triad • Diaphragm Blades',
    category: 'aperture',
    categoryName: 'Aperture Triad',
    tag: 'Shutter Diaphragm',
    style: '카메라 조리개 셔터 블레이드 3장이 맞물려 형성하는 삼각 AI 포컬 포인트',
    content: svg2,
    accent: '#cbd5e1'
  },
  {
    file: 'aperture-triad-3-hound-iris.svg',
    title: 'Aperture Triad • Hound Hybrid',
    category: 'aperture',
    categoryName: 'Aperture Triad',
    tag: 'Canine + Aperture',
    style: '상단 2개 블레이드는 강아지 귀, 하단 블레이드는 터미널 셰브론 코를 이루는 하이브리드',
    content: svg3,
    accent: '#f43f5e'
  },
  {
    file: 'aperture-triad-4-code-chevrons.svg',
    title: 'Aperture Triad • CLI Prompt Chevrons',
    category: 'aperture',
    categoryName: 'Aperture Triad',
    tag: 'Terminal Syntax >_',
    style: '터미널 프롬프트 셰브론(>) 3개가 120도 회전 궤도를 그리며 중앙 커서로 집중',
    content: svg4,
    accent: '#10b981'
  },
  {
    file: 'aperture-triad-5-neon-vortex.svg',
    title: 'Aperture Triad • Cyber Neon Vortex',
    category: 'aperture',
    categoryName: 'Aperture Triad',
    tag: 'Particle Trail',
    style: '사이언/마젠타/퍼플 레이저 광선 꼬리와 혜성 헤드가 회전하는 사이버네틱 볼텍스',
    content: svg5,
    accent: '#c084fc'
  },
  {
    file: 'aperture-triad-6-machined-titanium.svg',
    title: 'Aperture Triad • Machined Titanium',
    category: 'aperture',
    categoryName: 'Aperture Triad',
    tag: 'Hardware CNC',
    style: 'CNC 챔퍼 가공된 티타늄 셔터 플레이트와 정밀 눈금 다이얼, 앰버 레이저 센서',
    content: svg6,
    accent: '#f59e0b'
  },
  {
    file: 'aperture-triad-7-liquid-triquetra.svg',
    title: 'Aperture Triad • Liquid Triquetra',
    category: 'aperture',
    categoryName: 'Aperture Triad',
    tag: '3D Mobius Trefoil',
    style: '끝없이 순환하는 3차원 유체 뫼비우스 트리케트라 리본과 스펙큘러 하이라이트',
    content: svg7,
    accent: '#38bdf8'
  },
  {
    file: 'aperture-triad-8-phosphor-matrix.svg',
    title: 'Aperture Triad • CRT Phosphor Matrix',
    category: 'aperture',
    categoryName: 'Aperture Triad',
    tag: 'Ghostty Dot Matrix',
    style: '인광체 그린 도트 매트릭스 세그먼트 트랙과 중앙 >_ 프롬프트가 결합된 터미널 룬',
    content: svg8,
    accent: '#22c55e'
  },
  {
    file: 'aperture-triad-9-prism-refraction.svg',
    title: 'Aperture Triad • Prism Refraction',
    category: 'aperture',
    categoryName: 'Aperture Triad',
    tag: 'Multi-Model Glass',
    style: '사이언/로즈/앰버 3원색 반투명 광학 글래스 페탈이 오버랩되는 멀티 모델 합성',
    content: svg9,
    accent: '#00f2fe'
  },
  {
    file: 'aperture-triad-10-monoline-wireframe.svg',
    title: 'Aperture Triad • Linear Wireframe',
    category: 'aperture',
    categoryName: 'Aperture Triad',
    tag: 'Swiss Monoline',
    style: '이중 동심 정밀 와이어프레임과 청사진 레이아웃 그리드가 조화된 스위스 모더니즘',
    content: svg10,
    accent: '#ffffff'
  },
  {
    file: 'aperture-triad-11-hex-diaphragm.svg',
    title: 'Aperture Triad • Hex Cyber Iris',
    category: 'aperture',
    categoryName: 'Aperture Triad',
    tag: 'Hexagon Cyberpunk',
    style: '60°/120° 각면 셰브론 셔터 플레이트와 사이버네틱 헥사곤 조리개 코어',
    content: svg11,
    accent: '#00f2fe'
  },
  {
    file: 'aperture-triad-12-gold-obsidian.svg',
    title: 'Aperture Triad • Gold & Obsidian Crest',
    category: 'aperture',
    categoryName: 'Aperture Triad',
    tag: 'Luxury Stealth',
    style: '딥 옵시디언 블랙 바탕 위의 샴페인 골드 스웹트 아크와 솔리드 골드 커널 엠블럼',
    content: svg12,
    accent: '#fbbf24'
  }
];

// Write individual SVG files
for (const item of apertureList) {
  writeFileSync(`design/logo-concepts/${item.file}`, item.content, 'utf8');
}

console.log(`Generated ${apertureList.length} Aperture Triad SVG variations!`);

// Now update the Master Showcase Generator
const dir = 'design/logo-concepts';
const allSvgFiles = readdirSync(dir).filter(f => f.endsWith('.svg')).sort();

console.log(`Total SVGs now: ${allSvgFiles.length}`);

// Generate a specialized Aperture Triad Showcase HTML
const apertureHtml = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mixdog • Aperture Triad Specialized Design Suite</title>
  <style>
    :root {
      --bg: #07080b;
      --bg-surface: #0e1118;
      --bg-card: #131722;
      --bg-card-hover: #1b2030;
      --border: rgba(255, 255, 255, 0.08);
      --border-accent: rgba(56, 189, 248, 0.45);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --cyan: #38bdf8;
      --indigo: #818cf8;
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
        radial-gradient(circle at 50% 0%, rgba(56, 189, 248, 0.16) 0%, transparent 60%),
        radial-gradient(circle at 80% 25%, rgba(244, 63, 94, 0.08) 0%, transparent 50%),
        radial-gradient(circle at 20% 40%, rgba(251, 191, 36, 0.08) 0%, transparent 50%);
      pointer-events: none;
      z-index: 0;
    }

    .container {
      position: relative;
      z-index: 1;
      max-width: 1480px;
      margin: 0 auto;
      padding: 48px 24px 120px;
    }

    /* Top Nav */
    .top-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 40px;
    }

    .back-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      color: var(--text-muted);
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      transition: all 0.2s;
    }

    .back-btn:hover {
      background: rgba(255, 255, 255, 0.12);
      color: #fff;
    }

    /* Header */
    header {
      text-align: center;
      max-width: 920px;
      margin: 0 auto 56px;
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
      margin-bottom: 20px;
      box-shadow: 0 0 20px rgba(56, 189, 248, 0.2);
    }

    header h1 {
      font-size: 46px;
      font-weight: 800;
      letter-spacing: -0.03em;
      line-height: 1.15;
      margin-bottom: 16px;
      background: linear-gradient(135deg, #ffffff 0%, #e2e8f0 50%, #94a3b8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    header p {
      font-size: 16px;
      color: var(--text-muted);
      line-height: 1.6;
    }

    /* Benchmark Intro Banner */
    .intro-banner {
      background: linear-gradient(135deg, rgba(56, 189, 248, 0.08) 0%, rgba(99, 102, 241, 0.08) 100%);
      border: 1px solid rgba(56, 189, 248, 0.2);
      border-radius: var(--radius-xl);
      padding: 32px 36px;
      margin-bottom: 56px;
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 32px;
      align-items: center;
    }

    .intro-banner img {
      width: 120px;
      height: 120px;
      filter: drop-shadow(0 0 20px rgba(56, 189, 248, 0.4));
    }

    .intro-text h3 {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 8px;
      color: #fff;
    }

    .intro-text p {
      font-size: 14px;
      color: var(--text-muted);
      line-height: 1.6;
    }

    /* Section Headers */
    .section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 48px 0 24px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }

    .section-title h2 {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    /* 12 Variations Grid */
    .variations-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(330px, 1fr));
      gap: 24px;
      margin-bottom: 56px;
    }

    .variation-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 24px;
      display: flex;
      flex-direction: column;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
      cursor: pointer;
    }

    .variation-card:hover {
      transform: translateY(-6px);
      border-color: var(--border-accent);
      background: var(--bg-card-hover);
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6), 0 0 30px rgba(56, 189, 248, 0.15);
    }

    .card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .tag-pill {
      font-size: 11px;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--text);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .card-img-wrap {
      background: #090a0f;
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: var(--radius-md);
      padding: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 18px;
    }

    .card-img-wrap img {
      width: 140px;
      height: 140px;
      transition: transform 0.3s ease;
    }

    .variation-card:hover .card-img-wrap img {
      transform: scale(1.08);
    }

    .card-content h3 {
      font-size: 17px;
      font-weight: 700;
      margin-bottom: 6px;
      color: #ffffff;
    }

    .card-content .style-desc {
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
    }

    .btn-action {
      flex: 1;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      text-align: center;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
    }

    .btn-action.inspect {
      background: rgba(56, 189, 248, 0.15);
      color: var(--cyan);
      border: 1px solid rgba(56, 189, 248, 0.3);
    }

    .btn-action.inspect:hover {
      background: var(--cyan);
      color: #000;
    }

    /* Live Multi-Environment Interactive Simulator */
    .sim-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      padding: 36px;
      margin-bottom: 56px;
    }

    .sim-selector {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 24px;
    }

    .sim-btn {
      padding: 8px 14px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .sim-btn.active, .sim-btn:hover {
      background: var(--cyan);
      color: #000;
      border-color: var(--cyan);
      font-weight: 700;
    }

    .ide-window {
      background: #11131a;
      border: 1px solid #232838;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.7);
    }

    .ide-titlebar {
      height: 40px;
      background: #0d0f15;
      display: flex;
      align-items: center;
      padding: 0 16px;
      border-bottom: 1px solid #1c212f;
      gap: 12px;
    }

    .ide-dots { display: flex; gap: 6px; }
    .ide-dot { width: 10px; height: 10px; border-radius: 50%; }
    .dot-r { background: #ef4444; }
    .dot-y { background: #eab308; }
    .dot-g { background: #22c55e; }

    .ide-tab {
      background: #11131a;
      border: 1px solid #232838;
      border-bottom: none;
      padding: 6px 14px;
      border-radius: 6px 6px 0 0;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
      color: #e2e8f0;
    }

    .ide-tab img { width: 16px; height: 16px; }

    .ide-body {
      padding: 24px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      color: #94a3b8;
      line-height: 1.7;
    }

    .code-hl { color: var(--cyan); }
    .code-str { color: #a7f3d0; }
    .code-kw { color: #f472b6; }
    .code-fn { color: #60a5fa; }

    /* Modal Inspector */
    .modal-backdrop {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(12px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 100;
      padding: 24px;
    }

    .modal-backdrop.open { display: flex; }

    .modal-card {
      background: #11141d;
      border: 1px solid #23293a;
      border-radius: var(--radius-xl);
      max-width: 780px;
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
      background: #080a0e;
      border-radius: 20px;
      padding: 20px;
      border: 1px solid rgba(255,255,255,0.08);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .modal-hero img { width: 100%; height: 100%; }

    .modal-details { flex: 1; min-width: 280px; }

    .modal-scales {
      display: flex;
      align-items: center;
      gap: 16px;
      margin: 20px 0;
      background: #090b10;
      padding: 12px 18px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.05);
    }

    .modal-actions {
      display: flex;
      gap: 12px;
      margin-top: 24px;
    }

    .btn-primary {
      background: var(--cyan);
      color: #000;
      font-weight: 700;
      padding: 10px 20px;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      font-size: 13px;
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      font-weight: 600;
      padding: 10px 20px;
      border-radius: 8px;
      border: 1px solid var(--border);
      cursor: pointer;
      font-size: 13px;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
    }
  </style>
</head>
<body>
  <div class="bg-grid"></div>

  <div class="container">
    <!-- Top Nav -->
    <div class="top-nav">
      <a href="index.html" class="back-btn">← 전체 쇼케이스(Master Showcase)로 돌아가기</a>
      <span style="font-size: 12px; color: var(--text-dim); font-family: 'JetBrains Mono', monospace;">APERTURE-TRIAD-SPEC-V1.0</span>
    </div>

    <!-- Header -->
    <header>
      <div class="badge">🌀 Specialized Design Exploration</div>
      <h1>Aperture Triad • 12 Diverse Variations</h1>
      <p>
        3날 조리개(Aperture)와 120° 삼중 회전 대칭(Triad)을 기반으로<br>
        AI 카메라 센서, 터미널 프롬프트, 하운드 페이스, 티타늄 CNC, 뫼비우스 리본 등 다양한 스타일로 확장한 베리에이션 컬렉션입니다.
      </p>
    </header>

    <!-- Benchmark Intro Banner -->
    <div class="intro-banner">
      <img src="./131-aperture-triad.svg" alt="Original 131 Aperture Triad" />
      <div class="intro-text">
        <h3>오리지널 베이스: 131 · Aperture Triad</h3>
        <p>
          오리지널 131번은 120도 회전 대칭의 3개 아크와 중앙 싱귤래리티 코어로 이루어진 기하학 심볼입니다.
          이 구조는 <strong>다중 모델 믹싱(Multi-Model Orchestration)</strong>과 <strong>지능형 비전/센서(AI Vision)</strong>의 상징성을 동시에 담고 있어, 
          빛과 유리, 메탈 하드웨어, 터미널 코드 문법, 하운드 모티프와 완벽하게 융합될 수 있습니다.
        </p>
      </div>
    </div>

    <!-- Section: 12 Aperture Triad Variations -->
    <div class="section-title">
      <h2>✨ 12가지 Aperture Triad 심층 베리에이션</h2>
      <span style="font-size: 13px; color: var(--text-muted);">카드를 클릭하면 멀티 스케일 및 SVG 코드를 확인할 수 있습니다.</span>
    </div>

    <div class="variations-grid">
      ${apertureList.map((item, idx) => `
        <div class="variation-card" onclick="openInspector('${item.file}', '${item.title}', '${item.tag}')">
          <div class="card-top">
            <span class="tag-pill">${idx + 1}. ${item.tag}</span>
            <span style="font-size: 11px; color: ${item.accent}; font-weight: 700;">APERTURE</span>
          </div>
          <div class="card-img-wrap">
            <img src="./${item.file}" alt="${item.title}" />
          </div>
          <div class="card-content">
            <h3>${item.title.split('•')[1] || item.title}</h3>
            <p class="style-desc">${item.style}</p>
          </div>
          <div class="card-actions">
            <button class="btn-action inspect">🔍 상세 검사 & 복사</button>
          </div>
        </div>
      `).join('')}
    </div>

    <!-- Live Environment Simulator -->
    <div class="section-title">
      <h2>🖥️ Aperture Triad 실시간 환경 시뮬레이터</h2>
      <span style="font-size: 13px; color: var(--text-muted);">IDE 탭(16px), 타이틀바 등 실제 적용 화면을 비교해보세요.</span>
    </div>

    <div class="sim-card">
      <div class="sim-selector" id="sim-controls">
        ${apertureList.map((item, i) => `
          <button class="sim-btn ${i === 0 ? 'active' : ''}" onclick="switchSimLogo('${item.file}', this)">${item.tag.split(' ')[0]}</button>
        `).join('')}
      </div>

      <div class="ide-window">
        <div class="ide-titlebar">
          <div class="ide-dots">
            <div class="ide-dot dot-r"></div>
            <div class="ide-dot dot-y"></div>
            <div class="ide-dot dot-g"></div>
          </div>
          <div class="ide-tab">
            <img id="ide-tab-icon" src="./${apertureList[0].file}" />
            <span>aperture-triad.ts</span>
          </div>
        </div>
        <div class="ide-body">
          <div><span class="code-kw">import</span> { <span class="code-hl">ApertureTriadOrchestrator</span> } <span class="code-kw">from</span> <span class="code-str">'@mixdog/aperture'</span>;</div>
          <div><span class="code-kw">const</span> <span class="code-fn">aperture</span> = <span class="code-kw">new</span> <span class="code-hl">ApertureTriadOrchestrator</span>({</div>
          <div>&nbsp;&nbsp;symmetry: <span class="code-str">'120-degree-rotational-triad'</span>,</div>
          <div>&nbsp;&nbsp;blades: [<span class="code-str">'claude'</span>, <span class="code-str">'gpt-4.5'</span>, <span class="code-str">'gemini-pro'</span>],</div>
          <div>&nbsp;&nbsp;focusCore: <span class="code-str">'singularity-prompt-chevron'</span></div>
          <div>});</div>
          <div><span class="code-kw">await</span> aperture.<span class="code-fn">focusAndExecute</span>();</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Modal Inspector -->
  <div class="modal-backdrop" id="modal-backdrop" onclick="closeInspector(event)">
    <div class="modal-card" onclick="event.stopPropagation()">
      <button class="modal-close" onclick="closeInspector()">✕</button>
      <div class="modal-flex">
        <div class="modal-hero">
          <img id="modal-img" alt="Selected Aperture Triad preview" />
        </div>
        <div class="modal-details">
          <span class="tag-pill" id="modal-tag">Tag</span>
          <h2 id="modal-title" style="font-size: 22px; margin: 8px 0 16px;">Title</h2>
          
          <div style="font-size: 12px; color: var(--text-muted);">멀티 스케일 시인성 테스트:</div>
          <div class="modal-scales">
            <div style="text-align: center;"><img id="scale-64" style="width: 64px; height: 64px;" /><div style="font-size: 10px; color: #64748b; margin-top: 4px;">64px</div></div>
            <div style="text-align: center;"><img id="scale-32" style="width: 32px; height: 32px;" /><div style="font-size: 10px; color: #64748b; margin-top: 4px;">32px</div></div>
            <div style="text-align: center;"><img id="scale-24" style="width: 24px; height: 24px;" /><div style="font-size: 10px; color: #64748b; margin-top: 4px;">24px</div></div>
            <div style="text-align: center;"><img id="scale-16" style="width: 16px; height: 16px;" /><div style="font-size: 10px; color: #64748b; margin-top: 4px;">16px</div></div>
          </div>

          <div class="modal-actions">
            <button class="btn-primary" onclick="copySvgCode()">📋 SVG 코드 복사</button>
            <a id="modal-download" class="btn-secondary" download>⬇️ SVG 다운로드</a>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let currentSvgFile = '';

    function switchSimLogo(file, btn) {
      document.getElementById('ide-tab-icon').src = './' + file;
      const buttons = document.querySelectorAll('#sim-controls .sim-btn');
      buttons.forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
    }

    function openInspector(file, title, tag) {
      currentSvgFile = file;
      document.getElementById('modal-img').src = './' + file;
      document.getElementById('scale-64').src = './' + file;
      document.getElementById('scale-32').src = './' + file;
      document.getElementById('scale-24').src = './' + file;
      document.getElementById('scale-16').src = './' + file;
      document.getElementById('modal-title').innerText = title;
      document.getElementById('modal-tag').innerText = tag;
      document.getElementById('modal-download').href = './' + file;
      document.getElementById('modal-download').setAttribute('download', file);
      document.getElementById('modal-backdrop').classList.add('open');
    }

    function closeInspector(e) {
      document.getElementById('modal-backdrop').classList.remove('open');
    }

    async function copySvgCode() {
      if (!currentSvgFile) return;
      try {
        const res = await fetch('./' + currentSvgFile);
        const text = await res.text();
        await navigator.clipboard.writeText(text);
        alert('Aperture Triad SVG 소스코드가 복사되었습니다!');
      } catch (err) {
        alert('복사 실패: ' + err.message);
      }
    }
  </script>
</body>
</html>
`;

writeFileSync('design/logo-concepts/aperture-triad-showcase.html', apertureHtml.replace(/[ \t]+$/gm, ''), 'utf8');
console.log('✅ Generated aperture-triad-showcase.html successfully!');
