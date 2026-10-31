// Prompt-shaping settings — output style, profile (title, experience,
// response language), the workflow pack, the skill listing, instruction
// files and core memory — as the sections a prompt renders from them. A
// prompt records what it presents (`session.promptSettings`); a conversation
// that meets other settings keeps its cached prefix, is told once by a
// <system-reminder> (acknowledged when the provider accepts the turn) and
// folds them in at the next cold point (session-runtime/tool-policy-refresh.mjs,
// tool-policy/agent-profile-fold.mjs).
//
// Injection policy: a notice says what changed, never what the prompt or an
// earlier notice already carries — one `#` section per changed item, names
// and line diffs instead of bodies, each section and the whole block capped.
// promptSettingsNoticeContent is the one builder of that text.
import { createHash } from 'node:crypto';
import { isAgentOwner } from '../../agent-owner.mjs';
import { orchestrationModeName } from './orchestration-mode-switch-notice.mjs';

/** The rendered sections a prompt carries, in prompt order, with their labels. */
export const PROMPT_SETTING_SECTIONS = Object.freeze([
  ['meta', 'Profile Preferences and Output Style'],
  ['workflow', 'Workflow'],
  ['orchestration', 'Orchestration Mode'],
  ['skills', 'Skills'],
  ['instructionFiles', 'Instruction Files'],
  ['coreMemory', 'Core Memory'],
  ['language', 'Language'],
]);

export const NOTICE_MAX_BYTES = 4096;
export const DIFF_MAX_BYTES = 2048;
export const STYLE_BODY_MAX_BYTES = 1536;

const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

/** The prompt inputs of the runtime's in-memory config, for the rule builders. */
export function promptConfigSlice(config) {
  const root = record(config);
  if (!root) return null;
  const agent = record(root.agent) || {};
  return {
    outputStyle: root.outputStyle ?? null,
    profile: root.profile ?? agent.profile ?? null,
    instructionFiles: root.instructionFiles ?? agent.instructionFiles ?? null,
  };
}

const hashOf = (text) =>
  createHash('sha256')
    .update(String(text || '').trim())
    .digest('hex')
    .slice(0, 16);

const bytes = (text) => Buffer.byteLength(String(text || ''));

// --- section parsing ---------------------------------------------------------

/** `# Heading` blocks of a rendered section: heading → body. */
function headedBlocks(text) {
  const blocks = new Map();
  let heading = null;
  let lines = [];
  const flush = () => {
    if (heading !== null) blocks.set(heading, lines.join('\n').trim());
  };
  for (const line of String(text || '').split('\n')) {
    const match = /^# (.+)$/.exec(line);
    if (match) {
      flush();
      heading = match[1].trim();
      lines = [];
    } else if (heading !== null) lines.push(line);
  }
  flush();
  return blocks;
}

function outputStyleOf(meta) {
  for (const [heading, body] of headedBlocks(meta)) {
    const match = /^Output Style: (.+)$/.exec(heading);
    if (match) return { name: match[1].trim(), body };
  }
  return null;
}

const bulletLines = (text) =>
  String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));

const profileLines = (meta) => bulletLines(headedBlocks(meta).get('Profile Preferences'));

