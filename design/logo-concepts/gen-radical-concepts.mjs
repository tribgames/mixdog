import { writeFileSync } from 'node:fs';
import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';

chdir(fileURLToPath(new URL('../..', import.meta.url)));

// 1. Radical 01: Hexa-Runtime (Isometric Hexagon Container + Prompt)
const radical1 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="r1-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#15161c"/>
      <stop offset="50%" stop-color="#090a0d"/>
      <stop offset="100%" stop-color="#010203"/>
    </linearGradient>
    <linearGradient id="r1-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="40%" stop-color="#00f2fe" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <!-- Titanium Hex Facets -->
    <linearGradient id="r1-facet-top-left" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="50%" stop-color="#0284c7"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
    <linearGradient id="r1-facet-top-right" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="40%" stop-color="#cbd5e1"/>
      <stop offset="100%" stop-color="#334155"/>
    </linearGradient>
    <linearGradient id="r1-facet-bottom" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#020617"/>
    </linearGradient>
    <linearGradient id="r1-laser" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00f2fe"/>
      <stop offset="100%" stop-color="#38bdf8"/>
    </linearGradient>
    <filter id="r1-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
    <filter id="r1-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="6" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#r1-bg)" filter="url(#r1-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#r1-rim)" stroke-width="1.5"/>
  
  <!-- Hexagon Wireframe Substrate -->
  <polygon points="256,104 388,180 388,332 256,408 124,332 124,180" fill="none" stroke="#ffffff" stroke-width="1" opacity="0.1" stroke-dasharray="4 6"/>

  <!-- Hexa-Runtime Hound: Precision Geometric Architecture -->
  <g id="hex-hound-mark">
    <!-- Left Top Ear / Isometric Facet -->
    <polygon points="124,180 200,104 256,180 180,224" fill="url(#r1-facet-top-left)"/>
    
    <!-- Right Top Ear / Isometric Facet -->
    <polygon points="388,180 312,104 256,180 332,224" fill="url(#r1-facet-top-right)"/>

    <!-- Left Outer Wall -->
    <polygon points="124,180 180,224 180,332 124,332" fill="url(#r1-facet-bottom)"/>
    
    <!-- Right Outer Wall -->
    <polygon points="388,180 332,224 332,332 388,332" fill="url(#r1-facet-bottom)"/>

    <!-- Center Monolith M Plunge & Snout Arrow -->
    <polygon points="180,224 256,180 332,224 256,268" fill="#475569"/>
    <polygon points="200,296 256,268 312,296 256,368" fill="#ffffff"/>

    <!-- Specular Titanium Edges -->
    <line x1="200" y1="104" x2="256" y2="180" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
    <line x1="312" y1="104" x2="256" y2="180" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
    <line x1="256" y1="268" x2="256" y2="368" stroke="url(#r1-laser)" stroke-width="4" stroke-linecap="round" filter="url(#r1-glow)"/>
    <line x1="124" y1="180" x2="200" y2="104" stroke="#7dd3fc" stroke-width="2"/>
    <line x1="388" y1="180" x2="312" y2="104" stroke="#f1f5f9" stroke-width="2"/>

    <!-- Laser Core Indicator -->
    <circle cx="256" cy="308" r="5" fill="#00f2fe" filter="url(#r1-glow)"/>
  </g>
</svg>`;

// 2. Radical 02: Negative Space Monolith (Brutalist Vercel-Supabase Cut)
const radical2 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="r2-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#131418"/>
      <stop offset="50%" stop-color="#08080b"/>
      <stop offset="100%" stop-color="#000000"/>
    </linearGradient>
    <linearGradient id="r2-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="r2-metal-monolith" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="30%" stop-color="#e2e8f0"/>
      <stop offset="70%" stop-color="#64748b"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
    <linearGradient id="r2-amber-spark" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffedd5"/>
      <stop offset="50%" stop-color="#f97316"/>
      <stop offset="100%" stop-color="#ea580c"/>
    </linearGradient>
    <filter id="r2-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#r2-bg)" filter="url(#r2-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#r2-rim)" stroke-width="1.5"/>

  <!-- Brutalist Negative Space Block -->
  <g id="brutalist-monolith-mark">
    <!-- Outer Shield / Monolithic Plate with Dog Silhouette Carved by Negative Cuts -->
    <path d="M 120 360 L 120 190 L 190 120 L 256 186 L 322 120 L 392 190 L 392 360 L 328 360 L 328 250 L 256 322 L 184 250 L 184 360 Z"
          fill="url(#r2-metal-monolith)"
          fill-rule="evenodd"/>

    <!-- Negative Space Center Arrow (Terminal Prompt Execution Vector) -->
    <polygon points="214,280 256,238 298,280 256,336" fill="url(#r2-amber-spark)"/>

    <!-- Specular Chamfer Highlight Lines -->
    <line x1="120" y1="190" x2="190" y2="120" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
    <line x1="392" y1="190" x2="322" y2="120" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
    <line x1="190" y1="120" x2="256" y2="186" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
    <line x1="322" y1="120" x2="256" y2="186" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
  </g>
</svg>`;

