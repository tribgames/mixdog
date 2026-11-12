#!/usr/bin/env node
// Recording of scripts/skill-creator-validator.test.mjs, the case "the bundled skill-creator validates and is collected as a
// built-in skill" (b6f10295a): validateSkillDirectory over src/defaults/skills/skill-creator and collectSkills over the
// product tree with an empty data dir, every collected skill recorded whole (the bundled ones are the tree's).
//
//   node benchmarks/rust-core/recorders/record-skill-creator-validator-cases.mjs --tree <export of b6f10295a with node_modules>
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSet } from './lib/case-set.mjs';

const set = openSet('skill-creator-validator-cases', import.meta.url);
const { collectSkills } = await set.load('src/runtime/agent/orchestrator/context/collect.mjs');
const { validateSkillDirectory } = await set.load('src/defaults/skills/skill-creator/scripts/validate-skill.mjs');

const roots = [];
await set.run('the bundled skill-creator validates and is collected as a built-in skill', () => {
  const validated = validateSkillDirectory(join(set.tree, 'src', 'defaults', 'skills', 'skill-creator'));
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-creator-collect-'));
  roots.push(root);
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  try {
    return { validated, collected: collectSkills(set.tree) };
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
  }
});

const treePath = /^.*[\\/]src[\\/]defaults[\\/]skills[\\/]([^\\/]+)[\\/]SKILL\.md$/;
const treeDir = /^.*[\\/]src[\\/]defaults[\\/]skills[\\/]([^\\/]+)$/;
await set.finish({
  entry: { runs: 'skill-creator/scripts/validate-skill.mjs validateSkillDirectory and context/collect.mjs collectSkills(<tree>) with MIXDOG_DATA_DIR in an empty temp dir', notRun: 'no global or plugin skills: the data dir is empty' },
  replay: { entry: 'mixdog-mcp skills.rs collect_skills over the bundled skills folder as the one Builtin root: compare each collected skill (name, description, whenToUse, source, plugin, requires, declared and effective tool dependencies, dependency source and issues) in order; the validator result is compared whole with what the shipped validate-skill.mjs prints under node (the validator is a shipped script, not Rust)', normalised: {} },
  replaceRegex: [[treePath, '<tree>/src/defaults/skills/$1/SKILL.md'], [treeDir, '<tree>/src/defaults/skills/$1']],
  normaliseReason: 'the per-run tree path of each skill file (and of the validated folder) is written <tree>/src/defaults/skills/<folder>[/SKILL.md] (separators as slashes)',
});
for (const r of roots) rmSync(r, { recursive: true, force: true });
process.exit(0);
