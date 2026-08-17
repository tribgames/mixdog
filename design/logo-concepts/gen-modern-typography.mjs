import { writeFileSync } from 'node:fs';
import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';

chdir(fileURLToPath(new URL('../..', import.meta.url)));

// 8 Ultra-Clean Modern Tech / Lettering / Monogram Concepts

// 1. mx-ligature: Lowercase geometric 'm' seamlessly morphing into 'x' (Mix) + prompt
const svg1_tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="t1-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#16171d"/>
      <stop offset="50%" stop-color="#0a0b0e"/>
      <stop offset="100%" stop-color="#020304"/>
    </linearGradient>
    <linearGradient id="t1-border" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.25"/>
      <stop offset="50%" stop-color="#ffffff" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.25"/>
    </linearGradient>
    <linearGradient id="t1-metal" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="35%" stop-color="#e2e8f0"/>
      <stop offset="70%" stop-color="#94a3b8"/>
      <stop offset="100%" stop-color="#cbd5e1"/>
    </linearGradient>
    <filter id="t1-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#t1-bg)" filter="url(#t1-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#t1-border)" stroke-width="1.5"/>
  
  <!-- 'mx' Modernist Tech Ligature -->
  <g transform="translate(0, 0)">
    <!-- 'm' Arch 1 -->
    <path d="M 124 348 V 196 C 124 164 150 144 182 144 C 214 144 236 168 236 200 V 348" 
          fill="none" stroke="url(#t1-metal)" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
    <!-- 'm' Arch 2 + Diagonal 'x' Leg crossing -->
    <path d="M 236 208 C 236 168 258 144 290 144 C 322 144 348 164 348 196 V 348" 
          fill="none" stroke="url(#t1-metal)" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
    <!-- 'x' Cross slash with electric cyan prompt -->
    <line x1="282" y1="230" x2="388" y2="348" stroke="#38bdf8" stroke-width="34" stroke-linecap="round"/>
    <!-- Specular highlight line -->
    <line x1="282" y1="230" x2="388" y2="348" stroke="#ffffff" stroke-width="6" stroke-linecap="round" opacity="0.8"/>
  </g>
</svg>`;

// 2. md-monogram: Interlocking Minimalist 'M' & 'D' (Raycast / Modernist Grid)
const svg2_tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="t2-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#181920"/>
      <stop offset="50%" stop-color="#0b0c10"/>
      <stop offset="100%" stop-color="#030304"/>
    </linearGradient>
    <linearGradient id="t2-border" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#6366f1" stop-opacity="0.2"/>
    </linearGradient>
    <linearGradient id="t2-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="40%" stop-color="#f1f5f9"/>
      <stop offset="100%" stop-color="#94a3b8"/>
    </linearGradient>
    <filter id="t2-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#t2-bg)" filter="url(#t2-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#t2-border)" stroke-width="1.5"/>
  
  <!-- Interlocking 'M' + 'D' Monogram in precision 45-degree cuts -->
  <g transform="translate(0, 0)">
    <!-- Left 'M' stem & plunge -->
    <path d="M 136 348 V 164 L 208 260 L 256 196" 
          fill="none" stroke="url(#t2-grad)" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/>
    <!-- Right 'D' semi-circle looping back from M apex -->
    <path d="M 256 196 L 304 260 L 376 164 V 348" 
          fill="none" stroke="url(#t2-grad)" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/>
    <!-- Terminal Prompt Accent Dot / Amber status -->
    <circle cx="256" cy="316" r="14" fill="#f59e0b"/>
  </g>
</svg>`;