// 3. Radical 03: Infinite Möbius Agent Loop (Continuous Unbroken Flow)
const radical3 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="r3-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#16171e"/>
      <stop offset="50%" stop-color="#0a0b0e"/>
      <stop offset="100%" stop-color="#020204"/>
    </linearGradient>
    <linearGradient id="r3-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#8b5cf6" stop-opacity="0.25"/>
    </linearGradient>
    <linearGradient id="r3-loop-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="35%" stop-color="#6366f1"/>
      <stop offset="70%" stop-color="#a855f7"/>
      <stop offset="100%" stop-color="#f43f5e"/>
    </linearGradient>
    <linearGradient id="r3-metal-stream" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="30%" stop-color="#cbd5e1"/>
      <stop offset="60%" stop-color="#64748b"/>
      <stop offset="100%" stop-color="#e2e8f0"/>
    </linearGradient>
    <filter id="r3-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#r3-bg)" filter="url(#r3-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#r3-rim)" stroke-width="1.5"/>

  <!-- Unbroken Infinite Möbius Ribbon (Ear 1 -> Snout -> Ear 2 -> Base) -->
  <g id="infinite-loop-mark">
    <!-- Base Ribbon Loop -->
    <path d="M 144 352
             C 112 280 112 180 176 136
             C 224 104 256 184 256 220
             C 256 184 288 104 336 136
             C 400 180 400 280 368 352
             C 336 352 320 270 296 232
             L 256 272
             L 216 232
             C 192 270 176 352 144 352 Z"
          fill="url(#r3-metal-stream)"/>

    <!-- Inner Continuous Neon Flow Core -->
    <path d="M 160 336
             C 136 276 136 196 184 156
             C 220 128 244 190 256 226
             C 268 190 292 128 328 156
             C 376 196 376 276 352 336"
          fill="none"
          stroke="url(#r3-loop-grad)"
          stroke-width="10"
          stroke-linecap="round"/>

    <!-- Terminal Prompt Cutout Snout (> Execution Point) -->
    <polygon points="220,296 256,260 292,296 256,348" fill="#ffffff"/>
    <circle cx="256" cy="296" r="4" fill="#6366f1"/>
  </g>
</svg>`;

// 4. Radical 04: Neural Starburst / AI Particle Hound (Anthropic / OpenAI Sparkle)
const radical4 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="r4-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#14151a"/>
      <stop offset="50%" stop-color="#08080b"/>
      <stop offset="100%" stop-color="#010102"/>
    </linearGradient>
    <linearGradient id="r4-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="50%" stop-color="#38bdf8" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="r4-star-metal" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="35%" stop-color="#cbd5e1"/>
      <stop offset="70%" stop-color="#475569"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
    <radialGradient id="r4-core-flare" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="40%" stop-color="#38bdf8"/>
      <stop offset="80%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <filter id="r4-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
    <filter id="r4-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="8" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#r4-bg)" filter="url(#r4-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#r4-rim)" stroke-width="1.5"/>

  <!-- Radial AI Starburst / 8-Ray Canine Particle -->
  <g id="starburst-mark">
    <!-- Ambient Flare Glow -->
    <circle cx="256" cy="256" r="140" fill="url(#r4-core-flare)" opacity="0.2" filter="url(#r4-glow)"/>

    <!-- Left & Right Tall Ear Rays -->
    <path d="M 180 120 L 226 216 L 194 256 L 120 256 L 160 196 Z" fill="url(#r4-star-metal)"/>
    <path d="M 332 120 L 352 196 L 392 256 L 318 256 L 286 216 Z" fill="url(#r4-star-metal)"/>

    <!-- Center Cross & Terminal Prompt Rays -->
    <polygon points="256,164 274,228 348,256 274,284 256,364 238,284 164,256 238,228" fill="#ffffff" filter="url(#r4-glow)"/>

    <!-- Terminal Code Prompt Chevron Over Center Nexus -->
    <path d="M 212 284 L 256 328 L 300 284"
          fill="none"
          stroke="#38bdf8"
          stroke-width="14"
          stroke-linecap="round"
          stroke-linejoin="round"/>

    <!-- Precision AI Core Point -->
    <circle cx="256" cy="256" r="8" fill="#00f2fe" filter="url(#r4-glow)"/>
    <circle cx="256" cy="256" r="3" fill="#ffffff"/>
  </g>
</svg>`;

