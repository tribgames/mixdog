import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';

chdir(fileURLToPath(new URL('../..', import.meta.url)));

const outDir = 'design/logo-concepts';

// 18 Rich, High-End Color & Center Core Variations of the Original Aperture Triad
const variations = [
  // 1. Cyber & Electric Neon Gradients
  {
    id: 'ap-col-01',
    title: 'Electric Cyan & Indigo',
    category: 'Cyber Neon',
    tag: 'Cyan / Indigo / White Core',
    bg: '#0a0b10',
    rx: 60,
    gradientDefs: `
      <linearGradient id="g1-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#00f2fe"/><stop offset="100%" stop-color="#38bdf8"/>
      </linearGradient>
      <linearGradient id="g1-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#818cf8"/>
      </linearGradient>
      <linearGradient id="g1-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#818cf8"/><stop offset="100%" stop-color="#c084fc"/>
      </linearGradient>
    `,
    paths: [
      { stroke: 'url(#g1-a)', transform: '' },
      { stroke: 'url(#g1-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#g1-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `<circle cx="128" cy="128" r="12" fill="#00f2fe"/><circle cx="128" cy="128" r="5" fill="#ffffff"/>`
  },
  {
    id: 'ap-col-02',
    title: 'Aurora Borealis Flow',
    category: 'Aurora & Spectrum',
    tag: 'Emerald / Cyan / Purple',
    bg: '#080d12',
    rx: 60,
    gradientDefs: `
      <linearGradient id="g2-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#10b981"/><stop offset="100%" stop-color="#06b6d4"/>
      </linearGradient>
      <linearGradient id="g2-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#06b6d4"/><stop offset="100%" stop-color="#3b82f6"/>
      </linearGradient>
      <linearGradient id="g2-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#ec4899"/>
      </linearGradient>
      <radialGradient id="g2-glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#10b981" stop-opacity="0.8"/>
        <stop offset="100%" stop-color="#080d12" stop-opacity="0"/>
      </radialGradient>
    `,
    paths: [
      { stroke: 'url(#g2-a)', transform: '' },
      { stroke: 'url(#g2-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#g2-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `<circle cx="128" cy="128" r="22" fill="url(#g2-glow)"/><circle cx="128" cy="128" r="10" fill="#10b981"/><circle cx="128" cy="128" r="4" fill="#ffffff"/>`
  },
  {
    id: 'ap-col-03',
    title: 'Sunset Synthwave',
    category: 'Cyber Neon',
    tag: 'Hot Pink / Violet / Amber',
    bg: '#100814',
    rx: 60,
    gradientDefs: `
      <linearGradient id="g3-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ff007a"/><stop offset="100%" stop-color="#f43f5e"/>
      </linearGradient>
      <linearGradient id="g3-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#a855f7"/><stop offset="100%" stop-color="#6366f1"/>
      </linearGradient>
      <linearGradient id="g3-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#fbbf24"/><stop offset="100%" stop-color="#f97316"/>
      </linearGradient>
    `,
    paths: [
      { stroke: 'url(#g3-a)', transform: '' },
      { stroke: 'url(#g3-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#g3-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `<circle cx="128" cy="128" r="12" fill="#ff007a"/><circle cx="128" cy="128" r="4" fill="#fbbf24"/>`
  },
  {
    id: 'ap-col-04',
    title: 'Anthropic Terracotta & Warm Sand',
    category: 'Warm & Natural',
    tag: 'Claude Warm Terracotta / Sand',
    bg: '#141210',
    rx: 60,
    gradientDefs: `
      <linearGradient id="g4-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#f97316"/><stop offset="100%" stop-color="#ea580c"/>
      </linearGradient>
      <linearGradient id="g4-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#fcd34d"/><stop offset="100%" stop-color="#f59e0b"/>
      </linearGradient>
      <linearGradient id="g4-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#e2d9cc"/><stop offset="100%" stop-color="#a89f91"/>
      </linearGradient>
    `,
    paths: [
      { stroke: 'url(#g4-a)', transform: '' },
      { stroke: 'url(#g4-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#g4-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <!-- 4-Point AI Spark Asterisk -->
      <path d="M128 116 L128 140 M116 128 L140 128 M120 120 L136 136 M120 136 L136 120" stroke="#f97316" stroke-width="4" stroke-linecap="round"/>
      <circle cx="128" cy="128" r="4" fill="#ffffff"/>
    `
  },
  {
    id: 'ap-col-05',
    title: 'Hacker Phosphor CRT Green',
    category: 'Terminal & Hacker',
    tag: 'Ghostty / Zero-Latency CRT',
    bg: '#050c08',
    rx: 60,
    gradientDefs: `
      <linearGradient id="g5-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#22c55e"/><stop offset="100%" stop-color="#15803d"/>
      </linearGradient>
      <linearGradient id="g5-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#4ade80"/><stop offset="100%" stop-color="#22c55e"/>
      </linearGradient>
      <linearGradient id="g5-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#86efac"/><stop offset="100%" stop-color="#4ade80"/>
      </linearGradient>
    `,
    paths: [
      { stroke: 'url(#g5-a)', transform: '' },
      { stroke: 'url(#g5-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#g5-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <!-- Terminal Prompt Chevron Center Core -->
      <path d="M122 121 L129 128 L122 135" fill="none" stroke="#22c55e" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      <line x1="131" y1="135" x2="136" y2="135" stroke="#4ade80" stroke-width="3.5" stroke-linecap="round"/>
    `
  },
  {
    id: 'ap-col-06',
    title: 'Monochrome Stark White & Charcoal',
    category: 'Monochrome & Minimal',
    tag: 'Pure Luxury Minimalist',
    bg: '#090a0c',
    rx: 60,
    gradientDefs: `
      <linearGradient id="g6-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#cbd5e1"/>
      </linearGradient>
      <linearGradient id="g6-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#94a3b8"/><stop offset="100%" stop-color="#64748b"/>
      </linearGradient>
      <linearGradient id="g6-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#475569"/><stop offset="100%" stop-color="#1e293b"/>
      </linearGradient>
    `,
    paths: [
      { stroke: 'url(#g6-a)', transform: '' },
      { stroke: 'url(#g6-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#g6-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <!-- Concentric Rings Aperture Donut Core -->
      <circle cx="128" cy="128" r="14" fill="none" stroke="#ffffff" stroke-width="4"/>
      <circle cx="128" cy="128" r="5" fill="#ffffff"/>
    `
  },
  {
    id: 'ap-col-07',
    title: 'Prism Diamond Spark',
    category: 'Cyber Neon',
    tag: 'Diamond Rhombus Core',
    bg: '#0c0d14',
    rx: 60,
    gradientDefs: `
      <linearGradient id="g7-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#0284c7"/>
      </linearGradient>
      <linearGradient id="g7-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#be123c"/>
      </linearGradient>
      <linearGradient id="g7-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#a855f7"/><stop offset="100%" stop-color="#7e22ce"/>
      </linearGradient>
    `,
    paths: [
      { stroke: 'url(#g7-a)', transform: '' },
      { stroke: 'url(#g7-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#g7-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <!-- Diamond Rhombus Core -->
      <polygon points="128,112 144,128 128,144 112,128" fill="#38bdf8"/>
      <polygon points="128,118 138,128 128,138 118,128" fill="#ffffff"/>
    `
  },
  {
    id: 'ap-col-08',
    title: 'Machined Brass & Champagne Gold',
    category: 'Hardware & Metal',
    tag: 'Gold / Brass / Obsidian',
    bg: '#0e0e0a',
    rx: 60,
    gradientDefs: `
      <linearGradient id="g8-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#fef08a"/><stop offset="100%" stop-color="#eab308"/>
      </linearGradient>
      <linearGradient id="g8-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ca8a04"/><stop offset="100%" stop-color="#854d0e"/>
      </linearGradient>
      <linearGradient id="g8-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#fef9c3"/><stop offset="100%" stop-color="#fde047"/>
      </linearGradient>
    `,
    paths: [
      { stroke: 'url(#g8-a)', transform: '' },
      { stroke: 'url(#g8-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#g8-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <!-- Crosshair Target Laser Diode -->
      <circle cx="128" cy="128" r="14" fill="none" stroke="#eab308" stroke-width="2"/>
      <line x1="128" y1="110" x2="128" y2="146" stroke="#fde047" stroke-width="2"/>
      <line x1="110" y1="128" x2="146" y2="128" stroke="#fde047" stroke-width="2"/>
      <circle cx="128" cy="128" r="6" fill="#fef08a"/>
    `
  },
  {
    id: 'ap-col-09',
    title: 'Inverted Clean White Tile',
    category: 'Monochrome & Minimal',
    tag: 'Light Mode Pure Ceramic',
    bg: '#f8fafc',
    rx: 60,
    gradientDefs: `
      <linearGradient id="g9-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0f172a"/><stop offset="100%" stop-color="#334155"/>
      </linearGradient>
      <linearGradient id="g9-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0284c7"/><stop offset="100%" stop-color="#0369a1"/>
      </linearGradient>
      <linearGradient id="g9-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#334155"/><stop offset="100%" stop-color="#64748b"/>
      </linearGradient>
    `,
    paths: [
      { stroke: 'url(#g9-a)', transform: '' },
      { stroke: 'url(#g9-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#g9-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `<circle cx="128" cy="128" r="12" fill="#0284c7"/><circle cx="128" cy="128" r="4" fill="#ffffff"/>`
  },
  {
    id: 'ap-col-10',
    title: 'Hexagonal Cyber Kernel',
    category: 'Cyber Neon',
    tag: 'Hexagon Core / Cyan & Rose',
    bg: '#0a0d14',
    rx: 60,
    gradientDefs: `
      <linearGradient id="g10-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#00f2fe"/><stop offset="100%" stop-color="#4f46e5"/>
      </linearGradient>
      <linearGradient id="g10-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#ec4899"/>
      </linearGradient>
      <linearGradient id="g10-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#cbd5e1"/>
      </linearGradient>
    `,
    paths: [
      { stroke: 'url(#g10-a)', transform: '' },
      { stroke: 'url(#g10-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#g10-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <!-- Hexagonal Kernel Core -->
      <polygon points="128,114 140,121 140,135 128,142 116,135 116,121" fill="#00f2fe"/>
      <polygon points="128,120 134,124 134,132 128,136 122,132 122,124" fill="#ffffff"/>
    `
  },
  {
    id: 'ap-col-11',
    title: 'Plasma Violet & Deep Magenta',
    category: 'Cyber Neon',
    tag: 'Plasma Violet / Pulse Core',
    bg: '#0e0918',
    rx: 60,
    gradientDefs: `
      <linearGradient id="g11-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#c084fc"/><stop offset="100%" stop-color="#7e22ce"/>
      </linearGradient>
      <linearGradient id="g11-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#e879f9"/><stop offset="100%" stop-color="#a21caf"/>
      </linearGradient>
      <linearGradient id="g11-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#0369a1"/>
      </linearGradient>
    `,
    paths: [
      { stroke: 'url(#g11-a)', transform: '' },
      { stroke: 'url(#g11-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#g11-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <!-- Pulsing Multi-layer Core -->
      <circle cx="128" cy="128" r="16" fill="#c084fc" opacity="0.3"/>
      <circle cx="128" cy="128" r="10" fill="#e879f9"/>
      <circle cx="128" cy="128" r="4" fill="#ffffff"/>
    `
  },
  {
    id: 'ap-col-12',
    title: 'Fire & Ember Ignition',
    category: 'Warm & Natural',
    tag: 'Flame Ember / Red Core',
    bg: '#120805',
    rx: 60,
    gradientDefs: `
      <linearGradient id="g12-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ef4444"/><stop offset="100%" stop-color="#991b1b"/>
      </linearGradient>
      <linearGradient id="g12-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#f97316"/><stop offset="100%" stop-color="#c2410c"/>
      </linearGradient>
      <linearGradient id="g12-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#fbbf24"/><stop offset="100%" stop-color="#d97706"/>
      </linearGradient>
    `,
    paths: [
      { stroke: 'url(#g12-a)', transform: '' },
      { stroke: 'url(#g12-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#g12-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <circle cx="128" cy="128" r="13" fill="#ef4444"/>
      <circle cx="128" cy="128" r="7" fill="#fbbf24"/>
      <circle cx="128" cy="128" r="2.5" fill="#ffffff"/>
    `
  },
  {
    id: 'ap-col-13',
    title: 'Pure Single-Gradient Continuous Loop',
    category: 'Continuous Flow',
    tag: 'Continuous Color Sweep',
    bg: '#090a10',
    rx: 60,
    gradientDefs: `
      <linearGradient id="g13-flow" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#00f2fe"/>
        <stop offset="35%" stop-color="#38bdf8"/>
        <stop offset="70%" stop-color="#818cf8"/>
        <stop offset="100%" stop-color="#f43f5e"/>
      </linearGradient>
    `,
    paths: [
      { stroke: 'url(#g13-flow)', transform: '' },
      { stroke: 'url(#g13-flow)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#g13-flow)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `<circle cx="128" cy="128" r="11" fill="url(#g13-flow)"/>`
  },
  {
    id: 'ap-col-14',
    title: 'Holographic Liquid Chrome',
    category: 'Hardware & Metal',
    tag: 'Ultra-Gloss Chrome / Rainbow Specular',
    bg: '#07080a',
    rx: 60,
    gradientDefs: `
      <linearGradient id="g14-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="30%" stop-color="#38bdf8"/><stop offset="70%" stop-color="#e2e8f0"/><stop offset="100%" stop-color="#475569"/>
      </linearGradient>
      <linearGradient id="g14-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="30%" stop-color="#f43f5e"/><stop offset="70%" stop-color="#cbd5e1"/><stop offset="100%" stop-color="#334155"/>
      </linearGradient>
      <linearGradient id="g14-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="30%" stop-color="#a855f7"/><stop offset="70%" stop-color="#94a3b8"/><stop offset="100%" stop-color="#1e293b"/>
      </linearGradient>
    `,
    paths: [
      { stroke: 'url(#g14-a)', transform: '' },
      { stroke: 'url(#g14-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#g14-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <!-- Chrome Ball with Specular Reflection -->
      <circle cx="128" cy="128" r="12" fill="#cbd5e1"/>
      <circle cx="125" cy="125" r="4" fill="#ffffff"/>
    `
  },
  {
    id: 'ap-col-15',
    title: 'Slim Hairline Precision (14px)',
    category: 'Monochrome & Minimal',
    tag: 'Refined Slim Stroke & Dot',
    bg: '#08090d',
    rx: 60,
    gradientDefs: `
      <linearGradient id="g15-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#38bdf8"/>
      </linearGradient>
    `,
    paths: [
      { stroke: 'url(#g15-a)', transform: '' },
      { stroke: 'url(#g15-a)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#g15-a)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 14,
    centerCore: `<circle cx="128" cy="128" r="7" fill="#ffffff"/>`
  },
  {
    id: 'ap-col-16',
    title: 'Ultra Chunky Bold (30px)',
    category: 'Monochrome & Minimal',
    tag: 'Bold Heavyweight Glyph',
    bg: '#0d0e14',
    rx: 60,
    gradientDefs: `
      <linearGradient id="g16-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#6366f1"/>
      </linearGradient>
    `,
    paths: [
      { stroke: 'url(#g16-a)', transform: '' },
      { stroke: 'url(#g16-a)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#g16-a)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 30,
    centerCore: `<circle cx="128" cy="128" r="16" fill="#ffffff"/>`
  },
  {
    id: 'ap-col-17',
    title: 'Square Pixel Kernel Center',
    category: 'Terminal & Hacker',
    tag: 'Retro Pixel Matrix',
    bg: '#0b0d10',
    rx: 60,
    gradientDefs: `
      <linearGradient id="g17-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#0284c7"/>
      </linearGradient>
      <linearGradient id="g17-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#22c55e"/><stop offset="100%" stop-color="#16a34a"/>
      </linearGradient>
      <linearGradient id="g17-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#eab308"/><stop offset="100%" stop-color="#ca8a04"/>
      </linearGradient>
    `,
    paths: [
      { stroke: 'url(#g17-a)', transform: '' },
      { stroke: 'url(#g17-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#g17-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <!-- Pixel Square Core -->
      <rect x="116" y="116" width="24" height="24" rx="4" fill="#38bdf8"/>
      <rect x="122" y="122" width="12" height="12" rx="2" fill="#ffffff"/>
    `
  },
  {
    id: 'ap-col-18',
    title: 'Negative Cut Center (Hollow Donut)',
    category: 'Monochrome & Minimal',
    tag: 'Negative Space Donut',
    bg: '#0c0e12',
    rx: 60,
    gradientDefs: `
      <linearGradient id="g18-a" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#fb7185"/>
      </linearGradient>
      <linearGradient id="g18-b" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#7dd3fc"/>
      </linearGradient>
      <linearGradient id="g18-c" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#e2e8f0"/>
      </linearGradient>
    `,
    paths: [
      { stroke: 'url(#g18-a)', transform: '' },
      { stroke: 'url(#g18-b)', transform: 'transform="rotate(120 128 128)"' },
      { stroke: 'url(#g18-c)', transform: 'transform="rotate(240 128 128)"' }
    ],
    strokeWidth: 22,
    centerCore: `
      <circle cx="128" cy="128" r="16" fill="none" stroke="#f43f5e" stroke-width="5"/>
    `
  }
];

// Generate SVG files
const generatedFiles = [];
for (const v of variations) {
  const fileName = `aperture-color-${v.id.replace('ap-col-', '')}.svg`;
  const filePath = join(outDir, fileName);

  const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    ${v.gradientDefs}
  </defs>
  <rect width="256" height="256" rx="${v.rx}" fill="${v.bg}"/>
  <g fill="none" stroke-width="${v.strokeWidth}" stroke-linecap="round">
    <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="${v.paths[0].stroke}" ${v.paths[0].transform}/>
    <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="${v.paths[1].stroke}" ${v.paths[1].transform}/>
    <path d="M116.2 61A68 68 0 0 1 191.9 104.7" stroke="${v.paths[2].stroke}" ${v.paths[2].transform}/>
  </g>
  ${v.centerCore}
</svg>`;

  writeFileSync(filePath, svgContent, 'utf8');
  generatedFiles.push({ ...v, fileName });
}

console.log(`Generated ${generatedFiles.length} Aperture Triad Color & Core SVGs!`);

// HTML Showcase Builder for Aperture Color Lab
const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Aperture Triad Color & Center Core Lab — Mixdog</title>
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
        radial-gradient(circle at 50% 0%, rgba(56, 189, 248, 0.12) 0%, transparent 60%),
        radial-gradient(circle at 80% 30%, rgba(244, 63, 94, 0.08) 0%, transparent 50%),
        radial-gradient(circle at 20% 60%, rgba(16, 185, 129, 0.08) 0%, transparent 50%);
      pointer-events: none;
      z-index: 0;
    }

    .container {
      position: relative;
      z-index: 1;
      max-width: 1440px;
      margin: 0 auto;
      padding: 48px 28px 120px;
    }

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
      margin-bottom: 20px;
    }

    h1 {
      font-size: 44px;
      font-weight: 800;
      letter-spacing: -0.03em;
      line-height: 1.15;
      margin-bottom: 14px;
      background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 50%, #94a3b8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .subtitle {
      font-size: 16px;
      color: var(--text-muted);
      max-width: 760px;
      margin: 0 auto 32px;
    }

    /* Interactive Live Lab Tester */
    .lab-box {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      padding: 32px;
      margin-bottom: 48px;
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 36px;
      align-items: center;
    }

    .lab-hero {
      background: #090a0f;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: var(--radius-lg);
      padding: 36px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }

    .lab-hero img {
      width: 180px;
      height: 180px;
      filter: drop-shadow(0 16px 32px rgba(0,0,0,0.6));
    }

    .lab-title {
      font-size: 18px;
      font-weight: 700;
      margin-top: 18px;
      text-align: center;
    }

    .lab-tag {
      font-size: 12px;
      color: var(--cyan);
      font-family: 'JetBrains Mono', monospace;
      margin-top: 4px;
    }

    /* Scales preview */
    .lab-scales {
      display: flex;
      gap: 20px;
      align-items: center;
      background: rgba(0,0,0,0.3);
      padding: 16px 24px;
      border-radius: var(--radius-md);
      margin-top: 20px;
      width: 100%;
      justify-content: space-around;
    }

    .scale-node {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--text-dim);
    }

    /* Filter & Grid */
    .filter-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 28px;
      flex-wrap: wrap;
    }

    .chips {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .chip-btn {
      padding: 7px 14px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.2s;
    }

    .chip-btn:hover, .chip-btn.active {
      background: var(--cyan);
      color: #000;
      border-color: var(--cyan);
      font-weight: 700;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 20px;
    }

    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 22px;
      display: flex;
      flex-direction: column;
      align-items: center;
      cursor: pointer;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
    }

    .card:hover {
      transform: translateY(-5px);
      border-color: var(--border-accent);
      background: var(--bg-card-hover);
      box-shadow: 0 16px 36px rgba(0,0,0,0.6);
    }

    .card img {
      width: 130px;
      height: 130px;
      margin-bottom: 16px;
      transition: transform 0.2s ease;
    }

    .card:hover img {
      transform: scale(1.06);
    }

    .card-title {
      font-size: 15px;
      font-weight: 700;
      text-align: center;
      color: #ffffff;
      margin-bottom: 4px;
    }

    .card-tag {
      font-size: 11px;
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
      text-align: center;
      margin-bottom: 14px;
    }

    .card-actions {
      display: flex;
      gap: 8px;
      width: 100%;
      margin-top: auto;
    }

    .btn-sm {
      flex: 1;
      padding: 8px;
      font-size: 11px;
      font-weight: 600;
      border-radius: var(--radius-sm);
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.04);
      color: var(--text);
      cursor: pointer;
      text-align: center;
      text-decoration: none;
      transition: all 0.2s;
    }

    .btn-sm:hover {
      background: var(--cyan);
      color: #000;
      border-color: var(--cyan);
    }

    @media (max-width: 900px) {
      .lab-box { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="bg-grid"></div>

  <div class="container">
    <header>
      <div class="pill-badge">🌀 131 Aperture Triad Color & Core Lab</div>
      <h1>Aperture Triad Color & Center Core Variations</h1>
      <p class="subtitle">
        131번 원본 아퍼처 트라이어드(120° 스웹트 아크 3개)의 심플하고 완벽한 기하학을 유지하면서,<br>
        <strong>다채로운 네온/오로라/메탈 그라디언트</strong>와 <strong>지능형 센터 코어(다이아몬드, 아스테리스크, 프롬프트, 크로스헤어 등)</strong>를 변형한 에셋들입니다.
      </p>
    </header>

    <!-- Interactive Top Lab Simulator -->
    <div class="lab-box">
      <div class="lab-hero">
        <img id="active-hero-img" src="./aperture-color-01.svg" alt="Active" />
        <div class="lab-title" id="active-hero-title">${generatedFiles[0].title}</div>
        <div class="lab-tag" id="active-hero-tag">${generatedFiles[0].tag}</div>
      </div>

      <div style="display: flex; flex-direction: column; justify-content: center;">
        <h3 style="font-size: 20px; font-weight: 700; margin-bottom: 8px;">실시간 멀티 스케일 시인성 및 디테일 확인</h3>
        <p style="font-size: 13px; color: var(--text-muted); line-height: 1.6; margin-bottom: 16px;">
          아래 카드 중 하나를 클릭하면 이곳에 즉시 로드되며, 64px, 32px, 24px, 16px 등 다양한 해상도에서의 아크 선명도와 중심 코어의 시인성을 한눈에 비교할 수 있습니다.
        </p>

        <div class="lab-scales">
          <div class="scale-node">
            <img id="scale-img-64" src="./aperture-color-01.svg" style="width: 64px; height: 64px;" />
            <span>64px (Dock)</span>
          </div>
          <div class="scale-node">
            <img id="scale-img-32" src="./aperture-color-01.svg" style="width: 32px; height: 32px;" />
            <span>32px (Toolbar)</span>
          </div>
          <div class="scale-node">
            <img id="scale-img-24" src="./aperture-color-01.svg" style="width: 24px; height: 24px;" />
            <span>24px (Tab)</span>
          </div>
          <div class="scale-node">
            <img id="scale-img-16" src="./aperture-color-01.svg" style="width: 16px; height: 16px;" />
            <span>16px (CLI)</span>
          </div>
        </div>

        <div style="display: flex; gap: 12px; margin-top: 24px;">
          <button class="btn-sm" style="flex: none; padding: 10px 20px; background: var(--cyan); color: #000; font-weight: 700;" onclick="copyCurrentSvg()">📋 현재 선택 SVG 코드 복사</button>
          <a id="active-download-btn" href="./aperture-color-01.svg" download="aperture-color-01.svg" class="btn-sm" style="flex: none; padding: 10px 20px;">⬇️ SVG 파일 다운로드</a>
        </div>
      </div>
    </div>

    <!-- Filter Bar -->
    <div class="filter-bar">
      <div class="chips">
        <button class="chip-btn active" onclick="filterLab('all', this)">전체 (${generatedFiles.length})</button>
        <button class="chip-btn" onclick="filterLab('Cyber Neon', this)">사이버 네온</button>
        <button class="chip-btn" onclick="filterLab('Aurora & Spectrum', this)">오로라 & 스펙트럼</button>
        <button class="chip-btn" onclick="filterLab('Warm & Natural', this)">웜 & 앤트로픽</button>
        <button class="chip-btn" onclick="filterLab('Terminal & Hacker', this)">터미널 & 해커</button>
        <button class="chip-btn" onclick="filterLab('Hardware & Metal', this)">메탈 & 골드</button>
        <button class="chip-btn" onclick="filterLab('Monochrome & Minimal', this)">모노크롬 & 미니멀</button>
      </div>
    </div>

    <!-- Cards Grid -->
    <div class="grid" id="cards-container">
      ${generatedFiles.map(item => `
        <div class="card" data-cat="${item.category}" onclick="setActiveLab('${item.fileName}', '${item.title}', '${item.tag}')">
          <img src="./${item.fileName}" alt="${item.title}" />
          <div class="card-title">${item.title}</div>
          <div class="card-tag">${item.tag}</div>
          <div class="card-actions">
            <button class="btn-sm" onclick="event.stopPropagation(); copyDirectSvg('${item.fileName}')">📋 복사</button>
            <a href="./${item.fileName}" download="${item.fileName}" class="btn-sm" onclick="event.stopPropagation()">⬇️ 저장</a>
          </div>
        </div>
      `).join('')}
    </div>
  </div>

  <script>
    let activeFile = 'aperture-color-01.svg';

    function setActiveLab(file, title, tag) {
      activeFile = file;
      document.getElementById('active-hero-img').src = './' + file;
      document.getElementById('active-hero-title').innerText = title;
      document.getElementById('active-hero-tag').innerText = tag;

      document.getElementById('scale-img-64').src = './' + file;
      document.getElementById('scale-img-32').src = './' + file;
      document.getElementById('scale-img-24').src = './' + file;
      document.getElementById('scale-img-16').src = './' + file;

      const dl = document.getElementById('active-download-btn');
      dl.href = './' + file;
      dl.download = file;
    }

    function filterLab(cat, btn) {
      document.querySelectorAll('.chip-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      document.querySelectorAll('.card').forEach(card => {
        if (cat === 'all' || card.getAttribute('data-cat') === cat) {
          card.style.display = 'flex';
        } else {
          card.style.display = 'none';
        }
      });
    }

    async function copyCurrentSvg() {
      await copyDirectSvg(activeFile);
    }

    async function copyDirectSvg(file) {
      try {
        const res = await fetch('./' + file);
        const text = await res.text();
        await navigator.clipboard.writeText(text);
        alert('SVG 코드가 클립보드에 복사되었습니다! (' + file + ')');
      } catch (err) {
        alert('복사 실패: ' + err.message);
      }
    }
  </script>
</body>
</html>
`;

writeFileSync(join(outDir, 'aperture-color-lab.html'), html.replace(/[ \t]+$/gm, ''), 'utf8');
console.log('✅ Generated aperture-color-lab.html successfully!');
