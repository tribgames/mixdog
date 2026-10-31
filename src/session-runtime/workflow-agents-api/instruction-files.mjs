import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomicSync } from '../../runtime/shared/atomic-file.mjs';
import { normalizeText } from '../../runtime/shared/shipped-definitions.mjs';
import { decodeInstructionFile, INSTRUCTION_FILE_MAX_BYTES } from '../../lib/instruction-text.cjs';
import { outputStyleMetaFromMarkdown } from '../../lib/output-style-meta.cjs';
import {
  readInstructionFile,
  shippedOrchestrationPath,
  userOrchestrationPath,
} from '../../runtime/agent/orchestrator/runtime-core/orchestration.mjs';
import { ORCHESTRATION_MODES } from '../../runtime/shared/orchestration.mjs';
import { publishAgentProfileChange } from '../agent-profile-changes.mjs';
import { STANDALONE_ROOT } from '../runtime-paths.mjs';
import { resolveDataDir } from './shared.mjs';

// The editable instruction texts: the four orchestration modes (delegation)
// and the four output-style depth levels. Each has a shipped .md file and a
// same-name user file in the data dir that replaces it; the set is fixed.
export const INSTRUCTION_FILE_CONFLICT = 'INSTRUCTION_FILE_CONFLICT';

const MODE_LABELS = { none: 'Solo', focused: 'Focused', balanced: 'Balanced', swarm: 'Swarm' };
const STYLES = [
  ['detailed', 'Detailed'],
  ['simple', 'Simple'],
  ['minimal', 'Minimal'],
  ['extreme-minimal', 'Extreme Minimal'],
];
const INSTRUCTION_GROUPS = Object.freeze(['delegation', 'outputStyle']);

const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const bodyOfStyle = (text) =>
  String(text || '')
    .replace(FRONTMATTER, '')
    .trim();
const hashOf = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 24);

// One item's files and the text <-> file mapping. The style editor shows and
// saves the file's body only: the shipped front matter (name, title,
// description) is kept, and common.md is not part of it.
function itemFor(group, id, deps) {
  if (group === 'delegation') {
    if (!ORCHESTRATION_MODES.includes(id))
      throw new Error(`orchestration mode must be one of ${ORCHESTRATION_MODES.join(', ')}`);
    return {
      group,
      id,
      label: MODE_LABELS[id],
      shipped: shippedOrchestrationPath(id),
      user: userOrchestrationPath(id),
      body: (text) => text,
      file: (body) => `${body}\n`,
      accepts: () => true,
    };
  }
  if (group === 'outputStyle') {
    const style = STYLES.find(([styleId]) => styleId === id);
    if (!style) throw new Error(`output style must be one of ${STYLES.map(([styleId]) => styleId).join(', ')}`);
    const shipped = join(deps.rootDir ?? STANDALONE_ROOT, 'output-styles', `${id}.md`);
    return {
      group,
      id,
      label: style[1],
      shipped,
      user: join(resolveDataDir(deps), 'output-styles', `${id}.md`),
      body: bodyOfStyle,
      file: (body, shippedText) => `${(FRONTMATTER.exec(shippedText) || [''])[0].trimEnd()}\n\n${body}\n`,
      // A file whose front matter names another style defines that one instead
      // (the prompt builder registers it by name): it does not replace this one.
      accepts: (text) => outputStyleMetaFromMarkdown(text, `${id}.md`)?.id === id,
    };
  }
  throw new Error(`instruction group must be one of ${INSTRUCTION_GROUPS.join(', ')}`);
}

export function createInstructionFilesApi(deps) {
  function stateOf(item) {
    const shipped = readInstructionFile(item.shipped);
    const defaultBody = item.body(shipped?.text ?? '');
    const user = readInstructionFile(item.user);
    const accepted = Boolean(user?.text) && item.accepts(user.text);
    const userBody = accepted ? item.body(user.text) : '';
    // An existing user file that cannot serve (empty, too large, not text, a
    // style under another name) is passed over by the prompt builders: the
    // built-in applies.
    const usable = Boolean(userBody);
    const problem = user && !usable ? (user.problem ?? (accepted ? 'empty' : 'invalid')) : undefined;
    const body = usable ? userBody : defaultBody;
    return {
      group: item.group,
      id: item.id,
      label: item.label,
      body,
      defaultBody,
      userOverride: Boolean(user),
      modified: usable && normalizeText(userBody) !== normalizeText(defaultBody),
      ...(problem ? { problem } : {}),
      ...(user ? { path: item.user } : {}),
      revision: hashOf(`${usable ? 'user' : 'default'}\0${problem ?? ''}\0${body}`),
    };
  }

  // A write or reset made against a state that has moved on is refused.
  function assertCurrent(payloadRevision, before, item) {
    if (payloadRevision === undefined || String(payloadRevision) === before.revision) return;
    const conflict = new Error(`${INSTRUCTION_FILE_CONFLICT}: "${item.id}" changed since it was loaded`);
    conflict.code = INSTRUCTION_FILE_CONFLICT;
    throw conflict;
  }

  const get = (group, id) => stateOf(itemFor(group, id, deps));

  function list() {
    return [...ORCHESTRATION_MODES.map((id) => get('delegation', id)), ...STYLES.map(([id]) => get('outputStyle', id))];
  }

  async function announce() {
    deps.invalidateContextStatusCache?.();
    await publishAgentProfileChange();
  }

  async function save(payload = {}) {
    const item = itemFor(payload.group, payload.id, deps);
    const body = String(payload.body ?? '')
      .replace(/\r\n/g, '\n')
      .trim();
    if (!body) throw new Error('instruction text must not be empty');
    if (body.includes('\0')) throw new Error('instruction text must be plain text');
    const before = stateOf(item);
    assertCurrent(payload.expectedRevision, before, item);
    if (normalizeText(body) === normalizeText(before.defaultBody)) {
      // Equal to the shipped text: keep no copy, so it follows the shipped version.
      rmSync(item.user, { force: true });
    } else {
      // The bytes that reach the disk — front matter and newline included —
      // must pass the reader's check, or the saved file would be ignored.
      const bytes = Buffer.from(item.file(body, readInstructionFile(item.shipped)?.text ?? ''));
      if (bytes.length > INSTRUCTION_FILE_MAX_BYTES) throw new Error('instruction text is larger than 256 KB');
      const problem = decodeInstructionFile(bytes).problem;
      if (problem) throw new Error(`instruction text cannot be saved (${problem})`);
      mkdirSync(dirname(item.user), { recursive: true });
      writeFileAtomicSync(item.user, bytes, { backup: true, mode: 0o644 });
    }
    await announce();
    return stateOf(item);
  }

  async function reset(group, id, expectedRevision) {
    const item = itemFor(group, id, deps);
    if (!existsSync(item.user)) throw new Error(`"${item.id}" has no user override to reset`);
    assertCurrent(expectedRevision, stateOf(item), item);
    rmSync(item.user, { force: true });
    rmSync(`${item.user}.bak`, { force: true });
    await announce();
    return stateOf(item);
  }

  return {
    listInstructionFiles: list,
    getInstructionFile: get,
    saveInstructionFile: save,
    resetInstructionFile: reset,
  };
}
