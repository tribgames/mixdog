import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync, crc32 } from 'node:zlib';
import {
  AGENT_AVATAR_COLORS,
  AGENT_AVATAR_STATES,
  MASCOT_ACCESSORIES,
  MASCOT_EXPRESSIONS,
  MASCOT_INKS,
  MASCOT_SPECIES,
  MIXY_AVATAR,
  agentAvatar,
  agentAvatarImageProblem,
  agentAvatarStatePath,
  avatarImageInfo,
  avatarPosterFile,
  cellPaths,
  customAvatarStateFile,
  defaultAgentAvatar,
  mascotCells,
  mascotFromVariant,
  mascotParts,
  normalizeAgentAvatar,
  shadeHex,
} from './agent-avatar.mjs';
import { MASCOT_SPRITES } from './agent-avatar-sprites.mjs';

const count = (cells, fill) => cells.filter((cell) => cell.fill === fill).length;
const key = ({ x, y }) => `${x},${y}`;
const look = (species, accessory = 'none', expression = 'calm', color = '#e6e6e6') => ({
  kind: 'mascot',
  species,
  accessory,
  expression,
  color,
});

// The renderer before species existed, kept verbatim as the reference every
// stored `variant` must still match.
const OLD_PUP = [
  '................',
  '................',
  '...##########...',
  '...##########...',
  '...##########...',
  '...##########...',
  '...##########...',
  '...##########.#.',
  '...############.',
  '...##########...',
  '...#.#....#.#...',
  '...#.#....#.#...',
];
const OLD_EARS = {
  floppy: '3,1 3,2 4,1 4,2 5,1 5,2 6,1 6,2 3,13 3,14 4,13 4,14 5,13 5,14 6,13 6,14',
  perky: '0,3 0,2 0,12 0,13 1,3 1,4 1,11 1,12',
  folded: '1,3 1,4 1,5 1,10 1,11 1,12 2,2 2,13 3,2 3,13',
};
const OLD_FACES = { calm: '4,5 5,5 4,10 5,10', happy: '4,5 5,4 5,6 4,10 5,9 5,11' };
const OLD_VARIANTS = ['floppy', 'perky', 'folded'].flatMap((ears) =>
  ['calm', 'happy'].flatMap((face) => ['plain', 'collar'].map((extra) => `${ears}-${face}-${extra}`))
);
function oldCells(variant, color) {
  const [ears, face, extra] = variant.split('-');
  const cells = new Map();
  OLD_PUP.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) if (row[x] === '#') cells.set(`${x},${y}`, color);
  });
  const paint = (list, fill) => {
    for (const [y, x] of list.split(' ').map((pair) => pair.split(',').map(Number))) cells.set(`${x},${y}`, fill);
  };
  paint(OLD_EARS[ears], shadeHex(color, 0.7));
  if (extra === 'collar') {
    paint('8,3 8,4 8,5 8,6 8,7 8,8 8,9 8,10 8,11 8,12', '#e5534b');
    paint('9,7 9,8', '#f2c94c');
  }
  paint(OLD_FACES[face], '#141414');
  paint('6,7 6,8', '#141414');
  return cells;
}
// The old id default: FNV-1a over the id, then variant and colour.
function oldDefault(id) {
  let hash = 0x811c9dc5;
  for (const char of id) hash = Math.imul(hash ^ char.codePointAt(0), 0x01000193) >>> 0;
  return { variant: OLD_VARIANTS[hash % 12], color: AGENT_AVATAR_COLORS[Math.floor(hash / 12) % 10] };
}

