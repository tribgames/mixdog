// Skill surface (status listing, resource load, tool envelope, global skill
// creation/editing). Extracted from runtime-core so the facade only wires the mutable
// cwd and the context module into it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolvePluginData } from '../runtime/shared/plugin-paths.mjs';
import {
  createSkillDocument,
  parseSkillDocument,
  updateSkillDocument,
  validateSkillDescription,
  validateSkillName,
  validateSkillWhenToUse,
} from '../runtime/shared/skill-document.mjs';
import { clean } from './session-text.mjs';
import { normalizeSkillToolDependencies, saveSkillToolDependencies } from '../runtime/shared/skill-tool-dependencies.mjs';
import { loadSkillToolDependencies } from './skill-tool-loading.mjs';

const DEFAULT_SKILL_BODY = '# Instructions\n\nDescribe how to use this skill.';

export function createSkillsApi({ contextMod, getCwd, getTools = () => [] }) {
  const globalSkillsRoot = () => resolve(resolvePluginData(), 'skills');

  function skillsStatus() {
    const cwd = getCwd();
    const skills = typeof contextMod.collectSkillsCached === 'function'
      ? contextMod.collectSkillsCached(cwd)
      : [];
    const norm = (value) => String(value || '').replace(/\\/g, '/').toLowerCase();
    const globalRoot = `${norm(globalSkillsRoot())}/`;
    const sourceForSkill = (skill) => (
      skill.source || (norm(skill.filePath).startsWith(globalRoot) ? 'global' : 'plugin')
    );
    // Owner: who installs, shows, and toggles this skill. Only user-global
    // skills stand on their own; a built-in skill rides its feature's Install
    // and toggle, a plugin skill rides the plugin's, so panels list those under
    // the parent instead of as loose entries.
    const ownerForSkill = (skill, source) => {
      if (source === 'plugin') return { kind: 'plugin', id: skill.plugin || null };
      if (source === 'builtin') {
        const requires = Array.isArray(skill.requires) ? skill.requires : [];
        return { kind: 'builtin', feature: requires[0] || null };
      }
      return { kind: 'user' };
    };
    return {
      cwd,
      count: skills.length,
      tools: getTools().map(({ name }) => ({ name })),
      skills: skills.map((skill) => {
        const source = sourceForSkill(skill);
        return {
          name: skill.name,
          enabled: !(contextMod.isSkillDisabled?.(skill.name) || contextMod.skillMissingFeature?.(skill.name)),
          description: skill.description || '',
          whenToUse: skill.whenToUse || '',
          filePath: skill.filePath || null,
          source,
          owner: ownerForSkill(skill, source),
          editable: source === 'global',
          toolDependencies: skill.toolDependencies || [],
          declaredToolDependencies: skill.declaredToolDependencies || [],
          dependencySource: skill.dependencySource || 'none',
          dependencyIssues: skill.dependencyIssues || [],
        };
      }),
    };
  }

  function skillContent(name) {
    const skillName = String(name || '').trim();
    if (!skillName) throw new Error('skill name is required');
    const res = typeof contextMod.loadSkillResource === 'function'
      ? contextMod.loadSkillResource(skillName, getCwd())
      : null;
    if (!res) throw new Error(`skill not found: ${skillName}`);
    return { ...res, name: skillName, source: res.source || 'global' };
  }

  function skillToolContent(name, session = null, mode) {
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
    return loadSkillToolDependencies(
      contextMod.buildSkillToolEnvelope(skill.name, skill.content, skill.dir, skill), session, mode,
    );
  }

  function addGlobalSkill(input = {}) {
    const name = validateSkillName(clean(input.name));
    const description = validateSkillDescription(input.description);
    const whenToUse = validateSkillWhenToUse(input.whenToUse);
    const body = String(input.instructions || input.body || DEFAULT_SKILL_BODY);
    const dependencies = input.toolDependencies === undefined ? undefined
      : normalizeSkillToolDependencies(input.toolDependencies, { strict: true });
    const dir = join(globalSkillsRoot(), name);
    const filePath = join(dir, 'SKILL.md');
    if (existsSync(filePath)) throw new Error(`skill already exists: ${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, createSkillDocument({ name, description, whenToUse, body }), 'utf8');
    if (dependencies !== undefined) saveSkillToolDependencies(filePath, dependencies);
    contextMod.invalidateSkillsCache?.(getCwd());
    return { name, filePath };
  }

  function saveSkillDocument(input = {}) {
    const originalName = validateSkillName(input.originalName);
    const resource = contextMod.loadSkillResource?.(originalName, getCwd());
    if (!resource?.filePath) throw new Error(`skill not found: ${originalName}`);
    const dependencies = input.toolDependencies === null ? null
      : input.toolDependencies === undefined ? undefined
      : normalizeSkillToolDependencies(input.toolDependencies, { strict: true });
    if (input.dependenciesOnly === true) {
      if (dependencies === undefined) throw new Error('Skill tool dependencies are required.');
      saveSkillToolDependencies(resource.filePath, dependencies);
      contextMod.invalidateSkillsCache?.(getCwd());
      return { originalName, name: originalName, filePath: resource.filePath };
    }
    const name = validateSkillName(input.name);
    const description = validateSkillDescription(input.description);
    const whenToUse = validateSkillWhenToUse(input.whenToUse);
    const body = String(input.instructions || input.body || '');
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
    const parsed = parseSkillDocument(source);
    if (name === originalName && description === parsed.description && whenToUse === parsed.whenToUse
      && body.trim() === parsed.body.trim()) {
      if (dependencies !== undefined) saveSkillToolDependencies(resource.filePath, dependencies);
      contextMod.invalidateSkillsCache?.(getCwd());
      return { originalName, name, filePath: resource.filePath };
    }
    const updated = updateSkillDocument(source, { name, description, whenToUse, body });
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
    if (dependencies !== undefined) saveSkillToolDependencies(filePath, dependencies);
    else if (filePath !== resource.filePath && resource.dependencySource === 'override') {
      saveSkillToolDependencies(filePath, resource.toolDependencies || []);
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
