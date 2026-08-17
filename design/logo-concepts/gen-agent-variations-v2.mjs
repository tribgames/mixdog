import { writeFileSync } from 'node:fs';
import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';

chdir(fileURLToPath(new URL('../..', import.meta.url)));

// ============================================================================
// 12 Super-Detailed 2026 Coding Agent Benchmark Mixdog Logo Variations
// ============================================================================

// 1. Cursor Benchmark: 3D Isometric Hyper-Prism
const svgCursor = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="c-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#14151b"/>
      <stop offset="50%" stop-color="#090a0e"/>
      <stop offset="100%" stop-color="#020204"/>
    </linearGradient>
    <linearGradient id="c-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="50%" stop-color="#38bdf8" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="c-top-left" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#0284c7"/>
    </linearGradient>
    <linearGradient id="c-top-right" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#818cf8"/>
      <stop offset="100%" stop-color="#4f46e5"/>
    </linearGradient>
    <linearGradient id="c-side-l" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0284c7"/>
      <stop offset="100%" stop-color="#082f49"/>
    </linearGradient>
    <linearGradient id="c-side-r" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#4f46e5"/>
      <stop offset="100%" stop-color="#1e1b4b"/>
    </linearGradient>
    <linearGradient id="c-arrow-top" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#cbd5e1"/>
    </linearGradient>
    <linearGradient id="c-arrow-bot" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#94a3b8"/>
      <stop offset="100%" stop-color="#475569"/>
    </linearGradient>
    <radialGradient id="c-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.3"/>
      <stop offset="60%" stop-color="#818cf8" stop-opacity="0.1"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <filter id="c-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="20" stdDeviation="24" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#c-bg)" filter="url(#c-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#c-rim)" stroke-width="1.5"/>
  <circle cx="256" cy="256" r="160" fill="url(#c-glow)"/>

  <!-- 3D Isometric Prism Hound Structure -->
  <g id="cursor-hypercube">
    <!-- Left Ear Prism Cube -->
    <polygon points="128,196 196,156 196,276 128,316" fill="url(#c-side-l)"/>
    <polygon points="128,196 196,156 256,192 188,232" fill="url(#c-top-left)"/>
    
    <!-- Right Ear Prism Cube -->
    <polygon points="384,196 316,156 316,276 384,316" fill="url(#c-side-r)"/>
    <polygon points="384,196 316,156 256,192 324,232" fill="url(#c-top-right)"/>

    <!-- Central Code Execution Chevron / Hound Snout -->
    <polygon points="188,232 256,192 324,232 256,272" fill="url(#c-arrow-top)"/>
    <polygon points="188,232 256,272 256,364 188,324" fill="url(#c-arrow-bot)"/>
    <polygon points="324,232 256,272 256,364 324,324" fill="url(#c-top-left)" opacity="0.8"/>

    <!-- Razor Highlight Seams -->
    <line x1="256" y1="192" x2="256" y2="364" stroke="#ffffff" stroke-width="2.5"/>
    <line x1="128" y1="196" x2="196" y2="156" stroke="#ffffff" stroke-width="1.5" opacity="0.8"/>
    <line x1="384" y1="196" x2="316" y2="156" stroke="#ffffff" stroke-width="1.5" opacity="0.8"/>
    <circle cx="256" cy="272" r="6" fill="#00f2fe"/>
    <circle cx="256" cy="272" r="2.5" fill="#ffffff"/>
  </g>
</svg>`;

// 2. Windsurf Benchmark: Cascade Flow & Aerodynamic Jet Stream
const svgWindsurf = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="w-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#10131d"/>
      <stop offset="50%" stop-color="#080a12"/>
      <stop offset="100%" stop-color="#020306"/>
    </linearGradient>
    <linearGradient id="w-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="50%" stop-color="#06b6d4" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="w-stream-1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#22d3ee"/>
      <stop offset="40%" stop-color="#0ea5e9"/>
      <stop offset="100%" stop-color="#4f46e5"/>
    </linearGradient>
    <linearGradient id="w-stream-2" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="50%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#a855f7"/>
    </linearGradient>
    <linearGradient id="w-core-stream" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="50%" stop-color="#67e8f9"/>
      <stop offset="100%" stop-color="#0284c7"/>
    </linearGradient>
    <filter id="w-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="20" stdDeviation="24" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#w-bg)" filter="url(#w-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#w-rim)" stroke-width="1.5"/>

  <!-- Parallel Cascade Streamline Ribbons (M + Aerodynamic Hound) -->
  <g id="windsurf-cascade">
    <!-- Left Outer Cascade Wave -->
    <path d="M 124 356 C 124 210 168 136 216 156 C 256 172 256 220 256 220" 
          fill="none" stroke="url(#w-stream-1)" stroke-width="32" stroke-linecap="round"/>
    
    <!-- Right Outer Cascade Wave -->
    <path d="M 388 356 C 388 210 344 136 296 156 C 256 172 256 220 256 220" 
          fill="none" stroke="url(#w-stream-2)" stroke-width="32" stroke-linecap="round"/>

    <!-- Inner Parallel Jet Tracks -->
    <path d="M 172 356 C 172 260 196 200 232 216" 
          fill="none" stroke="#ffffff" stroke-width="16" stroke-linecap="round" opacity="0.9"/>
    <path d="M 340 356 C 340 260 316 200 280 216" 
          fill="none" stroke="#ffffff" stroke-width="16" stroke-linecap="round" opacity="0.9"/>

    <!-- Dynamic Forward Snout Chevron Dart -->
    <path d="M 196 280 L 256 348 L 316 280" 
          fill="none" stroke="url(#w-core-stream)" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>

    <!-- Singularity Flow Emitter -->
    <circle cx="256" cy="220" r="11" fill="#00f2fe"/>
    <circle cx="256" cy="220" r="4" fill="#ffffff"/>
  </g>
</svg>`;

// 3. Claude Code Benchmark: Intelligent Asterisk Spark & Warm Brutalism
const svgClaude = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="cl-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1a1412"/>
      <stop offset="50%" stop-color="#100b09"/>
      <stop offset="100%" stop-color="#050302"/>
    </linearGradient>
    <linearGradient id="cl-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="40%" stop-color="#f97316" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="cl-terracotta" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fb923c"/>
      <stop offset="50%" stop-color="#ea580c"/>
      <stop offset="100%" stop-color="#c2410c"/>
    </linearGradient>
    <linearGradient id="cl-charcoal" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fafaf9"/>
      <stop offset="100%" stop-color="#d6d3d1"/>
    </linearGradient>
    <radialGradient id="cl-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ea580c" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <filter id="cl-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="20" stdDeviation="24" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#cl-bg)" filter="url(#cl-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#cl-rim)" stroke-width="1.5"/>
  <circle cx="256" cy="256" r="160" fill="url(#cl-glow)"/>

  <!-- Anthropic Asterisk Spark Meets Hound M Monogram -->
  <g id="claude-spark-hound">
    <!-- Left Brutalist Ear Column -->
    <rect x="124" y="148" width="44" height="216" rx="22" fill="url(#cl-charcoal)"/>
    <polygon points="124,200 168,148 216,200" fill="url(#cl-terracotta)"/>

    <!-- Right Brutalist Ear Column -->
    <rect x="344" y="148" width="44" height="216" rx="22" fill="url(#cl-charcoal)"/>
    <polygon points="388,200 344,148 296,200" fill="url(#cl-terracotta)"/>

    <!-- Center Intelligence Asterisk Node (* Spark) -->
    <!-- Vertical Beam -->
    <rect x="240" y="172" width="32" height="152" rx="16" fill="url(#cl-terracotta)"/>
    <!-- Diagonal Beam 1 -->
    <rect x="240" y="172" width="32" height="152" rx="16" transform="rotate(60 256 248)" fill="url(#cl-terracotta)" opacity="0.9"/>
    <!-- Diagonal Beam 2 -->
    <rect x="240" y="172" width="32" height="152" rx="16" transform="rotate(-60 256 248)" fill="url(#cl-terracotta)" opacity="0.9"/>

    <!-- Central Focus Core / Snout Point -->
    <circle cx="256" cy="248" r="18" fill="#ffffff"/>
    <circle cx="256" cy="248" r="8" fill="#ea580c"/>

    <!-- Terminal Prompt Chevron Snout Underlay -->
    <path d="M 200 312 L 256 364 L 312 312" fill="none" stroke="#ffffff" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

