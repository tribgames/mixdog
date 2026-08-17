import { writeFileSync } from 'node:fs';
import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';

chdir(fileURLToPath(new URL('../..', import.meta.url)));

// 1. Cyber-Hound Side Profile (Agile, aerodynamic running/alert hound with laser visor snout)
const svgHoundProfile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="hp-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#14151c"/>
      <stop offset="50%" stop-color="#090a0e"/>
      <stop offset="100%" stop-color="#020305"/>
    </linearGradient>
    <linearGradient id="hp-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="50%" stop-color="#38bdf8" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="hp-metal" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="35%" stop-color="#cbd5e1"/>
      <stop offset="70%" stop-color="#475569"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
    <linearGradient id="hp-cyan" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00f2fe"/>
      <stop offset="100%" stop-color="#38bdf8"/>
    </linearGradient>
    <linearGradient id="hp-amber" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fbbf24"/>
      <stop offset="100%" stop-color="#f97316"/>
    </linearGradient>
    <filter id="hp-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#hp-bg)" filter="url(#hp-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#hp-rim)" stroke-width="1.5"/>
  
  <!-- Side Profile Stealth Cyber-Hound (Pure Aerodynamic Geometry) -->
  <g id="hound-profile">
    <!-- Back Neck & Torso Foundation -->
    <polygon points="132,364 216,248 168,144 248,188 344,248 388,248 404,268 348,312 256,364" fill="url(#hp-metal)"/>
    <!-- Pointed Cyber Ear (Back Antenna) -->
    <polygon points="168,144 248,188 204,232" fill="#0f172a"/>
    <!-- Forward Snout / Terminal Laser Cutout (Mouth forms > prompt) -->
    <polygon points="404,268 348,312 296,280 344,248 388,248" fill="#ffffff"/>
    <!-- Laser Visor Line -->
    <line x1="284" y1="236" x2="356" y2="236" stroke="url(#hp-cyan)" stroke-width="8" stroke-linecap="round"/>
    <!-- AI Eye Node -->
    <circle cx="280" cy="236" r="6" fill="url(#hp-amber)"/>
  </g>
</svg>`;

// 2. Code Tag Paw Prompt (< > + Code Dots)
const svgTagPaw = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="tp-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#141419"/>
      <stop offset="50%" stop-color="#0a0a0d"/>
      <stop offset="100%" stop-color="#020204"/>
    </linearGradient>
    <linearGradient id="tp-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#a855f7" stop-opacity="0.2"/>
    </linearGradient>
    <linearGradient id="tp-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="50%" stop-color="#818cf8"/>
      <stop offset="100%" stop-color="#c084fc"/>
    </linearGradient>
    <filter id="tp-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#tp-bg)" filter="url(#tp-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#tp-rim)" stroke-width="1.5"/>

  <!-- Code Tag Paw (Terminal Bracket & AI Nodes) -->
  <g id="code-tag-paw">
    <!-- Main Center Prompt Pad: Diamond Chevron (Terminal Execution Pad) -->
    <path d="M 200 272 L 256 216 L 312 272 L 256 328 Z" fill="url(#tp-grad)"/>
    <path d="M 216 328 L 256 368 L 296 328" fill="none" stroke="#ffffff" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>
    
    <!-- 4 Code Token Toe Nodes (AST Syntax Nodes) -->
    <!-- Far Left: Code Bracket < -->
    <path d="M 172 176 L 144 204 L 172 232" fill="none" stroke="#38bdf8" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
    <!-- Top Left Toe: Git Node -->
    <circle cx="216" cy="148" r="22" fill="url(#tp-grad)"/>
    <!-- Top Right Toe: Git Node -->
    <circle cx="296" cy="148" r="22" fill="url(#tp-grad)"/>
    <!-- Far Right: Code Bracket > -->
    <path d="M 340 176 L 368 204 L 340 232" fill="none" stroke="#c084fc" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

// 3. Dot-Matrix Retro Cyber Dog (Nothing OS / Teenage Engineering / TUI)
const svgDotMatrix = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="dm-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#16171d"/>
      <stop offset="50%" stop-color="#0a0b0e"/>
      <stop offset="100%" stop-color="#010203"/>
    </linearGradient>
    <linearGradient id="dm-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <filter id="dm-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="4" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#dm-bg)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#dm-rim)" stroke-width="1.5"/>

  <!-- LED Dot-Matrix Matrix Grid Cyber Dog Face -->
  <g id="led-matrix" fill="#f8fafc" filter="url(#dm-glow)">
    <!-- Left Ear Dots -->
    <circle cx="152" cy="140" r="14"/><circle cx="188" cy="176" r="14"/>
    <!-- Right Ear Dots -->
    <circle cx="360" cy="140" r="14"/><circle cx="324" cy="176" r="14"/>
    <!-- Forehead Matrix -->
    <circle cx="224" cy="212" r="14"/><circle cx="256" cy="212" r="14"/><circle cx="288" cy="212" r="14"/>
    <!-- Eyes (Amber Active LED) -->
    <circle cx="188" cy="248" r="14" fill="#38bdf8"/>
    <circle cx="324" cy="248" r="14" fill="#38bdf8"/>
    <circle cx="256" cy="248" r="14" fill="#334155"/>
    <!-- Snout Vector (>_ Prompt Matrix) -->
    <circle cx="188" cy="292" r="14"/><circle cx="324" cy="292" r="14"/>
    <circle cx="224" cy="328" r="14"/><circle cx="288" cy="328" r="14"/>
    <circle cx="256" cy="364" r="16" fill="#f97316"/>
  </g>
</svg>`;