test('every sprite layer is a 16x12 string grid of known colour keys', () => {
  const keys = new Set(['.', 'B', 'D', 'L', 'E', ...Object.keys(MASCOT_INKS)]);
  const layers = [
    ['body', MASCOT_SPRITES.body],
    ...Object.entries(MASCOT_SPRITES.tails).map(([name, rows]) => [`tail ${name}`, rows]),
    ...Object.entries(MASCOT_SPRITES.legs).map(([name, rows]) => [`legs ${name}`, rows]),
    ...Object.entries(MASCOT_SPRITES.eyes).map(([name, rows]) => [`eyes ${name}`, rows]),
    ...Object.entries(MASCOT_SPRITES.accessories).map(([name, rows]) => [`accessory ${name}`, rows]),
    ...Object.entries(MASCOT_SPRITES.species).flatMap(([name, species]) => [
      [`${name} ears`, species.ears],
      [`${name} marks`, species.marks],
    ]),
  ];
  for (const [name, rows] of layers) {
    assert.equal(rows.length, 12, name);
    for (const row of rows) {
      assert.equal(row.length, 16, name);
      assert.ok(
        [...row].every((c) => keys.has(c)),
        `${name}: ${row}`
      );
    }
  }
  for (const [name, species] of Object.entries(MASCOT_SPRITES.species)) {
    assert.ok(species.tail === null || MASCOT_SPRITES.tails[species.tail], name);
    assert.ok(MASCOT_SPRITES.legs[species.legs], name);
    assert.ok(MASCOT_INKS[species.eye], name);
  }
  assert.deepEqual(Object.keys(MASCOT_SPRITES.accessories).sort(), MASCOT_ACCESSORIES.slice(1).sort());
});

test('a look is layered parts: tail and legs outside the bob, eyes with a blink, the accessory on top', () => {
  const parts = mascotParts(look('labrador', 'collar', 'happy', '#5b9bff'));
  assert.deepEqual(Object.keys(parts), ['tail', 'legs', 'body', 'ear', 'marks', 'eyes', 'blink', 'accessory']);
  assert.ok(
    parts.legs.every(({ y }) => y >= 10),
    'the legs stay put while the body bobs'
  );
  assert.ok(parts.body.every(({ y }) => y >= 2 && y <= 9));
  assert.ok(parts.eyes.every(({ fill }) => fill === '#141414'));
  assert.notDeepEqual(parts.blink.map(key), parts.eyes.map(key), 'the blink closes the eyes');
  assert.ok(parts.ear.every(({ fill }) => fill === shadeHex('#5b9bff', 0.7)));
  const cells = mascotCells(look('labrador', 'collar', 'happy', '#5b9bff'));
  assert.equal(new Set(cells.map(key)).size, cells.length, 'one fill per cell');
  assert.equal(cells.find(({ x, y }) => x === 7 && y === 8).fill, '#e5534b', 'the accessory paints over the body');
  // Every species, accessory and expression draws inside the grid.
  for (const species of [...MASCOT_SPECIES, 'mixy']) {
    for (const accessory of MASCOT_ACCESSORIES) {
      for (const expression of MASCOT_EXPRESSIONS) {
        const drawn = mascotCells(look(species, accessory, expression));
        assert.ok(drawn.length > 80, `${species}-${accessory}-${expression}`);
        assert.ok(drawn.every(({ x, y }) => x >= 0 && x < 16 && y >= 0 && y < 12));
      }
    }
  }
  assert.equal(mascotParts(look('nope')), null);
  assert.deepEqual(mascotCells(look('nope')), []);
});

test("Mixy's signature: both ears down, a low thick tail with a lighter tip, a slate collar and the gold star medal between the legs", () => {
  const parts = mascotParts(MIXY_AVATAR);
  const left = parts.ear.filter(({ x }) => x < 8).map(({ x, y }) => `${15 - x},${y}`);
  const right = parts.ear.filter(({ x }) => x >= 8).map(key);
  assert.deepEqual(left.sort(), right.sort(), 'the ears mirror each other');
  assert.ok(
    parts.ear.every(({ y }) => y >= 3),
    'both ears hang beside the head'
  );
  assert.deepEqual(parts.tail.map(key).sort(), ['13,8', '13,9', '14,8', '14,9'], 'a 2x2 tail low on the body');
  assert.ok(
    parts.tail.every(({ x, y }) => !parts.ear.some((ear) => ear.x === x && Math.abs(ear.y - y) <= 1)),
    'the tail stays clear of the ear'
  );
  assert.deepEqual(
    parts.tail
      .filter(({ fill }) => fill !== MIXY_AVATAR.color)
      .map(key)
      .sort(),
    ['14,8', '14,9'],
    'only the tip is lighter'
  );
  const medal = parts.marks.filter(({ fill }) => fill === '#f2c94c');
  assert.equal(medal.length, 8);
  assert.ok(
    medal.every(({ x }) => x >= 6 && x <= 9),
    'between the legs (columns 6–9)'
  );
  assert.equal(parts.marks.filter(({ fill }) => fill === MASCOT_INKS.S).length, 10, 'the slate collar');
  for (const species of MASCOT_SPECIES) {
    assert.equal(count(mascotCells(look(species)), '#f2c94c'), 0, `${species} carries no medal`);
  }
});

