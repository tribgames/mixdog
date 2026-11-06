#!/usr/bin/env node
// Golden twin of the output styles: what Node's `outputStyleStatus` (the style catalog of the
// shipped and the user directory, the configured style), `findOutputStyle` (what
// `setOutputStyle` selects) and `configWithOutputStyle` (what it stores) answer over 40
// deterministic style directories and configs.
//
//   node benchmarks/rust-core/recorders/record-output-styles.mjs --tree <dir>
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { outputStyleStatus, findOutputStyle, listOutputStyleCatalog } = await importFrom(tree, 'src/session-runtime/output-styles.mjs');
const { configWithOutputStyle } = await importFrom(tree, 'src/session-runtime/config-lifecycle/config-writers.mjs');

let seed = 0x5171e5;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;

const front = (lines, body = 'Body.\n') => `---\n${lines.join('\n')}\n---\n${body}`;
const FILES = [
  ['detailed.md', front(['description: Deep answers', 'aliases: long, full'])],
  ['simple.md', front(['title: Simple', 'description: "Plain answers"'])],
  ['minimal.md', front(["description: 'Short'", 'aliases: Mini , tiny_one'])],
  ['extreme-minimal.md', front(['label: Extreme Minimal', 'aliases: xmin'])],
  ['common.md', front(['description: shared'])],
  ['hidden.md', front(['partial: true'])],
  ['hidden-yes.md', front(['partial: YES'])],
  ['named.md', front(['name: Renamed_Style', 'title: The Renamed'])],
  ['Foo_Bar.MD', front(['description: upper case file'])],
  ['crlf.md', '---\r\ntitle: Crlf Style\r\ndescription:   spaced   \r\n---\r\nBody\r\n'],
  ['plain.md', 'No frontmatter at all.\n'],
  ['bad!!.md', front(['description: unusable id'])],
  ['dots.v2.md', front(['aliases: dotted,, ,Dot_Two'])],
  ['zeta.md', front(['title: zeta'])],
  ['Alpha.md', front(['title: Alpha'])],
  ['alpha2.md', front(['title: alpha'])],
  ['empty-title.md', front(['title:', 'label: From Label'])],
  ['notes.txt', 'not a style'],
  ['unclosed.md', '---\ntitle: Never closed\n'],
];
const QUERIES = ['detailed', 'Simple', ' MINIMAL ', 'extreme minimal', 'EXTREME_minimal', 'extrememinimal', 'xmin', 'long', 'mini', 'tiny', 'tinyone', 'renamed-style', 'The Renamed', 'foo bar', 'foo_bar', 'crlf style', 'dotted', 'dot two', 'from label', 'common', 'hidden', 'plain', '', '   ', '---', 'nope', 'x y'];
const CONFIGURED = [undefined, undefined, '', ' detailed ', 'nonexistent', 'Simple', 'xmin', 5, '---', 'Extreme_Minimal'];

const dir = mkdtempSync(join(tmpdir(), 'output-styles-'));
const entries = [];
for (let i = 0; i < 40; i += 1) {
  const root = join(dir, `w${i}`, 'root');
  const data = join(dir, `w${i}`, 'data');
  const world = { builtin: {}, user: {} };
  for (const [side, chanceOf] of [['builtin', 0.7], ['user', 0.4]]) {
    const base = side === 'builtin' ? join(root, 'output-styles') : join(data, 'output-styles');
    mkdirSync(base, { recursive: true });
    for (const [name, text] of FILES) {
      if (i % 8 === 0 && side === 'user') break; // a user dir without styles
      if (!chance(chanceOf)) continue;
      world[side][name] = text;
      writeFileSync(join(base, name), text);
    }
  }
  const config = {};
  const configured = pick(CONFIGURED);
  if (configured !== undefined) config.outputStyle = configured;
  if (chance(0.3)) config.agent = { outputStyle: 'minimal', keep: 1 };
  if (chance(0.5)) config.desktop = { zoom: 1 };
  writeFileSync(join(data, 'mixdog-config.json'), JSON.stringify(config));
  const status = outputStyleStatus(root, data, { fresh: true });
  const styles = listOutputStyleCatalog(root, data, { fresh: true });
  const queries = QUERIES.filter(() => chance(0.5)).map((value) => {
    const selected = findOutputStyle(value, styles);
    return { value, selected: selected ? selected.id : null, stored: selected ? configWithOutputStyle(config, selected.id) : null };
  });
  entries.push({ world, config, status, queries });
}

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'output-styles-twin.json'), {
  domain: 'output-styles-twin',
  recorder: 'benchmarks/rust-core/recorders/record-output-styles.mjs',
  entries,
});
console.log(`recorded ${entries.length} output style worlds`);
