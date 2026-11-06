// Records, from today's Node product, the skill list a sample setup produces: `collectSkills()`
// over the global folder, the enabled registered plugins and the package bundle (`<root>/defaults`),
// and what `collectPromptSkillsCached(cwd)` offers a session at three folders, under two configs.
// The fixture tree is written by this script and stored in the output (`fixtures`, with `{base}`
// where the run's folder goes); the Rust replay recreates it. Paths are masked to `{base}`.
// Usage: node skilllist.mjs <repo-root> <base-dir> <out.json>
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const doc = (name, description, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nBody.\n`;
const requires = (list) => `metadata:\n  requires: ${list}\n`;
const fixtures = {
  'data/skills/alpha/SKILL.md': doc('alpha', 'Use when alpha (global).'),
  'data/skills/beta/SKILL.md': doc('beta', 'Use when beta.', 'when_to_use: Beta trigger\n'),
  'data/skills/gamma/SKILL.md': doc('gamma', 'Use when gamma.'),
  'data/skills/wrongname/SKILL.md': doc('other-name', 'Folder differs.'),
  'data/skills/emptied/SKILL.md': '',
  'data/skills/nested/deep/inner/SKILL.md': doc('inner', 'Use when nested.'),
  'data/skills/needs-git/SKILL.md': doc('needs-git', 'Needs git.', requires('git')),
  'data/skills/needs-office/SKILL.md': doc('needs-office', 'Needs office.', requires('[office, webSearch]')),
  'data/plugins/registry.json': JSON.stringify({
    plugins: [
      { id: 'plug-a', root: '{base}/plugins/a', enabled: true },
      { id: 'plug-off', root: '{base}/plugins/off', enabled: false },
      { name: 'plug-name', root: '{base}/plugins/named' },
      { id: 'plug-gone', root: '{base}/plugins/gone' },
      { id: 'plug-manifest', root: '{base}/plugins/manifest' },
    ],
  }),
  'plugins/a/skills/alpha/SKILL.md': doc('alpha', 'Plugin alpha (shadowed by the global one).'),
  'plugins/a/skills/topic/sub/SKILL.md': doc('plugin-topic', 'Use when topic (nested plugin layout).'),
  'plugins/off/skills/off-skill/SKILL.md': doc('off-skill', 'Disabled plugin.'),
  'plugins/named/skills/named-skill/SKILL.md': doc('named-skill', 'Plugin known by name only.'),
  'plugins/manifest/plugin.json': JSON.stringify({ skills: ['./extra/', '../escape', '/abs', ''] }),
  'plugins/manifest/skills/own/SKILL.md': doc('own', 'Conventional root.'),
  'plugins/manifest/extra/more/SKILL.md': doc('more', 'Manifest root.'),
  'package/defaults/plugin.json': JSON.stringify({ name: 'mixdog-defaults' }),
  'package/defaults/skills/bundled/SKILL.md': doc('bundled', 'Use when bundled.'),
  'package/defaults/skills/alpha/SKILL.md': doc('alpha', 'Bundled alpha (shadowed).'),
  'package/defaults/skills/bundled-git/SKILL.md': doc('bundled-git', 'Bundled, needs git.', requires('git')),
};
const configs = [
  {
    name: 'partial-builtins',
    agent: {
      skills: { disabled: [' Beta ', 'OWN'] },
      builtins: { git: { installed: true }, office: { installed: false } },
      extensionScopes: { skills: { gamma: ['{base}/proj1'] }, plugins: { 'plug-a': ['{base}/proj2'] } },
    },
  },
  { name: 'grandfathered', agent: { skills: { disabled: [] } } },
];

const [root, base, out] = process.argv.slice(2, 5);
const scenario = process.argv[5];
const sub = (text) => text.replaceAll('{base}', base.replaceAll('\\', '/'));
const mask = (path) => String(path).replaceAll('\\', '/').replace(base.replaceAll('\\', '/'), '{base}');

if (scenario === undefined) {
  rmSync(base, { recursive: true, force: true });
  const results = configs.map((_, i) => {
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), root, base, out, String(i)], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
    return JSON.parse(run.stdout);
  });
  writeFileSync(out, `${JSON.stringify({ fixtures, configs: configs.map(({ name, agent }) => ({ name, agent })), results }, null, 2)}\n`);
} else {
  for (const [rel, text] of Object.entries(fixtures)) {
    const path = join(base, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, sub(text));
  }
  for (const dir of ['proj1/sub', 'proj2', 'elsewhere']) mkdirSync(join(base, dir), { recursive: true });
  const config = configs[Number(scenario)];
  writeFileSync(join(base, 'data', 'mixdog-config.json'), sub(JSON.stringify({ defaultsVersion: 2, agent: config.agent })));
  process.env.MIXDOG_HOME = join(base, 'home');
  process.env.MIXDOG_DATA_DIR = join(base, 'data');
  delete process.env.MIXDOG_DISABLE_SKILLS;
  for (const name of Object.keys(process.env)) if (name.startsWith('MIXDOG_FEATURE_')) delete process.env[name];
  // The package root is read per call by the skill catalog but at load by the internal agents,
  // which need the product's own defaults/agents.json: point it at the fixture only afterwards.
  delete process.env.MIXDOG_ROOT;
  const catalog = await import(pathToFileURL(join(root, 'src/runtime/agent/orchestrator/context/skill-catalog.mjs')).href);
  process.env.MIXDOG_ROOT = join(base, 'package');
  const all = catalog.collectSkills(null).map((s) => ({
    name: s.name, description: s.description, whenToUse: s.whenToUse, path: mask(s.filePath), source: s.source, plugin: s.plugin, requires: s.requires,
  }));
  const cwds = { inProj1: join(base, 'proj1', 'sub'), inProj2: join(base, 'proj2'), elsewhere: join(base, 'elsewhere') };
  const visible = Object.fromEntries(Object.entries(cwds).map(([key, cwd]) => [key, catalog.collectPromptSkillsCached(cwd).map((s) => s.name)]));
  process.stdout.write(JSON.stringify({ name: config.name, all, visible }));
}