// 4. Command Rune Keycap (Apple ⌘ / Mac Command Key meets Dog Ears)
const svgCommandRune = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="cr-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#181820"/>
      <stop offset="50%" stop-color="#0b0c10"/>
      <stop offset="100%" stop-color="#030304"/>
    </linearGradient>
    <linearGradient id="cr-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="cr-stroke" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="40%" stop-color="#e2e8f0"/>
      <stop offset="100%" stop-color="#64748b"/>
    </linearGradient>
    <filter id="cr-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#cr-bg)" filter="url(#cr-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#cr-rim)" stroke-width="1.5"/>

  <!-- Command Keycap Loop + Ear Antennas + Terminal Prompt Center -->
  <g id="command-rune">
    <!-- Outer Connected Loop System (Command ⌘ Evolution) -->
    <!-- Top Left Ear Loop -->
    <path d="M 216 192 C 216 148 180 148 160 168 C 140 188 140 224 184 224 L 328 224 C 372 224 372 188 352 168 C 332 148 296 148 296 192 L 296 288 C 296 332 332 332 352 312 C 372 292 372 256 328 256 L 184 256 C 140 256 140 292 160 312 C 180 332 216 332 216 288 Z"
          fill="none"
          stroke="url(#cr-stroke)"
          stroke-width="26"
          stroke-linecap="round"
          stroke-linejoin="round"/>

    <!-- Center Prompt Core (Blinking Cyan Terminal Diamond) -->
    <polygon points="256,220 276,240 256,260 236,240" fill="#38bdf8"/>
  </g>
