import * as React from 'react';
import type { SVGProps } from 'react';

// Hand-drawn 24-unit artwork shared by capability lists, detail headers, and
// composer skill selections. Capabilities that wrap a product wear that
// product's mark and colour (Git, Chrome, Windows, Microsoft 365, Word, Excel,
// PowerPoint, Acrobat red) so the row is recognised at a glance (user: 브랜드가
// 드러나게). Everything else shares one language: a single object, 1.5 stroke
// with round joins, drawn inside the 3…21 frame so no per-icon transform is
// needed, and at most one quiet plate (fillOpacity .14) for silhouette. Keep
// navigation/status glyphs in MxIcon.
export const CAPABILITY_ARTWORK = {
  git: '#f05033',
  memory: '#b49bf2',
  browser: '#4a8df8',
  computer: '#1a8ce6',
  office: '#8a94a6',
  local: '#91bf7b',
  voice: '#dd9ac2',
  pdf: '#e5252a',
  pptx: '#d24726',
  docx: '#2b6fd1',
  xlsx: '#21a366',
  image: '#ba9af3',
  video: '#df91b8',
  goal: '#e9af70',
  recall: '#78c4c5',
  setup: '#b0b6c2',
  creator: '#c0a0ed',
  attach: '#9aa4b8',
  skill: '#a8afbf',
} as const;

export type CapabilityArtwork = keyof typeof CAPABILITY_ARTWORK;

const BUILT_IN_ARTWORK: Record<string, CapabilityArtwork> = {
  git: 'git', memory: 'memory', browser: 'browser', computer: 'computer',
  office: 'office', localProvider: 'local', voice: 'voice',
};
const SKILL_ARTWORK: Record<string, CapabilityArtwork> = {
  'browser-use': 'browser',
  'computer-use': 'computer',
  'memory-management': 'memory',
  'local-provider': 'local',
  'history-recall': 'recall',
  'goal-management': 'goal',
  'skill-creator': 'creator',
  'attach-files': 'attach',
  setup: 'setup',
  pdf: 'pdf', pptx: 'pptx', docx: 'docx', xlsx: 'xlsx',
  image: 'image', video: 'video',
};

const PLATE = { fill: 'currentColor', fillOpacity: 0.14, stroke: 'none' } as const;
const SOLID = { fill: 'currentColor', stroke: 'none' } as const;
// Office document: the page outline in the format's brand colour, with the
// brand tile (Word W, Excel X, PowerPoint P, Acrobat loop) anchored bottom-left
// exactly as the Microsoft 365 file icons place it.
const PAGE = 'M8.5 3.5h6L19.5 8.5V19a1.5 1.5 0 0 1-1.5 1.5H8.5A1.5 1.5 0 0 1 7 19V5a1.5 1.5 0 0 1 1.5-1.5Z';
// Geometry-generated outlines (hand-placed coordinates drifted off-symmetry and
// read as dented at 16px). Gear: 8 teeth, tip R 8.6 / root R 6.7, 18° tips and
// 27° roots about (12,12). Wrench: R 4.4 head with a 3.1-wide open jaw on a
// 3-wide handle, drawn axis-aligned then rotated -45° about the centre.
const GEAR = 'M10.44 5.49 10.65 3.51A8.6 8.6 0 0 1 13.35 3.51L13.56 5.49A6.7 6.7 0 0 1 15.5 6.29L17.05 5.04A8.6 8.6 0 0 1 18.96 6.95L17.71 8.5A6.7 6.7 0 0 1 18.51 10.44L20.49 10.65A8.6 8.6 0 0 1 20.49 13.35L18.51 13.56A6.7 6.7 0 0 1 17.71 15.5L18.96 17.05A8.6 8.6 0 0 1 17.05 18.96L15.5 17.71A6.7 6.7 0 0 1 13.56 18.51L13.35 20.49A8.6 8.6 0 0 1 10.65 20.49L10.44 18.51A6.7 6.7 0 0 1 8.5 17.71L6.95 18.96A8.6 8.6 0 0 1 5.04 17.05L6.29 15.5A6.7 6.7 0 0 1 5.49 13.56L3.51 13.35A8.6 8.6 0 0 1 3.51 10.65L5.49 10.44A6.7 6.7 0 0 1 6.29 8.5L5.04 6.95A8.6 8.6 0 0 1 6.95 5.04L8.5 6.29A6.7 6.7 0 0 1 10.44 5.49Z';
const WRENCH = 'M5.17 16.71 11.08 10.8A4.4 4.4 0 0 1 16.88 4.93L13.69 8.12 15.88 10.31 19.07 7.12A4.4 4.4 0 0 1 13.2 12.92L7.29 18.83A1.5 1.5 0 0 1 5.17 16.71Z';