// 4. Devin Benchmark: Autonomous Task Graph (DAG Execution Tree & Emerald Matrix)
const svgDevin = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="d-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0a1714"/>
      <stop offset="50%" stop-color="#040c0a"/>
      <stop offset="100%" stop-color="#010403"/>
    </linearGradient>
    <linearGradient id="d-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="50%" stop-color="#10b981" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="d-emerald" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#34d399"/>
      <stop offset="50%" stop-color="#10b981"/>
      <stop offset="100%" stop-color="#047857"/>
    </linearGradient>
    <radialGradient id="d-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#10b981" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <filter id="d-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="20" stdDeviation="24" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#d-bg)" filter="url(#d-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#d-rim)" stroke-width="1.5"/>
  <circle cx="256" cy="256" r="160" fill="url(#d-glow)"/>

  <!-- Autonomous Task Tree (Directed Acyclic Graph) forming Hound M -->
  <g id="devin-dag-matrix">
    <!-- Graph Edges / Bus Lines -->
    <line x1="136" y1="340" x2="168" y2="168" stroke="#10b981" stroke-width="12" stroke-linecap="round"/>
    <line x1="168" y1="168" x2="256" y2="236" stroke="#34d399" stroke-width="14" stroke-linecap="round"/>
    <line x1="376" y1="340" x2="344" y2="168" stroke="#10b981" stroke-width="12" stroke-linecap="round"/>
    <line x1="344" y1="168" x2="256" y2="236" stroke="#34d399" stroke-width="14" stroke-linecap="round"/>
    
    <!-- Snout Execution Branch -->
    <line x1="256" y1="236" x2="256" y2="352" stroke="#ffffff" stroke-width="16" stroke-linecap="round"/>
    <line x1="184" y1="292" x2="256" y2="352" stroke="#ffffff" stroke-width="14" stroke-linecap="round"/>
    <line x1="328" y1="292" x2="256" y2="352" stroke="#ffffff" stroke-width="14" stroke-linecap="round"/>

    <!-- Active Task Nodes (Glowing Pulse Rings) -->
    <!-- Left Stride Node -->
    <circle cx="136" cy="340" r="18" fill="#064e3b" stroke="#10b981" stroke-width="6"/>
    <circle cx="136" cy="340" r="7" fill="#34d399"/>
    
    <!-- Left Ear Node -->
    <circle cx="168" cy="168" r="22" fill="#064e3b" stroke="#34d399" stroke-width="7"/>
    <circle cx="168" cy="168" r="9" fill="#ffffff"/>

    <!-- Right Ear Node -->
    <circle cx="344" cy="168" r="22" fill="#064e3b" stroke="#34d399" stroke-width="7"/>
    <circle cx="344" cy="168" r="9" fill="#ffffff"/>

    <!-- Right Stride Node -->
    <circle cx="376" cy="340" r="18" fill="#064e3b" stroke="#10b981" stroke-width="6"/>
    <circle cx="376" cy="340" r="7" fill="#34d399"/>

    <!-- Central Orchestrator Core Node -->
    <circle cx="256" cy="236" r="28" fill="#10b981" stroke="#ffffff" stroke-width="6"/>
    <circle cx="256" cy="236" r="12" fill="#ffffff"/>

    <!-- Execution Terminal Apex (Snout Tip) -->
    <polygon points="244,340 268,340 256,364" fill="#34d399"/>
  </g>
</svg>`;

// 5. GitHub Copilot Benchmark: Dual-Pilot Visor & Cyber Neon HUD
const svgCopilot = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="cp-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#181124"/>
      <stop offset="50%" stop-color="#0e0817"/>
      <stop offset="100%" stop-color="#030105"/>
    </linearGradient>
    <linearGradient id="cp-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="50%" stop-color="#d946ef" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="cp-neon-1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f43f5e"/>
      <stop offset="50%" stop-color="#d946ef"/>
      <stop offset="100%" stop-color="#8b5cf6"/>
    </linearGradient>
    <linearGradient id="cp-neon-2" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="50%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#a855f7"/>
    </linearGradient>
    <radialGradient id="cp-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#d946ef" stop-opacity="0.25"/>
      <stop offset="60%" stop-color="#6366f1" stop-opacity="0.1"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <filter id="cp-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="20" stdDeviation="24" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#cp-bg)" filter="url(#cp-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#cp-rim)" stroke-width="1.5"/>
  <circle cx="256" cy="256" r="160" fill="url(#cp-glow)"/>

  <!-- Cybernetic Pair Pilot Visor & Antenna Ears -->
  <g id="copilot-cyber-hound">
    <!-- Left Neon Antenna Ear -->
    <path d="M 136 348 V 196 C 136 142 188 128 218 168 L 256 218" 
          fill="none" stroke="url(#cp-neon-1)" stroke-width="32" stroke-linecap="round"/>
    
    <!-- Right Neon Antenna Ear -->
    <path d="M 376 348 V 196 C 376 142 324 128 294 168 L 256 218" 
          fill="none" stroke="url(#cp-neon-2)" stroke-width="32" stroke-linecap="round"/>

    <!-- Pair Pilot Cyber Visor Slit (Laser HUD) -->
    <rect x="176" y="244" width="160" height="28" rx="14" fill="#ffffff" filter="drop-shadow(0 0 12px #d946ef)"/>
    
    <!-- Visor Scanning Glint -->
    <line x1="200" y1="258" x2="312" y2="258" stroke="#00f2fe" stroke-width="6" stroke-linecap="round"/>

    <!-- Terminal Prompt Snout Aperture -->
    <path d="M 204 300 L 256 352 L 308 300" 
          fill="none" stroke="#ffffff" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>
    
    <!-- Dual AI Synapse Nodes -->
    <circle cx="218" cy="168" r="8" fill="#ffffff"/>
    <circle cx="294" cy="168" r="8" fill="#ffffff"/>
  </g>
</svg>`;

// 6. OpenAI Operator Benchmark: Minimal Singularity Parabolic Ring
const svgOperator = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="op-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#15161a"/>
      <stop offset="50%" stop-color="#0a0a0d"/>
      <stop offset="100%" stop-color="#020203"/>
    </linearGradient>
    <linearGradient id="op-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.4"/>
      <stop offset="50%" stop-color="#ffffff" stop-opacity="0.06"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.2"/>
    </linearGradient>
    <linearGradient id="op-platinum" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="50%" stop-color="#e2e8f0"/>
      <stop offset="100%" stop-color="#94a3b8"/>
    </linearGradient>
    <radialGradient id="op-core" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="40%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#0284c7" stop-opacity="0"/>
    </radialGradient>
    <filter id="op-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="20" stdDeviation="24" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#op-bg)" filter="url(#op-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#op-rim)" stroke-width="1.5"/>

  <!-- Pure Parabolic Continuous Loop forming Hound M -->
  <g id="operator-singularity">
    <!-- Code Bracket Outer Arcs -->
    <path d="M 140 344 C 140 180 190 132 256 198 C 322 132 372 180 372 344" 
          fill="none" stroke="url(#op-platinum)" stroke-width="36" stroke-linecap="round"/>
    
    <!-- Inverted Inner Parabolic Snout Loop -->
    <path d="M 196 270 C 220 226 256 226 256 226 C 256 226 292 226 316 270 C 328 294 300 348 256 348 C 212 348 184 294 196 270 Z" 
          fill="none" stroke="#ffffff" stroke-width="18" stroke-linejoin="round"/>

    <!-- Central Singularity Core -->
    <circle cx="256" cy="276" r="14" fill="url(#op-core)"/>
    <circle cx="256" cy="276" r="5" fill="#ffffff"/>

    <!-- Ultra-Sleek Horizon Ray -->
    <line x1="210" y1="276" x2="302" y2="276" stroke="#ffffff" stroke-width="2" opacity="0.6"/>
  </g>
