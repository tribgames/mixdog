#!/usr/bin/env node
// Golden twin of the real prompt sources (`mixdog-core` `prompt::real_sources`): what Node's
// outside loaders answer for a temp world of files. Each world is a list of files (the Rust test
// writes the same files into its own temp folder, the token `{ROOT}` standing for the folder),
// and each query is one loader call with Node's answer.
//
//   node benchmarks/rust-core/recorders/record-prompt-sources.mjs --tree <dir>
//
// Recorded on Windows (`process.platform === 'win32'`): the shell-tools line walks PATH with
// PATHEXT and the git line's paths carry backslashes. The git repository of a world is a bare
// `.git/HEAD` file, which is all Node reads for the branch; Node's `git status` / `git check-ignore`
// probes fail on it, which is the empty observation the Rust test passes.
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'prompt-sources');
const stage = stageSet(outDir);

const work = mkdtempSync(join(tmpdir(), 'prompt-sources-'));
const plugin = join(work, 'plugin');
for (const dir of ['rules', 'agents']) cpSync(join(tree, 'src', dir), join(plugin, dir), { recursive: true });
mkdirSync(join(plugin, 'defaults'), { recursive: true });
cpSync(join(tree, 'src', 'defaults', 'agents.json'), join(plugin, 'defaults', 'agents.json'));

const text = (path, body) => ({ path, text: body });
const bytes = (path, buffer) => ({ path, b64: buffer.toString('base64') });
const BIG = `${'word '.repeat(8000)}tail`;
const LONG_PERSONA = `${'p'.repeat(3990)}  ${'q'.repeat(30)}`;
const GIT_PATH = 'data/ws/repo';

const identityFiles = [
  text('data/agents/lead/AGENT.md', '---\nname: ignored\n---\nWork in small steps.\n'),
  text('data/agents/lead/agent.json', JSON.stringify({ name: '  Mia   Lee ', description: 'Greets.' })),
  text('data/agents/lead/PERSONA.md', 'Warm and brief.\n'),
  text('data/agents/ann/AGENT.md', '---\nname: ann\n---\nAnn researches questions.\n'),
  text('data/agents/ann/agent.json', JSON.stringify({ name: 'Ann', description: 'Handles research.  Careful。。' })),
  text('data/agents/ann/PERSONA.md', 'Precise.\n'),
  text('data/agents/longp/AGENT.md', 'Long persona holder.'),
  text('data/agents/longp/PERSONA.md', LONG_PERSONA),
  text('data/agents/flat.md', 'A flat file agent.'),
  text('data/agents/emptybody/AGENT.md', '---\nname: x\n---\n'),
  text('data/agents/worker/AGENT.md', 'User override of the worker.'),
  text('data/agents/nodesc/AGENT.md', 'No description agent.'),
  text('data/agents/nodesc/agent.json', '{"description": 5}'),
];
const workspace = [
  text(`${GIT_PATH}/.git/HEAD`, 'ref: refs/heads/feature/x\n'),
  text(`${GIT_PATH}/README.md`, '# r\n'),
  text(`${GIT_PATH}/src/main.rs`, 'fn main() {}\n'),
  text(`${GIT_PATH}/Zeta.txt`, 'z'),
  text(`${GIT_PATH}/alpha.txt`, 'a'),
  text(`${GIT_PATH}/Beta.txt`, 'b'),
  text(`${GIT_PATH}/docs/a.md`, 'd'),
  text(`${GIT_PATH}/_hidden/x`, 'x'),
  text('data/ws/detached/.git/HEAD', '0123456789abcdef0123456789abcdef01234567\n'),
  text('data/ws/detached/f.txt', 'f'),
  text('data/ws/gitonly/.git/HEAD', 'ref: refs/heads/main\n'),
  text('data/ws/plain/a.txt', 'a'),
  ...Array.from({ length: 45 }, (_, i) => text(`data/ws/many/file${String(i).padStart(2, '0')}.txt`, 'x')),
  text('data/ws/many/zdir/x', 'x'),
  text('data/ws/many/Adir/x', 'x'),
  text('data/ws/many/Adir2/x', 'x'),
  text('data/ws/many/adir3/x', 'x'),
  text('data/ws/empty/.keep', ''),
  text('data/ws/linked/.git', 'gitdir: ../linked-git\n'),
  text('data/linked-git/HEAD', 'ref: refs/heads/wt\n'),
  text('data/ws/linked/f', 'f'),
];
const bin = [text('bin/python.exe', ''), text('bin/node.exe', ''), text('bin/curl.cmd', ''), text('bin/git.exe', ''), text('winapps/WindowsApps/py.exe', ''), text('bin2/jq.exe', '')];
const homeFiles = [
  text('home/.codex/AGENTS.md', '\n\n  Global agents rules.  \n'),
  bytes('home/.claude/CLAUDE.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Global claude rules é.')])),
  text(`${GIT_PATH}/AGENTS.md`, 'Project agents rules.'),
  text(`${GIT_PATH}/CLAUDE.md`, 'Global agents rules.'),
  text('data/ws/big/AGENTS.md', BIG),
  bytes('data/ws/big/CLAUDE.md', Buffer.concat([Buffer.from('é'.repeat(16383)), Buffer.from([0xe2, 0x82])])),
  bytes('data/ws/plain/CLAUDE.md', Buffer.from([0x66, 0xff, 0x6f])),
];

