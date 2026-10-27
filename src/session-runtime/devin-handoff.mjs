/**
 * `/handoff`: write a handoff file the Devin CLI can continue from
 * (`devin --prompt-file <file>`), then optionally start it. The file is a
 * summary a new task starts from — not a restore of internal Mixdog state.
 * Everything in it comes from session evidence (the goal record, the
 * transcript, the working tree); what could not be verified says so.
 *
 * Files live under `<data>/handoffs/` — outside any project, so they never
 * pollute a working tree or get committed by accident.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePluginData } from '../runtime/shared/plugin-paths.mjs';

const MAX_REPLY_CHARS = 4000;
const MAX_USER_CHARS = 2000;
const MAX_FILES = 100;
const MAX_GIT_LINES = 200;
// Tool calls whose arguments name files the session changed.
const EDIT_TOOLS = new Set(['edit', 'apply_patch', 'write', 'office', 'media']);
const FILE_ARG_KEYS = new Set(['file_path', 'filePath', 'path', 'files', 'filePaths', 'paths']);
const SETTLED_TASK_STATUSES = new Set(['completed', 'done', 'dropped', 'cancelled']);

// Runtime-injected envelopes stored as user messages are not user requests.
const ENVELOPE_RE = /^<(?:system-reminder|task-notification|mixdog-runtime|archived-task)[\s>]/;

const messageText = (message) => {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('\n')
      .trim();
  }
  return '';
};

const firstUserText = (messages) => {
  const found = messages.find((m) => {
    const text = m?.role === 'user' ? messageText(m) : '';
    return text && !ENVELOPE_RE.test(text);
  });
  const text = found ? messageText(found) : '';
  return text.length > MAX_USER_CHARS ? `${text.slice(0, MAX_USER_CHARS)}\n…` : text;
};

const lastAssistantText = (messages) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== 'assistant') continue;
    const text = messageText(messages[i]);
    if (text) return text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}\n…` : text;
  }
  return '';
};

/** Files named in this session's edit/write tool calls, first-seen order. */
function editedFiles(messages) {
  const files = new Set();
  for (const message of messages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.toolCalls)) continue;
    for (const call of message.toolCalls) {
      if (!EDIT_TOOLS.has(String(call?.name || ''))) continue;
      const args = call?.arguments;
      if (!args || typeof args !== 'object') continue;
      for (const [key, value] of Object.entries(args)) {
        if (!FILE_ARG_KEYS.has(key)) continue;
        for (const entry of Array.isArray(value) ? value : [value]) {
          if (typeof entry === 'string' && entry.trim()) files.add(entry.trim());
        }
      }
      if (files.size >= MAX_FILES) return [...files];
    }
  }
  return [...files];
}

/** `git status --porcelain` lines, or why the check is unavailable. */
function workingTree(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const lines = out.split('\n').filter((line) => line.trim());
    return { lines: lines.slice(0, MAX_GIT_LINES), truncated: lines.length > MAX_GIT_LINES };
  } catch (error) {
    const stderr = String(error?.stderr || '');
    return { error: /not a git repository/i.test(stderr) ? 'not a git repository' : 'git unavailable' };
  }
}

const taskMark = (status) => (SETTLED_TASK_STATUSES.has(String(status || '')) ? '[x]' : '[ ]');
const pendingTasks = (tasks) => (Array.isArray(tasks) ? tasks : []).filter((t) => !SETTLED_TASK_STATUSES.has(String(t?.status || '')));

