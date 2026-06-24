/**
 * App.jsx — the React/ink chat application (Claude-Code-style).
 *
 * Layout (top → bottom):
 *   welcome banner
 *   transcript (finished items, a live column — terminal scrolls older rows off)
 *   live reasoning (∴ Thinking… — only while a turn streams)
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
import { spawn } from 'node:child_process';
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import { theme, TURN_MARKER } from './theme.mjs';
import { useEngine } from './hooks/useEngine.mjs';
import { AssistantMessage, UserMessage, ThinkingMessage, NoticeMessage } from './components/Message.jsx';
import { ToolExecution } from './components/ToolExecution.jsx';
import { Spinner } from './components/Spinner.jsx';
import { TurnDone } from './components/TurnDone.jsx';
import { StatusLine } from './components/StatusLine.jsx';
import { PromptInput } from './components/PromptInput.jsx';
import { QueuedCommands } from './components/QueuedCommands.jsx';
import { Picker } from './components/Picker.jsx';
import { SlashCommandPalette } from './components/SlashCommandPalette.jsx';
import { ContextPanel } from './components/ContextPanel.jsx';
import { TextEntryPanel } from './components/TextEntryPanel.jsx';

const HELP = [
  'Slash commands:',
  '  /clear           reset the conversation',
  '  /compact         compact older conversation context',
  '  /new             start a fresh session (closes current)',
  '  /resume [id]     resume a saved session (picker if no id)',
  '  /context         show current session context surface',
  '  /status          open session/runtime status dashboard',
  '  /model <name>    switch model for subsequent turns (picker if no name)',
  '  /effort [level] set reasoning effort for the current model',
  '  /mcp             manage MCP servers and tools',
  '  /skills          choose a skill for the next request',
  '  /plugins         manage local plugin integrations',
  '  /hooks           manage before-tool hook rules and events',
  '  /providers       manage provider auth and local endpoints',
  '  /channels        manage Discord, channels, schedules, webhooks',
  '  /schedules       manage schedules',
  '  /webhooks        manage inbound webhooks',
  '  /exit, /quit     quit',
  'Picker: ↑/↓ navigate, →/Enter open, ← back, Esc cancel.',
  'Ctrl+B toggles bridge sync/async. /exit or /quit exits. Ctrl+V/paste inserts text. PageUp/PageDown scroll transcript.',
].join('\n');

const MOUSE_TRACKING_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
const MOUSE_TRACKING_OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';
const MOUSE_MODIFIER_MASK = 4 | 8 | 16;
const MOUSE_CTRL_MASK = 16;

const SLASH_COMMANDS = [
  { name: 'clear', usage: '/clear', description: 'reset the conversation' },
  { name: 'compact', usage: '/compact', description: 'compact older conversation context' },
  { name: 'new', usage: '/new', description: 'start a fresh session' },
  { name: 'resume', usage: '/resume', description: 'resume a saved session' },
  { name: 'context', usage: '/context', description: 'show current session context surface' },
  { name: 'status', usage: '/status', description: 'open session/runtime status dashboard' },
  { name: 'model', usage: '/model', description: 'switch model for subsequent turns' },
  { name: 'effort', usage: '/effort [level]', description: 'set reasoning effort for the current model' },
  { name: 'mcp', usage: '/mcp', description: 'manage MCP servers and tools' },
  { name: 'skills', usage: '/skills', description: 'choose a skill for the next request' },
  { name: 'plugins', usage: '/plugins', description: 'manage local plugin integrations' },
  { name: 'hooks', usage: '/hooks', description: 'manage before-tool hook rules and events' },
  { name: 'providers', usage: '/providers', description: 'manage auth, API keys, OAuth, and local endpoints' },
  { name: 'channels', usage: '/channels', description: 'manage Discord, channels, schedules, webhooks' },
  { name: 'schedules', usage: '/schedules', description: 'manage schedules' },
  { name: 'webhooks', usage: '/webhooks', description: 'manage inbound webhooks' },
  { name: 'exit', usage: '/exit', description: 'quit the TUI' },
  { name: 'quit', usage: '/quit', description: 'quit the TUI' },
];

function slashQuery(value) {
  const text = String(value ?? '');
  if (!/^\/[^\s]*$/.test(text)) return null;
  return text.slice(1).toLowerCase();
}

function slashCommandMatches(command, query) {
  const needle = String(query || '').toLowerCase();
  if (!needle) return true;
  return String(command?.name || '').toLowerCase().startsWith(needle);
}

function terminalSize(stdout) {
  return {
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  };
}

function formatSessionUpdatedAt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '--:--';
  const date = new Date(n);
  if (Number.isNaN(date.getTime())) return '--:--';
  const now = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDay ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function compactSessionCwd(cwd) {
  const text = String(cwd || '').trim();
  if (!text) return '(no cwd)';
  const parts = text.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return text;
  if (parts.length === 1) return parts[0];
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function shortSessionId(id) {
  const text = String(id || '');
  if (!text) return '';
  return text.length > 18 ? `${text.slice(0, 15)}…` : text;
}

function parseBridgeControl(text) {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
  const action = (parts[0] || '').toLowerCase();
  if (!['spawn', 'send', 'list', 'status', 'read', 'cleanup', 'cancel', 'close'].includes(action)) return null;
  const value = parts[1] || '';
  if (action === 'list' || action === 'cleanup') return { type: action };
  if (action === 'spawn') {
    const role = value;
    if (!role) return { error: 'usage: /bridge spawn <role> [sync|async] <prompt>' };
    const parsed = parseBridgeFreeform(parts.slice(2));
    if (!parsed.message) return { error: 'usage: /bridge spawn <role> [sync|async] <prompt>' };
    return { type: 'spawn', role, ...parsed };
  }
  if (action === 'send') {
    if (!value) return { error: 'usage: /bridge send <tag|sessionId> [sync|async] <message>' };
    const parsed = parseBridgeFreeform(parts.slice(2));
    if (!parsed.message) return { error: 'usage: /bridge send <tag|sessionId> [sync|async] <message>' };
    return value.startsWith('sess_')
      ? { type: 'send', sessionId: value, ...parsed }
      : { type: 'send', tag: value, ...parsed };
  }
  if (!value) return { error: `usage: /bridge ${action} <jobId|tag|sessionId>` };
  if (action === 'status' || action === 'read') return { type: action, jobId: value };
  if (value.startsWith('job_')) return { type: action, jobId: value };
  if (value.startsWith('sess_')) return { type: action, sessionId: value };
  return { type: action, tag: value };
}

function parseBridgeFreeform(parts) {
  const out = {};
  let i = 0;
  for (; i < parts.length; i += 1) {
    const token = parts[i];
    const lower = token.toLowerCase();
    if (lower === 'sync' || lower === 'async') {
      out.mode = lower;
      continue;
    }
    const kv = /^([a-zA-Z][\w-]*)=(.+)$/.exec(token);
    if (kv && ['tag', 'preset', 'provider', 'model', 'effort', 'cwd'].includes(kv[1])) {
      out[kv[1]] = kv[2];
      continue;
    }
    break;
  }
  out.message = parts.slice(i).join(' ').trim();
  return out;
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
  if (/^https?:\/\//i.test(commandOrUrl)) return { server: { name, url: commandOrUrl } };
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
  return String(text || '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      const raw = line.trim();
      if (raw.endsWith(':') && !raw.includes('id=')) {
        return {
          value: `core-group-${index}`,
          label: raw.slice(0, -1),
          description: 'core memory pool',
          _line: raw,
        };
      }
      const match = raw.match(/^id=(\d+)\s+\[([^\]]*)\]\s+(.+?)(?:\s+—\s+(.+))?$/);
      if (match) {
        const [, id, category, element, summary = ''] = match;
        return {
          value: `core-${id}`,
          label: `#${id} [${category}] ${element}`,
          description: summary,
          _line: raw,
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

// Copy text to the OS clipboard via the platform's native command. We avoid
// OSC 52 (terminal clipboard escape) because support is uneven across Windows
// terminals; spawning clip/pbcopy/xclip is reliable. Resolves on success,
// rejects if the helper is missing or errors.
function copyToClipboard(text) {
  return new Promise((resolve, reject) => {
    let cmd;
    let args = [];
    if (process.platform === 'win32') {
      cmd = 'clip';
    } else if (process.platform === 'darwin') {
      cmd = 'pbcopy';
    } else if (process.env.WAYLAND_DISPLAY) {
      cmd = 'wl-copy';
    } else {
      cmd = 'xclip';
      args = ['-selection', 'clipboard'];
    }
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch (e) {
      reject(e);
      return;
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    child.stdin.on('error', () => { /* ignore EPIPE if the helper closed early */ });
    child.stdin.end(text, 'utf8');
  });
}

const Item = React.memo(function Item({ item, prevKind, columns, toolOutputExpanded }) {
  switch (item.kind) {
    case 'user': return <UserMessage text={item.text} attached={prevKind === 'user'} columns={columns} />;
    case 'assistant': return <AssistantMessage text={item.text} />;
    case 'tool': return <ToolExecution name={item.name} args={item.args} result={item.result} isError={item.isError} expanded={toolOutputExpanded || item.expanded} globalExpanded={toolOutputExpanded} columns={columns} attached={false} count={item.count} completedCount={item.completedCount} />;
    case 'notice': return <NoticeMessage text={item.text} tone={item.tone} columns={columns} />;
    case 'turndone': return <TurnDone elapsedMs={item.elapsedMs} status={item.status} />;
    default: return null;
  }
});