const worlds = [
  { name: 'plain', files: [...identityFiles, ...workspace, ...bin, ...homeFiles] },
  {
    name: 'bot-store',
    files: [
      ...identityFiles,
      ...bin,
      text('data/bots/migration.json', JSON.stringify({ version: 1, bots: ['bob', 'ann'] })),
      text('data/bots/mixy/AGENT.md', 'Mixy as a bot.'),
      text('data/bots/mixy/agent.json', JSON.stringify({ name: 'Bot Mixy' })),
      text('data/bots/mixy/PERSONA.md', 'Bot persona.'),
      text('data/bots/bob/AGENT.md', 'Bob does things.'),
      text('data/bots/bob/agent.json', JSON.stringify({ name: 'Bob', description: 'Does things.' })),
      text('data/bots/bob/PERSONA.md', 'Bob persona.'),
      text('data/bots/ann/AGENT.md', 'Ann as a bot.'),
      text('data/bots/ann/agent.json', JSON.stringify({ name: 'Ann Bot', description: 'Bot ann.' })),
    ],
  },
];

function materialize(root, files) {
  for (const file of files) {
    const target = join(root, ...file.path.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, file.b64 ? Buffer.from(file.b64, 'base64') : file.text);
  }
}

const roles = await importFrom(tree, 'src/runtime/agent/orchestrator/context/role-instructions.mjs');
const caps = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin/runtime-capabilities.mjs');
const instr = await importFrom(tree, 'src/runtime/agent/orchestrator/context/instruction-files.mjs');
const scratch = await importFrom(tree, 'src/runtime/shared/session-scratch.mjs');

const recorded = [];
for (const world of worlds) {
  const root = join(work, world.name);
  mkdirSync(root, { recursive: true });
  materialize(root, world.files);
  process.env.MIXDOG_ROOT = plugin;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  process.env.MIXDOG_HOME = join(root, 'mixdog-home');
  process.env.USERPROFILE = join(root, 'home');
  process.env.HOME = join(root, 'home');
  roles.invalidateRoleInstructionsCache();
  const at = (rel) => join(root, ...rel.split('/'));
  const path = (...dirs) => dirs.map((d) => at(d)).join(';');
  const queries = [];
  const ask = (fn, args, answer) => queries.push({ fn, args, answer });
  for (const agent of [null, 'ann', 'longp', 'worker', 'title-agent', 'explore-agent', 'bob', 'lead', 'nodesc', 'missing']) {
    ask('roleCatalog', [agent], roles.loadScopedRoleInstructions(agent, 'anthropic'));
  }
  ask('mixyRoleSection', [], roles.composeSystemPrompt({ agent: 'lead', skipPersona: true }).sessionMarkerCore);
  for (const agent of ['lead', 'ann', 'longp', 'worker', 'bob', 'missing', 'bad..id', '../x', 'nodesc']) {
    ask('persona', [agent], roles.composeSystemPrompt({ agent, skipRoleCatalog: true }).sessionMarkerCore);
    ask('identity', [agent], roles.agentModeIdentityLine(agent));
  }
  for (const id of ['sess_a1', 'sess-b', 'bad id', '']) ask('scratch', [id], scratch.sessionScratchDir(id));
  for (const [label, dirs] of [['tools', ['bin', 'bin2']], ['stub', ['winapps/WindowsApps', 'bin']], ['none', []]]) {
    ask('shellTools', [dirs], caps.describeShellToolsStartupState({ pathValue: path(...dirs), platform: 'win32' }));
  }
  for (const [pathDirs, cwd] of [[['bin'], GIT_PATH], [['bin'], `${GIT_PATH}/src`], [['bin'], 'data/ws/detached'], [['bin'], 'data/ws/gitonly'], [['bin'], 'data/ws/linked'], [['bin'], 'data/ws/plain'], [[], GIT_PATH]]) {
    ask('git', [pathDirs, cwd], caps.describeGitStartupState({ cwd: at(cwd), pathValue: path(...pathDirs), platform: 'win32' }));
  }
  for (const cwd of [GIT_PATH, 'data/ws/many', 'data/ws/empty', 'data/ws/gitonly', 'data/ws/plain', 'data/ws/missing']) {
    ask('cwdEntries', [cwd], caps.describeCwdStartupEntries({ cwd: at(cwd) }));
  }
  for (const mode of ['all', 'agents', 'claude', 'off', undefined, 'bogus']) {
    for (const cwd of [GIT_PATH, 'data/ws/big', 'data/ws/plain', 'data/ws/missing', null]) {
      ask('instructionFiles', [mode ?? null, cwd], instr.loadInstructionFilesContext({ mode, cwd: cwd ? at(cwd) : undefined }));
    }
  }
  recorded.push({ name: world.name, files: world.files, queries });
}

// The data directory and world root are temp paths: the tests see the token.
const roots = worlds.map((w) => join(work, w.name));
let out = JSON.stringify({ worlds: recorded });
const escaped = (s) => s.replaceAll('\\', '\\\\');
for (const [index, root] of roots.entries()) {
  for (const variant of [escaped(root), root, root.replaceAll('\\', '/')]) out = out.split(variant).join(`{ROOT}`);
  void index;
}
writeJson(join(stage, 'sources.json'), JSON.parse(out));
writeSetManifest(stage, {
  set: 'prompt-sources',
  recorder: 'benchmarks/rust-core/recorders/record-prompt-sources.mjs',
  command: 'node benchmarks/rust-core/recorders/record-prompt-sources.mjs --tree <tree>',
  identityTree: tree,
});
commitStage(stage, outDir);
console.log(`prompt-sources: ${recorded.length} worlds -> ${outDir}`);