// 3. m-prompt: Ultra-clean Geometric 'm.' (Vercel / Supabase / Linear Style)
const svg3_tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="t3-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#14151b"/>
      <stop offset="50%" stop-color="#090a0d"/>
      <stop offset="100%" stop-color="#000000"/>
    </linearGradient>
    <linearGradient id="t3-border" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="50%" stop-color="#ffffff" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.12"/>
    </linearGradient>
    <filter id="t3-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#t3-bg)" filter="url(#t3-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#t3-border)" stroke-width="1.5"/>
  
  <!-- Lowercase 'm' with Prompt Terminal Caret & Dot -->
  <g transform="translate(0, 0)">
    <!-- Pure Solid 'm' letterform -->
    <path d="M 124 348 V 212 C 124 172 152 148 188 148 C 224 148 248 174 248 212 V 348 M 248 212 C 248 172 276 148 312 148 C 348 148 376 172 376 212 V 348" 
          fill="none" stroke="#ffffff" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/>
    <!-- Terminal Square Prompt Dot 'm.' -->
    <rect x="360" y="330" width="32" height="32" rx="6" fill="#38bdf8"/>
  </g>
</svg>`;

// 4. mix-cross: Minimalist 45-degree Intersection 'MIX' (Warp / Zed style)
const svg4_tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="t4-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#16171e"/>
      <stop offset="50%" stop-color="#0a0b0f"/>
      <stop offset="100%" stop-color="#020204"/>
    </linearGradient>
    <linearGradient id="t4-border" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#10b981" stop-opacity="0.25"/>
    </linearGradient>
    <linearGradient id="t4-band1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#3b82f6"/>
    </linearGradient>
    <linearGradient id="t4-band2" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#94a3b8"/>
    </linearGradient>
    <filter id="t4-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#t4-bg)" filter="url(#t4-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#t4-border)" stroke-width="1.5"/>
  
  <!-- Dual Orthogonal Precision Bands (M + X intersection) -->
  <g transform="translate(0, 0)">
    <!-- Primary Silver Monoline Chevron M -->
    <path d="M 128 348 V 192 L 208 144 L 256 192 L 304 144 L 384 192 V 348" 
          fill="none" stroke="url(#t4-band2)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
    <!-- Intersecting 45-degree Forward Prompt Blade -->
    <path d="M 168 280 L 256 348 L 344 280" 
          fill="none" stroke="url(#t4-band1)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
    <!-- Micro Laser Center Pin -->
    <circle cx="256" cy="226" r="8" fill="#10b981"/>
  </g>
</svg>`;

// 5. bespoke-grotesk-md: Heavy Grotesk Monogram MD (Stripe / Resend / Figma)
const svg5_tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="t5-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#14151a"/>
      <stop offset="50%" stop-color="#0a0a0d"/>
      <stop offset="100%" stop-color="#000000"/>
    </linearGradient>
    <linearGradient id="t5-border" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.08"/>
    </linearGradient>
    <linearGradient id="t5-metal" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="40%" stop-color="#cbd5e1"/>
      <stop offset="100%" stop-color="#64748b"/>
    </linearGradient>
    <filter id="t5-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#t5-bg)" filter="url(#t5-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#t5-border)" stroke-width="1.5"/>
  
  <!-- Solid Heavy Grotesk 'M' with Precision Center Notch -->
  <g transform="translate(0, 0)">
    <path d="M 120 356 V 156 H 176 L 256 272 L 336 156 H 392 V 356 H 340 V 232 L 272 332 H 240 L 172 232 V 356 Z" 
          fill="url(#t5-metal)"/>
    <!-- Micro Chamfer Highlight line on the inner V -->
    <path d="M 176 156 L 256 272 L 336 156" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
  </g>
</svg>`;

// 6. slash-code-md: Developer Native '//md' (GitHub Next / Claude Code)
const svg6_tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="t6-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#151720"/>
      <stop offset="50%" stop-color="#0a0c10"/>
      <stop offset="100%" stop-color="#020304"/>
    </linearGradient>
    <linearGradient id="t6-border" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.3"/>
    </linearGradient>
    <linearGradient id="t6-cyan-white" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="40%" stop-color="#e2e8f0"/>
      <stop offset="100%" stop-color="#38bdf8"/>
    </linearGradient>
    <filter id="t6-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#t6-bg)" filter="url(#t6-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#t6-border)" stroke-width="1.5"/>
  
  <!-- Double Forward Slash '//' + Lowercase 'm' -->
  <g transform="translate(0, 0)">
    <!-- Slash 1 (Code Comment //) -->
    <line x1="168" y1="352" x2="236" y2="152" stroke="#38bdf8" stroke-width="34" stroke-linecap="round"/>
    <!-- Slash 2 -->
    <line x1="248" y1="352" x2="316" y2="152" stroke="url(#t6-cyan-white)" stroke-width="34" stroke-linecap="round"/>
    <!-- Connecting Arch loop forming 'm' & 'd' -->
    <path d="M 236 152 C 276 152 300 178 300 216 V 352" fill="none" stroke="#ffffff" stroke-width="34" stroke-linecap="round"/>
    <!-- Micro Cursor Underscore -->
    <line x1="336" y1="352" x2="380" y2="352" stroke="#f59e0b" stroke-width="20" stroke-linecap="round"/>
  </g>
</svg>`;