// 5. Radical 05: Aperture Iris (Multi-Model Optical Core)
const radical5 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="r5-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#15171e"/>
      <stop offset="50%" stop-color="#0a0c10"/>
      <stop offset="100%" stop-color="#020305"/>
    </linearGradient>
    <linearGradient id="r5-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.2"/>
    </linearGradient>
    <!-- Blades Metallic Gradients -->
    <linearGradient id="r5-blade-1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#64748b"/>
    </linearGradient>
    <linearGradient id="r5-blade-2" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#cbd5e1"/><stop offset="100%" stop-color="#334155"/>
    </linearGradient>
    <linearGradient id="r5-blade-3" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#94a3b8"/><stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
    <filter id="r5-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#r5-bg)" filter="url(#r5-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#r5-rim)" stroke-width="1.5"/>

  <!-- Optical Aperture Blades forming M & Ear Silhouette -->
  <g id="aperture-hound-mark" transform="translate(0, 0)">
    <!-- Outer Ears / Wing Blades -->
    <polygon points="120,332 120,204 184,136 244,196 184,256" fill="url(#r5-blade-1)"/>
    <polygon points="392,332 392,204 328,136 268,196 328,256" fill="url(#r5-blade-1)"/>

    <!-- Intersecting Diaphragm Shutter Blades -->
    <polygon points="184,256 244,196 280,244 220,304" fill="url(#r5-blade-2)"/>
    <polygon points="328,256 268,196 232,244 292,304" fill="url(#r5-blade-3)"/>

    <!-- Center Aperture Opening / Prompt Chevron -->
    <polygon points="212,296 256,248 300,296 256,356" fill="#00f2fe"/>
    <polygon points="224,296 256,260 288,296 256,340" fill="#ffffff"/>

    <!-- Laser Alignment Ring -->
    <circle cx="256" cy="256" r="160" fill="none" stroke="#ffffff" stroke-width="1" opacity="0.12" stroke-dasharray="6 12"/>
    <circle cx="256" cy="296" r="4" fill="#0f172a"/>
  </g>
</svg>`;

// 6. Radical 06: Cyberpunk Typographic CLI Glyph (Panic / Teenage Engineering Vibe)
const radical6 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="r6-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#141519"/>
      <stop offset="50%" stop-color="#090a0c"/>
      <stop offset="100%" stop-color="#000000"/>
    </linearGradient>
    <linearGradient id="r6-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="50%" stop-color="#f59e0b" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="r6-safety-yellow" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fef08a"/>
      <stop offset="50%" stop-color="#eab308"/>
      <stop offset="100%" stop-color="#ca8a04"/>
    </linearGradient>
    <filter id="r6-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#r6-bg)" filter="url(#r6-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#r6-rim)" stroke-width="1.5"/>

  <!-- Extreme Typographic CLI Mark: // + >> + M Monogram -->
  <g id="cli-typographic-mark">
    <!-- Outer Heavy Chassis M-Structure -->
    <path d="M 124 356 V 212 L 184 148 L 244 208 L 256 196 L 268 208 L 328 148 L 388 212 V 356"
          fill="none"
          stroke="#ffffff"
          stroke-width="36"
          stroke-linecap="round"
          stroke-linejoin="round"/>

    <!-- High-Visibility Terminal Prompt Snout (Safety Yellow / Cyberpunk Amber) -->
    <path d="M 196 280 L 256 340 L 316 280"
          fill="none"
          stroke="url(#r6-safety-yellow)"
          stroke-width="32"
          stroke-linecap="round"
          stroke-linejoin="round"/>

    <!-- Monospace Blinking Prompt Cursor Block (_) -->
    <line x1="236" y1="236" x2="276" y2="236" stroke="url(#r6-safety-yellow)" stroke-width="14" stroke-linecap="round"/>
  </g>
</svg>`;

writeFileSync('design/logo-concepts/radical-1-hex-runtime.svg', radical1, 'utf8');
writeFileSync('design/logo-concepts/radical-2-negative-monolith.svg', radical2, 'utf8');
writeFileSync('design/logo-concepts/radical-3-infinite-mobius.svg', radical3, 'utf8');
writeFileSync('design/logo-concepts/radical-4-neural-starburst.svg', radical4, 'utf8');
writeFileSync('design/logo-concepts/radical-5-aperture-iris.svg', radical5, 'utf8');
writeFileSync('design/logo-concepts/radical-6-cli-glyph.svg', radical6, 'utf8');

console.log('6 Radical Concept SVGs generated successfully!');
