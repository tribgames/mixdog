// The Mixdog mascot: a blocky pixel creature on a 16x12 grid, painted from the
// string layers in agent-avatar-sprites.mjs (design/mockups/mixy-art). Every
// look is the same body block; the species (ears, marks, tail, legs), an
// accessory, the expression and the colour vary. An agent's `agent.json`
// stores its pick as `avatar: { kind: 'mascot', species, accessory,
// expression, color }` (an older `variant` reads as its mapped look), or its
// own images per motion state as `avatar: { kind: 'custom', states: { idle,
// typing?, message? } }`. An agent without one gets a stable look from its id.
import { MIXY_AGENT_ID } from '../agent/orchestrator/session/agent-home.mjs';
import { MASCOT_SPRITES } from './agent-avatar-sprites.mjs';

/** The palette an avatar colour is chosen from. */
export const AGENT_AVATAR_COLORS = Object.freeze([
  '#e6e6e6',
  '#9a9a9a',
  '#f06a5f',
  '#f59a42',
  '#f2c94c',
  '#5cc98a',
  '#3fc1c9',
  '#5b9bff',
  '#9b7bff',
  '#ef6fb0',
]);

/** Every species a user can pick: the six dogs. Mixy's own (`mixy`) is not one of them. */
export const MASCOT_SPECIES = Object.freeze(['labrador', 'shepherd', 'terrier', 'corgi', 'husky', 'shiba']);
export const MASCOT_ACCESSORIES = Object.freeze(['none', 'collar', 'glasses', 'beanie', 'scarf', 'bow']);
/** Picks that were removed, read as their nearest remaining option. */
const RETIRED_SPECIES = { dalmatian: 'labrador', cat: 'labrador', bird: 'labrador', robot: 'labrador' };
const RETIRED_ACCESSORIES = { headset: 'glasses' };
export const MASCOT_EXPRESSIONS = Object.freeze(['calm', 'happy', 'wink', 'sleepy']);

/** Mixy, the primary assistant: its own silver pup with both ears down, a low
 *  thick tail with a lighter tip and a slate collar with the gold star medal.
 *  Never offered in the picker. */
export const MIXY_AVATAR = Object.freeze({
  kind: 'mascot',
  species: 'mixy',
  accessory: 'none',
  expression: 'calm',
  color: '#e6e6e6',
});

/** The fixed inks a sprite letter names; B, D, L and E depend on the look. */
export const MASCOT_INKS = Object.freeze({
  K: '#141414',
  G: '#f2c94c',
  R: '#e5534b',
  O: '#f59a42',
  W: '#f4f4f4',
  C: '#3fc1c9',
  M: '#8a8a90',
  S: '#2a2b30',
  P: '#ef8fb4',
  N: '#f06a5f',
  n: '#c4544c',
  r: '#b94039',
  F: '#ef6fb0',
  f: '#b8497f',
});

/** `hex` with every channel scaled by `k`. */
export function shadeHex(hex, k) {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (shift) =>
    Math.round(((n >> shift) & 255) * k)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

/** `hex` mixed `k` of the way to white. */
function liftHex(hex, k) {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (shift) => {
    const value = (n >> shift) & 255;
    return Math.round(value + (255 - value) * k)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

// The 12 looks before species existed, `<ears>-<expression>-<plain|collar>`:
// each reads as the species with those ears, the collar as an accessory.
const LEGACY_EARS = { floppy: 'labrador', perky: 'shepherd', folded: 'terrier' };
const LEGACY_VARIANTS = Object.keys(LEGACY_EARS).flatMap((ears) =>
  ['calm', 'happy'].flatMap((expression) => ['plain', 'collar'].map((extra) => `${ears}-${expression}-${extra}`))
);

/** An older `variant` as its species, accessory and expression; null if unknown. */
export function mascotFromVariant(variant) {
  if (!LEGACY_VARIANTS.includes(variant)) return null;
  const [ears, expression, extra] = variant.split('-');
  return { species: LEGACY_EARS[ears], accessory: extra === 'collar' ? 'collar' : 'none', expression };
}

/** `species-accessory-expression`: a look's key (data attributes, tests). */
export const mascotLook = (avatar) => `${avatar.species}-${avatar.accessory}-${avatar.expression}`;

function layerCells(rows, color, eye) {
  if (!rows) return [];
  const ink = (key) => {
    if (key === 'B') return color;
    if (key === 'D') return shadeHex(color, 0.7);
    if (key === 'L') return liftHex(color, 0.35);
    return MASCOT_INKS[key === 'E' ? eye : key];
  };
  const cells = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) if (row[x] !== '.') cells.push({ x, y, fill: ink(row[x]) });
  });
  return cells;
}