test('cellPaths draws exactly the cells, one path per fill, each row run one rectangle', () => {
  const cells = mascotCells(look('husky', 'glasses', 'wink', '#9b7bff'));
  const paths = cellPaths(cells);
  assert.equal(new Set(paths.map(({ fill }) => fill)).size, paths.length);
  const drawn = [];
  for (const { fill, d } of paths) {
    for (const [, x, y, w] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      for (let i = 0; i < Number(w); i += 1) drawn.push(`${Number(x) + i},${y}:${fill}`);
    }
  }
  assert.deepEqual(drawn.sort(), cells.map((cell) => `${key(cell)}:${cell.fill}`).sort());
  assert.match(
    cellPaths([
      { x: 3, y: 2, fill: '#fff' },
      { x: 4, y: 2, fill: '#fff' },
    ])[0].d,
    /^M3 2h2v1h-2z$/
  );
});

test('every stored variant reads as its mapped look and renders the same pixels', () => {
  assert.deepEqual(mascotFromVariant('floppy-happy-plain'), {
    species: 'labrador',
    accessory: 'none',
    expression: 'happy',
  });
  assert.deepEqual(mascotFromVariant('perky-calm-collar'), {
    species: 'shepherd',
    accessory: 'collar',
    expression: 'calm',
  });
  assert.deepEqual(mascotFromVariant('folded-happy-plain').species, 'terrier');
  assert.equal(mascotFromVariant('nope'), null);
  for (const variant of OLD_VARIANTS) {
    for (const color of AGENT_AVATAR_COLORS) {
      const stored = normalizeAgentAvatar({ kind: 'mascot', variant, color });
      assert.equal(stored.kind, 'mascot');
      const before = oldCells(variant, color);
      const after = new Map(mascotCells(stored).map((cell) => [key(cell), cell.fill]));
      assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `${variant}: the same silhouette`);
      // The labrador is the old floppy pup cell for cell; the shepherd and
      // terrier add only their species marks inside the same silhouette.
      const marks = new Set(mascotParts(stored).marks.map(key));
      for (const [cell, fill] of before) {
        if (!marks.has(cell)) assert.equal(after.get(cell), fill, `${variant} ${color} ${cell}`);
      }
      if (variant.startsWith('floppy')) assert.deepEqual(after, before);
    }
  }
});

test('an agent without an avatar keeps the look its id gave it before, mapped, with a neutral face', () => {
  for (const id of ['github-watcher', 'worker', 'reviewer', 'writer', 'advisor', 'security', 'release', 'bench']) {
    const old = oldDefault(id);
    assert.deepEqual(
      defaultAgentAvatar(id),
      { ...normalizeAgentAvatar({ kind: 'mascot', ...old }), expression: 'calm' },
      id
    );
    assert.deepEqual(agentAvatar(id, undefined), defaultAgentAvatar(id));
  }
  const looks = new Set(
    ['worker', 'reviewer', 'writer', 'advisor'].map((id) => JSON.stringify(defaultAgentAvatar(id)))
  );
  assert.ok(looks.size > 1, 'ids spread over the looks and colours');
});

