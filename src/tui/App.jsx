/**
 * App.jsx — the React/ink chat application.
 *
 * Layout (top → bottom):
 *   welcome banner
 *   transcript (finished items, a live column — terminal scrolls older rows off)
 *   live reasoning (◈ Thinking… — only while a turn streams)
 *   spinner / TurnDone (while a turn runs / just finished)
 *   slash/model pickers (attached above the prompt)
 *   queued steering prompts + rounded prompt input (one cluster)
 *   statusline (vendored L1/L2)
 *
 * State comes from the engine store via useEngine; submitting a line calls
 * store.submit() (or handles a slash command locally). The whole tree is live
 * (no <Static>): full-width bands and the native hardware caret both need real
 * layout, which <Static> collapses. The terminal handles scrollback itself as
 * the transcript column grows past the screen height.
 */
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import React, { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { theme, surfaceBackground, TURN_MARKER, RESULT_GUTTER } from './theme.mjs';
import { useEngine } from './hooks/useEngine.mjs';
import {
  measureMarkdownRenderedRows,
  measureStreamingMarkdownRenderedRows,
} from './markdown/measure-rendered-rows.mjs';
import { streamingLayoutText } from './markdown/streaming-markdown.mjs';
import { displayWidth } from './display-width.mjs';
import { classifyToolCategory, formatToolSurface, normalizeToolName, parseToolArgs, summarizeAgentSurfaceBrief } from '../runtime/shared/tool-surface.mjs';
import { isBackgroundErrorOnlyBody } from '../runtime/shared/err-text.mjs';
import { AssistantMessage, UserMessage, NoticeMessage } from './components/Message.jsx';
import { ToolExecution } from './components/ToolExecution.jsx';
import { formatExpandedResult, wrapExpandedResultLines } from './components/tool-output-format.mjs';
import { Spinner } from './components/Spinner.jsx';
import { StatusDone, TurnDone } from './components/TurnDone.jsx';
import { ItemRightHintOverprint } from './components/ItemRightHintOverprint.jsx';
import { StatusLine } from './components/StatusLine.jsx';
import { PromptInput } from './components/PromptInput.jsx';
import { QueuedCommands } from './components/QueuedCommands.jsx';
import { Picker } from './components/Picker.jsx';
import { SlashCommandPalette } from './components/SlashCommandPalette.jsx';
import { ContextPanel } from './components/ContextPanel.jsx';
import { UsagePanel } from './components/UsagePanel.jsx';
import { TextEntryPanel } from './components/TextEntryPanel.jsx';
import {
  buildPromptContentWithImages,
  formatImageRef,
  imageReferenceIds,
  readClipboardImageAttachment,
  readImageAttachmentFromPath,
  splitPastedImagePathCandidates,
} from './paste-attachments.mjs';
import { formatDuration } from './time-format.mjs';
import {
  listProjects,
  addProject,
  touchProjectSelected,
  renameProject,
  isDirectory,
  pathExists,
  ensureDir,
  resolveProjectPath,
} from '../standalone/projects.mjs';
import { pickFolder } from '../standalone/folder-dialog.mjs';
import {
  formatHookDenialDetail,
  isHookApprovalDenialToolItem,
  shouldSuppressFullyFailedToolItem,
  toolItemResultText,
} from './transcript-tool-failures.mjs';
import {
  toggleVoice,
  isVoiceEnabled,
  getRecorderState,
  startRecording,
  stopRecording,
  cancelRecording,
  disposeRecorder,
} from './lib/voice-recorder.mjs';

import { displayModelName } from '../ui/model-display.mjs';
import { supportsExtendedKeys, ENABLE_KITTY_KEYBOARD, ENABLE_MODIFY_OTHER_KEYS } from './keyboard-protocol.mjs';

const MOUSE_TRACKING_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const MOUSE_TRACKING_OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';
const MOUSE_MODIFIER_MASK = 4 | 8 | 16;
const MOUSE_CTRL_MASK = 16;
// Bit 2 (4) of the SGR button byte = shift held during the click. Wheel/ctrl
// masking above intentionally strips it for scroll routing; button-press
// handling below reads it separately (before baseButton = button & 3 drops
// every modifier bit) so a shift-held left-click can extend an existing
// selection instead of starting a fresh one.
const MOUSE_SHIFT_MASK = 4;
// SEARCH_DEFAULT marker — mirrors backend SEARCH_DEFAULT_PROVIDER/MODEL
// (mixdog-session-runtime.mjs 1167-1168). A search route of {provider:'default',
// model:'default'} means "follow the Main Model" at runtime (nativeSearchRoutes).
const SEARCH_DEFAULT_ROUTE = Object.freeze({ provider: 'default', model: 'default' });
const isSearchDefaultRoute = (route) =>
  String(route?.provider || '').toLowerCase() === 'default'
  && String(route?.model || '').toLowerCase() === 'default';

const SLASH_COMMANDS = [
  { name: 'clear', usage: '/clear', aliases: ['new'], aliasUsage: ['new'], description: 'Start a fresh chat' },
  { name: 'project', usage: '/project', aliases: ['projects'], aliasUsage: ['projects'], showAliasUsage: false, description: 'Switch working directory (project)' },
  { name: 'compact', usage: '/compact', description: 'Compact older conversation context' },
  { name: 'autoclear', usage: '/autoclear', description: 'Reduce cache-miss cost after long idle gaps' },
  { name: 'resume', usage: '/resume', description: 'Resume a saved chat' },
  { name: 'context', usage: '/context', description: 'Show current context surface' },
  { name: 'usage', usage: '/usage', params: '[refresh]', description: 'Show total provider quota / balance' },
  { name: 'model', usage: '/model', description: 'Switch model for subsequent turns' },
  { name: 'search', usage: '/search', description: 'Set the web search provider/model' },
  { name: 'workflow', usage: '/workflow', description: 'Switch the active workflow' },
  { name: 'outputstyle', usage: '/OutputStyle', aliases: ['output-style', 'style'], aliasUsage: ['style'], showAliasUsage: false, params: '[name]', description: 'Switch Lead output style' },
  { name: 'theme', usage: '/theme', params: '[id]', description: 'Change the TUI color theme' },
  { name: 'agents', usage: '/agents', description: 'Show available workflow agents' },
  { name: 'effort', usage: '/effort', params: '[level]', description: 'Set reasoning effort for the current model' },
  { name: 'fast', usage: '/fast', params: '[on|off]', description: 'Toggle Fast mode for the current model' },
  { name: 'mcp', usage: '/mcp', description: 'Manage MCP servers and tools' },
  { name: 'skills', usage: '/skills', description: 'Choose a skill for the next request' },
  { name: 'memory', usage: '/memory', description: 'Memory status, core memories, cycles' },
  { name: 'plugins', usage: '/plugins', description: 'Manage local plugin integrations' },
  { name: 'hooks', usage: '/hooks', description: 'Manage before-tool hook rules and events' },
  { name: 'providers', usage: '/providers', description: 'Manage auth, API keys, OAuth, and local endpoints' },
  { name: 'channels', usage: '/channels', description: 'Manage Discord, channels, schedules, webhooks' },
  { name: 'remote', usage: '/remote', description: 'Toggle Discord remote mode for this session' },
  { name: 'schedules', usage: '/schedules', description: 'Manage schedules' },
  { name: 'webhooks', usage: '/webhooks', description: 'Manage inbound webhooks' },
  { name: 'settings', usage: '/setting', aliases: ['setting', 'config'], aliasUsage: ['settings', 'config'], showAliasUsage: false, description: 'Open runtime settings' },
  { name: 'profile', usage: '/profile', description: 'Set your title and response language' },
  { name: 'update', usage: '/update', description: 'Check version and update mixdog' },
  { name: 'voice', usage: '/voice', description: 'Toggle voice input (Ctrl+Space to record)' },
  { name: 'quit', usage: '/quit', aliases: ['exit', 'q'], aliasUsage: ['exit', 'q'], description: 'Quit the TUI' },
];

function slashQuery(value) {
  const text = String(value ?? '');
  if (!/^\/[^\s]*$/.test(text)) return null;
  return text.slice(1).toLowerCase();
}

function slashCommandMatches(command, query) {
  const needle = String(query || '').toLowerCase();
  if (!needle) return true;
  if (String(command?.name || '').toLowerCase().startsWith(needle)) return true;
  return (command?.aliases || []).some((alias) => String(alias || '').toLowerCase().startsWith(needle));
}

function compareSlashCommands(a, b) {
  return String(a?.name || '').localeCompare(String(b?.name || ''), 'en', { sensitivity: 'base' });
}

/** Prompt-owned overlays absorb PageUp/PageDown and wheel scroll instead of the transcript. */
function overlayBlocksGlobalTranscriptScroll(owner = {}) {
  return !!(
    owner.slashPaletteOpen ||
    owner.picker ||
    owner.toolApproval ||
    owner.contextPanel ||
    owner.usagePanel ||
    owner.providerPrompt ||
    owner.channelPrompt ||
    owner.hookPrompt ||
    owner.settingsPrompt
  );
}

function normalizeSlashCommandName(cmd) {
  const name = String(cmd || '').toLowerCase();
  const command = SLASH_COMMANDS.find((item) => item.name === name || (item.aliases || []).includes(name));
  return command?.name || name;
}

function slashCommandTokenForPaletteAccept(command, draftValue = '') {
  if (!command) return '';
  const text = String(draftValue ?? '').trim();
  const typedToken = text.startsWith('/') ? text.slice(1).split(/\s+/)[0]?.toLowerCase() : '';
  const canonical = String(command.name || '').toLowerCase();
  const aliases = (command.aliases || []).map((alias) => String(alias || '').toLowerCase());
  if (typedToken && (typedToken === canonical || aliases.includes(typedToken))) {
    return typedToken;
  }
  return command.name;
}

function slashCommandForName(cmd) {
  const name = normalizeSlashCommandName(cmd);
  return SLASH_COMMANDS.find((item) => item.name === name) || null;
}

function slashArgumentHint(value) {
  const text = String(value ?? '');
  const match = text.match(/^\/([^\s]+)\s+$/);
  if (!match) return '';
  const command = slashCommandForName(match[1]);
  return command?.params ? `${command.usage} ${command.params}` : '';
}

function terminalSize(stdout) {
  return {
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  };
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function wrappedTextRows(value, width) {
  const w = Math.max(1, Math.floor(Number(width) || 1));
  let row = 0;
  let col = 0;
  for (const { segment } of graphemeSegmenter.segment(String(value ?? ''))) {
    if (segment === '\n') {
      row += 1;
      col = 0;
      continue;
    }
    const segmentWidth = stringWidth(segment);
    if (segmentWidth === 0) continue;
    if (col > 0 && col + segmentWidth > w) {
      row += 1;
      col = 0;
    }
    col += segmentWidth;
    if (col >= w) {
      row += Math.floor(col / w);
      col %= w;
    }
  }
  return row + 1;
}

function promptContentRows(value, contentColumns) {
  // PromptInput appends a blank trailing cell when the caret is at end-of-input
  // so the native cursor always has a rendered cell. App does not own the cursor
  // offset, so reserve for the worst common case: caret at the end. This can
  // over-reserve by one row at exact wrap boundaries, but never under-reserves
  // and therefore prevents transcript rows from bleeding into the prompt box.
  return wrappedTextRows(`${String(value ?? '')} `, contentColumns);
}

function clean(value) {
  return String(value ?? '').trim();
}

function projectNameFromPath(value) {
  const text = String(value || '').replace(/[\\/]+$/, '');
  return text.split(/[\\/]/).pop() || text || '(current)';
}

function workflowDisplayName(workflow = {}) {
  return clean(workflow?.name || workflow?.id) || 'Default';
}

function workflowSwitchNotice(workflow = {}) {
  return 'Workflow updated · new sessions';
}

function modelSwitchNotice() {
  return 'Model updated · new sessions';
}

function compactJson(value, max = 180) {
  let text = '';
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value ?? '');
  }
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return stringWidth(text) > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function toolApprovalDescription(request = {}) {
  const surface = formatToolSurface(request.name, request.args);
  const summary = surface?.summary ? `${surface.label || request.name} (${surface.summary})` : (surface?.label || request.name || 'tool');
  const reason = clean(request.reason) || 'Hook requested approval.';
  const args = compactJson(request.args);
  return [
    summary ? `Tool: ${summary}` : '',
    reason ? `Reason: ${reason}` : '',
    args ? `Args: ${args}` : '',
  ].filter(Boolean).join('\n');
}

function providerStatusLabel(provider = {}) {
  const status = clean(provider.status);
  if (status) return status;
  if (provider.enabled || provider.authenticated) return 'Set';
  if (provider.detected) return 'Detected';
  return 'Off';
}

function providerDetailText(provider = {}) {
  const detail = clean(provider.detail);
  if (detail) return detail;
  if (provider.env && provider.envName) return `env: ${provider.envName}`;
  if (provider.envName) return provider.envName;
  if (provider.baseURL) return provider.baseURL;
  if (provider.desc) return provider.desc;
  return '';
}

function providerKindLabel(provider = {}) {
  if (provider.type === 'oauth') return 'OAuth';
  if (provider.type === 'local') return 'Local endpoint';
  return 'API key';
}

function formatSessionUpdatedAt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '--:--';
  const date = new Date(n);
  if (Number.isNaN(date.getTime())) return '--:--';
  const now = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${time}`
    : `${date.getFullYear()}-${day} ${time}`;
}

function formatSessionMessageCount(count) {
  const n = Number(count || 0);
  return `${Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0} msg${n === 1 ? '' : 's'}`;
}

function parseHookRuleInput(text) {
  const parts = String(text || '').split('|').map((part) => part.trim());
  const [tool, actionRaw, match, reason, patchText] = parts;
  const action = String(actionRaw || '').toLowerCase();
  if (!tool || !action) return { error: 'usage: tool | allow|deny|modify | match(optional) | reason(optional) | json patch(optional)' };
  if (!['allow', 'deny', 'block', 'modify', 'rewrite'].includes(action)) {
    return { error: 'hook action must be allow, deny, block, modify, or rewrite' };
  }
  const rule = { tool, action };
  if (match) rule.match = match;
  if (reason) rule.reason = reason;
  if (patchText) {
    try {
      const patch = JSON.parse(patchText);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: 'json patch must be an object' };
      rule.patch = patch;
    } catch (e) {
      return { error: `invalid json patch: ${e?.message || e}` };
    }
  }
  if ((action === 'modify' || action === 'rewrite') && !rule.patch) {
    return { error: 'modify/rewrite needs a json patch object in the last field' };
  }
  return { rule };
}

function parseMcpServerInput(text) {
  const parts = String(text || '').split('|').map((part) => part.trim());
  const [name, commandOrUrl, argsText = '', cwd = ''] = parts;
  if (!name || !commandOrUrl) return { error: 'usage: name | command-or-url | args(optional) | cwd(optional)' };
  if (/^(?:https?|wss?):\/\//i.test(commandOrUrl)) return { server: { name, url: commandOrUrl } };
  return {
    server: {
      name,
      command: commandOrUrl,
      args: argsText.split(/\s+/).filter(Boolean),
      cwd,
    },
  };
}

function parseSkillInput(text) {
  const parts = String(text || '').split('|').map((part) => part.trim());
  const [name, description = 'Project skill.'] = parts;
  if (!name) return { error: 'usage: name | description(optional)' };
  return { skill: { name, description } };
}

function parseMemoryCommand(text) {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
  const action = parts[0] || 'status';
  const out = { action };
  for (const part of parts.slice(1)) {
    const [key, ...rest] = part.split('=');
    if (!key || rest.length === 0) continue;
    const raw = rest.join('=');
    const num = Number(raw);
    out[key] = Number.isFinite(num) && raw.trim() !== '' ? num : raw;
  }
  return out;
}

function parseMemoryStatusRows(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const sep = line.indexOf(':');
      const label = sep === -1 ? line : line.slice(0, sep);
      const description = sep === -1 ? '' : line.slice(sep + 1).trim();
      return {
        value: `status-${index}`,
        label,
        description,
        _line: line,
      };
    });
}

function parseMemoryCoreRows(text) {
  let currentProjectId = null;
  return String(text || '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      const raw = line.trim();
      if (raw.endsWith(':') && !raw.includes('id=')) {
        const label = raw.slice(0, -1);
        currentProjectId = label === 'COMMON' ? null : label;
        return {
          value: `core-group-${index}`,
          label,
          description: 'core memory pool',
          _line: raw,
          _group: true,
        };
      }
      const match = raw.match(/^id=(\d+)\s+\[([^\]]*)\]\s+(.+?)(?:\s+—\s+(.+))?$/);
      if (match) {
        const [, id, category, element, summary = ''] = match;
        return {
          value: `core-${id}`,
          label: `#${id} [${category}] ${element}`,
          meta: currentProjectId || 'common',
          description: summary,
          _line: raw,
          _action: 'core-entry',
          _id: Number(id),
          _category: category,
          _element: element,
          _summary: summary,
          _projectId: currentProjectId,
        };
      }
      return {
        value: `core-${index}`,
        label: raw,
        description: '',
        _line: raw,
      };
    });
}

function parseMemoryCandidateRows(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      const raw = line.trim();
      const match = raw.match(/^id=(\d+)\s+\[([^\]]*)\]\s+(.+?)(?:\s+—\s+(.+))?$/);
      if (match) {
        const [, id, category, element, summary = ''] = match;
        return {
          value: `candidate-${id}`,
          label: `#${id} [${category}] ${element}`,
          description: summary,
          _line: raw,
          _action: 'candidate-entry',
          _id: Number(id),
        };
      }
      return {
        value: `candidate-${index}`,
        label: raw,
        description: '',
        _line: raw,
      };
    });
}

function fitLine(value, columns, reserve = 4) {
  const text = String(value || '');
  const width = Math.max(1, Number(columns || 80) - reserve);
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text;
}

function centerLine(value, columns, reserve = 0) {
  const text = fitLine(value, columns, reserve);
  const width = Math.max(1, Number(columns || 80) - reserve);
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return `${' '.repeat(pad)}${text}`;
}

const WELCOME_PROMPT_HINTS = [
  'Tip: /setting · Tune the runtime before the run.',
  'Tip: /model · Pick the right brain for the job.',
  'Tip: /workflow · Change how work gets routed.',
  'Tip: Ctrl+O · Expand tool output when you need details.',
  'Tip: PageUp/PageDown · Scroll the transcript.',
  'Tip: Esc · Close panels or interrupt work.',
  'Tip: /usage · Check quota before a long run.',
  'Tip: /agents · See who can help.',
  'Tip: /theme · Change the terminal mood.',
  'Tip: /search · Set web search routing.',
  'Paste an error. I’ll trace it.',
  'Tell me the goal. I’ll handle the steps.',
  'Start with a task, a bug, or a wild idea.',
  'Good fixes start with a repro.',
  'Ask for a plan, then let the agents work.',
  'Small prompt, sharp result.',
  'Drop in a file path and ask what changed.',
  'Describe the outcome, not just the command.',
  'Ready when you are.',
  'One clear goal beats ten vague tasks.',
];

const CONDITIONAL_WELCOME_PROMPT_HINTS = {
  noProvider: 'Tip: /providers · Connect a provider before your first turn.',
  noModel: 'Tip: /model · Choose a model before your first turn.',
  soloWorkflow: 'Tip: /workflow · Switch from Solo when you want agents.',
  searchDefaultUnsupported: 'Tip: /search · Choose a native search model for this main model.',
  error: 'Tip: /doctor · Check setup health. (coming soon)',
};

function randomWelcomePromptHint() {
  const index = Math.floor(Math.random() * WELCOME_PROMPT_HINTS.length);
  return WELCOME_PROMPT_HINTS[index] || WELCOME_PROMPT_HINTS[0] || '';
}

function providerSetupHasUsableProvider(setup = {}) {
  const rows = [
    ...(Array.isArray(setup.api) ? setup.api : []),
    ...(Array.isArray(setup.oauth) ? setup.oauth : []),
    ...(Array.isArray(setup.local) ? setup.local : []),
  ];
  return rows.some((row) => (
    row?.authenticated === true
    || row?.enabled === true
    || row?.stored === true
    || row?.env === true
    || row?.detected === true
  ));
}

function activeWorkflowSummaryForStore(store, workflow = {}) {
  try {
    const workflows = store.listWorkflows?.() || [];
    return workflows.find((item) => item.active)
      || workflows.find((item) => item.id === workflow?.id)
      || null;
  } catch {
    return null;
  }
}

function promptStatusColor(tone) {
  if (tone === 'error') return theme.error;
  if (tone === 'warn' || tone === 'cancel') return theme.warning;
  if (tone === 'plain') return theme.subtle;
  return theme.inactive;
}

function promptHistoryKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function osc52ClipboardSequence(text) {
  const b64 = Buffer.from(String(text ?? ''), 'utf8').toString('base64');
  const raw = `\x1b]52;c;${b64}\x07`;
  if (!process.env.TMUX) return raw;
  return `\x1bPtmux;${raw.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`;
}

function writeOsc52Clipboard(text) {
  try {
    process.stdout.write(osc52ClipboardSequence(text));
    return true;
  } catch {
    return false;
  }
}

function nativeClipboardCommand(text) {
  if (process.platform === 'win32') {
    // Do not use clip.exe here: it decodes stdin with the system code page on
    // many Windows setups, which turns UTF-8 glyphs like `·` into mojibake.
    // Send base64 ASCII through stdin and let PowerShell decode UTF-8 before
    // calling Set-Clipboard.
    return {
      cmd: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$b=[Console]::In.ReadToEnd();$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b));Set-Clipboard -Value $t',
      ],
      input: Buffer.from(String(text ?? ''), 'utf8').toString('base64'),
    };
  }
  if (process.platform === 'darwin') return { cmd: 'pbcopy', args: [], input: text };
  if (process.env.WAYLAND_DISPLAY) return { cmd: 'wl-copy', args: [], input: text };
  return { cmd: 'xclip', args: ['-selection', 'clipboard'], input: text };
}

// Copy text to the OS clipboard: send OSC 52 to the
// terminal, then use a native helper as a local safety net. OSC 52 preserves
// Unicode via base64; the Windows helper avoids clip.exe's code-page mojibake.
function copyToClipboard(text) {
  const value = String(text ?? '');
  const wroteOsc52 = writeOsc52Clipboard(value);
  return new Promise((resolve, reject) => {
    const { cmd, args, input } = nativeClipboardCommand(value);
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    } catch (e) {
      if (wroteOsc52) resolve();
      else reject(e);
      return;
    }
    child.on('error', (e) => {
      if (wroteOsc52) resolve();
      else reject(e);
    });
    child.on('close', (code) => {
      if (code === 0 || wroteOsc52) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    child.stdin.on('error', () => { /* ignore EPIPE if the helper closed early */ });
    child.stdin.end(input);
  });
}

const SKILL_SURFACE_NAMES = new Set([
  'skill', 'skill_execute', 'skill_view', 'skills_list', 'use_skill',
]);

function isAgentResponseResultText(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/^status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled)(?:\s*·\s*task_id:\s*\S+)?$/i.test(value)) return false;
  if (/^(?:background task\b|agent task:|task_id:)/i.test(value) && !/\n\s*\n[\s\S]*\S/.test(value)) return false;
  return true;
}

function ToolHookDenialCard({ item, columns = 80 }) {
  const { label, summary } = formatToolSurface(item.name, item.args);
  const detail = formatHookDenialDetail(toolItemResultText(item));
  const safeLabel = stripAnsi(String(label || '')).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  const safeSummary = stripAnsi(String(summary || '')).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  const safeDetail = stripAnsi(String(detail || '')).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  const summaryText = safeSummary ? ` (${safeSummary})` : '';
  const rowWidth = Math.max(1, Number(columns || 80));
  const detailWidth = Math.max(1, rowWidth - stringWidth(RESULT_GUTTER));
  return (
    <Box flexDirection="column" marginTop={1} width={rowWidth} overflow="hidden">
      <Box flexDirection="row" width={rowWidth} overflow="hidden">
        <Box flexShrink={0} minWidth={2}>
          <Text color={theme.error}>{TURN_MARKER}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} overflow="hidden" minWidth={0}>
          <Text wrap="truncate">
            <Text bold color={theme.text}>{safeLabel}</Text>
            {summaryText ? <Text color={theme.text}>{summaryText}</Text> : null}
            <Text color={theme.error}> · Denied</Text>
          </Text>
        </Box>
      </Box>
      {safeDetail ? (
        <Box flexDirection="row" width={rowWidth} overflow="hidden">
          <Box flexShrink={0} width={stringWidth(RESULT_GUTTER)}>
            <Text color={theme.subtle}>{RESULT_GUTTER}</Text>
          </Box>
          <Box flexShrink={0} width={detailWidth} overflow="hidden">
            <Text color={theme.error} wrap="truncate">{safeDetail}</Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

// `themeEpoch` is read but not used in the body: it is a memo-busting prop. The
// active theme mutates `theme` in-place, so a switch must force every mounted
// transcript row (which reads theme.* directly) to re-render. Threading the
// epoch through Item → AssistantMessage/UserMessage/ToolExecution breaks
// React.memo's shallow equality on a theme change without a broad refactor.
const Item = React.memo(function Item({ item, prevKind, columns, toolOutputExpanded, rightMessage = '', rightTone = 'info', rightMessageWidth = 24, themeEpoch = 0 }) {
  const hintOnTurnDoneRow = item.kind === 'turndone' || item.kind === 'statusdone';
  let node = null;
  switch (item.kind) {
    case 'user':
      node = <UserMessage text={item.text} attached={prevKind === 'user'} columns={columns} themeEpoch={themeEpoch} />;
      break;
    case 'assistant':
      node = <AssistantMessage text={item.text} streaming={item.streaming} columns={columns} themeEpoch={themeEpoch} assistantId={item.id} />;
      break;
    case 'tool': {
      if (shouldSuppressFullyFailedToolItem(item)) return null;
      if (isHookApprovalDenialToolItem(item)) {
        node = <ToolHookDenialCard item={item} columns={columns} />;
        break;
      }
      node = <ToolExecution name={item.name} args={item.args} result={item.result} rawResult={item.rawResult} isError={item.isError} errorCount={item.errorCount} expanded={toolOutputExpanded || item.expanded} columns={columns} attached={false} count={item.count} completedCount={item.completedCount} startedAt={item.startedAt} completedAt={item.completedAt} aggregate={item.aggregate} categories={item.categories} headerFinalized={item.headerFinalized} deferredDisplayReady={item.deferredDisplayReady} themeEpoch={themeEpoch} />;
      break;
    }
    case 'notice':
      node = <NoticeMessage text={item.text} tone={item.tone} columns={columns} />;
      break;
    case 'turndone':
      node = <TurnDone elapsedMs={item.elapsedMs} status={item.status} outputTokens={item.outputTokens} thinkingElapsedMs={item.thinkingElapsedMs} verb={item.verb} rightMessage={rightMessage} rightTone={rightTone} rightMessageWidth={rightMessageWidth} />;
      break;
    case 'statusdone':
      node = <StatusDone label={item.label} detail={item.detail} rightMessage={rightMessage} rightTone={rightTone} rightMessageWidth={rightMessageWidth} />;
      break;
    default:
      return null;
  }
  if (!node || hintOnTurnDoneRow || !rightMessage) return node;
  return (
    <ItemRightHintOverprint
      rightMessage={rightMessage}
      rightTone={rightTone}
      rightMessageWidth={rightMessageWidth}
    >
      {node}
    </ItemRightHintOverprint>
  );
});

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

// Per-keystroke render cost is proportional to the number of MOUNTED transcript
// items: ink's renderNodeToOutput still serializes (squashTextNodes/wrapText/
// output.write) every child even when an overflow:hidden viewport clips it
// off-screen — clipping only trims write coordinates, not the serialization. So
// the only lever for typing latency on a tall transcript is mounting fewer
// rows. The window keeps a small ITEM floor (so a few items stay mounted for
// stable scroll/overscan) but is otherwise driven by the viewport+overscan ROW
// span, not a large fixed item count. All three are env-tunable for A/B / revert.
const TRANSCRIPT_WINDOW_MIN_ITEMS = positiveIntEnv('MIXDOG_TUI_TRANSCRIPT_WINDOW_MIN_ITEMS', 12);
const TRANSCRIPT_WINDOW_OVERSCAN_ROWS = positiveIntEnv('MIXDOG_TUI_TRANSCRIPT_OVERSCAN_ROWS', 16);

// Hard cap on simultaneously MOUNTED transcript items. Every mounted child is
// fully serialized by ink each frame (clipping only trims write coords, not the
// serialize pass), so this cap is the dominant lever for per-frame render cost
// on a tall transcript. The viewport+overscan ROW span already drives the
// window; this cap only bounds the worst case (many short rows). 180 mounted
// rows is far more than any viewport needs and made each frame serialize a long
// tail of off-screen rows, so lower it to a value that still comfortably covers
// viewport + overscan on a large terminal. Env-tunable for A/B / revert.
const TRANSCRIPT_WINDOW_MAX_ITEMS = positiveIntEnv('MIXDOG_TUI_TRANSCRIPT_WINDOW_ITEMS', 80);
const SELECTION_PAINT_INTERVAL_MS = positiveIntEnv('MIXDOG_TUI_SELECTION_PAINT_MS', 24);
const PROMPT_HISTORY_LIMIT = 50;

// Parse a boolean env var that DEFAULTS ON. Any of 0/false/off/no (case-
// insensitive, trimmed) disables it; everything else (including unset) leaves it
// on. Used as the kill switch for the app-level measured-height feature below.
function boolEnvDefaultTrue(name) {
  const raw = process.env[name];
  if (raw == null) return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

// App-level measured transcript heights (virtual-scroll height cache). When ON (default), each mounted transcript
// row's REAL Yoga
// getComputedHeight() replaces the row-count ESTIMATE in the scroll/window math,
// so wheel scrolling moves REAL rows and stops juddering ("덜컥거림") on estimate
// error (markdown tables, wrapped long tokens, tool-card growth). Off-screen
// (never-measured) items keep the estimate; the overscan band absorbs that
// residual in the overscan band.
//
// ESCAPE HATCH: set MIXDOG_TUI_TRANSCRIPT_MEASURED to 0/false/off/no to fall
// back to the pure-estimate behavior. The measured path depends on two
// invariants that the estimate is now hand-tuned to satisfy (see
// estimateTranscriptItemRows: the tool branch includes the ToolExecution
// wrapper marginTop so estimate≈measured and no row "settles" by +1), and on
// anchor-aware scroll preservation (see the row-delta effect). If either drifts
// after a UI change and the transcript starts jumping on measure, flip this off
// to restore the previous estimate-only behavior with zero other code changes.
const TRANSCRIPT_MEASURED_ROWS = boolEnvDefaultTrue('MIXDOG_TUI_TRANSCRIPT_MEASURED');

function selectionRectsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.mode === b.mode
    && a.x1 === b.x1
    && a.y1 === b.y1
    && a.x2 === b.x2
    && a.y2 === b.y2
    && a.clipY1 === b.clipY1
    && a.clipY2 === b.clipY2
    && a.captureText === b.captureText;
}

function shiftSelectionRectY(rect, deltaY) {
  const dy = Math.round(Number(deltaY) || 0);
  if (!rect || dy === 0) return rect || null;
  return { ...rect, y1: rect.y1 + dy, y2: rect.y2 + dy };
}

// Reading-order compare (row then col): -1 if a<b, 1 if a>b, 0 equal. Shared by
// buildSpanRect (word/line drag-extension). Module scope so both the mouse
// handler and the auto-scroll path can reach it.
function comparePoints(a, b) {
  if (a.y !== b.y) return a.y < b.y ? -1 : 1;
  if (a.x !== b.x) return a.x < b.x ? -1 : 1;
  return 0;
}

// Count how many terminal rows ONE logical line (no '\n') occupies once ink
// word-wraps it. ink/Yoga break on whitespace (wrap-ansi wordWrap), NOT on a
// hard column count: a word that does not fit the remaining space is pushed
// whole to the next row, so `Math.ceil(width/cols)` UNDER-counts whenever a
// long token (e.g. `src/tui/App.jsx`) straddles a wrap boundary. That
// under-count accumulates over a long transcript and, because the viewport is
// `overflow:hidden` + `justifyContent:flex-end`, the newest assistant row gets
// its TOP wrapped lines clipped (only the last line shows). Mirror the greedy
// word-wrap so the row estimate is never lower than what ink actually renders.
function wrappedLineRows(line, width) {
  const text = String(line);
  const full = displayWidth(text);
  if (full === 0) return 1;
  if (full <= width) return 1;
  let rows = 1;
  let col = 0;
  for (const token of text.split(/(\s+)/)) {
    if (!token) continue;
    const tw = displayWidth(token);
    if (tw === 0) continue;
    if (tw > width) {
      // Over-long unbreakable token: ink hard-splits it across rows.
      if (col > 0) { rows++; col = 0; }
      rows += Math.ceil(tw / width) - 1;
      col = tw % width || width;
      continue;
    }
    if (col + tw > width) { rows++; col = tw; }
    else { col += tw; }
  }
  return Math.max(1, rows);
}

function estimateWrappedRows(text, columns, reserve = 4) {
  const width = Math.max(8, Number(columns || 80) - reserve);
  const lines = String(text ?? '').split('\n');
  return Math.max(1, lines.reduce((sum, line) => sum + wrappedLineRows(line, width), 0));
}

// EXACT assistant-body row measurement (lockstep with Markdown.jsx render).
//
// The old raw-line heuristic (estimateWrappedRows + per-block/table fudge)
// could not see what the renderer actually draws — fenced-code indent + border
// fences, list markers/indent, heading trailing blank rows, and (worst) GFM
// table borders / vertical fallback. That drift caused either a phantom blank
// band (over-estimate) or top-clipping (under-estimate) on streaming answers.
//
// Instead, mirror the render path: `renderTokenAnsiSegments(text)` returns the
// SAME ordered segments <Markdown> emits — one ANSI block per token plus a
// `table` segment carrying the token. The renderer stacks them in a
// `<Box flexDirection="column" gap={1}>`, so the rendered height is:
//   sum(each segment's wrapped line count) + (segments.length - 1)  // gap rows
// where an ANSI segment wraps at the assistant body width (columns-3, see
// AssistantMessage) and a table is measured by the SHARED table-layout module
// (`measureMarkdownTableRows`) at that SAME body width — the renderer passes it
// to MarkdownTable via forceWidth (Markdown.jsx/Message.jsx), so the estimate
// equals MarkdownTable's real line count (horizontal box OR vertical fallback)
// with zero drift, including on win32 where stdout.columns ≠ frameColumns.
//
const BACKGROUND_TASK_TOOL_NAMES = new Set(['explore', 'search', 'shell', 'bash', 'bash_session', 'shell_command', 'task']);

function isBackgroundTaskToolName(normalizedName) {
  return BACKGROUND_TASK_TOOL_NAMES.has(String(normalizedName || '').toLowerCase());
}

function parseBackgroundTaskResultForRows(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const allLines = text.split('\n');
  const start = allLines.findIndex((line) => line.trim() === 'background task');
  if (start < 0) return null;
  const rest = allLines.slice(start + 1);
  const blank = rest.findIndex((line) => !line.trim());
  const headLines = blank >= 0 ? rest.slice(0, blank) : rest;
  const body = blank >= 0 ? rest.slice(blank + 1).join('\n').trim() : '';
  const fields = {};
  for (const line of headLines) {
    const match = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
  }
  const status = String(fields.status || '').toLowerCase();
  const error = String(fields.error || '').trim();
  const errorOnlyBody = isBackgroundErrorOnlyBody(body, error);
  return {
    status,
    body,
    error,
    errorOnlyBody,
    hasResponse: Boolean(body) && !errorOnlyBody && !/^(running|pending|queued)$/i.test(status),
  };
}

function isBackgroundTaskResponseArgsForRows(normalizedName, args = {}) {
  if (!isBackgroundTaskToolName(normalizedName)) return false;
  const type = String(args?.type || args?.action || '').toLowerCase();
  const status = String(args?.status || '').toLowerCase();
  return type === 'result' || type === 'completion' || (/^(completed|cancelled|canceled)$/i.test(status) && Boolean(args?.task_id));
}

// ToolExecution derives its background-task classification from
// formatToolSurface(name, args).args — i.e. parseToolArgs(args), which unwraps a
// JSON string or a `{ input: {...} }` envelope into the flat arg object. The
// row estimate / variant key must read the SAME parsed shape, otherwise a tool
// whose raw `args` is a JSON string or input-wrapped object is mis-classified
// here (raw `args.type` is undefined) while ToolExecution treats it as a
// background response — desyncing the reserved height. Parse once, cheaply, and
// reuse for both the estimate branch and the variant key. parseToolArgs already
// guards malformed input (returns {} / { value } without throwing).
function backgroundArgsForRows(rawArgs) {
  const parsed = parseToolArgs(rawArgs);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function toolItemPendingForRows(item) {
  const count = Math.max(1, Number(item?.count || 1));
  const done = Math.max(0, Math.min(count, Number(item?.completedCount || (item?.result == null ? 0 : count))));
  return done < count;
}

// Mirror ToolExecution displayedResultText for row estimates (agent brief, etc.).
const LEADING_STATUS_MARKER_LINE_RE = /^\[status:\s*[^\]]*\]\s*$/i;

function stripLeadingStatusMarkerFromTextForRows(text) {
  const lines = String(text || '').split('\n');
  if (lines.length > 0 && LEADING_STATUS_MARKER_LINE_RE.test(String(lines[0] ?? '').trim())) lines.shift();
  return lines.join('\n');
}

function toolDisplayedResultTextForRows(item) {
  const rt = item?.result == null ? '' : String(item.result).replace(/\s+$/, '');
  const bgArgs = backgroundArgsForRows(item?.args);
  const backgroundError = String(bgArgs.error || '');
  const errorOnlyResult = Boolean(rt) && isBackgroundErrorOnlyBody(rt, backgroundError);
  const normalizedName = String(normalizeToolName(item?.name) || '').toLowerCase();
  if (!toolItemPendingForRows(item) && isBackgroundTaskToolName(normalizedName)) {
    const meta = parseBackgroundTaskResultForRows(rt);
    if (meta?.hasResponse && String(meta.body || '').trim()) {
      return stripLeadingStatusMarkerFromTextForRows(String(meta.body));
    }
  }
  return stripLeadingStatusMarkerFromTextForRows(errorOnlyResult ? '' : (rt || ''));
}

function toolHasDisplayResultForRows(item) {
  const rt = item.result == null ? '' : String(item.result).replace(/\s+$/, '');
  const trimmed = String(rt || '').trim();
  if (!trimmed) return false;
  const bgArgs = backgroundArgsForRows(item.args);
  if (isBackgroundErrorOnlyBody(trimmed, bgArgs.error || '')) return false;
  const normalizedName = String(normalizeToolName(item.name) || '').toLowerCase();
  if (isBackgroundTaskToolName(normalizedName)) {
    const meta = parseBackgroundTaskResultForRows(trimmed);
    if (meta) return Boolean(meta.hasResponse && String(meta.body || '').trim());
  }
  return true;
}

// Mirror ToolExecution expanded ResultBody rawText selection (aggregate always rawResult).
function toolExpandedRawTextForRows(item, rawRt) {
  if (item?.aggregate) return rawRt;
  const hasDisplayResult = toolHasDisplayResultForRows(item);
  if (hasDisplayResult) return toolDisplayedResultTextForRows(item);
  return stripLeadingStatusMarkerFromTextForRows(rawRt || '');
}

function toolHeaderFailureOnlyForRows(item, normalizedName, hasDisplayResult) {
  if (hasDisplayResult) return false;
  const bgArgs = backgroundArgsForRows(item.args);
  const error = String(bgArgs.error || '').trim();
  if (!error) return false;
  if (normalizedName === 'agent') {
    const pending = toolItemPendingForRows(item);
    const isError = Boolean(item.isError);
    const agentHeaderFailure = !pending && isError && error && !hasDisplayResult;
    if (!agentHeaderFailure) return false;
    const displayedResultText = toolDisplayedResultTextForRows(item);
    const rt = item.result == null ? '' : String(item.result).replace(/\s+$/, '');
    const isAgentResult = !pending && hasDisplayResult;
    const isAgentResponse = isAgentResult && isAgentResponseResultText(rt);
    const briefRaw = summarizeAgentSurfaceBrief(item.name, bgArgs, displayedResultText, {
      isError,
      isResponse: isAgentResponse,
    });
    const agentSurfaceBriefNonempty = Boolean(String(briefRaw || '').trim());
    return !agentSurfaceBriefNonempty;
  }
  if (!isBackgroundTaskToolName(normalizedName) || !bgArgs.task_id) return false;
  if (isBackgroundTaskResponseArgsForRows(normalizedName, bgArgs)) return false;
  const status = String(bgArgs.status || '').toLowerCase();
  return /^(failed|error|timeout|cancelled|canceled|killed)$/i.test(status);
}

function toolArgPathForRows(item) {
  const a = backgroundArgsForRows(item?.args);
  return a?.path ?? a?.file_path ?? a?.file ?? '';
}

function isShellSurfaceForRows(normalizedName, label = '') {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  return n === 'shell' || n === 'bash' || n === 'bash_session'
    || n === 'shell_command' || n === 'job_wait' || l === 'run';
}

function isShellSurfaceForToolItem(item, normalizedName) {
  const label = formatToolSurface(item?.name, item?.args)?.label || '';
  return isShellSurfaceForRows(normalizedName, label);
}

// EXPANDED tool bodies are post-processed by formatExpandedResult (JSON pretty,
// oversize guard, line-number split). It can add rows (JSON pretty) or drop them
// (truncation marker), so the row estimate MUST run the SAME pipeline — counting
// the raw `split('\n')` would desync windowing/scroll the moment the measured
// path replaces the estimate. Pass pathArg/isShell so the count matches exactly.
function estimateToolRenderedResultRows(value, { pathArg = '', isShell = false, columns = 80 } = {}) {
  const text = String(value ?? '').replace(/\s+$/, '');
  if (!text) return 1;
  try {
    const logical = formatExpandedResult(text, { pathArg, isShell });
    const rows = wrapExpandedResultLines(logical, columns, { isShell }).length;
    return Math.max(1, rows);
  } catch {
    return Math.max(1, text.split('\n').length);
  }
}

function estimateTranscriptItemRows(item, columns, toolOutputExpanded) {
  if (!item) return 1;
  switch (item.kind) {
    case 'user':
      return 1 + estimateWrappedRows(item.text, columns, 4);
    case 'assistant':
      // marginTop={1} (AssistantMessage <Box>) + rendered body height.
      // Streaming uses measureStreamingMarkdownRenderedRows (shared layout with
      // StreamingMarkdown); settled assistant uses measureMarkdownRenderedRows.
      return 1 + (item.streaming
        ? measureStreamingMarkdownRenderedRows(item.text, columns, item.id)
        : measureMarkdownRenderedRows(item.text, columns));
    case 'tool': {
      const TOOL_MARGIN_TOP = 1;
      if (shouldSuppressFullyFailedToolItem(item)) return 0;
      if (isHookApprovalDenialToolItem(item)) {
        const detail = formatHookDenialDetail(toolItemResultText(item));
        return TOOL_MARGIN_TOP + 1 + (detail ? 1 : 0);
      }
      // Match ToolExecution's real layout so the estimated height equals the
      // MEASURED height — otherwise the row "settles" by a row the moment the
      // app-level measured path replaces the estimate (the +1 jump). Every
      // ToolExecution card is wrapped in `<Box marginTop={attached ? 0 : 1}>`
      // and `Item` always passes attached={false} for tools, so the rendered
      // card ALWAYS carries a 1-row top margin. Yoga folds that margin into the
      // measured wrapper height, so the estimate MUST include it too. Layout:
      //   - COLLAPSED/PENDING: margin(1) + header(1) + detail(1), except skill
      //     surfaces which drop the ⎿ detail row → margin(1) + header(1).
      //   - EXPANDED: margin(1) + header(1) + the raw/detail result rows.
      // The pending pre-delay placeholder (ToolExecution returns blank Texts)
      // mirrors these exactly: skill → 2 rows, everything else → 3 rows.
      const normalizedName = String(normalizeToolName(item.name) || '').toLowerCase();
      const count = Math.max(1, Number(item.count || 1));
      const done = Math.max(0, Math.min(count, Number(item.completedCount || (item.result == null ? 0 : count))));
      const pending = done < count;
      const isSkillSurface = !item.aggregate && SKILL_SURFACE_NAMES.has(normalizedName);
      const isAgentSurface = normalizedName === 'agent';
      const rt = item.result == null ? null : String(item.result).replace(/\s+$/, '');
      const rawRt = item.rawResult == null ? null : String(item.rawResult).replace(/\s+$/, '');
      const hasResult = item.result != null && Boolean(String(rt || '').trim());
      const hasRawResult = item.rawResult != null && Boolean(String(rawRt || '').trim());
      const expanded = toolOutputExpanded || item.expanded;
      if (!expanded || pending) {
        // Skill surfaces drop the ⎿ detail row (ToolExecution sets
        // visibleDetailLines=[] for isSkillSurface), so margin + header only.
        if (isSkillSurface) return TOOL_MARGIN_TOP + 1;
        const hasDisplayResult = toolHasDisplayResultForRows(item);
        if (toolHeaderFailureOnlyForRows(item, normalizedName, hasDisplayResult)) {
          return TOOL_MARGIN_TOP + 1;
        }
        // Agent surfaces and every other collapsed/pending tool keep exactly one
        // detail row (the pending placeholder, the agent brief, or the collapsed
        // summary line), so margin + header + one detail row.
        return TOOL_MARGIN_TOP + 1 + 1;
      }
      // Expanded cards render rawResult verbatim when present (including failed
      // background-task metadata envelopes whose display result is intentionally
      // empty). Mirror ToolExecution's raw branch before no-result shortcuts so
      // expanded failure cards reserve enough height for the visible envelope.
      if (hasRawResult) {
        // Aggregate cards pass no pathArg/isShell to ResultBody; non-aggregate
        // cards do. Mirror that here so the formatExpandedResult row count matches
        // the rendered body exactly (JSON pretty / line-number split can shift it).
        const estimateText = toolExpandedRawTextForRows(item, rawRt);
        const rawOpts = item.aggregate
          ? {}
          : { pathArg: toolArgPathForRows(item), isShell: isShellSurfaceForToolItem(item, normalizedName) };
        return TOOL_MARGIN_TOP + 1 + estimateToolRenderedResultRows(estimateText, { ...rawOpts, columns });
      }
      // Expanded agent card with no raw body to reveal: ToolExecution still
      // shows one agent-brief detail line, so margin + header + one detail row.
      if (isAgentSurface && !hasResult) return TOOL_MARGIN_TOP + 1 + 1;
      // Expanded skill card with no raw body still suppresses the repeated
      // detail row, same as collapsed skill cards.
      if (isSkillSurface && !hasResult) return TOOL_MARGIN_TOP + 1;
      if (item.aggregate) {
        // Match ToolExecution aggregate rendering exactly:
        // expanded cards only show multiline raw output when a rawResult exists;
        // otherwise the normal detail/result is fitted into a single detail row.
        if (hasRawResult) {
          const resultRows = estimateToolRenderedResultRows(rawRt, { columns });
          return TOOL_MARGIN_TOP + 1 + resultRows;
        }
        return TOOL_MARGIN_TOP + 1 + 1;
      } else {
        const backgroundMeta = hasResult && isBackgroundTaskToolName(normalizedName)
          ? parseBackgroundTaskResultForRows(rt)
          : null;
        const isBackgroundResult = hasResult && isBackgroundTaskToolName(normalizedName);
        const isBackgroundResponse = isBackgroundResult
          && (backgroundMeta?.hasResponse || isBackgroundTaskResponseArgsForRows(normalizedName, backgroundArgsForRows(item.args)));
        const isBackgroundMetadataResult = isBackgroundResult && !isBackgroundResponse && Boolean(backgroundMeta);
        if (isBackgroundMetadataResult) {
          const hasDisplayResult = toolHasDisplayResultForRows(item);
          if (toolHeaderFailureOnlyForRows(item, normalizedName, hasDisplayResult)) {
            return TOOL_MARGIN_TOP + 1;
          }
          return isSkillSurface ? TOOL_MARGIN_TOP + 1 : TOOL_MARGIN_TOP + 1 + 1;
        }
        const resultText = backgroundMeta?.hasResponse ? backgroundMeta.body : rt;
        const resultRows = estimateToolRenderedResultRows(resultText, {
          pathArg: toolArgPathForRows(item),
          isShell: isShellSurfaceForToolItem(item, normalizedName),
          columns,
        });
        return TOOL_MARGIN_TOP + 1 + resultRows;
      }
    }
    case 'notice':
      return 1 + estimateWrappedRows(item.text, columns, 6);
    case 'turndone':
    case 'statusdone':
      return 2;
    default:
      return 1;
  }
}

function lowerBound(values, target) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(values, target) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (values[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Resolve the absolute scroll offset that keeps a captured reading anchor
// (viewport-top item id + row offset) at the same screen position for the
// CURRENT prefix table. Returns null when the anchor cannot be aligned (item
// gone / no prefix), so the caller keeps the existing offset. This is a pure
// function so it can run BOTH synchronously during render (same-frame
// correction — no blank band) AND in the post-commit layout effect (ref/state
// sync). The viewport is bottom-anchored, so scrollOffset counts rows up from
// the bottom: desired = totalRows - viewRows - anchorRowCur.
function resolveAnchorScrollOffset({ anchor, items, curPrefix, totalRows, viewRows, maxRows }) {
  if (!anchor || anchor.id == null) return null;
  if (!Array.isArray(curPrefix) || curPrefix.length <= 1) return null;
  const list = Array.isArray(items) ? items : [];
  let idx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].id === anchor.id) { idx = i; break; }
  }
  if (idx < 0 || idx > curPrefix.length - 2) return null;
  const itemHeight = Math.max(0, (curPrefix[idx + 1] || 0) - (curPrefix[idx] || 0));
  const clampedOffset = Math.max(0, Math.min(Number(anchor.offset) || 0, itemHeight));
  const anchorRowCur = (curPrefix[idx] || 0) + clampedOffset;
  return Math.max(0, Math.min(maxRows, totalRows - viewRows - anchorRowCur));
}

// Cheap, stable height fingerprint for a text blob. Row estimates depend on the
// LINE SHAPE (how many '\n'-separated lines and how each wraps), not just the
// raw character count, so a same-LENGTH edit that redistributes newlines or
// swaps content for a differently-wrapping string would otherwise be collapsed
// by a length-only key and serve a STALE row count / structure signature.
// Capture three cheap, order-sensitive signals: total display-relevant length,
// the newline count (line-shape), and an FNV-1a 32-bit rolling hash of the
// content (collision-resistant enough for cache validation, O(n) once, never
// embeds the whole string in the signature). null/undefined → a stable sentinel
// so a null→"" transition is never confused with unchanged.
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619, kept in 32-bit unsigned space.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// Two genuinely INDEPENDENT 32-bit rolling-hash steps used to fold short
// per-item sigParts into a single fixed-length structure signature (see
// transcriptStructureSignature). Combined they form a 64-bit signature whose
// collision probability across any realistic transcript edit sequence is
// negligible, while staying O(1) in length (unlike the previous O(N)-length
// concatenated signature string).
//
// CRITICAL: the two steps must use different mixers. `fnvStepA` is plain FNV-1a
// (the shift sum is exactly h*16777619). `fnvStepB` MUST NOT also be FNV-1a with
// the same prime — that collapses the pair into one 32-bit hash (an earlier
// version did, and a 216k-combo self-test showed ~5 collisions, matching 32-bit
// birthday math). `fnvStepB` therefore uses a distinct seed, a different prime,
// and an xorshift finalizer per char so the two chains are decorrelated and the
// effective space is the full 64 bits.
function fnvStepA(hash, str) {
  let h = hash >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function fnvStepB(hash, str) {
  let h = hash >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x85ebca77) >>> 0;
    // xorshift finalizer (murmur3 fmix tail) decorrelates fnvStepB from the
    // FNV-1a multiply in fnvStepA so the combined 64-bit value uses its full
    // space instead of degenerating to a single 32-bit hash.
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return h >>> 0;
}

function textShapeFingerprint(value) {
  if (value == null) return 'z';
  const text = String(value);
  const len = text.length;
  if (len === 0) return 'e';
  let newlines = 0;
  for (let i = 0; i < len; i++) {
    if (text.charCodeAt(i) === 10) newlines++;
  }
  return `${len}.${newlines}.${fnv1a32(text).toString(36)}`;
}

// Per-item cache validation key. This MUST contain EVERY item field that
// `estimateTranscriptItemRows` (and `shouldSuppressFullyFailedToolItem`, which it calls)
// reads, so any height-affecting change invalidates both the row-count cache
// and the structure signature. `columns`/`toolOutputExpanded` are global, not
// per-item, so the callers fold those in separately (signature prefix + the row
// cache's `toolExpanded` field). For tool items the estimate uses `rawResult`
// when expanded and `result` otherwise, and the fully-failed check reads
// count/completedCount/errorCount/isError plus whether `result` is null — all
// captured here. Background-task response classification also reads a tiny args
// subset, so include it too. Text/result/rawResult are folded in as a cheap
// SHAPE fingerprint (length + newline count + FNV-1a hash) rather than length
// alone, so a same-length edit that changes newline distribution or content
// (which changes the rendered row count) invalidates both the row cache and the
// structure signature instead of serving a stale height. The normalized tool
// NAME and `aggregate` are included because the tool estimate branches on the
// surface (skill/agent/background) and on aggregate vs normal.
// Identity-keyed memo for the variant key. The key is a pure function of the
// item's CONTENT (it folds the full text/result/rawResult through an O(n)
// FNV-1a shape fingerprint), and the engine swaps in a NEW object on every
// patch (engine.mjs flush/patchItem do `items[i] = { ...current, ...patch }`),
// so an unchanged historical item keeps its identity — and thus its cached
// key — across the fresh `state.items` array handed in on each streaming flush.
// Without this memo the same item's whole text was re-hashed multiple times per
// commit (structure signature + row-index build + measured-rows harvest +
// measuredTranscriptRows), so the per-commit cost grew linearly with the total
// MOUNTED transcript text and made drag/scroll/typing slow as history piled up.
// Streaming assistant items legitimately get a new object each flush, so they
// simply miss the cache and recompute — identical to the previous behavior.
const transcriptVariantKeyCache = new WeakMap();

function transcriptItemVariantKey(item) {
  if (item && typeof item === 'object') {
    const cached = transcriptVariantKeyCache.get(item);
    if (cached !== undefined) return cached;
    const key = computeTranscriptItemVariantKey(item);
    transcriptVariantKeyCache.set(item, key);
    return key;
  }
  return computeTranscriptItemVariantKey(item);
}

function computeTranscriptItemVariantKey(item) {
  const expanded = item.expanded ? 1 : 0;
  if (item.kind === 'tool') {
    const resultShape = textShapeFingerprint(item.result);
    const rawShape = textShapeFingerprint(item.rawResult);
    const count = Number(item.count ?? 0);
    const completed = item.completedCount === undefined ? 'u' : Number(item.completedCount);
    const errors = item.errorCount === undefined ? 'u' : Number(item.errorCount);
    const isError = item.isError ? 1 : 0;
    const normalizedName = String(normalizeToolName(item.name) || '').toLowerCase();
    const aggregate = item.aggregate ? 1 : 0;
    // Read the PARSED args (same shape ToolExecution/estimate use) so a JSON
    // string or `{ input: {...} }` envelope contributes its real type/action/
    // status/task_id to the key — otherwise a patched item that only changes
    // those (which flips background metadata↔response and the reserved height)
    // would keep a stale variant key and serve a stale row count.
    const bgArgs = backgroundArgsForRows(item.args);
    const bgType = String(bgArgs.type || bgArgs.action || '');
    const bgStatus = String(bgArgs.status || '');
    const bgTaskId = bgArgs.task_id ? 1 : 0;
    const bgPrompt = textShapeFingerprint(bgArgs.prompt);
    const bgMessage = textShapeFingerprint(bgArgs.message);
    const bgError = textShapeFingerprint(bgArgs.error);
    return `x${expanded}:n${normalizedName}:g${aggregate}:r${resultShape}:R${rawShape}:c${count}:d${completed}:e${errors}:E${isError}:bt${bgType}:bs${bgStatus}:bk${bgTaskId}:bp${bgPrompt}:bm${bgMessage}:be${bgError}`;
  }
  // user/assistant/notice: row count depends on the text's line SHAPE (newline
  // distribution + wrap), so fingerprint the content rather than length alone.
  return `x${expanded}:s${textShapeFingerprint(item.text ?? item.result ?? '')}`;
}

// Per-item ESTIMATED ROW COUNT cache for buildTranscriptRowIndex. The prefix-sum
// index is rebuilt whenever the structure signature changes (the consuming memo
// is keyed on it), but each rebuild re-ran estimateTranscriptItemRows for EVERY
// item from scratch — an O(n) `estimateWrappedRows` walk over all historical
// text on each rebuild. A completed (non-streaming) item's estimated height is a
// pure function of its variant key + `columns` + `toolOutputExpanded`, none of
// which change while the item keeps its object identity (engine.mjs swaps in a
// NEW object on any patch, so a changed item misses the cache). Memoize the row
// count on item identity, validated on the SAME variant key as the signature
// cache (+ columns + toolOutputExpanded) so a stale value can never be served.
// Streaming assistant items are never cached — their height can change between
// flushes — so the values stay 100% identical to the uncached implementation.
const transcriptRowsCache = new WeakMap();

// ── App-level MEASURED row heights (ScrollBox/useVirtualScroll-inspired
// heightCache) ────────────────────────────────────────────────────────────────
// Keyed on the transcript item OBJECT (stable until engine.mjs swaps it on a
// patch — a patched item legitimately changed height, so a cache miss → re-
// measure is correct). Stores the REAL Yoga getComputedHeight() of the row the
// last time it was mounted, validated on the same (variantKey + columns +
// toolExpanded) tuple as the estimate caches so a stale measurement can never be
// served. The App writes this from a per-commit layout effect; the row-index
// build reads it via measuredTranscriptRows() so the scroll/window math is in
// REAL rows instead of estimated rows — which is what removes the scroll judder
// when an item's true height (markdown table, wrapped long token, settled tool
// card) differs from its estimate. Streaming assistant items are intentionally
// NEVER measured here: their height churns every flush, so they keep the
// quantized estimate (the bottom-follow path keeps them visually stable).
const transcriptMeasuredRowsCache = new WeakMap();

function measuredTranscriptRows(item, columns, toolOutputExpanded) {
  if (!TRANSCRIPT_MEASURED_ROWS || !item) return null;
  if (shouldSuppressFullyFailedToolItem(item)) return 0;
  if (item.kind === 'assistant' && item.streaming) return null;
  const entry = transcriptMeasuredRowsCache.get(item);
  if (!entry) return null;
  if (entry.rows <= 0) return null;
  if (entry.columns !== columns) return null;
  if (entry.toolExpanded !== (toolOutputExpanded ? 1 : 0)) return null;
  if (entry.variantKey !== transcriptItemVariantKey(item)) return null;
  return entry.rows;
}

// Streaming assistant items re-estimate their height every flush (~8ms). The
// assistant branch now measures the EXACT rendered height via
// measureMarkdownRenderedRows (lockstep with <Markdown>), which already drops
// blank edge segments the way the renderer does — so engine streamingVisibleText
// (completed lines ending with '\n') no longer reserves a phantom blank body row
// that would scroll the viewport ahead of the characters. Edge-trimming the text
// first keeps the lex input stable across the trailing-newline flush. ENGINE
// newline-gating means the input only changes when a completed line appears
// (not per character), so quantum stays 1: growth is real line additions, not
// sub-quantum churn. The value is identical in the structure signature and the
// row-index build, so they never diverge.
const STREAMING_ROW_QUANTUM = 1;

function assistantTextForStreamingRowEstimate(text) {
  return streamingLayoutText(text);
}

function streamingEstimateRows(item, columns, toolOutputExpanded) {
  const trimmedText = assistantTextForStreamingRowEstimate(item.text);
  const estimateItem = trimmedText === item.text ? item : { ...item, text: trimmedText };
  const raw = Math.max(1, Math.ceil(estimateTranscriptItemRows(estimateItem, columns, toolOutputExpanded)));
  return Math.ceil(raw / STREAMING_ROW_QUANTUM) * STREAMING_ROW_QUANTUM;
}

function estimateTranscriptItemRowsCached(item, columns, toolOutputExpanded) {
  if (!item) return Math.max(1, Math.ceil(estimateTranscriptItemRows(item, columns, toolOutputExpanded)));
  if (shouldSuppressFullyFailedToolItem(item)) return 0;
  if (item.kind === 'assistant' && item.streaming) {
    return streamingEstimateRows(item, columns, toolOutputExpanded);
  }
  const variantKey = transcriptItemVariantKey(item);
  const toolExpanded = toolOutputExpanded ? 1 : 0;
  const cached = transcriptRowsCache.get(item);
  if (cached
    && cached.columns === columns
    && cached.toolExpanded === toolExpanded
    && cached.variantKey === variantKey
    && cached.id === item.id
    && cached.kind === item.kind) {
    return cached.rows;
  }
  const rows = Math.max(1, Math.ceil(estimateTranscriptItemRows(item, columns, toolOutputExpanded)));
  transcriptRowsCache.set(item, { id: item.id, kind: item.kind, variantKey, columns, toolExpanded, rows });
  return rows;
}

function buildTranscriptRowIndex(items, { columns = 80, toolOutputExpanded = false } = {}) {
  const allItems = Array.isArray(items) ? items : [];
  const rows = new Array(allItems.length);
  const prefixRows = new Array(allItems.length + 1);
  prefixRows[0] = 0;
  for (let i = 0; i < allItems.length; i++) {
    // Prefer the app-level MEASURED height (real Yoga rows) when available; fall
    // back to the estimate for items that are off-screen / never mounted. This
    // is the core of the ScrollBox-inspired fix: the prefix-sum the scroll/window
    // math is built on now tracks the REAL on-screen height of every visible
    // row, so wheel scrolling no longer judders when an estimate is wrong.
    const item = allItems[i];
    const measured = measuredTranscriptRows(item, columns, toolOutputExpanded);
    const rowCount = measured != null
      ? measured
      : estimateTranscriptItemRowsCached(item, columns, toolOutputExpanded);
    rows[i] = rowCount;
    prefixRows[i + 1] = prefixRows[i] + rowCount;
  }
  return { rows, prefixRows, totalRows: prefixRows[allItems.length] || 0 };
}

// Stable signature for the transcript row-index / window memos. During
// streaming the engine replaces `state.items` with a fresh array every flush
// (~8ms) while only the final assistant item's `text` grows. Keying the heavy
// O(n) row-index + windowing memos directly on `state.items` re-ran them on
// every delta frame, which throttled the stream into coarse chunks. This
// signature changes only when transcript STRUCTURE changes (item count, id,
// kind, expansion) or when the streaming item's ESTIMATED HEIGHT actually
// changes — not on every character. `columns`/`toolOutputExpanded` are folded
// in because they alter wrapped row estimates.
//
// Cost note: even though the consuming memos are cached on this signature, the
// signature itself was recomputed O(n) on EVERY App re-render (drag motion →
// setScrollOffset, scroll, streaming flush ~8ms). For long transcripts that
// per-frame O(n) walk grew linearly and slowed typing/drag/scroll. The
// per-item `sigPart` for COMPLETED (non-streaming) items only changes when the
// item's `text`/`result` length, `expanded`, or `columns` change, so it is
// memoized on the item OBJECT IDENTITY via this WeakMap. The engine creates a
// NEW object whenever it patches an item (engine.mjs patchItem/flush do
// `items[index] = { ...current, ...patch }`), so a patched item simply misses
// the cache; untouched historical items retain their identity across the fresh
// `state.items` array, which is where the hit rate comes from. Streaming
// assistant items still recompute their estimated height every call because
// their height can change between flushes. The cache key is validated on
// the SAME `transcriptItemVariantKey` (id/kind/expanded + text/result length,
// or for tool items rawResult length + count/completedCount/errorCount/isError +
// the background-task args subset) plus `columns`, so any field
// `estimateTranscriptItemRows` reads is folded in and a stale sigPart can never
// be served. This is critical: the consuming
// row-index memo only rebuilds when THIS signature changes, so missing a
// height-affecting field here would freeze a stale row count.
const transcriptSigPartCache = new WeakMap();

function transcriptStructureSignature(items, columns, toolOutputExpanded) {
  const list = Array.isArray(items) ? items : [];
  // Fold each item's short sigPart into a fixed-length 64-bit rolling hash (two
  // independent 32-bit FNV chains) instead of concatenating into one O(N)-length
  // string. The previous concat allocated and returned a signature string whose
  // length grew with the transcript, so during streaming (a fresh state.items
  // array every ~8ms) BOTH building it and useMemo's string compare scaled with
  // N. The hash chain keeps the per-item visit but produces a 16-char result,
  // making the build allocation O(1) and the memo compare O(1). The index `i` is
  // folded in so reordering changes the signature; `length` and the global
  // columns/expanded flags seed the chain.
  let hA = fnvStepA(0x811c9dc5, `${list.length}|${columns}|${toolOutputExpanded ? 1 : 0}`);
  let hB = fnvStepB(0xcbf29ce4, `${list.length}|${columns}|${toolOutputExpanded ? 1 : 0}`);
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    let sigPart;
    if (!it) {
      sigPart = '_';
    } else if (it.kind === 'assistant' && it.streaming) {
      // Streaming assistant: include only the estimated row count, not the text,
      // so per-character growth that does not change height keeps the memo warm.
      sigPart = `a${it.id}:${streamingEstimateRows(it, columns, toolOutputExpanded)}`;
    } else {
      // Completed item: reuse the cached sigPart while the variant key (every
      // height-affecting field) and columns are unchanged. Identity is keyed on
      // the item object itself (stable for in-place append/patch).
      const variantKey = transcriptItemVariantKey(it);
      const cached = transcriptSigPartCache.get(it);
      if (cached
        && cached.variantKey === variantKey
        && cached.columns === columns
        && cached.id === it.id
        && cached.kind === it.kind) {
        sigPart = cached.sigPart;
      } else {
        sigPart = `${it.kind?.[0] || '?'}${it.id}:${variantKey}`;
        transcriptSigPartCache.set(it, { id: it.id, kind: it.kind, variantKey, columns, sigPart });
      }
    }
    // Mix the row position in so a pure reorder (same items, new order) still
    // changes the signature, then fold the sigPart into both chains.
    hA = fnvStepA(hA, `;${i};`);
    hA = fnvStepA(hA, sigPart);
    hB = fnvStepB(hB, `;${i};`);
    hB = fnvStepB(hB, sigPart);
  }
  return `${hA.toString(36)}.${hB.toString(36)}`;
}

function transcriptRenderWindow(items, { scrollOffset = 0, viewportHeight = 24, columns = 80, toolOutputExpanded = false, rowIndex = null } = {}) {
  const allItems = Array.isArray(items) ? items : [];
  const itemCount = allItems.length;
  const fallbackIndex = rowIndex?.prefixRows?.length === itemCount + 1
    ? rowIndex
    : buildTranscriptRowIndex(allItems, { columns, toolOutputExpanded });
  const totalRows = Math.max(0, fallbackIndex.totalRows || 0);
  const viewRows = Math.max(1, Number(viewportHeight) || 24);
  const maxScrollRows = Math.max(0, totalRows - viewRows);
  const effectiveScrollOffset = Math.min(
    maxScrollRows,
    Math.max(0, Math.ceil(Number(scrollOffset) || 0)),
  );

  // Bypass windowing only when the WHOLE transcript already fits in the
  // viewport plus a full overscan band above and below — i.e. mounting every
  // item costs nothing extra over what the user can scroll to without a
  // re-window. Keying this on ROWS (not a large fixed item count) is what lets
  // a tall transcript stop mounting hundreds of off-screen rows on every
  // keystroke. A small item count still short-circuits so tiny sessions skip the
  // binary-search windowing entirely.
  const bypassRowBudget = viewRows + TRANSCRIPT_WINDOW_OVERSCAN_ROWS * 2;
  if (itemCount <= TRANSCRIPT_WINDOW_MIN_ITEMS || totalRows <= bypassRowBudget) {
    return { startIndex: 0, endIndex: itemCount, items: allItems, bottomSpacerRows: 0, totalRows, maxScrollRows, effectiveScrollOffset };
  }

  const minItems = Math.min(TRANSCRIPT_WINDOW_MIN_ITEMS, itemCount);
  const maxItems = Math.max(minItems, TRANSCRIPT_WINDOW_MAX_ITEMS);
  const prefixRows = fallbackIndex.prefixRows;
  const visibleTop = Math.max(0, totalRows - effectiveScrollOffset - viewRows);
  const visibleBottom = Math.min(totalRows, totalRows - effectiveScrollOffset);
  const desiredTop = Math.max(0, visibleTop - TRANSCRIPT_WINDOW_OVERSCAN_ROWS);
  const desiredBottom = Math.min(totalRows, visibleBottom + TRANSCRIPT_WINDOW_OVERSCAN_ROWS);

  let startIndex = Math.max(0, upperBound(prefixRows, desiredTop) - 1);
  let endIndex = Math.min(itemCount, Math.max(startIndex + 1, lowerBound(prefixRows, Math.max(desiredBottom, desiredTop + 1))));

  while (endIndex - startIndex < minItems && startIndex > 0) startIndex--;
  while (endIndex - startIndex < minItems && endIndex < itemCount) endIndex++;

  if (endIndex - startIndex > maxItems) {
    const visibleStartIndex = Math.max(0, upperBound(prefixRows, visibleTop) - 1);
    const visibleEndIndex = Math.min(itemCount, Math.max(visibleStartIndex + 1, lowerBound(prefixRows, Math.max(visibleBottom, visibleTop + 1))));
    startIndex = Math.max(0, Math.min(visibleStartIndex, itemCount - maxItems));
    endIndex = Math.min(itemCount, Math.max(visibleEndIndex, startIndex + maxItems));
    if (endIndex - startIndex > maxItems) startIndex = Math.max(0, endIndex - maxItems);
  }

  const bottomSpacerRows = Math.max(0, totalRows - (prefixRows[endIndex] || totalRows));
  return {
    startIndex,
    endIndex,
    items: allItems.slice(startIndex, endIndex),
    bottomSpacerRows,
    totalRows,
    maxScrollRows,
    effectiveScrollOffset,
  };
}

export function App({ store, initialStatusLine = '', forceOnboarding = false }) {
  const state = useEngine(store);
  const [toolOutputExpanded, setToolOutputExpanded] = useState(false);
  // True for the entire first-run onboarding wizard (every step + nested depth)
  // so the welcome banner stays reserved and the layout doesn't jump when the
  // step pickers mount. Cleared on finish/cancel.
  const [onboardingActive, setOnboardingActive] = useState(false);
  const { exit } = useApp();
  // internal_eventEmitter is ink's parsed-input bus. ink 7 consumes stdin via
  // the 'readable' event + stdin.read() (see ink's App.js), draining the buffer
  // so a plain stdin.on('data') listener of ours never sees mouse bytes. Instead
  // we subscribe to ink's 'input' events, which carry every parsed sequence —
  // including raw SGR mouse sequences (\x1b[<…M/m), since ink's input-parser
  // passes CSI sequences through untouched and emitInput forwards them verbatim.
  const { isRawModeSupported, stdin, internal_eventEmitter: inkInput } = useStdin();
  const { stdout } = useStdout();
  const [exiting, setExiting] = useState(false);
  // tuiReady stays false across the first render + commit. A setTimeout(0) in
  // the first effect defers the flip until one event-loop poll has drained any
  // keystrokes that the OS buffered during terminal setup / initial mount.
  const [tuiReady, setTuiReady] = useState(false);
  const exitRequestedRef = useRef(false);
  const [resizeState, setResizeState] = useState(() => ({ ...terminalSize(stdout), epoch: 0 }));
  // Windows Terminal/conhost scrolls the alt-screen (auto-wrap/DECAWM) when the
  // bottom-right cell is written. WT_SESSION is also set when the UI runs under
  // a Unix-ish shell hosted by Windows Terminal, where process.platform is not
  // necessarily win32 but the terminal behavior is still Windows-like.
  const windowsLikeTerminal = process.platform === 'win32' || Boolean(process.env.WT_SESSION);
  const rightSafetyColumns = windowsLikeTerminal ? 1 : 0;
  const frameColumns = Math.max(1, resizeState.columns - rightSafetyColumns);
  // scrollOffset = how many transcript ROWS we've scrolled UP from the bottom
  // (0 = pinned to the latest, showing the newest content). Mouse wheel adjusts
  // it; accepted prompts only arm bottom-follow; the snap happens when the
  // transcript actually grows.
  const [scrollOffset, setScrollOffset] = useState(0);
  const scrollPositionRef = useRef(0);
  const scrollTargetRef = useRef(0);
  const maxScrollRowsRef = useRef(0);
  const transcriptBottomSlackRowsRef = useRef(0);
  const scrollAnimationRef = useRef(null);
  const transcriptTotalRowsRef = useRef(0);
  const preservedScrollDeltaRef = useRef(0);
  // Absolute reading-anchor lock. While the user reads older transcript, we
  // capture the item id + row offset at the VIEWPORT TOP edge once, then re-
  // derive scrollOffset from that anchor on every commit. Streaming tail growth
  // (or any height change BELOW the anchor) only moves the bottom, so the top
  // item stays pinned — no incremental drift, no jump on newline. `dirty` forces
  // a re-capture after a manual scroll; cleared to null when we follow/pin the
  // bottom so a fresh scroll-up starts a new anchor.
  const transcriptAnchorRef = useRef(null);
  const transcriptAnchorDirtyRef = useRef(false);
  // Latest render's prefix-row table + dimensions, so a manual scroll can
  // capture the reading anchor SYNCHRONOUSLY (in the wheel/key callback) instead
  // of waiting for the post-commit effect — otherwise each scroll notch leaves
  // the anchor "dirty" for one frame, and if streaming grows the transcript on
  // that same frame the lock is not engaged yet and the view lurches.
  const transcriptGeomRef = useRef({ prefixRows: null, totalRows: 0, viewRows: 1 });
  // App-level measured row heights (ScrollBox/useVirtualScroll-inspired). The map of
  // mounted item id → ink DOM element is read every commit to harvest each
  // row's REAL Yoga height into transcriptMeasuredRowsCache. measuredRowsVersion
  // is bumped whenever a height actually changes so the row-index/window memos
  // recompute against the corrected heights (one-frame lag, absorbed by the
  // overscan band).
  const transcriptItemElsRef = useRef(new Map());
  const transcriptMeasureRefCache = useRef(new Map());
  // id → latest item object for this render. The callback ref reads from here so
  // a reused (stable) callback never captures a stale item across patches.
  const transcriptMeasureItemsRef = useRef(new Map());
  const [measuredRowsVersion, setMeasuredRowsVersion] = useState(0);
  // Stable per-item callback-ref factory: storing the element under the item id
  // (and reading the live item object from transcriptMeasureItemsRef) avoids the
  // ref-swap churn React would otherwise cause with an inline closure each
  // render, while never serving a stale item: the callback resolves the current
  // item by id at call time. The ref(null) path drops the element; the harvest
  // reads getComputedHeight from whatever is mounted, so an unmount simply stops
  // contributing (its last measurement stays cached on the item object).
  const transcriptMeasureRef = useCallback((item) => {
    if (!TRANSCRIPT_MEASURED_ROWS || !item || item.id == null) return undefined;
    if (shouldSuppressFullyFailedToolItem(item)) {
      transcriptMeasuredRowsCache.delete(item);
      transcriptItemElsRef.current.delete(item.id);
      transcriptMeasureItemsRef.current.delete(item.id);
      return undefined;
    }
    const key = item.id;
    transcriptMeasureItemsRef.current.set(key, item);
    let fn = transcriptMeasureRefCache.current.get(key);
    if (!fn) {
      fn = (el) => {
        if (el) {
          transcriptItemElsRef.current.set(key, el);
        } else {
          transcriptItemElsRef.current.delete(key);
        }
      };
      transcriptMeasureRefCache.current.set(key, fn);
    }
    return fn;
  }, []);
  // Auto-follow is separate from manual scroll. While true, new transcript rows
  // (new items or streaming text wrapping to another line) are folded into the
  // same glide back to the bottom.
  const followingRef = useRef(false);
  const lastItemsCountRef = useRef(0);
  // picker = null | { type, title, items, onSelect }
  // Rendered as an option panel attached directly above the bottom prompt.
  const pickerOpenedFromEnterRef = useRef(false);
  const pickerOpenedFromEnterTimerRef = useRef(null);
  const buildProjectPickerState = ({ initialEntry = false } = {}) => {
    let projects = [];
    try {
      projects = listProjects() || [];
    } catch {
      projects = [];
    }
    const currentPath = String(state.cwd || process.cwd() || '');
    const items = [];
    // Registered projects (store order via listProjects).
    for (const project of projects) {
      if (!project?.path) continue;
      items.push({
        value: project.path,
        label: project.name || project.path,
        meta: project.path,
        _project: project,
      });
    }
    // Last row: implicit current-directory shortcut (not persisted).
    items.push({
      value: '__use_current__',
      label: 'Current Path',
      meta: currentPath,
      _action: 'current',
    });
    return {
      kind: 'project',
      title: 'Project',
      description: 'Choose a project.',
      help: initialEntry
        ? '↑/↓ Select · Enter Open · c Create · r Rename'
        : '↑/↓ Select · Enter Open · c Create · r Rename · Esc Back',
      indexMode: 'always',
      labelWidth: 18,
      metaWidth: 40,
      items,
      onSelect: (_value, item) => {
        if (item?._action === 'new') {
          beginNewProject();
          return;
        }
        if (item?._action === 'current') {
          setPicker(null);
          try {
            store.setCwd?.(currentPath, {
              notice: !initialEntry,
              message: `Project set: ${projectNameFromPath(currentPath)}`,
            });
          } catch (e) {
            store.pushNotice(`project switch failed: ${e?.message || e}`, 'error');
          }
          return;
        }
        setPicker(null);
        const project = item?._project;
        if (project?.path) enterProject(project.path, { notice: !initialEntry });
      },
      onKey: (input, _key, item) => {
        if (input === 'c' || input === 'C') {
          beginNewProject();
          return;
        }
        // 'r' renames the highlighted registered project (not the current-dir
        // shortcut or the create row).
        if ((input === 'r' || input === 'R') && item?._project?.path) {
          beginRenameProject(item._project);
        }
      },
      onCancel: () => {
        setPicker(null);
      },
    };
  };
  const [picker, setPickerState] = useState(() => (
    state.items.length === 0 ? buildProjectPickerState({ initialEntry: true }) : null
  ));
  const setPicker = useCallback((next) => {
    setPickerState((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      if (resolved && typeof resolved === 'object' && pickerOpenedFromEnterRef.current) {
        pickerOpenedFromEnterRef.current = false;
        if (pickerOpenedFromEnterTimerRef.current) {
          clearTimeout(pickerOpenedFromEnterTimerRef.current);
          pickerOpenedFromEnterTimerRef.current = null;
        }
        return resolved.indexMode ? resolved : { ...resolved, indexMode: 'always' };
      }
      return resolved;
    });
  }, []);
  const [contextPanel, setContextPanel] = useState(null);
  const [usagePanel, setUsagePanel] = useState(null);
  const usageRequestRef = useRef(0);
  const closeUsagePanel = useCallback(() => {
    usageRequestRef.current += 1;
    setUsagePanel(null);
  }, []);
  const [providerPrompt, setProviderPrompt] = useState(null);
  const oauthSubmitRef = useRef(false);
  const [channelPrompt, setChannelPrompt] = useState(null);
  const [hookPrompt, setHookPrompt] = useState(null);
  const [settingsPrompt, setSettingsPrompt] = useState(null);
  const toolApproval = state.toolApproval || null;
  const [promptDraft, setPromptDraft] = useState('');
  const [promptDraftOverride, setPromptDraftOverride] = useState(null);
  const promptLayoutValueRef = useRef('');
  const [, setPromptLayoutRows] = useState(1);
  const [, setPastedImages] = useState({});
  const pastedImagesRef = useRef({});
  const nextPastedImageIdRef = useRef(1);
  const promptValueRef = useRef('');
  const promptSelectionRef = useRef(null);
  // [mixdog] Prompt-box mouse selection wiring. boxRect is the editable text
  // node's REAL absolute rect (top/left/height/contentWidth), reported by
  // PromptInput each render; mouseSelection exposes offsetAtCell/anchorAt/
  // extendTo/clear so the single mouse handler can drive the prompt's OWN
  // selectionAnchor engine without the ink-grid rect path.
  const promptBoxRectRef = useRef(null);
  const promptMouseSelectionRef = useRef(null);
  const promptHistoryNavRef = useRef({ active: false, index: -1, seed: '', lastValue: '' });
  const promptHistoryDraftChangeRef = useRef(false);
  const [promptHint, setPromptHint] = useState('');
  const [promptHintTone, setPromptHintTone] = useState('info');
  const [welcomePromptHintDismissed, setWelcomePromptHintDismissed] = useState(false);
  const [conditionalWelcomePromptHint, setConditionalWelcomePromptHint] = useState('');
  const welcomePromptHintRef = useRef(null);
  if (welcomePromptHintRef.current === null) {
    welcomePromptHintRef.current = randomWelcomePromptHint();
  }
  const dismissWelcomePromptHint = useCallback(() => {
    setWelcomePromptHintDismissed((dismissed) => dismissed || true);
  }, []);
  const toastErrorSignature = useMemo(() => (
    (state.toasts || [])
      .filter((toast) => toast?.tone === 'error')
      .map((toast) => `${toast.id || ''}:${toast.text || ''}`)
      .join('|')
  ), [state.toasts]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissedFor, setSlashDismissedFor] = useState('');
  const [disabledSkills, setDisabledSkills] = useState(() => new Set());
  const slashPaletteRef = useRef({ open: false, count: 0 });
  const scrollFocusRef = useRef({});
  const onboardingStartedRef = useRef(false);
  const onboardingRef = useRef({ defaultRoute: null, searchRoute: null, agentRoutes: {}, agents: [], providerModels: [] });
  const providerModelsCacheRef = useRef({ models: null, at: 0 });
  const searchModelsCacheRef = useRef({ models: null, at: 0 });
  const modelPickerRequestRef = useRef(0);
  // Generation guard for the Step 1 background prefetch: bumped on every
  // provider-scope cache clear (e.g. after auth) so a stale in-flight
  // listProviderModels() cannot repopulate the ref after invalidation.
  const onboardingPrefetchSeqRef = useRef(0);
  const clearModelCaches = useCallback((scope = 'all') => {
    if (scope === 'all' || scope === 'provider') {
      providerModelsCacheRef.current = { models: null, at: 0 };
      onboardingRef.current.providerModels = [];
      onboardingPrefetchSeqRef.current += 1;
    }
    if (scope === 'all' || scope === 'search') {
      searchModelsCacheRef.current = { models: null, at: 0 };
    }
  }, []);
  const promptHintTimerRef = useRef(null);
  const promptHintActiveRef = useRef(false);
  const mouseZoomPassthroughTimerRef = useRef(null);
  // dragRef tracks an in-progress mouse text selection (see the mouse handler):
  // anchor = where the drag began, last = the latest cell, active = button held.
  // region: which surface the in-progress (or last) selection belongs to —
  // 'transcript' | 'status' (both ink-grid) | 'prompt' (PromptInput's own engine)
  // | null. Press decides it; motion/release stay in that region.
  // anchorSpan: for word/line multi-click selections, the initial word/line
  // bounds ({ lo:{x,y}, hi:{x,y}, kind:'word'|'line' }) so a subsequent drag
  // extends the selection whole-word/whole-line from that span (see selection.ts
  // extendSelection). Null ⇔ ordinary char-drag selection.
  const dragRef = useRef({ anchor: null, anchorScroll: 0, last: null, active: false, rect: null, region: null, anchorSpan: null });
  const selectionPaintRef = useRef({ t: 0, rect: null, pending: null, timer: null });
  const transcriptViewportRef = useRef({ top: 0, bottom: 0 });
  // [mixdog] Latest terminal row count + the statusline band (bottom rows),
  // refreshed each render. The mouse handler uses these to (a) clip a status-bar
  // grid selection to the statusline rows and (b) route a press to the right
  // region. STATUSLINE_ROWS mirrors the layout reserve below.
  const frameRowsRef = useRef(24);
  const STATUSLINE_BAND_ROWS = 3;
  const promptContentColumns = Math.max(1, frameColumns - 4);
  const syncPromptLayoutRows = useCallback((value) => {
    const text = String(value ?? '');
    promptLayoutValueRef.current = text;
    const nextRows = promptContentRows(text, promptContentColumns);
    setPromptLayoutRows((prev) => (prev === nextRows ? prev : nextRows));
  }, [promptContentColumns]);
  useEffect(() => {
    syncPromptLayoutRows(promptLayoutValueRef.current);
  }, [syncPromptLayoutRows]);
  useEffect(() => {
    let alive = true;
    const refreshConditionalWelcomeHint = async () => {
      let next = '';
      try {
        const setup = await store.getProviderSetup?.();
        if (setup && !providerSetupHasUsableProvider(setup)) {
          next = CONDITIONAL_WELCOME_PROMPT_HINTS.noProvider;
        }
      } catch {
        // If provider setup probing fails, let the generic/error tip path decide.
      }
      if (!next) {
        const activeProvider = String(state.provider || '').trim();
        const activeModel = String(state.model || '').trim();
        if (!activeProvider || !activeModel) {
          next = CONDITIONAL_WELCOME_PROMPT_HINTS.noModel;
        } else {
          try {
            const models = await Promise.resolve(store.listProviderModels?.({ quick: true }) || []);
            if (Array.isArray(models) && models.length === 0) {
              next = CONDITIONAL_WELCOME_PROMPT_HINTS.noModel;
            }
          } catch {
            // Model probing is advisory only; avoid replacing the random hint on failure.
          }
        }
      }
      const activeWorkflow = activeWorkflowSummaryForStore(store, state.workflow || {});
      if (!next && String(activeWorkflow?.id || state.workflow?.id || '').toLowerCase() === 'solo') {
        next = CONDITIONAL_WELCOME_PROMPT_HINTS.soloWorkflow;
      }
      if (!next) {
        const searchRoute = store.getSearchRoute?.() || null;
        const searchProvider = String(searchRoute?.provider || '').trim();
        const searchModel = String(searchRoute?.model || '').trim();
        const defaultSearchRoute = searchProvider.toLowerCase() === 'default' && searchModel.toLowerCase() === 'default';
        if (defaultSearchRoute) {
          try {
            const models = await Promise.resolve(store.listProviderModels?.({ quick: true }) || []);
            const current = Array.isArray(models)
              ? models.find((model) => model?.provider === state.provider && model?.id === state.model)
              : null;
            if (current && current.supportsWebSearch !== true) {
              next = CONDITIONAL_WELCOME_PROMPT_HINTS.searchDefaultUnsupported;
            }
          } catch {
            // Search default probing is advisory only.
          }
        }
      }
      if (!next && toastErrorSignature) {
        next = CONDITIONAL_WELCOME_PROMPT_HINTS.error;
      }
      if (alive) setConditionalWelcomePromptHint((prev) => (prev === next ? prev : next));
    };
    void refreshConditionalWelcomeHint();
    return () => { alive = false; };
  }, [store, state.provider, state.model, state.workflow?.id, toastErrorSignature]);
  const selectionLayoutRef = useRef(null);
  const selectionTextRef = useRef('');
  const selectionTextTimerRef = useRef(null);
  // lastClickRef tracks the previous left-press cell + time so the mouse handler
  // can detect a double-click (same cell within 500ms) for word selection.
  // count = consecutive qualifying presses on the same cell (1=single,
  // 2=double/word, 3=triple/line). A 4th qualifying press restarts the
  // sequence at 1 (claude-code cycles; simplest reset). Any non-qualifying
  // press resets to a fresh single.
  const lastClickRef = useRef({ x: -1, y: -1, t: 0, count: 0 });

  const showSelectionCopyHint = useCallback((text, tone = 'plain') => {
    if (promptHintTimerRef.current) clearTimeout(promptHintTimerRef.current);
    promptHintActiveRef.current = true;
    setPromptHint(String(text || ''));
    setPromptHintTone(tone);
    promptHintTimerRef.current = setTimeout(() => {
      promptHintTimerRef.current = null;
      promptHintActiveRef.current = false;
      setPromptHint('');
      setPromptHintTone('info');
    }, 2200);
  }, []);

  // Copy the currently-highlighted selection to the OS clipboard. ink's fork
  // refreshed store.getRenderSelectionText() on the synchronous render that the
  // final setSelection() triggered, so the selected text is ready to read.
  const copySelection = useCallback((attempt = 0) => {
    const renderText = store.getRenderSelectionText?.();
    const text = renderText == null ? selectionTextRef.current : renderText;
    if ((!text || !text.trim()) && attempt < 4) {
      setTimeout(() => copySelection(attempt + 1), attempt === 0 ? 0 : 24);
      return;
    }
    if (!text || !text.trim()) return;
    selectionTextRef.current = text;
    copyToClipboard(text)
      .then(() => {
        const lines = text.split('\n').length;
        const chars = text.length;
        showSelectionCopyHint(`copied ${chars} char${chars === 1 ? '' : 's'}${lines > 1 ? ` · ${lines} lines` : ''}`, 'plain');
      })
      .catch((e) => showSelectionCopyHint(`copy failed: ${e?.message || e}`, 'error'));
  }, [store, showSelectionCopyHint]);

  // ── Post-mount input gate ──────────────────────────────────────────────
  // Let one event-loop poll pass so Ink processes (and discards, because
  // PromptInput is still disabled) any keystrokes queued during boot/first
  // render. After the tick, enable the input — new keystrokes land normally.
  useEffect(() => {
    const timer = setTimeout(() => setTuiReady(true), 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!stdout) return undefined;
    let trailing = null;
    const update = () => {
      setResizeState((prev) => {
        const next = terminalSize(stdout);
        return {
          ...next,
          epoch: prev.epoch + 1,
        };
      });
    };
    const onResize = () => {
      update();
      if (trailing) clearTimeout(trailing);
      trailing = setTimeout(() => {
        trailing = null;
        update();
      }, 60);
    };
    stdout.on('resize', onResize);
    update();
    return () => {
      if (trailing) clearTimeout(trailing);
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  const clearPromptHint = useCallback(() => {
    if (!promptHintActiveRef.current && !promptHintTimerRef.current) return;
    if (promptHintTimerRef.current) {
      clearTimeout(promptHintTimerRef.current);
      promptHintTimerRef.current = null;
    }
    promptHintActiveRef.current = false;
    setPromptHint('');
    setPromptHintTone('info');
  }, []);

  const showPromptHint = useCallback((text, tone = 'info') => {
    if (promptHintTimerRef.current) clearTimeout(promptHintTimerRef.current);
    promptHintActiveRef.current = true;
    setPromptHint(String(text || ''));
    setPromptHintTone(tone);
    promptHintTimerRef.current = setTimeout(() => {
      promptHintTimerRef.current = null;
      promptHintActiveRef.current = false;
      setPromptHint('');
      setPromptHintTone('info');
    }, 2200);
  }, []);

  // Voice recorder status hint — reuses the SAME promptHint state as
  // showPromptHint/clearPromptHint, but bypasses their 2200ms auto-clear
  // timer: '● REC' / '… transcribing' must stay visible for the ENTIRE
  // recording/transcribing duration (which can run well past 2.2s), not
  // vanish on a fixed timer. Also cancels any pending showPromptHint timer
  // so a stale auto-clear can never stomp the live recording status.
  const setVoiceStatusHint = useCallback((text, tone = 'info') => {
    if (promptHintTimerRef.current) {
      clearTimeout(promptHintTimerRef.current);
      promptHintTimerRef.current = null;
    }
    promptHintActiveRef.current = !!text;
    setPromptHint(String(text || ''));
    setPromptHintTone(tone);
  }, []);

  // Ctrl+Space handler wired to PromptInput's onVoiceToggle. Dispatches on the
  // recorder's CURRENT state (idle/recording/transcribing) — see
  // src/tui/lib/voice-recorder.mjs for the state machine itself.
  const handleVoiceToggle = useCallback(async () => {
    if (!isVoiceEnabled()) {
      store.pushNotice('Voice is off — run /voice to turn it on', 'warn');
      return;
    }
    const recState = getRecorderState();
    if (recState === 'transcribing') {
      store.pushNotice('Voice: already transcribing…', 'info');
      return;
    }
    if (recState === 'recording') {
      setVoiceStatusHint('… transcribing', 'info');
      let result;
      try {
        result = await stopRecording();
      } catch (e) {
        result = { ok: false, reason: e?.message || String(e) };
      }
      setVoiceStatusHint('', 'info');
      if (!result) return; // race: recorder was no longer RECORDING
      if (!result.ok) {
        store.pushNotice(`Voice: ${result.reason || 'transcription failed'}`, 'error');
        return;
      }
      const text = String(result.text || '').trim();
      if (!text) {
        store.pushNotice('Voice: no speech detected', 'warn');
        return;
      }
      // End-of-draft insertion via promptDraftOverride (approved design —
      // no cursor-position insert; see gamerscroll skill's out-of-scope note
      // on PromptInput's imperative surface).
      // Med-4: promptValueRef.current is read HERE — after `await
      // stopRecording()` has already resolved — not captured earlier before
      // the await. PromptInput keeps valueRef.current live on every
      // keystroke (commitDraft), so this always reflects whatever the user
      // typed during the recording+transcribe window; nothing typed in that
      // gap is overwritten.
      const current = promptValueRef.current || '';
      const next = current ? `${current}${/\s$/.test(current) ? '' : ' '}${text}` : text;
      syncPromptLayoutRows(next);
      setPromptDraftOverride({ id: Date.now(), value: next });
      return;
    }
    // idle -> recording
    let result;
    try {
      result = await startRecording();
    } catch (e) {
      result = { ok: false, reason: e?.message || String(e) };
    }
    if (!result?.ok) {
      store.pushNotice(`Voice: ${result?.reason || 'failed to start recording'}`, 'error');
      return;
    }
    setVoiceStatusHint('● REC', 'error');
  }, [store, setVoiceStatusHint, syncPromptLayoutRows]);

  // Best-effort recorder teardown on unmount (component-level cleanup;
  // index.jsx's runTui() also disposes via store.dispose on exit/signal, but
  // that path doesn't know about the TUI-local recorder singleton).
  useEffect(() => () => {
    disposeRecorder();
  }, []);

  const installPastedImages = useCallback((images, { merge = true } = {}) => {
    if (!images || typeof images !== 'object' || Object.keys(images).length === 0) return;
    const next = merge ? { ...pastedImagesRef.current, ...images } : { ...images };
    pastedImagesRef.current = next;
    const maxId = Object.keys(next)
      .map((id) => Number(id) || 0)
      .reduce((max, id) => Math.max(max, id), 0);
    if (maxId >= nextPastedImageIdRef.current) nextPastedImageIdRef.current = maxId + 1;
    setPastedImages(next);
  }, []);

  const clearPastedImagesSnapshot = useCallback((snapshot = null) => {
    if (!snapshot) {
      if (Object.keys(pastedImagesRef.current || {}).length === 0) return;
      pastedImagesRef.current = {};
      setPastedImages({});
      return;
    }
    if (typeof snapshot !== 'object' || Object.keys(snapshot).length === 0) return;
    const next = { ...pastedImagesRef.current };
    let changed = false;
    for (const [id, image] of Object.entries(snapshot)) {
      if (next[id] === image) {
        delete next[id];
        changed = true;
      }
    }
    if (!changed) return;
    pastedImagesRef.current = next;
    setPastedImages(next);
  }, []);

  const registerPastedImage = useCallback((image) => {
    if (!image || image.type !== 'image' || !image.content) return '';
    const id = nextPastedImageIdRef.current++;
    const entry = { ...image, id };
    pastedImagesRef.current = { ...pastedImagesRef.current, [id]: entry };
    setPastedImages(pastedImagesRef.current);
    return formatImageRef(id);
  }, []);

  const handlePromptPaste = useCallback((text, meta = {}) => {
    const source = String(meta?.source || 'paste');
    const value = String(text ?? '');
    if (source === 'clipboard-image-shortcut' && !value) {
      return readClipboardImageAttachment()
        .then((image) => {
          if (!image) {
            showPromptHint('no image found on clipboard', 'plain');
            return false;
          }
          const ref = registerPastedImage(image);
          showPromptHint(`attached ${image.filename || 'clipboard image'}`, 'plain');
          return ref;
        })
        .catch((e) => {
          showPromptHint(`image paste failed: ${e?.message || e}`, 'warn');
          return false;
        });
    }

    const chunks = splitPastedImagePathCandidates(value);
    if (!chunks.some((chunk) => chunk.imagePath)) return undefined;
    return Promise.all(chunks.map(async (chunk) => {
      if (!chunk.imagePath) return chunk.text;
      try {
        const image = await readImageAttachmentFromPath(chunk.text, state.cwd || process.cwd());
        if (!image) return chunk.text;
        const ref = registerPastedImage(image);
        showPromptHint(`attached ${image.filename || 'image'}`, 'plain');
        return ref;
      } catch (e) {
        showPromptHint(`image attach failed: ${e?.message || e}`, 'warn');
        return chunk.text;
      }
    })).then((parts) => parts.join(''));
  }, [registerPastedImage, showPromptHint, state.cwd]);

  const stopSmoothScroll = useCallback(() => {
    if (!scrollAnimationRef.current) return;
    clearInterval(scrollAnimationRef.current);
    scrollAnimationRef.current = null;
  }, []);

  const startSmoothScroll = useCallback(() => {
    if (scrollAnimationRef.current) return;
    scrollAnimationRef.current = setInterval(() => {
      const current = scrollPositionRef.current;
      const target = scrollTargetRef.current;
      const next = current + (target - current) * 0.32;
      if (Math.abs(target - next) < 0.12) {
        scrollPositionRef.current = target;
        setScrollOffset(Math.max(0, Math.round(target)));
        followingRef.current = false;
        stopSmoothScroll();
        return;
      }
      scrollPositionRef.current = Math.max(0, next);
      setScrollOffset(Math.max(0, Math.round(scrollPositionRef.current)));
    }, 16);
    scrollAnimationRef.current.unref?.();
  }, [stopSmoothScroll]);

  const cancelTranscriptFollow = useCallback(() => {
    followingRef.current = false;
  }, []);

  const resetTranscriptScroll = useCallback(() => {
    cancelTranscriptFollow();
    stopSmoothScroll();
    scrollPositionRef.current = 0;
    scrollTargetRef.current = 0;
    transcriptAnchorRef.current = null;
    transcriptAnchorDirtyRef.current = false;
    setScrollOffset(0);
  }, [stopSmoothScroll, cancelTranscriptFollow]);

  const armTranscriptFollow = useCallback(() => {
    // Do not mutate scrollOffset here. During prompt submit the transcript rows
    // have not necessarily been committed yet; resetting immediately makes a
    // long transcript jump to the bottom, then jump again when the new row is
    // appended. Keep the current viewport stable and let the row-delta effect
    // perform the single bottom-follow when the transcript actually grows.
    transcriptAnchorRef.current = null;
    transcriptAnchorDirtyRef.current = false;
    followingRef.current = true;
    stopSmoothScroll();
  }, [stopSmoothScroll]);

  const rememberSelectionTextSoon = useCallback(() => {
    if (selectionTextTimerRef.current) return;
    selectionTextTimerRef.current = setTimeout(() => {
      selectionTextTimerRef.current = null;
      const text = store.getRenderSelectionText?.();
      if (text && text.trim()) selectionTextRef.current = text;
    }, 0);
  }, [store]);

  const selectionClip = useCallback(() => {
    // The status-bar grid selection lives in the bottom statusline band, not the
    // transcript viewport — clip there so the highlight cannot spill into the
    // prompt/transcript rows. Everything else (transcript, word-select) keeps the
    // transcript-viewport clip.
    if (dragRef.current.region === 'status') {
      const rows = Math.max(1, Number(frameRowsRef.current) || 24);
      const top = Math.max(0, rows - STATUSLINE_BAND_ROWS);
      return { y1: top, y2: Math.max(top, rows - 1) };
    }
    return {
      y1: Math.max(0, Number(transcriptViewportRef.current?.top) || 0),
      y2: Math.max(0, Number(transcriptViewportRef.current?.bottom) || 0),
    };
  }, []);

  const withSelectionClip = useCallback((rect, options = {}) => {
    if (!rect) return null;
    const clip = selectionClip();
    const clipped = {
      ...rect,
      clipY1: clip.y1,
      clipY2: Math.max(clip.y1, clip.y2),
      selectionForeground: theme.selectionHighlightText || theme.selectionText,
      selectionBackground: theme.selectionHighlightBackground || theme.selectionBackground,
    };
    if (options.captureText === false) clipped.captureText = false;
    return clipped;
  }, [selectionClip]);

  const paintSelectionRect = useCallback((clippedRect, { rememberText = true, immediate = false } = {}) => {
    const nextRect = clippedRect || null;
    const state = selectionPaintRef.current;
    if (selectionRectsEqual(state.rect, nextRect)) {
      const needsCapture = nextRect && rememberText && nextRect.captureText !== false;
      if (!immediate && !needsCapture) return false;
      if (immediate || needsCapture) {
        store.setRenderSelection?.(nextRect, { immediate: true });
      }
      if (needsCapture) rememberSelectionTextSoon();
      return true;
    }
    state.rect = nextRect;
    state.t = Date.now();
    store.setRenderSelection?.(nextRect, immediate ? { immediate: true } : undefined);
    if (nextRect && rememberText && nextRect.captureText !== false) rememberSelectionTextSoon();
    return true;
  }, [store, rememberSelectionTextSoon]);

  const applySelectionRect = useCallback((rect) => {
    const clippedRect = withSelectionClip(rect);
    dragRef.current.rect = clippedRect || null;
    if (!clippedRect) selectionTextRef.current = '';
    const state = selectionPaintRef.current;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
      state.pending = null;
    }
    paintSelectionRect(clippedRect, { rememberText: true, immediate: true });
  }, [paintSelectionRect, withSelectionClip]);

  const applySelectionRectThrottled = useCallback((rect) => {
    const clippedRect = withSelectionClip(rect, { captureText: false });
    if (selectionRectsEqual(dragRef.current.rect, clippedRect)) return;
    dragRef.current.rect = clippedRect || null;
    const state = selectionPaintRef.current;
    if (selectionRectsEqual(state.rect, clippedRect)) return;
    const now = Date.now();
    const elapsed = now - state.t;
    if (elapsed >= SELECTION_PAINT_INTERVAL_MS) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
        state.pending = null;
      }
      paintSelectionRect(clippedRect, { rememberText: false });
      return;
    }
    state.pending = clippedRect || null;
    if (!state.timer) {
      state.timer = setTimeout(() => {
        const current = selectionPaintRef.current;
        const pending = current.pending;
        current.timer = null;
        current.pending = null;
        paintSelectionRect(pending, { rememberText: false });
      }, Math.max(1, SELECTION_PAINT_INTERVAL_MS - elapsed));
      state.timer.unref?.();
    }
  }, [paintSelectionRect, withSelectionClip]);

  const selectionPointAtCurrentScroll = useCallback((point, pointScroll = 0) => {
    if (!point) return null;
    return {
      x: point.x,
      y: point.y + (Number(scrollTargetRef.current) || 0) - (Number(pointScroll) || 0),
    };
  }, []);

  // Port of selection.ts extendSelection onto the linear-rect model, hoisted to
  // component scope so BOTH the mouse handler (motion/release) AND the
  // auto-scroll path (scrollTranscriptRows) can rebuild a span-aware rect. Grows
  // a word/line multi-click selection from its anchor span to the word/line under
  // the cursor: target ends before the span → extend backward (span.hi→targetLo);
  // target starts after → extend forward (span.lo→targetHi); overlapping → the
  // span. The moving end snaps to the word (getWordRectAt) or line (getLineRectAt)
  // at the cursor; a miss (blank/gutter) falls back to the raw cell. spanScroll
  // re-anchors the span to the current transcript scroll (status never scrolls) so
  // the original word/line tracks the content while dragging/auto-scrolling.
  const buildSpanRect = useCallback((span, x, y, region, spanScroll = 0) => {
    const conv = (pt) => (region === 'status' ? pt : selectionPointAtCurrentScroll(pt, spanScroll));
    const spanLo = conv(span.lo);
    const spanHi = conv(span.hi);
    let mLo;
    let mHi;
    if (span.kind === 'word') {
      const wr = store.getWordRectAt?.(x, y);
      if (wr) { mLo = { x: wr.x1, y: wr.y1 }; mHi = { x: wr.x2, y: wr.y2 }; }
      else { mLo = { x, y }; mHi = { x, y }; }
    } else {
      const lr = store.getLineRectAt?.(y);
      if (lr) { mLo = { x: lr.x1, y: lr.y1 }; mHi = { x: lr.x2, y: lr.y2 }; }
      else { mLo = { x: 0, y }; mHi = { x, y }; }
    }
    const rect = (a, b) => ({ mode: 'linear', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    if (comparePoints(mHi, spanLo) < 0) return rect(spanHi, mLo);
    if (comparePoints(mLo, spanHi) > 0) return rect(spanLo, mHi);
    return rect(spanLo, spanHi);
  }, [store, selectionPointAtCurrentScroll]);

  const transcriptViewportRows = useCallback(() => {
    const top = Math.max(0, Number(transcriptViewportRef.current?.top) || 0);
    const bottom = Math.max(top, Number(transcriptViewportRef.current?.bottom) || top);
    return { top, bottom };
  }, []);

  const statusBandRows = useCallback(() => {
    const rows = Math.max(1, Number(frameRowsRef.current) || 24);
    const top = Math.max(0, rows - STATUSLINE_BAND_ROWS);
    return { top, bottom: Math.max(top, rows - 1) };
  }, []);

  const selectionMaxColAtRow = useCallback((row) => {
    const lr = store.getLineRectAt?.(row);
    if (lr != null && Number.isFinite(lr.x2)) return Math.max(0, lr.x2);
    return Math.max(0, frameColumns - 1);
  }, [store, frameColumns]);

  // Synchronous predicate: is a transcript/status ink-grid selection live? Used
  // both by App (to consume Shift+Arrow even when focus clamps at an edge) and
  // by PromptInput (via prop) to gate its own Shift+Arrow at event time — a flag
  // set inside App's parent handler would be one event stale (parent handler
  // runs AFTER the child prompt handler for the same key).
  const gridSelectionActiveRef = useRef(() => {
    const drag = dragRef.current;
    if (!drag || drag.active) return false;
    if (drag.region !== 'transcript' && drag.region !== 'status') return false;
    const rect = drag.rect;
    return Boolean(rect) && !(rect.x1 === rect.x2 && rect.y1 === rect.y2);
  });

  const moveSelectionFocus = useCallback((move) => {
    const drag = dragRef.current;
    if (drag.active) return false;
    const region = drag.region;
    if (region !== 'transcript' && region !== 'status') return false;
    const rect = drag.rect;
    if (!rect) return false;
    if (rect.x1 === rect.x2 && rect.y1 === rect.y2) return false;

    const anchor = { x: rect.x1, y: rect.y1 };
    let col = rect.x2;
    let row = rect.y2;
    const beforeCol = col;
    const beforeRow = row;

    const { top, bottom } = region === 'status' ? statusBandRows() : transcriptViewportRows();

    switch (move) {
      case 'left':
        if (col > 0) col -= 1;
        else if (row > top) {
          row -= 1;
          col = selectionMaxColAtRow(row);
        }
        break;
      case 'right': {
        const maxCol = selectionMaxColAtRow(row);
        if (col < maxCol) col += 1;
        else if (row < bottom) {
          row += 1;
          col = 0;
        }
        break;
      }
      case 'up':
        if (row > top) row -= 1;
        break;
      case 'down':
        if (row < bottom) row += 1;
        break;
      case 'lineStart':
        col = 0;
        break;
      case 'lineEnd':
        col = selectionMaxColAtRow(row);
        break;
      default:
        return false;
    }

    row = Math.max(top, Math.min(bottom, row));
    col = Math.max(0, Math.min(selectionMaxColAtRow(row), col));

    if (col === beforeCol && row === beforeRow) return false;

    if (drag.anchorSpan) drag.anchorSpan = null;

    const focus = { x: col, y: row };
    applySelectionRect({
      mode: 'linear',
      x1: anchor.x,
      y1: anchor.y,
      x2: focus.x,
      y2: focus.y,
    });
    drag.last = { x: focus.x, y: focus.y };
    return true;
  }, [applySelectionRect, statusBandRows, transcriptViewportRows, selectionMaxColAtRow]);

  useEffect(() => () => {
    const paintState = selectionPaintRef.current;
    if (paintState.timer) clearTimeout(paintState.timer);
    paintState.timer = null;
    paintState.pending = null;
    if (selectionTextTimerRef.current) clearTimeout(selectionTextTimerRef.current);
    selectionTextTimerRef.current = null;
  }, []);

  const scrollTranscriptRows = useCallback((deltaRows, options = {}) => {
    const maxTarget = Math.max(0, Number(maxScrollRowsRef.current) || 0);
    const target = Math.max(0, Math.min(maxTarget, scrollTargetRef.current + deltaRows));
    const appliedDelta = target - scrollTargetRef.current;
    // Any manual wheel/keyboard scroll takes precedence over an in-flight
    // transcript follow: drop the glide so the user's intent wins.
    if (appliedDelta !== 0) cancelTranscriptFollow();
    scrollTargetRef.current = target;
    // A manual scroll moves the reading position. Capture the new reading anchor
    // SYNCHRONOUSLY from the latest published geometry so the very next render
    // already locks to it — no one-frame "dirty" window where concurrent
    // streaming growth could lurch the view. At/over the bottom, drop the anchor
    // so the bottom-follow path owns the viewport again.
    if (appliedDelta !== 0) {
      if (target <= Math.max(0, Number(transcriptBottomSlackRowsRef.current) || 0)) {
        transcriptAnchorRef.current = null;
        transcriptAnchorDirtyRef.current = false;
      } else {
        const geom = transcriptGeomRef.current || {};
        const prefixRows = geom.prefixRows;
        if (Array.isArray(prefixRows) && prefixRows.length > 1) {
          const gTotal = Math.max(0, Number(geom.totalRows) || 0);
          const gView = Math.max(1, Number(geom.viewRows) || 1);
          const anchorRow = Math.max(0, Math.min(gTotal, gTotal - target - gView));
          let idx = upperBound(prefixRows, anchorRow) - 1;
          if (idx < 0) idx = 0;
          if (idx > prefixRows.length - 2) idx = prefixRows.length - 2;
          const items = geom.items || [];
          const anchorItem = items[idx];
          if (anchorItem && anchorItem.id != null) {
            transcriptAnchorRef.current = { id: anchorItem.id, offset: Math.max(0, anchorRow - (prefixRows[idx] || 0)) };
            transcriptAnchorDirtyRef.current = false;
          } else {
            transcriptAnchorDirtyRef.current = true;
          }
        } else {
          transcriptAnchorDirtyRef.current = true;
        }
      }
    }
    if (appliedDelta !== 0 && selectionLayoutRef.current) {
      selectionLayoutRef.current = { ...selectionLayoutRef.current, scrollOffset: target };
    }
    if (appliedDelta !== 0 && dragRef.current.rect) {
      let rect;
      if (dragRef.current.active) {
        const { anchor, anchorScroll, last, anchorSpan, region } = dragRef.current;
        if (anchorSpan && last) {
          // Word/line multi-click drag that reached the edge: keep extending by
          // whole words/lines from the span to the word/line at the current cell,
          // NOT collapsing to a char {anchor->last} rect. Mirrors the motion path.
          rect = buildSpanRect(anchorSpan, last.x, last.y, region, anchorScroll);
        } else {
          const currentAnchor = selectionPointAtCurrentScroll(anchor, anchorScroll);
          rect = currentAnchor && last ? { mode: 'linear', x1: currentAnchor.x, y1: currentAnchor.y, x2: last.x, y2: last.y } : null;
        }
      } else {
        rect = shiftSelectionRectY(dragRef.current.rect, appliedDelta);
      }
      const clippedRect = withSelectionClip(rect);
      dragRef.current = { ...dragRef.current, rect: clippedRect };
      paintSelectionRect(clippedRect, { rememberText: !dragRef.current.active });
    }
    if (options.smooth) {
      startSmoothScroll();
      return;
    }
    stopSmoothScroll();
    scrollPositionRef.current = target;
    setScrollOffset(Math.round(target));
  }, [startSmoothScroll, stopSmoothScroll, paintSelectionRect, selectionPointAtCurrentScroll, withSelectionClip, cancelTranscriptFollow, buildSpanRect]);

  const passthroughCtrlWheelZoom = useCallback(() => {
    if (!stdout?.write) return;
    try {
      stdout.write(MOUSE_TRACKING_OFF);
    } catch {
      return;
    }
    if (mouseZoomPassthroughTimerRef.current) clearTimeout(mouseZoomPassthroughTimerRef.current);
    mouseZoomPassthroughTimerRef.current = setTimeout(() => {
      mouseZoomPassthroughTimerRef.current = null;
      try {
        stdout.write(MOUSE_TRACKING_ON);
      } catch {
        // The terminal may already be closing.
      }
    }, 700);
    mouseZoomPassthroughTimerRef.current.unref?.();
  }, [stdout]);

  useEffect(() => () => {
    stopSmoothScroll();
  }, [stopSmoothScroll]);

  useEffect(() => () => {
    if (promptHintTimerRef.current) clearTimeout(promptHintTimerRef.current);
    if (mouseZoomPassthroughTimerRef.current) clearTimeout(mouseZoomPassthroughTimerRef.current);
  }, []);

  // Optional mouse handling. When index.jsx enables SGR mouse tracking
  // (?1000h button + ?1002h drag-motion + ?1006h SGR coords).
  // Every event arrives as `\x1b[<b;col;rowM`
  // (press/motion) or `\x1b[<b;col;rowm` (release), 1-based col/row. We watch raw
  // stdin and split it two ways, both additive to ink's keyboard handling:
  //   • wheel (button 64 up / 65 down) → scroll the transcript
  //   • left-button (0) press → drag → release → in-app text selection; dragging
  //     against the top/bottom edge scrolls the transcript while selecting.
  //     The highlight stays visible after release so the user can confirm the
  //     selected region; ESC or a plain click clears it.
  // Because we run a true fullscreen alt-screen, the reported (row,col) maps 1:1
  // to ink's absolute output grid. We keep anchor/focus points instead of a
  // rectangular min/max box so multi-line drags behave like normal text
  // selection, not terminal block selection.
  useEffect(() => {
    if (!inkInput || !isRawModeSupported) return undefined;
    // Match every SGR mouse event: button, col, row, and final M(press)/m(release).
    const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    const linearSelection = (a, b) => {
      return {
        mode: 'linear',
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
      };
    };
    // Word/line multi-click drag-extension uses the hoisted buildSpanRect (same
    // logic reachable from the auto-scroll path in scrollTranscriptRows).
    const transcriptViewport = () => {
      const top = Math.max(0, Number(transcriptViewportRef.current?.top) || 0);
      const bottom = Math.max(top, Number(transcriptViewportRef.current?.bottom) || top);
      return { top, bottom };
    };
    const isInTranscriptViewport = (row) => {
      const { top, bottom } = transcriptViewport();
      return row >= top && row <= bottom;
    };
    const clampToTranscriptViewport = (row) => {
      const { top, bottom } = transcriptViewport();
      return Math.max(top, Math.min(bottom, row));
    };
    // [mixdog] Status-bar band = the bottom STATUSLINE_BAND_ROWS rows. The
    // prompt box occupies the rows reported by PromptInput's measured rect.
    const statusBand = () => {
      const rows = Math.max(1, Number(frameRowsRef.current) || 24);
      const top = Math.max(0, rows - STATUSLINE_BAND_ROWS);
      return { top, bottom: Math.max(top, rows - 1) };
    };
    const isInStatusBand = (row) => {
      const { top, bottom } = statusBand();
      return row >= top && row <= bottom;
    };
    const clampToStatusBand = (row) => {
      const { top, bottom } = statusBand();
      return Math.max(top, Math.min(bottom, row));
    };
    const promptRect = () => promptBoxRectRef.current;
    const isInPromptBox = (x, y) => {
      const r = promptRect();
      if (!r) return false;
      const top = Math.max(0, Number(r.top) || 0);
      const bottom = top + Math.max(1, Number(r.height) || 1) - 1;
      const left = Math.max(0, Number(r.left) || 0);
      const width = Math.max(1, Number(r.contentWidth) || 1);
      return y >= top && y <= bottom && x >= left && x <= left + width;
    };
    // Map an absolute grid cell to a prompt-draft edit offset via PromptInput's
    // measured box rect + its caret math (offsetAtCell handles wrapping).
    const promptOffsetAt = (x, y) => {
      const r = promptRect();
      const ctl = promptMouseSelectionRef.current;
      if (!r || !ctl) return null;
      const top = Math.max(0, Number(r.top) || 0);
      const left = Math.max(0, Number(r.left) || 0);
      const height = Math.max(1, Number(r.height) || 1);
      const width = Math.max(1, Number(r.contentWidth) || 1);
      // Clamp the mapped row/col to the box's own bounds so a drag that runs
      // outside the prompt (above/below/left/right, e.g. onto the transcript
      // or off-screen) still tracks the nearest edge cell instead of jumping
      // to whatever offset a raw negative/overflowing row would resolve to.
      const row = Math.max(0, Math.min(height - 1, y - top));
      const col = Math.max(0, Math.min(width, x - left));
      return ctl.offsetAtCell(row, col);
    };
    // Clear whichever selection is active (ink-grid rect AND/OR prompt engine).
    const clearAllSelections = () => {
      promptMouseSelectionRef.current?.clear?.();
      applySelectionRect(null);
    };
    const onData = (data) => {
      // ink emits each parsed input event as a string; a mouse SGR sequence
      // arrives whole. Guard so non-mouse keystrokes fall through untouched.
      const s = typeof data === 'string' ? data : String(data ?? '');
      if (s.indexOf('\x1b[<') === -1) return;
      dismissWelcomePromptHint();
      let up = 0;
      let down = 0;
      let m;
      MOUSE.lastIndex = 0;
      while ((m = MOUSE.exec(s)) !== null) {
        const button = Number(m[1]);
        const x = Number(m[2]) - 1; // SGR is 1-based; grid is 0-based
        const y = Number(m[3]) - 1;
        const press = m[4] === 'M';
        const wheelButton = button & ~MOUSE_MODIFIER_MASK;
        if (wheelButton === 64 || wheelButton === 65) {
          if ((button & MOUSE_CTRL_MASK) !== 0) {
            passthroughCtrlWheelZoom();
            continue;
          }
          if (wheelButton === 64) up += 1;
          else down += 1;
          continue;
        }
        // Low 2 bits = button id; bit 5 (32) = motion-while-pressed flag.
        const baseButton = button & 3;
        const isMotion = (button & 32) !== 0;
        // Shift bit must be read BEFORE baseButton drops every modifier bit
        // (button & 3); MOUSE_MODIFIER_MASK above is scroll-routing-only and
        // deliberately treats shift as noise there.
        const shiftHeld = (button & MOUSE_SHIFT_MASK) !== 0;
        if (baseButton === 0 && press && !isMotion) {
          // Region router: a press decides which surface owns this selection.
          // Prompt box takes priority (it overlaps no transcript rows), then the
          // transcript viewport, then the bottom statusline band. A press
          // anywhere else clears any prior selection (plain click).
          if (isInPromptBox(x, y)) {
            // Clear any ink-grid selection so only one highlight is ever visible.
            applySelectionRect(null);
            const offset = promptOffsetAt(x, y);
            stopSmoothScroll();
            dragRef.current = { anchor: { x, y }, anchorScroll: 0, last: { x, y }, active: true, rect: null, region: 'prompt', anchorSpan: null };
            const ctl = promptMouseSelectionRef.current;
            // Shift+click extends the EXISTING prompt selection (anchor stays
            // put, cursor jumps to the click) instead of starting a fresh
            // zero-width anchor at the click point.
            if (shiftHeld && ctl?.hasSelection?.()) {
              if (offset != null) ctl.extendTo?.(offset, true);
              lastClickRef.current = { x: -1, y: -1, t: 0 };
              continue;
            }
            // Multi-click word/line select (double = word, triple = line),
            // same "qualifying press" window/drift tolerance used by the
            // transcript/status path below. Reuses lastClickRef so a rapid
            // double/triple click on the prompt box behaves the same as one on
            // the transcript. A qualifying press advances the count; anything
            // else (moved too far, too slow, or count already at 3) resets to
            // a fresh single-click anchor.
            const nowPrompt = Date.now();
            const lcPrompt = lastClickRef.current;
            const qualifiesPrompt = (nowPrompt - lcPrompt.t) < 500
              && Math.abs(lcPrompt.y - y) <= 1
              && Math.abs(lcPrompt.x - x) <= 2;
            let promptClickCount = qualifiesPrompt ? (lcPrompt.count || 1) + 1 : 1;
            if (promptClickCount > 3) promptClickCount = 1;
            if ((promptClickCount === 2 || promptClickCount === 3) && offset != null) {
              if (promptClickCount === 2) ctl?.selectWordAt?.(offset);
              else ctl?.selectLineAt?.(offset);
              // Click-select is already final (selectWordAt/selectLineAt set the
              // full word/line range). Mark the drag inactive so a subsequent
              // release does NOT fall into the generic prompt release handler
              // below, which calls extendTo(releaseOffset) and would collapse
              // this selection back down to anchor→releaseOffset (or empty on a
              // no-motion release, since anchor was never re-anchored here).
              dragRef.current.active = false;
              lastClickRef.current = { x, y, t: nowPrompt, count: promptClickCount };
              continue;
            } else if (offset != null) {
              ctl?.anchorAt?.(offset);
            }
            lastClickRef.current = { x, y, t: nowPrompt, count: 1 };
            continue;
          }
          const inTranscript = isInTranscriptViewport(y);
          const inStatus = !inTranscript && isInStatusBand(y);
          if (!inTranscript && !inStatus) {
            lastClickRef.current = { x: -1, y: -1, t: 0 };
            dragRef.current.active = false;
            dragRef.current.region = null;
            dragRef.current.anchorSpan = null;
            clearAllSelections();
            continue;
          }
          const region = inTranscript ? 'transcript' : 'status';
          // A press always clears the prompt-box selection (single active region).
          promptMouseSelectionRef.current?.clear?.();
          const now = Date.now();
          // Shift+click extends the existing ink-grid selection in this SAME
          // region from its original anchor to the new click point, instead of
          // starting a fresh anchor here. Only applies to a plain char-drag
          // selection (no anchorSpan) with a live non-empty rect; a word/line
          // anchorSpan or an empty/absent selection falls through to a normal
          // fresh press below.
          if (
            shiftHeld
            && dragRef.current.region === region
            && !dragRef.current.anchorSpan
            && dragRef.current.anchor
            && dragRef.current.rect
            && !(dragRef.current.rect.x1 === dragRef.current.rect.x2 && dragRef.current.rect.y1 === dragRef.current.rect.y2)
          ) {
            const selectionY = region === 'status' ? clampToStatusBand(y) : clampToTranscriptViewport(y);
            const anchor = region === 'status'
              ? dragRef.current.anchor
              : selectionPointAtCurrentScroll(dragRef.current.anchor, dragRef.current.anchorScroll);
            const rect = linearSelection(anchor, { x, y: selectionY });
            stopSmoothScroll();
            dragRef.current = {
              ...dragRef.current,
              last: { x, y: selectionY },
              active: true,
              region,
            };
            applySelectionRect(rect);
            lastClickRef.current = { x, y, t: now, count: 1 };
            continue;
          }
          // Multi-click sequence: 2nd consecutive press = word (double-click),
          // 3rd = whole line (triple-click). Each press must land near the prior
          // one within 500ms — up to 2 columns and 1 row of drift (terminals
          // often report a shifted cell on repeat clicks); tighter matching made
          // word selection unreliable. A 4th qualifying press restarts the
          // sequence at 1 (claude-code cycles; simplest: reset). Works for
          // transcript AND status rows since getWordRectAt/getLineRectAt are
          // grid-based. Copy still happens on Ctrl+C, never here.
          const lc = lastClickRef.current;
          const qualifies = (now - lc.t) < 500
            && Math.abs(lc.y - y) <= 1
            && Math.abs(lc.x - x) <= 2;
          let clickCount = qualifies ? (lc.count || 1) + 1 : 1;
          if (clickCount > 3) clickCount = 1;
          if (clickCount === 2 || clickCount === 3) {
            // Word (2) or line (3) select. Snap to the word/line under the cell
            // and record the span on dragRef so a following drag extends by whole
            // words/lines from this span (see buildSpanRect). Leave the drag
            // ARMED (active:true): a release without motion keeps this highlight
            // (buildSpanRect returns the span for an in-span target), while
            // any motion extends it. Mirrors selectWordAt/selectLineAt setting
            // isDragging=true + anchorSpan; the mouse-up finalizes.
            const kind = clickCount === 2 ? 'word' : 'line';
            const wr = kind === 'word' ? store.getWordRectAt?.(x, y) : store.getLineRectAt?.(y);
            if (wr) {
              const lo = { x: wr.x1, y: wr.y1 };
              const hi = { x: wr.x2, y: wr.y2 };
              const rect = linearSelection(lo, hi);
              stopSmoothScroll();
              dragRef.current = {
                anchor: { x, y },
                anchorScroll: region === 'transcript' ? scrollTargetRef.current : 0,
                last: { x, y },
                active: true,
                rect: null,
                region,
                anchorSpan: { lo, hi, kind },
              };
              applySelectionRect(rect);
              lastClickRef.current = { x, y, t: now, count: clickCount };
              continue;
            }
          }
          lastClickRef.current = { x, y, t: now, count: 1 };
          // Left-button press: begin a new selection anchored here.
          // Anchor the drag but do NOT paint a zero-width selection yet; a plain
          // single click should not flash a one-cell highlight. The selection is
          // only rendered once a drag actually extends past the anchor.
          // Status-band selections do NOT scroll, so anchorScroll is irrelevant
          // there; keep the transcript scroll anchor only for the transcript.
          // Plain single press clears any word/line anchorSpan (char-drag mode).
          stopSmoothScroll();
          dragRef.current = {
            anchor: { x, y },
            anchorScroll: region === 'transcript' ? scrollTargetRef.current : 0,
            last: { x, y },
            active: true,
            rect: null,
            region,
            anchorSpan: null,
          };
        } else if (baseButton === 0 && isMotion && dragRef.current.active) {
          const region = dragRef.current.region;
          if (region === 'prompt') {
            // Prompt drag: extend the PromptInput selection to the mapped offset.
            // The cell is clamped to the box rows so a drag outside still tracks
            // the nearest edge of the editable content.
            const offset = promptOffsetAt(x, y);
            dragRef.current.last = { x, y };
            if (offset != null) promptMouseSelectionRef.current?.extendTo?.(offset);
            continue;
          }
          // Drag motion (transcript or status): extend the selection to the
          // current cell, clamped to the owning region's band.
          const selectionY = region === 'status' ? clampToStatusBand(y) : clampToTranscriptViewport(y);
          dragRef.current.last = { x, y: selectionY };
          const span = dragRef.current.anchorSpan;
          if (span) {
            // Word/line multi-click drag: extend by whole words/lines from the
            // anchor span to the word/line under the cursor (see buildSpanRect).
            const rect = buildSpanRect(span, x, selectionY, region, dragRef.current.anchorScroll);
            applySelectionRectThrottled(rect);
          } else {
            const anchor = region === 'status'
              ? dragRef.current.anchor
              : selectionPointAtCurrentScroll(dragRef.current.anchor, dragRef.current.anchorScroll);
            const rect = linearSelection(anchor, { x, y: selectionY });
            applySelectionRectThrottled(rect);
          }
          // Auto-scroll-while-dragging is transcript-only (the status band does
          // not scroll).
          if (region === 'transcript') {
            const rows = Math.max(1, Number(resizeState.rows) || 24);
            if (y <= 1) {
              scrollTranscriptRows(3);
            } else if (y >= rows - 5) {
              scrollTranscriptRows(-3);
            }
          }
        } else if (!press && dragRef.current.active) {
          const region = dragRef.current.region;
          if (region === 'prompt') {
            // Finalize the prompt selection; highlight persists (copy on Ctrl+C).
            const offset = promptOffsetAt(x, y);
            dragRef.current.active = false;
            promptMouseSelectionRef.current?.extendTo?.(offset, true);
            continue;
          }
          // Button release while dragging: finalize with the release coordinate
          // (the SGR release event carries col/row) and keep the selection
          // visible. Copy is NOT automatic — the user presses Ctrl+C to copy.
          // The highlight stays until ESC or a plain click.
          const span = dragRef.current.anchorSpan;
          const releaseY = region === 'status' ? clampToStatusBand(y) : clampToTranscriptViewport(y);
          dragRef.current.active = false;
          if (span) {
            // Word/line multi-click release: finalize from the span to the
            // word/line at the release cell. A release-without-motion resolves
            // to the span itself (in-span target), so the original word/line
            // highlight stays — never cleared as "empty" like a bare click.
            const rect = buildSpanRect(span, x, releaseY, region, dragRef.current.anchorScroll);
            applySelectionRect(rect);
          } else {
            const anchor = region === 'status'
              ? dragRef.current.anchor
              : selectionPointAtCurrentScroll(dragRef.current.anchor, dragRef.current.anchorScroll);
            const rect = linearSelection(anchor, { x, y: releaseY });
            const empty = rect.x1 === rect.x2 && rect.y1 === rect.y2;
            if (empty) {
              applySelectionRect(null); // a plain click clears any prior highlight
            } else {
              // Push the final rect so ink re-renders the visible selection.
              applySelectionRect(rect);
            }
          }
          // Drag is over: the measured-height harvest was skipped for every
          // motion commit (see the harvest effect's dragRef guard), so force one
          // re-measure now to reconcile any row whose true height drifted from
          // its estimate while the drag was in flight.
          if (TRANSCRIPT_MEASURED_ROWS) setMeasuredRowsVersion((v) => (v + 1) % 1000000);
        }
      }
      if (up !== 0 || down !== 0) {
        if (dragRef.current.active) return;
        const palette = slashPaletteRef.current;
        if (palette.open && palette.count > 0) {
          const step = down - up;
          if (step !== 0) {
            setSlashIndex((index) => Math.max(0, Math.min(palette.count - 1, index + step)));
          }
          return;
        }
        if (overlayBlocksGlobalTranscriptScroll(scrollFocusRef.current)) return;
        const STEP = 3; // rows per wheel notch; immediate updates feel steadier in Windows Terminal
        scrollTranscriptRows((up - down) * STEP);
      }
    };
    inkInput.on('input', onData);
    return () => { inkInput.off('input', onData); };
  }, [inkInput, isRawModeSupported, store, passthroughCtrlWheelZoom, resizeState.rows, scrollTranscriptRows, applySelectionRect, applySelectionRectThrottled, selectionPointAtCurrentScroll, buildSpanRect, dismissWelcomePromptHint]);

  // Enable extended keyboard reporting (kitty + xterm modifyOtherKeys) the same
  // way Claude Code does: SYNCHRONOUSLY, ONCE, with NO query/round-trip. ink
  // turns raw mode on during the first useInput mount (synchronously, inside
  // render); this mount effect runs in the same commit phase, right after — i.e.
  // before the user can realistically press a key. We write BOTH enables
  // unconditionally (the terminal honors whichever it implements; Windows
  // Terminal 1.24 has no kitty but DOES honor modifyOtherKeys), gated only by the
  // supportsExtendedKeys() allowlist. Because the enable lands before the first
  // keypress is read, the FIRST Ctrl+Enter already arrives as a distinguishable
  // \x1b[27;5;13~ (or kitty \x1b[13;5u) instead of a bare \r — fixing the old
  // "first Ctrl+Enter submits, second works" race. Teardown lives in index.jsx's
  // restoreTerminal(). The empty dep array makes this run exactly once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isRawModeSupported || !stdout?.write) return;
    if (!supportsExtendedKeys()) return;
    try {
      stdout.write(ENABLE_KITTY_KEYBOARD + ENABLE_MODIFY_OTHER_KEYS);
    } catch { /* terminal may be closing */ }
  }, []);

  // Item-count changes are the only time we can arm follow before row totals are
  // recomputed. Pure streaming height growth is handled in the row-delta effect.
  useLayoutEffect(() => {
    const count = state.items.length;
    const previousCount = lastItemsCountRef.current;
    lastItemsCountRef.current = count;
    if (count < previousCount || previousCount === 0) {
      resetTranscriptScroll();
      return;
    }
    if (count === previousCount || dragRef.current.active) return;
    if (scrollTargetRef.current <= transcriptBottomSlackRows || followingRef.current) followingRef.current = true;
  }, [state.items.length, resetTranscriptScroll]);

  // `exiting` removes the inline caret (PromptInput draws none when disabled) and
  // freezes input for the teardown frame, so the final frame is clean before ink
  // unmounts. Exit just past the render throttle window so that frame flushes.
  const requestExit = useCallback(() => {
    if (exitRequestedRef.current) return;
    exitRequestedRef.current = true;
    setExiting(true);
    const hardExitTimer = setTimeout(() => {
      try { process.stdout.write('\x1b[?25h\x1b[0m'); } catch {}
      process.exit(0);
    }, 2000);
    hardExitTimer.unref?.();
    setTimeout(() => {
      let timer = null;
      Promise.race([
        Promise.resolve(store.dispose?.('cli-react-exit', { detach: true })),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 350);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
        exit();
      });
    }, 60);
  }, [store, exit]);

  const restoreQueuedToPrompt = useCallback((options = {}) => {
    const restoreDraft = options.restoreDraft !== false;
    const showHint = options.showHint !== false;
    const currentText = options.currentText ?? promptValueRef.current ?? promptDraft;
    const restored = store.restoreQueued?.(currentText);
    if (!restored || restored.count === 0) {
      if (showHint) showPromptHint('No queued messages to restore.', 'info');
      return false;
    }
    if (restoreDraft) {
      if (restored.pastedImages) installPastedImages(restored.pastedImages, { merge: true });
      syncPromptLayoutRows(restored.text);
      setPromptDraftOverride({ id: Date.now(), value: restored.text });
    }
    if (showHint) {
      showPromptHint(`restored ${restored.count} queued message${restored.count === 1 ? '' : 's'}`, 'info');
    } else {
      clearPromptHint();
    }
    return true;
  }, [store, promptDraft, showPromptHint, clearPromptHint, installPastedImages, syncPromptLayoutRows]);

  const recentPromptHistory = useMemo(() => {
    const items = Array.isArray(state.items) ? state.items : [];
    const seen = new Set();
    const history = [];
    for (let i = items.length - 1; i >= 0 && history.length < PROMPT_HISTORY_LIMIT; i -= 1) {
      const item = items[i];
      if (item?.kind !== 'user') continue;
      const text = String(item.text || '').trim();
      const key = promptHistoryKey(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      history.push(text);
    }
    return history;
  }, [state.items]);

  const resetPromptHistoryNav = useCallback(() => {
    promptHistoryNavRef.current = { active: false, index: -1, seed: '', lastValue: '' };
  }, []);

  const handlePromptHistoryNavigate = useCallback((direction, currentText = '', meta = {}) => {
    const currentValue = String(currentText || '');
    const currentKey = promptHistoryKey(currentValue);
    const nav = promptHistoryNavRef.current || { active: false, index: -1, seed: '', lastValue: '' };

    if (meta.emptyDraft && direction === 'down') {
      resetPromptHistoryNav();
      clearPromptHint();
      return undefined;
    }

    if (recentPromptHistory.length === 0) {
      resetPromptHistoryNav();
      clearPromptHint();
      return undefined;
    }

    if (direction === 'down' && !nav.active) {
      clearPromptHint();
      return undefined;
    }

    const active = nav.active && (currentValue === nav.lastValue || currentValue === nav.seed);
    const seed = active ? nav.seed : currentValue;
    const step = direction === 'down' ? -1 : 1;
    let nextIndex = (active ? nav.index : -1) + step;

    if (nextIndex < 0) {
      resetPromptHistoryNav();
      clearPromptHint();
      promptHistoryDraftChangeRef.current = true;
      return seed;
    }

    while (nextIndex >= 0 && nextIndex < recentPromptHistory.length && promptHistoryKey(recentPromptHistory[nextIndex]) === currentKey) {
      nextIndex += step;
    }

    if (nextIndex < 0) {
      resetPromptHistoryNav();
      clearPromptHint();
      promptHistoryDraftChangeRef.current = true;
      return seed;
    }

    if (nextIndex >= recentPromptHistory.length) {
      clearPromptHint();
      return undefined;
    }

    const nextValue = recentPromptHistory[nextIndex];
    promptHistoryNavRef.current = { active: true, index: nextIndex, seed, lastValue: nextValue };
    clearPromptHint();
    promptHistoryDraftChangeRef.current = true;
    return nextValue;
  }, [recentPromptHistory, resetPromptHistoryNav, clearPromptHint]);

  // ESC / Up handling (prompt input):
  // - prompt-local overlays such as the slash palette close first.
  // - queued editable messages pop back into the prompt before clear/interrupt.
  // - non-empty prompt text is cleared by PromptInput and must never interrupt
  //   the active turn on the same Esc press.
  // - empty prompt + active turn interrupts the active turn.
  const handlePromptEscape = useCallback((text = '', meta = {}) => {
    // Recording takes priority over every other Esc branch (usage/context
    // panels, slash-clear, queue-restore, turn-interrupt): a live mic capture
    // must never silently keep running because Esc was consumed by something
    // else first. Only consumes Esc while actually RECORDING — transcribing
    // (already stopped, awaiting the HTTP round-trip) and idle fall through
    // to the existing branches unchanged.
    if (getRecorderState() === 'recording') {
      cancelRecording();
      setVoiceStatusHint('', 'info');
      store.pushNotice('Voice: recording cancelled', 'plain');
      return true;
    }
    if (usagePanel) { closeUsagePanel(); return true; }
    if (contextPanel) { setContextPanel(null); return true; }

    if (meta.phase === 'clear') {
      clearPastedImagesSnapshot();
      clearPromptHint();
      return false;
    }
    if (meta.phase === 'empty') {
      return restoreQueuedToPrompt({ restoreDraft: true, showHint: false, currentText: text });
    }
    // Idle + empty + nothing to restore: nothing (double-press from empty
    // opens message selector, but we don't have that feature yet).
    return false;
  }, [contextPanel, usagePanel, closeUsagePanel, restoreQueuedToPrompt, clearPromptHint, clearPastedImagesSnapshot, setVoiceStatusHint, store]);

  const handlePromptInterrupt = useCallback((currentText = '') => {
    const result = store.abort?.();
    if (result?.aborted === false) return undefined;
    if (result?.pastedImages) installPastedImages(result.pastedImages, { merge: true });
    if (result?.discardPastedImages) clearPastedImagesSnapshot(result.discardPastedImages);
    const restoreText = String(result?.restoreText || '').trim();
    if (!restoreText) return undefined;
    const existingText = String(currentText || '').trim();
    const nextText = [restoreText, existingText].filter(Boolean).join('\n');
    clearPromptHint();
    return nextText;
  }, [store, clearPromptHint, installPastedImages, clearPastedImagesSnapshot]);

  // Ctrl+O toggles the global tool-output expansion, matching common terminal-chat
  // expectation that this is a view mode rather than a per-card hidden state.
  const toggleExpand = useCallback(() => {
    setToolOutputExpanded((expanded) => !expanded);
  }, []);

  useInput((input, key) => {
    if (!welcomePromptHintDismissed) dismissWelcomePromptHint();
    if (toolApproval) {
      const value = String(input || '').trim().toLowerCase();
      if (key.escape || value === 'd' || value === 'n') {
        store.resolveToolApproval?.(toolApproval.id, { approved: false, reason: 'denied by user' });
        return;
      }
      if (value === 'a' || value === 'y') {
        store.resolveToolApproval?.(toolApproval.id, { approved: true, reason: 'approved by user' });
        return;
      }
    }
    if (key.ctrl && (input === 'c' || input === 'C')) {
      // Ctrl+C is copy-first. Native terminal selections can still forward the
      // key event to us on Windows Terminal, so a missing app-owned selection
      // must NOT cancel the active turn; use Esc to interrupt instead.
      // Region-aware copy source: a prompt-box selection (its OWN engine) copies
      // from promptSelectionRef; a transcript/status ink-grid selection copies
      // from store.getRenderSelectionText via copySelection(). Only one region is
      // ever active at a time (a press in one region clears the others), but when
      // the last drag was in the prompt we prefer its selection explicitly.
      const promptSelectionText = promptSelectionRef.current?.text;
      const lastRegion = dragRef.current.region;
      const inkRect = dragRef.current.rect;
      const hasInkSelection = inkRect && !(inkRect.x1 === inkRect.x2 && inkRect.y1 === inkRect.y2);
      if (promptSelectionText && (lastRegion === 'prompt' || !hasInkSelection)) {
        copyToClipboard(promptSelectionText)
          .then(() => showSelectionCopyHint(`copied ${promptSelectionText.length} char${promptSelectionText.length === 1 ? '' : 's'}`, 'plain'))
          .catch((e) => showSelectionCopyHint(`copy failed: ${e?.message || e}`, 'error'));
        return;
      }
      if (hasInkSelection) {
        copySelection();
        return;
      }
      showSelectionCopyHint('select text to copy · Esc interrupts', 'plain');
      return;
    }
    if (key.ctrl && (input === 'o' || input === 'O')) {
      toggleExpand();
      return;
    }
    if (
      !picker
      && key.shift
      && (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.home || key.end)
    ) {
      // Consume the chord whenever a transcript/status ink-grid selection is
      // live — even if the focus clamps at an edge (moveSelectionFocus returns
      // false there). PromptInput independently skips the same chord via the
      // shared gridSelectionActiveRef predicate, so there is no double-handling.
      // When no grid selection is live, fall through to PromptInput.
      let move = null;
      if (key.leftArrow) move = 'left';
      else if (key.rightArrow) move = 'right';
      else if (key.upArrow) move = 'up';
      else if (key.downArrow) move = 'down';
      else if (key.home) move = 'lineStart';
      else if (key.end) move = 'lineEnd';
      if (move && gridSelectionActiveRef.current()) {
        moveSelectionFocus(move);
        return;
      }
    }
    if (key.escape && usagePanel && !picker) {
      closeUsagePanel();
      return;
    }
    if (key.escape && contextPanel && !picker) {
      setContextPanel(null);
      return;
    }
    if (key.pageUp) {
      if (overlayBlocksGlobalTranscriptScroll(scrollFocusRef.current)) return;
      const pageRows = Math.max(3, Math.floor((resizeState.rows ?? 24) * 0.6));
      scrollTranscriptRows(pageRows);
      return;
    }
    if (key.pageDown) {
      if (overlayBlocksGlobalTranscriptScroll(scrollFocusRef.current)) return;
      const pageRows = Math.max(3, Math.floor((resizeState.rows ?? 24) * 0.6));
      scrollTranscriptRows(-pageRows);
      return;
    }
    if (key.ctrl && key.end) {
      resetTranscriptScroll();
      return;
    }
    if (key.escape && !picker) {
      dragRef.current.active = false;
      dragRef.current.region = null;
      dragRef.current.anchorSpan = null;
      // Clear whichever region's selection is active. PromptInput's own ESC also
      // clears its selection when focused/enabled; this covers the disabled case
      // and a status/transcript ink-grid selection in one press.
      promptMouseSelectionRef.current?.clear?.();
      applySelectionRect(null);
    }
  }, { isActive: isRawModeSupported });

  const parsedModelVersion = (id) => {
    const text = String(id || '').toLowerCase();
    const claude = text.match(/^claude-[a-z]+-(\d+)(?:[-.](\d+))?/);
    if (claude) return [Number(claude[1]) || 0, Number(claude[2]) || 0];
    const compact = text.match(/(?:^|[-_])(?:o|gpt|grok|qwen|llama|mistral|gemma|phi|glm)(\d+)(?:\.(\d+))?(?:\.(\d{1,3}))?/);
    if (compact) return compact.slice(1).filter((v) => v != null).map((v) => Number(v) || 0);
    const generic = text.match(/(?:^|[-_v])(\d+)(?:\.(\d+))?(?:\.(\d{1,3}))?/);
    if (!generic) return [];
    return generic.slice(1).filter((v) => v != null).map((v) => Number(v) || 0);
  };

  const releaseTime = (m) => {
    if (m?.releaseDate) {
      const t = Date.parse(m.releaseDate);
      if (Number.isFinite(t)) return t;
    }
    const created = Number(m?.created);
    if (Number.isFinite(created) && created > 0) {
      return created < 1_000_000_000_000 ? created * 1000 : created;
    }
    const dated = String(m?.id || '').match(/(?:^|-)(\d{4})(\d{2})(\d{2})(?:$|-)/);
    if (!dated) return 0;
    return Date.parse(`${dated[1]}-${dated[2]}-${dated[3]}`) || 0;
  };

  const isClaudeModel = (m) => {
    const provider = String(m?.provider || '').toLowerCase();
    const id = String(m?.id || '').toLowerCase();
    return provider.includes('anthropic') && /^claude-[a-z]+-/.test(id);
  };

  const modelVersion = (m) => {
    const fromId = parsedModelVersion(m?.id);
    return fromId.length ? fromId : parsedModelVersion(m?.display || m?.name);
  };

  const compareModelVersion = (a, b) => {
    const va = modelVersion(a);
    const vb = modelVersion(b);
    if (va.length === 0 && vb.length === 0) return 0;
    if (va.length === 0) return 1;
    if (vb.length === 0) return -1;
    for (let i = 0; i < Math.max(va.length, vb.length); i += 1) {
      const delta = (vb[i] || 0) - (va[i] || 0);
      if (delta) return delta;
    }
    return 0;
  };

  const compareModelRecency = (a, b) => {
    if (isClaudeModel(a) && isClaudeModel(b)) {
      if (!!a?.latest !== !!b?.latest) return a?.latest ? -1 : 1;
      const versionDelta = compareModelVersion(a, b);
      if (versionDelta) return versionDelta;
      const ta = releaseTime(a);
      const tb = releaseTime(b);
      if (ta !== tb) return tb - ta;
      return String(a?.display || a?.id || '').localeCompare(String(b?.display || b?.id || ''));
    }

    const ta = releaseTime(a);
    const tb = releaseTime(b);
    if (ta !== tb) return tb - ta;

    if (!!a?.latest !== !!b?.latest) return a?.latest ? -1 : 1;
    const versionDelta = compareModelVersion(a, b);
    if (versionDelta) return versionDelta;
    return String(a?.display || a?.id || '').localeCompare(String(b?.display || b?.id || ''));
  };

  const modelFamily = (m) => {
    const text = String(m?.id || m?.display || '').toLowerCase();
    const claude = text.match(/^claude-([a-z]+)/);
    if (claude) return claude[1];
    if (m?.family) return String(m.family).toLowerCase();
    const first = text.match(/^[a-z]+(?:-[a-z]+)?/);
    return first ? first[0] : 'model';
  };

  const modelContextWindow = (m) => {
    const raw = Number(m?.contextWindow);
    const n = Number.isFinite(raw) && raw > 0 ? raw : 0;
    const provider = String(m?.provider || '').toLowerCase();
    const id = String(m?.id || '').toLowerCase();
    const version = parsedModelVersion(id);
    if (provider.includes('anthropic') && /^claude-[a-z]+-/.test(id)) {
      if ((version[0] || 0) >= 5) return Math.max(n, 1_000_000);
      if (/^claude-(opus|sonnet)-4-(6|7|8)(?:$|-)/.test(id)) return Math.max(n, 1_000_000);
    }
    return n;
  };

  const formatContextWindow = (tokens) => {
    const n = Number(tokens);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 1_000_000) {
      const m = n / 1_000_000;
      return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M Context`;
    }
    return `${Math.round(n / 1000)}k Context`;
  };

  const modelFamilyLimit = (provider, family) => {
    const p = String(provider || '').toLowerCase();
    if (!p.includes('anthropic')) return 8;
    if (family === 'opus') return 3;
    return 1;
  };

  const normalizeModelOptions = (models) => {
    if (!Array.isArray(models)) return [];
    const providers = new Map();
    for (const model of models) {
      if (!model?.provider || !model?.id) continue;
      if (!providers.has(model.provider)) providers.set(model.provider, new Map());
      const families = providers.get(model.provider);
      const family = modelFamily(model);
      if (!families.has(family)) families.set(family, []);
      families.get(family).push(model);
    }

    const normalized = [];
    for (const [provider, families] of providers.entries()) {
      const providerModels = [];
      for (const [family, group] of families.entries()) {
        const limit = modelFamilyLimit(provider, family);
        providerModels.push(...group.slice().sort(compareModelRecency).slice(0, limit));
      }
      normalized.push(...providerModels.sort(compareModelRecency));
    }
    return normalized;
  };

  const providerDisplayName = (provider) => {
    const key = String(provider || '').toLowerCase();
    if (key === 'openai-oauth') return 'OpenAI OAuth';
    if (key === 'anthropic-oauth') return 'Anthropic OAuth';
    if (key === 'grok-oauth') return 'Grok Build';
    if (key === 'openai' || key === 'openai-api') return 'OpenAI API';
    if (key === 'anthropic' || key === 'anthropic-api') return 'Anthropic API';
    if (key === 'gemini' || key === 'gemini-api') return 'Gemini API';
    if (key === 'xai' || key === 'xai-api') return 'xAI API';
    if (key === 'deepseek' || key === 'deepseek-api') return 'DeepSeek API';
    if (key === 'opencode-go') return 'OpenCode Go API';
    if (key === 'ollama') return 'Ollama';
    if (key === 'lmstudio') return 'LM Studio';
    if (key === 'default') return 'Default';
    return provider || 'Provider';
  };

  const providerDisplayRank = (provider) => {
    const key = String(provider || '').toLowerCase();
    const ranks = {
      default: 0,
      'openai-oauth': 10,
      'anthropic-oauth': 20,
      'grok-oauth': 30,
      openai: 40,
      'openai-api': 40,
      anthropic: 50,
      'anthropic-api': 50,
      gemini: 60,
      'gemini-api': 60,
      xai: 70,
      'xai-api': 70,
      'opencode-go': 80,
      deepseek: 90,
      'deepseek-api': 90,
      ollama: 100,
      lmstudio: 110,
    };
    return ranks[key] ?? 900;
  };

  const titleCaseOption = (value) => String(value || '')
    .split(/([\s_-]+)/)
    .map((part) => /^[\s_-]+$/.test(part) ? part : `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join('');

  const effortDisplayLabel = (value) => {
    const text = String(value || '').trim();
    if (!text) return '';
    if (text.toLowerCase() === 'xhigh') return 'XHigh';
    return titleCaseOption(text);
  };

  const fastDisplayLabel = (enabled = true) => `Fast ${enabled ? 'On' : 'Off'}`;

  const modelDescription = (m) => [formatContextWindow(modelContextWindow(m)), m.fastCapable ? 'Fast Available' : ''].filter(Boolean).join(' · ');

  const modelRecordDisplayName = (model) => displayModelName(
    model?.id,
    model?.provider,
    model?.display || model?.name,
  );

  const routeModelDisplayName = (route) => displayModelName(route?.model, route?.provider);

  const groupModelsByProvider = (models) => {
    const providers = new Map();
    for (const model of models) {
      if (!providers.has(model.provider)) providers.set(model.provider, []);
      providers.get(model.provider).push(model);
    }

    const orderedProviders = [...providers.keys()].sort((a, b) => {
      const rank = providerDisplayRank(a) - providerDisplayRank(b);
      if (rank !== 0) return rank;
      const label = providerDisplayName(a).localeCompare(providerDisplayName(b));
      if (label !== 0) return label;
      return a.localeCompare(b);
    });
    return { providers, orderedProviders };
  };

  const buildModelProviderItems = (models, currentRoute = null) => {
    const { providers, orderedProviders } = groupModelsByProvider(models);
    return orderedProviders.map((provider) => {
      const providerModels = providers.get(provider) || [];
      const currentModel = currentRoute?.provider === provider
        ? providerModels.find((model) => model.id === currentRoute.model)
        : null;
      return {
        value: `provider:${provider}`,
        label: providerDisplayName(provider),
        marker: currentModel ? '✓' : '',
        markerColor: theme.success,
        meta: currentModel ? modelRecordDisplayName(currentModel) : '',
        description: `${providerModels.length} model${providerModels.length === 1 ? '' : 's'}`,
        _action: 'open-provider',
        _provider: provider,
      };
    });
  };

  const buildProviderModelItems = (models, provider, currentRoute = null) => {
    const providerModels = models.filter((model) => model.provider === provider);
    return providerModels.map((model) => ({
      value: `model:${model.provider}:${model.id}`,
      label: modelRecordDisplayName(model),
      marker: currentRoute?.provider === model.provider && currentRoute?.model === model.id ? '✓' : '',
      markerColor: theme.success,
      description: modelDescription(model),
      _action: 'select-model',
      _provider: model.provider,
      _modelId: model.id,
      _model: model,
    }));
  };

  const routeLabel = (route) => {
    if (!route?.provider || !route?.model) return '(unset)';
    return [
      providerDisplayName(route.provider),
      routeModelDisplayName(route),
      route.effort ? effortDisplayLabel(route.effort) : '',
      route.fast ? 'Fast' : '',
    ].filter(Boolean).join(' · ');
  };

  const routeModelLabel = (route) => {
    if (!route?.model) return '(unset)';
    return [
      routeModelDisplayName(route),
      route.effort ? effortDisplayLabel(route.effort) : '',
      route.fast ? 'Fast' : '',
    ].filter(Boolean).join(' · ');
  };

  const agentModelProfile = (route) => {
    if (!route?.model) return '';
    return [
      routeModelDisplayName(route),
      route.effort ? effortDisplayLabel(route.effort) : '',
      route.fast ? 'Fast' : '',
    ].filter(Boolean).join(' · ');
  };

  const agentModelParts = (route) => [
    { text: route?.model ? routeModelDisplayName(route) : '', width: 17 },
    { text: route?.effort ? effortDisplayLabel(route.effort) : '', width: 6 },
    { text: route?.fast ? 'Fast' : '', width: 4 },
  ];

  const routeFromModel = (model, effort = null) => ({
    provider: model.provider,
    model: model.id,
    ...(effort && effort !== 'auto' ? { effort } : {}),
  });

  const modelScore = (model, slot) => {
    const text = `${model.provider} ${model.id} ${model.display} ${model.family || ''} ${model.tier || ''}`.toLowerCase();
    let score = 0;
    if (model.latest) score += 6;
    if (slot === 'lead' || slot === 'review') {
      if (/opus|gpt-5\.5|gpt-5|sonnet/.test(text)) score += 20;
      if (/mini|nano|haiku|flash/.test(text)) score -= 5;
    } else if (slot === 'memory') {
      if (/haiku|mini|nano|flash|fast/.test(text)) score += 20;
      if (/opus|max/.test(text)) score -= 4;
    } else if (slot === 'explorer' || slot === 'agent') {
      if (/sonnet|gpt-5|mini|haiku|flash/.test(text)) score += 12;
      if (/opus/.test(text)) score += slot === 'agent' ? 3 : -2;
    }
    if (model.supportsFunctionCalling) score += 2;
    return score;
  };

  const chooseRecommendedModel = (models, slot, fallbackRoute) => {
    if (!Array.isArray(models) || models.length === 0) return null;
    const sorted = models.slice().sort((a, b) => modelScore(b, slot) - modelScore(a, slot));
    return sorted[0] ? routeFromModel(sorted[0]) : (fallbackRoute || null);
  };

  const buildWorkflowDefaults = (models, defaultRoute) => ({
    lead: defaultRoute,
    agent: chooseRecommendedModel(models, 'agent', defaultRoute),
    explorer: chooseRecommendedModel(models, 'explorer', defaultRoute),
    memory: chooseRecommendedModel(models, 'memory', defaultRoute),
  });

  const openModelPicker = async (options = {}) => {
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    const modelPickerRequest = ++modelPickerRequestRef.current;
    let modelPickerClosed = false;
    let activeModelProvider = null;
    let providerListHighlightProvider = null;
    const isActiveModelPicker = () => !modelPickerClosed && modelPickerRequestRef.current === modelPickerRequest;
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    const returnLabel = String(options.returnLabel || 'Agents');
    const returnOnNestedCancel = options.returnOnNestedCancel === true;
    const cancelModelPicker = () => {
      modelPickerClosed = true;
      if (returnTo) returnTo();
      else setPicker(null);
    };
    const cacheRef = options.cacheRef === 'search' ? searchModelsCacheRef : providerModelsCacheRef;
    const loadModels = typeof options.loadModels === 'function' ? options.loadModels : store.listProviderModels;
    let providerModels = Array.isArray(cacheRef.current.models)
      ? cacheRef.current.models
      : [];
    let refreshModelsPromise = null;
    let renderedQuickModels = false;
    if (!providerModels.length || options.refreshModels === true) {
      setPicker({
        title: options.title || 'Model',
        description: options.loadingDescription || 'Loading models...',
        help: returnTo ? `↑/↓ Select · Enter Open · Esc ${returnLabel}` : '↑/↓ Select · Enter Open · Esc Back',
        items: [],
        onCancel: cancelModelPicker,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        if (options.refreshModels !== true && options.cacheRef !== 'search') {
          refreshModelsPromise = Promise.resolve(loadModels({ force: false }));
          providerModels = await loadModels({ quick: true });
          renderedQuickModels = Array.isArray(providerModels) && providerModels.length > 0;
          if (!renderedQuickModels) {
            providerModels = await refreshModelsPromise;
          }
        } else {
          providerModels = await loadModels({ force: options.refreshModels === true });
        }
        cacheRef.current = { models: providerModels, at: Date.now() };
      } catch (e) {
        store.pushNotice(`could not list models: ${e?.message || e}`, 'error');
        return;
      }
    }

    if (!providerModels || providerModels.length === 0) {
      store.pushNotice(options.emptyNotice || 'no provider models available; open /providers to sign in', 'warn');
      void openProviderSetupPicker({
        title: 'Providers',
        continueLabel: 'Back to model setup',
        continueDescription: 'retry model list after provider auth',
        onContinue: () => void openModelPicker(options),
      });
      return;
    }

    let models = normalizeModelOptions(providerModels);
    const activeRoute = options.currentRoute || {
      provider: state.provider,
      model: state.model,
      effort: state.effort,
      fast: state.fast,
    };
    const renderModelPicker = (renderOptions = {}) => {
      if (renderOptions.highlightProvider) {
        providerListHighlightProvider = renderOptions.highlightProvider;
      }
      const highlightProvider = renderOptions.highlightProvider || providerListHighlightProvider || null;
      activeModelProvider = null;
      const openProviderModelsPicker = (provider) => {
        if (!provider) return;
        activeModelProvider = provider;
        const providerModels = models.filter((model) => model.provider === provider);
        const preferredEffort = (values = []) => {
          const allowed = values.filter(Boolean);
          for (const value of ['high', 'medium', 'low', 'none', 'xhigh', 'max']) {
            if (allowed.includes(value)) return value;
          }
          return allowed[0] || null;
        };
        const effortItemsFor = (model) => Array.isArray(model?.effortOptions) && model.effortOptions.length > 0
          ? model.effortOptions
          : [];
        const modelEffortValues = (model) => effortItemsFor(model).map((effort) => effort.value).filter(Boolean);
        const modelDefaultEffort = (model) => {
          const values = modelEffortValues(model);
          if (!values.length) return null;
          const currentRoute = options.currentRoute || null;
          if (currentRoute?.provider === model.provider && currentRoute?.model === model.id && currentRoute.effort && values.includes(currentRoute.effort)) return currentRoute.effort;
          if (model.provider === state.provider && model.id === state.model && state.effort && values.includes(state.effort)) return state.effort;
          if (model.savedEffort && values.includes(model.savedEffort)) return model.savedEffort;
          return preferredEffort(values);
        };
        const selectedEfforts = new Map();
        const modelKey = (model) => `${model?.provider || ''}\n${model?.id || ''}`;
        const getSelectedEffort = (model) => {
          if (!model) return null;
          const key = modelKey(model);
          if (selectedEfforts.has(key)) return selectedEfforts.get(key);
          const effort = modelDefaultEffort(model);
          selectedEfforts.set(key, effort);
          return effort;
        };
        const setSelectedEffort = (model, effort) => {
          if (!model) return;
          selectedEfforts.set(modelKey(model), effort || null);
        };
        const selectedFast = new Map();
        const modelDefaultFast = (model) => {
          if (!model?.fastCapable) return false;
          const currentRoute = options.currentRoute || null;
          if (currentRoute?.provider === model.provider && currentRoute?.model === model.id && typeof currentRoute.fast === 'boolean') return currentRoute.fast;
          if (model.provider === state.provider && model.id === state.model && typeof state.fast === 'boolean') return state.fast;
          if (typeof model.savedFast === 'boolean') return model.savedFast;
          return model.fastPreferred === true;
        };
        const getSelectedFast = (model) => {
          if (!model) return false;
          const key = modelKey(model);
          if (selectedFast.has(key)) return selectedFast.get(key) === true;
          const fast = modelDefaultFast(model);
          selectedFast.set(key, fast);
          return fast;
        };
        const toggleFast = (model) => {
          if (!model?.fastCapable) return;
          selectedFast.set(modelKey(model), !getSelectedFast(model));
          renderProviderModels();
        };
        const providerEffortItems = () => {
          const seen = new Set();
          const out = [];
          for (const effort of providerModels.flatMap((model) => effortItemsFor(model))) {
            if (!effort?.value || seen.has(effort.value)) continue;
            seen.add(effort.value);
            out.push(effort);
          }
          return out;
        };
        const effortLabel = (value) => {
          const found = providerEffortItems().find((effort) => effort.value === value);
          return effortDisplayLabel(found?.label || value || '');
        };
        const effortGlyph = (value) => {
          if (value === 'none') return '○';
          if (value === 'low') return '◔';
          if (value === 'medium') return '◑';
          if (value === 'high') return '◕';
          if (value === 'max') return '◆';
          return '●';
        };
        const effortColor = (value) => {
          if (value === 'none') return theme.inactive;
          if (value === 'low') return theme.warning;
          if (value === 'medium') return theme.claude;
          if (value === 'high') return theme.error;
          if (value === 'max') return theme.permission;
          return theme.error;
        };
        const modelFooter = (model = null) => {
          const items = model ? effortItemsFor(model) : providerEffortItems();
          const values = items.map((effort) => effort.value).filter(Boolean);
          const fastCapable = model?.fastCapable === true;
          const fastOn = fastCapable && getSelectedFast(model);
          const fastLine = fastCapable
            ? { glyph: fastOn ? '●' : '○', color: fastOn ? theme.fastMode : theme.inactive, text: `${fastDisplayLabel(fastOn)} · Tab Toggle` }
            : null;
          if (!values.length) {
            return fastLine ? [fastLine] : '';
          }
          let selectedEffort = getSelectedEffort(model);
          if (!values.includes(selectedEffort)) {
            selectedEffort = modelDefaultEffort(model);
            setSelectedEffort(model, selectedEffort);
          }
          const effortLine = {
            glyph: effortGlyph(selectedEffort),
            color: effortColor(selectedEffort),
            text: `${effortLabel(selectedEffort)} Effort ←/→ To Adjust`,
          };
          return fastLine ? [effortLine, fastLine] : [effortLine];
        };
        const coerceEffort = (model) => {
          const values = modelEffortValues(model);
          if (!values.length) return null;
          const selectedEffort = getSelectedEffort(model);
          return values.includes(selectedEffort) ? selectedEffort : modelDefaultEffort(model);
        };
        const cycleEffort = (model, direction = 1) => {
          const values = modelEffortValues(model);
          if (values.length === 0) return;
          const selectedEffort = getSelectedEffort(model);
          const currentValue = values.includes(selectedEffort) ? selectedEffort : modelDefaultEffort(model);
          const current = values.includes(currentValue) ? values.indexOf(currentValue) : 0;
          setSelectedEffort(model, values[(current + direction + values.length) % values.length] || null);
          renderProviderModels();
        };
        const applyModel = (item) => {
          const selected = item?._model || models.find((m) => m.provider === item?._provider && m.id === item?._modelId);
          if (!selected) return;
          modelPickerClosed = true;
          const effort = coerceEffort(selected);
          const routeInput = {
            provider: selected.provider,
            model: selected.id,
            ...(effort ? { effort } : {}),
            ...(selected.fastCapable ? { fast: getSelectedFast(selected) } : {}),
          };
          if (typeof options.onSelectRoute === 'function') {
            const savePromise = Promise.resolve(options.onSelectRoute(routeInput, selected, effort));
            if (typeof options.onImmediateSelect === 'function') {
              options.onImmediateSelect(routeInput, selected, effort);
            } else {
              setPicker(null);
            }
            void savePromise
              .then((result) => {
                if (result) clearModelCaches('all');
                if (typeof options.onAfterSelect === 'function') options.onAfterSelect();
                return result;
              })
              .catch((e) => store.pushNotice(`Couldn’t save model: ${e?.message || e}`, 'error'));
            return;
          }
          setPicker(null);
          void store.setRoute(routeInput)
            .then((ok) => {
              if (ok) clearModelCaches('provider');
              store.pushNotice(
                ok
                  ? modelSwitchNotice()
                  : 'Model switch is already running',
                ok ? 'info' : 'warn',
              );
              if (ok && typeof options.onAfterSelect === 'function') options.onAfterSelect();
            })
            .catch((e) => store.pushNotice(`Couldn’t switch model: ${e?.message || e}`, 'error'));
        };
        const renderProviderModels = () => {
          const providerModelItems = buildProviderModelItems(models, provider, activeRoute);
          const providerModelInitialIndex = Math.max(
            0,
            providerModelItems.findIndex(
              (item) => item._provider === activeRoute?.provider && item._modelId === activeRoute?.model,
            ),
          );
          setPicker({
            title: providerDisplayName(provider),
            description: options.modelDescription || 'Select a model. Adjust Effort with ←/→.',
            footer: (item) => modelFooter(item?._model),
            help: returnOnNestedCancel && returnTo
              ? `↑/↓ Select · ←/→ Effort · Tab Fast · Enter Save · Esc ${returnLabel}`
              : '↑/↓ Select · ←/→ Effort · Tab Fast · Enter Save · Esc Back',
            indexMode: 'always',
            initialIndex: providerModelInitialIndex,
            pickerKey: `model-picker:provider-models:${provider}`,
            items: providerModelItems,
            onSelect: (_value, item) => applyModel(item),
            onLeft: (item) => {
              if (item?._model) cycleEffort(item._model, -1);
            },
            onRight: (item) => {
              if (item?._model) cycleEffort(item._model, 1);
            },
            onTab: (item) => {
              if (item?._model) toggleFast(item._model);
            },
            onCancel: () => {
              if (returnOnNestedCancel && returnTo) cancelModelPicker();
              else renderModelPicker({ highlightProvider: provider });
            },
          });
        };
        renderProviderModels();
      };
      const providerItems = buildModelProviderItems(models, activeRoute);
      const providerHighlight = highlightProvider || activeRoute?.provider || null;
      const providerInitialIndex = Math.max(
        0,
        providerItems.findIndex((item) => item._provider === providerHighlight),
      );
      setPicker({
        title: options.title || 'Model',
        description: options.providerDescription || 'Choose a provider.',
        help: returnTo ? `↑/↓ Select · Enter Open · Esc ${returnLabel}` : '↑/↓ Select · Enter Open · Esc Back',
        indexMode: 'always',
        labelWidth: 18,
        metaWidth: 20,
        initialIndex: providerInitialIndex,
        pickerKey: `model-picker:providers:${providerHighlight || 'default'}`,
        items: providerItems,
        onSelect: (_value, item) => {
          if (item?._provider) openProviderModelsPicker(item._provider);
        },
        onHighlight: (_value, item) => {
          if (item?._provider) providerListHighlightProvider = item._provider;
        },
        onCancel: cancelModelPicker,
      });
    };

    renderModelPicker();
    if (renderedQuickModels && refreshModelsPromise) {
      void refreshModelsPromise
        .then((freshModels) => {
          if (!isActiveModelPicker()) return;
          if (!Array.isArray(freshModels) || freshModels.length === 0) return;
          providerModels = freshModels;
          models = normalizeModelOptions(providerModels);
          cacheRef.current = { models: providerModels, at: Date.now() };
          if (activeModelProvider === null) {
            renderModelPicker();
          }
        })
        .catch(() => {});
    }
  };

  const openSearchPicker = (options = {}) => {
    const routeOverride = options.routeOverride || null;
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    void openModelPicker({
      title: 'Search Model',
      loadingDescription: 'Loading search-capable models...',
      providerDescription: 'Choose native search provider.',
      modelDescription: 'Select native search model. Adjust Effort with ←/→.',
      emptyNotice: 'no native search models available; connect OpenAI, Grok, Gemini, or Anthropic',
      cacheRef: 'search',
      loadModels: store.listSearchModels,
      currentRoute: routeOverride || store.getSearchRoute?.() || null,
      returnTo,
      returnLabel: options.returnLabel || 'Settings',
      returnOnNestedCancel: options.returnOnNestedCancel === true,
      onImmediateSelect: () => {
        if (returnTo) returnTo();
        else setPicker(null);
      },
      onSelectRoute: async (routeInput) => {
        const result = await store.setSearchRoute?.(routeInput);
        if (!result) {
          store.pushNotice('Search model save is already running.', 'warn');
          return;
        }
        store.pushNotice(`Search model set to ${routeLabel(result)}`, 'info');
        return result;
      },
      onAfterSelect: null,
    });
  };

  const openAgentsPicker = (options = {}) => {
    let agents = [];
    try {
      agents = store.listAgents?.() || [];
    } catch (e) {
      store.pushNotice(`could not list agents: ${e?.message || e}`, 'error');
      return;
    }
    const routeOverrides = options.routeOverrides && typeof options.routeOverrides === 'object' ? options.routeOverrides : {};
    const initialAgentId = clean(options.initialAgentId || '');
    const items = agents.map((agent) => ({
      value: agent.id,
      label: agent.label,
      metaParts: agentModelParts(routeOverrides[agent.id] || agent.route),
      description: agent.description || agent.definition?.description || '',
      _agent: agent,
    }));
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    setPicker({
      title: 'Agents',
      description: 'Workflow agents available for agent tasks.',
      help: '↑/↓ Select · Enter Set Model · Esc Back',
      indexMode: 'always',
      labelWidth: 18,
      metaWidth: 33,
      initialIndex: Math.max(0, items.findIndex((item) => item.value === initialAgentId)),
      items,
      onSelect: (_value, item) => {
        const agent = item?._agent;
        if (!agent) return;
        void openModelPicker({
          title: `${agent.label} Model`,
          providerDescription: 'Choose a provider for this agent.',
          currentRoute: agent.route || null,
          returnTo: () => openAgentsPicker(),
          onImmediateSelect: (routeInput) => {
            openAgentsPicker({ routeOverrides: { [agent.id]: routeInput }, initialAgentId: agent.id });
          },
          onSelectRoute: async (routeInput) => {
            const result = await store.setAgentRoute?.(agent.id, routeInput);
            if (!result) {
              store.pushNotice('Agent model save is already running.', 'warn');
              return;
            }
            store.pushNotice(`${agent.label} model set to ${agentModelProfile(result)}`, 'info');
          },
        });
      },
      onCancel: () => {
        setPicker(null);
      },
    });
  };

  const openWorkflowPicker = (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    let workflows = [];
    try {
      workflows = store.listWorkflows?.() || [];
    } catch (e) {
      store.pushNotice(`could not list workflows: ${e?.message || e}`, 'error');
      return;
    }
    if (!workflows.length) {
      store.pushNotice('no workflows available', 'warn');
      return;
    }
    const items = workflows.map((workflow) => ({
      value: workflow.id,
      label: workflow.name,
      marker: workflow.active ? '✓' : '',
      markerColor: theme.success,
      description: workflow.description || `${workflow.source || 'workflow'} workflow`,
      _workflow: workflow,
    }));
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    setPicker({
      title: 'Workflow',
      description: 'Select active workflow.',
      help: returnTo ? '↑/↓ Select · Enter Choose · Esc Settings' : '↑/↓ Select · Enter Choose · Esc Back',
      labelWidth: 18,
      items,
      onSelect: (_value, item) => {
        const workflow = item?._workflow;
        if (!workflow) return;
        setPicker(null);
        void store.setWorkflow?.(workflow.id)
          .then((result) => {
            if (!result) {
              store.pushNotice('Workflow switch is already running.', 'warn');
              return;
            }
            store.pushNotice(workflowSwitchNotice(result), 'info');
            if (returnTo) returnTo();
          })
          .catch((e) => store.pushNotice(`Couldn’t switch workflow: ${e?.message || e}`, 'error'));
      },
      onCancel: () => {
        setPicker(null);
        if (returnTo) returnTo();
      },
    });
  };

  const outputStyleNotice = (result) => {
    const label = result?.current?.label || result?.current?.id || result?.configured || 'Default';
    return result?.appliedToCurrentSession === false
      ? `Output style set to ${label}. Use /clear to apply to this chat.`
      : `Output style set to ${label}.`;
  };

  const openOutputStylePicker = (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    // Onboarding mode: Enter (row select) and ConfirmBar Next must both persist
    // the chosen style, then advance. `onboarding.onAdvance/onBack` drive the
    // wizard; the confirm bar is built here so both paths share `saveStyle`.
    const onboarding = options.onboarding || null;
    let status = null;
    try {
      status = store.listOutputStyles?.() || null;
    } catch (e) {
      store.pushNotice(`could not list output styles: ${e?.message || e}`, 'error');
      return;
    }
    const styles = Array.isArray(status?.styles) ? status.styles : [];
    if (!styles.length) {
      store.pushNotice('no output styles available', 'warn');
      return;
    }
    const currentId = status?.current?.id || 'default';
    let highlightedStyleId = currentId;
    const items = styles.map((style) => ({
      value: style.id,
      label: style.label || style.id,
      marker: style.id === currentId ? '✓' : '',
      markerColor: theme.success,
      description: style.description || style.source || 'output style',
      _style: style,
    }));
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    const saveStyle = (styleId, { advance = false } = {}) => {
      if (!styleId) return;
      setPicker(null);
      void store.setOutputStyle?.(styleId)
        .then((result) => {
          if (!result) {
            store.pushNotice('Output style switch is already running.', 'warn');
          } else {
            store.pushNotice(outputStyleNotice(result), 'info');
          }
          if (advance && onboarding) onboarding.onAdvance?.();
          else if (returnTo) returnTo();
        })
        .catch((e) => store.pushNotice(`Couldn’t switch output style: ${e?.message || e}`, 'error'));
    };
    setPicker({
      title: 'Output Style',
      description: 'Select response style.',
      // Onboarding uses a ConfirmBar (←/→ = Back/Next); let the Picker supply
      // its ConfirmBar help instead of a stale ←/→ hint.
      help: onboarding ? undefined : (returnTo ? '↑/↓ Select · Enter Choose · Esc Settings' : '↑/↓ Select · Enter Choose · Esc Back'),
      labelWidth: 18,
      items,
      confirmBar: onboarding ? {
        buttons: [
          { value: 'back', label: '◀ Back' },
          { value: 'next', label: 'Next ▶' },
        ],
        onConfirm: (button) => {
          if (button.value === 'back') {
            setPicker(null);
            onboarding.onBack?.();
            return;
          }
          saveStyle(highlightedStyleId, { advance: true });
        },
      } : (options.confirmBar || null),
      onHighlight: onboarding ? (_value, item) => {
        if (item?._style?.id) highlightedStyleId = item._style.id;
      } : undefined,
      onSelect: (_value, item) => {
        const style = item?._style;
        if (!style) return;
        saveStyle(style.id, { advance: Boolean(onboarding) });
      },
      onCancel: () => {
        setPicker(null);
        if (onboarding) onboarding.onCancel?.();
        else if (returnTo) returnTo();
      },
    });
  };

  const themeNotice = (applied) => `Theme set to ${applied?.label || applied?.id || 'default'}`;

  const openThemePicker = (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    const onboarding = options.onboarding || null;
    let themes = [];
    try {
      themes = store.listThemes?.() || [];
    } catch (e) {
      store.pushNotice(`could not list themes: ${e?.message || e}`, 'error');
      return;
    }
    if (!themes.length) {
      store.pushNotice('no themes available', 'warn');
      return;
    }
    const currentId = store.getTheme?.() || themes.find((t) => t.current)?.id || themes[0]?.id;
    let highlightedThemeId = currentId;
    const items = themes.map((entry) => ({
      value: entry.id,
      label: entry.label || entry.id,
      marker: entry.id === currentId ? '✓' : '',
      description: entry.description || 'color theme',
      _theme: entry,
    }));
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    const applyTheme = (id, { persist = true } = {}) => {
      try {
        return store.setTheme?.(id, { persist });
      } catch (e) {
        store.pushNotice(`Couldn’t set theme: ${e?.message || e}`, 'error');
        return null;
      }
    };
    // Onboarding: Enter (row) and ConfirmBar Next both persist the highlighted
    // theme, then advance; Back restores the original palette then steps back.
    const saveTheme = (id, { advance = false } = {}) => {
      setPicker(null);
      const applied = applyTheme(id, { persist: true });
      store.pushNotice(themeNotice(applied || { id }), 'info');
      if (advance && onboarding) onboarding.onAdvance?.();
      else if (returnTo) returnTo();
    };
    setPicker({
      title: 'Theme',
      description: 'Choose the color theme that looks best with your terminal.',
      help: onboarding ? undefined : (returnTo ? '↑/↓ Preview · Enter Choose · Esc Settings' : '↑/↓ Preview · Enter Choose · Esc Back'),
      labelWidth: 22,
      initialIndex: Math.max(0, items.findIndex((item) => item.value === currentId)),
      items,
      confirmBar: onboarding ? {
        buttons: [
          { value: 'back', label: '◀ Back' },
          { value: 'next', label: 'Next ▶' },
        ],
        onConfirm: (button) => {
          if (button.value === 'back') {
            setPicker(null);
            // Restore the palette active before the picker opened, then step back.
            if (currentId) applyTheme(currentId, { persist: false });
            onboarding.onBack?.();
            return;
          }
          saveTheme(highlightedThemeId, { advance: true });
        },
      } : (options.confirmBar || null),
      // Live preview while moving: apply (no persist) so the surface re-tones
      // as the selection moves. Enter persists; Esc restores the original.
      onHighlight: (_value, item) => {
        if (item?._theme?.id) {
          highlightedThemeId = item._theme.id;
          applyTheme(item._theme.id, { persist: false });
        }
      },
      onSelect: (_value, item) => {
        const entry = item?._theme;
        if (!entry) return;
        saveTheme(entry.id, { advance: Boolean(onboarding) });
      },
      onCancel: () => {
        setPicker(null);
        // Restore the theme that was active before the picker opened.
        if (currentId) applyTheme(currentId, { persist: false });
        if (onboarding) onboarding.onCancel?.();
        else if (returnTo) returnTo();
      },
    });
  };

  const openEffortPicker = () => {
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    const items = Array.isArray(state.effortOptions) && state.effortOptions.length > 0
      ? state.effortOptions
      : [];
    if (!items.length) {
      store.pushNotice('Current model has no effort levels.', 'warn');
      return;
    }
    const current = state.effort || items[0]?.value || '';
    const pickerItems = items.map((item) => ({
      ...item,
      marker: item?.value === current ? '✓' : '',
      markerColor: theme.success,
      description: clean(item?.description).toLowerCase() === 'current' ? '' : item?.description,
    }));
    setPicker({
      title: 'Effort',
      description: 'Reasoning effort for the current model.',
      items: pickerItems,
      onSelect: (value) => {
        setPicker(null);
        void store.setEffort(value)
          .then(result => store.pushNotice(result ? `Effort set to ${result}` : 'Effort switch is already running.', result ? 'info' : 'warn'))
          .catch((e) => store.pushNotice(`Couldn’t switch effort: ${e?.message || e}`, 'error'));
      },
      onCancel: () => {
        setPicker(null);
      },
    });
  };

  const openBridgePicker = () => {
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: 'Agent Tasks',
      description: 'Inspect or clean up background agent tasks.',
      items: [
        {
          value: 'list',
          label: 'List agents/tasks',
          description: 'show active agents and async tasks',
          _action: 'control',
          _args: { type: 'list' },
        },
        {
          value: 'cleanup',
          label: 'Cleanup finished tasks',
          description: 'remove completed agent task records',
          _action: 'control',
          _args: { type: 'cleanup' },
        },
      ],
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action === 'control') {
          void store.agentControl?.(item._args)
            .catch((e) => store.pushNotice(`agent failed: ${e?.message || e}`, 'error'));
        }
      },
      onCancel: () => {
        setPicker(null);
      },
    });
  };

  const openToolsPicker = (query = '') => {
    let status;
    try {
      status = store.toolsStatus?.(query) || { tools: [] };
    } catch (e) {
      store.pushNotice(`tools status failed: ${e?.message || e}`, 'error');
      return;
    }
    const tools = status.tools || [];
    const items = [
      {
        value: 'summary',
        label: 'Tool surface',
        description: `${status.activeCount || 0}/${status.count || 0} active · mode ${status.mode || state.toolMode}`,
        _action: 'summary',
      },
      ...(tools.length ? tools.map((tool) => ({
        value: tool.name,
        label: tool.name,
        marker: tool.active ? '●' : '○',
        markerColor: tool.active ? theme.success : theme.inactive,
        description: `${tool.kind || 'tool'} · usage ${tool.usage || 0}${tool.description ? ` · ${tool.description}` : ''}`,
        _action: tool.active ? 'tool' : 'enable',
        _tool: tool,
      })) : [{
        value: 'empty',
        label: 'No tools',
        description: query ? `no matches for "${query}"` : 'tool catalog is empty',
        _action: 'noop',
      }]),
    ];
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: query ? `Tools · ${query}` : 'Tools',
      description: 'Browse active and deferred tools.',
      items,
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action === 'summary') {
          store.pushNotice([
            `mode: ${status.mode || state.toolMode}`,
            `active: ${status.activeCount || 0}/${status.count || 0}`,
            `active tools: ${(status.activeTools || []).join(', ') || '(none)'}`,
          ].join('\n'), 'info');
          return;
        }
        if (item._action === 'enable') {
          store.selectTools?.([item._tool.name]);
          void openToolsPicker(query);
          return;
        }
        if (item._action === 'tool') {
          const tool = item._tool;
          setPicker({
            title: `Tool · ${tool.name}`,
            description: 'Tool details and quick actions.',
            items: [
              {
                value: 'info',
                label: 'Tool info',
                description: `${tool.kind || 'tool'} · ${tool.active ? 'active' : 'deferred'}`,
                _action: 'info',
              },
              {
                value: 'copy-name',
                label: 'Copy name',
                description: tool.name,
                _action: 'copy-name',
              },
            ],
            onSelect: (_detailValue, detail) => {
              setPicker(null);
              if (detail._action === 'info') {
                store.pushNotice([
                  tool.name,
                  `kind: ${tool.kind || 'tool'}`,
                  `state: ${tool.active ? 'active' : 'deferred'}`,
                  `usage: ${tool.usage || 0}`,
                  tool.description || '',
                ].filter(Boolean).join('\n'), 'info');
                return;
              }
              if (detail._action === 'copy-name') {
                void copyToClipboard(tool.name)
                  .then(() => store.pushNotice(`copied tool name: ${tool.name}`, 'plain'))
                  .catch((e) => store.pushNotice(`copy failed: ${e?.message || e}`, 'error'));
              }
            },
            onCancel: () => openToolsPicker(query),
          });
        }
      },
      onCancel: () => {
        setPicker(null);
      },
    });
  };

  const openUsagePanel = (arg = '') => {
    const refresh = /(?:^|\s)(?:refresh|--refresh|-r|true)(?:\s|$)/i.test(String(arg || ''));
    const requestId = usageRequestRef.current + 1;
    usageRequestRef.current = requestId;
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker(null);
    setContextPanel(null);
    setUsagePanel({
      title: 'Provider Quotas',
      subtitle: 'Statusline-style provider quota windows.',
      checking: true,
      refresh,
      rows: [],
      total: null,
    });
    setTimeout(() => {
      if (usageRequestRef.current !== requestId) return;
      void store.getUsageDashboard?.({
        refresh,
        onUpdate: (dashboard) => {
          if (usageRequestRef.current !== requestId) return;
          if (!dashboard) return;
          setUsagePanel(dashboard);
        },
      })
        .then((dashboard) => {
          if (usageRequestRef.current !== requestId) return;
          if (!dashboard) {
            closeUsagePanel();
            store.pushNotice('usage dashboard unavailable', 'warn');
            return;
          }
          setUsagePanel(dashboard);
        })
        .catch((e) => {
          if (usageRequestRef.current !== requestId) return;
          closeUsagePanel();
          store.pushNotice(`usage failed: ${e?.message || e}`, 'error');
        });
    }, 0);
  };

  const openContextPicker = () => {
    const tools = store.toolsStatus?.() || { activeCount: 0, count: 0, activeTools: [] };
    const mcp = store.mcpStatus?.() || { connectedCount: 0, configuredCount: 0, failedCount: 0 };
    const skills = store.skillsStatus?.() || { count: 0 };
    const plugins = store.pluginsStatus?.() || { count: 0 };
    const context = store.contextStatus?.() || {};
    const usage = context.usage || {};
    const messages = context.messages || {};
    const request = context.request || {};
    const compaction = context.compaction || {};
    const windowTokens = Number(context.contextWindow || state.contextWindow || context.rawContextWindow || state.rawContextWindow || 0);
    const rawWindowTokens = Number(context.rawContextWindow || state.rawContextWindow || windowTokens || 0);
    // Compaction boundary/trigger are sourced from the runtime contextStatus
    // (context.compaction). Fall back to the visible window for the boundary
    // and to the boundary for the trigger so /context still renders on a
    // fresh/resumed session before any compaction telemetry exists. (These
    // used to reference undefined compactTrigger/compactBoundary and threw a
    // ReferenceError when the picker opened.)
    const compactBoundary = Number(compaction.boundaryTokens || windowTokens || 0);
    const compactTrigger = Number(compaction.triggerTokens || compactBoundary || 0);
    const usedTokens = Number(context.usedTokens || context.currentEstimatedTokens || usage.lastContextTokens || 0);
    const freeTokens = windowTokens ? Math.max(0, windowTokens - usedTokens) : Number(context.freeTokens || 0);
    const pct = (value, total = windowTokens) => {
      const n = Number(value || 0);
      const d = Number(total || 0);
      if (!d) return 'N/A';
      return `${((n / d) * 100).toFixed(n > 0 && n < d / 100 ? 1 : 0)}%`;
    };
    const fmt = (value) => {
      const n = Number(value || 0);
      if (!Number.isFinite(n) || n <= 0) return '0';
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
      if (n >= 10_000) return `${Math.round(n / 1000)}k`;
      if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
      return `${Math.round(n)}`;
    };
    const cachedRead = Number(usage.lastCachedReadTokens || 0);
    const cacheWrite = Number(usage.lastCacheWriteTokens || 0);
    const freshInput = Number(
      usage.lastUncachedInputTokens != null
        ? usage.lastUncachedInputTokens
        : Math.max(Number(usage.lastInputTokens || 0) - cachedRead - cacheWrite, 0)
    );
    const cacheDenom = Number(usage.lastContextTokens || 0) || (cachedRead + freshInput + cacheWrite);
    const cacheHitRate = cacheDenom > 0
      ? `${((cachedRead / cacheDenom) * 100).toFixed(0)}%`
      : 'N/A';
    const cacheWriteLabel = cacheWrite > 0 ? ` · ${fmt(cacheWrite)} write` : '';
    const contextSource = context.usedSource === 'last_api_request' ? 'last API request' : 'estimated';
    const lastApiLabel = context.lastApiRequestStale ? 'last API request (pre-compact)' : 'last API request';
    const compactElapsed = (value) => {
      const n = Number(value || 0);
      if (!Number.isFinite(n) || n <= 0) return '';
      return `${Math.max(1, Math.ceil(n / 1000))}s`;
    };
    const compactRunning = compaction.inProgress === true || compaction.lastStage === 'compacting';
    const autoClearFailed = compaction.lastStage === 'auto_clear_failed' || !!compaction.lastClearCompactError;
    const autoClearStage = compaction.lastStage === 'auto_clear' || compaction.lastClearAt;
    const compactDuration = compactElapsed(compaction.lastDurationMs);
    const compactInterrupted = compaction.lastStage === 'interrupted';
    const compactReactive = String(compaction.lastTrigger || '').toLowerCase() === 'reactive';
    const compactState = compactRunning
      ? 'Compacting conversation'
      : compactInterrupted
      ? 'Compact interrupted'
      : autoClearFailed
      ? `auto-clear skipped${compaction.lastClearCompactError ? `: ${compaction.lastClearCompactError}` : ''}`
      : autoClearStage
      ? 'Auto-clear complete'
      : compaction.lastChanged
      ? (compactReactive ? 'Compact complete (overflow recovery)' : 'Compact complete')
      : 'Compact checked';
    const compactDescription = compactDuration
      ? `${compactState} · ${compactDuration}`
      : compactState;
    const contextRows = [
      {
        value: 'summary',
        label: 'Context Usage',
        description: `${fmt(usedTokens)}/${fmt(windowTokens)} (${pct(usedTokens)}) · ${fmt(freeTokens)} free · ${contextSource} · effective`,
        _action: 'summary',
      },
      {
        value: 'compaction',
        label: 'Compaction',
        description: compactDescription,
        _action: 'compaction',
      },
      {
        value: 'messages',
        label: 'Messages',
        description: `${fmt(messages.estimatedTokens)} tokens (${pct(messages.estimatedTokens)}) · ${messages.count || 0} messages`,
        _action: 'messages',
      },
      {
        value: 'tools',
        label: 'Tools',
        description: `${fmt(request.toolSchemaTokens)} schema tokens (${pct(request.toolSchemaTokens)}) · ${tools.activeCount || 0}/${tools.count || 0} active`,
        _action: 'tools',
      },
      {
        value: 'tool-io',
        label: 'Tool calls/results',
        description: `${messages.toolCallCount || 0} calls (${fmt(messages.toolCallTokens)}) · ${messages.toolResultCount || 0} results (${fmt(messages.toolResultTokens)})`,
        _action: 'tool-io',
      },
      {
        value: 'request',
        label: 'Request overhead',
        description: `${fmt(request.requestOverheadTokens)} framing · ${fmt(request.reserveTokens)} reserve incl. tools`,
        _action: 'request',
      },
      {
        value: 'last-api',
        label: 'Last API usage',
        description: `${fmt(usage.lastContextTokens)} context · ${fmt(freshInput)} uncached input · ${fmt(usage.lastOutputTokens)} output · ${lastApiLabel}`,
        _action: 'last-api',
      },
      {
        value: 'cache',
        label: 'Prompt cache',
        description: `${cacheHitRate} hit · ${fmt(usage.lastCachedReadTokens)} read${cacheWriteLabel} · ${fmt(freshInput)} new (last request)`,
        _action: 'cache',
      },
      {
        value: 'free',
        label: 'Free space',
        description: `${fmt(freeTokens)} tokens (${pct(freeTokens)}) · raw window ${fmt(rawWindowTokens)}`,
        _action: 'free',
      },
      {
        value: 'extensions',
        label: 'Skills/plugins',
        description: `${skills.count || 0} skills · ${plugins.count || 0} plugins`,
        _action: 'extensions',
      },
    ];
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker(null);
    setContextPanel({
      kind: 'context',
      title: 'Context Usage',
      detail: {
        type: 'context',
        usage: {
          usedTokens,
          windowTokens,
          freeTokens,
          rawWindowTokens,
          source: contextSource,
          effective: true,
        },
        compaction: {
          stage: compaction.lastStage || 'pending',
          state: compactState,
          triggerTokens: compactTrigger,
          boundaryTokens: compactBoundary,
          type: compaction.compactType || compaction.type || null,
          bufferTokens: Number(compaction.bufferTokens || (compactBoundary && compactTrigger ? Math.max(0, compactBoundary - compactTrigger) : 0)) || null,
          pressureTokens: Number(compaction.lastPressureTokens || compaction.currentEstimatedTokens || 0) || null,
          lastChanged: compaction.lastChanged === true,
        },
        messages: {
          tokens: messages.estimatedTokens,
          count: messages.count,
          semantic: messages.semantic,
        },
        tools: {
          schemaTokens: request.toolSchemaTokens,
          active: tools.activeCount,
          count: tools.count,
        },
        toolIo: {
          calls: messages.toolCallCount,
          results: messages.toolResultCount,
        },
        request: {
          toolSchemaBreakdown: request.toolSchemaBreakdown,
          overheadTokens: request.requestOverheadTokens,
          reserveTokens: request.reserveTokens,
        },
        lastApi: {
          contextTokens: usage.lastContextTokens,
          inputTokens: freshInput,
          rawInputTokens: usage.lastInputTokens,
          outputTokens: usage.lastOutputTokens,
        },
        cache: {
          hitRate: cacheHitRate,
          readTokens: usage.lastCachedReadTokens,
          writeTokens: cacheWrite,
        },
        extensions: {
          skills: skills.count,
          plugins: plugins.count,
        },
        mcp: {
          connected: mcp.connectedCount,
          configured: mcp.configuredCount,
          failed: mcp.failedCount,
        },
      },
      rows: contextRows,
    });
  };

  useEffect(() => {
    if (contextPanel?.kind === 'context') {
      openContextPicker();
      return;
    }
  }, [
    contextPanel?.kind,
    state.stats,
    state.contextWindow,
    state.rawContextWindow,
    state.sessionId,
    state.toolMode,
    state.agentWorkers,
    state.agentJobs,
    state.provider,
    state.model,
    state.effort,
    state.fast,
    state.cwd,
    state.clientHostPid,
  ]);

  const openSettingsPicker = () => {
    const autoClear = store.getAutoClear?.() || {};
    const compaction = store.getCompactionSettings?.() || {};
    const memory = store.getMemorySettings?.() || { enabled: true };
    const channels = store.getChannelSettings?.({ includeStatus: false }) || { enabled: true };
    const outputStyle = store.getOutputStyle?.() || store.listOutputStyles?.() || {};
    const workflow = state.workflow || {};
    const mcp = store.mcpStatus?.() || { connectedCount: 0, configuredCount: 0, failedCount: 0 };
    const hooks = store.hooksStatus?.() || { ruleCount: 0 };
    const plugins = store.pluginsStatus?.() || { count: 0 };
    const skills = store.skillsStatus?.() || { count: 0 };
    const channelWorker = store.getChannelWorkerStatus?.();
    let channelBackend = 'discord';
    try {
      channelBackend = store.getChannelSetup?.()?.backend || 'discord';
    } catch {
      channelBackend = 'discord';
    }
    const channelBackendLabel = channelBackend === 'telegram' ? 'Telegram' : 'Discord';
    const remoteEnabled = store.isRemoteEnabled?.() === true;
    const remoteRuntimeDescription = channelWorker?.running
      ? `runtime running · pid ${channelWorker.pid}`
      : 'runtime stopped';
    const compactType = compaction.compactType || compaction.type || 'semantic';
    const compactTypeLabel = compactType === 'recall-fasttrack' ? 'Fast-track' : 'Default';
    const outputStyleLabel = outputStyle?.current?.label || outputStyle?.current?.id || outputStyle?.configured || 'Default';
    const workflowLabel = workflowDisplayName(workflow);
    const boolLabel = (enabled) => enabled ? 'On' : 'Off';
    const compactTypeDescription = memory.enabled === false
      ? 'Default summarization is active; fast-track needs Memory.'
      : compactType === 'recall-fasttrack'
        ? 'Uses Memory recall to rebuild context faster on large histories.'
        : 'Uses semantic summarization for predictable context compaction.';
    const applyAutoClear = (enabled) => {
      try {
        const next = store.setAutoClear?.({ enabled });
        if (!next) store.pushNotice('autoclear unavailable', 'warn');
        else store.pushNotice(`Auto-clear ${next.enabled ? 'on' : 'off'}`, 'info');
      } catch (e) {
        store.pushNotice(`autoclear failed: ${e?.message || e}`, 'error');
      }
      openSettingsPicker();
    };
    const applyCompaction = (patch = {}) => {
      void Promise.resolve(store.setCompactionSettings?.(patch))
        .then((next) => {
          if (!next) {
            store.pushNotice('compaction setting is busy', 'warn');
            return;
          }
          store.pushNotice(`Compaction ${next.auto !== false ? 'auto on' : 'auto off'} · ${next.compactType === 'recall-fasttrack' ? 'Fast-track' : 'Default'}`, 'info');
        })
        .catch((e) => store.pushNotice(`compaction failed: ${e?.message || e}`, 'error'))
        .finally(() => openSettingsPicker());
    };
    const applyMemory = (enabled) => {
      void Promise.resolve(store.setMemoryEnabled?.(enabled))
        .then((next) => {
          if (!next) {
            store.pushNotice('memory setting is busy', 'warn');
            return;
          }
          store.pushNotice(`Memory ${next.enabled ? 'on' : 'off'}`, 'info');
        })
        .catch((e) => store.pushNotice(`memory setting failed: ${e?.message || e}`, 'error'))
        .finally(() => openSettingsPicker());
    };
    const applyChannels = (enabled) => {
      void Promise.resolve(store.setChannelsEnabled?.(enabled))
        .then((next) => {
          if (!next) {
            store.pushNotice('channel setting is busy', 'warn');
            return;
          }
          store.pushNotice(`Channels ${next.enabled ? 'on' : 'off'}`, 'info');
        })
        .catch((e) => store.pushNotice(`channel setting failed: ${e?.message || e}`, 'error'))
        .finally(() => openSettingsPicker());
    };
    const cycleOutputStyle = (direction = 1) => {
      let status = null;
      try { status = store.listOutputStyles?.() || null; } catch (e) {
        store.pushNotice(`could not list output styles: ${e?.message || e}`, 'error');
        return;
      }
      const styles = Array.isArray(status?.styles) ? status.styles : [];
      if (!styles.length) {
        store.pushNotice('no output styles available', 'warn');
        return;
      }
      const currentId = status?.current?.id || 'default';
      const currentIndex = Math.max(0, styles.findIndex((style) => style.id === currentId));
      const next = styles[(currentIndex + direction + styles.length) % styles.length];
      void store.setOutputStyle?.(next.id)
        .then((result) => {
          if (!result) {
            store.pushNotice('Output style switch is already running.', 'warn');
            return;
          }
          store.pushNotice(outputStyleNotice(result), 'info');
        })
        .catch((e) => store.pushNotice(`Couldn’t switch output style: ${e?.message || e}`, 'error'))
        .finally(() => openSettingsPicker());
    };
    const cycleWorkflow = (direction = 1) => {
      let workflows = [];
      try { workflows = store.listWorkflows?.() || []; } catch (e) {
        store.pushNotice(`could not list workflows: ${e?.message || e}`, 'error');
        return;
      }
      if (!workflows.length) {
        store.pushNotice('no workflows available', 'warn');
        return;
      }
      const activeIndex = workflows.findIndex((item) => item.active);
      const currentIndex = activeIndex >= 0 ? activeIndex : Math.max(0, workflows.findIndex((item) => item.id === workflow.id));
      const next = workflows[(currentIndex + direction + workflows.length) % workflows.length];
      void store.setWorkflow?.(next.id)
        .then((result) => {
          if (!result) {
            store.pushNotice('Workflow switch is already running.', 'warn');
            return;
          }
          store.pushNotice(workflowSwitchNotice(result), 'info');
        })
        .catch((e) => store.pushNotice(`Couldn’t switch workflow: ${e?.message || e}`, 'error'))
        .finally(() => openSettingsPicker());
    };
    const cycleTheme = (direction = 1) => {
      let themes = [];
      try { themes = store.listThemes?.() || []; } catch (e) {
        store.pushNotice(`could not list themes: ${e?.message || e}`, 'error');
        return;
      }
      if (!themes.length) {
        store.pushNotice('no themes available', 'warn');
        return;
      }
      const currentId = store.getTheme?.() || themes.find((t) => t.current)?.id || themes[0]?.id;
      const currentIndex = Math.max(0, themes.findIndex((t) => t.id === currentId));
      const next = themes[(currentIndex + direction + themes.length) % themes.length];
      try {
        const applied = store.setTheme?.(next.id, { persist: true });
        store.pushNotice(themeNotice(applied || next), 'info');
      } catch (e) {
        store.pushNotice(`Couldn’t set theme: ${e?.message || e}`, 'error');
      }
      openSettingsPicker();
    };
    const applyRemoteRuntime = () => {
      const enabled = store.toggleRemote?.() === true;
      store.pushNotice(enabled ? 'Remote mode ON' : 'Remote mode OFF', 'info');
      openSettingsPicker();
    };
    const cycleChannelBackend = (direction = 1) => {
      const backends = ['discord', 'telegram'];
      const currentIndex = Math.max(0, backends.indexOf(channelBackend));
      const chosen = backends[(currentIndex + direction + backends.length) % backends.length];
      if (chosen === channelBackend) {
        openSettingsPicker();
        return;
      }
      try {
        store.setBackend(chosen);
        const label = chosen === 'telegram' ? 'Telegram' : 'Discord';
        const restartHint = (store.isRemoteEnabled?.() === true || channelWorker?.running)
          ? `Channel set to ${label}. Restart remote to apply.`
          : `Channel set to ${label}.`;
        store.pushNotice(restartHint, 'info');
      } catch (e) {
        store.pushNotice(`channel backend failed: ${e?.message || e}`, 'error');
      }
      openSettingsPicker();
    };
    const items = [
      {
        value: 'profile',
        label: 'Profile',
        meta: (() => {
          try {
            const p = store.getProfile?.();
            const lang = p?.languageEntry?.label || 'System';
            return p?.title ? `${p.title} · ${lang}` : lang;
          } catch { return 'System'; }
        })(),
        description: 'Your title and response language.',
        _action: 'profile',
      },
      {
        value: 'autoclear',
        label: 'Auto-clear',
        meta: boolLabel(autoClear.enabled !== false),
        description: `Clear idle sessions after ${formatDuration(autoClear.idleMs || 60 * 60 * 1000)}.`,
        _action: 'autoclear',
      },
      {
        value: 'autocompact',
        label: 'Auto-compact',
        meta: boolLabel(compaction.auto !== false),
        description: 'Compact when context is high.',
        _action: 'autocompact',
      },
      {
        value: 'compact-type',
        label: 'Compact type',
        meta: compactTypeLabel,
        description: compactTypeDescription,
        _action: 'compact-type',
      },
      {
        value: 'memory',
        label: 'Memory enabled',
        meta: boolLabel(memory.enabled !== false),
        description: memory.enabled === false
          ? 'Recall and memory disabled.'
          : 'Recall, memory, and fast-track support.',
        _action: 'memory',
      },
      {
        value: 'memory-dashboard',
        label: 'Memory dashboard',
        description: 'runtime dashboard, cycles, and core entries',
        _action: 'memory-dashboard',
      },
      {
        value: 'channels',
        label: 'Channels enabled',
        meta: boolLabel(channels.enabled !== false),
        description: channels.enabled === false
          ? 'Channel tools disabled.'
          : 'Discord, schedules, and webhooks.',
        _action: 'channels',
      },
      {
        value: 'remote-runtime',
        label: 'Remote Runtime',
        meta: boolLabel(remoteEnabled),
        description: remoteRuntimeDescription,
        _action: 'remote-runtime',
      },
      {
        value: 'channel-backend',
        label: 'Channel',
        meta: channelBackendLabel,
        description: 'Left/Right or Enter changes channel type (Discord or Telegram).',
        _action: 'channel-backend',
      },
      {
        value: 'channel-setting',
        label: 'Setting',
        description: 'Configure credentials and main channel/chat for the active type.',
        _action: 'channel-setting',
      },
      {
        value: 'output-style',
        label: 'Output style',
        meta: outputStyleLabel,
        description: 'Response tone and format.',
        _action: 'output-style',
      },
      {
        value: 'theme',
        label: 'Theme',
        meta: (() => {
          try {
            const id = store.getTheme?.();
            const entry = (store.listThemes?.() || []).find((t) => t.id === id);
            return entry?.label || id || 'Default';
          } catch { return 'Default'; }
        })(),
        description: 'TUI color theme.',
        _action: 'theme',
      },
      {
        value: 'workflow',
        label: 'Workflow',
        meta: workflowLabel,
        description: 'Active agent routing profile.',
        _action: 'workflow',
      },
      {
        value: 'model',
        label: 'Model',
        meta: displayModelName(state.model, state.provider),
        description: 'Main chat model.',
        _action: 'model',
      },
      {
        value: 'search',
        label: 'Search model',
        meta: routeModelLabel(store.getSearchRoute?.()),
        description: 'Native search model.',
        _action: 'search',
      },
      {
        value: 'providers',
        label: 'Providers',
        description: 'Auth, API keys, OAuth, local.',
        _action: 'providers',
      },
      {
        value: 'mcp',
        label: 'MCP servers',
        description: `${mcp.connectedCount || 0}/${mcp.configuredCount || 0} connected${mcp.failedCount ? ` · ${mcp.failedCount} failed` : ''}`,
        _action: 'mcp',
      },
      {
        value: 'plugins',
        label: 'Plugins',
        description: `${plugins.count || 0} detected`,
        _action: 'plugins',
      },
      {
        value: 'hooks',
        label: 'Hooks',
        description: `${hooks.ruleCount || 0} before-tool rules`,
        _action: 'hooks',
      },
      {
        value: 'skills',
        label: 'Skills',
        description: `${skills.count || 0} available`,
        _action: 'skills',
      },
      {
        value: 'update',
        label: 'Update',
        meta: (() => {
          try {
            const upd = store.getUpdateSettings?.() || {};
            const current = upd.currentVersion || 'unknown';
            if (upd.updateAvailable && upd.latestVersion) return `${current} → ${upd.latestVersion}`;
            if (!upd.currentVersion) return 'unknown';
            return `${current} (latest)`;
          } catch { return 'unknown'; }
        })(),
        description: 'Check version and update mixdog.',
        _action: 'update',
      },
    ];
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: 'Settings',
      description: 'Runtime, model, tools, and integrations.',
      help: '↑/↓ Select · ←/→ Change · Enter Open/Toggle · Esc Close',
      indexMode: 'always',
      labelWidth: 18,
      metaWidth: 18,
      fillAvailable: true,
      items,
      onLeft: (item) => {
        if (item?._action === 'autoclear') applyAutoClear(!(autoClear.enabled !== false));
        else if (item?._action === 'autocompact') applyCompaction({ auto: !(compaction.auto !== false) });
        else if (item?._action === 'compact-type') {
          const nextType = compactType === 'recall-fasttrack' ? 'semantic' : 'recall-fasttrack';
          applyCompaction({ compactType: nextType });
        }
        else if (item?._action === 'memory') applyMemory(!(memory.enabled !== false));
        else if (item?._action === 'channels') applyChannels(!(channels.enabled !== false));
        else if (item?._action === 'remote-runtime') applyRemoteRuntime();
        else if (item?._action === 'channel-backend') cycleChannelBackend(-1);
        else if (item?._action === 'output-style') cycleOutputStyle(-1);
        else if (item?._action === 'theme') cycleTheme(-1);
        else if (item?._action === 'workflow') cycleWorkflow(-1);
      },
      onRight: (item) => {
        if (item?._action === 'autoclear') applyAutoClear(!(autoClear.enabled !== false));
        else if (item?._action === 'autocompact') applyCompaction({ auto: !(compaction.auto !== false) });
        else if (item?._action === 'compact-type') {
          const nextType = compactType === 'recall-fasttrack' ? 'semantic' : 'recall-fasttrack';
          applyCompaction({ compactType: nextType });
        }
        else if (item?._action === 'memory') applyMemory(!(memory.enabled !== false));
        else if (item?._action === 'channels') applyChannels(!(channels.enabled !== false));
        else if (item?._action === 'remote-runtime') applyRemoteRuntime();
        else if (item?._action === 'channel-backend') cycleChannelBackend(1);
        else if (item?._action === 'output-style') cycleOutputStyle(1);
        else if (item?._action === 'theme') cycleTheme(1);
        else if (item?._action === 'workflow') cycleWorkflow(1);
      },
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action === 'autoclear') openAutoClearPicker({ returnTo: openSettingsPicker });
        else if (item._action === 'profile') openProfilePicker({ returnTo: openSettingsPicker });
        else if (item._action === 'autocompact') applyCompaction({ auto: !(compaction.auto !== false) });
        else if (item._action === 'compact-type') {
          const nextType = compactType === 'recall-fasttrack' ? 'semantic' : 'recall-fasttrack';
          applyCompaction({ compactType: nextType });
        }
        else if (item._action === 'memory') applyMemory(!(memory.enabled !== false));
        else if (item._action === 'memory-dashboard') openMemoryPicker();
        else if (item._action === 'channels') applyChannels(!(channels.enabled !== false));
        else if (item._action === 'remote-runtime') applyRemoteRuntime();
        else if (item._action === 'channel-backend') cycleChannelBackend(1);
        else if (item._action === 'channel-setting') openChannelSettingTypePicker({ returnTo: openSettingsPicker });
        else if (item._action === 'output-style') openOutputStylePicker({ returnTo: openSettingsPicker });
        else if (item._action === 'theme') openThemePicker({ returnTo: openSettingsPicker });
        else if (item._action === 'workflow') openWorkflowPicker({ returnTo: openSettingsPicker });
        else if (item._action === 'model') openModelPicker({
          returnTo: openSettingsPicker,
          returnLabel: 'Settings',
          returnOnNestedCancel: true,
          onAfterSelect: openSettingsPicker,
        });
        else if (item._action === 'search') openSearchPicker({
          returnTo: openSettingsPicker,
          returnLabel: 'Settings',
          returnOnNestedCancel: true,
        });
        else if (item._action === 'providers') void openProviderSetupPicker({
          returnTo: openSettingsPicker,
          onCancel: openSettingsPicker,
          continueLabel: 'Back to settings',
          continueDescription: 'return to settings',
        });
        else if (item._action === 'mcp') openMcpPicker();
        else if (item._action === 'plugins') openPluginsPicker();
        else if (item._action === 'hooks') openHooksPicker();
        else if (item._action === 'skills') openSkillsPicker();
        else if (item._action === 'update') openUpdatePicker({ returnTo: openSettingsPicker });
      },
      onCancel: () => {
        setPicker(null);
      },
    });
  };

  const openProviderSetupPicker = async (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    const onContinue = typeof options.onContinue === 'function' ? options.onContinue : returnTo;
    const onCancel = typeof options.onCancel === 'function' ? options.onCancel : null;
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    // Onboarding (and any caller) can pass a preloaded provider setup so we skip
    // the "Checking Providers" placeholder frame that otherwise flashes before
    // the real list — that swap is what looked like a jump on Step 1 entry.
    let setup = options.preloadedSetup && typeof options.preloadedSetup === 'object'
      ? options.preloadedSetup
      : null;
    if (!setup) {
      setPicker({
        title: options.title || 'Providers',
        description: options.description || 'Choose a provider to configure.',
        labelWidth: 18,
        metaWidth: 10,
        pickerKey: 'providers-loading',
        initialIndex: 0,
        items: [{
          value: 'checking',
          label: 'Checking Providers',
          meta: '',
          description: 'please wait',
          _type: 'loading',
        }],
        onSelect: () => {},
        onCancel: () => {
          setPicker(null);
          if (onCancel) onCancel();
        },
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        setup = await store.getProviderSetup();
      } catch (e) {
        store.pushNotice(`providers failed: ${e?.message || e}`, 'error');
        return;
      }
    }

    const items = [];
    if ((returnTo || onContinue) && !options.confirmBar) {
      items.push({
        value: 'continue-setup',
        label: options.continueLabel || 'Continue setup',
        description: options.continueDescription || 'return to setup',
        _type: 'continue',
      });
    }
    const providerFooter = (item) => {
      const provider = item?._provider;
      if (!provider) return '';
      const active = provider.enabled || provider.authenticated || provider.detected;
      return [{
        glyph: active ? '●' : '○',
        color: active ? theme.success : theme.inactive,
        text: [providerKindLabel(provider), providerStatusLabel(provider), providerDetailText(provider)].filter(Boolean).join(' · '),
      }];
    };
    const providerItemRank = (item) => providerDisplayRank(item._providerId || item.value);
    const providerItems = [];
    for (const p of setup.api || []) {
      providerItems.push({
        value: `api:${p.id}`,
        label: p.name,
        meta: providerStatusLabel(p),
        description: '',
        _type: 'api-key',
        _providerId: p.id,
        _providerName: p.name,
        _provider: p,
        _authenticated: p.authenticated,
        _url: p.url,
      });
    }
    for (const p of setup.oauth || []) {
      providerItems.push({
        value: `oauth:${p.id}`,
        label: p.name,
        meta: providerStatusLabel(p),
        description: '',
        _type: 'oauth',
        _providerId: p.id,
        _providerName: p.name,
        _provider: p,
        _authenticated: p.authenticated,
      });
    }
    for (const p of setup.local || []) {
      providerItems.push({
        value: `local:${p.id}`,
        label: p.name,
        meta: providerStatusLabel(p),
        description: '',
        _type: 'local',
        _providerId: p.id,
        _providerName: p.name,
        _provider: p,
        _enabled: p.enabled,
        _baseURL: p.baseURL,
        _defaultURL: p.defaultURL,
      });
    }
    providerItems.sort((a, b) => {
      const rank = providerItemRank(a) - providerItemRank(b);
      if (rank !== 0) return rank;
      return String(a.label || '').localeCompare(String(b.label || ''), 'en', { sensitivity: 'base' });
    });
    items.push(...providerItems);

    const rememberProviderSelection = (providerItem) => {
      if (!providerItem?.value) return;
      options.highlightProviderValue = providerItem.value;
    };
    const providerMainInitialIndex = () => {
      const value = options.highlightProviderValue;
      if (!value) return 0;
      const idx = items.findIndex((item) => item.value === value);
      return idx >= 0 ? idx : 0;
    };

    const reopenProviders = () => {
      void openProviderSetupPicker(options);
    };
    const providerActionFooter = (provider) => provider ? [{
      glyph: provider.enabled || provider.authenticated || provider.detected ? '●' : '○',
      color: provider.enabled || provider.authenticated || provider.detected ? theme.success : theme.inactive,
      text: [providerKindLabel(provider), providerStatusLabel(provider), providerDetailText(provider)].filter(Boolean).join(' · '),
    }] : '';
    const setApiKeyPrompt = (providerItem) => {
      setProviderPrompt({
        kind: 'api-key',
        providerId: providerItem._providerId,
        label: providerItem._providerName,
        mode: providerItem._authenticated ? 'replace' : 'set',
        envName: providerItem._provider?.envName || '',
        source: providerDetailText(providerItem._provider),
        afterSave: returnTo,
      });
    };
    const openApiProviderActions = (providerItem) => {
      rememberProviderSelection(providerItem);
      const provider = providerItem._provider || {};
      const hasAuth = providerItem._authenticated || provider.authenticated;
      const hasStoredKey = provider.stored || (!provider.env && hasAuth);
      const apiActions = [];
      apiActions.push({
        value: 'set-key',
        label: hasAuth ? 'Replace API key' : 'Add API key',
        description: provider.envName ? `masked input · ${provider.envName}` : 'masked input · stored in OS keychain',
        _action: 'set-key',
      });
      if (hasStoredKey) {
        apiActions.push({
          value: 'forget-key',
          label: 'Delete API key',
          description: provider.env ? 'remove keychain key; env key remains active' : 'remove stored key for this provider',
          _action: 'forget-key',
        });
      }
      setPicker({
        title: `Provider · ${providerItem._providerName}`,
        description: 'Choose an API-key action.',
        footer: () => providerActionFooter(provider),
        help: '↑/↓ Select · Enter Choose · Esc Providers',
        indexMode: 'always',
        labelWidth: 22,
        pickerKey: `providers-action:${providerItem.value}`,
        initialIndex: 0,
        items: apiActions,
        onSelect: (_detailValue, detail) => {
          setPicker(null);
          if (detail._action === 'set-key') {
            setApiKeyPrompt(providerItem);
            return;
          }
          if (detail._action === 'forget-key') {
            try {
              store.forgetProviderAuth(providerItem._providerId);
              clearModelCaches('all');
              reopenProviders();
            } catch (e) {
              store.pushNotice(`auth-forget failed: ${e?.message || e}`, 'error');
            }
          }
        },
        onCancel: reopenProviders,
      });
    };

    const startOAuthLogin = (providerItem) => {
      const provider = providerItem._provider || {};
      const showOAuthProgress = (message = 'Opening login flow. Complete it in the browser if prompted.', opts = {}) => {
        const onBack = typeof opts.onBack === 'function' ? opts.onBack : () => openOAuthProviderActions(providerItem);
        const actions = [
          {
            value: 'waiting',
            label: opts.waitLabel || 'Waiting for login',
            meta: 'Running',
            description: opts.waitDescription || 'finish the browser/OAuth prompt',
            _action: 'waiting',
          },
          {
            value: 'back',
            label: 'Back',
            meta: '',
            description: 'return to provider actions',
            _action: 'back',
          },
        ];
        setPicker({
          title: `Provider · ${providerItem._providerName}`,
          description: message,
          footer: () => providerActionFooter(provider),
          help: '↑/↓ Select · Enter Choose · Esc Providers',
          indexMode: 'never',
          labelWidth: 22,
          metaWidth: 12,
          pickerKey: `providers-oauth-progress:${providerItem.value}`,
          initialIndex: 0,
          items: actions,
          onSelect: (_value, item) => {
            if (item?._action === 'back') onBack();
          },
          onCancel: onBack,
        });
      };
      const showOAuthResult = (ok, message = '') => {
        setProviderPrompt(null);
        setPicker({
          title: `Provider · ${providerItem._providerName}`,
          description: message || (ok ? 'Login complete.' : 'Login did not complete.'),
          footer: () => providerActionFooter(provider),
          help: ok ? 'Enter Refresh Providers · Esc Providers' : 'Enter Back · Esc Providers',
          indexMode: 'never',
          labelWidth: 22,
          metaWidth: 12,
          pickerKey: `providers-oauth-result:${providerItem.value}:${ok ? 'ok' : 'fail'}`,
          initialIndex: 0,
          items: [{
            value: ok ? 'success' : 'back',
            label: ok ? 'Success' : 'Back',
            meta: ok ? 'Done' : 'Ready',
            description: ok ? 'refresh provider status' : 'return to provider actions',
            _action: ok ? 'success' : 'back',
          }],
          onSelect: () => {
            if (ok) reopenProviders();
            else openOAuthProviderActions(providerItem);
          },
          onCancel: () => {
            if (ok) reopenProviders();
            else openOAuthProviderActions(providerItem);
          },
        });
      };
      let backedOut = false;
      showOAuthProgress('Opening login flow. Complete it in the browser if prompted.', {
        onBack: () => {
          backedOut = true;
          openOAuthProviderActions(providerItem);
        },
      });
      if (typeof store.beginOAuthProviderLogin === 'function') {
        let handled = false;
        const providerName = providerItem._providerName || providerItem._providerId || 'OAuth';
        const finish = (ok, message = '') => {
          if (handled) return;
          handled = true;
          if (ok) clearModelCaches('all');
          if (backedOut) {
            if (message) store.pushNotice(message, ok ? 'info' : 'error');
            return;
          }
          showOAuthResult(ok, message || (ok ? `${providerName} login complete.` : `${providerName} login failed.`));
        };
        void store.beginOAuthProviderLogin(providerItem._providerId)
          .then((login) => {
            setPicker(null);
            const manualUrl = login?.manualUrl || '';
            setProviderPrompt({
              kind: 'oauth-code',
              providerId: providerItem._providerId,
              providerName,
              label: `${providerName} OAuth code`,
              hint: manualUrl
                ? 'If the browser callback does not finish, paste code#state below. Manual URL added to the transcript.'
                : `Paste the authorization code or full redirect URL for ${providerName}.`,
              login,
              afterSave: returnTo,
              successReturn: () => showOAuthResult(true, `${providerName} login complete.`),
              failureReturn: (e) => showOAuthResult(false, `${providerName} code failed: ${e?.message || e}`),
              cancelReturn: () => openOAuthProviderActions(providerItem),
            });
            // Persist the full manual URL into the transcript (not just a
            // transient toast) so it stays retrievable; the visible panel hint
            // is kept short/bounded and never carries the URL inline.
            if (manualUrl) {
              store.pushNotice(`${providerName} manual OAuth URL: ${manualUrl}`, 'info', { transcript: true });
            }
            store.pushNotice(`browser opened for ${providerName}; paste code/redirect here if callback does not finish`, 'info');
            login.waitForCallback
              ?.then((result) => {
                if (result && !oauthSubmitRef.current) finish(true, `${providerName} login complete`);
              })
              .catch((e) => finish(false, `oauth login failed: ${e?.message || e}`));
          })
          .catch((e) => {
            store.pushNotice(`oauth login failed: ${e?.message || e}`, 'error');
            openOAuthProviderActions(providerItem);
          });
        return;
      }
      void store.loginOAuthProvider(providerItem._providerId)
        .then(() => {
          clearModelCaches('all');
          if (backedOut) {
            store.pushNotice(`${providerItem._providerName} login complete`, 'info');
            return;
          }
          showOAuthResult(true, `${providerItem._providerName} login complete.`);
        })
        .catch((e) => {
          if (backedOut) {
            store.pushNotice(`oauth login failed: ${e?.message || e}`, 'error');
            return;
          }
          showOAuthResult(false, `OAuth login failed: ${e?.message || e}`);
        });
    };
    const openOAuthProviderActions = (providerItem) => {
      rememberProviderSelection(providerItem);
      const provider = providerItem._provider || {};
      const hasAuth = providerItem._authenticated || provider.authenticated;
      const oauthActions = [];
      oauthActions.push({
        value: 'login-oauth',
        label: hasAuth ? 'Re-login' : 'Login',
        description: providerDetailText(provider) || 'open browser or OAuth flow',
        _action: 'login-oauth',
      });
      if (hasAuth) {
        oauthActions.push({
          value: 'forget-oauth',
          label: 'Forget login',
          description: 'remove stored OAuth credentials',
          _action: 'forget-oauth',
        });
      }
      setPicker({
        title: `Provider · ${providerItem._providerName}`,
        description: 'Choose an OAuth login action.',
        footer: () => providerActionFooter(provider),
        help: '↑/↓ Select · Enter Choose · Esc Providers',
        indexMode: 'always',
        labelWidth: 22,
        pickerKey: `providers-action:${providerItem.value}`,
        initialIndex: 0,
        items: oauthActions,
        onSelect: (_detailValue, detail) => {
          if (detail._action === 'login-oauth') {
            startOAuthLogin(providerItem);
            return;
          }
          if (detail._action === 'forget-oauth') {
            try {
              store.forgetProviderAuth(providerItem._providerId);
              clearModelCaches('all');
              reopenProviders();
            } catch (e) {
              store.pushNotice(`auth-forget failed: ${e?.message || e}`, 'error');
            }
          }
        },
        onCancel: reopenProviders,
      });
    };

    const openLocalProviderActions = (providerItem) => {
      rememberProviderSelection(providerItem);
      const provider = providerItem._provider || {};
      const localActions = [
        {
          value: 'set-local-url',
          label: providerItem._enabled ? 'Update Base URL' : 'Enable / Set URL',
          description: providerDetailText(provider) || providerItem._defaultURL,
          _action: 'set-local-url',
        },
      ];
      if (providerItem._enabled) {
        localActions.push({
          value: 'disable-local',
          label: 'Disable provider',
          description: 'keep URL but stop using this local provider',
          _action: 'disable-local',
        });
      }
      setPicker({
        title: `Provider · ${providerItem._providerName}`,
        description: 'Choose a local endpoint action.',
        footer: () => providerActionFooter(provider),
        help: '↑/↓ Select · Enter Choose · Esc Providers',
        indexMode: 'always',
        labelWidth: 22,
        pickerKey: `providers-action:${providerItem.value}`,
        initialIndex: 0,
        items: localActions,
        onSelect: (_detailValue, detail) => {
          setPicker(null);
          if (detail._action === 'set-local-url') {
            setProviderPrompt({
              kind: 'local-url',
              providerId: providerItem._providerId,
              label: providerItem._providerName,
              defaultURL: providerItem._baseURL || providerItem._defaultURL,
              afterSave: returnTo,
            });
            return;
          }
          if (detail._action === 'disable-local') {
            try {
              store.setLocalProvider(providerItem._providerId, { enabled: false, baseURL: providerItem._baseURL });
              clearModelCaches('all');
              reopenProviders();
            } catch (e) {
              store.pushNotice(`local provider update failed: ${e?.message || e}`, 'error');
            }
          }
        },
        onCancel: reopenProviders,
      });
    };

    setPicker({
      title: options.title || 'Providers',
      description: options.description || 'Choose a provider. Enter opens provider actions.',
      footer: providerFooter,
      footerGapRows: 1,
      help: options.confirmBar ? undefined : '↑/↓ Select · Enter Open · Esc Back',
      indexMode: 'always',
      labelWidth: 18,
      metaWidth: 12,
      pickerKey: `providers-main:${options.highlightProviderValue || 'root'}`,
      initialIndex: providerMainInitialIndex(),
      items,
      confirmBar: options.confirmBar || null,
      onHighlight: (_value, item) => {
        if (item?._providerId) rememberProviderSelection(item);
      },
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._type === 'continue') {
          onContinue?.();
          return;
        }
        if (item._type === 'api-key') {
          openApiProviderActions(item);
          return;
        }
        if (item._type === 'oauth') {
          openOAuthProviderActions(item);
          return;
        }
        if (item._type === 'local') {
          openLocalProviderActions(item);
        }
      },
      onCancel: () => {
        setPicker(null);
        if (onCancel) onCancel();
        else if (returnTo) returnTo();
      },
    });
  };

  // First-run onboarding is a 5-step wizard. Each step's ROOT screen carries a
  // ConfirmBar (Back/Next, Finish on the last step); the Picker owns the bar
  // focus and only fires onConfirm from the bar. Nested depths (API-key entry,
  // model route picker, channel setting/webhook) render without a ConfirmBar so
  // their own key semantics are untouched and step-switching is disabled there.
  // Esc/cancel during onboarding = confirm skip. Mark onboarding complete
  // (routes/agents/provider untouched) so it does not reopen next launch;
  // `mixdog --onboarding` (forceOnboarding) still reopens regardless.
  const onboardingWarnReopen = () => {
    setOnboardingActive(false);
    try {
      store.skipOnboarding?.();
      store.pushNotice('Setup skipped. Run `mixdog --onboarding` to set up later.', 'info');
    } catch (e) {
      store.pushNotice(`Couldn’t save skip: ${e?.message || e}`, 'error');
    }
  };

  // Warm the Step 2 data (provider models + agent roster) in the background as
  // soon as Step 1 opens, so advancing to Step 2 renders instantly instead of
  // flashing an empty panel while the async load runs.
  const prefetchOnboardingStep2 = () => {
    if (!Array.isArray(onboardingRef.current.providerModels) || onboardingRef.current.providerModels.length === 0) {
      const seq = onboardingPrefetchSeqRef.current;
      void Promise.resolve(store.listProviderModels?.())
        .then((models) => {
          // Drop a stale result: if the provider cache was invalidated (auth
          // change) while this load was in flight, its generation moved on.
          if (seq !== onboardingPrefetchSeqRef.current) return;
          if (Array.isArray(models) && models.length) {
            onboardingRef.current.providerModels = models;
            providerModelsCacheRef.current = { models, at: Date.now() };
          }
        })
        .catch(() => { /* Step 2 falls back to its own load on entry. */ });
    }
    if (!Array.isArray(onboardingRef.current.agents) || onboardingRef.current.agents.length === 0) {
      try {
        const roster = (store.listAgents?.() || []).map((a) => ({ id: a.id, label: a.label || a.id, description: a.description || '' }));
        if (roster.length) onboardingRef.current.agents = roster;
      } catch { /* Step 2 retries on entry. */ }
    }
  };

  const openOnboardingAuthStep = async () => {
    prefetchOnboardingStep2();
    // Load the provider setup BEFORE opening the picker so Step 1 renders the
    // real list in one frame instead of flashing the "Checking Providers"
    // placeholder (that swap is what looked like a jump on entry). On failure,
    // fall back to the picker's own in-panel loading path.
    let preloadedSetup = null;
    try {
      preloadedSetup = await store.getProviderSetup?.();
    } catch { /* openProviderSetupPicker will show its loading frame + error. */ }
    void openProviderSetupPicker({
      title: 'First Run · Step 1/5 · Provider Auth',
      returnTo: () => openOnboardingAuthStep(),
      preloadedSetup,
      confirmBar: {
        buttons: [{ value: 'next', label: 'Next ▶' }],
        onConfirm: () => { setPicker(null); void openOnboardingWorkflowStep(); },
      },
      onCancel: onboardingWarnReopen,
    });
  };

  const openOnboardingThemeStep = () => {
    openThemePicker({
      onboarding: {
        onAdvance: () => openOnboardingOutputStyleStep(),
        onBack: () => void openOnboardingWorkflowStep(),
        onCancel: onboardingWarnReopen,
      },
    });
  };

  const openOnboardingOutputStyleStep = () => {
    openOutputStylePicker({
      onboarding: {
        onAdvance: () => void openOnboardingRemoteStep(),
        onBack: () => openOnboardingThemeStep(),
        onCancel: onboardingWarnReopen,
      },
    });
  };

  const openOnboardingRemoteStep = () => {
    void openChannelSetupPicker('all', {
      onboarding: true,
      confirmBar: {
        buttons: [
          { value: 'back', label: '◀ Back' },
          { value: 'finish', label: 'Finish ✓' },
        ],
        onConfirm: (button) => {
          if (button.value === 'back') {
            setPicker(null);
            openOnboardingOutputStyleStep();
            return;
          }
          finishOnboarding();
        },
      },
    });
  };

  const finishOnboarding = () => {
    const defaultRoute = onboardingRef.current.defaultRoute;
    const searchRoute = onboardingRef.current.searchRoute || null;
    const overrides = onboardingRef.current.agentRoutes || {};
    const hasOverrides = Object.keys(overrides).length > 0;
    setPicker(null);
    setOnboardingActive(false);
    const done = () => store.pushNotice('First-run setup complete.', 'info');
    const failed = (e) => store.pushNotice(`Couldn’t save setup: ${e?.message || e}`, 'error');
    // Branch 1 — Main Model set: full persist. Agents without an explicit
    // override are sent; untouched agents are left out so the backend never
    // overwrites them (they follow the Main Model dynamically at runtime).
    if (defaultRoute) {
      void store.completeOnboarding?.({
        defaultRoute,
        defaultProvider: defaultRoute.provider,
        ...(hasOverrides ? { agentRoutes: { ...overrides } } : {}),
        ...(searchRoute ? { searchRoute } : {}),
      }).then(done).catch(failed);
      return;
    }
    // Branch 2 — Main unset but some Search/agent picks exist: partial persist.
    // Only the explicit overrides are sent (no defaultRoute/defaultProvider); the
    // backend skips agents lacking a route and marks onboarding complete.
    if (hasOverrides || searchRoute) {
      void store.completeOnboarding?.({
        ...(hasOverrides ? { agentRoutes: { ...overrides } } : {}),
        ...(searchRoute ? { searchRoute } : {}),
      }).then(done).catch(failed);
      return;
    }
    // Branch 3 — nothing configured: mark done only, leave config untouched.
    try {
      store.skipOnboarding?.();
    } catch (e) {
      failed(e);
      return;
    }
    done();
  };

  // Onboarding Step 2 per-target model picker. `target` is either the pseudo
  // slot 'lead' (Main Model) or a real agent id from listAgents(). No
  // recommendation logic: the current effective route is pre-highlighted, and
  // the plain model list is shown. Selecting Main Model updates defaultRoute;
  // agents that have no explicit override keep inheriting it.
  const openOnboardingRoleModelPicker = async (target) => {
    const isLead = target === 'lead';
    const isSearch = target === 'search';
    // Search uses the search-capable model list; lead/agent use provider models.
    let models;
    if (isSearch) {
      let searchModels = [];
      try {
        searchModels = await Promise.resolve(store.listSearchModels?.() || []);
      } catch (e) {
        store.pushNotice(`could not list search models: ${e?.message || e}`, 'warn');
      }
      models = normalizeModelOptions(searchModels || []);
      if (models.length === 0) {
        store.pushNotice('no native search models available; connect OpenAI, Grok, Gemini, or Anthropic', 'warn');
        void openOnboardingWorkflowStep();
        return;
      }
    } else {
      models = normalizeModelOptions(onboardingRef.current.providerModels || []);
      if (models.length === 0) {
        store.pushNotice('no provider models available; open /providers to sign in', 'warn');
        openOnboardingAuthStep();
        return;
      }
    }
    const overrides = onboardingRef.current.agentRoutes || {};
    // Current effective route for pre-marking: Main/Search show their own stored
    // route (or none); agents show their explicit override only (unset = none,
    // so we don't falsely mark the Main Model row on an untouched agent).
    const currentRoute = isLead
      ? (onboardingRef.current.defaultRoute || null)
      : isSearch
        ? (onboardingRef.current.searchRoute || null)
        : (overrides[target] || null);
    const routeMatchesModel = (route, m) => route?.provider === m.provider && route?.model === m.id;
    // Non-lead targets get a leading "Default" row that makes the target follow
    // the Main Model at runtime. For agents this clears the override (null);
    // for search this stores the SEARCH_DEFAULT marker route. "Default" is the
    // pre-marked row when the target is unset (agent) or on the marker (search).
    const isDefaultSelected = isSearch
      ? (!currentRoute || isSearchDefaultRoute(currentRoute))
      : !currentRoute;
    const isUnset = isDefaultSelected;
    const modelItems = models.map((m) => ({
      value: `${m.provider}:${m.id}`,
      label: m.display || m.id,
      marker: routeMatchesModel(currentRoute, m) ? '✓' : '',
      markerColor: theme.success,
      description: modelDescription(m),
      _model: m,
    }));
    const items = isLead
      ? modelItems
      : [
          {
            value: '__default__',
            label: 'Default',
            marker: isUnset ? '✓' : '',
            markerColor: theme.success,
            description: 'follows Main Model',
            _default: true,
          },
          ...modelItems,
        ];
    const matchIdx = models.findIndex((m) => routeMatchesModel(currentRoute, m));
    const initialIndex = isLead
      ? Math.max(0, matchIdx)
      : (isUnset || matchIdx < 0 ? 0 : matchIdx + 1);
    const label = isLead
      ? 'Main'
      : isSearch
        ? 'Search'
        : (onboardingRef.current.agents || []).find((a) => a.id === target)?.label || target;
    setPicker({
      title: `First Run · ${label}`,
      description: isLead
        ? 'Pick the main model. Agents inherit this unless individually changed.'
        : isSearch
          ? 'Pick the native web-search model, or Default to follow the Main Model.'
          : `Pick the model for ${label}, or Default to follow the Main Model.`,
      initialIndex,
      items,
      onSelect: (_value, item) => {
        // "Default" → clear the override so this target follows the Main Model.
        if (item?._default) {
          if (isSearch) {
            // Store the SEARCH_DEFAULT marker so finish persists it and the
            // runtime follows the Main Model (not a null that drops the field).
            onboardingRef.current.searchRoute = { ...SEARCH_DEFAULT_ROUTE };
          } else {
            const nextOverrides = { ...(onboardingRef.current.agentRoutes || {}) };
            delete nextOverrides[target];
            onboardingRef.current.agentRoutes = nextOverrides;
          }
          setPicker(null);
          void openOnboardingWorkflowStep();
          return;
        }
        const next = item?._model ? routeFromModel(item._model) : null;
        if (!next) {
          store.pushNotice('select a provider model first', 'warn');
          setPicker(null);
          void openOnboardingWorkflowStep();
          return;
        }
        if (isLead) {
          onboardingRef.current.defaultRoute = next;
        } else if (isSearch) {
          onboardingRef.current.searchRoute = next;
        } else {
          onboardingRef.current.agentRoutes = {
            ...(onboardingRef.current.agentRoutes || {}),
            [target]: next,
          };
        }
        setPicker(null);
        void openOnboardingWorkflowStep();
      },
      onCancel: () => {
        setPicker(null);
        void openOnboardingWorkflowStep();
      },
    });
  };

  const openOnboardingWorkflowStep = async () => {
    if (!Array.isArray(onboardingRef.current.providerModels) || onboardingRef.current.providerModels.length === 0) {
      try {
        onboardingRef.current.providerModels = await store.listProviderModels();
        providerModelsCacheRef.current = { models: onboardingRef.current.providerModels, at: Date.now() };
      } catch (e) {
        onboardingRef.current.providerModels = [];
        store.pushNotice(`could not list models: ${e?.message || e}`, 'warn');
      }
    }
    const models = onboardingRef.current.providerModels || [];
    if (models.length === 0) {
      onboardingRef.current.defaultRoute = null;
      onboardingRef.current.agentRoutes = {};
      store.pushNotice('no provider models available; open /providers to sign in', 'warn');
      openOnboardingAuthStep();
      return;
    }
    // Main Model stays unset until the user picks one; no auto-recommendation.
    // Load the real agent roster once (explore/maintainer/worker/heavy-worker/
    // reviewer/debugger). Each agent defaults to the Main Model unless the user
    // set an explicit override in agentRoutes.
    if (!Array.isArray(onboardingRef.current.agents) || onboardingRef.current.agents.length === 0) {
      try {
        onboardingRef.current.agents = (store.listAgents?.() || []).map((a) => ({ id: a.id, label: a.label || a.id, description: a.description || '' }));
      } catch (e) {
        onboardingRef.current.agents = [];
        store.pushNotice(`could not list agents: ${e?.message || e}`, 'warn');
      }
    }
    const defaultRoute = onboardingRef.current.defaultRoute;
    const searchRoute = onboardingRef.current.searchRoute || null;
    const overrides = onboardingRef.current.agentRoutes || {};
    const agents = onboardingRef.current.agents || [];
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: 'First Run · Step 2/5 · Models',
      description: 'Set the Main Model; each agent inherits it unless changed.',
      indexMode: 'always',
      labelWidth: 18,
      metaWidth: 33,
      items: [
        {
          value: 'main-model',
          label: 'Main',
          metaParts: agentModelParts(defaultRoute),
          description: 'main chat, planning, and agent default',
          _action: 'slot',
          _target: 'lead',
        },
        {
          value: 'search-model',
          label: 'Search',
          // Marker route = follow Main Model → show a hint, not 'default/default'.
          metaParts: isSearchDefaultRoute(searchRoute)
            ? [{ text: '(follows main)', width: 17 }, { text: '', width: 6 }, { text: '', width: 4 }]
            : agentModelParts(searchRoute),
          description: 'native search model',
          _action: 'slot',
          _target: 'search',
        },
        ...agents.map((agent) => ({
          value: `agent:${agent.id}`,
          label: agent.label,
          metaParts: agentModelParts(overrides[agent.id] || null),
          description: agent.description || '',
          _action: 'slot',
          _target: agent.id,
        })),
      ],
      confirmBar: {
        buttons: [
          { value: 'back', label: '◀ Back' },
          { value: 'next', label: 'Next ▶' },
        ],
        onConfirm: (button) => {
          setPicker(null);
          if (button.value === 'back') openOnboardingAuthStep();
          else openOnboardingThemeStep();
        },
      },
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action === 'slot') {
          openOnboardingRoleModelPicker(item._target);
        }
      },
      onCancel: () => {
        setPicker(null);
        onboardingWarnReopen();
      },
    });
  };

  useEffect(() => {
    if (onboardingStartedRef.current) return undefined;
    let canceled = false;
    try {
      const status = store.getOnboardingStatus?.();
      if (status?.completed === true && !forceOnboarding) return undefined;
      onboardingStartedRef.current = true;
      setOnboardingActive(true);
      setTimeout(() => {
        if (!canceled) openOnboardingAuthStep();
      }, 0);
    } catch {
      // If status probing fails, do not block normal TUI startup.
    }
    return () => {
      canceled = true;
    };
  }, [store, forceOnboarding]);

  const openChannelTypeActionsPicker = (backend, options = {}) => {
    const parentReturn = typeof options.returnTo === 'function'
      ? options.returnTo
      : () => openChannelSettingTypePicker();
    setProviderPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    let setup;
    try {
      setup = store.getChannelSetup();
    } catch (e) {
      store.pushNotice(`channels failed: ${e?.message || e}`, 'error');
      return;
    }
    const isTelegram = backend === 'telegram';
    const activeBackend = setup.backend || 'discord';
    const tokenDescription = isTelegram
      ? `${setup.telegram?.status ?? 'Off'}${setup.telegram?.problem ? ' · Invalid' : ''}`
      : `${setup.discord.status}${setup.discord.problem ? ' · Invalid' : ''}`;
    const mainEntry = (setup.channels || []).find((ch) => ch.main)
      || (setup.channels || []).find((ch) => ch.name === 'main');
    const mainTarget = isTelegram
      ? (mainEntry?.telegramChatId || (activeBackend === 'telegram' ? mainEntry?.channelId : ''))
      : (mainEntry?.discordChannelId || (activeBackend === 'discord' ? mainEntry?.channelId : ''));
    const mainDescription = isTelegram
      ? (mainTarget ? `Chat ID ${mainTarget}` : 'Not set · Enter Telegram chat ID')
      : (mainTarget ? `Channel ID ${mainTarget}` : 'Not set · Enter Discord channel ID');

    const openChannelPrompt = (prompt) => {
      setPicker(null);
      setContextPanel(null);
      setChannelPrompt({
        ...prompt,
        afterSave: () => openChannelTypeActionsPicker(backend, options),
      });
    };

    setPicker({
      title: isTelegram ? 'Telegram' : 'Discord',
      description: activeBackend === backend
        ? 'Active channel type · token and main target'
        : 'Token and main target settings',
      help: '↑/↓ Select · Enter Edit · Esc Back',
      indexMode: 'always',
      labelWidth: 18,
      items: [
        {
          value: 'token',
          label: 'Bot token',
          description: tokenDescription,
          _action: isTelegram ? 'telegram-token' : 'discord-token',
        },
        {
          value: 'main',
          label: isTelegram ? 'Main chat' : 'Main channel',
          description: mainDescription,
          _action: 'main-target',
        },
      ],
      onSelect: (_value, item) => {
        try {
          if (item._action === 'discord-token') {
            openChannelPrompt({
              kind: 'discord-token',
              label: 'Discord bot token',
              hint: 'Paste the Discord bot token. It is stored in the OS keychain.',
            });
            return;
          }
          if (item._action === 'telegram-token') {
            openChannelPrompt({
              kind: 'telegram-token',
              label: 'Telegram bot token',
              hint: 'Paste the Telegram bot token from @BotFather. Stored in the OS keychain.',
            });
            return;
          }
          if (item._action === 'main-target') {
            openChannelPrompt({
              kind: 'channel-add',
              backend,
              label: isTelegram ? 'Main chat' : 'Main channel',
              hint: isTelegram
                ? 'Format: main | Telegram chat ID | mode(interactive/broadcast) | main'
                : 'Format: main | Discord channel ID | mode(interactive/broadcast) | main',
            });
          }
        } catch (e) {
          store.pushNotice(`channels update failed: ${e?.message || e}`, 'error');
        }
      },
      onCancel: () => {
        parentReturn();
      },
    });
  };

  const openChannelSettingTypePicker = (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : () => {};
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    let setup;
    try {
      setup = store.getChannelSetup();
    } catch (e) {
      store.pushNotice(`channels failed: ${e?.message || e}`, 'error');
      return;
    }
    const activeBackend = setup.backend || 'discord';
    const mainEntry = (setup.channels || []).find((ch) => ch.main)
      || (setup.channels || []).find((ch) => ch.name === 'main');
    const typeDescription = (backend) => {
      const selected = activeBackend === backend;
      const hasToken = backend === 'telegram'
        ? setup.telegram?.authenticated === true
        : setup.discord?.authenticated === true;
      const hasTarget = backend === 'telegram'
        ? Boolean(mainEntry?.telegramChatId || (activeBackend === 'telegram' && mainEntry?.channelId))
        : Boolean(mainEntry?.discordChannelId || (activeBackend === 'discord' && mainEntry?.channelId));
      const needs = [
        ...(hasToken ? [] : ['token']),
        ...(hasTarget ? [] : [backend === 'telegram' ? 'chat ID' : 'channel ID']),
      ];
      return [
        ...(selected ? ['Selected'] : []),
        needs.length ? `Needs ${needs.join(' + ')}` : 'Ready',
      ].join(' · ');
    };
    setPicker({
      title: 'Channel Type Settings',
      description: 'Choose a type. Selected is the active backend; Ready means token and main target are set.',
      help: '↑/↓ Select · Enter Open · Esc Back',
      indexMode: 'always',
      labelWidth: 18,
      items: [
        {
          value: 'discord',
          label: 'Discord',
          description: typeDescription('discord'),
          _backend: 'discord',
        },
        {
          value: 'telegram',
          label: 'Telegram',
          description: typeDescription('telegram'),
          _backend: 'telegram',
        },
      ],
      onSelect: (value, item) => {
        const backend = item?._backend || (value === 'telegram' ? 'telegram' : value === 'discord' ? 'discord' : null);
        if (!backend) return;
        setPicker(null);
        openChannelTypeActionsPicker(backend, {
          returnTo: () => openChannelSettingTypePicker(options),
        });
      },
      onCancel: () => {
        setPicker(null);
        returnTo();
      },
    });
  };

  const openChannelSetupPicker = async (focus = 'all', options = {}) => {
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    let setup;
    try {
      setup = store.getChannelSetup();
    } catch (e) {
      store.pushNotice(`channels failed: ${e?.message || e}`, 'error');
      return;
    }

    const openChannelPrompt = (prompt) => {
      setPicker(null);
      setContextPanel(null);
      setChannelPrompt(prompt);
    };

    const channelRemoteEnabled = store.isRemoteEnabled?.() === true;

    if (focus === 'schedules') {
      const schedules = setup.schedules || [];
      const items = [
        ...(schedules.length ? schedules.map((schedule) => {
        const enabled = schedule.enabled !== false;
        return {
          value: `schedule:${schedule.name}`,
          label: schedule.name,
          marker: enabled ? '●' : '○',
          markerColor: channelRemoteEnabled ? (enabled ? theme.success : theme.inactive) : theme.inactive,
          description: `${schedule.time || '(no cron)'} · ${schedule.route}${schedule.model ? ` · ${schedule.model}` : ''}${channelRemoteEnabled ? '' : ' · channel off'}`,
          _action: 'schedule-toggle',
          _name: schedule.name,
          _enabled: enabled,
        };
      }) : [{
          value: 'empty',
          label: 'No schedules',
          description: 'no schedules configured',
          _action: 'noop',
        }]),
      ];
      const toggleSchedule = (item) => {
        if (item._action !== 'schedule-toggle') return;
        if (!channelRemoteEnabled) {
          store.pushNotice('enable channel first', 'warn');
          return;
        }
        try {
          store.setScheduleEnabled?.(item._name, !item._enabled);
          void openChannelSetupPicker('schedules', { highlightValue: `schedule:${item._name}` });
        } catch (e) {
          store.pushNotice(`schedule toggle failed: ${e?.message || e}`, 'error');
        }
      };
      setPicker({
        title: 'Schedules',
        description: channelRemoteEnabled ? 'Enable or disable cron schedules.' : 'Enable channel to toggle schedules.',
        initialIndex: Math.max(0, items.findIndex((entry) => entry.value === options.highlightValue)),
        items,
        onSelect: (_value, item) => toggleSchedule(item),
        onLeft: (item) => toggleSchedule(item),
        onRight: (item) => toggleSchedule(item),
        onCancel: () => {
          setPicker(null);
        },
      });
      return;
    }

    if (focus === 'webhook-endpoint') {
      const returnTo = typeof options.returnTo === 'function'
        ? options.returnTo
        : () => setPicker(null);
      const domain = setup.webhook?.ngrokDomain || setup.webhook?.domain || '';
      const items = [
        {
          value: 'endpoint-domain',
          label: 'ngrok domain',
          description: domain ? domain : 'Not set · Enter ngrok domain',
          _action: 'endpoint-domain',
        },
        {
          value: 'endpoint-authtoken',
          label: 'authtoken',
          description: setup.webhook?.authenticated === true ? 'Set' : 'Not set · Enter authtoken',
          _action: 'endpoint-authtoken',
        },
      ];
      setPicker({
        title: 'Webhook endpoint',
        description: 'ngrok domain and authtoken. Toggle individual webhooks in /webhooks.',
        help: '↑/↓ Select · Enter Edit · Esc Back',
        indexMode: 'always',
        labelWidth: 18,
        items,
        onSelect: (_value, item) => {
          try {
            if (item._action === 'endpoint-domain') {
              openChannelPrompt({
                kind: 'webhook-domain',
                label: 'ngrok domain',
                hint: 'Paste the reserved ngrok domain (e.g. my-app.ngrok-free.app).',
                afterSave: () => void openChannelSetupPicker('webhook-endpoint', options),
              });
              return;
            }
            if (item._action === 'endpoint-authtoken') {
              openChannelPrompt({
                kind: 'webhook-token',
                label: 'Webhook/ngrok authtoken',
                hint: 'Paste the webhook/ngrok authtoken. It is stored in the OS keychain.',
                afterSave: () => void openChannelSetupPicker('webhook-endpoint', options),
              });
            }
          } catch (e) {
            store.pushNotice(`webhook endpoint failed: ${e?.message || e}`, 'error');
          }
        },
        onCancel: () => {
          setPicker(null);
          returnTo();
        },
      });
      return;
    }

    if (focus === 'webhooks') {
      const hooks = setup.webhooks || [];
      const items = [
        ...(hooks.length ? hooks.map((hook) => {
          const enabled = hook.enabled !== false;
          return {
            value: `webhook:${hook.name}`,
            label: hook.name,
            marker: enabled ? '●' : '○',
            markerColor: channelRemoteEnabled ? (enabled ? theme.success : theme.inactive) : theme.inactive,
            description: `${hook.parser || 'github'} · ${hook.route} · secret:${hook.secretSet ? 'set' : 'missing'}${channelRemoteEnabled ? '' : ' · channel off'}`,
            _action: 'webhook-toggle',
            _name: hook.name,
            _enabled: enabled,
          };
        }) : [{
          value: 'empty',
          label: 'No webhooks',
          description: 'no webhook endpoints configured',
          _action: 'noop',
        }]),
      ];
      const toggleWebhook = (item) => {
        if (item._action !== 'webhook-toggle') return;
        if (!channelRemoteEnabled) {
          store.pushNotice('enable channel first', 'warn');
          return;
        }
        try {
          store.setWebhookEnabled?.(item._name, !item._enabled);
          void openChannelSetupPicker('webhooks', { highlightValue: `webhook:${item._name}` });
        } catch (e) {
          store.pushNotice(`webhook toggle failed: ${e?.message || e}`, 'error');
        }
      };
      setPicker({
        title: 'Webhooks',
        description: channelRemoteEnabled ? 'Enable or disable inbound webhook endpoints.' : 'Enable channel to toggle webhooks.',
        initialIndex: Math.max(0, items.findIndex((entry) => entry.value === options.highlightValue)),
        items,
        onSelect: (_value, item) => toggleWebhook(item),
        onLeft: (item) => toggleWebhook(item),
        onRight: (item) => toggleWebhook(item),
        onCancel: () => {
          setPicker(null);
        },
      });
      return;
    }

    const worker = store.getChannelWorkerStatus?.();
    const activeBackend = setup.backend === 'telegram' ? 'telegram' : 'discord';
    const backendLabel = activeBackend === 'telegram' ? 'Telegram' : 'Discord';
    const remoteEnabled = store.isRemoteEnabled?.() === true;
    const boolLabel = (enabled) => enabled ? 'On' : 'Off';
    // Onboarding Step 5 reuses this root picker with a ConfirmBar. Reopens after
    // a toggle must carry the onboarding context (confirmBar + flag) forward so
    // Back/Finish stay wired and the general /channels path keeps its own opts.
    const reopenRoot = (extra = {}) => {
      const preserved = options.onboarding
        ? { onboarding: true, confirmBar: options.confirmBar || null }
        : {};
      void openChannelSetupPicker('all', { ...preserved, ...extra });
    };
    const applyRemoteRuntime = (highlightValue = 'remote-runtime') => {
      const enabled = store.toggleRemote?.() === true;
      store.pushNotice(enabled ? 'Remote mode ON' : 'Remote mode OFF', 'info');
      reopenRoot({ highlightValue });
    };
    const cycleChannelBackend = (direction = 1, highlightValue = 'channel-backend') => {
      const backends = ['discord', 'telegram'];
      const currentIndex = Math.max(0, backends.indexOf(activeBackend));
      const chosen = backends[(currentIndex + direction + backends.length) % backends.length];
      if (chosen === activeBackend) {
        reopenRoot({ highlightValue, backendOverride: activeBackend });
        return;
      }
      try {
        store.setBackend(chosen);
        const label = chosen === 'telegram' ? 'Telegram' : 'Discord';
        const restartHint = (store.isRemoteEnabled?.() === true || worker?.running)
          ? `Channel set to ${label}. Restart remote to apply.`
          : `Channel set to ${label}.`;
        store.pushNotice(restartHint, 'info');
      } catch (e) {
        store.pushNotice(`channel backend failed: ${e?.message || e}`, 'error');
      }
      reopenRoot({ highlightValue, backendOverride: chosen });
    };
    const items = [
      {
        value: 'remote-runtime',
        label: 'Remote Runtime',
        meta: boolLabel(remoteEnabled),
        description: worker?.running ? `Running · pid ${worker.pid}` : 'Stopped',
        _action: 'remote-runtime',
      },
      {
        value: 'channel-backend',
        label: 'Channel',
        meta: backendLabel,
        description: 'Select Discord or Telegram',
        _action: 'channel-backend',
      },
      {
        value: 'channel-setting',
        label: 'Setting',
        description: 'Token and main target',
        _action: 'channel-setting',
      },
      {
        value: 'webhook-endpoint',
        label: 'Webhook endpoint',
        meta: (() => {
          const hasDomain = Boolean(setup.webhook?.ngrokDomain || setup.webhook?.domain);
          const hasAuth = setup.webhook?.authenticated === true;
          return (hasDomain && hasAuth) ? 'On' : 'Off';
        })(),
        description: (() => {
          const hasDomain = Boolean(setup.webhook?.ngrokDomain || setup.webhook?.domain);
          const hasAuth = setup.webhook?.authenticated === true;
          const needs = [
            ...(hasDomain ? [] : ['domain']),
            ...(hasAuth ? [] : ['authtoken']),
          ];
          return needs.length ? `Needs ${needs.join(' + ')}` : 'ngrok domain and authtoken set';
        })(),
        _action: 'webhook-endpoint',
      },
    ];

    setPicker({
      title: 'Channels',
      description: 'Remote access and channel setup.',
      // Onboarding overlays a ConfirmBar (←/→ drive Back/Finish, not toggles),
      // so drop the ←/→ Change hint there and use the Picker's ConfirmBar help.
      help: options.confirmBar ? undefined : '↑/↓ Select · ←/→ Change · Enter Choose/Toggle · Esc Back',
      indexMode: 'always',
      labelWidth: 18,
      metaWidth: 12,
      pickerKey: `channels:${activeBackend}:${remoteEnabled ? 'on' : 'off'}:${options.highlightValue || 'root'}`,
      initialIndex: Math.max(0, items.findIndex((entry) => entry.value === options.highlightValue)),
      items,
      confirmBar: options.confirmBar || null,
      onLeft: options.confirmBar ? undefined : (item) => {
        if (item?._action === 'remote-runtime') applyRemoteRuntime(item.value);
        else if (item?._action === 'channel-backend') cycleChannelBackend(-1, item.value);
      },
      onRight: options.confirmBar ? undefined : (item) => {
        if (item?._action === 'remote-runtime') applyRemoteRuntime(item.value);
        else if (item?._action === 'channel-backend') cycleChannelBackend(1, item.value);
      },
      onSelect: (_value, item) => {
        try {
          if (item._action === 'remote-runtime') {
            applyRemoteRuntime(item.value);
            return;
          }
          if (item._action === 'channel-backend') {
            cycleChannelBackend(1, item.value);
            return;
          }
          if (item._action === 'channel-setting') {
            openChannelSettingTypePicker({
              returnTo: () => reopenRoot({ highlightValue: 'channel-setting' }),
            });
            return;
          }
          if (item._action === 'webhook-endpoint') {
            void openChannelSetupPicker('webhook-endpoint', {
              ...(options.onboarding ? { onboarding: true, confirmBar: options.confirmBar || null } : {}),
              returnTo: () => reopenRoot({ highlightValue: 'webhook-endpoint' }),
            });
          }
        } catch (e) {
          store.pushNotice(`channels update failed: ${e?.message || e}`, 'error');
        }
      },
      onCancel: () => {
        setPicker(null);
        // Onboarding Step 5 Esc mirrors the other steps' reopen-next-launch warning.
        if (options.onboarding) onboardingWarnReopen();
      },
    });
  };

  const mcpStatus = () => {
    let status;
    try {
      status = store.mcpStatus?.() || { servers: [] };
    } catch (e) {
      store.pushNotice(`mcp status failed: ${e?.message || e}`, 'error');
      return null;
    }
    return { ...status, servers: status.servers || [] };
  };

  const openMcpServersPicker = (options = {}) => {
    const status = mcpStatus();
    if (!status) return;
    const servers = status.servers || [];
    const items = [];
    if (servers.length === 0) {
      items.push({
        value: 'empty',
        label: 'No MCP servers',
        description: 'no configured MCP servers',
        _action: 'noop',
      });
    }
    for (const server of servers) {
      const enabled = server.enabled !== false;
      items.push({
        value: `server:${server.name}`,
        label: server.name,
        marker: enabled ? '●' : '○',
        markerColor: enabled ? theme.success : theme.inactive,
        description: `${server.status || 'unknown'} · ${server.transport || 'unknown'} · ${server.toolCount || 0} tools${server.error ? ` · ${server.error}` : ''}`,
        _action: 'server',
        _server: server,
        _enabled: enabled,
      });
    }
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    const toggleServer = (item) => {
      if (item._action !== 'server' || !item._server?.name) return;
      void store.setMcpServerEnabled?.(item._server.name, !item._enabled)
        .then(() => openMcpServersPicker({ highlightValue: `server:${item._server.name}` }))
        .catch((e) => store.pushNotice(`mcp toggle failed: ${e?.message || e}`, 'error'));
    };
    setPicker({
      title: 'MCP servers',
      description: 'Enable or disable configured MCP servers.',
      initialIndex: Math.max(0, items.findIndex((entry) => entry.value === options?.highlightValue)),
      items,
      onSelect: (_value, item) => toggleServer(item),
      onLeft: (item) => toggleServer(item),
      onRight: (item) => toggleServer(item),
      onCancel: () => {
        setPicker(null);
      },
    });
  };

  const openMcpPicker = () => {
    openMcpServersPicker();
  };

  const skillsStatus = () => {
    let status;
    try {
      status = store.skillsStatus?.() || { skills: [] };
    } catch (e) {
      store.pushNotice(`skills status failed: ${e?.message || e}`, 'error');
      return null;
    }
    return { ...status, skills: status.skills || [] };
  };

  const openProjectSkillsPicker = () => {
    const status = skillsStatus();
    if (!status) return;
    const skills = status.skills || [];
    const items = [];
    if (skills.length === 0) {
      items.push({
        value: 'empty',
        label: 'No project skills',
        description: 'no project skills available',
        _action: 'noop',
      });
    }
    for (const skill of skills) {
      items.push({
        value: skill.name,
        label: skill.name,
        description: `${skill.source || 'skill'} · ${skill.description || skill.filePath || ''}`,
        _action: 'view',
        _skill: skill,
      });
    }
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: 'Project skills',
      description: 'Skills bundled with this project.',
      items,
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action !== 'view') return;
        openSkillDetailPicker(item._skill);
      },
      onCancel: () => {
        setPicker(null);
        void openSkillsPicker();
      },
    });
  };

  const openSkillsPicker = (options = {}) => {
    const status = skillsStatus();
    if (!status) return;
    const skills = status.skills || [];
    const disabledSet = options.disabledOverride instanceof Set ? options.disabledOverride : disabledSkills;
    const items = [];
    if (skills.length === 0) {
      items.push({
        value: 'empty',
        label: 'No skills',
        description: 'no project skills available',
        _action: 'noop',
      });
    }
    for (const skill of skills) {
      const enabled = !disabledSet.has(skill.name);
      items.push({
        value: skill.name,
        label: skill.name,
        marker: enabled ? '●' : '○',
        markerColor: enabled ? theme.success : theme.inactive,
        description: `${skill.source || 'skill'} · ${skill.description || skill.filePath || ''}`,
        _action: 'skill',
        _skill: skill,
        _enabled: enabled,
      });
    }
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    const toggleSkill = (item) => {
      if (item._action !== 'skill' || !item._skill?.name) return;
      const name = item._skill.name;
      const next = new Set(disabledSet);
      if (item._enabled) next.add(name); else next.delete(name);
      setDisabledSkills(next);
      store.pushNotice(`skill ${item._enabled ? 'disabled' : 'enabled'}: ${name}`, 'info');
      openSkillsPicker({ highlightValue: name, disabledOverride: next });
    };
    setPicker({
      title: 'Skills',
      description: 'Enable or disable project skills.',
      initialIndex: Math.max(0, items.findIndex((entry) => entry.value === options.highlightValue)),
      items,
      onSelect: (_value, item) => toggleSkill(item),
      onLeft: (item) => toggleSkill(item),
      onRight: (item) => toggleSkill(item),
      onCancel: () => {
        setPicker(null);
      },
    });
  };

  const openSkillDetailPicker = (skill) => {
    const disabled = disabledSkills.has(skill.name);
    setPicker({
      title: `Skill · ${skill.name}`,
      description: clean(skill.description) || 'Enable, disable, or run this skill.',
      items: [
        {
          value: 'use',
          label: 'Use skill',
          description: disabled ? 'enable this skill first' : 'write a request with this skill',
          _action: disabled ? 'noop' : 'use',
        },
        {
          value: disabled ? 'enable' : 'disable',
          label: disabled ? 'Enable skill' : 'Disable skill',
          description: disabled ? 'show and allow this skill in the TUI' : 'hide use action until re-enabled',
          _action: disabled ? 'enable' : 'disable',
        },
      ],
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action === 'enable') {
          setDisabledSkills((current) => {
            const next = new Set(current);
            next.delete(skill.name);
            return next;
          });
          store.pushNotice(`skill enabled: ${skill.name}`, 'info');
          openSkillsPicker();
          return;
        }
        if (item._action === 'disable') {
          setDisabledSkills((current) => {
            const next = new Set(current);
            next.add(skill.name);
            return next;
          });
          store.pushNotice(`skill disabled: ${skill.name}`, 'info');
          openSkillsPicker();
          return;
        }
        if (item._action === 'use') {
          setSettingsPrompt({
            kind: 'skill-use',
            label: `Skill · ${skill.name}`,
            hint: 'Write the request to run with this skill.',
            skillName: skill.name,
          });
          return;
        }
      },
      onCancel: () => {
        setPicker(null);
        void openSkillsPicker();
      },
    });
  };

  const pluginStatus = () => {
    let status;
    try {
      status = store.pluginsStatus?.() || { plugins: [] };
    } catch (e) {
      store.pushNotice(`plugins status failed: ${e?.message || e}`, 'error');
      return null;
    }
    return { ...status, plugins: status.plugins || [] };
  };

  const beginAddPlugin = () => {
    setPicker(null);
    setSettingsPrompt({ kind: 'plugin-add', label: 'Plugin URL', hint: 'Git URL, owner/repo, or local path' });
  };

  const openPluginDetailPicker = (p) => {
    setPicker({
      title: p.title || p.name,
      description: clean(p.description) || 'Update, MCP, or uninstall this plugin.',
      items: [
        {
          value: 'info',
          label: 'Plugin info',
          description: `${p.sourceType || p.source}${p.version ? ` · ${p.version}` : ''} · skills ${p.skillCount || 0}`,
          _action: 'info',
        },
        {
          value: 'update',
          label: p.sourceType === 'local' ? 'Refresh metadata' : 'Update plugin',
          description: p.sourceType === 'local' ? 'rescan local plugin manifest' : 'pull latest from source URL',
          _action: 'update',
        },
        {
          value: 'enable-mcp',
          label: p.mcpScript ? (p.mcpEnabled ? 'Refresh MCP server' : 'Enable MCP server') : 'No MCP script',
          description: p.mcpScript ? `${p.mcpServerName || 'plugin-mcp'} · ${p.mcpEnabled ? 'configured' : p.mcpScript}` : 'plugin does not expose scripts/run-mcp.mjs or mcp/server.mjs',
          _action: p.mcpScript ? 'enable-mcp' : 'noop',
        },
        {
          value: 'copy-root',
          label: 'Copy root path',
          description: p.root,
          _action: 'copy-root',
        },
        {
          value: 'copy-mcp-name',
          label: p.mcpScript ? 'Copy MCP server name' : 'No MCP server name',
          description: p.mcpServerName || '',
          _action: p.mcpScript ? 'copy-mcp-name' : 'noop',
        },
        {
          value: 'uninstall',
          label: 'Uninstall plugin',
          description: p.managed === false ? 'remove from registry only' : 'remove registry entry and installed files',
          _action: 'uninstall',
        },
      ],
      onSelect: (_detailValue, detail) => {
        setPicker(null);
        if (detail._action === 'info') {
          store.pushNotice([
            `${p.title || p.name}${p.version ? ` ${p.version}` : ''}`,
            `source: ${p.sourceType || p.source}${p.sourceUrl ? ` / ${p.sourceUrl}` : ''}`,
            `skills: ${p.skillCount || 0}`,
            `mcp: ${p.mcpScript ? `${p.mcpEnabled ? 'enabled' : 'available'} (${p.mcpServerName || 'plugin-mcp'})` : '(none)'}`,
            `root: ${p.root}`,
            p.description ? `\n${p.description}` : '',
          ].filter(Boolean).join('\n'), 'info');
          return;
        }
        if (detail._action === 'update') {
          void store.updatePlugin?.(p)
            .then(() => openInstalledPluginsPicker())
            .catch((e) => store.pushNotice(`plugin update failed: ${e?.message || e}`, 'error'));
          return;
        }
        if (detail._action === 'enable-mcp') {
          void store.enablePluginMcp?.(p)
            .then(() => openMcpPicker())
            .catch((e) => store.pushNotice(`plugin MCP enable failed: ${e?.message || e}`, 'error'));
          return;
        }
        if (detail._action === 'copy-root') {
          void copyToClipboard(p.root)
            .then(() => store.pushNotice(`copied plugin root: ${p.name}`, 'plain'))
            .catch((e) => store.pushNotice(`copy failed: ${e?.message || e}`, 'error'));
          return;
        }
        if (detail._action === 'copy-mcp-name') {
          void copyToClipboard(p.mcpServerName || '')
            .then(() => store.pushNotice(`copied plugin MCP server: ${p.mcpServerName}`, 'plain'))
            .catch((e) => store.pushNotice(`copy failed: ${e?.message || e}`, 'error'));
          return;
        }
        if (detail._action === 'uninstall') {
          void store.removePlugin?.(p)
            .then(() => openInstalledPluginsPicker())
            .catch((e) => store.pushNotice(`plugin uninstall failed: ${e?.message || e}`, 'error'));
        }
      },
      onCancel: () => {
        setPicker(null);
        void openInstalledPluginsPicker();
      },
    });
  };

  const openInstalledPluginsPicker = () => {
    const status = pluginStatus();
    if (!status) return;
    const plugins = status.plugins || [];
    const items = [];
    if (plugins.length === 0) {
      items.push({
        value: 'empty',
        label: 'No installed plugins',
        description: 'Esc back · add from Plugins > Add plugin',
        _action: 'noop',
      });
    }
    for (const plugin of plugins) {
      items.push({
        value: `${plugin.id || plugin.name}:${plugin.version || ''}`,
        label: plugin.title || plugin.name,
        description: `${plugin.sourceType || plugin.source}${plugin.version ? ` · ${plugin.version}` : ''} · skills ${plugin.skillCount || 0}${plugin.mcpScript ? ` · mcp ${plugin.mcpEnabled ? 'enabled' : plugin.mcpScript}` : ''}`,
        _action: 'plugin',
        _plugin: plugin,
      });
    }
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: 'Installed plugins',
      description: 'Open an installed plugin to manage it.',
      items,
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action !== 'plugin') return;
        openPluginDetailPicker(item._plugin);
      },
      onCancel: () => {
        setPicker(null);
        void openPluginsPicker();
      },
    });
  };

  const openPluginsPicker = () => {
    const status = pluginStatus();
    if (!status) return;
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: 'Plugins',
      description: 'Add or manage local plugin integrations.',
      items: [
        {
          value: 'installed',
          label: 'Installed plugins',
          description: `${status.count || 0} installed`,
          _action: 'installed',
        },
        {
          value: 'add',
          label: 'Add plugin',
          description: 'Git URL, owner/repo, or local path',
          _action: 'add',
        },
      ],
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action === 'installed') {
          openInstalledPluginsPicker();
          return;
        }
        if (item._action === 'add') beginAddPlugin();
      },
      onCancel: () => {
        setPicker(null);
      },
    });
  };

  const openHooksPicker = () => {
    let status;
    try {
      status = store.hooksStatus?.() || { events: [], recent: [] };
    } catch (e) {
      store.pushNotice(`hooks status failed: ${e?.message || e}`, 'error');
      return;
    }
    const rules = status.rules || [];
    const items = [
      ...(rules.length ? rules.map((rule) => ({
        value: `rule:${rule.index}`,
        label: `${rule.tool} -> ${rule.action}`,
        marker: rule.enabled ? '●' : '○',
        markerColor: rule.enabled ? theme.success : theme.inactive,
        description: `${rule.match ? `match ${rule.match} · ` : ''}${rule.reason || 'Enter toggle'}`,
        _action: 'rule',
        _rule: rule,
      })) : [{
        value: 'rules:none',
        label: 'No rules',
        description: status.rulesPath || 'hooks.json not configured',
        _action: 'noop',
      }]),
    ];
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    const toggleRule = (item) => {
      if (item._action !== 'rule') return;
      try {
        store.setHookRuleEnabled?.(item._rule.index, !item._rule.enabled);
        void openHooksPicker();
      } catch (e) {
        store.pushNotice(`hook toggle failed: ${e?.message || e}`, 'error');
      }
    };
    setPicker({
      title: 'Hooks',
      description: 'Before-tool hook rules; Enter toggles a rule.',
      items,
      onSelect: (_value, item) => toggleRule(item),
      onLeft: (item) => toggleRule(item),
      onRight: (item) => toggleRule(item),
      onCancel: () => {
        setPicker(null);
      },
    });
  };

  const openMemoryStatusPicker = () => {
    setPicker({
      title: 'Memory Status',
      description: 'Fetching memory runtime status.',
      items: [{ value: 'loading', label: 'Loading memory status', description: 'please wait' }],
      onSelect: () => {},
      onCancel: () => openMemoryPicker(),
    });
    void store.memoryControl?.({ action: 'status' }, { silent: true })
      .then((result) => {
        const rows = parseMemoryStatusRows(result);
        setPicker({
          title: 'Memory Status',
          description: 'Memory subsystem counters and health.',
          items: rows.length ? rows : [{ value: 'empty', label: 'Status', description: 'empty' }],
          onSelect: (_value, item) => {
            if (item?._line) store.pushNotice(item._line, 'info');
          },
          onCancel: () => openMemoryPicker(),
        });
      })
      .catch((e) => {
        setPicker(null);
        store.pushNotice(`memory status failed: ${e?.message || e}`, 'error');
      });
  };

  const openMemoryCorePicker = () => {
    setPicker({
      title: 'Core Memory',
      description: 'Loading curated core memory entries.',
      items: [{ value: 'loading', label: 'Loading core memory', description: 'please wait' }],
      onSelect: () => {},
      onCancel: () => openMemoryPicker(),
    });
    void store.memoryControl?.({ action: 'core', op: 'list', project_id: '*' }, { silent: true })
      .then((result) => {
        const rows = parseMemoryCoreRows(result);
        setPicker({
          title: 'Core Memory',
          description: 'User-curated core memories across projects.',
          items: rows.length ? rows : [{ value: 'empty', label: 'Core memory', description: 'empty' }],
          onSelect: (_value, item) => {
            if (item?._line) store.pushNotice(item._line, 'info');
          },
          onCancel: () => openMemoryPicker(),
        });
      })
      .catch((e) => {
        setPicker(null);
        store.pushNotice(`core memory failed: ${e?.message || e}`, 'error');
      });
  };

  const runMemoryAction = (args, successLabel) => {
    setPicker(null);
    void store.memoryControl?.(args)
      .then(() => {
        if (successLabel) store.pushNotice(successLabel, 'info');
      })
      .catch((e) => store.pushNotice(`memory failed: ${e?.message || e}`, 'error'));
  };

  const openUpdatePicker = (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    const readSettings = () => {
      try { return store.getUpdateSettings?.() || {}; } catch { return {}; }
    };
    const readStatus = () => {
      try { return store.getUpdateStatus?.() || { phase: 'idle' }; } catch { return { phase: 'idle' }; }
    };
    const render = ({ checking = false } = {}) => {
      const upd = readSettings();
      const status = readStatus();
      const current = upd.currentVersion || 'unknown';
      const latestMeta = checking || status.phase === 'checking'
        ? 'checking…'
        : (upd.latestVersion || 'unknown');
      const items = [
        {
          value: 'current',
          label: 'Current version',
          meta: current,
          description: 'Installed mixdog version.',
          _action: 'current',
        },
        {
          value: 'latest',
          label: 'Latest version',
          meta: latestMeta,
          description: 'Enter to re-check now.',
          _action: 'latest',
        },
        {
          value: 'auto-update',
          label: 'Auto-update',
          meta: upd.autoUpdate ? 'On' : 'Off',
          description: 'Enter to toggle automatic updates.',
          _action: 'auto-update',
        },
      ];
      setProviderPrompt(null);
      setChannelPrompt(null);
      setHookPrompt(null);
      setSettingsPrompt(null);
      setPicker({
        title: 'Update',
        description: 'Check version and update mixdog.',
        help: '↑/↓ Select · Enter Open/Toggle · Esc Close',
        indexMode: 'always',
        labelWidth: 16,
        metaWidth: 16,
        items,
        confirmBar: {
          buttons: [
            {
              value: 'update-now',
              label: upd.updateAvailable
                ? `Update to v${upd.latestVersion || 'latest'}`
                : 'Update now',
            },
          ],
          onConfirm: (button) => {
            if (button?.value === 'update-now') runUpdate();
          },
        },
        onSelect: (_value, item) => {
          if (item?._action === 'latest') {
            recheck();
          } else if (item?._action === 'auto-update') {
            toggleAutoUpdate(!upd.autoUpdate);
          }
        },
        onCancel: () => {
          setPicker(null);
          if (returnTo) returnTo();
        },
      });
    };
    const toggleAutoUpdate = (enabled) => {
      try {
        void Promise.resolve(store.setAutoUpdate?.(enabled)).finally(() => render());
        store.pushNotice(`Auto-update ${enabled ? 'on' : 'off'}`, 'info');
      } catch (e) {
        store.pushNotice(`auto-update failed: ${e?.message || e}`, 'error');
      }
      render();
    };
    const recheck = () => {
      render({ checking: true });
      void Promise.resolve(store.checkForUpdate?.({ force: true }))
        .then(() => render())
        .catch((e) => {
          store.pushNotice(`update check failed: ${e?.message || e}`, 'error');
          render();
        });
    };
    const runUpdate = () => {
      store.pushNotice('Updating…', 'info');
      void Promise.resolve(store.runUpdateNow?.())
        .then((result) => {
          if (result?.ok) {
            store.pushNotice(`v${result.version} installed — restart to apply`, 'info');
          } else {
            store.pushNotice(`Update failed: ${result?.error || 'unknown error'}`, 'error');
          }
          render();
        })
        .catch((e) => {
          store.pushNotice(`Update failed: ${e?.message || e}`, 'error');
          render();
        });
    };
    render({ checking: true });
    void Promise.resolve(store.checkForUpdate?.({}))
      .then(() => render())
      .catch(() => render());
  };

  const openMemoryPicker = () => {
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: 'Memory',
      description: 'Status, core memory, and maintenance cycles.',
      items: [
        {
          value: 'status',
          label: 'Status',
          description: 'open memory runtime dashboard',
          _action: 'status',
        },
        {
          value: 'core',
          label: 'Core memory',
          description: 'list user-curated core memories',
          _action: 'core',
        },
        {
          value: 'cycle1',
          label: 'Run cycle1',
          description: 'chunk raw transcript leaves',
          _action: 'cycle1',
        },
        {
          value: 'cycle2',
          label: 'Run cycle2',
          description: 'review pending roots',
          _action: 'cycle2',
        },
        {
          value: 'cycle3',
          label: 'Run cycle3',
          description: 'review core memory health',
          _action: 'cycle3',
        },
        {
          value: 'backfill',
          label: 'Backfill 7d',
          description: 'ingest recent transcript window',
          _action: 'backfill',
        },
      ],
      onSelect: (_value, item) => {
        if (item._action === 'status') openMemoryStatusPicker();
        else if (item._action === 'core') openMemoryCorePicker();
        else if (item._action === 'cycle1') runMemoryAction({ action: 'cycle1' });
        else if (item._action === 'cycle2') runMemoryAction({ action: 'cycle2' });
        else if (item._action === 'cycle3') runMemoryAction({ action: 'cycle3' });
        else if (item._action === 'backfill') runMemoryAction({ action: 'backfill', window: '7d', scope: 'all' });
      },
      onCancel: () => {
        setPicker(null);
      },
    });
  };

  const openResumePicker = () => {
    let sessions;
    try {
      sessions = store.listSessions();
    } catch (e) {
      store.pushNotice(`could not list saved chats: ${e?.message || e}`, 'error');
      return;
    }
    if (!sessions || sessions.length === 0) {
      store.pushNotice('no saved chats', 'warn');
      return;
    }
    const items = sessions.map((s) => {
      const preview = String(s.preview || '').replace(/\n/g, ' ').trim();
      const count = formatSessionMessageCount(s.messageCount);
      return {
        value: s.id,
        label: `${formatSessionUpdatedAt(s.updatedAt)}  ${count}`,
        description: preview || '(no message)',
      };
    });
    setPicker({
      title: 'Resume',
      description: 'Restore a saved chat session.',
      items,
      fillAvailable: true,
      labelWidth: 21,
      onSelect: (value) => {
        setPicker(null);
        void store.resume(value)
          .then(ok => store.pushNotice(ok ? `Resumed ${value}` : 'Couldn’t resume chat.', ok ? 'info' : 'warn'))
          .catch((e) => store.pushNotice(`Couldn’t resume chat: ${e?.message || e}`, 'error'));
      },
      onCancel: () => {
        setPicker(null);
      },
    });
  };

  const openAutoClearPicker = (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    let current = null;
    try {
      current = store.getAutoClear?.() || null;
    } catch {
      current = null;
    }
    const idleLabel = current?.idleMs ? formatDuration(current.idleMs) : '1h';
    const applyAutoClear = (enabled) => {
      try {
        const next = store.setAutoClear?.({ enabled });
        if (!next) {
          store.pushNotice('autoclear unavailable', 'warn');
          return;
        }
        store.pushNotice(`autoclear ${next.enabled ? 'on' : 'off'} · idle ${formatDuration(next.idleMs)}`, 'info');
      } catch (e) {
        store.pushNotice(`autoclear failed: ${e?.message || e}`, 'error');
      }
    };
    const autoClearEnabled = current?.enabled === true;
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    setPicker({
      title: 'Auto-clear',
      description: `Clear idle context after ${idleLabel}.`,
      labelWidth: 10,
      items: [
        {
          value: 'on',
          label: 'On',
          marker: autoClearEnabled ? '✓' : '',
          markerColor: theme.success,
          description: autoClearEnabled ? `idle ${idleLabel}` : 'Enable idle auto-clear',
          _enabled: true,
        },
        {
          value: 'off',
          label: 'Off',
          marker: autoClearEnabled ? '' : '✓',
          markerColor: theme.success,
          description: autoClearEnabled ? 'Disable idle auto-clear' : 'idle auto-clear disabled',
          _enabled: false,
        },
      ],
      onSelect: (_value, item) => {
        setPicker(null);
        applyAutoClear(item?._enabled === true);
        if (returnTo) returnTo();
      },
      onCancel: () => {
        setPicker(null);
        if (returnTo) returnTo();
      },
    });
  };

  const openProfilePicker = (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    let profile = null;
    try {
      profile = store.getProfile?.() || null;
    } catch {
      profile = null;
    }
    const languages = Array.isArray(profile?.languages) && profile.languages.length
      ? profile.languages
      : [{ id: 'system', label: 'System (locale)' }];
    const currentLangId = profile?.language || 'system';
    const currentLang = languages.find((lang) => lang.id === currentLangId) || languages[0];
    const titleValue = String(profile?.title || '').trim();
    const cycleLanguage = (direction = 1) => {
      const idx = Math.max(0, languages.findIndex((lang) => lang.id === currentLangId));
      const next = languages[(idx + direction + languages.length) % languages.length];
      try {
        store.setProfile?.({ language: next.id });
        store.pushNotice(`Language set to ${next.label}`, 'info');
      } catch (e) {
        store.pushNotice(`profile update failed: ${e?.message || e}`, 'error');
      }
      openProfilePicker({ returnTo });
    };
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    setPicker({
      title: 'Profile',
      description: 'How the assistant addresses you and which language it replies in.',
      help: '↑/↓ Select · ←/→ Change · Enter Edit · Esc Close',
      indexMode: 'always',
      labelWidth: 12,
      metaWidth: 20,
      items: [
        {
          value: 'title',
          label: 'Title',
          meta: titleValue || '(not set)',
          description: 'Preferred form of address. Enter to edit.',
          _action: 'title',
        },
        {
          value: 'language',
          label: 'Language',
          meta: currentLang?.label || 'System (locale)',
          description: 'Response language. ←/→ to change, Enter to cycle.',
          _action: 'language',
        },
      ],
      onLeft: (item) => {
        if (item?._action === 'language') cycleLanguage(-1);
      },
      onRight: (item) => {
        if (item?._action === 'language') cycleLanguage(1);
      },
      onSelect: (_value, item) => {
        if (item?._action === 'title') {
          setPicker(null);
          setSettingsPrompt({
            kind: 'profile-title',
            label: 'Profile · Title',
            hint: 'How should the assistant address you? Leave blank to clear.',
          });
        } else if (item?._action === 'language') {
          cycleLanguage(1);
        }
      },
      onCancel: () => {
        setPicker(null);
        if (returnTo) returnTo();
      },
    });
  };

  // Open the manual path-entry flow. The user types a directory path; on submit
  // we register it (and offer to create it if missing). Used as a
  // fallback when no native folder dialog is available.
  const beginNewProjectManual = () => {
    setPicker(null);
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    setSettingsPrompt({
      kind: 'project-new',
      label: 'New project · Path',
      hint: 'Type a directory path. The folder name becomes the project name.',
    });
  };

  // Begin "create project": open the OS-native folder picker. The project picker
  // stays mounted (swapped to a non-interactive "Opening folder picker…" panel)
  // while the native dialog is open, so the welcome banner/layout stay put and
  // the prompt remains disabled (input is gated on `!!picker`). On a chosen
  // folder we register; on cancel we return to the project picker;
  // when no dialog tool exists we fall back to manual path typing.
  const beginNewProject = () => {
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    // Keep an overlay up (kind:'project' so the banner/height stay reserved) but
    // make it inert: no selectable items, navigation is a no-op until resolve.
    setPicker({
      kind: 'project',
      title: 'Project',
      description: 'Opening folder picker… choose a folder in the dialog window.',
      help: 'Waiting for the system folder dialog…',
      indexMode: 'never',
      items: [],
      onSelect: () => {},
      onCancel: () => {},
    });
    void pickFolder({
      title: 'Select a project folder',
      initialPath: String(state.cwd || process.cwd() || ''),
    })
      .then((result) => {
        if (!result || result.available === false) {
          // No native dialog on this system → manual typing.
          beginNewProjectManual();
          return;
        }
        if (!result.path) {
          // User cancelled the dialog → back to the project list.
          openProjectPicker();
          return;
        }
        registerProject(result.path);
      })
      .catch(() => {
        beginNewProjectManual();
      });
  };

  // Register a project in the picker list without switching this session's cwd.
  const registerProject = (rawPath) => {
    const path = resolveProjectPath(rawPath);
    if (!path) {
      store.pushNotice('project path is required', 'warn');
      return;
    }
    try {
      const project = addProject(path);
      if (project?.name) store.pushNotice(`project added: ${project.name}`, 'info');
      openProjectPicker();
    } catch (e) {
      store.pushNotice(`project add failed: ${e?.message || e}`, 'error');
    }
  };

  // Switch the active working directory to a registered/created project path.
  const enterProject = (rawPath, options = {}) => {
    const path = resolveProjectPath(rawPath);
    if (!path) {
      store.pushNotice('project path is required', 'warn');
      return;
    }
    try {
      // Switch cwd first; only persist the project once the runtime accepts it,
      // so an invalid/missing path can never be written to projects.json.
      store.setCwd?.(path, {
        notice: options?.notice !== false,
        message: `Project set: ${projectNameFromPath(path)}`,
      });
      addProject(path);
      touchProjectSelected(path);
    } catch (e) {
      store.pushNotice(`project switch failed: ${e?.message || e}`, 'error');
    }
  };

  // Begin renaming a registered project's display name. Opens a text prompt
  // seeded with the current name; submitting persists via renameProject and
  // returns to the project picker. The path is never changed.
  const beginRenameProject = (project) => {
    if (!project?.path) return;
    setPicker(null);
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    setSettingsPrompt({
      kind: 'project-rename',
      label: 'Rename project',
      hint: 'Set a display name. Leave blank to reset to the folder name.',
      projectPath: project.path,
      initialValue: project.name || '',
    });
  };

  // Open the project selector, styled like the Model picker: numbered rows with
  // a Name column + Path column. The list always opens (even when empty) and
  // lists registered projects first, then a trailing "Current Path" shortcut.
  // Creating a new project is available via the picker-level c shortcut.
  const openProjectPicker = () => {
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    setPicker(buildProjectPickerState());
  };

  const runSlashCommand = (cmd, arg = '') => {
    const rawName = String(cmd || '').toLowerCase();
    cmd = normalizeSlashCommandName(cmd);
    if (cmd !== 'context') setContextPanel(null);
    if (cmd !== 'usage') closeUsagePanel();
    switch (cmd) {
      case 'clear':
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /clear', 'warn');
          return false;
        }
        if (rawName === 'new') {
          void store.newSession().then(() => {}).catch((e) => store.pushNotice(`new session failed: ${e?.message || e}`, 'error'));
        } else {
          void store.clear().then(() => {}).catch((e) => store.pushNotice(`clear failed: ${e?.message || e}`, 'error'));
        }
        return true;
      case 'model':
        if (!arg) {
          openModelPicker();
          return true;
        }
        void store.setModel(arg)
          .then(ok => store.pushNotice(ok ? modelSwitchNotice() : 'Model switch is already running.', ok ? 'info' : 'warn'))
          .catch((e) => store.pushNotice(`Couldn’t switch model: ${e?.message || e}`, 'error'));
        return true;
      case 'remote': {
        const enabled = store.toggleRemote?.() === true;
        store.pushNotice(enabled ? 'Remote mode ON' : 'Remote mode OFF', 'info');
        return true;
      }
      case 'voice': {
        // Step1 only: toggleVoice() owns config persistence (voice.enabled) +
        // the missing-component install sequence + its own notices (OFF/ON/
        // progress/failure). We don't push a redundant notice here; a null
        // return means "already running" or "failed", both already noticed.
        void toggleVoice({ pushNotice: store.pushNotice });
        return true;
      }
      case 'search':
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /search', 'warn');
          return false;
        }
        if (arg) store.pushNotice('/search sets the search provider/model; the search tool uses that model when called.', 'warn');
        openSearchPicker();
        return true;
      case 'agents':
        openAgentsPicker();
        return true;
      case 'workflow':
        if (!arg) {
          openWorkflowPicker();
          return true;
        }
        void store.setWorkflow?.(arg.trim())
          .then((result) => {
            if (!result) {
              store.pushNotice('Workflow switch is already running.', 'warn');
              return;
            }
            store.pushNotice(workflowSwitchNotice(result), 'info');
          })
          .catch((e) => store.pushNotice(`Couldn’t switch workflow: ${e?.message || e}`, 'error'));
        return true;
      case 'outputstyle': {
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /OutputStyle', 'warn');
          return false;
        }
        const value = arg.trim();
        const lower = value.toLowerCase();
        if (!value) {
          openOutputStylePicker();
          return true;
        }
        if (lower === 'status' || lower === 'current' || lower === 'show') {
          try {
            const status = store.getOutputStyle?.();
            const label = status?.current?.label || status?.current?.id || status?.configured || 'Default';
            store.pushNotice(`Output style: ${label}`, 'info');
          } catch (e) {
            store.pushNotice(`Couldn’t read output style: ${e?.message || e}`, 'error');
          }
          return true;
        }
        void store.setOutputStyle?.(value)
          .then((result) => {
            if (!result) {
              store.pushNotice('Output style switch is already running.', 'warn');
              return;
            }
            store.pushNotice(outputStyleNotice(result), 'info');
          })
          .catch((e) => store.pushNotice(`Couldn’t switch output style: ${e?.message || e}`, 'error'));
        return true;
      }
      case 'theme': {
        const value = arg.trim();
        const lower = value.toLowerCase();
        if (!value) {
          openThemePicker();
          return true;
        }
        let themes = [];
        try { themes = store.listThemes?.() || []; } catch (e) {
          store.pushNotice(`could not list themes: ${e?.message || e}`, 'error');
          return true;
        }
        if (lower === 'status' || lower === 'current' || lower === 'show') {
          const id = store.getTheme?.();
          const entry = themes.find((t) => t.id === id);
          store.pushNotice(`Theme: ${entry?.label || id || 'default'}`, 'info');
          return true;
        }
        const match = themes.find((t) => t.id.toLowerCase() === lower)
          || themes.find((t) => String(t.label || '').toLowerCase() === lower);
        if (!match) {
          const ids = themes.map((t) => t.id).join(', ');
          store.pushNotice(`usage: /theme [id]. Available: ${ids}`, 'warn');
          return true;
        }
        try {
          const applied = store.setTheme?.(match.id, { persist: true });
          store.pushNotice(themeNotice(applied || match), 'info');
        } catch (e) {
          store.pushNotice(`Couldn’t set theme: ${e?.message || e}`, 'error');
        }
        return true;
      }
      case 'effort':
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /effort', 'warn');
          return false;
        }
        if (!arg) {
          openEffortPicker();
          return true;
        }
        void store.setEffort(arg)
          .then(result => store.pushNotice(result ? `Effort set to ${result}` : 'Effort switch is already running.', result ? 'info' : 'warn'))
          .catch((e) => store.pushNotice(`Couldn’t switch effort: ${e?.message || e}`, 'error'));
        return true;
      case 'fast': {
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /fast', 'warn');
          return false;
        }
        const value = String(arg || '').trim().toLowerCase();
        const setTo = value
          ? ['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(value)
            ? true
            : ['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(value)
              ? false
              : null
          : undefined;
        if (setTo === null) {
          store.pushNotice('usage: /fast [on|off]', 'warn');
          return true;
        }
        const action = setTo === undefined ? store.toggleFast?.() : store.setFast?.(setTo);
        void Promise.resolve(action)
          .then((enabled) => {
            if (enabled === null || enabled === undefined) {
              store.pushNotice('Fast mode switch is already running.', 'warn');
              return;
            }
            store.pushNotice(`Fast mode ${enabled ? 'on' : 'off'} for ${state.provider}/${state.model}`, 'info');
          })
          .catch((e) => store.pushNotice(`Couldn’t update fast mode: ${e?.message || e}`, 'error'));
        return true;
      }
      case 'cwd': {
        const nextPath = arg.trim();
        if (!nextPath) {
          store.pushNotice(`Project path: ${state.cwd}`, 'info');
          return true;
        }
        try {
          store.setCwd?.(nextPath, { message: `Project set: ${projectNameFromPath(nextPath)}` });
        } catch (e) {
          store.pushNotice(`project switch failed: ${e?.message || e}`, 'error');
        }
        return true;
      }
      case 'project': {
        const target = arg.trim();
        if (target) {
          enterProject(target);
          return true;
        }
        openProjectPicker();
        return true;
      }
      case 'tools':
        openToolsPicker(arg.trim());
        return true;
      case 'mcp':
        openMcpPicker();
        return true;
      case 'skills':
        openSkillsPicker();
        return true;
      case 'plugins':
        openPluginsPicker();
        return true;
      case 'hooks':
        openHooksPicker();
        return true;
      case 'providers':
        void openProviderSetupPicker();
        return true;
      case 'channels':
        void openChannelSetupPicker('all');
        return true;
      case 'schedules':
        void openChannelSetupPicker('schedules');
        return true;
      case 'webhooks':
        void openChannelSetupPicker('webhooks');
        return true;
      case 'auth':
        store.pushNotice('/auth moved to /providers', 'info');
        void openProviderSetupPicker();
        return true;
      case 'auth-forget': {
        const providerId = arg.trim();
        if (!providerId) {
          store.pushNotice('usage: /auth-forget <provider>', 'warn');
          return true;
        }
        try {
          store.forgetProviderAuth(providerId);
        } catch (e) {
          store.pushNotice(`auth-forget failed: ${e?.message || e}`, 'error');
        }
        return true;
      }
      case 'memory': {
        if (!arg.trim()) {
          openMemoryPicker();
          return true;
        }
        void store.memoryControl?.(parseMemoryCommand(arg))
          .catch((e) => store.pushNotice(`memory failed: ${e?.message || e}`, 'error'));
        return true;
      }
      case 'recall': {
        const query = arg.trim();
        if (!query) {
          store.pushNotice('usage: /recall <query>', 'warn');
          return true;
        }
        void store.recall?.(query)
          .catch((e) => store.pushNotice(`recall failed: ${e?.message || e}`, 'error'));
        return true;
      }
      case 'autoclear': {
        const value = arg.trim().toLowerCase();
        if (!value) {
          openAutoClearPicker();
          return true;
        }
        try {
          let next;
          if (value === 'status') {
            next = store.getAutoClear?.();
          } else if (value === 'on' || value === 'enable' || value === 'enabled') {
            next = store.setAutoClear?.({ enabled: true });
          } else if (value === 'off' || value === 'disable' || value === 'disabled') {
            next = store.setAutoClear?.({ enabled: false });
          } else {
            next = store.setAutoClear?.({ duration: value });
          }
          if (!next) {
            store.pushNotice('autoclear unavailable', 'warn');
            return true;
          }
          store.pushNotice(`autoclear ${next.enabled ? 'on' : 'off'} · idle ${formatDuration(next.idleMs)}`, 'info');
        } catch (e) {
          store.pushNotice(`autoclear failed: ${e?.message || e}`, 'error');
        }
        return true;
      }
      case 'compact':
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /compact', 'warn');
          return false;
        }
        void store.compact()
          .then((r) => {
            if (!r) {
              store.pushNotice('Compact failed.', 'warn');
              return;
            }
            if (r.error) {
              store.pushNotice('Compact failed.', 'error');
              return;
            }
            if (r.changed === false && r.reason) {
              store.pushNotice(r.reason, 'warn');
              return;
            }
            if (r.changed === false) {
              store.pushNotice('nothing to compact', 'warn');
              return;
            }
            store.pushNotice('Compact done.', 'info');
          })
          .catch(() => store.pushNotice('Compact failed.', 'error'));
        return true;
      case 'resume':
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /resume', 'warn');
          return false;
        }
        if (arg) {
          void store.resume(arg)
            .then(ok => store.pushNotice(ok ? `Resumed ${arg}` : 'Couldn’t resume chat.', ok ? 'info' : 'warn'))
            .catch((e) => store.pushNotice(`Couldn’t resume chat: ${e?.message || e}`, 'error'));
        } else {
          openResumePicker();
        }
        return true;
      case 'usage':
        openUsagePanel(arg);
        return true;
      case 'context':
        openContextPicker();
        return true;
      case 'settings':
      case 'config':
        openSettingsPicker();
        return true;
      case 'profile':
        openProfilePicker();
        return true;
      case 'update':
        openUpdatePicker();
        return true;
      case 'quit':
        requestExit();
        return true;
      default:
        store.pushNotice(`unknown command: /${cmd}`, 'warn');
        return true;
    }
  };

  const onSubmit = (raw) => {
    const text = String(raw ?? '');
    const commandText = text.trim();
    if (providerPrompt) {
      if (state.commandBusy) {
        store.pushNotice('wait for the current command to finish', 'warn');
        return false;
      }
      if (providerPrompt.kind === 'api-key') {
        if (!commandText) {
          store.pushNotice(`API key is required for ${providerPrompt.providerId}`, 'warn');
          return false;
        }
        try {
          store.saveProviderApiKey(providerPrompt.providerId, commandText);
          clearModelCaches('all');
          const afterSave = providerPrompt.afterSave;
          setProviderPrompt(null);
          if (afterSave) afterSave();
          else void openProviderSetupPicker();
          return true;
        } catch (e) {
          store.pushNotice(`api key save failed: ${e?.message || e}`, 'error');
          return false;
        }
      }
      if (providerPrompt.kind === 'opencode-go-cookie') {
        if (!commandText) {
          store.pushNotice('OpenCode auth cookie is required for usage lookup', 'warn');
          return false;
        }
        try {
          store.saveOpenCodeGoUsageAuth({
            workspaceId: providerPrompt.workspaceId,
            authCookie: commandText,
          });
          const afterSave = providerPrompt.afterSave;
          setProviderPrompt(null);
          if (afterSave) afterSave();
          else void openProviderSetupPicker();
          return true;
        } catch (e) {
          store.pushNotice(`OpenCode Go usage auth save failed: ${e?.message || e}`, 'error');
          return false;
        }
      }
      if (providerPrompt.kind === 'openai-usage-session') {
        if (!commandText) {
          store.pushNotice('OpenAI usage session key is required for credit lookup', 'warn');
          return false;
        }
        try {
          store.saveOpenAIUsageSessionKey(commandText);
          const afterSave = providerPrompt.afterSave;
          setProviderPrompt(null);
          if (afterSave) afterSave();
          else void openProviderSetupPicker();
          return true;
        } catch (e) {
          store.pushNotice(`OpenAI usage auth save failed: ${e?.message || e}`, 'error');
          return false;
        }
      }
      if (providerPrompt.kind === 'local-url') {
        try {
          store.setLocalProvider(providerPrompt.providerId, {
            enabled: true,
            baseURL: commandText || providerPrompt.defaultURL,
          });
          clearModelCaches('all');
          const afterSave = providerPrompt.afterSave;
          setProviderPrompt(null);
          if (afterSave) afterSave();
          else void openProviderSetupPicker();
          return true;
        } catch (e) {
          store.pushNotice(`local provider update failed: ${e?.message || e}`, 'error');
          return false;
        }
      }
      if (providerPrompt.kind === 'oauth-code') {
        if (!commandText) {
          store.pushNotice('OAuth code is required', 'warn');
          return false;
        }
        if (oauthSubmitRef.current || providerPrompt.submitting) {
          store.pushNotice('OAuth code is already being submitted', 'warn');
          return false;
        }
        oauthSubmitRef.current = true;
        setProviderPrompt((prompt) => prompt === providerPrompt ? { ...prompt, submitting: true } : prompt);
        void providerPrompt.login?.completeCode(commandText)
          .then(() => {
            const successReturn = providerPrompt.successReturn;
            const afterSave = providerPrompt.afterSave;
            oauthSubmitRef.current = false;
            clearModelCaches('all');
            setProviderPrompt(null);
            store.pushNotice(`${providerPrompt.providerName || 'OAuth'} login complete`, 'info');
            if (successReturn) successReturn();
            else if (afterSave) afterSave();
            else void openProviderSetupPicker();
          })
          .catch((e) => {
            oauthSubmitRef.current = false;
            store.pushNotice(`oauth code failed: ${e?.message || e}`, 'error');
            setProviderPrompt(null);
            providerPrompt.failureReturn?.(e);
          });
        return true;
      }
    }
    if (channelPrompt) {
      if (state.commandBusy) {
        store.pushNotice('wait for the current command to finish', 'warn');
        return false;
      }
      try {
        const resumeAfterChannelPrompt = (prompt) => {
          const afterSave = prompt?.afterSave;
          setChannelPrompt(null);
          if (typeof afterSave === 'function') afterSave();
          else void openChannelSetupPicker('all');
        };
        if (channelPrompt.kind === 'discord-token') {
          if (!commandText) return false;
          store.saveDiscordToken(commandText);
          resumeAfterChannelPrompt(channelPrompt);
          return true;
        }
        if (channelPrompt.kind === 'telegram-token') {
          if (!commandText) return false;
          store.saveTelegramToken(commandText);
          resumeAfterChannelPrompt(channelPrompt);
          return true;
        }
        if (channelPrompt.kind === 'webhook-token') {
          if (!commandText) return false;
          store.saveWebhookAuthtoken(commandText);
          resumeAfterChannelPrompt(channelPrompt);
          return true;
        }
        if (channelPrompt.kind === 'webhook-domain') {
          if (!commandText) return false;
          store.setWebhookConfig?.({ ngrokDomain: commandText });
          resumeAfterChannelPrompt(channelPrompt);
          return true;
        }
        const parts = commandText.split('|').map((part) => part.trim());
        if (channelPrompt.kind === 'channel-add') {
          const [name, channelId, mode, mainFlag] = parts;
          const main = String(mainFlag || '').toLowerCase() === 'main' || String(name || '').toLowerCase() === 'main';
          store.saveChannel({ name, channelId, mode, main, backend: channelPrompt.backend });
          resumeAfterChannelPrompt(channelPrompt);
          return true;
        }
        if (channelPrompt.kind === 'schedule-add') {
          const [name, time, instructions, channel, model] = parts;
          store.saveSchedule({ name, time, instructions, channel, model });
          setChannelPrompt(null);
          void openChannelSetupPicker('schedules');
          return true;
        }
        if (channelPrompt.kind === 'webhook-add') {
          const [name, instructions, channel, model, parser] = parts;
          const result = store.saveWebhook({ name, instructions, channel, model, parser });
          if (result?.secret) {
            store.pushNotice(`webhook secret for ${result.name}: ${result.secret}`, 'info');
          }
          setChannelPrompt(null);
          void openChannelSetupPicker('webhooks');
          return true;
        }
      } catch (e) {
        store.pushNotice(`channels update failed: ${e?.message || e}`, 'error');
        return false;
      }
    }
    if (hookPrompt) {
      if (state.commandBusy) {
        store.pushNotice('wait for the current command to finish', 'warn');
        return false;
      }
      try {
        if (hookPrompt.kind === 'rule-add') {
          const parsed = parseHookRuleInput(commandText);
          if (parsed.error) {
            store.pushNotice(parsed.error, 'warn');
            return false;
          }
          store.addHookRule?.(parsed.rule);
          setHookPrompt(null);
          void openHooksPicker();
          return true;
        }
      } catch (e) {
        store.pushNotice(`hook update failed: ${e?.message || e}`, 'error');
        return false;
      }
    }
    if (settingsPrompt) {
      if (state.commandBusy) {
        store.pushNotice('wait for the current command to finish', 'warn');
        return false;
      }
      try {
        if (settingsPrompt.kind === 'cwd') {
          if (!commandText) {
            store.pushNotice('working directory path is required', 'warn');
            return false;
          }
          store.setCwd?.(commandText, { message: `Project set: ${projectNameFromPath(commandText)}` });
          setSettingsPrompt(null);
          void openSettingsPicker();
          return true;
        }
        if (settingsPrompt.kind === 'project-new') {
          if (!commandText) {
            store.pushNotice('project path is required', 'warn');
            return false;
          }
          const path = resolveProjectPath(commandText);
          if (isDirectory(path)) {
            setSettingsPrompt(null);
            registerProject(path);
            return true;
          }
          // A path that exists but is a regular file is not a valid project dir.
          if (pathExists(path)) {
            store.pushNotice(`${path} is not a directory`, 'warn');
            return false;
          }
          // Missing folder: confirm creation before registering.
          setSettingsPrompt({
            kind: 'project-create-confirm',
            label: 'New project · Create folder?',
            hint: `${path} does not exist. Type "y" to create it, or anything else to cancel.`,
            pendingPath: path,
          });
          return true;
        }
        if (settingsPrompt.kind === 'project-create-confirm') {
          const pendingPath = String(settingsPrompt.pendingPath || '');
          const answer = String(commandText || '').trim().toLowerCase();
          if (answer === 'y' || answer === 'yes') {
            const created = ensureDir(pendingPath);
            if (!created) {
              store.pushNotice(`could not create folder: ${pendingPath}`, 'error');
              setSettingsPrompt(null);
              return true;
            }
            setSettingsPrompt(null);
            registerProject(pendingPath);
            return true;
          }
          setSettingsPrompt(null);
          store.pushNotice('project creation canceled', 'info');
          return true;
        }
        if (settingsPrompt.kind === 'project-rename') {
          const targetPath = String(settingsPrompt.projectPath || '');
          try {
            const updated = renameProject(targetPath, commandText);
            if (updated) {
              store.pushNotice(`project renamed to "${updated.name}"`, 'info');
            }
          } catch (e) {
            store.pushNotice(`rename failed: ${e?.message || e}`, 'error');
          }
          setSettingsPrompt(null);
          openProjectPicker();
          return true;
        }
        if (settingsPrompt.kind === 'system-shell') {
          store.setSystemShell?.(commandText);
          setSettingsPrompt(null);
          void openSettingsPicker();
          return true;
        }
        if (settingsPrompt.kind === 'profile-title') {
          try {
            store.setProfile?.({ title: commandText });
            store.pushNotice(commandText ? `Title set to "${commandText.trim()}"` : 'Title cleared', 'info');
          } catch (e) {
            store.pushNotice(`profile update failed: ${e?.message || e}`, 'error');
          }
          setSettingsPrompt(null);
          openProfilePicker();
          return true;
        }
        if (settingsPrompt.kind === 'plugin-add') {
          if (!commandText) {
            store.pushNotice('plugin URL/path is required', 'warn');
            return false;
          }
          void store.addPlugin?.(commandText)
            .then(() => openPluginsPicker())
            .catch((e) => store.pushNotice(`plugin add failed: ${e?.message || e}`, 'error'));
          setSettingsPrompt(null);
          return true;
        }
        if (settingsPrompt.kind === 'mcp-add') {
          const parsed = parseMcpServerInput(commandText);
          if (parsed.error) {
            store.pushNotice(parsed.error, 'warn');
            return false;
          }
          void store.addMcpServer?.(parsed.server)
            .then(() => openMcpServersPicker())
            .catch((e) => store.pushNotice(`mcp add failed: ${e?.message || e}`, 'error'));
          setSettingsPrompt(null);
          return true;
        }
        if (settingsPrompt.kind === 'skill-add') {
          const parsed = parseSkillInput(commandText);
          if (parsed.error) {
            store.pushNotice(parsed.error, 'warn');
            return false;
          }
          void store.addSkill?.(parsed.skill)
            .then(() => openProjectSkillsPicker())
            .catch((e) => store.pushNotice(`skill add failed: ${e?.message || e}`, 'error'));
          setSettingsPrompt(null);
          return true;
        }
        if (settingsPrompt.kind === 'skill-use') {
          const skillName = String(settingsPrompt.skillName || '').trim();
          if (!skillName) {
            store.pushNotice('skill name is missing', 'warn');
            return false;
          }
          const prompt = `$${skillName}${commandText ? ` ${commandText}` : ''}`;
          setSettingsPrompt(null);
          const accepted = store.submit(prompt);
          if (accepted) armTranscriptFollow();
          return accepted;
        }
      } catch (e) {
        store.pushNotice(`settings update failed: ${e?.message || e}`, 'error');
        return false;
      }
    }
    if (!commandText) return false;
    if (state.commandBusy) {
      store.pushNotice('wait for the current command to finish', 'warn');
      return false;
    }

    if (commandText.startsWith('/')) {
      const [cmd, ...rest] = commandText.slice(1).split(/\s+/);
      const accepted = runSlashCommand(cmd, rest.join(' ').trim());
      if (accepted !== false) clearPastedImagesSnapshot();
      return accepted;
    }
    const imageRefs = imageReferenceIds(text);
    const imageSnapshot = Object.fromEntries(Object.entries(pastedImagesRef.current || {})
      .filter(([id]) => imageRefs.has(Number(id))));
    const hasImageSnapshot = Object.keys(imageSnapshot).length > 0;
    const content = buildPromptContentWithImages(text, imageSnapshot);
    const accepted = store.submit(content, {
      displayText: text,
      pastedImages: imageSnapshot,
      onCommitted: hasImageSnapshot ? () => clearPastedImagesSnapshot(imageSnapshot) : null,
    });
    if (accepted) {
      armTranscriptFollow();
      if (imageRefs.size === 0 || (!hasImageSnapshot && !state.busy)) clearPastedImagesSnapshot();
      else if (state.busy && hasImageSnapshot) clearPastedImagesSnapshot(imageSnapshot);
    }
    return accepted;
  };

  const activeSlashQuery = providerPrompt || channelPrompt || hookPrompt || settingsPrompt || toolApproval || contextPanel || usagePanel ? null : slashQuery(promptDraft);
  const slashCommands = activeSlashQuery === null || picker || toolApproval || contextPanel || usagePanel || exiting || state.commandBusy
    ? []
    : SLASH_COMMANDS
      .filter((command) => slashCommandMatches(command, activeSlashQuery))
      .sort(compareSlashCommands);
  const slashPaletteOpen = activeSlashQuery !== null
    && slashDismissedFor !== promptDraft
    && slashCommands.length > 0;
  slashPaletteRef.current = { open: slashPaletteOpen, count: slashCommands.length };
  scrollFocusRef.current = {
    slashPaletteOpen,
    picker: !!picker,
    toolApproval: !!toolApproval,
    contextPanel: !!contextPanel,
    usagePanel: !!usagePanel,
    providerPrompt: !!providerPrompt,
    channelPrompt: !!channelPrompt,
    hookPrompt: !!hookPrompt,
    settingsPrompt: !!settingsPrompt,
  };

  useEffect(() => {
    setSlashIndex((index) => Math.min(index, Math.max(0, slashCommands.length - 1)));
  }, [slashCommands.length, activeSlashQuery]);

  const onPromptDraftChange = useCallback((value) => {
    if (String(value ?? '').length > 0) dismissWelcomePromptHint();
    syncPromptLayoutRows(value);
    const suppressPromptHint = promptHistoryDraftChangeRef.current;
    promptHistoryDraftChangeRef.current = false;
    const historyNav = promptHistoryNavRef.current;
    if (!value || (historyNav.active && value !== historyNav.lastValue && value !== historyNav.seed)) {
      resetPromptHistoryNav();
    }
    // Only lift the draft into App state when it can affect the slash palette
    // (a single "/token"). Prose typing renders entirely inside PromptInput's
    // own state, so App need not re-render — and relayout the full fullscreen
    // frame — on every keystroke (input lag fix). Entering slash mode and
    // leaving it both still sync because either prev or next is a slash token.
    // Clearing/submitting must also sync so a consumed slash command does not
    // remount later as stale initialValue after a picker/panel closes.
    const nextSlash = slashQuery(value);
    setPromptDraft((prev) => {
      const previousWasSlashFlow = String(prev || '').startsWith('/');
      if (value === '') return '';
      return nextSlash !== null || previousWasSlashFlow ? value : prev;
    });
    setPromptDraftOverride((prev) => (prev === null ? prev : null));
    const argumentHint = slashArgumentHint(value);
    if (argumentHint && !suppressPromptHint) {
      showPromptHint(argumentHint, 'info');
    } else if (suppressPromptHint || promptHintActiveRef.current || promptHintTimerRef.current) {
      // Only clear when a hint is actually live (shown or pending its timer).
      // clearPromptHint() already early-returns when neither ref is set, but
      // gating the call here avoids invoking it on EVERY keystroke once a hint
      // has appeared — that call path otherwise drives a setState → full App
      // re-render per key, which is costly on long transcripts. Hint-while-
      // typing still vanishes immediately because the guard includes the active
      // state; the argumentHint branch above is untouched. The guard no longer
      // requires a non-empty value: clearing/submitting to '' must also dismiss
      // a live hint instead of leaving it until its timer expires.
      clearPromptHint();
    }
    if (slashDismissedFor) {
      setSlashDismissedFor((dismissed) => (dismissed && dismissed !== value ? '' : dismissed));
    }
  }, [clearPromptHint, dismissWelcomePromptHint, resetPromptHistoryNav, showPromptHint, slashDismissedFor, syncPromptLayoutRows]);

  const cancelProviderPrompt = useCallback(() => {
    try { providerPrompt?.login?.cancel?.(); } catch {}
    oauthSubmitRef.current = false;
    const onCancel = providerPrompt?.cancelReturn || providerPrompt?.onCancel;
    const afterSave = providerPrompt?.afterSave;
    setProviderPrompt(null);
    if (onCancel) onCancel();
    else if (afterSave) afterSave();
  }, [providerPrompt, showPromptHint]);

  const cancelChannelPrompt = useCallback(() => {
    const onCancel = channelPrompt?.onCancel;
    const afterSave = channelPrompt?.afterSave;
    setChannelPrompt(null);
    if (typeof onCancel === 'function') onCancel();
    else if (typeof afterSave === 'function') afterSave();
  }, [channelPrompt, showPromptHint]);

  const cancelHookPrompt = useCallback(() => {
    setHookPrompt(null);
  }, [showPromptHint]);

  const cancelSettingsPrompt = useCallback(() => {
    // The project entry prompts are reached from the project picker; backing out
    // (Esc) should return to that picker rather than dropping to a bare prompt.
    const kind = settingsPrompt?.kind;
    setSettingsPrompt(null);
    if (kind === 'project-new' || kind === 'project-create-confirm' || kind === 'project-rename') {
      openProjectPicker();
    }
  }, [settingsPrompt, showPromptHint]);

  const acceptSlashPalette = useCallback((draftValue = '') => {
    const command = slashCommands[slashIndex];
    if (!command) return false;
    pickerOpenedFromEnterRef.current = true;
    if (pickerOpenedFromEnterTimerRef.current) {
      clearTimeout(pickerOpenedFromEnterTimerRef.current);
      pickerOpenedFromEnterTimerRef.current = null;
    }
    try {
      return runSlashCommand(slashCommandTokenForPaletteAccept(command, draftValue), '');
    } finally {
      pickerOpenedFromEnterTimerRef.current = setTimeout(() => {
        pickerOpenedFromEnterRef.current = false;
        pickerOpenedFromEnterTimerRef.current = null;
      }, 3000);
    }
  }, [slashCommands, slashIndex]);

  const completeSlashPalette = useCallback((draftValue = '') => {
    const command = slashCommands[slashIndex];
    if (!command) return undefined;
    const token = slashCommandTokenForPaletteAccept(command, draftValue);
    return token ? `/${token} ` : undefined;
  }, [slashCommands, slashIndex]);

  const cancelSlashPalette = useCallback((value = '') => {
    // Esc clears the slash draft, so the dismissal marker must not survive.
    // If it stays as "/" then typing "/" again is treated as the same
    // dismissed query and the palette never re-opens.
    setSlashDismissedFor('');
    setPromptDraft('');
    setPromptDraftOverride({ id: Date.now(), value: '' });
  }, []);

  const resizeEpoch = resizeState.epoch;
  // agentRevision is a cheap change-detection key for downstream consumers, but
  // JSON.stringify over the worker/job arrays ran on EVERY render (including the
  // ~120fps streaming reconciles). Memoize on the agent slices so it only
  // recomputes when agent state actually changes, not on every assistant delta.
  const agentRevision = useMemo(() => JSON.stringify({
    workers: (state.agentWorkers || []).map((w) => [w.tag, w.status, w.stage, w.sessionId]).slice(0, 20),
    jobs: (state.agentJobs || []).map((j) => [j.task_id, j.status, j.tag, j.sessionId, j.startedAt, j.finishedAt, j.error]).slice(0, 20),
  }), [state.agentWorkers, state.agentJobs]);

  // L2 statusline explore/search segments are the MAIN session's own running
  // tool cards (NOT agentWorkers/agentJobs). Derive pending counts + oldest
  // start time straight from the live transcript tool cards. A card is pending
  // until completedCount >= count. (Do NOT use completedAt as the terminal
  // signal: engine patchToolCardResult stamps completedAt on EVERY aggregate
  // result patch even while calls are still running, and reused tail-aggregates
  // keep a stale completedAt, so it would drop the segment early / skip newly
  // added pending calls.) Aggregate cards carry a `categories` map; standalone
  // cards carry name/args resolved
  // via classifyToolCategory. Keep this CHEAP: build a primitive signature from
  // only the tool items (mirrors agentRevision) so streaming flushes that swap
  // state.items for a fresh array don't restringify the whole transcript and
  // the StatusLine effect only re-fires when the numbers actually change.
  const activeToolsSignature = useMemo(() => {
    const items = state.items || [];
    let exploreCount = 0;
    let exploreStart = 0;
    let searchCount = 0;
    let searchStart = 0;
    for (const it of items) {
      if (!it || it.kind !== 'tool') continue;
      const count = Math.max(1, Number(it.count || 1));
      // Resolved check: aggregates stay on the pure completedCount>=count test
      // because engine patchToolCardResult sets `result` on EVERY aggregate
      // patch (even partial, completedCount<count), so a `result`-aware check
      // would drop a still-running aggregate early. Standalone cards mirror
      // toolItemPendingForRows (done when completedCount>=count OR a result
      // landed) so an abnormally-finished card (cancelled/errored) that sets a
      // result without bumping completedCount cannot pin a phantom segment.
      const done = it.aggregate
        ? Number(it.completedCount || 0)
        : Math.max(0, Math.min(count, Number(it.completedCount || (it.result == null ? 0 : count))));
      if (done >= count) continue; // resolved card (matches toolItemPendingForRows)
      const started = Number(it.startedAt || 0);
      let exploreHits = 0;
      let searchHits = 0;
      if (it.aggregate && it.categories && typeof it.categories === 'object') {
        for (const v of Object.values(it.categories)) {
          const cat = v && typeof v === 'object' ? v.category : null;
          const c = Math.max(1, Number(v && typeof v === 'object' ? v.count : 1) || 1);
          if (cat === 'Explore') exploreHits += c;
          else if (cat === 'Search') searchHits += c;
        }
      } else if (it.name) {
        const cat = classifyToolCategory(it.name, it.args || {});
        if (cat === 'Explore') exploreHits = count;
        else if (cat === 'Search') searchHits = count;
      }
      if (exploreHits > 0) {
        exploreCount += exploreHits;
        if (started > 0 && (exploreStart === 0 || started < exploreStart)) exploreStart = started;
      }
      if (searchHits > 0) {
        searchCount += searchHits;
        if (started > 0 && (searchStart === 0 || started < searchStart)) searchStart = started;
      }
    }
    if (!exploreCount && !searchCount) return '';
    return `${exploreCount}:${exploreStart}:${searchCount}:${searchStart}`;
  }, [state.items]);

  const activeTools = useMemo(() => {
    if (!activeToolsSignature) return null;
    const [ec, es, sc, ss] = activeToolsSignature.split(':').map((n) => Number(n) || 0);
    return {
      explore: { count: ec, startedAt: es },
      search: { count: sc, startedAt: ss },
    };
  }, [activeToolsSignature]);

  // StatusLine only reads a small stats subset; engine clones the full stats
  // object on many updates. Memoize by field value so identical usage keeps
  // the same object reference and React.memo / effect deps stay quiet.
  const statuslineStats = useMemo(() => {
    const s = state.stats || {};
    return {
      currentContextSource: s.currentContextSource ?? null,
      currentEstimatedContextTokens: s.currentEstimatedContextTokens ?? 0,
      currentContextTokens: s.currentContextTokens ?? 0,
      contextTokens: s.contextTokens ?? 0,
      latestPromptTokens: s.latestPromptTokens ?? 0,
      latestInputTokens: s.latestInputTokens ?? 0,
      latestCachedTokens: s.latestCachedTokens ?? 0,
      latestCacheWriteTokens: s.latestCacheWriteTokens ?? 0,
      inputTokens: s.inputTokens ?? 0,
      cachedTokens: s.cachedTokens ?? 0,
      cacheWriteTokens: s.cacheWriteTokens ?? 0,
      promptTokens: s.promptTokens ?? 0,
      turns: s.turns ?? 0,
    };
  }, [
    state.stats?.currentContextSource,
    state.stats?.currentEstimatedContextTokens,
    state.stats?.currentContextTokens,
    state.stats?.contextTokens,
    state.stats?.latestPromptTokens,
    state.stats?.latestInputTokens,
    state.stats?.latestCachedTokens,
    state.stats?.latestCacheWriteTokens,
    state.stats?.inputTokens,
    state.stats?.cachedTokens,
    state.stats?.cacheWriteTokens,
    state.stats?.promptTokens,
    state.stats?.turns,
  ]);

  // ── Transcript viewport height ──────────────────────────────────────────
  // ROOT-CAUSE FIX: the transcript must live in a box with an EXPLICIT numeric
  // height + overflow:hidden so ink's renderer actually clips off-screen rows
  // (render-node-to-output.js → output.clip uses the box's computed height). An
  // unbounded negative-margin column inside a flexGrow box let stale rows
  // overprint newer ones across incremental redraws. We reserve the rows the
  // bottom cluster needs and give the transcript everything above it.
  //
  //   viewportHeight = rows
  //                  − welcome header  (empty transcript only)
  //                  − live status     (thinking / spinner / TurnDone)
  //                  − queued prompts  (marginTop 1 + N rows, only when queued)
  //                  − prompt meta     (spinner / transient message / queued)
  //                  − input box       (2 border + wrapped content)
  //                  − statusline      (reserved L1 + L2 + outer gap; total 3 rows)
  //
  // Every sibling outside the viewport must be accounted for here; otherwise
  // the total tree height exceeds the terminal and the input box gets pushed.
  const textEntryPrompt = providerPrompt || channelPrompt || hookPrompt || settingsPrompt;
  const hasTextEntryPrompt = !!textEntryPrompt;
  const hasFloatingPanel = !!(toolApproval || picker || contextPanel || usagePanel || slashPaletteOpen || hasTextEntryPrompt);
  const expandedOptionPanel = !!(toolApproval || picker || contextPanel || usagePanel || hasTextEntryPrompt);
  // Project selection (initial-entry experience) keeps the welcome banner
  // visible above the picker / path-entry prompt, unlike other floating panels.
  const projectSelectionActive = picker?.kind === 'project'
    || settingsPrompt?.kind === 'project-new'
    || settingsPrompt?.kind === 'project-create-confirm'
    || settingsPrompt?.kind === 'project-rename';
  // Slash search floats above the normal prompt. Actual option panels own the
  // prompt/status area, so they hide those rows and expand into that space.
  const inputBoxHidden = expandedOptionPanel;
  const showWelcomeBanner = (state.items.length === 0 && !hasFloatingPanel) || projectSelectionActive || onboardingActive;
  const WELCOME_ROWS = showWelcomeBanner ? 11 : 0;
  const liveSpinner = state.spinner?.active ? state.spinner : (state.commandStatus?.active ? state.commandStatus : null);
  const latestToast = state.toasts?.length ? state.toasts[state.toasts.length - 1] : null;
  const toastHint = latestToast ? latestToast.text : '';
  const inputHint = promptHint || toastHint;
  const inputHintTone = promptHint ? promptHintTone : (latestToast?.tone || 'info');
  const latestTranscriptItem = state.items[state.items.length - 1] || null;
  const latestDoneAtTail = latestTranscriptItem?.kind === 'turndone' || latestTranscriptItem?.kind === 'statusdone';
  // Bottom meta band ownership is LIVE-SPINNER ONLY. A finished turn's done row
  // (turndone/statusdone) is a normal transcript item and flows into scrollback
  // like anything else, so the area directly above the prompt is CLEAR when the
  // user is idle. Earlier this row was pinned in the meta band until the next
  // transcript item was appended (to dodge an autowrap overprint/bleed), which
  // left the completed status row stuck above the prompt while the user typed or
  // sat idle. That bleed is now fixed at the source by the tool-output width
  // clamp, so the pin is no longer needed. Kept as a named null const so the
  // downstream meta-band/hint logic collapses cleanly to the spinner-only path.
  const latestDoneItem = null;
  const SCROLL_HINT_ROWS = 0;
  const LIVE_STATUS_ROWS = 0;
  // The standalone prompt box is 2 border rows + the wrapped PromptInput body.
  // The one-row scroll baseline gap ABOVE the prompt is owned by
  // transcriptGuardRows, not the prompt box itself. That keeps the scroll
  // reference at "textbox + 1" while the prompt/statusline bottom stays fixed.
  //
  // This must track the prompt draft's REAL wrapped height. Reserving a constant
  // one-line prompt lets long/multiline input grow the bottom cluster after the
  // transcript viewport has already claimed those rows, which makes transcript
  // body text overprint the textbox or slash command window.
  const currentPromptLayoutRows = promptContentRows(promptLayoutValueRef.current, promptContentColumns);
  const promptInputRows = inputBoxHidden ? 0 : currentPromptLayoutRows;
  const promptBoxRows = inputBoxHidden ? 0 : 2 + promptInputRows;
  const STATUSLINE_ROWS = 3;
  // Shared panel chrome math. Every floating panel follows the same vertical
  // rhythm INSIDE its round border: title row, blank, description/hint row,
  // blank, then content. That is 4 non-content rows; the round border adds 2
  // more, so chrome reserves 6 rows total. Reserving the full chrome here (even
  // for panels that omit the description) guarantees the bordered title can
  // never be clipped off the top — content rows shrink first when the terminal
  // is short, because the floating container clips from the top (flex-end).
  const PANEL_MAX_VISIBLE = 8;
  const PANEL_CHROME_ROWS = 6;
  const PANEL_BASE_ROWS = PANEL_MAX_VISIBLE + PANEL_CHROME_ROWS;
  const PICKER_CHROME_ROWS = PANEL_CHROME_ROWS;
  // TextEntryPanel content is a single prompt line, so chrome + 1.
  const TEXT_ENTRY_ROWS = PANEL_CHROME_ROWS + 1;
  const OPTION_PANEL_EXTRA_ROWS = expandedOptionPanel ? 3 : 0;
  const queuedVisible = !hasFloatingPanel && !inputBoxHidden && state.queued?.length > 0;
  // While the slash palette is open it owns the area above the prompt, so the
  // live spinner/meta row is suppressed entirely — no reservation and no render.
  // Normalize the spinner → TurnDone handoff by making them occupy the SAME
  // two-row slot. Engine appends turndone/statusdone before clearing spinner, so
  // a transient frame can otherwise contain BOTH: transcript grows by two rows
  // while the bottom spinner still reserves two rows, making the viewport visibly
  // jump. As soon as the done row is the transcript tail, drop the spinner slot;
  // the new done row replaces that height in the same frame, with no ms timer.
  const promptMetaVisible = !inputBoxHidden && !slashPaletteOpen && !!liveSpinner && !latestDoneAtTail;
  const promptMetaRows = promptMetaVisible ? 2 : 0;
  // Toast/error text without a live spinner uses the existing transcript guard
  // row directly above the prompt. Do NOT reserve another row here: that made a
  // transient hint add a visible newline/prompt jump whenever no spinner was
  // active.
  const overlayHintRequested = !inputBoxHidden && !hasFloatingPanel && !liveSpinner && !!inputHint && !queuedVisible;
  const overlayHintRows = 0;
  // QueuedCommands renders one row per queued command, pinned above the prompt
  // box (no extra top-margin row).
  const queuedRows = queuedVisible ? state.queued.length : 0;
  const INPUT_BOX_ROWS = promptBoxRows + promptMetaRows + overlayHintRows;
  const baseReserve = WELCOME_ROWS + SCROLL_HINT_ROWS + LIVE_STATUS_ROWS + INPUT_BOX_ROWS + STATUSLINE_ROWS + queuedRows;
  const maxFloatingPanelRows = Math.max(0, resizeState.rows - baseReserve - 1);
  const desiredFloatingPanelRows = toolApproval
    ? PANEL_CHROME_ROWS + 2 + OPTION_PANEL_EXTRA_ROWS
    : picker
      ? (picker.fillAvailable ? maxFloatingPanelRows : PANEL_BASE_ROWS + OPTION_PANEL_EXTRA_ROWS)
      : contextPanel
      ? PANEL_BASE_ROWS + OPTION_PANEL_EXTRA_ROWS + 3
      : usagePanel
        ? PANEL_BASE_ROWS + OPTION_PANEL_EXTRA_ROWS
        : slashPaletteOpen
          ? PANEL_MAX_VISIBLE + PANEL_CHROME_ROWS
          : hasTextEntryPrompt
            ? TEXT_ENTRY_ROWS
            : 0;
  const floatingPanelRows = desiredFloatingPanelRows > 0
    ? Math.min(desiredFloatingPanelRows, maxFloatingPanelRows)
    : 0;
  // Give the list every content row the panel exposes. The panel already grew
  // by OPTION_PANEL_EXTRA_ROWS; previously that growth was subtracted back out
  // here, so the rows leaked into an empty flexGrow gap instead of the list.
  // Reserving only PICKER_CHROME_ROWS lets the list occupy the full interior
  // (the footer's own reservation is handled inside Picker).
  const pickerVisibleRows = picker
    ? Math.max(1, floatingPanelRows - PICKER_CHROME_ROWS)
    : PANEL_MAX_VISIBLE;
  const bottomReserve = baseReserve + floatingPanelRows;
  const viewportHeight = Math.max(1, resizeState.rows - bottomReserve);
  // Keep one physical row between the transcript clip and the bottom cluster
  // even when pinned to the live tail. Windows Terminal/conhost can still
  // surface one clipped/off-by-one transcript row below the statusline during
  // rapid tool-card updates; a permanent guard row makes that row blank instead
  // of a tool header/detail.
  const baseGuardRows = viewportHeight > 1 ? 1 : 0;
  // ── Scroll-time overprint guard ───────────────────────────────────────────
  // Wheel/manual scroll pushes the transcript column DOWN via a negative
  // marginBottom (see the viewport render). Under conhost/Windows Terminal the
  // incremental redraw can leave the row that slid past the clip edge painted
  // OVER the bottom cluster (input box / statusline) for a frame — the reported
  // "scrolled text shows on the statusline row" bug. One guard row is enough
  // while pinned to the live tail, but during an active scroll the slid row can
  // still bleed one line further, so widen the guard to TWO rows whenever the
  // viewport is genuinely scrolled up. The extra blank row absorbs the stray
  // paint instead of the statusline. Requires a viewport tall enough to spare
  // the row, and never shrinks below the base guard.
  const transcriptGuardRows = baseGuardRows;
  const transcriptContentHeight = Math.max(1, viewportHeight - transcriptGuardRows);
  // Bottom-follow / pin semantics must NOT widen with the scroll-time guard, or
  // the "pinned to tail" threshold would drift and streaming could freeze a row
  // above bottom. Keep the slack anchored to the BASE (single) guard: if a stale
  // pre-guard offset of 1 survives while no reading anchor is active, still treat
  // the viewport as pinned to the live tail so streaming/tool output continues
  // to auto-follow instead of freezing one row above bottom.
  const transcriptBottomSlackRows = Math.max(0, baseGuardRows);
  transcriptBottomSlackRowsRef.current = transcriptBottomSlackRows;
  transcriptViewportRef.current = {
    top: WELCOME_ROWS,
    bottom: Math.max(WELCOME_ROWS, WELCOME_ROWS + transcriptContentHeight - 1),
  };
  // [mixdog] Keep the live terminal row count current for the mouse handler's
  // region routing + status-band selection clip (see onData).
  frameRowsRef.current = Math.max(1, Number(resizeState.rows) || 24);
  // When the prompt box is hidden (floating panel / option panel owns the
  // bottom area), drop its stale measured rect so the mouse handler does not
  // route presses to a prompt box that is not on screen.
  if (inputBoxHidden) promptBoxRectRef.current = null;
  // Toast/error text has two mutually exclusive placements:
  // - while a live status row exists (thinking/compacting/responding), attach it
  //   to that row so the bottom cluster reserves exactly one status band;
  // - otherwise render it into the normal one-row gap above the prompt, replacing
  //   the blank spacer instead of reserving an extra row. This keeps late errors
  //   from pushing the prompt/statusline upward, and when thinking starts the
  //   hint moves into the live row on the same render instead of double-painting.
  // Transient hint placement while no spinner owns the band is resolved after
  // transcript windowing (see overlayHintOnLastItem / overlayHintFallbackRow).
  const spinnerHintWidth = inputHint
    ? Math.max(1, Math.min(Math.max(1, frameColumns - 4), Math.max(12, Math.floor(frameColumns * 0.42))))
    : 0;
  // When no live spinner owns a status band, the transient hint/error is drawn
  // into the existing transcript guard row directly above the prompt. Mirror the
  // spinner-row placement: a fixed-width right slot, not a full-width left box.
  const guardHintWidth = inputHint
    ? Math.max(1, Math.min(Math.max(1, frameColumns - 4), Math.max(12, Math.floor(frameColumns * 0.42))))
    : 0;
  const transientStatusWidth = liveSpinner ? spinnerHintWidth : guardHintWidth;
  const promptSpinnerColumns = liveSpinner && inputHint
    ? Math.max(1, frameColumns - spinnerHintWidth - 1)
    : frameColumns;
  const welcomePromptHintText = conditionalWelcomePromptHint || welcomePromptHintRef.current || '';
  const welcomePromptHintVisible = Boolean(
    welcomePromptHintText
    && !welcomePromptHintDismissed
    && state.items.length === 0
    && !hasFloatingPanel
    && !inputBoxHidden
    && !queuedVisible
    && !liveSpinner
    && !inputHint
  );
  // Key the heavy O(n) row-index + windowing memos on a STRUCTURE signature
  // instead of the `state.items` array identity. The engine swaps `state.items`
  // for a new array on every streaming flush (~8ms) while only the final
  // assistant item's text grows; depending on array identity re-ran both memos
  // each delta frame and visibly throttled the stream. The signature changes
  // only when transcript structure or the streaming item's estimated height
  // changes, so steady per-character growth keeps both memos warm.
  //
  // The signature itself is memoized on `state.items` identity (+columns/
  // expanded) so re-renders that DO NOT touch items — drag motion, scroll,
  // input typing — skip the O(n) signature walk entirely. During streaming the
  // engine hands us a fresh `state.items` array each flush, so this memo
  // recomputes and still tracks the streaming item's height correctly.
  const transcriptStructureSig = useMemo(
    () => transcriptStructureSignature(state.items, frameColumns, toolOutputExpanded),
    [state.items, frameColumns, toolOutputExpanded],
  );
  const transcriptRowIndex = useMemo(() => buildTranscriptRowIndex(state.items, {
    columns: frameColumns,
    toolOutputExpanded,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: sig captures the relevant item changes; measuredRowsVersion folds in app-level measured height corrections
  }), [transcriptStructureSig, measuredRowsVersion]);
  // ── Same-frame anchor lock ───────────────────────────────────────────────
  // While the user reads older transcript (anchor captured, not dirty), resolve
  // the scroll offset that keeps the anchored viewport-top row fixed for THIS
  // frame's prefix table — SYNCHRONOUSLY, before windowing/marginBottom use it.
  // Previously this correction lived only in the post-commit layout effect, so
  // the frame that grew the streaming tail rendered with the STALE offset first
  // (a blank band opened at the top) and only the NEXT frame snapped it shut.
  // Computing it here folds the new totalRows and the corrected offset into the
  // SAME render, so the completed line fills its space with no one-frame gap.
  // Falls back to the live scrollOffset state when there is no active anchor
  // (bottom-follow / pinned) or it cannot be aligned (anchor item gone).
  const hasReadingAnchor = !!transcriptAnchorRef.current && !transcriptAnchorDirtyRef.current;
  const scrolledUpRows = Math.max(0, Number(scrollTargetRef.current) || 0);
  // "Genuinely scrolled up" = the viewport is above the bottom slack band. The
  // bottom-follow / pinned path owns everything at-or-below the slack; anything
  // above it is the user reading older transcript.
  const scrolledUp = scrolledUpRows > transcriptBottomSlackRows;
  // A genuine reading anchor wins even if followingRef is stale-true while the
  // user is scrolled up. The follow-arm SHOULD have been cleared when the anchor
  // was captured, but if it lingers true we must not fall through to the stale-
  // offset render path (that is one half of the newline-jump bug). Keep the
  // plain !following gate for the anchor-less follow case.
  const anchorLockActive = hasReadingAnchor && !followingRef.current && scrolledUp;
  const targetNearBottom = followingRef.current || !scrolledUp;
  const nearBottomWithoutAnchor = !transcriptAnchorRef.current
    && !transcriptAnchorDirtyRef.current
    && targetNearBottom;
  let renderScrollOffset = targetNearBottom ? 0 : scrollOffset;
  const lockViewRows = Math.max(1, Number(transcriptContentHeight) || 1);
  const lockTotalRows = Math.max(0, Number(transcriptRowIndex?.totalRows) || 0);
  const lockMaxRows = Math.max(0, lockTotalRows - lockViewRows);
  const curPrefixForLock = transcriptRowIndex?.prefixRows || null;
  if (anchorLockActive) {
    const locked = resolveAnchorScrollOffset({
      anchor: transcriptAnchorRef.current,
      items: state.items,
      curPrefix: curPrefixForLock,
      totalRows: lockTotalRows,
      viewRows: lockViewRows,
      maxRows: lockMaxRows,
    });
    if (locked != null) renderScrollOffset = locked;
  } else if (!followingRef.current && !nearBottomWithoutAnchor && scrolledUp) {
    // ── Same-frame anchor CAPTURE for the missing/dirty-anchor case ─────────
    // The viewport is genuinely scrolled up but there is NO usable same-frame
    // anchor: it is missing, or dirtied by a manual scroll whose synchronous
    // capture failed, or a stale-true follow-arm already dropped it. Without an
    // anchor this frame would render with the STALE bottom-relative
    // scrollOffset, so any row growth THIS frame (a streaming newline
    // completing a line, a transcript row expanding) shifts the visible top by
    // the delta BEFORE the post-commit rowDelta effect can capture/correct — and
    // that effect would then capture from the ALREADY-shifted totalRows. That is
    // the confirmed one-frame jump/jitter.
    //
    // Fix it at render time: capture an anchor from the PREVIOUS published
    // geometry (transcriptGeomRef still holds the prior frame here — THIS
    // frame's geom is published a few lines below), identifying the item id +
    // row offset that sat at the previous visible-TOP edge, then resolve the
    // offset against the CURRENT prefix table with the same pure helper so that
    // exact top row stays put THIS frame. Persist the captured anchor so the
    // post-commit effect keeps the identical anchor stable instead of
    // re-deriving one from the already-shifted totalRows.
    const geom = transcriptGeomRef.current || {};
    const prevPrefix = geom.prefixRows;
    if (Array.isArray(prevPrefix) && prevPrefix.length > 1) {
      const prevTotal = Math.max(0, Number(geom.totalRows) || 0);
      const prevView = Math.max(1, Number(geom.viewRows) || 1);
      const prevOffset = Math.max(0, Number(geom.renderOffset) || 0);
      const prevItems = geom.items || [];
      // Bottom-relative window math (same as transcriptRenderWindow): the top
      // edge sits `offset + viewRows` rows up from the previous total.
      const prevTopRow = Math.max(0, Math.min(prevTotal, prevTotal - prevOffset - prevView));
      let idx = upperBound(prevPrefix, prevTopRow) - 1;
      if (idx < 0) idx = 0;
      if (idx > prevPrefix.length - 2) idx = prevPrefix.length - 2;
      const anchorItem = prevItems[idx];
      if (anchorItem && anchorItem.id != null) {
        const captured = { id: anchorItem.id, offset: Math.max(0, prevTopRow - (prevPrefix[idx] || 0)) };
        const locked = resolveAnchorScrollOffset({
          anchor: captured,
          items: state.items,
          curPrefix: curPrefixForLock,
          totalRows: lockTotalRows,
          viewRows: lockViewRows,
          maxRows: lockMaxRows,
        });
        if (locked != null) {
          renderScrollOffset = locked;
          transcriptAnchorRef.current = captured;
          transcriptAnchorDirtyRef.current = false;
        }
      }
    }
  }
  const transcriptWindow = useMemo(() => transcriptRenderWindow(state.items, {
    scrollOffset: renderScrollOffset,
    viewportHeight: transcriptContentHeight,
    columns: frameColumns,
    toolOutputExpanded,
    rowIndex: transcriptRowIndex,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: sig+scroll/viewport capture the relevant changes
  }), [transcriptStructureSig, renderScrollOffset, transcriptContentHeight, transcriptRowIndex]);
  maxScrollRowsRef.current = transcriptWindow.maxScrollRows;
  // Publish this frame's geometry so a manual scroll can capture the reading
  // anchor synchronously (see captureTranscriptAnchorAt).
  transcriptGeomRef.current = {
    prefixRows: transcriptRowIndex?.prefixRows || null,
    totalRows: Math.max(0, Number(transcriptWindow.totalRows) || 0),
    viewRows: Math.max(1, Number(transcriptContentHeight) || 1),
    items: state.items || null,
    // The offset THIS frame actually rendered with. The same-frame anchor
    // CAPTURE for a missing/dirty anchor (above) reads this from the PREVIOUS
    // frame to reconstruct the exact top-edge row that was on screen, so the
    // capture matches what the user saw rather than the stale scrollOffset
    // state. Bottom-relative, matching transcriptRenderWindow's window math.
    renderOffset: Math.max(0, Number(renderScrollOffset) || 0),
  };
  // The window memo is keyed on a structure signature that intentionally
  // ignores per-character growth of the streaming assistant text, so its
  // `items` slice can hold a STALE reference to the streaming item between
  // height changes. Re-slice the live `state.items` over the memo's stable
  // [startIndex, endIndex) bounds so the on-screen text is always current
  // while the expensive indexing/windowing stays warm.
  const transcriptVisibleItems = (state.items || []).slice(
    transcriptWindow.startIndex,
    transcriptWindow.endIndex,
  );
  // The bottom meta band is spinner-only, so nothing is pulled out of the
  // transcript for it. A finished turn's done row (turndone/statusdone) renders
  // inline in scrollback like any other item — no filtering, no double-paint.
  const renderedTranscriptItems = transcriptVisibleItems;
  let overlayHintAttachItemIndex = -1;
  for (let i = renderedTranscriptItems.length - 1; i >= 0; i--) {
    const item = renderedTranscriptItems[i];
    if (item?.kind === 'tool' && shouldSuppressFullyFailedToolItem(item)) continue;
    overlayHintAttachItemIndex = i;
    break;
  }
  const transcriptTailPinned = Math.max(0, Number(transcriptWindow.effectiveScrollOffset) || 0) <= transcriptBottomSlackRows;
  const overlayHintOnLastItem = overlayHintRequested
    && floatingPanelRows <= 0
    && transcriptWindow.bottomSpacerRows === 0
    && transcriptTailPinned
    && overlayHintAttachItemIndex >= 0;
  const overlayHintFallbackRow = overlayHintRequested
    && floatingPanelRows <= 0
    && transcriptGuardRows > 0
    && !overlayHintOnLastItem;
  // ── App-level measured height harvest (ScrollBox/useVirtualScroll-inspired) ─
  // Runs after EVERY commit (no deps): Yoga has just laid out the mounted rows,
  // so each tracked item Box's getComputedHeight() is its REAL terminal height.
  // Fold those into transcriptMeasuredRowsCache (validated on the same variant
  // key the estimate caches use) and bump measuredRowsVersion only when a height
  // actually changed — that re-runs the row-index/window memos against corrected
  // heights, then the harvest finds nothing new and the loop settles (one frame,
  // overscan-absorbed). Streaming
  // assistant rows are skipped: their height churns every flush and the bottom-
  // follow path already keeps them visually stable.
  useLayoutEffect(() => {
    if (!TRANSCRIPT_MEASURED_ROWS) return;
    // Skip the per-row Yoga harvest while a drag is in progress. Edge auto-
    // scroll commits setScrollOffset on every pointer motion, but the mounted
    // rows' real heights do not change during a drag — only their scroll
    // position does. Re-measuring every motion ran this O(mounted) loop (plus a
    // variantKey check per row) for no height change, which is pure drag
    // overhead on a tall transcript. The cached measurements stay authoritative
    // for the row-index math; a single re-measure is forced on release below.
    if (dragRef.current.active) return;
    const els = transcriptItemElsRef.current;
    if (!els || els.size === 0) return;
    const liveItems = transcriptMeasureItemsRef.current;
    const toolExpandedFlag = toolOutputExpanded ? 1 : 0;
    let changed = false;
    for (const [key, el] of els.entries()) {
      const item = liveItems.get(key);
      const yoga = el?.yogaNode;
      if (!item || !yoga) continue;
      if (shouldSuppressFullyFailedToolItem(item)) {
        if (transcriptMeasuredRowsCache.delete(item)) changed = true;
        continue;
      }
      if (item.kind === 'assistant' && item.streaming) continue;
      // Width 0 = Yoga has not laid this node out yet this frame; skip so a
      // transient 0 never poisons the cache (mirrors useVirtualScroll's
      // getComputedWidth()>0 guard).
      if (typeof yoga.getComputedWidth === 'function' && yoga.getComputedWidth() <= 0) continue;
      const rawMeasured = Math.round(Number(yoga.getComputedHeight?.()) || 0);
      if (rawMeasured <= 0) {
        if (transcriptMeasuredRowsCache.delete(item)) changed = true;
        continue;
      }
      const measured = Math.max(1, rawMeasured);
      const variantKey = transcriptItemVariantKey(item);
      const prev = transcriptMeasuredRowsCache.get(item);
      if (prev
        && prev.rows === measured
        && prev.columns === frameColumns
        && prev.toolExpanded === toolExpandedFlag
        && prev.variantKey === variantKey) {
        continue;
      }
      transcriptMeasuredRowsCache.set(item, {
        rows: measured,
        columns: frameColumns,
        toolExpanded: toolExpandedFlag,
        variantKey,
      });
      changed = true;
    }
    if (changed) setMeasuredRowsVersion((v) => (v + 1) % 1000000);
    // Prune the id→item / id→callback maps to the currently-mounted set so they
    // do not grow unbounded over a long session. `els` is the live mounted set
    // (ref(null) deletes on unmount), so anything not in it is gone.
    if (liveItems.size > els.size) {
      for (const key of liveItems.keys()) {
        if (!els.has(key)) liveItems.delete(key);
      }
    }
    const refCache = transcriptMeasureRefCache.current;
    if (refCache.size > els.size) {
      for (const key of refCache.keys()) {
        if (!els.has(key)) refCache.delete(key);
      }
    }
  });
  useLayoutEffect(() => {
    const totalRows = Math.max(0, Number(transcriptWindow.totalRows) || 0);
    const previousTotalRows = Math.max(0, Number(transcriptTotalRowsRef.current) || 0);
    transcriptTotalRowsRef.current = totalRows;
    const rowDelta = totalRows - previousTotalRows;
    const curPrefix = transcriptRowIndex?.prefixRows || null;
    if (previousTotalRows <= 0 || dragRef.current.active) return;

    const currentTarget = Math.max(0, Number(scrollTargetRef.current) || 0);
    const currentPosition = Math.max(0, Number(scrollPositionRef.current) || 0);
    const currentOffset = Math.max(0, Number(scrollOffset) || 0);
    const maxRows = Math.max(0, Number(transcriptWindow.maxScrollRows) || 0);
    const nearBottom = followingRef.current || currentTarget <= transcriptBottomSlackRows;
    const pinnedToBottom = nearBottom;
    // A genuine reading anchor must win over ordinary stream growth, but an
    // explicit follow arm (prompt submit / pinned bottom) must win over stale
    // anchor state. Manual scroll cancels followingRef before anchor capture, so
    // deliberate reading still stays anchored while automatic bottom-follow
    // stays armed across spinner/tool/stream height corrections.
    const activeReadingAnchor = !!transcriptAnchorRef.current
      && !transcriptAnchorDirtyRef.current
      && !followingRef.current
      && !nearBottom;
    const followOnGrowth = followingRef.current && rowDelta > 0 && !activeReadingAnchor;
    const shouldFollowBottom = rowDelta > 0 && (followOnGrowth || pinnedToBottom);
    if (shouldFollowBottom) {
      // Bottom follow: while pinned to the newest output,
      // do NOT animate row growth. The viewport is already bottom-aligned by
      // justifyContent:flex-end; injecting a temporary positive scroll offset
      // during streaming makes the transcript jump down/up and can clip the
      // currently generated assistant text. Keep all scroll refs at zero so
      // character generation stays visually stable.
      stopSmoothScroll();
      scrollTargetRef.current = 0;
      scrollPositionRef.current = 0;
      transcriptAnchorRef.current = null;
      transcriptAnchorDirtyRef.current = false;
      if (currentOffset !== 0) setScrollOffset(0);
      return;
    }

    // Viewport-only changes, such as swapping TextEntryPanel for a picker, must
    // not turn a bottom-pinned transcript into a reading-anchor lock.
    if (rowDelta <= 0 && nearBottom) {
      stopSmoothScroll();
      scrollTargetRef.current = 0;
      scrollPositionRef.current = 0;
      transcriptAnchorRef.current = null;
      transcriptAnchorDirtyRef.current = false;
      if (currentOffset !== 0) setScrollOffset(0);
      return;
    }

    // ── ABSOLUTE ANCHOR LOCK ──────────────────────────────────────────────
    // User is reading older transcript. Instead of folding the per-frame row
    // DELTA into scrollOffset (which accumulated streaming-tail estimate jitter
    // and could fall back to the whole-total delta on a misalignment — the
    // "newline makes the screen jump" bug), we pin an ABSOLUTE anchor: the item
    // id + row offset sitting at the viewport TOP edge. Every commit we look that
    // item up in the CURRENT prefix table and re-derive scrollOffset so the
    // anchored row stays at the same screen position. Any height change BELOW the
    // anchor (streaming tail growth, a result landing under the reading position)
    // only moves the bottom — the top is rock-stable. Changes ABOVE the anchor
    // move the item's prefix start and are absorbed the same way. No deltas, no
    // fallback, no drift.
    const viewRows = Math.max(1, Number(transcriptContentHeight) || 1);
    const items = state.items || [];
    let anchor = transcriptAnchorRef.current;
    // (Re)capture the anchor from the current viewport-top edge when missing or
    // invalidated by a manual scroll. anchorRow = absolute row at the top edge.
    if (!followingRef.current && (!anchor || transcriptAnchorDirtyRef.current)) {
      if (curPrefix && curPrefix.length > 1) {
        const anchorRow = Math.max(0, Math.min(totalRows, totalRows - currentTarget - viewRows));
        let idx = upperBound(curPrefix, anchorRow) - 1;
        if (idx < 0) idx = 0;
        if (idx > items.length - 1) idx = items.length - 1;
        const anchorItem = items[idx];
        if (anchorItem && anchorItem.id != null) {
          anchor = { id: anchorItem.id, offset: Math.max(0, anchorRow - (curPrefix[idx] || 0)) };
          transcriptAnchorRef.current = anchor;
        }
      }
      transcriptAnchorDirtyRef.current = false;
      // Just captured at the current offset; nothing to correct this frame.
      return;
    }
    // Resolve the anchored item's CURRENT position with the SAME pure helper the
    // render path uses, so the post-commit state sync can never disagree with the
    // synchronous render correction (which already fixed the screen this frame).
    const desired = resolveAnchorScrollOffset({
      anchor,
      items,
      curPrefix,
      totalRows,
      viewRows,
      maxRows,
    });
    if (desired == null) {
      // Anchor item gone (rare: removal/compaction). Re-capture next frame.
      transcriptAnchorDirtyRef.current = true;
      return;
    }
    const appliedDelta = desired - currentTarget;
    if (appliedDelta === 0) return;

    stopSmoothScroll();
    scrollTargetRef.current = desired;
    scrollPositionRef.current = Math.max(0, Math.min(maxRows, currentPosition + appliedDelta));
    preservedScrollDeltaRef.current += appliedDelta;
    setScrollOffset(Math.max(0, Math.round(desired)));
  }, [transcriptWindow.totalRows, transcriptWindow.maxScrollRows, transcriptRowIndex, transcriptContentHeight, transcriptBottomSlackRows, scrollOffset, stopSmoothScroll]);
  useLayoutEffect(() => {
    if (transcriptBottomSlackRows <= 0) return;
    if (transcriptAnchorRef.current || transcriptAnchorDirtyRef.current || followingRef.current) return;
    const currentTarget = Math.max(0, Number(scrollTargetRef.current) || 0);
    const currentPosition = Math.max(0, Number(scrollPositionRef.current) || 0);
    const currentOffset = Math.max(0, Number(scrollOffset) || 0);
    if (Math.max(currentTarget, currentPosition, currentOffset) === 0) return;
    if (Math.max(currentTarget, currentPosition, currentOffset) > transcriptBottomSlackRows) return;
    stopSmoothScroll();
    scrollTargetRef.current = 0;
    scrollPositionRef.current = 0;
    setScrollOffset(0);
  }, [transcriptBottomSlackRows, scrollOffset, stopSmoothScroll]);
  useLayoutEffect(() => {
    const top = Math.max(0, Number(transcriptViewportRef.current?.top) || 0);
    const next = {
      top,
      height: Math.max(1, Number(transcriptContentHeight) || 1),
      totalRows: Math.max(0, Number(transcriptWindow.totalRows) || 0),
      scrollOffset: Math.max(0, Number(transcriptWindow.effectiveScrollOffset) || 0),
    };
    const preservedDelta = Number(preservedScrollDeltaRef.current) || 0;
    if (preservedDelta !== 0) {
      next.scrollOffset = Math.max(0, next.scrollOffset + preservedDelta);
      preservedScrollDeltaRef.current = 0;
    }
    const previous = selectionLayoutRef.current;
    selectionLayoutRef.current = next;
    if (!previous || !dragRef.current.rect || dragRef.current.active) return;
    const deltaY = (next.top - previous.top)
      + (next.height - previous.height)
      - (next.totalRows - previous.totalRows)
      + (next.scrollOffset - previous.scrollOffset);
    if (deltaY === 0) return;
    const clippedRect = withSelectionClip(shiftSelectionRectY(dragRef.current.rect, deltaY));
    dragRef.current = { ...dragRef.current, rect: clippedRect };
    paintSelectionRect(clippedRect, { rememberText: true, immediate: true });
  }, [transcriptContentHeight, transcriptWindow.totalRows, transcriptWindow.effectiveScrollOffset, withSelectionClip, paintSelectionRect]);
  useEffect(() => {
    if (!dragRef.current.rect) return;
    const clippedRect = withSelectionClip(dragRef.current.rect);
    dragRef.current = { ...dragRef.current, rect: clippedRect };
    paintSelectionRect(clippedRect, { rememberText: true, immediate: true });
  }, [state.themeEpoch, withSelectionClip, paintSelectionRect]);
  useEffect(() => {
    const maxRows = Math.max(0, Number(transcriptWindow.maxScrollRows) || 0);
    if (scrollTargetRef.current <= maxRows && scrollPositionRef.current <= maxRows && scrollOffset <= maxRows) return;
    stopSmoothScroll();
    const next = Math.max(0, Math.min(maxRows, scrollTargetRef.current));
    scrollTargetRef.current = next;
    scrollPositionRef.current = next;
    setScrollOffset(Math.round(next));
  }, [transcriptWindow.maxScrollRows, scrollOffset, stopSmoothScroll]);
  const cycleWorkflowFromPrompt = useCallback(() => {
    if (slashPaletteOpen || toolApproval || picker || settingsPrompt || providerPrompt || channelPrompt || hookPrompt || contextPanel || usagePanel) return true;
    let workflows = [];
    try {
      workflows = store.listWorkflows?.() || [];
    } catch (e) {
      store.pushNotice(`could not list workflows: ${e?.message || e}`, 'error');
      return true;
    }
    if (!workflows.length) {
      store.pushNotice('no workflows available', 'warn');
      return true;
    }
    const workflow = state.workflow || {};
    if (workflows.length < 2) {
      store.pushNotice(`Workflow: ${workflowDisplayName(workflows[0] || workflow)}`, 'info');
      return true;
    }
    const activeIndex = workflows.findIndex((item) => item.active);
    const currentIndex = activeIndex >= 0 ? activeIndex : Math.max(0, workflows.findIndex((item) => item.id === workflow.id));
    const next = workflows[(currentIndex + 1 + workflows.length) % workflows.length];
    void store.setWorkflow?.(next.id)
      .then((result) => {
        if (!result) {
          store.pushNotice('Workflow switch is already running.', 'warn');
          return;
        }
        store.pushNotice(workflowSwitchNotice(result), 'info');
      })
      .catch((e) => store.pushNotice(`Couldn’t switch workflow: ${e?.message || e}`, 'error'));
    return true;
  }, [slashPaletteOpen, toolApproval, picker, settingsPrompt, providerPrompt, channelPrompt, hookPrompt, contextPanel, usagePanel, state.workflow, store]);
  // The hardware/IME caret is parked by PromptInput from its OWN measured box
  // position (ink useCursor + useBoxMetrics) — correct now that the transcript
  // is a live column, so the live-frame line count ink relies on is accurate.
  const promptInputControl = (
    <PromptInput
      onSubmit={onSubmit}
      disabled={exiting || !!picker || !!toolApproval || !tuiReady}
      onDraftChange={onPromptDraftChange}
      interruptActive={state.busy}
      onInterrupt={handlePromptInterrupt}
      initialValue={promptDraft}
      draftOverride={promptDraftOverride}
      valueRef={promptValueRef}
      selectionRef={promptSelectionRef}
      boxRectRef={promptBoxRectRef}
      mouseSelectionRef={promptMouseSelectionRef}
      suppressShiftNavRef={gridSelectionActiveRef}
      hint=""
      hintTone={inputHintTone}
      mask={false}
      onEscape={handlePromptEscape}
      onTab={cycleWorkflowFromPrompt}
      onPasteText={handlePromptPaste}
      onHistoryNavigate={handlePromptHistoryNavigate}
      onVoiceToggle={handleVoiceToggle}
      commandPaletteActive={slashPaletteOpen}
      onCommandPaletteNavigate={(direction) => {
        setSlashIndex((index) => {
          const total = slashCommands.length;
          if (total === 0) return 0;
          if (direction === 'home') return 0;
          if (direction === 'end') return total - 1;
          const step = direction === 'left'
            ? -1
            : direction === 'right'
              ? 1
              : Number(direction) || 0;
          if (step === 1 || step === -1) return (index + step + total) % total;
          return Math.max(0, Math.min(total - 1, index + step));
        });
      }}
      onCommandPaletteAccept={acceptSlashPalette}
      onCommandPaletteCancel={cancelSlashPalette}
      onCommandPaletteComplete={completeSlashPalette}
      onRestoreQueued={(currentText) => restoreQueuedToPrompt({ restoreDraft: true, showHint: false, currentText })}
    />
  );

  return (
    // Fullscreen layout: a full-height column (height = terminal rows) pins the
    // input cluster + statusline to the physical bottom (flexShrink={0}), while
    // the transcript fills the space above and is bottom-aligned so messages
    // stack up from just over the input. A top flexGrow spacer sinks the whole
    // stack to the bottom; the transcript itself is a fixed-height clipping
    // viewport (see viewportHeight above).
    <Box flexDirection="column" width={frameColumns} height={resizeState.rows} backgroundColor={surfaceBackground()}>
      {/* Empty-transcript header stays outside the bottom-anchored viewport and
          has its own reserved rows, so it cannot steal space from the input. */}
      {showWelcomeBanner ? (
        <Box flexDirection="column" height={7} flexShrink={0} marginTop={3} marginBottom={1} backgroundColor={surfaceBackground()}>
          <Text color={theme.text} bold>{centerLine('███╗   ███╗██╗██╗  ██╗██████╗  ██████╗  ██████╗ ', frameColumns)}</Text>
          <Text color={theme.text} bold>{centerLine('████╗ ████║██║╚██╗██╔╝██╔══██╗██╔═══██╗██╔════╝ ', frameColumns)}</Text>
          <Text color={theme.logo ?? theme.claude} bold>{centerLine('██╔████╔██║██║ ╚███╔╝ ██║  ██║██║   ██║██║  ███╗', frameColumns)}</Text>
          <Text color={theme.logo ?? theme.claude} bold>{centerLine('██║╚██╔╝██║██║ ██╔██╗ ██║  ██║██║   ██║██║   ██║', frameColumns)}</Text>
          <Text color={theme.logo ?? theme.claude} bold>{centerLine('██║ ╚═╝ ██║██║██╔╝ ██╗██████╔╝╚██████╔╝╚██████╔╝', frameColumns)}</Text>
          <Box height={1} flexShrink={0} />
          <Text color={theme.inactive}>{centerLine(`mixdog coding agent · ${state.cwd}`, frameColumns, 4)}</Text>
        </Box>
      ) : null}

      {/* Transcript viewport — a BOUNDED, fixed-height clipping box. The explicit
          numeric height + overflow:hidden is what lets ink actually slice the
          off-screen rows (output.clip in render-node-to-output.js), so older
          rows can never overprint newer ones. justifyContent flex-end keeps the
          newest content pinned to the bottom edge; older content overflows the
          TOP and is clipped. flexShrink lets it yield rows to the live status /
          a multi-line input rather than overflow the screen. */}
      <Box
        flexDirection="column"
        width="100%"
        height={viewportHeight}
        flexGrow={0}
        flexShrink={1}
        overflow="hidden"
        justifyContent="flex-end"
      >
        <Box
          flexDirection="column"
          width="100%"
          height={transcriptContentHeight}
          flexShrink={0}
          overflow="hidden"
          justifyContent="flex-end"
        >
        {/* Wheel scroll: with the viewport bottom-anchored (flex-end), a NEGATIVE
            marginBottom pushes the transcript column DOWN past the bottom edge,
            bringing older content above the window into view (overflow hidden
            clips the newest rows that slide below). 0 = newest content pinned to
            the bottom. (marginTop has no effect under flex-end — the bottom edge
            stays fixed — so the scroll axis here is marginBottom, not marginTop.)
            scrollOffset is clamped ≥ 0 by the wheel handler; a new turn snaps it
            back to 0. */}
        <Box flexDirection="column" width="100%" flexShrink={0} marginBottom={-transcriptWindow.effectiveScrollOffset}>
           {/*
             * Transcript windowing: render only the rows around the viewport rather
             * than the full state.items list. A cheap bottom spacer preserves the
             * same scroll coordinate when the visible window is in older history;
             * items above the window are off-screen and omitted entirely.
             * MAX cap: TRANSCRIPT_WINDOW_MAX_ITEMS items (env MIXDOG_TUI_TRANSCRIPT_WINDOW_ITEMS).
             * OVERSCAN: TRANSCRIPT_WINDOW_OVERSCAN_ROWS extra rows above the viewport so
             * fast wheel scrolls don't show a blank gap before re-render.
             */}
           {renderedTranscriptItems.map((item, i, arr) => {
             const measureRef = transcriptMeasureRef(item);
             const attachOverlayHint = overlayHintOnLastItem && i === overlayHintAttachItemIndex;
             const itemNode = (
               <Item
                 item={item}
                 prevKind={i > 0 ? arr[i - 1].kind : state.items[transcriptWindow.startIndex - 1]?.kind ?? null}
                 columns={frameColumns}
                 toolOutputExpanded={toolOutputExpanded}
                 rightMessage={attachOverlayHint ? inputHint : ''}
                 rightTone={attachOverlayHint ? inputHintTone : 'info'}
                 rightMessageWidth={attachOverlayHint ? (guardHintWidth || transientStatusWidth || 24) : 24}
                 themeEpoch={state.themeEpoch || 0}
               />
             );
             // When measured-rows is on, wrap each row in a zero-cost flex column
             // whose ref exposes the row's REAL Yoga height to the harvest effect.
             // The wrapper adds no rows of its own (it shrink-wraps the child) and
             // is omitted entirely when the feature is disabled so the default
             // render tree is byte-for-byte unchanged on the off path.
             return measureRef ? (
               <Box key={item.id} ref={measureRef} flexDirection="column" flexShrink={0}>
                 {itemNode}
               </Box>
             ) : (
               <React.Fragment key={item.id}>{itemNode}</React.Fragment>
             );
           })}
           {transcriptWindow.bottomSpacerRows > 0 ? (
             <Box height={transcriptWindow.bottomSpacerRows} flexShrink={0} />
           ) : null}
        </Box>
        {welcomePromptHintVisible ? (
          <Box height={1} flexShrink={0} width="100%" overflow="hidden">
            <Text color={theme.inactive} wrap="truncate">{centerLine(welcomePromptHintText, frameColumns, 2)}</Text>
          </Box>
        ) : null}
        </Box>
        {transcriptGuardRows > 0 ? (
          <Box height={transcriptGuardRows} flexShrink={0} backgroundColor={surfaceBackground()} flexDirection="row" width="100%" overflow="hidden">
            <Box flexGrow={1} flexShrink={1} overflow="hidden" />
            {overlayHintFallbackRow ? (
              <Box flexShrink={0} width={guardHintWidth || 1} marginLeft={1} marginRight={1} justifyContent="flex-end" overflow="hidden">
                <Text color={promptStatusColor(inputHintTone)} wrap="truncate">{inputHint}</Text>
              </Box>
            ) : null}
          </Box>
        ) : null}
      </Box>

      {/* Live reasoning and transient status live just above the prompt: reasoning
          on the left, short-lived copy/error/info messages on the right. */}

      {/* Bottom bar — pinned to the physical bottom, never moves. Floating
          panels use their actual rendered height and shrink before the prompt
          can move; overflow is clipped from the top while the panel remains
          bottom-aligned against the prompt. */}
      <Box flexDirection="column" flexShrink={0} width="100%" backgroundColor={surfaceBackground()}>
        {floatingPanelRows > 0 ? (
          <Box flexDirection="column" flexShrink={0} height={floatingPanelRows} overflow="hidden" justifyContent="flex-end" backgroundColor={surfaceBackground()}>
            {toolApproval ? (
              <Picker
                items={[
                  { value: 'deny', label: 'Deny', marker: '×', markerColor: theme.error, description: 'block this tool call' },
                  { value: 'approve', label: 'Approve once', marker: '✓', markerColor: theme.success, description: 'run this tool call' },
                ]}
                onSelect={(value) => {
                  store.resolveToolApproval?.(toolApproval.id, {
                    approved: value === 'approve',
                    reason: value === 'approve' ? 'approved by user' : 'denied by user',
                  });
                }}
                onCancel={() => {
                  store.resolveToolApproval?.(toolApproval.id, { approved: false, reason: 'denied by user' });
                }}
                onKey={(input) => {
                  const value = String(input || '').trim().toLowerCase();
                  if (value === 'a' || value === 'y') {
                    store.resolveToolApproval?.(toolApproval.id, { approved: true, reason: 'approved by user' });
                  } else if (value === 'd' || value === 'n') {
                    store.resolveToolApproval?.(toolApproval.id, { approved: false, reason: 'denied by user' });
                  }
                }}
                title="Tool approval"
                description={toolApprovalDescription(toolApproval)}
                help="↑/↓ Select · Enter Choose · a/y Approve · d/n/Esc Deny"
                columns={frameColumns}
                labelWidth={18}
                initialIndex={0}
                indexMode="never"
                visibleCount={2}
                fillHeight={expandedOptionPanel}
              />
            ) : picker ? (
              <Picker
                key={picker.pickerKey}
                items={picker.items}
                onSelect={(value, item) => {
                  pickerOpenedFromEnterRef.current = true;
                  if (pickerOpenedFromEnterTimerRef.current) {
                    clearTimeout(pickerOpenedFromEnterTimerRef.current);
                    pickerOpenedFromEnterTimerRef.current = null;
                  }
                  try {
                    if (picker.onSelect) picker.onSelect(value, item);
                  } finally {
                    pickerOpenedFromEnterTimerRef.current = setTimeout(() => {
                      pickerOpenedFromEnterRef.current = false;
                      pickerOpenedFromEnterTimerRef.current = null;
                    }, 3000);
                  }
                }}
                onCancel={() => {
                  if (picker.onCancel) picker.onCancel();
                  else {
                    setPicker(null);
                    clearPromptHint();
                  }
                }}
                onLeft={picker.onLeft}
                onRight={picker.onRight}
                onTab={picker.onTab}
                onKey={picker.onKey}
                onHighlight={picker.onHighlight}
                title={picker.title}
                description={picker.description}
                footer={picker.footer}
                footerGapRows={picker.footerGapRows}
                help={picker.help}
                columns={frameColumns}
                labelWidth={picker.labelWidth}
                metaWidth={picker.metaWidth}
                initialIndex={picker.initialIndex}
                indexMode={picker.indexMode}
                visibleCount={pickerVisibleRows}
                fillHeight={expandedOptionPanel}
                themeEpoch={state.themeEpoch || 0}
                confirmBar={picker.confirmBar}
              />
            ) : contextPanel ? (
              <ContextPanel
                rows={contextPanel.rows}
                title={contextPanel.title}
                detail={contextPanel.detail}
                columns={frameColumns}
                fillHeight={expandedOptionPanel}
              />
            ) : usagePanel ? (
              <UsagePanel
                dashboard={usagePanel}
                columns={frameColumns}
                fillHeight={expandedOptionPanel}
                panelRows={floatingPanelRows}
              />
            ) : slashPaletteOpen ? (
              <SlashCommandPalette
                commands={slashCommands}
                selectedIndex={slashIndex}
                title="Commands"
                columns={frameColumns}
                query={activeSlashQuery}
              />
            ) : providerPrompt ? (
              <TextEntryPanel
                title={providerPrompt.kind === 'api-key'
                  ? `${providerPrompt.mode === 'replace' ? 'Replace' : 'Set'} API key · ${providerPrompt.label}`
                  : providerPrompt.kind === 'oauth-code'
                    ? providerPrompt.label
                    : providerPrompt.kind === 'openai-usage-session'
                      ? 'OpenAI Usage · Session Key'
                    : providerPrompt.kind === 'opencode-go-cookie'
                      ? 'OpenCode Go Usage · Auth Cookie'
                      : `Base URL · ${providerPrompt.label}`}
                hint={providerPrompt.kind === 'api-key'
                  ? [
                    providerPrompt.envName ? `Env: ${providerPrompt.envName}` : '',
                    providerPrompt.source ? `Current: ${providerPrompt.source}` : '',
                    'Stored in the OS keychain.',
                  ].filter(Boolean).join(' · ')
                  : providerPrompt.kind === 'oauth-code'
                    ? (providerPrompt.hint || 'Paste the browser code.')
                    : providerPrompt.kind === 'openai-usage-session'
                      ? 'Paste an OpenAI dashboard/session key for the undocumented credit lookup. It is stored in the OS keychain.'
                    : providerPrompt.kind === 'opencode-go-cookie'
                      ? 'Paste the OpenCode web auth cookie value. It is stored in the OS keychain.'
                      : `Default: ${providerPrompt.defaultURL}`}
                mask={providerPrompt.kind === 'api-key' || providerPrompt.kind === 'opencode-go-cookie' || providerPrompt.kind === 'openai-usage-session'}
                columns={frameColumns}
                actionLabel={providerPrompt.kind === 'oauth-code' ? 'continue' : 'save'}
                promptLabel={providerPrompt.kind === 'api-key'
                  ? 'API key > '
                  : providerPrompt.kind === 'oauth-code'
                    ? 'Paste code here if prompted > '
                    : providerPrompt.kind === 'openai-usage-session'
                      ? 'Session key > '
                    : providerPrompt.kind === 'opencode-go-cookie'
                      ? 'Auth cookie > '
                      : 'Base URL > '}
                onSubmit={onSubmit}
                onCancel={cancelProviderPrompt}
              />
            ) : channelPrompt ? (
              <TextEntryPanel
                title={channelPrompt.label}
                hint={channelPrompt.hint || 'Save channel setting.'}
                mask={channelPrompt.kind === 'discord-token' || channelPrompt.kind === 'telegram-token' || channelPrompt.kind === 'webhook-token'}
                columns={frameColumns}
                promptLabel="Value > "
                onSubmit={onSubmit}
                onCancel={cancelChannelPrompt}
              />
            ) : hookPrompt ? (
              <TextEntryPanel
                title={hookPrompt.label}
                hint={hookPrompt.hint || 'Save hook setting.'}
                columns={frameColumns}
                promptLabel="Value > "
                onSubmit={onSubmit}
                onCancel={cancelHookPrompt}
              />
            ) : settingsPrompt ? (
              <TextEntryPanel
                title={settingsPrompt.label}
                hint={settingsPrompt.hint || 'Save setting.'}
                columns={frameColumns}
                initialValue={settingsPrompt.initialValue || ''}
                actionLabel={settingsPrompt.kind === 'skill-use'
                  ? 'run'
                  : settingsPrompt.kind === 'project-new'
                    ? 'open'
                    : settingsPrompt.kind === 'project-create-confirm'
                      ? 'confirm'
                      : settingsPrompt.kind === 'project-rename'
                        ? 'rename'
                        : 'save'}
                promptLabel={settingsPrompt.kind === 'skill-use'
                  ? 'Command > '
                  : settingsPrompt.kind === 'project-new'
                    ? 'Path > '
                    : settingsPrompt.kind === 'project-create-confirm'
                      ? 'Create? (y/n) > '
                      : settingsPrompt.kind === 'project-rename'
                        ? 'Name > '
                        : 'Value > '}
                onSubmit={onSubmit}
                onCancel={cancelSettingsPrompt}
              />
            ) : null}
          </Box>
        ) : null}
        {!inputBoxHidden ? (
          <>
          {promptMetaVisible ? (
            <>
              <Box
                marginTop={0}
                marginBottom={0}
                height={1}
                width="100%"
                flexDirection="row"
                backgroundColor={surfaceBackground()}
              >
                <Box flexGrow={1} flexShrink={1} overflow="hidden">
                  {liveSpinner ? (
                    <Spinner
                      verb={liveSpinner.verb}
                      startedAt={liveSpinner.startedAt}
                      outputTokens={liveSpinner?.outputTokens ?? liveSpinner?.tokens ?? 0}
                      thinking={!!(state.thinking || liveSpinner?.thinking)}
                      thinkingActiveSince={liveSpinner?.thinkingSegmentStartedAt ?? 0}
                      mode={liveSpinner?.mode || 'responding'}
                      columns={promptSpinnerColumns}
                      marginTop={0}
                    />
                  ) : null}
                </Box>
                {inputHint ? (
                  <Box flexShrink={0} width={transientStatusWidth || 1} marginLeft={1} marginRight={1} justifyContent="flex-end" overflow="hidden">
                    <Text color={promptStatusColor(inputHintTone)} wrap="truncate">{inputHint}</Text>
                  </Box>
                ) : null}
              </Box>
              <Box height={1} width="100%" backgroundColor={surfaceBackground()} />
            </>
          ) : null}
          {queuedVisible ? (
            <QueuedCommands queued={state.queued} columns={frameColumns} />
          ) : null}
          <Box
            marginTop={0}
            width="100%"
            borderStyle="round"
            borderColor={theme.promptBorder}
            backgroundColor={surfaceBackground()}
            paddingX={1}
          >
            {promptInputControl}
          </Box>
          </>
        ) : null}
        <StatusLine
          sessionId={state.sessionId}
          clientHostPid={state.clientHostPid}
          provider={state.provider}
          model={state.model}
          effort={state.effort}
          fast={state.fast}
          cwd={state.cwd}
          stats={statuslineStats}
          contextWindow={state.contextWindow}
          displayContextWindow={state.displayContextWindow}
          compactBoundaryTokens={state.compactBoundaryTokens}
          autoCompactTokenLimit={state.autoCompactTokenLimit}
          rawContextWindow={state.rawContextWindow}
          resizeEpoch={resizeEpoch}
          agentRevision={agentRevision}
          agentWorkers={state.agentWorkers}
          agentJobs={state.agentJobs}
          activeTools={activeTools}
          initialLine={initialStatusLine}
          workflow={state.workflow}
          remoteEnabled={state.remoteEnabled === true}
          themeEpoch={state.themeEpoch || 0}
        />
      </Box>
    </Box>
  );
}