export function App({ store, initialStatusLine = '' }) {
  const state = useEngine(store);
  const [toolOutputExpanded, setToolOutputExpanded] = useState(false);
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
  const exitRequestedRef = useRef(false);
  const [resizeState, setResizeState] = useState(() => ({ ...terminalSize(stdout), epoch: 0 }));
  // scrollOffset = how many transcript ROWS we've scrolled UP from the bottom
  // (0 = pinned to the latest, showing the newest content). Mouse wheel adjusts
  // it; a new turn / new items snap back to 0 (handled below).
  const [scrollOffset, setScrollOffset] = useState(0);
  const scrollPositionRef = useRef(0);
  const scrollTargetRef = useRef(0);
  const scrollAnimationRef = useRef(null);
  // picker = null | { type, title, items, onSelect }
  // Rendered as an option panel attached directly above the bottom prompt.
  const [picker, setPicker] = useState(null);
  const [contextPanel, setContextPanel] = useState(null);
  const [providerPrompt, setProviderPrompt] = useState(null);
  const [channelPrompt, setChannelPrompt] = useState(null);
  const [hookPrompt, setHookPrompt] = useState(null);
  const [settingsPrompt, setSettingsPrompt] = useState(null);
  const [promptDraft, setPromptDraft] = useState('');
  const [promptDraftOverride, setPromptDraftOverride] = useState(null);
  const promptValueRef = useRef('');
  const [promptHint, setPromptHint] = useState('');
  const [promptHintTone, setPromptHintTone] = useState('info');
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissedFor, setSlashDismissedFor] = useState('');
  const [disabledSkills, setDisabledSkills] = useState(() => new Set());
  const slashPaletteRef = useRef({ open: false, count: 0 });
  const onboardingStartedRef = useRef(false);
  const onboardingRef = useRef({ defaultRoute: null, workflowRoutes: {}, providerModels: [] });
  const promptHintTimerRef = useRef(null);
  const mouseZoomPassthroughTimerRef = useRef(null);
  // dragRef tracks an in-progress mouse text selection (see the mouse handler):
  // anchor = where the drag began, last = the latest cell, active = button held.
  const dragRef = useRef({ anchor: null, last: null, active: false, rect: null });
  const selectionTextRef = useRef('');
  // lastClickRef tracks the previous left-press cell + time so the mouse handler
  // can detect a double-click (same cell within 400ms) for word selection.
  const lastClickRef = useRef({ x: -1, y: -1, t: 0 });

  // Copy the currently-highlighted selection to the OS clipboard. ink's fork
  // refreshed store.getRenderSelectionText() on the synchronous render that the
  // final setSelection() triggered, so the text under the rect is ready to read.
  const copySelection = useCallback((rect, attempt = 0) => {
    const text = store.getRenderSelectionText?.() || selectionTextRef.current;
    if ((!text || !text.trim()) && attempt < 4) {
      setTimeout(() => copySelection(rect, attempt + 1), attempt === 0 ? 0 : 24);
      return;
    }
    if (!text || !text.trim()) return;
    selectionTextRef.current = text;
    copyToClipboard(text)
      .then(() => {
        const lines = text.split('\n').length;
        const chars = text.length;
        store.pushNotice(`copied ${chars} char${chars === 1 ? '' : 's'}${lines > 1 ? ` · ${lines} lines` : ''}`, 'plain');
      })
      .catch((e) => store.pushNotice(`copy failed: ${e?.message || e}`, 'error'));
  }, [store]);

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
    if (promptHintTimerRef.current) {
      clearTimeout(promptHintTimerRef.current);
      promptHintTimerRef.current = null;
    }
    setPromptHint('');
    setPromptHintTone('info');
  }, []);

  const showPromptHint = useCallback((text, tone = 'info') => {
    if (promptHintTimerRef.current) clearTimeout(promptHintTimerRef.current);
    setPromptHint(String(text || ''));
    setPromptHintTone(tone);
    promptHintTimerRef.current = setTimeout(() => {
      promptHintTimerRef.current = null;
      setPromptHint('');
      setPromptHintTone('info');
    }, 2200);
  }, []);

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
        stopSmoothScroll();
        return;
      }
      scrollPositionRef.current = Math.max(0, next);
      setScrollOffset(Math.max(0, Math.round(scrollPositionRef.current)));
    }, 16);
    scrollAnimationRef.current.unref?.();
  }, [stopSmoothScroll]);

  const resetTranscriptScroll = useCallback(() => {
    stopSmoothScroll();
    scrollPositionRef.current = 0;
    scrollTargetRef.current = 0;
    setScrollOffset(0);
  }, [stopSmoothScroll]);

  const rememberSelectionTextSoon = useCallback(() => {
    setTimeout(() => {
      const text = store.getRenderSelectionText?.();
      if (text && text.trim()) selectionTextRef.current = text;
    }, 0);
  }, [store]);

  const applySelectionRect = useCallback((rect) => {
    dragRef.current.rect = rect || null;
    if (!rect) selectionTextRef.current = '';
    store.setRenderSelection?.(rect || null);
    if (rect) rememberSelectionTextSoon();
  }, [store, rememberSelectionTextSoon]);

  const scrollTranscriptRows = useCallback((deltaRows, options = {}) => {
    const target = Math.max(0, scrollTargetRef.current + deltaRows);
    const appliedDelta = target - scrollTargetRef.current;
    scrollTargetRef.current = target;
    if (appliedDelta !== 0 && dragRef.current.rect) {
      const shift = (p) => (p ? { ...p, y: p.y + appliedDelta } : p);
      dragRef.current = {
        ...dragRef.current,
        anchor: shift(dragRef.current.anchor),
        last: shift(dragRef.current.last),
        rect: {
          ...dragRef.current.rect,
          y1: dragRef.current.rect.y1 + appliedDelta,
          y2: dragRef.current.rect.y2 + appliedDelta,
        },
      };
      store.setRenderSelection?.(dragRef.current.rect);
    }
    if (options.smooth) {
      startSmoothScroll();
      return;
    }
    stopSmoothScroll();
    scrollPositionRef.current = target;
    setScrollOffset(Math.round(target));
  }, [startSmoothScroll, stopSmoothScroll, store]);

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

  // Mouse handling. index.jsx enabled SGR mouse tracking (?1000h button + ?1002h
  // drag-motion + ?1006h SGR coords). Every event arrives as `\x1b[<b;col;rowM`
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
    const onData = (data) => {
      // ink emits each parsed input event as a string; a mouse SGR sequence
      // arrives whole. Guard so non-mouse keystrokes fall through untouched.
      const s = typeof data === 'string' ? data : String(data ?? '');
      if (s.indexOf('\x1b[<') === -1) return;
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
        if (baseButton === 0 && press && !isMotion) {
          // Double-click on a word: select just that word and copy it, reusing
          // the existing selection/copy pipeline, then advance to the next event.
          const now = Date.now();
          const lc = lastClickRef.current;
          // Treat a second press as a double-click when it lands on the same row
          // within ~1 cell of the first press (terminals often report a slightly
          // shifted column on the second click). Exact-cell matching made
          // double-click word selection unreliable.
          const isDouble = (now - lc.t) < 450
            && lc.y === y
            && Math.abs(lc.x - x) <= 1;
          if (isDouble) {
            // Consume this click so a following press is not mistaken for another
            // double-click (avoids a stray single-cell selection flicker).
            lastClickRef.current = { x: -1, y: -1, t: 0 };
            const wr = store.getWordRectAt?.(x, y);
            if (wr) {
              const rect = linearSelection({ x: wr.x1, y: wr.y1 }, { x: wr.x2, y: wr.y2 });
              stopSmoothScroll();
              dragRef.current = { anchor: null, last: null, active: false, rect };
              applySelectionRect(rect);
              // Selection only — copy happens on Ctrl+C (see useInput), not here.
              continue;
            }
          }
          lastClickRef.current = { x, y, t: now };
          // Left-button press: begin a new selection anchored here.
          // Anchor the drag but do NOT paint a zero-width selection yet; a plain
          // single click should not flash a one-cell highlight. The selection is
          // only rendered once a drag actually extends past the anchor.
          stopSmoothScroll();
          dragRef.current = { anchor: { x, y }, last: { x, y }, active: true, rect: null };
        } else if (baseButton === 0 && isMotion && dragRef.current.active) {
          // Drag motion: extend the selection to the current cell.
          dragRef.current.last = { x, y };
          const rect = linearSelection(dragRef.current.anchor, { x, y });
          applySelectionRect(rect);
          const rows = Math.max(1, Number(resizeState.rows) || 24);
          if (y <= 1) {
            scrollTranscriptRows(3);
          } else if (y >= rows - 5) {
            scrollTranscriptRows(-3);
          }
        } else if (!press && dragRef.current.active) {
          // Button release while dragging: finalize with the release coordinate
          // (the SGR release event carries col/row) and keep the selection
          // visible. Copy is NOT automatic — the user presses Ctrl+C to copy
          // (see useInput). The highlight stays until ESC or a plain click.
          const { anchor } = dragRef.current;
          dragRef.current.active = false;
          const rect = linearSelection(anchor, { x, y });
          const empty = rect.x1 === rect.x2 && rect.y1 === rect.y2;
          if (empty) {
            applySelectionRect(null); // a plain click clears any prior highlight
          } else {
            // Push the final rect so ink re-renders and refreshes the selection
            // text synchronously; it is read back by copySelection on Ctrl+C.
            applySelectionRect(rect);
          }
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
        const STEP = 3; // rows per wheel notch; immediate updates feel steadier in Windows Terminal
        scrollTranscriptRows((up - down) * STEP);
      }
    };
    inkInput.on('input', onData);
    return () => { inkInput.off('input', onData); };
  }, [inkInput, isRawModeSupported, store, copySelection, passthroughCtrlWheelZoom, resizeState.rows, scrollTranscriptRows, applySelectionRect]);

  // Keep the transcript pinned only while the user is already at the bottom.
  // If they scroll up to inspect a long answer, later tool/result cards must not
  // yank the viewport back down.
  useEffect(() => {
    if (dragRef.current.active) return;
    if (scrollTargetRef.current <= 0) resetTranscriptScroll();
  }, [state.items.length, resetTranscriptScroll]);

  // `exiting` removes the inline caret (PromptInput draws none when disabled) and
  // freezes input for the teardown frame, so the final frame is clean before ink
  // unmounts. Exit just past the render throttle window so that frame flushes.
  const requestExit = useCallback(() => {
    if (exitRequestedRef.current) return;
    exitRequestedRef.current = true;
    setExiting(true);
    setTimeout(() => {
      let timer = null;
      Promise.race([
        Promise.resolve(store.dispose?.()),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 6500);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
        exit();
      });
    }, 60);
  }, [store, exit]);

  // ESC → interrupt the running turn (keeps the steering queue). Only active
  // on a real TTY (raw mode); in pipes/CI useInput throws.
  // This handler is registered before PromptInput's, so ESC is caught here while
  // a turn is busy; when idle it falls through (PromptInput may use it later).
  // Ctrl+O toggles the global tool-output expansion, matching the Claude/Pi
  // expectation that this is a view mode rather than a per-card hidden state.
  const toggleExpand = useCallback(() => {
    setToolOutputExpanded((expanded) => !expanded);
  }, []);

  const restoreQueuedToPrompt = useCallback(() => {
    const restored = store.restoreQueued?.(promptValueRef.current || promptDraft);
    if (!restored || restored.count === 0) {
      showPromptHint('no queued messages to restore', 'info');
      return false;
    }
    setPromptDraftOverride({ id: Date.now(), value: restored.text });
    showPromptHint(`restored ${restored.count} queued message${restored.count === 1 ? '' : 's'}`, 'info');
    return true;
  }, [store, promptDraft, showPromptHint]);

  useInput((input, key) => {
    if (key.ctrl && (input === 'b' || input === 'B')) {
      store.toggleBridgeMode?.();
      return;
    }
    if (key.ctrl && (input === 'c' || input === 'C')) {
      // Ctrl+C copies the current drag/double-click selection (if any) to the
      // OS clipboard. The highlight is intentionally kept visible after copy.
      // With no active selection this is a no-op (exitOnCtrlC:false in
      // index.jsx already prevents Ctrl+C from terminating the app).
      const rect = dragRef.current.rect;
      const hasSelection = rect && !(rect.x1 === rect.x2 && rect.y1 === rect.y2);
      if (hasSelection) copySelection(rect);
      return;
    }
    if (key.ctrl && (input === 'o' || input === 'O')) {
      toggleExpand();
      return;
    }
    if (key.escape && contextPanel && !picker) {
      setContextPanel(null);
      return;
    }
    if (key.pageUp) {
      const pageRows = Math.max(3, Math.floor((resizeState.rows ?? 24) * 0.6));
      scrollTranscriptRows(pageRows);
      return;
    }
    if (key.pageDown) {
      const pageRows = Math.max(3, Math.floor((resizeState.rows ?? 24) * 0.6));
      scrollTranscriptRows(-pageRows);
      return;
    }
    if (key.ctrl && key.end) {
      resetTranscriptScroll();
      return;
    }
    if (key.escape && state.busy && !picker) {
      store.abort();
      return;
    }
    if (key.escape && !picker) {
      dragRef.current.active = false;
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
    const versionDelta = compareModelVersion(a, b);
    if (versionDelta) return versionDelta;

    if (isClaudeModel(a) && isClaudeModel(b)) {
      if (!!a?.latest !== !!b?.latest) return a?.latest ? -1 : 1;
      const ta = releaseTime(a);
      const tb = releaseTime(b);
      if (ta !== tb) return tb - ta;
      return String(a?.display || a?.id || '').localeCompare(String(b?.display || b?.id || ''));
    }

    const ta = releaseTime(a);
    const tb = releaseTime(b);
    if (ta !== tb) return tb - ta;
    if (!!a?.latest !== !!b?.latest) return a?.latest ? -1 : 1;
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
      return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M ctx`;
    }
    return `${Math.round(n / 1000)}k ctx`;
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

  const modelDescription = (m) => [m.provider, formatContextWindow(modelContextWindow(m))].filter(Boolean).join(' · ');

  const buildModelPickerItems = (models, expandedProvider) => {
    const providers = new Map();
    for (const model of models) {
      if (!providers.has(model.provider)) providers.set(model.provider, []);
      providers.get(model.provider).push(model);
    }

    const currentProvider = state.provider;
    const orderedProviders = [...providers.keys()].sort((a, b) => {
      if (a === currentProvider) return -1;
      if (b === currentProvider) return 1;
      return a.localeCompare(b);
    });

    const items = [];
    for (const provider of orderedProviders) {
      const providerModels = providers.get(provider) || [];
      const expanded = expandedProvider === provider;
      items.push({
        value: `provider:${provider}`,
        label: `${expanded ? '▾' : '▸'} ${provider}`,
        description: '',
        _action: 'toggle-provider',
        _provider: provider,
      });
      if (!expanded) continue;
      for (const model of providerModels) {
        items.push({
          value: `model:${model.provider}:${model.id}`,
          label: `    ${model.display || model.id}`,
          description: formatContextWindow(modelContextWindow(model))
            ? `    ${formatContextWindow(modelContextWindow(model))}`
            : '',
          _action: 'select-model',
          _provider: model.provider,
          _modelId: model.id,
        });
      }
    }
    return items;
  };

  const routeLabel = (route) => {
    if (!route?.provider || !route?.model) return '(unset)';
    return `${route.provider}/${route.model}${route.effort ? ` · ${route.effort}` : ''}`;
  };

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
    } else if (slot === 'memory' || slot === 'search') {
      if (/haiku|mini|nano|flash|fast/.test(text)) score += 20;
      if (/opus|max/.test(text)) score -= 4;
    } else if (slot === 'explorer' || slot === 'bridge') {
      if (/sonnet|gpt-5|mini|haiku|flash/.test(text)) score += 12;
      if (/opus/.test(text)) score += slot === 'bridge' ? 3 : -2;
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
    bridge: chooseRecommendedModel(models, 'bridge', defaultRoute),
    explorer: chooseRecommendedModel(models, 'explorer', defaultRoute),
    search: chooseRecommendedModel(models, 'search', defaultRoute),
    memory: chooseRecommendedModel(models, 'memory', defaultRoute),
  });

  const openModelPicker = async (options = {}) => {
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    let providerModels = [];
    try {
      providerModels = await store.listProviderModels();
    } catch (e) {
      store.pushNotice(`could not list models: ${e?.message || e}`, 'error');
      return;
    }

    if (!providerModels || providerModels.length === 0) {
      store.pushNotice('no provider models available; open /providers to authenticate', 'warn');
      void openProviderSetupPicker({
        title: 'Providers',
        continueLabel: 'Back to model setup',
        continueDescription: 'retry model list after provider auth',
        onContinue: () => void openModelPicker(),
      });
      return;
    }

    const models = normalizeModelOptions(providerModels);
    let expandedProvider = null;
    const toggleProvider = (provider, force) => {
      if (!provider) return;
      if (force === false) {
        if (expandedProvider === provider) expandedProvider = null;
        return;
      }
      if (force === true) {
        expandedProvider = provider;
        return;
      }
      expandedProvider = expandedProvider === provider ? null : provider;
    };
    const renderModelPicker = () => {
      setPicker({
        title: `Model (current: ${state.model})`,
        items: buildModelPickerItems(models, expandedProvider),
        onSelect: (_value, item) => {
          if (item?._action === 'toggle-provider') {
            toggleProvider(item._provider);
            renderModelPicker();
            return;
          }
          setPicker(null);
          void store.setRoute({ provider: item._provider, model: item._modelId })
            .then(ok => store.pushNotice(ok ? `✓ model → ${item._provider}/${item._modelId}` : 'model switch already in progress', ok ? 'info' : 'warn'))
            .catch((e) => store.pushNotice(`model switch failed: ${e?.message || e}`, 'error'));
        },
        onLeft: (item) => {
          if (item?._provider && expandedProvider === item._provider) {
            toggleProvider(item._provider, false);
            renderModelPicker();
            return;
          }
          setPicker(null);
          if (options.onBack) options.onBack();
          else showPromptHint('canceled', 'cancel');
        },
        onRight: (item) => {
          if (item?._action === 'select-model') {
            setPicker(null);
            void store.setRoute({ provider: item._provider, model: item._modelId })
              .then(ok => store.pushNotice(ok ? `✓ model → ${item._provider}/${item._modelId}` : 'model switch already in progress', ok ? 'info' : 'warn'))
              .catch((e) => store.pushNotice(`model switch failed: ${e?.message || e}`, 'error'));
            return;
          }
          toggleProvider(item?._provider, true);
          renderModelPicker();
        },
        onCancel: () => {
          setPicker(null);
          showPromptHint('canceled', 'cancel');
        },
      });
    };

    renderModelPicker();
  };

  const openEffortPicker = () => {
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    const current = state.effort || 'auto';
    const items = Array.isArray(state.effortOptions) && state.effortOptions.length > 0
      ? state.effortOptions
      : [{ value: 'auto', label: 'auto', description: 'provider/model default' }];
    setPicker({
      title: `Effort (current: ${current})`,
      items,
      onSelect: (value) => {
        setPicker(null);
        void store.setEffort(value)
          .then(result => store.pushNotice(result ? `✓ effort → ${result}` : 'effort switch already in progress', result ? 'info' : 'warn'))
          .catch((e) => store.pushNotice(`effort switch failed: ${e?.message || e}`, 'error'));
      },
      onCancel: () => {
        setPicker(null);
        showPromptHint('canceled', 'cancel');
      },
    });
  };

  const openBridgePicker = () => {
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    const mode = state.bridgeMode || 'sync';
    setPicker({
      title: `Bridge (current: ${mode})`,
      items: [
        {
          value: 'sync',
          label: mode === 'sync' ? '● Sync mode' : '○ Sync mode',
          description: 'worker calls wait for completion',
          _action: 'mode',
          _mode: 'sync',
        },
        {
          value: 'async',
          label: mode === 'async' ? '● Async mode' : '○ Async mode',
          description: 'worker calls return job handles',
          _action: 'mode',
          _mode: 'async',
        },
        {
          value: 'list',
          label: 'List workers/jobs',
          description: 'show active bridge sessions and async jobs',
          _action: 'control',
          _args: { type: 'list' },
        },
        {
          value: 'cleanup',
          label: 'Cleanup finished jobs',
          description: 'remove completed bridge job records',
          _action: 'control',
          _args: { type: 'cleanup' },
        },
      ],
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action === 'mode') {
          const next = store.setBridgeMode?.(item._mode);
          store.pushNotice(`✓ bridge mode → ${next || item._mode}`, 'info');
          return;
        }
        if (item._action === 'control') {
          void store.bridgeControl?.(item._args)
            .catch((e) => store.pushNotice(`bridge failed: ${e?.message || e}`, 'error'));
        }
      },
      onCancel: () => {
        setPicker(null);
        showPromptHint('canceled', 'cancel');
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
        label: `${tool.active ? '●' : '○'} ${tool.name}`,
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
        showPromptHint('canceled', 'cancel');
      },
    });
  };

  const openStatusPicker = () => {
    const tools = store.toolsStatus?.() || { activeCount: 0, count: 0 };
    const mcp = store.mcpStatus?.() || { connectedCount: 0, configuredCount: 0, failedCount: 0 };
    const hooks = store.hooksStatus?.() || { ruleCount: 0, recent: [] };
    const plugins = store.pluginsStatus?.() || { count: 0 };
    const skills = store.skillsStatus?.() || { count: 0 };
    const channelWorker = store.getChannelWorkerStatus?.();
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker(null);
    setContextPanel({
      title: 'Status',
      rows: [
        {
          value: 'route',
          label: 'Route',
          description: `${state.provider}/${state.model} · ${state.effort || 'auto'}`,
        },
        {
          value: 'session',
          label: 'Session',
          description: state.sessionId || '(none)',
        },
        {
          value: 'cwd',
          label: 'Working dir',
          description: state.cwd,
        },
        {
          value: 'bridge',
          label: 'Bridge',
          description: `default ${state.bridgeMode || 'sync'}`,
        },
        {
          value: 'tools',
          label: 'Tools',
          description: `${tools.activeCount || 0}/${tools.count || 0} active · mode ${tools.mode || state.toolMode}`,
        },
        {
          value: 'memory',
          label: 'Memory',
          description: 'runtime controls available',
        },
        {
          value: 'mcp',
          label: 'MCP',
          description: `${mcp.connectedCount || 0}/${mcp.configuredCount || 0} connected${mcp.failedCount ? ` · ${mcp.failedCount} failed` : ''}`,
        },
        {
          value: 'hooks',
          label: 'Hooks',
          description: `${hooks.ruleCount || 0} rules · ${(hooks.recent || []).length} recent events`,
        },
        {
          value: 'plugins',
          label: 'Plugins',
          description: `${plugins.count || 0} detected`,
        },
        {
          value: 'skills',
          label: 'Skills',
          description: `${skills.count || 0} available`,
        },
        {
          value: 'channels',
          label: 'Channels',
          description: channelWorker?.running ? `worker running · pid ${channelWorker.pid}` : 'worker stopped',
        },
      ],
    });
  };

  const openContextPicker = () => {
    const tools = store.toolsStatus?.() || { activeCount: 0, count: 0, activeTools: [] };
    const skills = store.skillsStatus?.() || { count: 0 };
    const plugins = store.pluginsStatus?.() || { count: 0 };
    const context = store.contextStatus?.() || {};
    const usage = context.usage || {};
    const messages = context.messages || {};
    const roles = messages.roles || {};
    const request = context.request || {};
    const windowTokens = Number(context.contextWindow || state.contextWindow || context.rawContextWindow || state.rawContextWindow || 0);
    const rawWindowTokens = Number(context.rawContextWindow || state.rawContextWindow || windowTokens || 0);
    const usedTokens = Number(context.usedTokens || usage.lastContextTokens || 0);
    const freeTokens = windowTokens ? Math.max(0, windowTokens - usedTokens) : Number(context.freeTokens || 0);
    const pct = (value, total = windowTokens) => {
      const n = Number(value || 0);
      const d = Number(total || 0);
      if (!d) return 'n/a';
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
    const freshInput = Number(usage.lastInputTokens || 0);
    const cacheDenom = cachedRead + freshInput;
    const cacheHitRate = cacheDenom > 0
      ? `${((cachedRead / cacheDenom) * 100).toFixed(0)}%`
      : 'n/a';
    const roleLine = (label, key) => {
      const row = roles[key] || { count: 0, tokens: 0 };
      return `${label}: ${fmt(row.tokens)} tokens (${pct(row.tokens)}) · ${row.count || 0} messages`;
    };
    const contextSource = context.usedSource === 'last_api_request' ? 'last API request' : 'estimated';
    const contextRows = [
      {
        value: 'summary',
        label: 'Context Usage',
        description: `${fmt(usedTokens)}/${fmt(windowTokens)} (${pct(usedTokens)}) · ${fmt(freeTokens)} free · ${contextSource}`,
        _action: 'summary',
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
        description: `${fmt(usage.lastContextTokens)} context · ${fmt(usage.lastInputTokens)} input · ${fmt(usage.lastOutputTokens)} output`,
        _action: 'last-api',
      },
      {
        value: 'cache',
        label: 'Prompt cache',
        description: `${cacheHitRate} hit · ${fmt(usage.lastCachedReadTokens)} read · ${fmt(usage.lastInputTokens)} new (last request)`,
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
      title: 'Context Usage',
      rows: contextRows,
    });
  };

  const openSettingsPicker = () => {
    const tools = store.toolsStatus?.() || { activeCount: 0, count: 0 };
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: 'Settings',
      items: [
        {
          value: 'model',
          label: 'Model',
          description: `${state.provider}/${state.model}`,
          _action: 'model',
        },
        {
          value: 'effort',
          label: 'Reasoning effort',
          description: state.effort || 'auto',
          _action: 'effort',
        },
        {
          value: 'providers',
          label: 'Providers',
          description: 'API keys, OAuth, local endpoints',
          _action: 'providers',
        },
        {
          value: 'cwd',
          label: 'Working directory',
          description: state.cwd,
          _action: 'cwd',
        },
        {
          value: 'bridge',
          label: 'Bridge',
          description: `default ${state.bridgeMode || 'sync'}`,
          _action: 'bridge',
        },
        {
          value: 'tools',
          label: 'Tool surface',
          description: `${tools.activeCount || 0}/${tools.count || 0} active · ${state.toolMode}`,
          _action: 'tools',
        },
        {
          value: 'advanced',
          label: 'Advanced',
          description: 'MCP, plugins, hooks, skills, channels, runtime status',
          _action: 'advanced',
        },
      ],
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action === 'model') openModelPicker({ onBack: openSettingsPicker });
        else if (item._action === 'effort') openEffortPicker();
        else if (item._action === 'providers') void openProviderSetupPicker();
        else if (item._action === 'cwd') {
          setSettingsPrompt({
            kind: 'cwd',
            label: 'Working directory',
            hint: state.cwd,
          });
        }
        else if (item._action === 'bridge') openBridgePicker();
        else if (item._action === 'tools') openToolsPicker();
        else if (item._action === 'advanced') openAdvancedSettingsPicker();
      },
      onCancel: () => {
        setPicker(null);
        showPromptHint('canceled', 'cancel');
      },
    });
  };

  const openAdvancedSettingsPicker = () => {
    const mcp = store.mcpStatus?.() || { connectedCount: 0, configuredCount: 0, failedCount: 0 };
    const hooks = store.hooksStatus?.() || { ruleCount: 0 };
    const plugins = store.pluginsStatus?.() || { count: 0 };
    const skills = store.skillsStatus?.() || { count: 0 };
    const channelWorker = store.getChannelWorkerStatus?.();
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: 'Advanced Settings',
      items: [
        {
          value: 'mcp',
          label: 'MCP servers',
          description: `${mcp.connectedCount || 0}/${mcp.configuredCount || 0} connected${mcp.failedCount ? ` · ${mcp.failedCount} failed` : ''}`,
          _action: 'mcp',
        },
        {
          value: 'memory',
          label: 'Memory',
          description: 'runtime dashboard, cycles, and core entries',
          _action: 'memory',
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
          value: 'channels',
          label: 'Channels',
          description: channelWorker?.running ? `worker running · pid ${channelWorker.pid}` : 'worker stopped',
          _action: 'channels',
        },
        {
          value: 'status',
          label: 'Runtime status',
          description: 'open read-only overview dashboard',
          _action: 'status',
        },
        {
          value: 'back',
          label: 'Back',
          description: 'return to main settings',
          _action: 'back',
        },
      ],
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action === 'mcp') openMcpPicker();
        else if (item._action === 'memory') openMemoryPicker();
        else if (item._action === 'plugins') openPluginsPicker();
        else if (item._action === 'hooks') openHooksPicker();
        else if (item._action === 'skills') openSkillsPicker();
        else if (item._action === 'channels') void openChannelSetupPicker('all');
        else if (item._action === 'status') openStatusPicker();
        else if (item._action === 'back') openSettingsPicker();
      },
      onCancel: () => {
        setPicker(null);
        openSettingsPicker();
      },
    });
  };

  const openProviderSetupPicker = async (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    const onContinue = typeof options.onContinue === 'function' ? options.onContinue : returnTo;
    const onCancel = typeof options.onCancel === 'function' ? options.onCancel : null;
    let setup;
    try {
      setup = await store.getProviderSetup();
    } catch (e) {
      store.pushNotice(`providers failed: ${e?.message || e}`, 'error');
      return;
    }

    const items = [];
    if (returnTo || onContinue) {
      items.push({
        value: 'continue-setup',
        label: options.continueLabel || 'Continue setup',
        description: options.continueDescription || 'return to setup',
        _type: 'continue',
      });
    }
    for (const p of setup.api || []) {
      items.push({
        value: `api:${p.id}`,
        label: p.name,
        description: `API Key · ${p.status} · ${p.detail}`,
        _type: 'api-key',
        _providerId: p.id,
        _providerName: p.name,
      });
    }
    for (const p of setup.oauth || []) {
      items.push({
        value: `oauth:${p.id}`,
        label: p.name,
        description: `OAuth · ${p.status} · ${p.detail}`,
        _type: 'oauth',
        _providerId: p.id,
        _providerName: p.name,
      });
    }
    for (const p of setup.local || []) {
      items.push({
        value: `local:${p.id}`,
        label: p.name,
        description: `Local · ${p.status} · ${p.baseURL}`,
        _type: 'local',
        _providerId: p.id,
        _providerName: p.name,
        _enabled: p.enabled,
        _baseURL: p.baseURL,
        _defaultURL: p.defaultURL,
      });
    }

    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: options.title || 'Providers',
      items,
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._type === 'continue') {
          onContinue?.();
          return;
        }
        if (item._type === 'api-key') {
          setPicker({
            title: `Provider · ${item._providerName}`,
            items: [
              {
                value: 'set-key',
                label: 'Set API key',
                description: 'save or replace key in the OS keychain',
                _action: 'set-key',
              },
              {
                value: 'forget-key',
                label: 'Forget API key',
                description: 'remove stored key for this provider',
                _action: 'forget-key',
              },
            ],
            onSelect: (_detailValue, detail) => {
              setPicker(null);
              if (detail._action === 'set-key') {
                setProviderPrompt({
                  kind: 'api-key',
                  providerId: item._providerId,
                  label: item._providerName,
                  afterSave: returnTo,
                });
                return;
              }
              if (detail._action === 'forget-key') {
                try {
                  store.forgetProviderAuth(item._providerId);
                  void openProviderSetupPicker(options);
                } catch (e) {
                  store.pushNotice(`auth-forget failed: ${e?.message || e}`, 'error');
                }
              }
            },
            onCancel: () => {
              setPicker(null);
              void openProviderSetupPicker(options);
            },
          });
          return;
        }
        if (item._type === 'oauth') {
          void store.loginOAuthProvider(item._providerId)
            .then(() => openProviderSetupPicker(options))
            .catch((e) => store.pushNotice(`oauth login failed: ${e?.message || e}`, 'error'));
          return;
        }
        if (item._type === 'local') {
          if (item._enabled) {
            try {
              store.setLocalProvider(item._providerId, { enabled: false, baseURL: item._baseURL });
              void openProviderSetupPicker(options);
            } catch (e) {
              store.pushNotice(`local provider update failed: ${e?.message || e}`, 'error');
            }
            return;
          }
          setProviderPrompt({
            kind: 'local-url',
            providerId: item._providerId,
            label: item._providerName,
            defaultURL: item._defaultURL,
            afterSave: returnTo,
          });
        }
      },
      onCancel: () => {
        setPicker(null);
        if (onCancel) onCancel();
        else if (returnTo) returnTo();
        else showPromptHint('canceled', 'cancel');
      },
    });
  };

  const openOnboardingAuthStep = () => {
    void openProviderSetupPicker({
      title: 'First Run · Step 1/2 · Provider Auth',
      continueLabel: 'Continue to model setup',
      continueDescription: 'choose the default and workflow models',
      returnTo: () => openOnboardingAuthStep(),
      onContinue: () => void openOnboardingWorkflowStep(),
      onCancel: () => store.pushNotice('first-run setup will open again next launch', 'warn'),
    });
  };

  const openOnboardingRoleModelPicker = (slot) => {
    const models = normalizeModelOptions(onboardingRef.current.providerModels || []);
    const fallbackRoute = onboardingRef.current.defaultRoute || null;
    if (models.length === 0) {
      store.pushNotice('no provider models available; open /providers to authenticate', 'warn');
      openOnboardingAuthStep();
      return;
    }
    const recommendedRoute = chooseRecommendedModel(models, slot, fallbackRoute);
    const items = [
      {
        value: 'recommended',
        label: 'Use recommended',
        description: routeLabel(recommendedRoute),
        _action: 'recommended',
      },
      ...models.map((m) => ({
        value: `${m.provider}:${m.id}`,
        label: m.display || m.id,
        description: modelDescription(m),
        _action: 'select-model',
        _model: m,
      })),
      ...(fallbackRoute ? [{
        value: 'fallback',
        label: 'Use lead model',
        description: routeLabel(fallbackRoute),
        _action: 'fallback',
      }] : []),
    ];
    setPicker({
      title: `First Run · ${slot} model`,
      items,
      onSelect: (_value, item) => {
        const next = item._action === 'select-model'
          ? routeFromModel(item._model)
          : item._action === 'recommended'
            ? recommendedRoute
            : fallbackRoute;
        if (!next) {
          store.pushNotice('select a provider model first', 'warn');
          setPicker(null);
          openOnboardingAuthStep();
          return;
        }
        if (slot === 'lead') {
          onboardingRef.current.defaultRoute = next;
        }
        onboardingRef.current.workflowRoutes = {
          ...(onboardingRef.current.workflowRoutes || {}),
          [slot]: next,
        };
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
      } catch (e) {
        onboardingRef.current.providerModels = [];
        store.pushNotice(`could not list models: ${e?.message || e}`, 'warn');
      }
    }
    const models = onboardingRef.current.providerModels || [];
    if (models.length === 0) {
      onboardingRef.current.defaultRoute = null;
      onboardingRef.current.workflowRoutes = {};
      store.pushNotice('no provider models available; open /providers to authenticate', 'warn');
      openOnboardingAuthStep();
      return;
    }
    if (!onboardingRef.current.defaultRoute) {
      onboardingRef.current.defaultRoute = chooseRecommendedModel(models, 'lead', null);
    }
    if (!onboardingRef.current.workflowRoutes || Object.keys(onboardingRef.current.workflowRoutes).length === 0) {
      onboardingRef.current.workflowRoutes = buildWorkflowDefaults(models, onboardingRef.current.defaultRoute);
    }
    onboardingRef.current.workflowRoutes = {
      ...(onboardingRef.current.workflowRoutes || {}),
      lead: onboardingRef.current.defaultRoute,
    };
    const routes = onboardingRef.current.workflowRoutes || {};
    const slots = [
      ['bridge', 'Bridge', 'worker and agent dispatch route'],
      ['explorer', 'Explorer', 'code graph, file reading, repo exploration'],
      ['search', 'Search', 'web/search/retrieval helpers'],
      ['memory', 'Memory', 'memory cycles and curation'],
    ];
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: 'First Run · Step 2/2 · Workflow Routes',
      items: [
        {
          value: 'finish',
          label: 'Finish setup',
          description: 'save model and workflow route mapping',
          _action: 'finish',
        },
        {
          value: 'lead',
          label: 'Default model',
          description: `${routeLabel(onboardingRef.current.defaultRoute)} · main chat and planning route`,
          _action: 'slot',
          _slot: 'lead',
        },
        ...slots.map(([slot, label, description]) => ({
          value: slot,
          label,
          description: `${routeLabel(routes[slot])} · ${description}`,
          _action: 'slot',
          _slot: slot,
        })),
        {
          value: 'back',
          label: 'Back to provider auth',
          description: 'change API keys, OAuth, or local endpoints',
          _action: 'back',
        },
      ],
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action === 'finish') {
          const defaultRoute = onboardingRef.current.defaultRoute;
          if (!defaultRoute) {
            store.pushNotice('select a provider model before finishing setup', 'warn');
            openOnboardingAuthStep();
            return;
          }
          void store.completeOnboarding?.({
            defaultRoute,
            workflowRoutes: onboardingRef.current.workflowRoutes || {},
          })
            .then(() => store.pushNotice('✓ first-run setup complete', 'info'))
            .catch((e) => store.pushNotice(`setup save failed: ${e?.message || e}`, 'error'));
          return;
        }
        if (item._action === 'back') {
          openOnboardingAuthStep();
          return;
        }
        if (item._action === 'slot') {
          openOnboardingRoleModelPicker(item._slot);
        }
      },
      onCancel: () => {
        setPicker(null);
        store.pushNotice('first-run setup will open again next launch', 'warn');
      },
    });
  };

  useEffect(() => {
    if (onboardingStartedRef.current) return undefined;
    let canceled = false;
    try {
      const status = store.getOnboardingStatus?.();
      if (status?.completed === true) return undefined;
      onboardingStartedRef.current = true;
      setTimeout(() => {
        if (!canceled) openOnboardingAuthStep();
      }, 0);
    } catch {
      // If status probing fails, do not block normal TUI startup.
    }
    return () => {
      canceled = true;
    };
  }, [store]);

  const openChannelSetupPicker = async (focus = 'all') => {
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    let setup;
    try {
      setup = store.getChannelSetup();
    } catch (e) {
      store.pushNotice(`channels failed: ${e?.message || e}`, 'error');
      return;
    }

    if (focus === 'schedules') {
      const schedules = setup.schedules || [];
      const items = schedules.length ? schedules.map((schedule) => {
        const enabled = schedule.enabled !== false;
        return {
          value: `schedule:${schedule.name}`,
          label: `${enabled ? '●' : '○'} ${schedule.name}`,
          description: `${schedule.time || '(no cron)'} · ${schedule.route}${schedule.model ? ` · ${schedule.model}` : ''}`,
          _action: 'schedule-toggle',
          _name: schedule.name,
          _enabled: enabled,
        };
      }) : [{
        value: 'empty',
        label: 'No schedules',
        description: 'no schedules configured',
        _action: 'noop',
      }];
      setPicker({
        title: 'Schedules',
        items,
        onSelect: (_value, item) => {
          setPicker(null);
          if (item._action !== 'schedule-toggle') return;
          try {
            store.setScheduleEnabled?.(item._name, !item._enabled);
            void openChannelSetupPicker('schedules');
          } catch (e) {
            store.pushNotice(`schedule toggle failed: ${e?.message || e}`, 'error');
          }
        },
        onCancel: () => {
          setPicker(null);
          showPromptHint('canceled', 'cancel');
        },
      });
      return;
    }

    if (focus === 'webhooks') {
      const hooks = setup.webhooks || [];
      const serverEnabled = setup.webhook.enabled !== false;
      const items = [
        {
          value: 'webhook-server',
          label: `${serverEnabled ? '●' : '○'} Webhook server`,
          description: `port ${setup.webhook.port || 3333} · auth ${setup.webhook.status}`,
          _action: 'server-toggle',
          _enabled: serverEnabled,
        },
        ...(hooks.length ? hooks.map((hook) => {
          const enabled = hook.enabled !== false;
          return {
            value: `webhook:${hook.name}`,
            label: `${enabled ? '●' : '○'} ${hook.name}`,
            description: `${hook.parser || 'github'} · ${hook.route} · secret:${hook.secretSet ? 'set' : 'missing'}`,
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
      setPicker({
        title: 'Webhooks',
        items,
        onSelect: (_value, item) => {
          setPicker(null);
          try {
            if (item._action === 'server-toggle') {
              store.setWebhookConfig?.({ enabled: !item._enabled });
              void openChannelSetupPicker('webhooks');
              return;
            }
            if (item._action === 'webhook-toggle') {
              store.setWebhookEnabled?.(item._name, !item._enabled);
              void openChannelSetupPicker('webhooks');
            }
          } catch (e) {
            store.pushNotice(`webhook toggle failed: ${e?.message || e}`, 'error');
          }
        },
        onCancel: () => {
          setPicker(null);
          showPromptHint('canceled', 'cancel');
        },
      });
      return;
    }

    const worker = store.getChannelWorkerStatus?.();
    const rows = [
      {
        value: 'worker-status',
        label: 'Channel worker',
        description: worker?.running ? `running · pid ${worker.pid}` : 'stopped',
      },
      {
        value: 'discord-token',
        label: 'Discord token',
        description: `Bot token · ${setup.discord.status}${setup.discord.problem ? ' · invalid' : ''}`,
      },
      {
        value: 'webhook-token',
        label: 'Webhook auth',
        description: `ngrok/webhook authtoken · ${setup.webhook.status}`,
      },
      {
        value: 'webhook-toggle',
        label: 'Webhook server',
        description: `${setup.webhook.enabled === false ? 'disabled' : 'enabled'} · port ${setup.webhook.port || 3333}`,
      },
    ];

    if (focus !== 'schedules' && focus !== 'webhooks') {
      for (const ch of setup.channels || []) {
        rows.push({
          value: `channel:${ch.name}`,
          label: `# ${ch.name}`,
          description: `${ch.channelId || '(unset)'} · ${ch.mode}${ch.main ? ' · main' : ''}`,
        });
      }
    }
    if (focus !== 'webhooks') {
      for (const schedule of setup.schedules || []) {
        rows.push({
          value: `schedule:${schedule.name}`,
          label: `↻ ${schedule.name}`,
          description: `${schedule.time || '(no cron)'} · ${schedule.route}${schedule.model ? ` · ${schedule.model}` : ''}`,
        });
      }
    }
    if (focus !== 'schedules') {
      for (const hook of setup.webhooks || []) {
        rows.push({
          value: `webhook:${hook.name}`,
          label: `⌁ ${hook.name}`,
          description: `${hook.parser || 'github'} · ${hook.route} · secret:${hook.secretSet ? 'set' : 'missing'}`,
        });
      }
    }

    setPicker(null);
    setContextPanel({
      title: focus === 'schedules' ? 'Schedules' : focus === 'webhooks' ? 'Webhooks' : 'Channels',
      rows,
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

  const openMcpToolPicker = (server, tool) => {
    setPicker({
      title: tool.name.replace(/^mcp__[^_]+__/, ''),
      items: [
        {
          value: 'info',
          label: 'Tool info',
          description: tool.description || tool.name,
          _action: 'info',
        },
        {
          value: 'copy-name',
          label: 'Copy full name',
          description: tool.name,
          _action: 'copy-name',
        },
      ],
      onSelect: (_detailValue, detail) => {
        setPicker(null);
        if (detail._action === 'info') {
          store.pushNotice([tool.name, tool.description || ''].filter(Boolean).join('\n'), 'info');
          return;
        }
        if (detail._action === 'copy-name') {
          void copyToClipboard(tool.name)
            .then(() => store.pushNotice(`copied MCP tool: ${tool.name}`, 'plain'))
            .catch((e) => store.pushNotice(`copy failed: ${e?.message || e}`, 'error'));
        }
      },
      onCancel: () => openMcpServerPicker(server),
    });
  };

  const openMcpServerPicker = (server) => {
    if (server?.error) store.pushNotice(`${server.name}: ${server.error}`, 'warn');
    const enabled = server?.enabled !== false;
    const items = [
      {
        value: enabled ? 'disable' : 'enable',
        label: enabled ? 'Disable server' : 'Enable server',
        description: server?.configured ? `${server?.status || 'unknown'} · ${server?.transport || 'unknown'}` : 'server is not configured',
        _action: server?.configured ? (enabled ? 'disable' : 'enable') : 'noop',
      },
      {
        value: 'reconnect',
        label: 'Reconnect server',
        description: 'refresh configured MCP servers',
        _action: 'reconnect',
      },
    ];
    setPicker({
      title: `MCP · ${server?.name || 'server'}`,
      items,
      onSelect: (_toolValue, toolItem) => {
        setPicker(null);
        if (toolItem._action === 'enable' || toolItem._action === 'disable') {
          void store.setMcpServerEnabled?.(server.name, toolItem._action === 'enable')
            .then(() => openMcpServersPicker())
            .catch((e) => store.pushNotice(`mcp toggle failed: ${e?.message || e}`, 'error'));
          return;
        }
        if (toolItem._action === 'reconnect') {
          void store.reconnectMcp?.()
            .then(() => openMcpServersPicker())
            .catch((e) => store.pushNotice(`mcp reconnect failed: ${e?.message || e}`, 'error'));
        }
      },
      onCancel: () => openMcpServersPicker(),
    });
  };

  const openMcpServersPicker = () => {
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
      items.push({
        value: `server:${server.name}`,
        label: server.enabled === false ? `${server.name} (off)` : server.name,
        description: `${server.status || 'unknown'} · ${server.transport || 'unknown'} · ${server.toolCount || 0} tools${server.error ? ` · ${server.error}` : ''}`,
        _action: 'server',
        _server: server,
      });
    }
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: 'MCP servers',
      items,
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action !== 'server') return;
        openMcpServerPicker(item._server);
      },
      onCancel: () => {
        setPicker(null);
        showPromptHint('canceled', 'cancel');
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

  const openSkillsPicker = () => {
    const status = skillsStatus();
    if (!status) return;
    const skills = status.skills || [];
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
      const disabled = disabledSkills.has(skill.name);
      items.push({
        value: skill.name,
        label: disabled ? `${skill.name} (disabled)` : skill.name,
        description: `${disabled ? 'disabled · ' : ''}${skill.source || 'skill'} · ${skill.description || skill.filePath || ''}`,
        _action: 'skill',
        _skill: skill,
      });
    }
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: 'Skills',
      items,
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action !== 'skill' || !item._skill?.name) return;
        openSkillDetailPicker(item._skill);
      },
      onCancel: () => {
        setPicker(null);
        showPromptHint('canceled', 'cancel');
      },
    });
  };

  const openSkillDetailPicker = (skill) => {
    const disabled = disabledSkills.has(skill.name);
    setPicker({
      title: `Skill · ${skill.name}`,
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
        showPromptHint('canceled', 'cancel');
      },
    });
  };

  const openHookRulePicker = (rule) => {
    setPicker({
      title: `Hook rule ${rule.index + 1}`,
      items: [
        {
          value: 'toggle',
          label: rule.enabled ? 'Disable rule' : 'Enable rule',
          description: `${rule.tool} -> ${rule.action}`,
          _action: 'toggle',
        },
        {
          value: 'delete',
          label: 'Delete rule',
          description: rule.reason || rule.match || `${rule.tool} -> ${rule.action}`,
          _action: 'delete',
        },
        {
          value: 'view',
          label: 'View rule',
          description: 'show normalized rule details',
          _action: 'view',
        },
        {
          value: 'copy',
          label: 'Copy rule JSON',
          description: 'copy normalized rule details',
          _action: 'copy',
        },
      ],
      onSelect: (_value, item) => {
        setPicker(null);
        try {
          if (item._action === 'toggle') {
            store.setHookRuleEnabled?.(rule.index, !rule.enabled);
            void openHooksPicker();
          } else if (item._action === 'delete') {
            store.deleteHookRule?.(rule.index);
            void openHooksPicker();
          } else if (item._action === 'view') {
            store.pushNotice(JSON.stringify(rule, null, 2), 'info');
          } else if (item._action === 'copy') {
            void copyToClipboard(JSON.stringify(rule, null, 2))
              .then(() => store.pushNotice(`copied hook rule ${rule.index + 1}`, 'plain'))
              .catch((e) => store.pushNotice(`copy failed: ${e?.message || e}`, 'error'));
          }
        } catch (e) {
          store.pushNotice(`hook rule update failed: ${e?.message || e}`, 'error');
        }
      },
      onCancel: () => {
        setPicker(null);
        void openHooksPicker();
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
        label: `${rule.enabled ? '●' : '○'} ${rule.tool} -> ${rule.action}`,
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
    setPicker({
      title: 'Hooks',
      items,
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action === 'rule') {
          try {
            store.setHookRuleEnabled?.(item._rule.index, !item._rule.enabled);
            void openHooksPicker();
          } catch (e) {
            store.pushNotice(`hook toggle failed: ${e?.message || e}`, 'error');
          }
        }
      },
      onCancel: () => {
        setPicker(null);
        showPromptHint('canceled', 'cancel');
      },
    });
  };

  const openMemoryStatusPicker = () => {
    setPicker({
      title: 'Memory Status',
      items: [{ value: 'loading', label: 'Loading memory status', description: 'please wait' }],
      onSelect: () => {},
      onCancel: () => openMemoryPicker(),
    });
    void store.memoryControl?.({ action: 'status' }, { silent: true })
      .then((result) => {
        const rows = parseMemoryStatusRows(result);
        setPicker({
          title: 'Memory Status',
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
      items: [{ value: 'loading', label: 'Loading core memory', description: 'please wait' }],
      onSelect: () => {},
      onCancel: () => openMemoryPicker(),
    });
    void store.memoryControl?.({ action: 'core', op: 'list', project_id: '*' }, { silent: true })
      .then((result) => {
        const rows = parseMemoryCoreRows(result);
        setPicker({
          title: 'Core Memory',
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

  const openMemoryPicker = () => {
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: 'Memory',
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
        showPromptHint('canceled', 'cancel');
      },
    });
  };

  const openResumePicker = () => {
    let sessions;
    try {
      sessions = store.listSessions();
    } catch (e) {
      store.pushNotice(`could not list sessions: ${e?.message || e}`, 'error');
      return;
    }
    if (!sessions || sessions.length === 0) {
      store.pushNotice('no saved sessions', 'warn');
      return;
    }
    const items = sessions.map((s) => {
      const preview = String(s.preview || '').replace(/\n/g, ' ').trim();
      const count = `${s.messageCount || 0} msgs`;
      const suffix = [count, shortSessionId(s.id)].filter(Boolean).join(' · ');
      return {
        value: s.id,
        label: `${formatSessionUpdatedAt(s.updatedAt)} · ${compactSessionCwd(s.cwd)}`,
        description: `${preview || '(no prompt)'} · ${suffix}`,
      };
    });
    setPicker({
      title: 'Resume session',
      items,
      onSelect: (value) => {
        setPicker(null);
        void store.resume(value)
          .then(ok => store.pushNotice(ok ? `✓ resumed ${value}` : 'resume failed', ok ? 'info' : 'warn'))
          .catch((e) => store.pushNotice(`resume failed: ${e?.message || e}`, 'error'));
      },
      onCancel: () => {
        setPicker(null);
        showPromptHint('canceled', 'cancel');
      },
    });
  };

  const runSlashCommand = (cmd, arg = '') => {
    if (cmd !== 'context' && cmd !== 'status') setContextPanel(null);
    switch (cmd) {
      case 'clear':
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /clear', 'warn');
          return false;
        }
        void store.clear().then(() => {}).catch(e => store.pushNotice(`clear failed: ${e?.message || e}`, 'error'));
        return true;
      case 'model':
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /model', 'warn');
          return false;
        }
        if (!arg) {
          openModelPicker();
          return true;
        }
        void store.setModel(arg)
          .then(ok => store.pushNotice(ok ? `✓ model → ${arg}` : 'model switch already in progress', ok ? 'info' : 'warn'))
          .catch((e) => store.pushNotice(`model switch failed: ${e?.message || e}`, 'error'));
        return true;
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
          .then(result => store.pushNotice(result ? `✓ effort → ${result}` : 'effort switch already in progress', result ? 'info' : 'warn'))
          .catch((e) => store.pushNotice(`effort switch failed: ${e?.message || e}`, 'error'));
        return true;
      case 'cwd': {
        const nextPath = arg.trim();
        if (!nextPath) {
          store.pushNotice(`cwd: ${state.cwd}`, 'info');
          return true;
        }
        try {
          store.setCwd?.(nextPath);
        } catch (e) {
          store.pushNotice(`cwd failed: ${e?.message || e}`, 'error');
        }
        return true;
      }
      case 'tools':
        openToolsPicker(arg.trim());
        return true;
      case 'bridge': {
        const mode = arg.trim().toLowerCase();
        if (!mode) {
          openBridgePicker();
          return true;
        }
        const control = parseBridgeControl(arg);
        if (control?.error) {
          store.pushNotice(control.error, 'warn');
          return true;
        }
        if (control) {
          void store.bridgeControl?.(control)
            .catch((e) => store.pushNotice(`bridge failed: ${e?.message || e}`, 'error'));
          return true;
        }
        if (mode !== 'sync' && mode !== 'async') {
          store.pushNotice('usage: /bridge [sync|async|list|status|read|cleanup|cancel|close]', 'warn');
          return true;
        }
        const next = store.setBridgeMode?.(mode);
        store.pushNotice(`✓ bridge mode → ${next || mode}`, 'info');
        return true;
      }
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
      case 'compact':
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /compact', 'warn');
          return false;
        }
        void store.compact()
          .then((r) => {
            if (!r) {
              store.pushNotice('compact failed', 'warn');
              return;
            }
            if (r.changed === false && r.reason) {
              store.pushNotice(r.reason, 'warn');
              return;
            }
            store.pushNotice(
              `✓ compacted context: ${r.beforeMessages}→${r.afterMessages} messages, ${r.beforeTokens}→${r.afterTokens} est tokens`,
              r.changed ? 'info' : 'warn',
            );
          })
          .catch((e) => store.pushNotice(`compact failed: ${e?.message || e}`, 'error'));
        return true;
      case 'new':
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /new', 'warn');
          return false;
        }
        void store.newSession()
          .then(() => store.pushNotice('✓ new session', 'info'))
          .catch((e) => store.pushNotice(`new session failed: ${e?.message || e}`, 'error'));
        return true;
      case 'resume':
        if (state.busy) {
          store.pushNotice('wait for the current turn to finish before /resume', 'warn');
          return false;
        }
        if (arg) {
          void store.resume(arg)
            .then(ok => store.pushNotice(ok ? `✓ resumed ${arg}` : 'resume failed', ok ? 'info' : 'warn'))
            .catch((e) => store.pushNotice(`resume failed: ${e?.message || e}`, 'error'));
        } else {
          openResumePicker();
        }
        return true;
      case 'status':
        openStatusPicker();
        return true;
      case 'context':
        openContextPicker();
        return true;
      case 'settings':
      case 'config':
        openSettingsPicker();
        return true;
      case 'exit':
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
      if (providerPrompt.kind === 'local-url') {
        try {
          store.setLocalProvider(providerPrompt.providerId, {
            enabled: true,
            baseURL: commandText || providerPrompt.defaultURL,
          });
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
    }
    if (channelPrompt) {
      if (state.commandBusy) {
        store.pushNotice('wait for the current command to finish', 'warn');
        return false;
      }
      try {
        if (channelPrompt.kind === 'discord-token') {
          if (!commandText) return false;
          store.saveDiscordToken(commandText);
          setChannelPrompt(null);
          void openChannelSetupPicker('all');
          return true;
        }
        if (channelPrompt.kind === 'webhook-token') {
          if (!commandText) return false;
          store.saveWebhookAuthtoken(commandText);
          setChannelPrompt(null);
          void openChannelSetupPicker('all');
          return true;
        }
        const parts = commandText.split('|').map((part) => part.trim());
        if (channelPrompt.kind === 'channel-add') {
          const [name, channelId, mode] = parts;
          store.saveChannel({ name, channelId, mode });
          setChannelPrompt(null);
          void openChannelSetupPicker('all');
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
          store.setCwd?.(commandText);
          setSettingsPrompt(null);
          void openSettingsPicker();
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
          resetTranscriptScroll();
          return store.submit(prompt);
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
      return runSlashCommand(cmd, rest.join(' ').trim());
    }
    resetTranscriptScroll();
    return store.submit(text);
  };

  const activeSlashQuery = providerPrompt || channelPrompt || hookPrompt || settingsPrompt || contextPanel ? null : slashQuery(promptDraft);
  const slashCommands = activeSlashQuery === null || picker || contextPanel || exiting || state.commandBusy
    ? []
    : SLASH_COMMANDS.filter((command) => slashCommandMatches(command, activeSlashQuery));
  const slashPaletteOpen = activeSlashQuery !== null
    && slashDismissedFor !== promptDraft
    && slashCommands.length > 0;
  slashPaletteRef.current = { open: slashPaletteOpen, count: slashCommands.length };

  useEffect(() => {
    setSlashIndex((index) => Math.min(index, Math.max(0, slashCommands.length - 1)));
  }, [slashCommands.length, activeSlashQuery]);

  const onPromptDraftChange = useCallback((value) => {
    // Only lift the draft into App state when it can affect the slash palette
    // (a single "/token"). Prose typing renders entirely inside PromptInput's
    // own state, so App need not re-render — and relayout the full fullscreen
    // frame — on every keystroke (input lag fix). Entering slash mode and
    // leaving it both still sync because either prev or next is a slash token.
    setPromptDraft((prev) =>
      slashQuery(value) !== null || slashQuery(prev) !== null ? value : prev);
    setPromptDraftOverride(null);
    if (value) clearPromptHint();
    setSlashDismissedFor((dismissed) => (dismissed && dismissed !== value ? '' : dismissed));
  }, [clearPromptHint]);

  const cancelProviderPrompt = useCallback(() => {
    const afterSave = providerPrompt?.afterSave;
    setProviderPrompt(null);
    if (afterSave) afterSave();
    else showPromptHint('canceled', 'cancel');
  }, [providerPrompt, showPromptHint]);

  const cancelChannelPrompt = useCallback(() => {
    setChannelPrompt(null);
    showPromptHint('canceled', 'cancel');
  }, [showPromptHint]);

  const cancelHookPrompt = useCallback(() => {
    setHookPrompt(null);
    showPromptHint('canceled', 'cancel');
  }, [showPromptHint]);

  const cancelSettingsPrompt = useCallback(() => {
    setSettingsPrompt(null);
    showPromptHint('canceled', 'cancel');
  }, [showPromptHint]);

  const acceptSlashPalette = useCallback(() => {
    const command = slashCommands[slashIndex];
    if (!command) return false;
    return runSlashCommand(command.name, '');
  }, [slashCommands, slashIndex]);

  const completeSlashPalette = useCallback(() => {
    const command = slashCommands[slashIndex];
    return command ? `/${command.name} ` : undefined;
  }, [slashCommands, slashIndex]);

  const cancelSlashPalette = useCallback((value = '') => {
    setSlashDismissedFor(String(value || promptDraft || '/'));
    setPromptDraft('');
    setPromptDraftOverride({ id: Date.now(), value: '' });
  }, [promptDraft]);

  const resizeEpoch = resizeState.epoch;

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
  //                  − input box       (marginTop 1 + 2 border + 1 content)
  //                  − statusline      (reserved L1 + L2 + marginBottom)
  //
  // Every sibling outside the viewport must be accounted for here; otherwise
  // the total tree height exceeds the terminal and the input box gets pushed.
  const textEntryPrompt = providerPrompt || channelPrompt || hookPrompt || settingsPrompt;
  const hasTextEntryPrompt = !!textEntryPrompt;
  const hasFloatingPanel = !!(picker || contextPanel || slashPaletteOpen || hasTextEntryPrompt);
  // The bottom input box is hidden only by panels that REPLACE the prompt
  // (picker / context panel / text-entry prompts). The slash palette floats
  // above the prompt instead of merging into it, so the input box stays.
  const inputBoxHidden = !!(picker || contextPanel || hasTextEntryPrompt);
  const WELCOME_ROWS = state.items.length === 0 && !hasFloatingPanel ? 11 : 0;
  // Independent reservation for each live-status child — the viewport must
  // yield enough space for every bottom sibling. ThinkingMessage: outer
  // marginTop(1) + inner marginTop(1) + "∴ Thinking…" label(1) = 3.
  // Spinner occupies marginTop(1) + content(1) = 2. TurnDone is no longer a
  // bottom sibling — it's a transcript item pinned after the turn's output, so
  // it lives inside the viewport and needs no separate reservation here.
  const THINKING_ROWS = state.thinking ? 3 : 0;
  const SPINNER_ROWS = state.spinner?.active ? 2 : 0;
  const SCROLL_HINT_ROWS = 0;
  const LIVE_STATUS_ROWS = THINKING_ROWS + SPINNER_ROWS;
  const INPUT_BOX_ROWS = inputBoxHidden ? 0 : 4;
  const STATUSLINE_ROWS = 3;
  const PANEL_MAX_VISIBLE = 8;
  const TEXT_ENTRY_ROWS = 5;
  const desiredFloatingPanelRows = picker
    ? Math.min(picker.items.length, PANEL_MAX_VISIBLE) + 4
    : contextPanel
      ? Math.min(contextPanel.rows?.length || 0, PANEL_MAX_VISIBLE + 1) + 4
    : slashPaletteOpen
      ? Math.min(slashCommands.length, PANEL_MAX_VISIBLE) + 3
      : hasTextEntryPrompt
        ? TEXT_ENTRY_ROWS
        : 0;
  const queuedRows = !hasFloatingPanel && state.queued?.length ? state.queued.length + 1 : 0;
  const baseReserve = WELCOME_ROWS + SCROLL_HINT_ROWS + LIVE_STATUS_ROWS + INPUT_BOX_ROWS + STATUSLINE_ROWS + queuedRows;
  const maxFloatingPanelRows = Math.max(0, resizeState.rows - baseReserve - 1);
  const floatingPanelRows = desiredFloatingPanelRows > 0
    ? Math.min(desiredFloatingPanelRows, maxFloatingPanelRows)
    : 0;
  const bottomReserve = baseReserve + floatingPanelRows;
  const viewportHeight = Math.max(1, resizeState.rows - bottomReserve);
  const latestToast = state.toasts?.length ? state.toasts[state.toasts.length - 1] : null;
  const toastHint = latestToast ? latestToast.text : '';
  const inputHint = promptHint || toastHint;
  const inputHintTone = promptHint ? promptHintTone : (latestToast?.tone || 'info');
  // Windows Terminal/conhost can scroll the alt-screen when a fullscreen frame
  // writes the bottom-right cell. Keep the whole app one cell narrower; it is
  // visually invisible but prevents frame drift and stale overprints.
  const frameColumns = Math.max(1, resizeState.columns - 1);
  // The hardware/IME caret is parked by PromptInput from its OWN measured box
  // position (ink useCursor + useBoxMetrics) — correct now that the transcript
  // is a live column, so the live-frame line count ink relies on is accurate.

  return (
    // Fullscreen layout: a full-height column (height = terminal rows) pins the
    // input cluster + statusline to the physical bottom (flexShrink={0}), while
    // the transcript fills the space above and is bottom-aligned so messages
    // stack up from just over the input. A top flexGrow spacer sinks the whole
    // stack to the bottom; the transcript itself is a fixed-height clipping
    // viewport (see viewportHeight above).
    <Box flexDirection="column" width={frameColumns} height={resizeState.rows}>
      {/* Empty-transcript header stays outside the bottom-anchored viewport and
          has its own reserved rows, so it cannot steal space from the input. */}
      {state.items.length === 0 && !hasFloatingPanel ? (
        <Box flexDirection="column" height={7} flexShrink={0} marginTop={3} marginBottom={1}>
          <Text color={theme.text} bold>{centerLine('███╗   ███╗██╗██╗  ██╗██████╗  ██████╗  ██████╗ ', frameColumns)}</Text>
          <Text color={theme.text} bold>{centerLine('████╗ ████║██║╚██╗██╔╝██╔══██╗██╔═══██╗██╔════╝ ', frameColumns)}</Text>
          <Text color={theme.claude} bold>{centerLine('██╔████╔██║██║ ╚███╔╝ ██║  ██║██║   ██║██║  ███╗', frameColumns)}</Text>
          <Text color={theme.claude} bold>{centerLine('██║╚██╔╝██║██║ ██╔██╗ ██║  ██║██║   ██║██║   ██║', frameColumns)}</Text>
          <Text color={theme.claude} bold>{centerLine('██║ ╚═╝ ██║██║██╔╝ ██╗██████╔╝╚██████╔╝╚██████╔╝', frameColumns)}</Text>
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
        {/* Wheel scroll: with the viewport bottom-anchored (flex-end), a NEGATIVE
            marginBottom pushes the transcript column DOWN past the bottom edge,
            bringing older content above the window into view (overflow hidden
            clips the newest rows that slide below). 0 = newest content pinned to
            the bottom. (marginTop has no effect under flex-end — the bottom edge
            stays fixed — so the scroll axis here is marginBottom, not marginTop.)
            scrollOffset is clamped ≥ 0 by the wheel handler; a new turn snaps it
            back to 0. */}
        <Box flexDirection="column" width="100%" flexShrink={0} marginBottom={-scrollOffset}>
          {state.items.map((item, i) => (
            <Item key={item.id} item={item} prevKind={i > 0 ? state.items[i - 1].kind : null} columns={frameColumns} toolOutputExpanded={toolOutputExpanded} />
          ))}
        </Box>
      </Box>

      {/* Live reasoning — streams just above the spinner while the turn runs,
          then collapses (engine clears state.thinking at turn end). marginTop
          keeps it off the last transcript row. Sits BELOW the viewport so it is
          never clipped. */}
      {state.thinking ? (
        <Box marginTop={1} flexShrink={0}>
          <ThinkingMessage text={state.thinking} />
        </Box>
      ) : null}

      {/* Wrapped flexShrink:0 so the live status keeps its full height and the
          viewport (flexShrink:1) yields rows to it, never the other way around —
          Spinner doesn't set flexShrink itself. TurnDone is now a transcript
          item (pinned after the turn's output), not a bottom-fixed slot. */}
      {state.spinner?.active ? (
        <Box flexShrink={0}>
          <Spinner
            verb={state.spinner.verb}
            startedAt={state.spinner.startedAt}
            outputTokens={Math.max(state.spinner?.outputTokens ?? 0, state.spinner?.liveTokens ?? 0)}
            thinking={!!(state.thinking || state.spinner?.thinking)}
            mode={state.spinner?.mode || 'responding'}
            columns={frameColumns}
          />
        </Box>
      ) : null}

      {/* Bottom bar — pinned to the physical bottom, never moves. Floating
          panels use their actual rendered height and shrink before the prompt
          can move; overflow is clipped from the top while the panel remains
          bottom-aligned against the prompt. */}
      <Box flexDirection="column" flexShrink={0}>
        {floatingPanelRows > 0 ? (
          <Box flexDirection="column" flexShrink={0} height={floatingPanelRows} overflow="hidden" justifyContent="flex-end">
            {picker ? (
              <Picker
                items={picker.items}
                onSelect={picker.onSelect}
                onBack={picker.onBack || picker.onCancel}
                onCancel={() => {
                  setPicker(null);
                  showPromptHint('canceled', 'cancel');
                }}
                onLeft={picker.onLeft}
                onRight={picker.onRight}
                title={picker.title}
                columns={frameColumns}
              />
            ) : contextPanel ? (
              <ContextPanel
                rows={contextPanel.rows}
                title={contextPanel.title}
                columns={frameColumns}
              />
            ) : slashPaletteOpen ? (
              <SlashCommandPalette
                commands={slashCommands}
                selectedIndex={slashIndex}
                title="Slash commands"
                columns={frameColumns}
              />
            ) : providerPrompt ? (
              <TextEntryPanel
                title={providerPrompt.kind === 'api-key' ? `API key · ${providerPrompt.label}` : `Base URL · ${providerPrompt.label}`}
                hint={providerPrompt.kind === 'api-key' ? 'Save or replace the provider key.' : `Default: ${providerPrompt.defaultURL}`}
                mask={providerPrompt.kind === 'api-key'}
                columns={frameColumns}
                onSubmit={onSubmit}
                onCancel={cancelProviderPrompt}
              />
            ) : channelPrompt ? (
              <TextEntryPanel
                title={channelPrompt.label}
                hint={channelPrompt.hint || 'Save channel setting.'}
                mask={channelPrompt.kind === 'discord-token' || channelPrompt.kind === 'webhook-token'}
                columns={frameColumns}
                onSubmit={onSubmit}
                onCancel={cancelChannelPrompt}
              />
            ) : hookPrompt ? (
              <TextEntryPanel
                title={hookPrompt.label}
                hint={hookPrompt.hint || 'Save hook setting.'}
                columns={frameColumns}
                onSubmit={onSubmit}
                onCancel={cancelHookPrompt}
              />
            ) : settingsPrompt ? (
              <TextEntryPanel
                title={settingsPrompt.label}
                hint={settingsPrompt.hint || 'Save setting.'}
                columns={frameColumns}
                actionLabel={settingsPrompt.kind === 'skill-use' ? 'run' : 'save'}
                onSubmit={onSubmit}
                onCancel={cancelSettingsPrompt}
              />
            ) : null}
          </Box>
        ) : (
          <QueuedCommands queued={state.queued} columns={frameColumns} />
        )}
        {!inputBoxHidden ? (
          <Box
            marginTop={hasFloatingPanel ? 0 : 1}
            width="100%"
            borderStyle="round"
            borderColor={theme.promptBorder}
            paddingX={1}
          >
            <PromptInput
              onSubmit={onSubmit}
              disabled={exiting || state.commandBusy || !!picker}
              onDraftChange={onPromptDraftChange}
              initialValue={promptDraft}
              draftOverride={promptDraftOverride}
              valueRef={promptValueRef}
              hint={inputHint}
              hintTone={inputHintTone}
              mask={false}
              onEscape={contextPanel ? () => setContextPanel(null) : undefined}
              commandPaletteActive={slashPaletteOpen}
              onCommandPaletteNavigate={(direction) => {
                setSlashIndex((index) => {
                  const total = slashCommands.length;
                  if (total === 0) return 0;
                  if (direction === 'home') return 0;
                  if (direction === 'end') return total - 1;
                  if (direction === 'right') return total - 1;
                  const step = Number(direction) || 0;
                  if (step === 1 || step === -1) return (index + step + total) % total;
                  return Math.max(0, Math.min(total - 1, index + step));
                });
              }}
              onCommandPaletteAccept={acceptSlashPalette}
              onCommandPaletteCancel={cancelSlashPalette}
              onCommandPaletteComplete={completeSlashPalette}
              submitPasteImmediately={state.busy}
            />
          </Box>
        ) : null}
        <StatusLine
          sessionId={state.sessionId}
          provider={state.provider}
          model={state.model}
          effort={state.effort}
          cwd={state.cwd}
          stats={state.stats}
          contextWindow={state.contextWindow}
          rawContextWindow={state.rawContextWindow}
          resizeEpoch={resizeEpoch}
          initialLine={initialStatusLine}
        />
      </Box>
    </Box>
  );
}
