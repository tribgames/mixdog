// The user's instruction files (AGENTS.md / CLAUDE.md), global then project,
// rendered as one `# Instruction Files` block for a new session's BP3 core.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readSection } from '../../../shared/config.mjs';
import { normalizeInstructionFilesMode } from '../../../shared/instruction-files-mode.mjs';
import { featureEnvOverride } from '../runtime-core/config-helpers.mjs';

// Per-file budget in UTF-8 bytes (same byte-based cap as core memory).
const INSTRUCTION_FILE_MAX_BYTES = 32 * 1024;
const TRUNCATED_MARK = '\n\n[... truncated]';
const KINDS_BY_MODE = { all: ['agents', 'claude'], agents: ['agents'], claude: ['claude'], off: [] };
const GLOBAL_DIR = { agents: '.codex', claude: '.claude' };
const FILE_NAME = { agents: 'AGENTS.md', claude: 'CLAUDE.md' };

/** The configured mode, forced off by MIXDOG_BOOT_INSTRUCTION_FILES=0. */
export function effectiveInstructionFilesMode(mode) {
  if (featureEnvOverride('MIXDOG_BOOT_INSTRUCTION_FILES') === false) return 'off';
  return normalizeInstructionFilesMode(mode);
}

/** The stored agent-config value; an unreadable config reads as the default. */
export function configuredInstructionFilesMode() {
  try {
    return normalizeInstructionFilesMode(readSection('agent')?.instructionFiles);
  } catch {
    return normalizeInstructionFilesMode(undefined);
  }
}

/** Candidate paths in load order: global files first, then the project root's. */
function instructionFilePaths({ mode, cwd, homeDir = homedir() } = {}) {
  const kinds = KINDS_BY_MODE[effectiveInstructionFilesMode(mode)];
  const paths = homeDir ? kinds.map((kind) => join(resolve(homeDir), GLOBAL_DIR[kind], FILE_NAME[kind])) : [];
  if (cwd) paths.push(...kinds.map((kind) => join(resolve(cwd), FILE_NAME[kind])));
  return paths;
}

function capInstructionFile(text) {
  if (Buffer.byteLength(text, 'utf8') <= INSTRUCTION_FILE_MAX_BYTES) return text;
  const budget = INSTRUCTION_FILE_MAX_BYTES - Buffer.byteLength(TRUNCATED_MARK, 'utf8');
  // A byte cut can split a multi-byte character; drop its replacement chars.
  const head = Buffer.from(text, 'utf8').subarray(0, budget).toString('utf8').replace(/\uFFFD+$/, '');
  return `${head.replace(/\s+\S*$/, '')}${TRUNCATED_MARK}`;
}

function readInstructionFile(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

/** The `# Instruction Files` block, or '' when no file has content. Files
 *  whose trimmed content repeats an included one (symlinks, copies) are dropped. */
export function loadInstructionFilesContext({ mode, cwd, homeDir = homedir() } = {}) {
  const seen = new Set();
  const sections = [];
  for (const path of instructionFilePaths({ mode, cwd, homeDir })) {
    const content = readInstructionFile(path);
    if (!content || seen.has(content)) continue;
    seen.add(content);
    sections.push(`## ${path}\n\n${capInstructionFile(content)}`);
  }
  if (!sections.length) return '';
  return [
    '# Instruction Files',
    "The user's instruction files. Project files take precedence over global ones when they conflict.",
    ...sections,
  ].join('\n\n');
}