function Artwork({ kind }: { kind: CapabilityArtwork }) {
  if (kind === 'pdf' || kind === 'pptx' || kind === 'docx' || kind === 'xlsx') {
    return <>
      <path d={PAGE} {...PLATE} />
      <path d={PAGE} /><path d="M14.5 3.5v5h5" />
      <path d="M4.75 10.5h7.5A1.25 1.25 0 0 1 13.5 11.75v6.5a1.25 1.25 0 0 1-1.25 1.25h-7.5A1.25 1.25 0 0 1 3.5 18.25v-6.5A1.25 1.25 0 0 1 4.75 10.5Z" {...SOLID} />
      <g stroke="#fff" strokeWidth="1.6">
        {kind === 'pdf' && <path d="M5.25 17.75c1.9-1.1 3-3.5 3.25-5.5.25 2.2 1.4 4.3 3.25 5.5-2.1-.8-4.4-.8-6.5 0Z" />}
        {kind === 'pptx' && <path d="M6.75 17.5v-5h1.9a1.5 1.5 0 0 1 0 3h-1.9" />}
        {kind === 'docx' && <path d="m5.25 12.5 1.2 4.75 2.05-3.5 2.05 3.5 1.2-4.75" />}
        {kind === 'xlsx' && <path d="m6.25 12.5 4.5 5m0-5-4.5 5" />}
      </g>
    </>;
  }
  switch (kind) {
    // Git's diamond mark (git-scm.com), scaled into the shared frame.
    case 'git': return <g transform="translate(3 3) scale(.75)">
      <path d="M23.546 10.93 13.067.452c-.604-.603-1.582-.603-2.188 0L8.708 2.627l2.76 2.76c.645-.215 1.379-.07 1.889.441.516.515.658 1.258.438 1.9l2.658 2.66c.645-.223 1.387-.078 1.9.435.721.72.721 1.884 0 2.604-.719.719-1.881.719-2.6 0-.539-.541-.674-1.337-.404-1.996L12.86 8.955v6.525c.176.086.342.203.488.348.713.721.713 1.883 0 2.6-.719.721-1.889.721-2.609 0-.719-.719-.719-1.879 0-2.598.182-.18.387-.316.605-.406V8.835c-.217-.091-.424-.222-.6-.401-.545-.545-.676-1.342-.396-2.009L7.636 3.7.45 10.881c-.6.605-.6 1.584 0 2.189l10.48 10.477c.604.604 1.582.604 2.186 0l10.43-10.43c.605-.603.605-1.582 0-2.187" {...SOLID} />
    </g>;
    // A bookmark: what you keep to come back to (no brain — user request).
    case 'memory': return <>
      <path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-3.75L6 20V5.5a1 1 0 0 1 1-1Z" {...PLATE} />
      <path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-3.75L6 20V5.5a1 1 0 0 1 1-1Z" />
      <path d="M9.5 9h5" />
    </>;
    // Chrome's ring-and-hub, monochrome in Google blue: the three dividers
    // leave the hub tangentially like the real mark, not radially.
    case 'browser': return <>
      <circle cx="12" cy="12" r="8.5" {...PLATE} />
      <circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3.5" />
      <path d="M12 8.5h7.75M15.03 13.75l-3.88 6.71M8.97 13.75l-3.87-6.71" />
    </>;
    // Windows four-pane flag (the computer-use host is the Windows desktop).
    // A laptop with the pointer on screen: the capability drives a desktop.
    case 'computer': return <>
      <rect x="5" y="4.5" width="14" height="10" rx="1.75" {...PLATE} />
      <rect x="5" y="4.5" width="14" height="10" rx="1.75" />
      <path d="M4 14.5 2.75 18.25a1 1 0 0 0 .95 1.25h16.6a1 1 0 0 0 .95-1.25L20 14.5" />
      <path d="m10 7.25 5 3-2.15.6-.95 2.15Z" {...SOLID} />
    </>;
    // Microsoft's four tiles in brand colours: the Office capability is the
    // Word / Excel / PowerPoint / PDF family behind one switch.
    case 'office': return <g stroke="none">
      <path d="M3.5 3.5h7.75v7.75H3.5Z" fill="#f25022" />
      <path d="M12.75 3.5h7.75v7.75h-7.75Z" fill="#7fba00" />
      <path d="M3.5 12.75h7.75v7.75H3.5Z" fill="#00a4ef" />
      <path d="M12.75 12.75h7.75v7.75h-7.75Z" fill="#ffb900" />
    </g>;
    case 'local': return <>
      <rect x="6" y="6" width="12" height="12" rx="2.5" {...PLATE} />
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
      <path d="M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3M3 9h3M3 12h3M3 15h3M18 9h3M18 12h3M18 15h3" />
    </>;
    case 'voice': return <>
      <rect x="9.5" y="3.5" width="5" height="10" rx="2.5" {...PLATE} />
      <rect x="9.5" y="3.5" width="5" height="10" rx="2.5" />
      <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3.5M9 20.5h6" />
    </>;
    case 'image': return <>
      <rect x="3" y="4" width="18" height="16" rx="3" {...PLATE} />
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <circle cx="9" cy="9.5" r="1.6" {...SOLID} />
      <path d="m3.5 17.25 4.75-4.75 3.5 3.5 3-3 5.75 5.75" />
    </>;
    case 'video': return <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" {...PLATE} />
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M3 9.25h3.5M3 14.75h3.5M17.5 9.25H21M17.5 14.75H21" />
      <path d="m10.25 9 5 3-5 3Z" {...SOLID} />
    </>;
    // A planted flag: the goal you run toward.
    case 'goal': return <>
      <path d="M6.5 4.5h11.75l-2.75 3.75 2.75 3.75H6.5Z" {...PLATE} />
      <path d="M6.5 4.5h11.75l-2.75 3.75 2.75 3.75H6.5M6.5 3.5v17" />
    </>;
    case 'attach': return <>
      <path d="m15.75 7.25-6.9 6.9a1.75 1.75 0 0 0 2.5 2.5l7.4-7.4a3.75 3.75 0 0 0-5.3-5.3l-7.6 7.6a5.25 5.25 0 0 0 7.4 7.4l5.25-5.25" />
    </>;
    case 'recall': return <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 8.5M4.5 4.5v4h4M12 8.5V12l2.5 1.75" />
    </>;
    // The settings cog every OS uses: a ring with six square teeth and a hub.
    case 'setup': return <>
      <path d={GEAR} {...PLATE} />
      <path d={GEAR} />
      <circle cx="12" cy="12" r="2.6" />
    </>;
    case 'creator': return <>
      <path d={WRENCH} {...PLATE} />
      <path d={WRENCH} />
    </>;
    // Generic skill: a full-frame hexagon module with a sparkle. The old flat
    // layer stack only used half the frame's height and read undersized beside
    // the brand marks (user: 스킬 아이콘 왜 작게 느껴지냐).
    default: return <>
      <path d="M12 3.5 19.36 7.75v8.5L12 20.5l-7.36-4.25v-8.5Z" {...PLATE} />
      <path d="M12 3.5 19.36 7.75v8.5L12 20.5l-7.36-4.25v-8.5Z" />
      <path d="m12 7.75 1.3 2.95L16.25 12l-2.95 1.3L12 16.25l-1.3-2.95L7.75 12l2.95-1.3Z" {...SOLID} />
    </>;
  }
}

export function CapabilityIcon({ name, kind = 'skill', size = 16, className = '', style, ...props }: {
  name: string;
  kind?: 'skill' | 'builtin';
  size?: number;
} & SVGProps<SVGSVGElement>) {
  const registry = kind === 'builtin' ? BUILT_IN_ARTWORK : SKILL_ARTWORK;
  const artwork = Object.hasOwn(registry, name) ? registry[name] : 'skill';
  return React.createElement('svg', {
    ...props, xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24',
    width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
    className: `capability-icon ${className}`.trim(),
    style: { flexShrink: 0, ...style, color: CAPABILITY_ARTWORK[artwork] },
  }, React.createElement(Artwork, { kind: artwork }));
}