/** A look's cells by part, in paint order — the groups the renderer draws
 *  (tail, legs, then the bobbing body with its ears, marks, eyes and
 *  accessory). `blink` is the closed eyes an idle blink shows. Null for an
 *  unknown species. */
export function mascotParts(avatar) {
  const species = MASCOT_SPRITES.species[avatar.species];
  if (!species) return null;
  const paint = (rows) => layerCells(rows, avatar.color, species.eye);
  return {
    tail: paint(species.tail && MASCOT_SPRITES.tails[species.tail]),
    legs: paint(MASCOT_SPRITES.legs[species.legs]),
    body: paint(MASCOT_SPRITES.body),
    ear: paint(species.ears),
    marks: paint(species.marks),
    eyes: paint(MASCOT_SPRITES.eyes[avatar.expression]),
    blink: paint(MASCOT_SPRITES.eyes.sleepy),
    accessory: paint(MASCOT_SPRITES.accessories[avatar.accessory]),
  };
}

/** The look as one still frame: each cell's final fill. [] when unknown. */
export function mascotCells(avatar) {
  const parts = mascotParts(avatar);
  if (!parts) return [];
  const cells = new Map();
  for (const part of ['tail', 'legs', 'body', 'ear', 'marks', 'eyes', 'accessory']) {
    for (const cell of parts[part]) cells.set(`${cell.y},${cell.x}`, cell);
  }
  return [...cells.values()];
}

/** Cells as one SVG path per fill, each row's run one rectangle. */
export function cellPaths(cells) {
  const byFill = new Map();
  for (const { x, y, fill } of cells) {
    const rows = byFill.get(fill) ?? new Map();
    byFill.set(fill, rows);
    rows.set(y, [...(rows.get(y) ?? []), x]);
  }
  return [...byFill].map(([fill, rows]) => {
    let d = '';
    for (const [y, xs] of [...rows].sort(([a], [b]) => a - b)) {
      const sorted = [...new Set(xs)].sort((a, b) => a - b);
      for (let i = 0; i < sorted.length; ) {
        let j = i;
        while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
        const run = j - i + 1;
        d += `M${sorted[i]} ${y}h${run}v1h-${run}z`;
        i = j + 1;
      }
    }
    return { fill, d };
  });
}

/** The motion states an avatar shows today, `idle` first (a custom avatar's
 *  one required image, and every missing state's fallback). */
export const AGENT_AVATAR_STATES = Object.freeze(['idle', 'typing', 'message']);

/** The single image avatar before per-state images: a PNG beside AGENT.md
 *  under a content-hash name. Still read, as a custom avatar's idle image. */
export const AGENT_AVATAR_IMAGE_FILE = /^avatar-[0-9a-f]{12}\.png$/;
/** One state's image in `agents/<id>/avatar/`, under a content-hash name (a
 *  new upload is a new name, so caches by name never go stale). An animated
 *  one keeps its still first frame beside it (avatarPosterFile). */
export const AGENT_AVATAR_STATE_FILE = /^(idle|typing|message)-[0-9a-f]{12}\.(png|gif|webp)$/;
export const AGENT_AVATAR_DIR = 'avatar';
/** The largest image upload accepted, and the largest side of an animation. */
export const AGENT_AVATAR_IMAGE_MAX_BYTES = 1024 * 1024;
export const AGENT_AVATAR_IMAGE_MAX_SIDE = 512;

/** A state image's path under the agent's folder ('/'-separated). */
export const agentAvatarStatePath = (file) =>
  AGENT_AVATAR_IMAGE_FILE.test(file) ? file : `${AGENT_AVATAR_DIR}/${file}`;
/** The still first frame stored beside an animated state image. */
export const avatarPosterFile = (file) => file.replace(/\.(png|gif|webp)$/, '.poster.png');
/** The image a custom avatar shows in `state`: its own, else idle's. */
export const customAvatarStateFile = (avatar, state) => avatar.states[state] ?? avatar.states.idle;

