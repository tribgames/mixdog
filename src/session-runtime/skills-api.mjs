// Skill surface (status listing, resource load, tool envelope, global skill
// creation/editing). Extracted from runtime-core so the facade only wires the mutable
// cwd and the context module into it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolvePluginData } from '../runtime/shared/plugin-paths.mjs';
import {
  createSkillDocument,
  updateSkillDocument,
  validateSkillDescription,
  validateSkillName,
} from '../runtime/shared/skill-document.mjs';
import { clean } from './session-text.mjs';

const DEFAULT_SKILL_BODY = '# Instructions\n\nDescribe how to use this skill.';

export function createSkillsApi({ contextMod, getCwd }) {
  const globalSkillsRoot = () => resolve(resolvePluginData(), 'skills');

  function skillsStatus() {
    const cwd = getCwd();
    const skills = typeof contextMod.collectSkillsCached === 'function'
      ? contextMod.collectSkillsCached(cwd)
      : [];
    const norm = (value) => String(value || '').replace(/\\/g, '/').toLowerCase();
    const globalRoot = `${norm(globalSkillsRoot())}/`;
    const builtinRoot = typeof contextMod.builtinSkillsDir === 'function'
      ? `${norm(contextMod.builtinSkillsDir())}/`
      : null;
    const sourceForSkill = (filePath) => {
      const path = norm(filePath);
      if (path.startsWith(globalRoot)) return 'global';
      if (builtinRoot && path.startsWith(builtinRoot)) return 'builtin';
      return 'plugin';
    };
    return {
      cwd,
      count: skills.length,
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description || '',
        filePath: skill.filePath || null,
        source: sourceForSkill(skill.filePath),
        editable: sourceForSkill(skill.filePath) === 'global',
      })),
    };
  }

  function skillContent(name) {
    const skillName = String(name || '').trim();
    if (!skillName) throw new Error('skill name is required');
    const res = typeof contextMod.loadSkillResource === 'function'
      ? contextMod.loadSkillResource(skillName, getCwd())
      : null;
    if (!res) throw new Error(`skill not found: ${skillName}`);
    return { name: skillName, content: res.content, dir: res.dir };
  }

  function skillToolContent(name) {
    const skillName = String(name || '').trim();
    if (!skillName) throw new Error('skill name is required');
    const missingFeature = typeof contextMod.skillMissingFeature === 'function'
      ? contextMod.skillMissingFeature(skillName)
      : null;
    if (missingFeature) {
      return `Error: skill "${skillName}" needs the ${missingFeature} built-in feature, which is not installed or is switched off in Settings → Built-in`;
    }
    if (typeof contextMod.isSkillDisabled === 'function' && contextMod.isSkillDisabled(skillName)) {
      return `Error: skill "${skillName}" is disabled`;
    }
    const skill = skillContent(skillName);
    // The general tool envelope keeps the main/Lead session identical to agent
    // loops: the model-visible tool_result is the short stub and the SKILL.md
    // body is delivered ONCE as a separate injected user message.
    return contextMod.buildSkillToolEnvelope(skill.name, skill.content, skill.dir);
  }

  function addGlobalSkill(input = {}) {
    const name = validateSkillName(clean(input.name));
    const description = validateSkillDescription(input.description);
    const body = String(input.instructions || input.body || DEFAULT_SKILL_BODY);
    const dir = join(globalSkillsRoot(), name);
    const filePath = join(dir, 'SKILL.md');
    if (existsSync(filePath)) throw new Error(`skill already exists: ${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, createSkillDocument({ name, description, body }), 'utf8');
    contextMod.invalidateSkillsCache?.(getCwd());
    return { name, filePath };
  }

  function saveSkillDocument(input = {}) {
    const originalName = validateSkillName(input.originalName);
    const name = validateSkillName(input.name);
    const description = validateSkillDescription(input.description);
    const body = String(input.instructions || input.body || '');
    const resource = contextMod.loadSkillResource?.(originalName, getCwd());
    if (!resource?.filePath) throw new Error(`skill not found: ${originalName}`);
    const resourcePath = resolve(resource.filePath);
    const resourceRelative = relative(globalSkillsRoot(), resourcePath);
    if (!resourceRelative || resourceRelative.startsWith('..') || isAbsolute(resourceRelative)) {
      throw new Error(`plugin skill is read-only: ${originalName}`);
    }
    const collision = skillsStatus().skills.find((skill) =>
      skill.name === name && skill.filePath !== resource.filePath);
    if (collision) throw new Error(`skill already exists: ${name}`);

    const currentDir = dirname(resource.filePath);
    if (basename(currentDir) !== originalName) {
      throw new Error(`skill folder does not match its name: ${originalName}`);
    }
    const nextDir = join(dirname(currentDir), name);
    if (nextDir !== currentDir && existsSync(nextDir)) {
      throw new Error(`skill folder already exists: ${name}`);
    }
    const source = readFileSync(resource.filePath, 'utf8');
    const updated = updateSkillDocument(source, { name, description, body });
    let filePath = resource.filePath;
    if (nextDir !== currentDir) {
      renameSync(currentDir, nextDir);
      filePath = join(nextDir, 'SKILL.md');
      try {
        writeFileSync(filePath, updated, 'utf8');
      } catch (error) {
        renameSync(nextDir, currentDir);
        throw error;
      }
    } else {
      writeFileSync(filePath, updated, 'utf8');
    }
    contextMod.invalidateSkillsCache?.(getCwd());
    return { originalName, name, filePath };
  }

  function invalidateSkills() {
    contextMod.invalidateSkillsCache?.(getCwd());
  }

  return {
    skillsStatus,
    skillContent,
    skillToolContent,
    addGlobalSkill,
    saveSkillDocument,
    invalidateSkills,
  };
}