</svg>`;

// 7. Ghostty Benchmark: Zero-Latency CRT Phosphor Matrix
const svgGhostty = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="gh-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0a120d"/>
      <stop offset="50%" stop-color="#050906"/>
      <stop offset="100%" stop-color="#010302"/>
    </linearGradient>
    <linearGradient id="gh-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="50%" stop-color="#22c55e" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <filter id="gh-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="5" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
    <filter id="gh-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="20" stdDeviation="24" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#gh-bg)" filter="url(#gh-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#gh-rim)" stroke-width="1.5"/>

  <!-- Native Phosphor CRT Terminal Hound Mark -->
  <g id="ghostty-crt" filter="url(#gh-glow)">
    <!-- CRT Grid Horizontal Scanlines Backdrop -->
    <line x1="120" y1="180" x2="392" y2="180" stroke="#15803d" stroke-width="1.5" opacity="0.4"/>
    <line x1="120" y1="216" x2="392" y2="216" stroke="#15803d" stroke-width="1.5" opacity="0.4"/>
    <line x1="120" y1="252" x2="392" y2="252" stroke="#15803d" stroke-width="1.5" opacity="0.4"/>
    <line x1="120" y1="288" x2="392" y2="288" stroke="#15803d" stroke-width="1.5" opacity="0.4"/>
    <line x1="120" y1="324" x2="392" y2="324" stroke="#15803d" stroke-width="1.5" opacity="0.4"/>

    <!-- Pixel Slits forming M + Hound Ears -->
    <!-- Left Column Blocks -->
    <rect x="128" y="148" width="40" height="72" rx="6" fill="#4ade80"/>
    <rect x="128" y="232" width="40" height="52" rx="6" fill="#22c55e"/>
    <rect x="128" y="296" width="40" height="64" rx="6" fill="#16a34a"/>

    <!-- Right Column Blocks -->
    <rect x="344" y="148" width="40" height="72" rx="6" fill="#4ade80"/>
    <rect x="344" y="232" width="40" height="52" rx="6" fill="#22c55e"/>
    <rect x="344" y="296" width="40" height="64" rx="6" fill="#16a34a"/>

    <!-- Center Diagonal Slits (Ear Flaps & Prompt Apex) -->
    <polygon points="176,148 236,208 236,252 176,192" fill="#86efac"/>
    <polygon points="336,148 276,208 276,252 336,192" fill="#86efac"/>

    <!-- Terminal Prompt Chevron Snout (>_) -->
    <polygon points="216,280 256,320 296,280 256,356" fill="#ffffff"/>
    <rect x="236" y="348" width="40" height="10" rx="3" fill="#4ade80"/>
  </g>
</svg>`;

// 8. Replit Agent Benchmark: Fire Ember & Brutalist Interlocking Blocks
const svgReplit = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="rp-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#18110e"/>
      <stop offset="50%" stop-color="#0f0907"/>
      <stop offset="100%" stop-color="#030101"/>
    </linearGradient>
    <linearGradient id="rp-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="50%" stop-color="#f97316" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="rp-fire-1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#facc15"/>
      <stop offset="50%" stop-color="#f97316"/>
      <stop offset="100%" stop-color="#dc2626"/>
    </linearGradient>
    <linearGradient id="rp-fire-2" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="50%" stop-color="#fdba74"/>
      <stop offset="100%" stop-color="#ea580c"/>
    </linearGradient>
    <radialGradient id="rp-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#f97316" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <filter id="rp-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="20" stdDeviation="24" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#rp-bg)" filter="url(#rp-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#rp-rim)" stroke-width="1.5"/>
  <circle cx="256" cy="256" r="160" fill="url(#rp-glow)"/>

  <!-- Interlocking Modular Flame Blocks forming Hound M -->
  <g id="replit-flame-blocks">
    <!-- Left Stride Flame Block -->
    <rect x="124" y="216" width="56" height="144" rx="16" fill="url(#rp-fire-1)"/>
    <polygon points="124,216 180,216 180,144 124,188" fill="url(#rp-fire-2)"/>

    <!-- Right Stride Flame Block -->
    <rect x="332" y="216" width="56" height="144" rx="16" fill="url(#rp-fire-1)"/>
    <polygon points="388,216 332,216 332,144 388,188" fill="url(#rp-fire-2)"/>

    <!-- Central Interlocking Code Block (Ember Core) -->
    <rect x="228" y="172" width="56" height="116" rx="16" fill="#ffffff"/>
    
    <!-- Forward Execution Flame Dart Snout -->
    <polygon points="188,296 256,364 324,296 256,324" fill="url(#rp-fire-2)"/>

    <!-- Ember Synapse Core -->
    <circle cx="256" cy="228" r="12" fill="#ea580c"/>
    <circle cx="256" cy="228" r="5" fill="#facc15"/>
  </g>
</svg>`;

// 9. Bolt.new Benchmark: Lightning Spark & High-Voltage WebContainer
const svgBolt = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="b-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#141520"/>
      <stop offset="50%" stop-color="#080914"/>
      <stop offset="100%" stop-color="#010206"/>
    </linearGradient>
    <linearGradient id="b-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="50%" stop-color="#facc15" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="b-thunder" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="30%" stop-color="#fef08a"/>
      <stop offset="70%" stop-color="#eab308"/>
      <stop offset="100%" stop-color="#ca8a04"/>
    </linearGradient>
    <linearGradient id="b-blue" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#1d4ed8"/>
    </linearGradient>
    <radialGradient id="b-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#facc15" stop-opacity="0.25"/>
      <stop offset="60%" stop-color="#38bdf8" stop-opacity="0.1"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <filter id="b-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="20" stdDeviation="24" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#b-bg)" filter="url(#b-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#b-rim)" stroke-width="1.5"/>
  <circle cx="256" cy="256" r="160" fill="url(#b-glow)"/>

  <!-- Thunderbolt M Hound Energy Architecture -->
  <g id="bolt-thunder-hound">
    <!-- Left Electric Ear Wing -->
    <polygon points="128,348 128,196 176,144 224,244 180,244 196,348" fill="url(#b-blue)"/>
    
    <!-- Right Electric Ear Wing -->
    <polygon points="384,348 384,196 336,144 288,244 332,244 316,348" fill="url(#b-blue)"/>

    <!-- High-Voltage Central Lightning Bolt (Prompt & Snout) -->
    <polygon points="268,144 212,252 260,252 236,368 300,240 252,240" fill="url(#b-thunder)" filter="drop-shadow(0 0 16px #facc15)"/>

    <!-- Specular Spark Highlight -->
    <polygon points="268,144 236,252 260,252 236,368 260,240" fill="#ffffff" opacity="0.8"/>
  </g>
</svg>`;