// 7. minimal-bracket-m: Clean Angle Bracket '<m>' Ligature (AST / Syntax)
const svg7_tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="t7-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#16171d"/>
      <stop offset="50%" stop-color="#090a0d"/>
      <stop offset="100%" stop-color="#010102"/>
    </linearGradient>
    <linearGradient id="t7-border" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#8b5cf6" stop-opacity="0.25"/>
    </linearGradient>
    <filter id="t7-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.85"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#t7-bg)" filter="url(#t7-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#t7-border)" stroke-width="1.5"/>
  
  <!-- Left Angle Bracket '<' merged into 'M' -->
  <g transform="translate(0, 0)">
    <!-- Left Opening Bracket '<' forming left stem -->
    <path d="M 204 148 L 132 250 L 204 352" fill="none" stroke="#38bdf8" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/>
    <!-- Right Opening Bracket '>' forming right stem -->
    <path d="M 308 148 L 380 250 L 308 352" fill="none" stroke="#a855f7" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/>
    <!-- Center V Connector completing 'M' -->
    <path d="M 204 148 L 256 244 L 308 148" fill="none" stroke="#ffffff" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

// 8. linear-wordmark-tile: Ultra-Sophisticated Monogram & Geometric Grotesk
const svg8_tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="t8-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#121318"/>
      <stop offset="50%" stop-color="#07080a"/>
      <stop offset="100%" stop-color="#000000"/>
    </linearGradient>
    <linearGradient id="t8-border" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
      <stop offset="50%" stop-color="#ffffff" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.15"/>
    </linearGradient>
    <linearGradient id="t8-silver" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="50%" stop-color="#e2e8f0"/>
      <stop offset="100%" stop-color="#94a3b8"/>
    </linearGradient>
    <filter id="t8-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#t8-bg)" filter="url(#t8-shadow)"/>
  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#t8-border)" stroke-width="1.5"/>
  
  <!-- Continuous Pure 45° Chamfer M-Vector -->
  <path d="M 124 352 V 192 L 188 144 L 256 204 L 324 144 L 388 192 V 352" 
        fill="none" stroke="url(#t8-silver)" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/>
  <!-- Razor Sharp Forward Terminal Vector -->
  <path d="M 196 284 L 256 344 L 316 284" 
        fill="none" stroke="#38bdf8" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

writeFileSync('design/logo-concepts/type-1-mx-ligature.svg', svg1_tile, 'utf8');
writeFileSync('design/logo-concepts/type-2-md-monogram.svg', svg2_tile, 'utf8');
writeFileSync('design/logo-concepts/type-3-m-prompt.svg', svg3_tile, 'utf8');
writeFileSync('design/logo-concepts/type-4-mix-cross.svg', svg4_tile, 'utf8');
writeFileSync('design/logo-concepts/type-5-heavy-grotesk.svg', svg5_tile, 'utf8');
writeFileSync('design/logo-concepts/type-6-slash-code.svg', svg6_tile, 'utf8');
writeFileSync('design/logo-concepts/type-7-bracket-m.svg', svg7_tile, 'utf8');
writeFileSync('design/logo-concepts/type-8-linear-apex.svg', svg8_tile, 'utf8');

console.log('8 Modern Typography & Lettering SVGs generated successfully!');
