#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillDocument, SKILL_TRIGGER_LISTING_MAX } from '../../../../runtime/shared/skill-document.mjs';
import { normalizeSkillToolDependencies } from '../../../../runtime/shared/skill-tool-dependencies.mjs';

const ALLOWED_FIELDS = new Set([
  'name',
  'description',
  'when_to_use',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
  'dependencies',
]);

// UI descriptions and model selection triggers have separate budgets.
// Only when_to_use enters the model's listing; instructions live in the body.
const DESCRIPTION_MAX = 100;
const LISTING_MAX = SKILL_TRIGGER_LISTING_MAX;

function referencedPaths(body) {
  const found = new Set();
  const patterns = [
    /`((?:references|scripts|assets)\/[A-Za-z0-9._/-]+)`/g,
    /\]\(((?:references|scripts|assets)\/[A-Za-z0-9._/-]+)\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

// Resolve, read and parse SKILL.md; a failure is returned as the finished
// validation result.
function loadSkillDocument(inputPath) {
  const fail = (message) => ({ failure: { ok: false, errors: [message], warnings: [] } });
  if (!inputPath) return fail('A skill directory path is required.');
  const skillDir = resolve(String(inputPath));
  const skillFile = resolve(skillDir, 'SKILL.md');
  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
    return fail(`Skill directory not found: ${skillDir}`);
  }
  if (!existsSync(skillFile) || !statSync(skillFile).isFile()) {
    return fail(`SKILL.md not found: ${skillFile}`);
  }
  let source = '';
  try {
    source = readFileSync(skillFile, 'utf8');
  } catch (error) {
    return fail(`Could not read SKILL.md: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return { skillDir, parsed: parseSkillDocument(source) };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function checkReferencedResources(skillDir, body, errors, warnings) {
  for (const resource of referencedPaths(body)) {
    const resourcePath = resolve(skillDir, resource);
    const rel = relative(skillDir, resourcePath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      errors.push(`Referenced resource escapes the skill directory: ${resource}.`);
    } else if (!existsSync(resourcePath)) {
      const skillBundlesFolder = existsSync(resolve(skillDir, resource.split('/')[0]));
      if (skillBundlesFolder) errors.push(`Referenced resource does not exist: ${resource}.`);
      else
        warnings.push(
          `${resource} is not bundled with the skill; if it is a repository path, prefer a repo-relative form the reader can resolve, or bundle it.`
        );
    }
  }
}

function checkFrontmatterKeys(frontmatter, errors) {
  for (const key of Object.keys(frontmatter)) {
    if (!ALLOWED_FIELDS.has(key)) errors.push(`Unsupported frontmatter field: ${key}.`);
  }
  if (frontmatter.dependencies != null) {
    if (typeof frontmatter.dependencies !== 'object' || Array.isArray(frontmatter.dependencies)) {
      errors.push('dependencies must be a mapping.');
    } else {
      try {
        normalizeSkillToolDependencies(frontmatter.dependencies.tools);
      } catch (error) {
        errors.push(error.message);
      }
    }
  }
}

function checkIdentityAndListing(skillDir, { name, description, whenToUse }, errors, warnings) {
  if (basename(skillDir) !== name) {
    errors.push(`Folder name "${basename(skillDir)}" must match skill name "${name}".`);
  }
  if (/[<>]/.test(description) || /[<>]/.test(whenToUse)) {
    errors.push('description and when_to_use cannot contain angle brackets.');
  }
  if (description.length > DESCRIPTION_MAX) {
    warnings.push(
      `description is ${description.length} characters; keep this UI summary within ${DESCRIPTION_MAX} and put operating details in the instructions.`
    );
  }
  if (whenToUse.length > LISTING_MAX) {
    warnings.push(
      `when_to_use is ${whenToUse.length} characters; the model's trigger cuts at ${LISTING_MAX}, so text past that never routes the skill.`
    );
  }
  if (!whenToUse) {
    warnings.push(
      'when_to_use is empty; the model sees only the name, not the UI description. Add selection conditions and relevant boundaries.'
    );
  }
}

function checkOptionalFrontmatter(frontmatter, errors) {
  if (frontmatter.compatibility != null) {
    if (typeof frontmatter.compatibility !== 'string') {
      errors.push('compatibility must be a string.');
    } else if (frontmatter.compatibility.trim().length > 500) {
      errors.push('compatibility must be 500 characters or fewer.');
    }
  }
  if (
    frontmatter.metadata != null &&
    (typeof frontmatter.metadata !== 'object' || Array.isArray(frontmatter.metadata))
  ) {
    errors.push('metadata must be a mapping.');
  }
}

function checkBody(body, errors, warnings) {
  if (!body) errors.push('SKILL.md must contain non-empty instructions after frontmatter.');
  const fenceLines = body ? body.split('\n').filter((line) => /^ {0,3}(```|~~~)/.test(line)).length : 0;
  if (fenceLines % 2) {
    errors.push('SKILL.md has an unclosed code fence; every ``` must start its own line.');
  }
  const bodyLines = body ? body.split('\n').length : 0;
  if (bodyLines > 500) {
    warnings.push(`SKILL.md body has ${bodyLines} lines; progressive disclosure is recommended above 500.`);
  }
}

export function validateSkillDirectory(inputPath) {
  const loaded = loadSkillDocument(inputPath);
  if (loaded.failure) return loaded.failure;
  const { skillDir, parsed } = loaded;
  const errors = [];
  const warnings = [];
  const { name, description, whenToUse, body, frontmatter } = parsed;

  checkFrontmatterKeys(frontmatter, errors);
  checkIdentityAndListing(skillDir, parsed, errors, warnings);
  checkOptionalFrontmatter(frontmatter, errors);
  checkBody(body, errors, warnings);
  checkReferencedResources(skillDir, body, errors, warnings);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    skill: name ? { name, description, whenToUse, directory: skillDir } : undefined,
  };
}
function runCli() {
  const result = validateSkillDirectory(process.argv[2]);
  for (const warning of result.warnings) console.warn(`WARNING: ${warning}`);
  for (const error of result.errors) console.error(`ERROR: ${error}`);
  if (result.ok) {
    console.log(`Valid skill: ${result.skill.name}`);
    return;
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === resolve(fileURLToPath(import.meta.url))) runCli();