function handoffMarkdown({ session, cwd, goal, files, git }) {
  const lines = [];
  lines.push(`# Handoff — Mixdog session ${session.id}`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Project directory: ${cwd || '(unknown)'}`);
  lines.push('This is a summary for continuing the work in a new session, not a saved runtime state.');
  lines.push('');
  lines.push('## Objective');
  lines.push('');
  lines.push(goal?.objective || firstUserText(session.messages || []) || 'Not recorded.');
  lines.push('');
  lines.push('## Progress');
  lines.push('');
  if (goal) {
    lines.push(`Goal status: ${goal.status}${goal.blocker ? ` (blocker: ${goal.blocker})` : ''}`);
    for (const task of Array.isArray(goal.tasks) ? goal.tasks : []) {
      lines.push(`- ${taskMark(task.status)} ${task.text}${task.status ? ` (${task.status})` : ''}`);
    }
  } else {
    lines.push('No goal was recorded for this session.');
  }
  const reply = lastAssistantText(session.messages || []);
  if (reply) {
    lines.push('');
    lines.push('Latest agent reply:');
    lines.push('');
    lines.push(reply);
  }
  lines.push('');
  lines.push('## Files this session edited');
  lines.push('');
  if (files.length) {
    for (const file of files) lines.push(`- ${file}`);
  } else {
    lines.push('None recorded.');
  }
  lines.push('(From this session’s edit/write tool calls; files changed by shell commands are not listed here.)');
  lines.push('');
  lines.push('## Working tree state');
  lines.push('');
  if (git.error) {
    lines.push(`Unavailable: ${git.error}.`);
  } else if (!git.lines.length) {
    lines.push('Clean (git status --porcelain).');
  } else {
    lines.push('```');
    for (const line of git.lines) lines.push(line);
    if (git.truncated) lines.push(`… truncated at ${MAX_GIT_LINES} entries`);
    lines.push('```');
  }
  lines.push('Note: the working tree may contain changes made outside this session.');
  lines.push('');
  lines.push('## Remaining work');
  lines.push('');
  const remaining = pendingTasks(goal?.tasks);
  if (remaining.length) {
    for (const task of remaining) lines.push(`- [ ] ${task.text}`);
  } else {
    lines.push('Not recorded — check the session history or the repository state.');
  }
  lines.push('');
  lines.push('## Continue');
  lines.push('');
  lines.push('You are continuing this work as a new task in the project directory above.');
  lines.push('Treat this file as a briefing: verify the current state of the files and the');
  lines.push('working tree first, then finish the remaining work.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

const wslPath = (path) => {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(String(path));
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}` : String(path);
};
const shQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const winQuote = (value) => (/[\s"']/.test(value) ? `"${String(value).replaceAll('"', '\\"')}"` : value);

/** The devin invocation for this platform: process args plus its display form. */
function devinCommand({ cwd, file, env }) {
  if (process.platform === 'win32') {
    const distro = String(env.MIXDOG_DEVIN_WSL_DISTRO || '').trim();
    const args = [
      ...(distro ? ['-d', distro] : []),
      ...(cwd ? ['--cd', cwd] : []),
      '--',
      'bash',
      '-lc',
      `devin --prompt-file ${shQuote(wslPath(file))}`,
    ];
    return { exe: 'wsl.exe', args, display: `wsl.exe ${args.map(winQuote).join(' ')}` };
  }
  const display = cwd
    ? `cd ${shQuote(cwd)} && devin --prompt-file ${shQuote(file)}`
    : `devin --prompt-file ${shQuote(file)}`;
  return { exe: null, args: [], display };
}

/** Open devin in a new console window (Windows `start`). True when spawned. */
function launchDevinWindow({ cwd, file, env }) {
  const { exe, args } = devinCommand({ cwd, file, env });
  if (!exe) return false;
  const result = spawnSync('cmd.exe', ['/c', 'start', '', exe, ...args], {
    stdio: 'ignore',
    timeout: 15_000,
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

export function createDevinHandoffApi(deps) {
  return {
    /**
     * `{launch}`: 'auto' opens devin in a new console window on Windows
     * (elsewhere it only reports the command); 'none' returns the command for
     * the caller to run — the desktop enters it in the session terminal.
     */
    async devinHandoff(args = {}) {
      const session = deps.getSession();
      if (!session?.id) return { ok: false, error: 'no-session' };
      const cwd = session.cwd || deps.getCurrentCwd?.() || null;
      const goal = deps.goalSnapshotFor ? deps.goalSnapshotFor(session.id) || null : null;
      const dir = join(resolvePluginData(), 'handoffs');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `handoff-${session.id.slice(-12)}-${Date.now()}.md`);
      writeFileSync(
        file,
        handoffMarkdown({ session, cwd, goal, files: editedFiles(session.messages || []), git: workingTree(cwd || process.cwd()) }),
        'utf8'
      );
      const command = devinCommand({ cwd, file, env: process.env }).display;
      const launch = args?.launch === undefined ? 'auto' : String(args.launch);
      const launched = launch === 'auto' && cwd ? launchDevinWindow({ cwd, file, env: process.env }) : false;
      return { ok: true, path: file, command, cwd, launched };
    },
  };
}
