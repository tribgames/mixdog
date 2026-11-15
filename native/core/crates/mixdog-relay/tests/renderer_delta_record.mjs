// Records what the Node renderer-delta tool writes, for tests/tool_renderer_delta.rs.
// Run: node renderer_delta_record.mjs <apps/relay/deploy directory of a Node checkout> <scratch directory>
// It prints one JSON object (the Rust test embeds it as tests/fixtures/renderer-delta.recording.json): a base tree and a
// current tree (path -> base64), the manifest line Node prints for each, the manifest file and result `create` produces, the
// files of the delta, and the result of applying it plain and with hardlinks.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [deploy, scratch] = process.argv.slice(2);
const mod = await import(pathToFileURL(join(deploy, 'renderer-delta.mjs')).href);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

const bytes = (text) => Buffer.from(text, 'utf8');
// Names chosen to separate localeCompare from byte order: case, punctuation, digits, a non-ASCII letter, a space.
const base = {
  'index.html': bytes('<html>base</html>'),
  'B.js': bytes('B'),
  'a.js': bytes('a'),
  'a-b.js': bytes('a-b'),
  'a_b.js': bytes('a_b'),
  'a b.js': bytes('a b'),
  'assets/x.css': bytes('x'),
  'Docs/y.css': bytes('y'),
  'assets/removed.css': bytes('gone'),
  'z/\u00e9.js': bytes('accent'),
  'z/e.js': bytes('plain'),
  'file10.js': bytes('ten'),
  'file2.js': bytes('two'),
  'bin.dat': Buffer.from([0, 1, 2, 255, 254, 0]),
};
const current = { ...base };
delete current['assets/removed.css'];
current['index.html'] = bytes('<html>current</html>');
current['assets/new.css'] = bytes('new');
current['z/\u00e9.js'] = bytes('accent two');

function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
}
function read(root, dir = root, out = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) read(root, path, out);
    else out[path.slice(root.length + 1).split(sep).join('/')] = readFileSync(path).toString('base64');
  }
  return out;
}
const encode = (files) => Object.fromEntries(Object.entries(files).map(([path, content]) => [path, content.toString('base64')]));

const dirs = Object.fromEntries(['base', 'current', 'delta', 'output', 'linked'].map((name) => [name, join(scratch, name)]));
write(dirs.base, base);
write(dirs.current, current);
const baseManifest = await mod.buildRendererManifest(dirs.base);
const currentManifest = await mod.buildRendererManifest(dirs.current);
const manifestPath = join(scratch, 'renderer-manifest.json');
const result = await mod.createRendererDelta({ root: dirs.current, baseManifest, deltaDir: dirs.delta, manifestPath });
const manifestFile = readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(manifestFile);
const applied = await mod.applyRendererDelta({ baseDir: dirs.base, deltaDir: dirs.delta, manifest, outputDir: dirs.output });
const linked = await mod.applyRendererDelta({
  baseDir: dirs.base,
  deltaDir: dirs.delta,
  manifest,
  outputDir: dirs.linked,
  hardlinkBase: true,
});
statSync(dirs.output);
process.stdout.write(
  `${JSON.stringify(
    {
      base: encode(base),
      current: encode(current),
      baseManifestLine: JSON.stringify(baseManifest),
      currentManifestLine: JSON.stringify(currentManifest),
      manifestFile,
      createResult: JSON.stringify(result),
      delta: read(dirs.delta),
      applyResult: JSON.stringify(applied),
      linkedResult: JSON.stringify(linked),
    },
    null,
    1
  )}\n`
);