test('normalisation: the new shape, the old variant, junk; Mixy defaults to its own look', () => {
  const pick = look('corgi', 'bow', 'wink', '#5b9bff');
  assert.deepEqual(normalizeAgentAvatar({ ...pick, color: '#5B9BFF' }), pick);
  assert.deepEqual(
    normalizeAgentAvatar({ kind: 'mascot', species: 'corgi', color: '#f2c94c' }),
    look('corgi', 'none', 'calm', '#f2c94c')
  );
  for (const companion of ['cat', 'bird', 'robot']) {
    assert.deepEqual(
      normalizeAgentAvatar({
        kind: 'mascot',
        species: companion,
        accessory: 'bow',
        expression: 'sleepy',
        color: '#ef6fb0',
      }),
      look('labrador', 'bow', 'sleepy', '#ef6fb0'),
      `${companion} reads as a labrador, everything else kept`
    );
  }
  assert.deepEqual(normalizeAgentAvatar({ kind: 'mascot', variant: 'perky-calm-collar', color: '#5b9bff' }), {
    kind: 'mascot',
    species: 'shepherd',
    accessory: 'collar',
    expression: 'calm',
    color: '#5b9bff',
  });
  // Removed picks read as their nearest remaining option, colour kept.
  assert.deepEqual(
    normalizeAgentAvatar({
      kind: 'mascot',
      species: 'dalmatian',
      accessory: 'headset',
      expression: 'wink',
      color: '#9B7BFF',
    }),
    look('labrador', 'glasses', 'wink', '#9b7bff')
  );
  assert.deepEqual(
    normalizeAgentAvatar({
      kind: 'mascot',
      species: 'husky',
      accessory: 'headset',
      expression: 'calm',
      color: '#3fc1c9',
    }),
    look('husky', 'glasses', 'calm', '#3fc1c9')
  );
  for (const junk of [
    { ...pick, color: '#123456' },
    { ...pick, species: 'dragon' },
    { ...pick, accessory: 'crown' },
    { ...pick, expression: 'angry' },
    { kind: 'mascot', variant: 'nope', color: '#5b9bff' },
    { kind: 'mascot' },
    { kind: 'svg', file: 'x.svg' },
    'mascot',
    null,
  ]) {
    assert.equal(normalizeAgentAvatar(junk), null, JSON.stringify(junk));
  }
  // Mixy's own species round-trips with its accessory and colour (the picker's 기본).
  const dressed = { kind: 'mascot', species: 'mixy', accessory: 'scarf', expression: 'happy', color: '#5b9bff' };
  assert.deepEqual(normalizeAgentAvatar(dressed), dressed);
  assert.deepEqual(agentAvatar('lead', dressed), dressed);
  assert.deepEqual(agentAvatar('watcher', pick), pick);
  assert.deepEqual(agentAvatar('watcher', { ...pick, species: 'x' }), defaultAgentAvatar('watcher'));
  assert.deepEqual(agentAvatar('lead', pick), pick, 'Mixy can wear another look');
  assert.deepEqual(agentAvatar('lead', null), MIXY_AVATAR, 'its own look is the default');
  const own = { kind: 'custom', states: { idle: 'idle-0123456789ab.gif' } };
  assert.deepEqual(agentAvatar('lead', own), own, 'Mixy shows uploaded images');
});