const u16le = (bytes, at) => bytes[at] | (bytes[at + 1] << 8);
const u24le = (bytes, at) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
const u32be = (bytes, at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
const ascii = (bytes, at, length) => String.fromCharCode(...bytes.subarray(at, at + length));

/** An upload's format and size, read from its header bytes: a PNG (an APNG
 *  counts as animated), a GIF (always treated as animated) or a WebP; null
 *  for anything else — SVG and every other markup included. */
export function avatarImageInfo(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 30) return null;
  if (u32be(bytes, 0) === 0x89504e47 && u32be(bytes, 4) === 0x0d0a1a0a && ascii(bytes, 12, 4) === 'IHDR') {
    let animated = false;
    for (let at = 8; at + 8 <= bytes.length; at += 12 + u32be(bytes, at)) {
      const type = ascii(bytes, at + 4, 4);
      if (type === 'acTL') animated = true;
      if (type === 'IDAT' || type === 'IEND') break;
    }
    return { format: 'png', width: u32be(bytes, 16), height: u32be(bytes, 20), animated };
  }
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') {
    return { format: 'gif', width: u16le(bytes, 6), height: u16le(bytes, 8), animated: true };
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === 'VP8X') {
      const animated = (bytes[20] & 0x02) !== 0;
      return { format: 'webp', width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1, animated };
    }
    if (chunk === 'VP8 ') {
      return { format: 'webp', width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff, animated: false };
    }
    if (chunk === 'VP8L') {
      const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
      return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, animated: false };
    }
  }
  return null;
}

/** Why bytes cannot be a state image ('' when they can): not a PNG, GIF or
 *  WebP, over 1 MB, not square, or over 512px. */
export function agentAvatarImageProblem(bytes) {
  const info = avatarImageInfo(bytes);
  if (!info) return 'must be a PNG, GIF or WebP image';
  if (bytes.length > AGENT_AVATAR_IMAGE_MAX_BYTES) return 'is larger than 1 MB';
  if (!info.width || info.width !== info.height) return 'must be square';
  if (info.width > AGENT_AVATAR_IMAGE_MAX_SIDE) return 'must be 512px or smaller';
  return '';
}

function normalizeCustom(states) {
  if (!states || typeof states !== 'object') return null;
  const kept = {};
  for (const state of AGENT_AVATAR_STATES) {
    const file = states[state];
    if (file == null) continue;
    const own = typeof file === 'string' && AGENT_AVATAR_STATE_FILE.test(file) && file.startsWith(`${state}-`);
    const legacy = state === 'idle' && typeof file === 'string' && AGENT_AVATAR_IMAGE_FILE.test(file);
    if (!own && !legacy) return null;
    kept[state] = file;
  }
  return kept.idle ? { kind: 'custom', states: kept } : null;
}

const pick = (value, list, fallback) => (value == null ? fallback : list.includes(value) ? value : null);

/** A stored avatar as the app understands it, or null when it is not one. An
 *  older single image reads as a custom avatar with only its idle image; an
 *  older mascot `variant` as its mapped species, accessory and expression. */
export function normalizeAgentAvatar(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.kind === 'image') {
    return typeof value.file === 'string' && AGENT_AVATAR_IMAGE_FILE.test(value.file)
      ? { kind: 'custom', states: { idle: value.file } }
      : null;
  }
  if (value.kind === 'custom') return normalizeCustom(value.states);
  if (value.kind !== 'mascot') return null;
  const color = typeof value.color === 'string' ? value.color.toLowerCase() : '';
  if (!AGENT_AVATAR_COLORS.includes(color)) return null;
  const look =
    value.species == null && typeof value.variant === 'string'
      ? mascotFromVariant(value.variant)
      : {
          species: pick(
            RETIRED_SPECIES[value.species] ?? value.species,
            [...MASCOT_SPECIES, MIXY_AVATAR.species],
            null
          ),
          accessory: pick(RETIRED_ACCESSORIES[value.accessory] ?? value.accessory, MASCOT_ACCESSORIES, 'none'),
          expression: pick(value.expression, MASCOT_EXPRESSIONS, 'calm'),
        };
  if (!look?.species || !look.accessory || !look.expression) return null;
  return { kind: 'mascot', ...look, color };
}

// FNV-1a: a small stable string hash, the same on every platform.
function hashId(id) {
  let hash = 0x811c9dc5;
  for (const char of String(id)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The look of an agent that never picked one: fixed by its id — the
 *  species, accessory and colour it had before species existed (its old
 *  variant, mapped), with the neutral face every default wears. */
export function defaultAgentAvatar(id) {
  const hash = hashId(id);
  return {
    kind: 'mascot',
    ...mascotFromVariant(LEGACY_VARIANTS[hash % LEGACY_VARIANTS.length]),
    expression: 'calm',
    color: AGENT_AVATAR_COLORS[Math.floor(hash / LEGACY_VARIANTS.length) % AGENT_AVATAR_COLORS.length],
  };
}

/** What an agent shows: its own images, else Mixy's fixed look (for Mixy),
 *  its own mascot pick, or its id default. */
export function agentAvatar(id, stored) {
  const own = normalizeAgentAvatar(stored);
  if (id === MIXY_AGENT_ID) return own ?? { ...MIXY_AVATAR };
  return own ?? defaultAgentAvatar(id);
}