// 10. Aider Benchmark: Git Branch-Merge DAG & Diff Patch
const svgAider = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="ai-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#14181f"/>
      <stop offset="50%" stop-color="#0a0d12"/>
      <stop offset="100%" stop-color="#020305"/>
    </linearGradient>
    <linearGradient id="ai-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="50%" stop-color="#38bdf8" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="ai-cyan" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#0284c7"/>
    </linearGradient>
    <linearGradient id="ai-purple" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#a855f7"/>
      <stop offset="100%" stop-color="#6366f1"/>
    </linearGradient>
    <filter id="ai-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="20" stdDeviation="24" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#ai-bg)" filter="url(#ai-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#ai-rim)" stroke-width="1.5"/>

  <!-- Git Branch-Merge Graph Topology forming Hound M -->
  <g id="aider-git-fork">
    <!-- Main Branch Line (Left M Stride) -->
    <path d="M 148 348 V 180" stroke="url(#ai-cyan)" stroke-width="24" stroke-linecap="round"/>
    <!-- Feature Branch Fork (Left Ear to Apex) -->
    <path d="M 148 240 C 148 160 212 160 256 228" stroke="url(#ai-cyan)" stroke-width="20" stroke-linecap="round" fill="none"/>

    <!-- Upstream Branch Line (Right M Stride) -->
    <path d="M 364 348 V 180" stroke="url(#ai-purple)" stroke-width="24" stroke-linecap="round"/>
    <!-- Upstream Merge Fork (Right Ear to Apex) -->
    <path d="M 364 240 C 364 160 300 160 256 228" stroke="url(#ai-purple)" stroke-width="20" stroke-linecap="round" fill="none"/>

    <!-- Merged Terminal Execution Apex (Snout) -->
    <path d="M 204 292 L 256 348 L 308 292" stroke="#ffffff" stroke-width="22" stroke-linecap="round" stroke-linejoin="round" fill="none"/>

    <!-- Git Commit Nodes -->
    <circle cx="148" cy="180" r="18" fill="#0284c7" stroke="#ffffff" stroke-width="5"/>
    <circle cx="148" cy="348" r="16" fill="#0284c7" stroke="#ffffff" stroke-width="4"/>
    <circle cx="364" cy="180" r="18" fill="#6366f1" stroke="#ffffff" stroke-width="5"/>
    <circle cx="364" cy="348" r="16" fill="#6366f1" stroke="#ffffff" stroke-width="4"/>
    
    <!-- Merge Commit Node (Center Synapse) -->
    <circle cx="256" cy="228" r="22" fill="#ffffff" stroke="#38bdf8" stroke-width="6"/>
    <circle cx="256" cy="228" r="8" fill="#0284c7"/>
  </g>
</svg>`;

// 11. Zed Benchmark: High-Performance Rust Monoline Precision
const svgZed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="z-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#141517"/>
      <stop offset="50%" stop-color="#090a0b"/>
      <stop offset="100%" stop-color="#010202"/>
    </linearGradient>
    <linearGradient id="z-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.08"/>
    </linearGradient>
    <linearGradient id="z-steel" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="50%" stop-color="#cbd5e1"/>
      <stop offset="100%" stop-color="#64748b"/>
    </linearGradient>
    <filter id="z-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="20" stdDeviation="24" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#z-bg)" filter="url(#z-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#z-rim)" stroke-width="1.5"/>

  <!-- High-Performance Ultra-Crisp Precision Monoline Vector -->
  <g id="zed-rust-monoline">
    <!-- Outer Precision Chamfer Contour (30° Angle) -->
    <path d="M 136 348 L 136 188 L 196 128 L 256 198 L 316 128 L 376 188 L 376 348" 
          fill="none" stroke="url(#z-steel)" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>

    <!-- Inner Code Chevron Nested Precision -->
    <path d="M 188 286 L 256 354 L 324 286" 
          fill="none" stroke="#ffffff" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>

    <!-- High-Performance Diamond Core -->
    <polygon points="256,198 274,228 256,258 238,228" fill="#38bdf8"/>
    <polygon points="256,210 266,228 256,246 246,228" fill="#ffffff"/>

    <!-- Razor Dimension Marks -->
    <line x1="196" y1="128" x2="196" y2="148" stroke="#ffffff" stroke-width="3"/>
    <line x1="316" y1="128" x2="316" y2="148" stroke="#ffffff" stroke-width="3"/>
  </g>
</svg>`;

// 12. Mixdog Supreme: Multi-Model Nexus Core (The Synthesis Emblem)
const svgSupreme = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="sup-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#161824"/>
      <stop offset="40%" stop-color="#0d0e17"/>
      <stop offset="100%" stop-color="#020306"/>
    </linearGradient>
    <linearGradient id="sup-rim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.4"/>
      <stop offset="30%" stop-color="#00f2fe" stop-opacity="0.35"/>
      <stop offset="70%" stop-color="#f43f5e" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.1"/>
    </linearGradient>
    <linearGradient id="sup-left-wing" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00f2fe"/>
      <stop offset="50%" stop-color="#0284c7"/>
      <stop offset="100%" stop-color="#312e81"/>
    </linearGradient>
    <linearGradient id="sup-right-wing" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#f43f5e"/>
      <stop offset="50%" stop-color="#a855f7"/>
      <stop offset="100%" stop-color="#312e81"/>
    </linearGradient>
    <linearGradient id="sup-core-prism" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="50%" stop-color="#e0e7ff"/>
      <stop offset="100%" stop-color="#93c5fd"/>
    </linearGradient>
    <radialGradient id="sup-ambient" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.25"/>
      <stop offset="50%" stop-color="#a855f7" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
    <filter id="sup-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="22" stdDeviation="28" flood-color="#000000" flood-opacity="0.95"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#sup-bg)" filter="url(#sup-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#sup-rim)" stroke-width="1.5"/>
  <circle cx="256" cy="256" r="160" fill="url(#sup-ambient)"/>

  <!-- Mixdog Supreme: Synthesis of 3D Prism + Flow Ribbon + Terminal Prompt -->
  <g id="mixdog-supreme">
    <!-- Left Multi-Model Fluid Wing (M-Ear) -->
    <path d="M 132 352 V 204 C 132 144 176 124 214 156 L 256 196" 
          fill="none" stroke="url(#sup-left-wing)" stroke-width="36" stroke-linecap="round"/>
    
    <!-- Right Multi-Model Fluid Wing (M-Ear) -->
    <path d="M 380 352 V 204 C 380 144 336 124 298 156 L 256 196" 
          fill="none" stroke="url(#sup-right-wing)" stroke-width="36" stroke-linecap="round"/>

    <!-- Central High-Refraction Diamond Core (Singularity Engine) -->
    <polygon points="214,244 256,196 298,244 256,364" fill="url(#sup-core-prism)" filter="drop-shadow(0 0 16px rgba(255,255,255,0.4))"/>
    
    <!-- Forward Execution Razor Chevron -->
    <polygon points="214,244 256,292 298,244 256,260" fill="#00f2fe"/>

    <!-- Razor Specular Seam -->
    <line x1="256" y1="196" x2="256" y2="364" stroke="#ffffff" stroke-width="2.5"/>

    <!-- Quantum Core Spark -->
    <circle cx="256" cy="256" r="6" fill="#ffffff"/>
    <circle cx="256" cy="256" r="2.5" fill="#00f2fe"/>
  </g>
