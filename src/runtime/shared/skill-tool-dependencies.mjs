// Explicit skill dependencies. Imported manifests are read, never rewritten.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { resolvePluginData } from './plugin-paths.mjs';

const MAX_METADATA_BYTES = 64 * 1024;
const MAX_DEPENDENCIES = 128;
const dependencyKey = ({ type, value }) => `${type}:${value}`;

export function normalizeSkillToolDependencies(value, { strict = false } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_DEPENDENCIES) {
    throw new Error(`Skill dependencies.tools must be an array of at most ${MAX_DEPENDENCIES} entries.`);
  }
  const seen = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Each skill tool dependency needs type and value.');
    }
    const type = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : '';
    const name = typeof entry.value === 'string' ? entry.value.trim() : '';
    if (!type || !name || type.length > 64 || name.length > 256 || /[\s<>\0]/.test(type + name)) {
      throw new Error('Skill tool dependency type and value must be nonempty identifiers.');
    }
    if (strict && !['tool', 'mcp'].includes(type)) {
      throw new Error(`Unsupported skill tool dependency type: ${type}`);
    }
    // Extra import metadata (URL, command, OAuth) is not executable authority.
    return { ...entry, type, value: name };
  }).filter((entry) => {
    const key = dependencyKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function skillToolDependenciesRoot() {
  return join(resolvePluginData(), 'skill-tool-dependencies');
}

function overridePath(filePath) {
  let key = resolve(filePath);
  if (process.platform === 'win32') key = key.toLowerCase();
  return join(skillToolDependenciesRoot(), `${createHash('sha256').update(key).digest('hex')}.json`);
}

function boundedRead(path) {
  if (statSync(path).size > MAX_METADATA_BYTES) throw new Error('Skill dependency metadata is too large.');
  return readFileSync(path, 'utf8');
}

export function readSkillToolDependencies(filePath, frontmatter = {}) {
  const issues = [];
  const declared = [];
  const add = (value, label) => {
    try { declared.push(...normalizeSkillToolDependencies(value)); }
    catch (error) { issues.push(`${label}: ${error.message}`); }
  };
  add(frontmatter.dependencies?.tools, 'SKILL.md');
  const metadataPath = join(dirname(filePath), 'agents', 'openai.yaml');
  if (existsSync(metadataPath)) {
    try {
      const document = parseDocument(boundedRead(metadataPath), { uniqueKeys: true });
      if (document.errors.length) throw document.errors[0];
      add(document.toJS({ maxAliasCount: 100 })?.dependencies?.tools, 'agents/openai.yaml');
    } catch (error) { issues.push(`agents/openai.yaml: ${error.message}`); }
  }
  let declaredToolDependencies = [];
  try { declaredToolDependencies = normalizeSkillToolDependencies(declared); }
  catch (error) { issues.push(error.message); }
  const localPath = overridePath(filePath);
  if (existsSync(localPath)) {
    try {
      const local = JSON.parse(boundedRead(localPath));
      return {
        toolDependencies: normalizeSkillToolDependencies(local.dependencies?.tools),
        declaredToolDependencies,
        dependencySource: 'override',
        dependencyIssues: [],
      };
    } catch (error) {
      // A broken override must not silently restore dependencies the user removed.
      return { toolDependencies: [], declaredToolDependencies, dependencySource: 'override',
        dependencyIssues: [`Local skill dependencies: ${error.message}`] };
    }
  }
  return { toolDependencies: declaredToolDependencies, declaredToolDependencies,
    dependencySource: declaredToolDependencies.length || issues.length ? 'declaration' : 'none',
    dependencyIssues: issues };
}

export function saveSkillToolDependencies(filePath, dependencies) {
  const path = overridePath(filePath);
  // null restores the original declaration; [] explicitly disconnects all tools.
  if (dependencies === null) {
    rmSync(path, { force: true });
    return;
  }
  const tools = normalizeSkillToolDependencies(dependencies, { strict: true });
  const content = `${JSON.stringify({ dependencies: { tools } }, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_METADATA_BYTES) throw new Error('Skill dependency metadata is too large.');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
