// The user's instruction files (AGENTS.md / CLAUDE.md), global then project,
// rendered as one `# Instruction Files` block for a new session's BP3 core.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
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

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Candidate files in load order: global files first, then the project root's.
 *  Project files are confined to the real directory of their `root`; global
 *  files carry no root and may resolve anywhere. */
function instructionFileCandidates({ mode, cwd, homeDir = homedir() } = {}) {
  const kinds = KINDS_BY_MODE[effectiveInstructionFilesMode(mode)];
  const candidates = [];
  if (homeDir) {
    const root = resolve(homeDir);
    // Global files may be symlinks into a dotfiles repo: no containment root.
    for (const kind of kinds) candidates.push({ path: join(root, GLOBAL_DIR[kind], FILE_NAME[kind]) });
  }
  if (cwd) {
    const root = resolve(cwd);
    for (const kind of kinds) candidates.push({ path: join(root, FILE_NAME[kind]), root });
  }
  return candidates;
}

function isInside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function skipNote(path, reason) {
  process.stderr.write(`[instruction-files] skipped ${path}: ${reason}\n`);
}

/** At most the file's first cap bytes (plus a BOM allowance and one probe byte)
 *  from an open fd, so a huge or endless file is never read whole. */
function readHead(fd) {
  const buffer = Buffer.allocUnsafe(INSTRUCTION_FILE_MAX_BYTES + UTF8_BOM.length + 1);
  let length = 0;
  while (length < buffer.length) {
    const count = readSync(fd, buffer, length, buffer.length - length, null);
    if (count === 0) break;
    length += count;
  }
  return buffer.subarray(0, length);
}

/** Decode a head that may end mid-character: the incomplete tail is dropped. */
function decodeHead(bytes) {
  return new TextDecoder('utf-8').decode(bytes, { stream: true });
}

/** The bounded, trimmed text of one instruction file; over the budget it is cut
 *  at a word boundary and ends with the truncation notice. */
function boundedText(head) {
  const bytes = head.subarray(0, UTF8_BOM.length).equals(UTF8_BOM) ? head.subarray(UTF8_BOM.length) : head;
  if (bytes.length <= INSTRUCTION_FILE_MAX_BYTES) return decodeHead(bytes).trim();
  const budget = INSTRUCTION_FILE_MAX_BYTES - Buffer.byteLength(TRUNCATED_MARK, 'utf8');
  const text = decodeHead(bytes.subarray(0, budget)).trim();
  return `${text.replace(/\s+\S*$/, '')}${TRUNCATED_MARK}`;
}

/** The file's bounded content, or '' when it is absent, unreadable, not a
 *  regular file, or resolves (symlink/junction) outside `root` when one is set. */
function readInstructionFile({ path, root }) {
  let fd;
  try {
    const realPath = realpathSync.native(path);
    if (root && !isInside(realpathSync.native(root), realPath)) {
      skipNote(path, 'resolves outside its root');
      return '';
    }
    if (!statSync(realPath).isFile()) return '';
    fd = openSync(realPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) return '';
    return boundedText(readHead(fd));
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR' && error?.code !== 'EISDIR') {
      skipNote(path, error?.code || error?.message || 'unreadable');
    }
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The `# Instruction Files` block, or '' when no file has content. Files
 *  whose bounded content repeats an included one (symlinks, copies) are dropped. */
export function loadInstructionFilesContext({ mode, cwd, homeDir = homedir() } = {}) {
  const seen = new Set();
  const sections = [];
  for (const candidate of instructionFileCandidates({ mode, cwd, homeDir })) {
    const content = readInstructionFile(candidate);
    if (!content || seen.has(content)) continue;
    seen.add(content);
    sections.push(`## ${candidate.path}\n\n${content}`);
  }
  if (!sections.length) return '';
  return [
    '# Instruction Files',
    "The user's instruction files. Project files take precedence over global ones when they conflict.",
    ...sections,
  ].join('\n\n');
}