</svg>`;

// Write all SVGs
const newSvgs = [
  { file: 'agent-v2-1-cursor-hypercube.svg', content: svgCursor },
  { file: 'agent-v2-2-windsurf-flow-cascade.svg', content: svgWindsurf },
  { file: 'agent-v2-3-claude-spark-brutalist.svg', content: svgClaude },
  { file: 'agent-v2-4-devin-dag-matrix.svg', content: svgDevin },
  { file: 'agent-v2-5-copilot-cyber-visor.svg', content: svgCopilot },
  { file: 'agent-v2-6-operator-singularity-loop.svg', content: svgOperator },
  { file: 'agent-v2-7-ghostty-zero-phosphor.svg', content: svgGhostty },
  { file: 'agent-v2-8-replit-flame-monolith.svg', content: svgReplit },
  { file: 'agent-v2-9-bolt-thunder-apex.svg', content: svgBolt },
  { file: 'agent-v2-10-aider-git-fork.svg', content: svgAider },
  { file: 'agent-v2-11-zed-super-speed-chevron.svg', content: svgZed },
  { file: 'agent-v2-12-mixdog-supreme-nexus.svg', content: svgSupreme }
];

for (const item of newSvgs) {
  writeFileSync(`design/logo-concepts/${item.file}`, item.content, 'utf8');
}

console.log(`Generated ${newSvgs.length} new coding agent variations!`);

// ============================================================================
// Generate Master Showcase HTML
// ============================================================================
import { readdirSync } from 'node:fs';

const allSvgFiles = readdirSync('design/logo-concepts').filter(f => f.endsWith('.svg')).sort();

const deepDiveAgents = [
  {
    id: 'agent-v2-cursor',
    file: 'agent-v2-1-cursor-hypercube.svg',
    agentName: 'Cursor (Anysphere)',
    conceptTitle: '3D Isometric Hyper-Prism',
    philosophy: '아이소메트릭 큐브, 광학 굴절 프리즘, 3D 공간감, 티타늄 다크모드',
    breakdown: 'Cursor 특유의 30°/60° 아이소메트릭 큐브를 하운드의 쫑긋한 귀로 변환. 중앙에 즉각적인 코드 실행을 상징하는 사이언/인디고 프리즘 셰브론 배치.',
    tags: ['3D Prism', 'Isometric Cube', 'Optical Seam'],
    accent: '#38bdf8'
  },
  {
    id: 'agent-v2-windsurf',
    file: 'agent-v2-2-windsurf-flow-cascade.svg',
    agentName: 'Windsurf (Codeium)',
    conceptTitle: 'Cascade Flow & Jet Stream',
    philosophy: 'Cascade 다중 에이전트 병렬 기류, 유체역학적 서핑 곡선, 고속 제트 스트림',
    breakdown: 'Windsurf의 Cascade 병렬 실행 스트림에서 착안한 듀얼 에어로포일 곡선. M 실루엣을 따라 흐르며 중앙 셰브론 노즐로 합류.',
    tags: ['Cascade Wave', 'Parallel Streams', 'Aerodynamic'],
    accent: '#06b6d4'
  },
  {
    id: 'agent-v2-claude',
    file: 'agent-v2-3-claude-spark-brutalist.svg',
    agentName: 'Claude Code (Anthropic)',
    conceptTitle: 'Intelligent Asterisk & Brutalism',
    philosophy: '지능형 아스테리스크(*), 웜 테라코타 & 차콜, 모던 브루탈리즘',
    breakdown: 'Anthropic의 시그니처 6방향 지능 스파크(*)와 단단한 브루탈리스트 M 기둥의 융합. 따뜻한 오렌지/테라코타 톤의 인간 중심 에이전트.',
    tags: ['Asterisk *', 'Warm Terracotta', 'Brutalism'],
    accent: '#f97316'
  },
  {
    id: 'agent-v2-devin',
    file: 'agent-v2-4-devin-dag-matrix.svg',
    agentName: 'Devin (Cognition)',
    conceptTitle: 'Autonomous Task Graph (DAG)',
    philosophy: '방향성 비순환 그래프(DAG) 실행 트리, 에메랄드 형광, 엔드투엔드 자율성',
    breakdown: '복잡한 소프트웨어 엔지니어링 문제를 분할 해결하는 DAG 태스크 노드 5개가 M자형으로 연결되어 스스로 문제를 해결하는 지능형 그래프 형성.',
    tags: ['DAG Task Tree', 'Emerald Nodes', 'Autonomous Loop'],
    accent: '#10b981'
  },
  {
    id: 'agent-v2-copilot',
    file: 'agent-v2-5-copilot-cyber-visor.svg',
    agentName: 'GitHub Copilot (Workspace)',
    conceptTitle: 'Cyber Visor & Pair Pilot',
    philosophy: '페어 프로그래밍, 헬멧/바이저 HUD, 일렉트릭 마젠타-퍼플 네온',
    breakdown: '인간 개발자와 AI가 함께 코딩하는 페어 파일럿 감성. 듀얼 네온 안테나 귀와 중앙의 사이버네틱 레이저 바이저 슬릿 HUD.',
    tags: ['Pair Pilot', 'Neon HUD', 'Visor Slit'],
    accent: '#d946ef'
  },
  {
    id: 'agent-v2-operator',
    file: 'agent-v2-6-operator-singularity-loop.svg',
    agentName: 'OpenAI Operator / Codex',
    conceptTitle: 'Singularity Parabolic Ring',
    philosophy: '단일 폐곡선 럭셔리 곡률, 중앙 자율 코어, 플래티넘 미니멀리즘',
    breakdown: '코드 브래킷(&lt; &gt;)과 포물선(Parabola)이 하나로 이어지는 완벽한 폐곡선. 중심에 위치한 싱귤래리티 펄스 코어로 무한한 자율 실행 표현.',
    tags: ['Singularity Ring', 'Parabolic Curve', 'Platinum Luxury'],
    accent: '#ffffff'
  },
  {
    id: 'agent-v2-ghostty',
    file: 'agent-v2-7-ghostty-zero-phosphor.svg',
    agentName: 'Ghostty (Mitchellh)',
    conceptTitle: 'Zero-Latency CRT Phosphor',
    philosophy: '네이티브 C/Rust 가속, 인광체 그린 CRT 스캔라인, 해커 터미널 글리프',
    breakdown: '하드웨어 레벨의 극한 성능과 CRT 모니터의 그린 인광체 잔상을 재현한 래스터 픽셀 슬릿 하운드. 순수 터미널 CLI 감성 극대화.',
    tags: ['CRT Phosphor', 'Scanline Matrix', 'Zero-Latency'],
    accent: '#22c55e'
  },
  {
    id: 'agent-v2-replit',
    file: 'agent-v2-8-replit-flame-monolith.svg',
    agentName: 'Replit Agent',
    conceptTitle: 'Fire Ember & Interlocking Block',
    philosophy: '타오르는 불꽃(Flame/Ember), 기하학 블록 결합, 하이 콘트라스트',
    breakdown: '모듈식 기하학 블록 3개가 맞물리며 하운드와 불꽃(Ember)을 동시에 형상화. 즉각적이고 역동적인 풀스택 프로토타이핑 에너지.',
    tags: ['Flame Ember', 'Interlock Blocks', 'High Contrast'],
    accent: '#ea580c'
  },
  {
    id: 'agent-v2-bolt',
    file: 'agent-v2-9-bolt-thunder-apex.svg',
    agentName: 'Bolt.new (StackBlitz)',
    conceptTitle: 'Lightning WebContainer Spark',
    philosophy: '썬더볼트 번개, 초고속 웹컨테이너 런타임, 일렉트릭 옐로우 & 블루',
    breakdown: 'M 심볼의 중심을 관통하는 고전압 썬더볼트 셰브론. 브라우저 내 즉시 풀스택 환경을 기동하는 초고속 스피드 표현.',
    tags: ['Thunderbolt', 'High-Voltage', 'Instant Runtime'],
    accent: '#facc15'
  },
  {
    id: 'agent-v2-aider',
    file: 'agent-v2-10-aider-git-fork.svg',
    agentName: 'Aider (CLI Pair)',
    conceptTitle: 'Git Branch-Merge & Diff Patch',
    philosophy: 'Git 브랜치 분기/병합(Fork & Merge), 터미널 diff 문법, CLI 협업',
    breakdown: '좌우의 피처 브랜치(Feature)와 메인 브랜치가 M 라인을 그리며 중앙 머지 커밋(Merge Node)으로 수렴하는 Git 토폴로지 구조.',
    tags: ['Git Topology', 'Branch Fork', 'Merge Node'],
    accent: '#38bdf8'
  },
  {
    id: 'agent-v2-zed',
    file: 'agent-v2-11-zed-super-speed-chevron.svg',
    agentName: 'Zed (Rust Speed)',
    conceptTitle: 'High-Performance Rust Monoline',
    philosophy: 'Rust 기반 극한의 경량/고속, 날카로운 30° 챔퍼, 인더스트리얼 스틸',
    breakdown: '불필요한 장식을 완전히 배제한 정밀 30° 각면 모노라인. 네이티브 GPU 렌더링 수준의 칼같은 시인성과 날렵함.',
    tags: ['Rust Precision', '30° Chamfer', 'Steel Monoline'],
    accent: '#94a3b8'
  },
  {
    id: 'agent-v2-supreme',
    file: 'agent-v2-12-mixdog-supreme-nexus.svg',
    agentName: 'Mixdog Supreme (Synthesis)',
    conceptTitle: 'Multi-Model Nexus Core',
    philosophy: '모든 에이전트의 정수(3D 프리즘 + 유체 리본 + 터미널 프롬프트) 융합',
    breakdown: '사이언-인디고의 멀티 모델 윙과 중앙의 고굴절 다이아몬드 코어가 어우러진 믹스독의 궁극적 마스터피스 엠블럼.',
    tags: ['Multi-Model Nexus', 'Diamond Refraction', 'Masterpiece'],
    accent: '#00f2fe'
  }
];

function categorizeFile(filename) {
  if (filename.startsWith('ap-360-')) return { cat: 'aperture360', name: '360° Gradient Loop', tag: '360° Seamless' };
  if (filename.startsWith('ap-col-')) return { cat: 'aperturecol', name: 'Aperture Color Lab', tag: 'Color Lab' };
  if (filename.startsWith('aperture-triad-') || filename === '131-aperture-triad.svg') return { cat: 'aperture', name: 'Aperture Triad', tag: 'Iris / Triad' };
  if (filename.startsWith('agent-v2-')) return { cat: 'deepdive', name: '2026 Agent Deep-Dive', tag: 'Top Tier' };
  if (filename.startsWith('agent-ref-')) return { cat: 'benchmarks', name: 'Agent Benchmark', tag: 'Benchmark' };
  if (filename.startsWith('sleek-')) return { cat: 'sleek', name: 'Sleek 2026', tag: 'Unicorn Tier' };
  if (filename.startsWith('metal-')) return { cat: 'metal', name: 'Hardware Metal', tag: 'Industrial' };
  if (filename.startsWith('fresh-')) return { cat: 'fresh', name: 'Cyber & Future', tag: 'Cybernetic' };
  if (filename.startsWith('type-')) return { cat: 'typography', name: 'Typography & Code', tag: 'Monogram' };
  if (filename.startsWith('radical-')) return { cat: 'radical', name: 'Radical Geometry', tag: 'Geometric' };
  if (filename.startsWith('different-')) return { cat: 'different', name: 'Hound & Canine', tag: 'Mascot' };
  if (filename.startsWith('concept-') || filename.startsWith('tech-')) return { cat: 'concept', name: 'Tech Concept', tag: 'Concept' };

  const lower = filename.toLowerCase();
  if (lower.includes('hound') || lower.includes('dog') || lower.includes('paw') || lower.includes('bone') || lower.includes('ear') || lower.includes('collar') || lower.includes('tail') || lower.includes('snout')) {
    return { cat: 'canine', name: 'Canine & Hound Motif', tag: 'Hound/Dog' };
  }
  if (lower.includes('ribbon') || lower.includes('fold') || lower.includes('mobius') || lower.includes('knot') || lower.includes('loop')) {
    return { cat: 'ribbon', name: 'Ribbon & Continuous Fold', tag: 'Continuous Flow' };
  }
  if (lower.includes('wordmark') || lower.includes('lockup') || lower.includes('monogram') || lower.includes('ligature')) {
    return { cat: 'typography', name: 'Wordmark & Lockup', tag: 'Typography' };
  }
  if (lower.includes('terminal') || lower.includes('prompt') || lower.includes('bracket') || lower.includes('ascii') || lower.includes('crt') || lower.includes('cli') || lower.includes('code') || lower.includes('syntax') || lower.includes('node')) {
    return { cat: 'cli', name: 'Terminal & Code Syntax', tag: 'CLI / Terminal' };
  }
  if (lower.includes('mesh') || lower.includes('glass') || lower.includes('aurora') || lower.includes('glow') || lower.includes('neon') || lower.includes('gradient')) {
    return { cat: 'visual', name: 'Glass & Optical Glow', tag: 'Lighting & FX' };
  }
  return { cat: 'classic', name: 'Geometric Monogram', tag: 'Geometry' };
}

const catalog = allSvgFiles.map((file, idx) => {
  const meta = categorizeFile(file);
  let cleanName = file.replace(/\.svg$/, '');
  cleanName = cleanName.replace(/^\d+-/, '').replace(/^(ap-360|ap-col|aperture-triad|agent-v2|agent-ref|sleek|metal|fresh|type|radical|different|concept|tech)-\d*-?/, '');
  cleanName = cleanName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  if (!cleanName || cleanName.trim() === '') cleanName = file.replace(/\.svg$/, '');

  return {
    index: idx + 1,
    file,
    title: cleanName,
    category: meta.cat,
    categoryName: meta.name,
    tag: meta.tag
  };
});

const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mixdog Logo Design System & Global AI Coding Agent Benchmarks</title>
  <style>
    :root {
      --bg: #07080b;
      --bg-surface: #0e1118;
      --bg-card: #131722;
      --bg-card-hover: #1a2030;
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
      --orange: #f97316;
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
        radial-gradient(circle at 50% 0%, rgba(56, 189, 248, 0.14) 0%, transparent 60%),
        radial-gradient(circle at 85% 20%, rgba(217, 70, 239, 0.08) 0%, transparent 50%),
        radial-gradient(circle at 15% 40%, rgba(16, 185, 129, 0.08) 0%, transparent 50%);
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

    header {
      text-align: center;
      max-width: 980px;
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
      font-size: 48px;
      font-weight: 800;
      letter-spacing: -0.03em;
      line-height: 1.15;
      margin-bottom: 16px;
      background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 50%, #94a3b8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    header p {
      font-size: 16px;
      color: var(--text-muted);
      line-height: 1.6;
    }

    .section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 64px 0 28px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border);
    }

    .section-title h2 {
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.02em;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .section-title .desc {
      font-size: 13px;
      color: var(--text-muted);
    }

    .deepdive-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      gap: 24px;
      margin-bottom: 48px;
    }

    .deepdive-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 24px;
      display: flex;
      flex-direction: column;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
      overflow: hidden;
      cursor: pointer;
    }

    .deepdive-card:hover {
      transform: translateY(-6px);
      border-color: var(--border-accent);
      background: var(--bg-card-hover);
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6), 0 0 30px rgba(56, 189, 248, 0.15);
    }

    .deepdive-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0; height: 3px;
      background: var(--card-accent, var(--cyan));
      opacity: 0.8;
    }

    .card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .agent-pill {
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
      position: relative;
    }

    .card-img-wrap img {
      width: 140px;
      height: 140px;
      transition: transform 0.3s ease;
    }

    .deepdive-card:hover .card-img-wrap img {
      transform: scale(1.06);
    }

    .card-content h3 {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 6px;
      color: #ffffff;
    }

    .card-content .philosophy {
      font-size: 12px;
      color: var(--cyan);
      font-family: 'JetBrains Mono', monospace;
      margin-bottom: 12px;
    }

    .card-content .breakdown {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.55;
      margin-bottom: 16px;
      flex-grow: 1;
    }

    .card-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .tag {
      font-size: 10px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.04);
      color: var(--text-dim);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    .table-container {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow-x: auto;
      margin-bottom: 56px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 13px;
    }

    th {
      background: rgba(255, 255, 255, 0.03);
      color: var(--text-muted);
      font-weight: 600;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.05em;
    }

    td {
      padding: 16px 20px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      color: var(--text);
    }

    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }

    .table-thumb {
      width: 44px;
      height: 44px;
      border-radius: 8px;
      background: #000;
      vertical-align: middle;
      margin-right: 12px;
    }

    .sim-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      padding: 36px;
      margin-bottom: 56px;
    }

    .sim-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 16px;
    }

    .sim-selector {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
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

    .sim-btn:hover, .sim-btn.active {
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

    .ide-dots {
      display: flex;
      gap: 6px;
    }

    .ide-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
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

    .ide-tab img {
      width: 16px;
      height: 16px;
    }

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

    .dock-container {
      margin-top: 32px;
      background: rgba(255, 255, 255, 0.02);
      border-radius: 24px;
      padding: 24px;
      display: flex;
      justify-content: center;
    }

    .dock {
      background: rgba(20, 24, 35, 0.75);
      backdrop-filter: blur(24px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 20px;
      padding: 10px 16px;
      display: flex;
      align-items: center;
      gap: 14px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.5);
    }

    .dock-icon {
      width: 54px;
      height: 54px;
      border-radius: 12px;
      transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .dock-icon:hover {
      transform: scale(1.3) translateY(-8px);
    }

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

    .catalog-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 16px;
    }

    .catalog-card {
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

    .catalog-card:hover {
      transform: translateY(-4px);
      border-color: var(--border-accent);
      background: var(--bg-card-hover);
    }

    .catalog-card img {
      width: 90px;
      height: 90px;
      margin-bottom: 12px;
    }

    .catalog-title {
      font-size: 12px;
      font-weight: 600;
      text-align: center;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      width: 100%;
      color: #e2e8f0;
    }

    .catalog-tag {
      font-size: 10px;
      color: var(--text-dim);
      margin-top: 4px;
    }

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

    .modal-details {
      flex: 1;
      min-width: 280px;
    }

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
    }
  </style>
</head>
<body>
  <div class="bg-grid"></div>

  <div class="container">
    <header>
      <div class="badge">🚀 2026 Next-Gen Coding Agent Benchmark Suite</div>
      <h1>Mixdog Global AI Agent Logo System</h1>
      <p>
        글로벌 톱티어 코딩 에이전트(Cursor, Windsurf, Claude Code, Devin, GitHub Copilot, OpenAI Operator 등)의<br>
        핵심 디자인 철학 및 비주얼 아이덴티티를 분석하여 믹스독(Mixdog) 브랜드에 정밀하게 접목한 종합 쇼케이스입니다.
      </p>
    </header>

    <div class="section-title">
      <h2>🤖 12대 글로벌 코딩 에이전트 심층 분석 & 믹스독 베리에이션</h2>
      <span class="desc">각 에이전트의 시각 언어(3D 큐브, 캐스케이드, 아스테리스크, DAG 노드 등)를 재해석한 콘셉트</span>
    </div>

    <div class="deepdive-grid">
      ${deepDiveAgents.map(agent => `
        <div class="deepdive-card" style="--card-accent: ${agent.accent}" onclick="openInspector('${agent.file}', '${agent.conceptTitle}', '${agent.agentName}')">
          <div class="card-top">
            <span class="agent-pill">${agent.agentName}</span>
            <span style="font-size: 11px; color: ${agent.accent}; font-weight: 700;">PRO TIER</span>
          </div>
          <div class="card-img-wrap">
            <img src="./${agent.file}" alt="${agent.conceptTitle}" />
          </div>
          <div class="card-content">
            <h3>${agent.conceptTitle}</h3>
            <div class="philosophy">// ${agent.philosophy}</div>
            <p class="breakdown">${agent.breakdown}</p>
          </div>
          <div class="card-tags">
            ${agent.tags.map(t => `<span class="tag">#${t}</span>`).join('')}
          </div>
        </div>
      `).join('')}
    </div>

    <div class="section-title">
      <h2>📊 코딩 에이전트 시각 언어 & 믹스독 접목 매트릭스</h2>
      <span class="desc">글로벌 에이전트들의 비주얼 토큰과 믹스독 구현 방식 비교</span>
    </div>

    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>로고</th>
            <th>벤치마크 에이전트</th>
            <th>핵심 디자인 DNA</th>
            <th>믹스독 브랜드 접목 포인트</th>
            <th>추천 적용 환경</th>
          </tr>
        </thead>
        <tbody>
          ${deepDiveAgents.map(a => `
            <tr>
              <td><img class="table-thumb" src="./${a.file}" /></td>
              <td><strong>${a.agentName}</strong></td>
              <td style="color: var(--cyan); font-family: 'JetBrains Mono', monospace; font-size: 12px;">${a.philosophy}</td>
              <td style="color: #cbd5e1;">${a.breakdown}</td>
              <td><span class="tag">${a.tags[0]}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div class="section-title">
      <h2>🖥️ 실제 환경 실시간 시뮬레이터 (IDE Editor & macOS Dock)</h2>
      <span class="desc">로고를 선택하여 실제 코딩 에디터 타이틀바, 탭(16px), 앱 독(64px)에서의 시인성을 테스트하세요.</span>
    </div>

    <div class="sim-card">
      <div class="sim-header">
        <strong style="font-size: 16px;">에셋 실시간 변경:</strong>
        <div class="sim-selector" id="sim-controls">
          ${deepDiveAgents.slice(0, 6).map((a, i) => `
            <button class="sim-btn ${i === 0 ? 'active' : ''}" onclick="switchSimLogo('${a.file}', this)">${a.agentName.split(' ')[0]}</button>
          `).join('')}
          <button class="sim-btn" onclick="switchSimLogo('agent-v2-12-mixdog-supreme-nexus.svg', this)">Supreme</button>
        </div>
      </div>

      <div class="ide-window">
        <div class="ide-titlebar">
          <div class="ide-dots">
            <div class="ide-dot dot-r"></div>
            <div class="ide-dot dot-y"></div>
            <div class="ide-dot dot-g"></div>
          </div>
          <div class="ide-tab">
            <img id="ide-tab-icon" src="./agent-v2-1-cursor-hypercube.svg" />
            <span>mixdog-agent.ts</span>
          </div>
        </div>
        <div class="ide-body">
          <div><span class="code-kw">import</span> { <span class="code-hl">MixdogOrchestrator</span> } <span class="code-kw">from</span> <span class="code-str">'@mixdog/runtime'</span>;</div>
          <div><span class="code-kw">const</span> <span class="code-fn">agent</span> = <span class="code-kw">new</span> <span class="code-hl">MixdogOrchestrator</span>({</div>
          <div>&nbsp;&nbsp;models: [<span class="code-str">'claude-3-7-sonnet'</span>, <span class="code-str">'gpt-4.5'</span>, <span class="code-str">'o3-mini'</span>],</div>
          <div>&nbsp;&nbsp;mode: <span class="code-str">'autonomous-pair-programmer'</span>,</div>
          <div>&nbsp;&nbsp;vision: <span class="code-str">'high-velocity-code-generation'</span></div>
          <div>});</div>
          <div><span class="code-kw">await</span> agent.<span class="code-fn">executeTask</span>(<span class="code-str">'Build next-gen autonomous architecture'</span>);</div>
        </div>
      </div>

      <div class="dock-container">
        <div class="dock">
          <img class="dock-icon" id="dock-main-icon" src="./agent-v2-1-cursor-hypercube.svg" title="Mixdog" />
          <img class="dock-icon" src="./agent-v2-2-windsurf-flow-cascade.svg" title="Windsurf Variant" />
          <img class="dock-icon" src="./agent-v2-3-claude-spark-brutalist.svg" title="Claude Variant" />
          <img class="dock-icon" src="./agent-v2-4-devin-dag-matrix.svg" title="Devin Variant" />
          <img class="dock-icon" src="./agent-v2-12-mixdog-supreme-nexus.svg" title="Mixdog Supreme" />
        </div>
      </div>
    </div>

    <div class="section-title">
      <h2>📦 전체 로고 베리에이션 카탈로그</h2>
      <span class="desc">실시간 필터 및 검색 지원</span>
    </div>

    <div class="filter-bar">
      <input type="text" class="search-input" id="search-input" placeholder="🔍 로고 이름, 태그 또는 카테고리 검색..." oninput="filterCatalog()" />
      <div class="filter-chips">
        <button class="chip active" onclick="setFilter('all', this)">전체 (${catalog.length})</button>
        <button class="chip" onclick="setFilter('aperture360', this)" style="border-color: rgba(56, 189, 248, 0.5); color: var(--cyan); font-weight: 700;">🌈 360° Loop (18)</button>
        <button class="chip" onclick="setFilter('aperture', this)">🌀 Aperture Triad (13)</button>
        <button class="chip" onclick="setFilter('deepdive', this)">2026 에이전트 (12)</button>
        <button class="chip" onclick="setFilter('benchmarks', this)">벤치마크</button>
        <button class="chip" onclick="setFilter('sleek', this)">Sleek 2026</button>
        <button class="chip" onclick="setFilter('metal', this)">Hardware Metal</button>
        <button class="chip" onclick="setFilter('cyber', this)">Cyber & Future</button>
        <button class="chip" onclick="setFilter('canine', this)">Hound / Dog</button>
        <button class="chip" onclick="setFilter('cli', this)">Terminal / CLI</button>
      </div>
    </div>

    <div class="catalog-grid" id="catalog-container">
      ${catalog.map(item => `
        <div class="catalog-card" data-cat="${item.category}" data-title="${item.title.toLowerCase()}" onclick="openInspector('${item.file}', '${item.title}', '${item.categoryName}')">
          <img src="./${item.file}" loading="lazy" alt="${item.title}" />
          <div class="catalog-title">${item.title}</div>
          <div class="catalog-tag">${item.categoryName}</div>
        </div>
      `).join('')}
    </div>
  </div>

  <div class="modal-backdrop" id="modal-backdrop" onclick="closeInspector(event)">
    <div class="modal-card" onclick="event.stopPropagation()">
      <button class="modal-close" onclick="closeInspector()">✕</button>
      <div class="modal-flex">
        <div class="modal-hero">
          <img id="modal-img" alt="Selected logo preview" />
        </div>
        <div class="modal-details">
          <span class="agent-pill" id="modal-category">Category</span>
          <h2 id="modal-title" style="font-size: 24px; margin: 8px 0 16px;">Title</h2>

          <div style="font-size: 12px; color: var(--text-muted);">멀티 스케일 시인성 테스트:</div>
          <div class="modal-scales">
            <div style="text-align: center;"><img id="scale-64" style="width: 64px; height: 64px;" /><div style="font-size: 10px; color: #64748b; margin-top: 4px;">64px</div></div>
            <div style="text-align: center;"><img id="scale-32" style="width: 32px; height: 32px;" /><div style="font-size: 10px; color: #64748b; margin-top: 4px;">32px</div></div>
            <div style="text-align: center;"><img id="scale-24" style="width: 24px; height: 24px;" /><div style="font-size: 10px; color: #64748b; margin-top: 4px;">24px</div></div>
            <div style="text-align: center;"><img id="scale-16" style="width: 16px; height: 16px;" /><div style="font-size: 10px; color: #64748b; margin-top: 4px;">16px</div></div>
          </div>

          <div class="modal-actions">
            <button class="btn-primary" onclick="copySvgCode()">📋 SVG 코드 복사</button>
            <a id="modal-download" class="btn-secondary" download style="text-decoration: none; display: inline-flex; align-items: center;">⬇️ SVG 다운로드</a>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let currentSvgFile = '';

    function switchSimLogo(file, btn) {
      document.getElementById('ide-tab-icon').src = './' + file;
      document.getElementById('dock-main-icon').src = './' + file;

      const buttons = document.querySelectorAll('#sim-controls .sim-btn');
      buttons.forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
    }

    function openInspector(file, title, cat) {
      currentSvgFile = file;
      document.getElementById('modal-img').src = './' + file;
      document.getElementById('scale-64').src = './' + file;
      document.getElementById('scale-32').src = './' + file;
      document.getElementById('scale-24').src = './' + file;
      document.getElementById('scale-16').src = './' + file;
      document.getElementById('modal-title').innerText = title;
      document.getElementById('modal-category').innerText = cat;
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
        alert('SVG 소스코드가 클립보드에 복사되었습니다!');
      } catch (err) {
        alert('복사 실패: ' + err.message);
      }
    }

    let currentFilter = 'all';

    function setFilter(filter, btn) {
      currentFilter = filter;
      document.querySelectorAll('.filter-chips .chip').forEach(c => c.classList.remove('active'));
      if (btn) btn.classList.add('active');
      filterCatalog();
    }

    function filterCatalog() {
      const q = document.getElementById('search-input').value.toLowerCase().trim();
      const cards = document.querySelectorAll('.catalog-card');

      cards.forEach(card => {
        const cat = card.getAttribute('data-cat');
        const title = card.getAttribute('data-title');

        let matchFilter = (currentFilter === 'all') ||
                          (currentFilter === 'aperture360' && cat === 'aperture360') ||
                          (currentFilter === 'aperture' && (cat === 'aperture' || cat === 'aperture360' || cat === 'aperturecol')) ||
                          (currentFilter === 'deepdive' && cat === 'deepdive') ||
                          (currentFilter === 'benchmarks' && cat === 'benchmarks') ||
                          (currentFilter === 'sleek' && cat === 'sleek') ||
                          (currentFilter === 'metal' && cat === 'metal') ||
                          (currentFilter === 'cyber' && (cat === 'fresh' || cat === 'radical')) ||
                          (currentFilter === 'canine' && cat === 'canine') ||
                          (currentFilter === 'cli' && cat === 'cli');

        let matchSearch = !q || title.includes(q) || cat.includes(q);

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

const cleanHtml = html.replace(/[ \t]+$/gm, '');
writeFileSync('design/logo-concepts/index.html', cleanHtml, 'utf8');
writeFileSync('design/logo-concepts/preview.html', cleanHtml, 'utf8');
console.log('Master Showcase built successfully with 12 Deep-Dive Agent Benchmarks!');