</svg>`;

// 5. Code Bone Slash (Developer Bone --slash flag)
const svgCodeBone = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="cb-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#14151b"/>
      <stop offset="50%" stop-color="#08090d"/>
      <stop offset="100%" stop-color="#010203"/>
    </linearGradient>
    <linearGradient id="cb-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#10b981" stop-opacity="0.25"/>
    </linearGradient>
    <linearGradient id="cb-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#34d399"/>
      <stop offset="50%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#6366f1"/>
    </linearGradient>
    <filter id="cb-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#cb-bg)" filter="url(#cb-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#cb-rim)" stroke-width="1.5"/>

  <!-- Code Bone Slash (45-degree Precision Developer Bone // ) -->
  <g id="code-bone">
    <!-- 45-degree Diagonal Code Bone Shaft -->
    <rect x="196" y="236" width="120" height="40" rx="12" transform="rotate(-45 256 256)" fill="url(#cb-grad)"/>
    
    <!-- Top Left Terminal Nodes -->
    <circle cx="148" cy="148" r="28" fill="url(#cb-grad)"/>
    <circle cx="188" cy="116" r="28" fill="url(#cb-grad)"/>
    <circle cx="116" cy="188" r="28" fill="url(#cb-grad)"/>
    <polygon points="148,148 188,116 116,188" fill="url(#cb-grad)"/>

    <!-- Bottom Right Terminal Nodes -->
    <circle cx="364" cy="364" r="28" fill="url(#cb-grad)"/>
    <circle cx="324" cy="396" r="28" fill="url(#cb-grad)"/>
    <circle cx="396" cy="324" r="28" fill="url(#cb-grad)"/>
    <polygon points="364,364 324,396 396,324" fill="url(#cb-grad)"/>

    <!-- Center Laser Cutout (Double Forward Slash //) -->
    <line x1="236" y1="284" x2="260" y2="236" stroke="#000000" stroke-width="8" stroke-linecap="round"/>
    <line x1="252" y1="284" x2="276" y2="236" stroke="#000000" stroke-width="8" stroke-linecap="round"/>
  </g>
</svg>`;

// 6. Dual-Orb Multi-Model Mixer (Orchestrator Sound Wave / Lens)
const svgModelMixer = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="mm-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#14151a"/>
      <stop offset="50%" stop-color="#08080c"/>
      <stop offset="100%" stop-color="#010102"/>
    </linearGradient>
    <linearGradient id="mm-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#f43f5e" stop-opacity="0.2"/>
    </linearGradient>
    <linearGradient id="mm-left" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#3b82f6"/>
    </linearGradient>
    <linearGradient id="mm-right" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f43f5e"/>
      <stop offset="100%" stop-color="#fb923c"/>
    </linearGradient>
    <filter id="mm-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#mm-bg)" filter="url(#mm-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#mm-rim)" stroke-width="1.5"/>

  <!-- Multi-Model Mixer: 2 Interlocking Model Lenses forming Canine Face & Prompt -->
  <g id="model-mixer">
    <!-- Left Model Lens (Cyan LLM) -->
    <circle cx="204" cy="232" r="76" fill="url(#mm-left)" opacity="0.85"/>
    <!-- Right Model Lens (Rose LLM) -->
    <circle cx="308" cy="232" r="76" fill="url(#mm-right)" opacity="0.85" style="mix-blend-mode: screen;"/>
    <!-- Top Ears (Pointed Antenna Nodes) -->
    <polygon points="152,180 184,112 216,180" fill="#38bdf8"/>
    <polygon points="296,180 328,112 360,180" fill="#f43f5e"/>
    <!-- Center Intersecting AI Core (White Terminal Snout) -->
    <path d="M 216 264 L 256 316 L 296 264" fill="none" stroke="#ffffff" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="256" cy="288" r="6" fill="#ffffff"/>
  </g>
</svg>`;

writeFileSync('design/logo-concepts/different-1-hound-profile.svg', svgHoundProfile);
writeFileSync('design/logo-concepts/different-2-code-paw.svg', svgTagPaw);
writeFileSync('design/logo-concepts/different-3-dot-matrix.svg', svgDotMatrix);
writeFileSync('design/logo-concepts/different-4-command-rune.svg', svgCommandRune);
writeFileSync('design/logo-concepts/different-5-code-bone.svg', svgCodeBone);
writeFileSync('design/logo-concepts/different-6-model-mixer.svg', svgModelMixer);

console.log('6 completely different concept SVGs written successfully!');