test('custom avatars: idle is required, names match their state, and the old single image migrates to idle', () => {
  const states = {
    idle: 'idle-0123456789ab.gif',
    typing: 'typing-0123456789ab.png',
    message: 'message-abcdefabcdef.webp',
  };
  assert.deepEqual(normalizeAgentAvatar({ kind: 'custom', states }), { kind: 'custom', states });
  assert.deepEqual(normalizeAgentAvatar({ kind: 'custom', states: { idle: states.idle, later: 'x' } }), {
    kind: 'custom',
    states: { idle: states.idle },
  });
  assert.equal(normalizeAgentAvatar({ kind: 'custom', states: { typing: states.typing } }), null, 'no idle');
  assert.equal(normalizeAgentAvatar({ kind: 'custom', states: { idle: 'typing-0123456789ab.png' } }), null);
  assert.equal(normalizeAgentAvatar({ kind: 'custom', states: { idle: 'idle-0123456789ab.svg' } }), null);
  assert.equal(normalizeAgentAvatar({ kind: 'custom', states: { idle: '../idle-0123456789ab.png' } }), null);
  assert.equal(
    normalizeAgentAvatar({ kind: 'custom', states: { idle: states.idle, typing: 'avatar-0123456789ab.png' } }),
    null
  );
  assert.equal(normalizeAgentAvatar({ kind: 'custom' }), null);
  // The single image of before: its idle image, read where it always lay.
  assert.deepEqual(normalizeAgentAvatar({ kind: 'image', file: 'avatar-0123456789ab.png' }), {
    kind: 'custom',
    states: { idle: 'avatar-0123456789ab.png' },
  });
  assert.equal(normalizeAgentAvatar({ kind: 'image', file: 'avatar.svg' }), null);
  assert.equal(agentAvatarStatePath('avatar-0123456789ab.png'), 'avatar-0123456789ab.png');
  assert.equal(agentAvatarStatePath('idle-0123456789ab.gif'), 'avatar/idle-0123456789ab.gif');
  assert.equal(avatarPosterFile('idle-0123456789ab.gif'), 'idle-0123456789ab.poster.png');
  // A missing state falls back to idle.
  const onlyIdle = { kind: 'custom', states: { idle: states.idle } };
  for (const state of AGENT_AVATAR_STATES) assert.equal(customAvatarStateFile(onlyIdle, state), states.idle);
  assert.equal(customAvatarStateFile({ kind: 'custom', states }, 'typing'), states.typing);
});

/** A real PNG of `side`², optionally with an APNG `acTL` chunk. */
function png(width, height = width, animated = false) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...(animated ? [chunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]))] : []),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('uploads are read by their bytes: PNG, APNG, GIF and WebP pass; SVG, other formats and odd sizes do not', () => {
  assert.deepEqual(avatarImageInfo(png(64)), { format: 'png', width: 64, height: 64, animated: false });
  assert.deepEqual(avatarImageInfo(png(64, 64, true)), { format: 'png', width: 64, height: 64, animated: true });
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x80, 0, 0x80, 0]), Buffer.alloc(30)]);
  assert.deepEqual(avatarImageInfo(gif), { format: 'gif', width: 128, height: 128, animated: true });
  const vp8x = Buffer.alloc(40);
  vp8x.write('RIFF', 0);
  vp8x.write('WEBP', 8);
  vp8x.write('VP8X', 12);
  vp8x[20] = 0x02;
  vp8x.writeUIntLE(255, 24, 3);
  vp8x.writeUIntLE(255, 27, 3);
  assert.deepEqual(avatarImageInfo(vp8x), { format: 'webp', width: 256, height: 256, animated: true });
  const vp8l = Buffer.alloc(40);
  vp8l.write('RIFF', 0);
  vp8l.write('WEBP', 8);
  vp8l.write('VP8L', 12);
  vp8l.writeUInt32LE((99 << 14) | 99, 21);
  assert.deepEqual(avatarImageInfo(vp8l), { format: 'webp', width: 100, height: 100, animated: false });
  assert.equal(avatarImageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>')), null);
  assert.equal(avatarImageInfo(Buffer.from([0xff, 0xd8, 0xff, ...Buffer.alloc(40)])), null, 'JPEG is rasterised first');

  assert.equal(agentAvatarImageProblem(png(256)), '');
  assert.equal(agentAvatarImageProblem(png(512, 512, true)), '');
  assert.match(agentAvatarImageProblem(Buffer.from('<svg/>'.padEnd(64))), /PNG, GIF or WebP/);
  assert.match(agentAvatarImageProblem(png(300, 200)), /square/);
  assert.match(agentAvatarImageProblem(png(600)), /512px/);
  assert.match(agentAvatarImageProblem(Buffer.concat([png(64), Buffer.alloc(1024 * 1024)])), /1 MB/);
});
