// Skill surface (status listing, resource load, tool envelope, project skill
// creation). Extracted from runtime-core so the facade only wires the mutable
// cwd and the context module into it.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clean } from './session-text.mjs';

const SKILL_TEMPLATE = (name, description) => [
  '---',
  `name: ${name}`,
  `description: ${description}`,
  '---',
  '',
  '# Instructions',
  '',
  'Describe when and how to use this skill.',
  '',
].join('\n');

export function createSkillsApi({ contextMod, getCwd }) {
  function skillsStatus() {
    const cwd = getCwd();
    const skills = typeof contextMod.collectSkillsCached === 'function'
      ? contextMod.collectSkillsCached(cwd)
      : [];
    const norm = (value) => String(value || '').replace(/\\/g, '/').toLowerCase();
    const cwdNorm = norm(cwd);
    // A skill under <cwd>/.mixdog/skills is project-scoped; everything else
    // comes from the user/global tree.
    const sourceForSkill = (filePath) => (
      cwdNorm && norm(filePath).startsWith(`${cwdNorm}/.mixdog/skills/`) ? 'project' : 'skill'
    );
    return {
      cwd,
      count: skills.length,
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description || '',
        filePath: skill.filePath || null,
        source: sourceForSkill(skill.filePath),
      })),
    };
  }

  function skillContent(name) {
    const res = typeof contextMod.loadSkillResource === 'function'
      ? contextMod.loadSkillResource(name, getCwd())
      : null;
    if (!res) throw new Error(`skill not found: ${name}`);
    return { name, content: res.content, dir: res.dir };
  }

  function skillToolContent(name) {
    if (typeof contextMod.isSkillDisabled === 'function' && contextMod.isSkillDisabled(name)) {
      const label = String(name || '').trim() || 'skill';
      return `Error: skill "${label}" is disabled`;
    }
    const skill = skillContent(name);
    // The general tool envelope keeps the main/Lead session identical to agent
    // loops: the model-visible tool_result is the short stub and the SKILL.md
    // body is delivered ONCE as a separate injected user message.
    return contextMod.buildSkillToolEnvelope(skill.name, skill.content, skill.dir);
  }

  function addProjectSkill(input = {}) {
    const name = clean(input.name).replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) throw new Error('skill name is required');
    const dir = join(getCwd(), '.mixdog', 'skills', name);
    const filePath = join(dir, 'SKILL.md');
    if (existsSync(filePath)) throw new Error(`skill already exists: ${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, SKILL_TEMPLATE(name, clean(input.description) || 'Project skill.'), 'utf8');
    return { name, filePath };
  }

  return { skillsStatus, skillContent, skillToolContent, addProjectSkill };
}