function skillNames(manifest) {
  return bulletLines(manifest)
    .map((line) => /^- ([^:[]+?)(?::|\s\[|$)/.exec(line)?.[1]?.trim())
    .filter((name) => name && !name.startsWith('...'));
}

// A file's own `## ` headings are content: only an absolute path opens a file.
const FILE_HEADING_RE = /^## ((?:[A-Za-z]:[\\/]|\/).*)$/;

/** `## <path>` → content of a rendered `# Instruction Files` block. */
function instructionFiles(text) {
  const files = new Map();
  let path = null;
  let lines = [];
  const flush = () => {
    if (path) files.set(path, lines.join('\n').trim());
  };
  for (const line of String(text || '').split('\n')) {
    const match = FILE_HEADING_RE.exec(line);
    if (match) {
      flush();
      path = match[1].trim();
      lines = [];
    } else if (path) lines.push(line);
  }
  flush();
  return files;
}

const contentLines = (text) =>
  String(text || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());

/** Added (+) and removed (-) lines, capped at `max` bytes; '' when equal. */
function lineDiff(before, after, max = DIFF_MAX_BYTES) {
  const was = contentLines(before);
  const now = contentLines(after);
  const wasSet = new Set(was);
  const nowSet = new Set(now);
  const changes = [
    ...was.filter((line) => !nowSet.has(line)).map((line) => `- ${line}`),
    ...now.filter((line) => !wasSet.has(line)).map((line) => `+ ${line}`),
  ];
  const kept = [];
  let used = 0;
  for (const line of changes) {
    if (used + bytes(line) + 1 > max) {
      kept.push(`(${changes.length - kept.length} more changed lines)`);
      break;
    }
    kept.push(line);
    used += bytes(line) + 1;
  }
  return kept.join('\n');
}

// --- records -----------------------------------------------------------------

/** `sections`: { meta, workflow, skills, instructionFiles, coreMemory,
 *  language } texts ('' when absent), plus `responseLanguage` ({ id, name })
 *  and `instructionFilesMode`. The record keeps what a later notice diffs. */
export function promptSettingsRecord(sections = {}) {
  const hashes = Object.fromEntries(PROMPT_SETTING_SECTIONS.map(([key]) => [key, hashOf(sections[key])]));
  const revision = hashOf(PROMPT_SETTING_SECTIONS.map(([key]) => hashes[key]).join('|'));
  return {
    revision,
    hashes,
    texts: {
      meta: String(sections.meta || ''),
      orchestration: String(sections.orchestration || ''),
      orchestrationMode: String(sections.orchestrationMode || ''),
      instructionFiles: String(sections.instructionFiles || ''),
      coreMemory: String(sections.coreMemory || ''),
      skills: skillNames(sections.skills),
      ...(sections.instructionFilesMode ? { instructionFilesMode: sections.instructionFilesMode } : {}),
    },
  };
}

// A section a record predates (added to the list later) counts as unchanged.
function changedKeys(from, to) {
  return PROMPT_SETTING_SECTIONS.map(([key]) => key).filter(
    (key) => from?.hashes?.[key] !== undefined && from.hashes[key] !== to.hashes[key]
  );
}

// --- the notice builder ------------------------------------------------------

function languageSection(sections) {
  const name = sections.responseLanguage?.name;
  return name
    ? `# Language\nRespond in ${name} from now on.`
    : '# Language\nNo response language is set any more: reply in the language of the conversation.';
}

function metaSections(before, sections) {
  const out = [];
  const style = outputStyleOf(sections.meta);
  const was = outputStyleOf(before);
  if (style?.name !== was?.name || style?.body !== was?.body) {
    if (!style) out.push('# Output Style\nNo output style applies any more.');
    else {
      const body =
        bytes(style.body) < STYLE_BODY_MAX_BYTES ? `\n\n${style.body}` : '\nIt applies from the next prompt rebuild.';
      out.push(`# Output Style\nThe output style is now "${style.name}".${body}`);
    }
  }
  const profileDiff = lineDiff(profileLines(before).join('\n'), profileLines(sections.meta).join('\n'));
  if (profileDiff) out.push(`# Profile\n${profileDiff}`);
  return out;
}

function instructionFilesSection(told, sections) {
  const mode = sections.instructionFilesMode;
  if (mode && told.instructionFilesMode && mode !== told.instructionFilesMode) {
    return `# Instruction Files\nThe instruction files mode is now "${mode}"; the files apply from the next prompt rebuild.`;
  }
  const was = instructionFiles(told.instructionFiles);
  const now = instructionFiles(sections.instructionFiles);
  const parts = [];
  for (const path of new Set([...was.keys(), ...now.keys()])) {
    if (!now.has(path)) parts.push(`## ${path}\nNo longer applies.`);
    else {
      const diff = lineDiff(was.get(path), now.get(path));
      if (diff) parts.push(`## ${path}\n${diff}\nRead ${path} for the full file.`);
    }
  }
  return parts.length ? `# Instruction Files\n${parts.join('\n\n')}` : '';
}

function skillsSection(told, sections) {
  const was = new Set(told.skills || []);
  const now = skillNames(sections.skills);
  const added = now.filter((name) => !was.has(name));
  const removed = [...was].filter((name) => !now.includes(name));
  const lines = [
    ...(added.length ? [`Added: ${added.join(', ')}`] : []),
    ...(removed.length ? [`Removed: ${removed.join(', ')}`] : []),
  ];
  return lines.length ? `# Skills\n${lines.join('\n')}` : '';
}

const LATER = 'it applies from the next prompt rebuild.';

// The paths of changed instruction files, with how each changed.
function changedInstructionFiles(told, sections) {
  const was = instructionFiles(told.instructionFiles);
  const now = instructionFiles(sections.instructionFiles);
  const out = [];
  for (const path of new Set([...was.keys(), ...now.keys()])) {
    if (!now.has(path)) out.push({ path, line: `- no longer applies: ${path}` });
    else if (!was.has(path)) out.push({ path, line: `- added: ${path} (read it)` });
    else if (was.get(path) !== now.get(path)) out.push({ path, line: `- changed: ${path} (read it)` });
  }
  return out;
}

// The rendered block of `files` (path → text), as instructionFiles() parses it.
function renderInstructionFiles(files) {
  if (!files.size) return '';
  return ['# Instruction Files', ...[...files].map(([path, text]) => `## ${path}\n\n${text}`)].join('\n\n');
}

/** What the model knows of instruction files once `paths` were told. */
function instructionFilesAfter(toldText, nowText, paths) {
  const files = instructionFiles(toldText);
  const now = instructionFiles(nowText);
  for (const path of paths) {
    if (now.has(path)) files.set(path, now.get(path));
    else files.delete(path);
  }
  return renderInstructionFiles(files);
}

const INSTRUCTION_LIST_MAX_BYTES = 1024;

// Instruction files: the diffs (full), every path by name (compact), or as
// many paths as fit a short list (minimal). A form lists `paths`: only those
// are acknowledged; the rest stay pending for the next turn.
function instructionFilesItem(full, told, sections) {
  const changed = changedInstructionFiles(told, sections);
  const heading = '# Instruction Files';
  const all = changed.map((entry) => entry.path);
  const compact = [heading, ...changed.map((entry) => entry.line)].join('\n');
  const listed = [];
  let size = bytes(heading);
  for (const entry of changed) {
    if (listed.length && size + bytes(entry.line) + 1 > INSTRUCTION_LIST_MAX_BYTES) break;
    listed.push(entry);
    size += bytes(entry.line) + 1;
  }
  const rest = changed.length - listed.length;
  const minimal = [
    heading,
    ...listed.map((entry) => entry.line),
    ...(rest ? [`(${rest} more changed files follow in the next notice)`] : []),
  ].join('\n');
  return {
    key: 'instructionFiles',
    full,
    compact,
    minimal,
    paths: { full: all, compact: all, minimal: listed.map((entry) => entry.path) },
  };
}

// One changed item: its full text and the compact form it degrades to when
// the block has no room (a name and a pointer, never dropped).
function noticeItems(keys, sections, told) {
  const items = [];
  const add = (key, full, compact = full, minimal = compact) => full && items.push({ key, full, compact, minimal });
  for (const [key] of PROMPT_SETTING_SECTIONS) {
    if (!keys.includes(key)) continue;
    if (key === 'meta') {
      const style = outputStyleOf(sections.meta);
      for (const part of metaSections(told.meta, sections)) {
        if (part.startsWith('# Output Style')) {
          add(key, part, style ? `# Output Style\nThe output style is now "${style.name}"; ${LATER}` : part);
        } else {
          const lines = part.split('\n').length - 1;
          add(key, part, `# Profile\n${lines} profile preference lines changed; ${LATER}`);
        }
      }
    } else if (key === 'workflow') {
      const name = sections.workflowName ? `"${sections.workflowName}"` : 'active';
      add(key, `# Workflow\nThe ${name} workflow pack changed; ${LATER}`);
    } else if (key === 'orchestration') {
      // The text of the active mode was edited. A switch to another mode is
      // the mode-switch notice's, and a record that predates the text has
      // nothing to diff.
      const mode = sections.orchestrationMode;
      if (told.orchestration === undefined || !mode || told.orchestrationMode !== mode) continue;
      // Order is meaning in instructions: the line diff compares sets, so
      // moved or repeated lines are caught by comparing the sequences.
      const was = contentLines(told.orchestration);
      const now = contentLines(sections.orchestration);
      if (was.join('\n') === now.join('\n')) continue;
      const diff = lineDiff(told.orchestration, sections.orchestration);
      const nowSet = new Set(now);
      const wasSet = new Set(was);
      const reordered =
        was.filter((line) => nowSet.has(line)).join('\n') !== now.filter((line) => wasSet.has(line)).join('\n');
      const name = orchestrationModeName(mode);
      const head = `# Orchestration Mode\nThe ${name} orchestration mode instructions were edited`;
      add(
        key,
        diff
          ? `${head}:\n${diff}${reordered ? '\n(line order also changed)' : ''}`
          : `${head}: the same lines in a different order or count.`,
        `${head}; ${LATER}`
      );
    } else if (key === 'skills') {
      const full = skillsSection(told, sections);
      const added = skillNames(sections.skills).filter((name) => !(told.skills || []).includes(name)).length;
      const removed = (told.skills || []).filter((name) => !skillNames(sections.skills).includes(name)).length;
      add(key, full, `# Skills\n${added} skills added, ${removed} removed; ${LATER}`);
    } else if (key === 'instructionFiles') {
      const full = instructionFilesSection(told, sections);
      if (!full) continue;
      if (full.includes('instruction files mode is now')) add(key, full);
      else items.push(instructionFilesItem(full, told, sections));
    } else if (key === 'coreMemory') {
      const later = `# Core Memory\nCore memory was updated; ${LATER}`;
      const diff = told.coreMemory === undefined ? '' : lineDiff(told.coreMemory, sections.coreMemory);
      add(key, diff ? `# Core Memory\nCore memory was updated:\n${diff}` : later, later);
    } else if (key === 'language') add(key, languageSection(sections));
  }
  return items;
}

const NOTICE_OPEN =
  '<system-reminder>\nSettings changed during this conversation; each section replaces the matching part of your system prompt.';
const NOTICE_CLOSE = '</system-reminder>';

/**
 * The one builder of model-visible prompt-settings text: one `#` section per
 * changed item of `keys`, diffed against `told` (the texts the model last
 * had: promptSettingsRecord().texts). Every item first takes its minimal
 * form (one line), smallest first; the budget left then upgrades items to
 * their compact form and then their full text, smallest first. An item that
 * does not fit even minimal is left out, named by the overflow line and not
 * acknowledged. `compact: true` stops at the compact forms.
 * Returns `{ content, emitted }` (`emitted`: the keys whose every item was
 * sent); content '' when nothing is worth telling.
 */
export function buildPromptSettingsNotice(keys, sections, told = {}, { compact = false } = {}) {
  const items = noticeItems(keys, sections, told);
  if (!items.length) return { content: '', emitted: [] };
  let used = bytes(NOTICE_OPEN) + bytes(NOTICE_CLOSE);
  const cost = (text) => bytes(text) + 2;
  const overflowReserve = cost('99 more changes; see the setup tool.');
  const chosen = new Map(); // item → tier
  for (const item of [...items].sort((a, b) => bytes(a.minimal) - bytes(b.minimal))) {
    if (used + cost(item.minimal) + overflowReserve > NOTICE_MAX_BYTES) continue;
    chosen.set(item, 'minimal');
    used += cost(item.minimal);
  }
  // Upgrade, smallest first: to the compact form, then (unless compact only) the full text.
  for (const tier of compact ? ['compact'] : ['compact', 'full']) {
    for (const item of [...chosen.keys()].sort((a, b) => bytes(a[tier]) - bytes(b[tier]))) {
      const extra = cost(item[tier]) - cost(item[chosen.get(item)]);
      if (extra > 0 && used + extra + overflowReserve > NOTICE_MAX_BYTES) continue;
      chosen.set(item, tier);
      used += extra;
    }
  }
  const left = items.filter((item) => !chosen.has(item));
  const parts = items.filter((item) => chosen.has(item)).map((item) => item[chosen.get(item)]);
  if (left.length) parts.push(`${left.length} more changes; see the setup tool.`);
  // An item whose form names only some of its paths tells those alone.
  const partial = {};
  for (const [item, tier] of chosen) {
    const paths = item.paths?.[tier];
    if (paths && paths.length < item.paths.full.length) partial[item.key] = paths;
  }
  const emitted = keys.filter(
    (key) =>
      items.some((item) => item.key === key) && !left.some((item) => item.key === key) && !Object.hasOwn(partial, key)
  );
  return { content: parts.length ? [NOTICE_OPEN, ...parts, NOTICE_CLOSE].join('\n\n') : '', emitted, partial };
}

/** The notice text alone (see buildPromptSettingsNotice). */
export function promptSettingsNoticeContent(keys, sections, told = {}) {
  return buildPromptSettingsNotice(keys, sections, told).content;
}

// --- staging -----------------------------------------------------------------

// What the model was last told: an acknowledged notice, else its prompt; a
// staged working-folder change tells its own instruction files and core
// memory (workspace notice), so they count as told.
function toldRecord(session, presented) {
  const told = session.promptSettingsTold || presented;
  const target = session.workspaceReroot?.target;
  if (!target) return told;
  const hashes = { ...told.hashes };
  const texts = { ...(told.texts || {}) };
  if (target.instructionFilesContext !== undefined) {
    hashes.instructionFiles = hashOf(target.instructionFilesContext);
    texts.instructionFiles = String(target.instructionFilesContext || '');
  }
  if (target.coreMemoryContext !== undefined) {
    hashes.coreMemory = hashOf(target.coreMemoryContext);
    texts.coreMemory = String(target.coreMemoryContext || '');
  }
  return { ...told, hashes, texts };
}

/**
 * Compare a conversation's settings with `sections` (as they stand now).
 * Returns the keys that differ from the prompt (a later fold presents them),
 * staging one notice for what differs from what the model was last told —
 * a setting moved back to the prompt's value is told too.
 */
export function stagePromptSettingsNotice(session, sections) {
  if (sections.responseLanguage !== undefined) session.responseLanguage = sections.responseLanguage;
  // After a compaction stripped what a worker was told: names and pointers only.
  const compact = session.promptSettingsRecheck === 'compact';
  delete session.promptSettingsRecheck;
  const presented = session?.promptSettings;
  // A prompt from before settings were recorded: what it presents is unknown.
  if (!presented?.hashes) {
    session.promptSettings = promptSettingsRecord(sections);
    return [];
  }
  const next = promptSettingsRecord(sections);
  // `sections.only`: the caller computes these sections alone; the others
  // stay as the prompt presents them.
  if (Array.isArray(sections.only)) {
    for (const [key] of PROMPT_SETTING_SECTIONS) {
      if (sections.only.includes(key) || presented.hashes[key] === undefined) continue;
      next.hashes[key] = presented.hashes[key];
    }
    next.revision = hashOf(PROMPT_SETTING_SECTIONS.map(([key]) => next.hashes[key]).join('|'));
  }
  // Sections a record predates are adopted as presented.
  for (const [key] of PROMPT_SETTING_SECTIONS) {
    if (presented.hashes[key] === undefined) presented.hashes[key] = next.hashes[key];
  }
  const changed = changedKeys(presented, next);
  const told = toldRecord(session, presented);
  const fresh = changedKeys(told, next);
  const { content, emitted, partial } = fresh.length
    ? buildPromptSettingsNotice(fresh, sections, told.texts || {}, { compact })
    : { content: '', emitted: [], partial: {} };
  if (!content) {
    delete session.promptSettingsNotice;
    // Nothing to tell: the model's view is the prompt's, or what it was told.
    if (!changed.length) delete session.promptSettingsTold;
    else if (fresh.length) session.promptSettingsTold = next;
    return changed;
  }
  const pending = session.promptSettingsNotice;
  if (pending?.record?.revision === next.revision && pending.content === content) return changed;
  // One notice per change: an unsent one is replaced by what is current.
  const revision = (Number(session.promptSettingsNoticeRevision) || 0) + 1;
  session.promptSettingsNoticeRevision = revision;
  session.promptSettingsNotice = { revision, record: next, content, emitted, partial, fresh };
  session.updatedAt = Date.now();
  return changed;
}

// What the model knows after `notice` reached it: the record's sections it
// carried, the earlier told state for the rest.
const TEXTS_OF = {
  meta: ['meta'],
  orchestration: ['orchestration', 'orchestrationMode'],
  instructionFiles: ['instructionFiles', 'instructionFilesMode'],
  coreMemory: ['coreMemory'],
  skills: ['skills'],
};
function toldAfter(session, notice) {
  const emitted = Array.isArray(notice.emitted) ? notice.emitted : null;
  if (!emitted) return notice.record;
  const base = session.promptSettingsTold || session.promptSettings || notice.record;
  const hashes = { ...base.hashes };
  const texts = { ...(base.texts || {}) };
  for (const key of emitted) {
    hashes[key] = notice.record.hashes[key];
    for (const field of TEXTS_OF[key] || []) {
      if (notice.record.texts?.[field] === undefined) delete texts[field];
      else texts[field] = notice.record.texts[field];
    }
  }
  // Instruction files the notice named one by one: those paths alone.
  const paths = notice.partial?.instructionFiles;
  if (Array.isArray(paths)) {
    texts.instructionFiles = instructionFilesAfter(
      texts.instructionFiles,
      notice.record.texts?.instructionFiles,
      paths
    );
    hashes.instructionFiles = hashOf(texts.instructionFiles);
  }
  const revision = hashOf(PROMPT_SETTING_SECTIONS.map(([key]) => hashes[key]).join('|'));
  return { revision, hashes, texts };
}

/** The notice the next user turn carries, or null. */
export function snapshotPendingPromptSettingsNotice(session) {
  const pending = session?.promptSettingsNotice;
  return pending?.content ? { revision: pending.revision, content: pending.content } : null;
}

/** The notice of `revision` reached the model. */
export function acknowledgePendingPromptSettingsNotice(session, revision) {
  const pending = session?.promptSettingsNotice;
  if (!pending || pending.revision !== Number(revision)) return false;
  // Only what the notice carried is told; an item the cap left out stays
  // pending and is told by the next turn's reconcile.
  session.promptSettingsTold = toldAfter(session, pending);
  if (Array.isArray(pending.fresh) && pending.fresh.some((key) => !pending.emitted.includes(key))) {
    session.promptSettingsRecheck = true;
  }
  delete session.promptSettingsNotice;
  return true;
}

/** The prompt now presents `sections`: nothing is pending any more. */
export function notePromptSettingsPresented(session, sections) {
  if (sections.responseLanguage !== undefined) session.responseLanguage = sections.responseLanguage;
  session.promptSettings = promptSettingsRecord(sections);
  delete session.promptSettingsNotice;
  delete session.promptSettingsTold;
  delete session.promptSettingsRecheck;
}

/**
 * A compaction dropped the notices the model was told — acknowledged ones and
 * a pending one the running turn may already carry (its acknowledgement at
 * settlement then finds nothing). A Lead or bot thread folds its settings
 * into the rebuilt prompt instead; a session whose prompt is never rebuilt (a
 * delegated worker) is told the difference from its prompt again at the next
 * reconcile, in compact form (names and pointers).
 */
export function rearmPromptSettingsNotice(session) {
  if (session?.promptIdentity && !isAgentOwner(session)) return false;
  if (!session?.promptSettingsTold && !session?.promptSettingsNotice) return false;
  delete session.promptSettingsTold;
  delete session.promptSettingsNotice;
  session.promptSettingsRecheck = 'compact';
  return true;
}
