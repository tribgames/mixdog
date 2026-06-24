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

const HELP = [
  'Slash commands:',
  '  /help            show this help',
  '  /clear           reset the conversation',
  '  /compact         compact older conversation context',
  '  /new             start a fresh session (closes current)',
  '  /resume [id]     resume a saved session (picker if no id)',
  '  /status          open session/runtime status dashboard',
  '  /settings        open configuration hub',
  '  /config          alias for /settings',
  '  /model <name>    switch model for subsequent turns (picker if no name)',
  '  /effort [level] set reasoning effort for the current model',
  '  /cwd [path]      show or set the session working directory',
  '  /tools [query]   inspect or enable deferred tools',
  '  /bridge <mode>   switch bridge default: sync | async',
  '  /bridge spawn <role> <prompt>',
  '  /bridge send <tag> <message>',
  '  /bridge list     show bridge workers and async jobs',
  '  /bridge read <id> read a finished/running async job snapshot',
  '  /mcp             manage MCP servers and tools',
  '  /skills          list and view available skills',
  '  /plugins         manage local plugin integrations',
  '  /hooks           manage before-tool hook rules and events',
  '  /providers       manage provider auth and local endpoints',
  '  /channels        manage Discord, channels, schedules, webhooks',
  '  /schedules       manage schedules',
  '  /webhooks        manage inbound webhooks',
  '  /auth <p> [key]  login OAuth provider or save API key',
  '  /auth-forget <p> remove an API-key provider secret',
  '  /memory [action] show memory status or run a memory action',
  '  /recall <query>  search stored memory directly',
  '  /exit, /quit     quit',
  'Picker: ↑/↓ navigate, Enter confirm, Escape cancel (attached above prompt).',
  'Ctrl+B toggles bridge sync/async. Ctrl+C exits. Ctrl+V/paste inserts text. Terminal drag/select/drop stays native. PageUp/PageDown scroll transcript. ↑/↓ recall history.',
].join('\n');

const SLASH_COMMANDS = [
  { name: 'help', usage: '/help', description: 'show slash command help' },
  { name: 'clear', usage: '/clear', description: 'reset the conversation' },
  { name: 'compact', usage: '/compact', description: 'compact older conversation context' },
  { name: 'new', usage: '/new', description: 'start a fresh session' },
  { name: 'resume', usage: '/resume', description: 'resume a saved session' },
  { name: 'status', usage: '/status', description: 'open session/runtime status dashboard' },
  { name: 'settings', usage: '/settings', description: 'open configuration hub' },
  { name: 'config', usage: '/config', description: 'open configuration hub' },
  { name: 'model', usage: '/model', description: 'switch model for subsequent turns' },
  { name: 'effort', usage: '/effort [level]', description: 'set reasoning effort for the current model' },
  { name: 'cwd', usage: '/cwd [path]', description: 'show or set the session working directory' },
  { name: 'tools', usage: '/tools [query]', description: 'inspect or enable deferred tools' },
  { name: 'bridge', usage: '/bridge [sync|async|spawn|send|list|read]', description: 'control bridge workers' },
  { name: 'mcp', usage: '/mcp', description: 'manage MCP servers and tools' },
  { name: 'skills', usage: '/skills', description: 'list and view available skills' },
  { name: 'plugins', usage: '/plugins', description: 'manage local plugin integrations' },
  { name: 'hooks', usage: '/hooks', description: 'manage before-tool hook rules and events' },
  { name: 'providers', usage: '/providers', description: 'manage provider auth and local endpoints' },
  { name: 'channels', usage: '/channels', description: 'manage Discord, channels, schedules, webhooks' },
  { name: 'schedules', usage: '/schedules', description: 'manage schedules' },
  { name: 'webhooks', usage: '/webhooks', description: 'manage inbound webhooks' },
  { name: 'auth', usage: '/auth', description: 'login OAuth provider or save API key' },
  { name: 'auth-forget', usage: '/auth-forget', description: 'remove an API-key provider secret' },
  { name: 'memory', usage: '/memory [status]', description: 'show memory runtime status' },
  { name: 'recall', usage: '/recall <query>', description: 'search stored memory' },
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

function fitLine(value, columns, reserve = 4) {
  const text = String(value || '');
  const width = Math.max(1, Number(columns || 80) - reserve);
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text;
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
    case 'tool': return <ToolExecution name={item.name} args={item.args} result={item.result} isError={item.isError} expanded={toolOutputExpanded || item.expanded} globalExpanded={toolOutputExpanded} columns={columns} attached={prevKind === 'tool'} />;
    case 'notice': return <NoticeMessage text={item.text} tone={item.tone} />;
    default: return null;
  }
});

function ToastNotice({ toast, columns }) {
  if (!toast) return null;
  const color = toast.tone === 'error' ? theme.error : toast.tone === 'warn' ? theme.warning : theme.inactive;
  const prefix = toast.tone === 'error' ? 'x' : toast.tone === 'warn' ? '!' : 'i';
  return (
    <Box flexShrink={0} paddingX={1}>
      <Box borderStyle="round" borderColor={color} paddingX={1} width="100%">
        <Text color={color}>{fitLine(`${prefix} ${toast.text}`, columns, 6)}</Text>
      </Box>
    </Box>
  );
}

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
  const [resizeState, setResizeState] = useState(() => ({ ...terminalSize(stdout), epoch: 0 }));
  // scrollOffset = how many transcript ROWS we've scrolled UP from the bottom
  // (0 = pinned to the latest, showing the newest content). Mouse wheel adjusts
  // it; a new turn / new items snap back to 0 (handled below).
  const [scrollOffset, setScrollOffset] = useState(0);
  // picker = null | { type, title, items, onSelect }
  // Rendered as an option panel attached directly above the bottom prompt.
  const [picker, setPicker] = useState(null);
  const [providerPrompt, setProviderPrompt] = useState(null);
  const [channelPrompt, setChannelPrompt] = useState(null);
  const [hookPrompt, setHookPrompt] = useState(null);
  const [settingsPrompt, setSettingsPrompt] = useState(null);
  const [promptDraft, setPromptDraft] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissedFor, setSlashDismissedFor] = useState('');
  const onboardingStartedRef = useRef(false);
  const onboardingRef = useRef({ defaultRoute: null, workflowRoutes: {}, providerModels: [] });
  // dragRef tracks an in-progress mouse text selection (see the mouse handler):
  // anchor = where the drag began, last = the latest cell, active = button held.
  const dragRef = useRef({ anchor: null, last: null, active: false });

  // Copy the currently-highlighted selection to the OS clipboard. ink's fork
  // refreshed store.getRenderSelectionText() on the synchronous render that the
  // final setSelection() triggered, so the text under the rect is ready to read.
  const copySelection = useCallback((rect) => {
    const text = store.getRenderSelectionText?.();
    if (!text || !text.trim()) return;
    copyToClipboard(text)
      .then(() => {
        const lines = text.split('\n').length;
        const chars = text.length;
        store.pushNotice(`📋 copied ${chars} char${chars === 1 ? '' : 's'}${lines > 1 ? ` · ${lines} lines` : ''}`, 'info');
      })
      .catch((e) => store.pushNotice(`copy failed: ${e?.message || e}`, 'error'));
    // Clear the highlight a beat after copying so the user sees what was taken.
    setTimeout(() => { store.setRenderSelection?.(null); }, 120);
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

  // Mouse handling. index.jsx enabled SGR mouse tracking (?1000h button + ?1002h
  // drag-motion + ?1006h SGR coords). Every event arrives as `\x1b[<b;col;rowM`
  // (press/motion) or `\x1b[<b;col;rowm` (release), 1-based col/row. We watch raw
  // stdin and split it two ways, both additive to ink's keyboard handling:
  //   • wheel (button 64 up / 65 down) → scroll the transcript
  //   • left-button (0) press → drag → release → in-app text selection + copy,
  //     OpenCode-style: capture stays on so wheel and drag-select coexist. We
  //     paint an inverse highlight via the ink fork (store.setRenderSelection)
  //     and copy the selected cells to the OS clipboard on release.
  // Because we run a true fullscreen alt-screen, the reported (row,col) maps 1:1
  // to ink's absolute output grid, so the selection rectangle needs no scroll/
  // viewport translation — we highlight exactly the cells the user sees.
  useEffect(() => {
    if (!inkInput || !isRawModeSupported) return undefined;
    // Match every SGR mouse event: button, col, row, and final M(press)/m(release).
    const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    const setSel = store.setRenderSelection;
    const normalize = (a, b) => {
      // Build an axis-aligned rectangle from the two drag endpoints. x and y MUST
      // be min/max'd INDEPENDENTLY — ordering by row and copying that point's x
      // breaks diagonal drags (e.g. dragging up-and-left), producing x1 > x2 so
      // the selection loop skips every cell and nothing highlights or copies.
      return {
        x1: Math.min(a.x, b.x),
        y1: Math.min(a.y, b.y),
        x2: Math.max(a.x, b.x),
        y2: Math.max(a.y, b.y),
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
        if (button === 64) { up += 1; continue; }
        if (button === 65) { down += 1; continue; }
        // Low 2 bits = button id; bit 5 (32) = motion-while-pressed flag.
        const baseButton = button & 3;
        const isMotion = (button & 32) !== 0;
        if (baseButton === 0 && press && !isMotion) {
          // Left-button press: begin a new selection anchored here.
          dragRef.current = { anchor: { x, y }, last: { x, y }, active: true };
          setSel?.({ x1: x, y1: y, x2: x, y2: y });
        } else if (baseButton === 0 && isMotion && dragRef.current.active) {
          // Drag motion: extend the selection to the current cell.
          dragRef.current.last = { x, y };
          setSel?.(normalize(dragRef.current.anchor, { x, y }));
        } else if (!press && dragRef.current.active) {
          // Button release while dragging: finalize with the release coordinate
          // (the SGR release event carries col/row), then copy.
          const { anchor } = dragRef.current;
          dragRef.current.active = false;
          const rect = normalize(anchor, { x, y });
          const empty = rect.x1 === rect.x2 && rect.y1 === rect.y2;
          if (empty) {
            setSel?.(null); // a plain click clears any prior highlight
          } else {
            // Push the final rect so ink re-renders and refreshes the selection
            // text synchronously, then read it back inside copySelection.
            setSel?.(rect);
            copySelection(rect);
          }
        }
      }
      if (up !== 0 || down !== 0) {
        const STEP = 3; // rows per wheel notch
        setScrollOffset((prev) => Math.max(0, prev + (up - down) * STEP));
      }
    };
    inkInput.on('input', onData);
    return () => { inkInput.off('input', onData); };
  }, [inkInput, isRawModeSupported, store, copySelection]);

  // Snap back to the latest content whenever the transcript grows (new message /
  // turn) so the user always sees fresh output after sending.
  useEffect(() => {
    setScrollOffset(0);
  }, [state.items.length]);

  // `exiting` removes the inline caret (PromptInput draws none when disabled) and
  // freezes input for the teardown frame, so the final frame is clean before ink
  // unmounts. Exit just past the render throttle window so that frame flushes.
  const requestExit = useCallback(() => {
    setExiting(true);
    setTimeout(() => { store.dispose?.(); exit(); }, 60);
  }, [store, exit]);

  // Ctrl+C → clean exit; ESC → interrupt the running turn (keeps the steering
  // queue). Only active on a real TTY (raw mode); in pipes/CI useInput throws.
  // This handler is registered before PromptInput's, so ESC is caught here while
  // a turn is busy; when idle it falls through (PromptInput may use it later).
  // Ctrl+O toggles the global tool-output expansion, matching the Claude/Pi
  // expectation that this is a view mode rather than a per-card hidden state.
  const toggleExpand = useCallback(() => {
    setToolOutputExpanded((expanded) => !expanded);
  }, []);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      requestExit();
      return;
    }
    if (key.ctrl && (input === 'b' || input === 'B')) {
      store.toggleBridgeMode?.();
      return;
    }
    if (key.ctrl && (input === 'o' || input === 'O')) {
      toggleExpand();
      return;
    }
    if (key.pageUp) {
      const pageRows = Math.max(3, Math.floor((resizeState.rows ?? 24) * 0.6));
      setScrollOffset((prev) => prev + pageRows);
      return;
    }
    if (key.pageDown) {
      const pageRows = Math.max(3, Math.floor((resizeState.rows ?? 24) * 0.6));
      setScrollOffset((prev) => Math.max(0, prev - pageRows));
      return;
    }
    if (key.ctrl && key.end) {
      setScrollOffset(0);
      return;
    }
    if (key.escape && state.busy && !picker) {
      if (store.abort()) {
        store.pushNotice('⎋ stopped — queued prompts kept (↑ to edit)', 'info');
      }
      return;
    }
    if (key.escape && !picker) {
      dragRef.current.active = false;
      store.setRenderSelection?.(null);
    }
  }, { isActive: isRawModeSupported });

  const modelDescription = (m) => {
    const meta = [];
    if (m.contextWindow) meta.push(`${Math.round(Number(m.contextWindow) / 1000)}k ctx`);
    if (m.supportsVision) meta.push('vision');
    const efforts = (m.effortOptions || []).map((e) => e.value).filter((v) => v && v !== 'auto');
    if (efforts.length) meta.push(`effort ${efforts.join('/')}`);
    if (m.latest) meta.push('latest');
    return [m.provider, ...meta].join(' · ');
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

  const openModelPicker = async () => {
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

    const items = providerModels.map((m) => {
      return {
        value: `${m.provider}:${m.id}`,
        label: m.display || m.id,
        description: modelDescription(m),
        _provider: m.provider,
        _modelId: m.id,
      };
    });

    setPicker({
      title: `Model (current: ${state.model})`,
      items,
      onSelect: (value, item) => {
        setPicker(null);
        void store.setRoute({ provider: item._provider, model: item._modelId })
          .then(ok => store.pushNotice(ok ? `✓ model → ${item._provider}/${item._modelId}` : 'model switch already in progress', ok ? 'info' : 'warn'))
          .catch((e) => store.pushNotice(`model switch failed: ${e?.message || e}`, 'error'));
      },
      onCancel: () => {
        setPicker(null);
        store.pushNotice('canceled', 'info');
      },
    });
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
        store.pushNotice('canceled', 'info');
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
        store.pushNotice('canceled', 'info');
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
                  .then(() => store.pushNotice(`copied tool name: ${tool.name}`, 'info'))
                  .catch((e) => store.pushNotice(`copy failed: ${e?.message || e}`, 'error'));
              }
            },
            onCancel: () => openToolsPicker(query),
          });
        }
      },
      onCancel: () => {
        setPicker(null);
        store.pushNotice('canceled', 'info');
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
    setPicker({
      title: 'Status',
      items: [
        {
          value: 'overview',
          label: 'Overview',
          description: `${state.provider}/${state.model} · ${state.effort || 'auto'} · ${state.cwd}`,
          _action: 'overview',
        },
        {
          value: 'settings',
          label: 'Settings',
          description: 'open configuration hub',
          _action: 'settings',
        },
        {
          value: 'tools',
          label: 'Tools',
          description: `${tools.activeCount || 0}/${tools.count || 0} active · mode ${tools.mode || state.toolMode}`,
          _action: 'tools',
        },
        {
          value: 'mcp',
          label: 'MCP',
          description: `${mcp.connectedCount || 0}/${mcp.configuredCount || 0} connected${mcp.failedCount ? ` · ${mcp.failedCount} failed` : ''}`,
          _action: 'mcp',
        },
        {
          value: 'hooks',
          label: 'Hooks',
          description: `${hooks.ruleCount || 0} rules · ${(hooks.recent || []).length} recent events`,
          _action: 'hooks',
        },
        {
          value: 'plugins',
          label: 'Plugins',
          description: `${plugins.count || 0} detected`,
          _action: 'plugins',
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
      ],
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action === 'overview') {
          store.pushNotice([
            `session: ${state.sessionId || '(none)'}`,
            `route: ${state.provider}/${state.model}`,
            `effort: ${state.effort || 'auto'}`,
            `cwd: ${state.cwd}`,
            `tools: ${tools.activeCount || 0}/${tools.count || 0}`,
            `mcp: ${mcp.connectedCount || 0}/${mcp.configuredCount || 0}${mcp.failedCount ? ` (${mcp.failedCount} failed)` : ''}`,
            `bridge: ${state.bridgeMode || 'sync'}`,
          ].join('\n'), 'info');
          return;
        }
        if (item._action === 'settings') openSettingsPicker();
        else if (item._action === 'tools') openToolsPicker();
        else if (item._action === 'mcp') openMcpPicker();
        else if (item._action === 'hooks') openHooksPicker();
        else if (item._action === 'plugins') openPluginsPicker();
        else if (item._action === 'skills') openSkillsPicker();
        else if (item._action === 'channels') void openChannelSetupPicker('all');
      },
      onCancel: () => {
        setPicker(null);
        store.pushNotice('canceled', 'info');
      },
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
        if (item._action === 'model') openModelPicker();
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
        store.pushNotice('canceled', 'info');
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
        else store.pushNotice('canceled', 'info');
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
    const models = onboardingRef.current.providerModels || [];
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

    const items = [
      {
        value: 'worker-status',
        label: 'Channel worker',
        description: (() => {
          const worker = store.getChannelWorkerStatus?.();
          return worker?.running ? `running · pid ${worker.pid}` : 'stopped';
        })(),
        _action: 'noop',
      },
      {
        value: 'discord-token',
        label: 'Discord token',
        description: `Bot token · ${setup.discord.status}${setup.discord.problem ? ' · invalid' : ''}`,
        _action: 'discord-token',
      },
      {
        value: 'webhook-token',
        label: 'Webhook auth',
        description: `ngrok/webhook authtoken · ${setup.webhook.status}`,
        _action: 'webhook-token',
      },
      {
        value: 'webhook-toggle',
        label: 'Webhook server',
        description: `${setup.webhook.enabled === false ? 'disabled' : 'enabled'} · port ${setup.webhook.port || 3333}`,
        _action: 'webhook-toggle',
      },
      { value: 'channel-add', label: 'Add channel', description: 'label | Discord channel id | mode', _action: 'channel-add' },
      { value: 'schedule-add', label: 'Add schedule', description: 'name | cron | instructions | channel | model', _action: 'schedule-add' },
      { value: 'webhook-add', label: 'Add webhook', description: 'name | instructions | channel | model | parser', _action: 'webhook-add' },
    ];

    if (focus !== 'schedules' && focus !== 'webhooks') {
      for (const ch of setup.channels || []) {
        items.push({
          value: `channel:${ch.name}`,
          label: `# ${ch.name}`,
          description: `${ch.channelId || '(unset)'} · ${ch.mode}${ch.main ? ' · main' : ''} · Enter delete`,
          _action: 'channel-delete',
          _name: ch.name,
        });
      }
    }
    if (focus !== 'webhooks') {
      for (const schedule of setup.schedules || []) {
        items.push({
          value: `schedule:${schedule.name}`,
          label: `↻ ${schedule.name}`,
          description: `${schedule.time || '(no cron)'} · ${schedule.route}${schedule.model ? ` · ${schedule.model}` : ''} · Enter delete`,
          _action: 'schedule-delete',
          _name: schedule.name,
        });
      }
    }
    if (focus !== 'schedules') {
      for (const hook of setup.webhooks || []) {
        items.push({
          value: `webhook:${hook.name}`,
          label: `⌁ ${hook.name}`,
          description: `${hook.parser || 'github'} · ${hook.route} · secret:${hook.secretSet ? 'set' : 'missing'} · Enter delete`,
          _action: 'webhook-delete',
          _name: hook.name,
        });
      }
    }

    setPicker({
      title: focus === 'schedules' ? 'Schedules' : focus === 'webhooks' ? 'Webhooks' : 'Channels',
      items,
      onSelect: (_value, item) => {
        setPicker(null);
        try {
          switch (item._action) {
            case 'discord-token':
              setPicker({
                title: 'Discord Token',
                items: [
                  { value: 'set', label: 'Set token', description: `current: ${setup.discord.status}`, _action: 'set' },
                  { value: 'forget', label: 'Forget token', description: 'remove stored Discord bot token', _action: 'forget' },
                ],
                onSelect: (_detailValue, detail) => {
                  setPicker(null);
                  if (detail._action === 'set') {
                    setChannelPrompt({ kind: 'discord-token', label: 'Discord bot token' });
                    return;
                  }
                  if (detail._action === 'forget') {
                    store.forgetDiscordToken?.();
                    void openChannelSetupPicker(focus);
                  }
                },
                onCancel: () => {
                  setPicker(null);
                  void openChannelSetupPicker(focus);
                },
              });
              return;
            case 'webhook-token':
              setPicker({
                title: 'Webhook Auth',
                items: [
                  { value: 'set', label: 'Set auth token', description: `current: ${setup.webhook.status}`, _action: 'set' },
                  { value: 'forget', label: 'Forget auth token', description: 'remove stored webhook/ngrok auth token', _action: 'forget' },
                ],
                onSelect: (_detailValue, detail) => {
                  setPicker(null);
                  if (detail._action === 'set') {
                    setChannelPrompt({ kind: 'webhook-token', label: 'Webhook/ngrok authtoken' });
                    return;
                  }
                  if (detail._action === 'forget') {
                    store.forgetWebhookAuthtoken?.();
                    void openChannelSetupPicker(focus);
                  }
                },
                onCancel: () => {
                  setPicker(null);
                  void openChannelSetupPicker(focus);
                },
              });
              return;
            case 'webhook-toggle':
              store.setWebhookConfig({ enabled: setup.webhook.enabled === false });
              void openChannelSetupPicker(focus);
              return;
            case 'channel-add':
              setChannelPrompt({ kind: 'channel-add', label: 'Channel', hint: 'name | channelId | interactive' });
              return;
            case 'schedule-add':
              setChannelPrompt({ kind: 'schedule-add', label: 'Schedule', hint: 'name | cron | instructions | channel(optional) | model(optional)' });
              return;
            case 'webhook-add':
              setChannelPrompt({ kind: 'webhook-add', label: 'Webhook', hint: 'name | instructions | channel(optional) | model(optional) | github' });
              return;
            case 'channel-delete':
              store.deleteChannel(item._name);
              void openChannelSetupPicker(focus);
              return;
            case 'schedule-delete':
              store.deleteSchedule(item._name);
              void openChannelSetupPicker(focus);
              return;
            case 'webhook-delete':
              store.deleteWebhook(item._name);
              void openChannelSetupPicker(focus);
              return;
            default:
              return;
          }
        } catch (e) {
          store.pushNotice(`channels update failed: ${e?.message || e}`, 'error');
        }
      },
      onCancel: () => {
        setPicker(null);
        store.pushNotice('canceled', 'info');
      },
    });
  };

  const openMcpPicker = () => {
    let status;
    try {
      status = store.mcpStatus?.() || { servers: [] };
    } catch (e) {
      store.pushNotice(`mcp status failed: ${e?.message || e}`, 'error');
      return;
    }
    const servers = status.servers || [];
    const items = [
      {
        value: 'reconnect',
        label: 'Reconnect all',
        description: `${status.connectedCount || 0}/${status.configuredCount || 0} connected${status.failedCount ? ` · ${status.failedCount} failed` : ''}`,
        _action: 'reconnect',
      },
    ];
    if (servers.length === 0) {
      items.push({
        value: 'empty',
        label: 'No MCP servers',
        description: 'Configure mcpServers in mixdog-config.json',
        _action: 'noop',
      });
    }
    for (const server of servers) {
      items.push({
        value: `server:${server.name}`,
        label: server.name,
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
      title: 'MCP',
      items,
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action === 'reconnect') {
          void store.reconnectMcp?.()
            .then(() => openMcpPicker())
            .catch((e) => store.pushNotice(`mcp reconnect failed: ${e?.message || e}`, 'error'));
          return;
        }
        if (item._action !== 'server') return;
        const server = item._server;
        if (server?.error) {
          store.pushNotice(`${server.name}: ${server.error}`, 'warn');
        }
        const tools = server?.tools || [];
        const toolItems = [
          {
            value: 'remove',
            label: 'Remove server',
            description: server?.configured ? 'delete from mcpServers and reconnect' : 'server is not configured',
            _action: server?.configured ? 'remove' : 'noop',
          },
          ...(tools.length
            ? tools.map((tool) => ({
                value: tool.name,
                label: tool.name.replace(/^mcp__[^_]+__/, ''),
                description: tool.description || tool.name,
                _action: 'tool',
                _tool: tool,
              }))
            : [{ value: 'empty', label: 'No tools', description: server?.connected ? 'server returned no tools' : 'server is not connected', _action: 'noop' }]),
        ];
        setPicker({
          title: `MCP · ${server?.name || 'server'}`,
          items: toolItems,
          onSelect: (_toolValue, toolItem) => {
            setPicker(null);
            if (toolItem._action === 'remove') {
              void store.removeMcpServer?.(server.name)
                .then(() => openMcpPicker())
                .catch((e) => store.pushNotice(`mcp remove failed: ${e?.message || e}`, 'error'));
              return;
            }
            if (toolItem._action === 'tool') {
              const tool = toolItem._tool;
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
                      .then(() => store.pushNotice(`copied MCP tool: ${tool.name}`, 'info'))
                      .catch((e) => store.pushNotice(`copy failed: ${e?.message || e}`, 'error'));
                  }
                },
                onCancel: () => openMcpPicker(),
              });
            }
          },
          onCancel: () => openMcpPicker(),
        });
      },
      onCancel: () => {
        setPicker(null);
        store.pushNotice('canceled', 'info');
      },
    });
  };

  const openSkillsPicker = () => {
    let status;
    try {
      status = store.skillsStatus?.() || { skills: [] };
    } catch (e) {
      store.pushNotice(`skills status failed: ${e?.message || e}`, 'error');
      return;
    }
    const skills = status.skills || [];
    const items = [
      {
        value: 'reload',
        label: 'Reload skills',
        description: `${status.count || 0} available · ${status.cwd || ''}`,
        _action: 'reload',
      },
    ];
    if (skills.length === 0) {
      items.push({
        value: 'empty',
        label: 'No skills',
        description: 'Add SKILL.md files under user, project, or plugin skills directories',
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
      title: 'Skills',
      items,
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action === 'reload') {
          void store.reloadSkills?.()
            .then(() => openSkillsPicker())
            .catch((e) => store.pushNotice(`skills reload failed: ${e?.message || e}`, 'error'));
          return;
        }
        if (item._action !== 'view') return;
        openSkillDetailPicker(item._skill);
      },
      onCancel: () => {
        setPicker(null);
        store.pushNotice('canceled', 'info');
      },
    });
  };

  const openSkillDetailPicker = (skill) => {
    setPicker({
      title: `Skill · ${skill.name}`,
      items: [
        {
          value: 'view',
          label: 'View skill',
          description: skill.description || skill.filePath || 'preview SKILL.md content',
          _action: 'view',
        },
        {
          value: 'copy-content',
          label: 'Copy content',
          description: 'copy full skill content to clipboard',
          _action: 'copy-content',
        },
        {
          value: 'copy-path',
          label: 'Copy path',
          description: skill.filePath || 'no file path available',
          _action: skill.filePath ? 'copy-path' : 'noop',
        },
      ],
      onSelect: (_value, item) => {
        setPicker(null);
        try {
          const result = store.skillContent?.(skill.name);
          const body = String(result?.content || '').trim();
          if (item._action === 'view') {
            const max = 2200;
            const preview = body.length > max ? `${body.slice(0, max)}\n\n... (${body.length - max} more chars)` : body;
            store.pushNotice(`# ${skill.name}\n${preview || '(empty skill)'}`, 'info');
            return;
          }
          if (item._action === 'copy-content') {
            void copyToClipboard(body)
              .then(() => store.pushNotice(`copied skill content: ${skill.name}`, 'info'))
              .catch((e) => store.pushNotice(`copy failed: ${e?.message || e}`, 'error'));
            return;
          }
          if (item._action === 'copy-path') {
            void copyToClipboard(skill.filePath)
              .then(() => store.pushNotice(`copied skill path: ${skill.name}`, 'info'))
              .catch((e) => store.pushNotice(`copy failed: ${e?.message || e}`, 'error'));
          }
        } catch (e) {
          store.pushNotice(`skill action failed: ${e?.message || e}`, 'error');
        }
      },
      onCancel: () => {
        setPicker(null);
        void openSkillsPicker();
      },
    });
  };

  const openPluginsPicker = () => {
    let status;
    try {
      status = store.pluginsStatus?.() || { plugins: [] };
    } catch (e) {
      store.pushNotice(`plugins status failed: ${e?.message || e}`, 'error');
      return;
    }
    const plugins = status.plugins || [];
    const items = [
      {
        value: 'reload',
        label: 'Reload plugins',
        description: `${status.count || 0} detected`,
        _action: 'reload',
      },
    ];
    if (plugins.length === 0) {
      items.push({
        value: 'empty',
        label: 'No plugins',
        description: 'No local marketplace/cache plugins detected',
        _action: 'noop',
      });
    }
    for (const plugin of plugins) {
      items.push({
        value: `${plugin.source}:${plugin.name}:${plugin.version || ''}`,
        label: plugin.title || plugin.name,
        description: `${plugin.source}${plugin.marketplace ? ` · ${plugin.marketplace}` : ''}${plugin.version ? ` · ${plugin.version}` : ''} · skills ${plugin.skillCount || 0}${plugin.mcpScript ? ` · mcp ${plugin.mcpEnabled ? 'enabled' : plugin.mcpScript}` : ''}`,
        _action: 'plugin',
        _plugin: plugin,
      });
    }
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setPicker({
      title: 'Plugins',
      items,
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._action === 'reload') {
          void store.reloadPlugins?.()
            .then(() => openPluginsPicker())
            .catch((e) => store.pushNotice(`plugins reload failed: ${e?.message || e}`, 'error'));
          return;
        }
        if (item._action !== 'plugin') return;
        const p = item._plugin;
        setPicker({
          title: p.title || p.name,
          items: [
            {
              value: 'info',
              label: 'Plugin info',
              description: `${p.source}${p.version ? ` · ${p.version}` : ''} · skills ${p.skillCount || 0}`,
              _action: 'info',
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
          ],
          onSelect: (_detailValue, detail) => {
            setPicker(null);
            if (detail._action === 'info') {
              store.pushNotice([
                `${p.title || p.name}${p.version ? ` ${p.version}` : ''}`,
                `source: ${p.source}${p.marketplace ? ` / ${p.marketplace}` : ''}`,
                `skills: ${p.skillCount || 0}`,
                `mcp: ${p.mcpScript ? `${p.mcpEnabled ? 'enabled' : 'available'} (${p.mcpServerName || 'plugin-mcp'})` : '(none)'}`,
                `root: ${p.root}`,
                p.description ? `\n${p.description}` : '',
              ].filter(Boolean).join('\n'), 'info');
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
                .then(() => store.pushNotice(`copied plugin root: ${p.name}`, 'info'))
                .catch((e) => store.pushNotice(`copy failed: ${e?.message || e}`, 'error'));
              return;
            }
            if (detail._action === 'copy-mcp-name') {
              void copyToClipboard(p.mcpServerName || '')
                .then(() => store.pushNotice(`copied plugin MCP server: ${p.mcpServerName}`, 'info'))
                .catch((e) => store.pushNotice(`copy failed: ${e?.message || e}`, 'error'));
            }
          },
          onCancel: () => {
            setPicker(null);
            void openPluginsPicker();
          },
        });
      },
      onCancel: () => {
        setPicker(null);
        store.pushNotice('canceled', 'info');
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
              .then(() => store.pushNotice(`copied hook rule ${rule.index + 1}`, 'info'))
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
    const recent = status.recent || [];
    const rules = status.rules || [];
    const items = [
      {
        value: 'add',
        label: 'Add before-tool rule',
        description: 'tool | action | match | reason | json patch',
        _action: 'add',
      },
      {
        value: 'summary',
        label: status.enabled ? 'Hook bus enabled' : 'Hook bus disabled',
        description: `${status.mode || 'unknown'} · rules ${status.ruleCount || 0} · ${recent.length} recent events`,
        _action: 'summary',
      },
      ...(rules.length ? rules.map((rule) => ({
        value: `rule:${rule.index}`,
        label: `${rule.enabled ? '●' : '○'} ${rule.tool} -> ${rule.action}`,
        description: `${rule.match ? `match ${rule.match} · ` : ''}${rule.reason || 'Enter options'}`,
        _action: 'rule',
        _rule: rule,
      })) : [{
        value: 'rules:none',
        label: 'No rules',
        description: status.rulesPath || 'hooks.json not configured',
        _action: 'noop',
      }]),
      ...recent.slice(0, 30).map((event, index) => ({
        value: `event:${index}`,
        label: event.name,
        description: `${event.ts || ''}${event.summary ? ` · ${event.summary}` : ''}`,
        _action: 'event',
        _event: event,
      })),
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
        if (item._action === 'add') {
          setHookPrompt({ kind: 'rule-add', label: 'Hook rule', hint: 'tool | allow|deny|modify | match | reason | {"arg":"value"}' });
          return;
        }
        if (item._action === 'summary') {
          store.pushNotice([
            `mode: ${status.mode || 'unknown'}`,
            `rules path: ${status.rulesPath || '(none)'}`,
            `rules: ${status.ruleCount || 0}`,
            `events: ${(status.events || []).join(', ') || '(none)'}`,
            `counts: ${JSON.stringify(status.counts || {})}`,
            status.note || '',
          ].filter(Boolean).join('\n'), 'info');
          return;
        }
        if (item._action === 'rule') {
          openHookRulePicker(item._rule);
          return;
        }
        if (item._action === 'event') {
          setPicker({
            title: `Hook event · ${item._event.name}`,
            items: [
              {
                value: 'view',
                label: 'View event',
                description: item._event.summary || item._event.ts || '',
                _action: 'view',
              },
              {
                value: 'copy',
                label: 'Copy event JSON',
                description: item._event.ts || '',
                _action: 'copy',
              },
            ],
            onSelect: (_detailValue, detail) => {
              setPicker(null);
              const body = JSON.stringify(item._event, null, 2);
              if (detail._action === 'view') {
                store.pushNotice(body, 'info');
                return;
              }
              if (detail._action === 'copy') {
                void copyToClipboard(body)
                  .then(() => store.pushNotice(`copied hook event: ${item._event.name}`, 'info'))
                  .catch((e) => store.pushNotice(`copy failed: ${e?.message || e}`, 'error'));
              }
            },
            onCancel: () => openHooksPicker(),
          });
        }
      },
      onCancel: () => {
        setPicker(null);
        store.pushNotice('canceled', 'info');
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
    const items = sessions.map((s) => ({
      value: s.id,
      label: s.id.length > 28 ? s.id.slice(0, 25) + '…' : s.id,
      description: `${s.messageCount} msgs${s.preview ? ' · ' + s.preview.slice(0, 50).replace(/\n/g, ' ') : ''}`,
    }));
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
        store.pushNotice('canceled', 'info');
      },
    });
  };

  const runSlashCommand = (cmd, arg = '') => {
    switch (cmd) {
      case 'help': store.pushNotice(HELP, 'info'); return true;
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
      case 'auth': {
        const [providerId, ...secretParts] = arg.split(/\s+/).filter(Boolean);
        if (!providerId) {
          store.pushNotice('usage: /auth <provider> [api-key]', 'warn');
          return true;
        }
        if (secretParts.length === 0) {
          void store.loginOAuthProvider(providerId)
            .catch((e) => {
              if (/unknown OAuth provider/i.test(String(e?.message || e))) {
                setProviderPrompt({ kind: 'api-key', providerId, label: providerId });
              } else {
                store.pushNotice(`auth failed: ${e?.message || e}`, 'error');
              }
            });
        } else {
          try {
            store.saveProviderApiKey(providerId, secretParts.join(' '));
          } catch (e) {
            store.pushNotice(`auth failed: ${e?.message || e}`, 'error');
          }
        }
        return true;
      }
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
      case 'settings':
      case 'config':
        openSettingsPicker();
        return true;
      case 'exit':
      case 'quit':
        requestExit();
        return true;
      default:
        store.pushNotice(`unknown command: /${cmd} (try /help)`, 'warn');
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
    return store.submit(text);
  };

  const activeSlashQuery = providerPrompt || channelPrompt || hookPrompt || settingsPrompt ? null : slashQuery(promptDraft);
  const slashCommands = activeSlashQuery === null || picker || exiting || state.commandBusy
    ? []
    : SLASH_COMMANDS.filter((command) => slashCommandMatches(command, activeSlashQuery));
  const slashPaletteOpen = activeSlashQuery !== null
    && slashDismissedFor !== promptDraft
    && slashCommands.length > 0;

  useEffect(() => {
    setSlashIndex((index) => Math.min(index, Math.max(0, slashCommands.length - 1)));
  }, [slashCommands.length, activeSlashQuery]);

  const onPromptDraftChange = useCallback((value) => {
    setPromptDraft(value);
    setSlashDismissedFor((dismissed) => (dismissed && dismissed !== value ? '' : dismissed));
  }, []);

  const cancelProviderPrompt = useCallback(() => {
    const afterSave = providerPrompt?.afterSave;
    setProviderPrompt(null);
    if (afterSave) afterSave();
    else store.pushNotice('canceled', 'info');
  }, [providerPrompt, store]);

  const cancelChannelPrompt = useCallback(() => {
    setChannelPrompt(null);
    store.pushNotice('canceled', 'info');
  }, [store]);

  const cancelHookPrompt = useCallback(() => {
    setHookPrompt(null);
    store.pushNotice('canceled', 'info');
  }, [store]);

  const cancelSettingsPrompt = useCallback(() => {
    setSettingsPrompt(null);
    store.pushNotice('canceled', 'info');
  }, [store]);

  const acceptSlashPalette = useCallback(() => {
    const command = slashCommands[slashIndex];
    if (!command) return false;
    return runSlashCommand(command.name, '');
  }, [slashCommands, slashIndex]);

  const completeSlashPalette = useCallback(() => {
    const command = slashCommands[slashIndex];
    return command ? `/${command.name} ` : undefined;
  }, [slashCommands, slashIndex]);

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
  const WELCOME_ROWS = state.items.length === 0 ? 3 : 0;
  // Independent reservation for each live-status child — the viewport must
  // yield enough space for every bottom sibling. ThinkingMessage: outer
  // marginTop(1) + inner marginTop(1) + "∴ Thinking…" label(1) = 3.
  // Spinner / TurnDone each occupy marginTop(1) + content(1) = 2 and are
  // mutually exclusive in rendering (spinner wins when both are set).
  const THINKING_ROWS = state.thinking ? 3 : 0;
  const SPINNER_ROWS = state.spinner?.active ? 2 : 0;
  const TURNDONE_ROWS = state.lastTurn && !state.spinner?.active ? 2 : 0;
  const SCROLL_HINT_ROWS = scrollOffset > 0 ? 1 : 0;
  const LIVE_STATUS_ROWS = THINKING_ROWS + SPINNER_ROWS + TURNDONE_ROWS;
  const INPUT_BOX_ROWS = 4;
  const STATUSLINE_ROWS = 3;
  const FLOATING_PANEL_ROWS = 12; // MAX_VISIBLE(8) + header/border/count room.
  const PROMPT_HINT_ROWS = 1;
  const floatingPanelRows = picker || slashPaletteOpen
    ? FLOATING_PANEL_ROWS
    : providerPrompt || channelPrompt || hookPrompt || settingsPrompt
      ? PROMPT_HINT_ROWS
      : 0;
  const TOAST_ROWS = state.toasts?.length ? 3 : 0;
  const queuedRows = !picker && !slashPaletteOpen && !providerPrompt && !channelPrompt && !hookPrompt && !settingsPrompt && state.queued?.length ? state.queued.length + 1 : 0;
  const bottomReserve = WELCOME_ROWS + SCROLL_HINT_ROWS + floatingPanelRows + TOAST_ROWS + LIVE_STATUS_ROWS + INPUT_BOX_ROWS + STATUSLINE_ROWS + queuedRows;
  const viewportHeight = Math.max(1, resizeState.rows - bottomReserve);
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
    <Box flexDirection="column" width={resizeState.columns} height={resizeState.rows}>
      {/* Empty-transcript header stays outside the bottom-anchored viewport and
          has its own reserved rows, so it cannot steal space from the input. */}
      {state.items.length === 0 ? (
        <Box flexDirection="column" height={1} flexShrink={0} marginTop={1} marginBottom={1}>
          <Text>
            <Text color={theme.text}>{TURN_MARKER} </Text>
            <Text color={theme.text}>mixdog-cli</Text>
            <Text color={theme.inactive}>{`  ${state.provider}/${state.model}`}</Text>
          </Text>
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
        <Box flexDirection="column" width="100%" marginBottom={-scrollOffset}>
          {state.items.map((item, i) => (
            <Item key={item.id} item={item} prevKind={i > 0 ? state.items[i - 1].kind : null} columns={resizeState.columns} toolOutputExpanded={toolOutputExpanded} />
          ))}
        </Box>
      </Box>

      {scrollOffset > 0 ? (
        <Box flexShrink={0} paddingLeft={2}>
          <Text color={theme.subtle}>{`↑ scrollback ${scrollOffset} rows · wheel/PageDown to latest · Ctrl+End jump`}</Text>
        </Box>
      ) : null}

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
          Spinner/TurnDone don't set flexShrink themselves. */}
      {state.spinner?.active ? (
        <Box flexShrink={0}>
          <Spinner
            verb={state.spinner.verb}
            startedAt={state.spinner.startedAt}
            inputTokens={state.spinner?.inputTokens ?? 0}
            outputTokens={Math.max(state.spinner?.outputTokens ?? 0, state.spinner?.liveTokens ?? 0)}
            thinking={!!state.thinking}
            columns={resizeState.columns}
          />
        </Box>
      ) : state.lastTurn ? (
        <Box flexShrink={0}>
          <TurnDone elapsedMs={state.lastTurn.elapsedMs} />
        </Box>
      ) : null}

      {/* Bottom bar — pinned to the physical bottom, never moves. A fixed-height
          floating slot keeps the prompt/status y-position stable while pickers
          grow/shrink; the active panel is bottom-aligned inside the slot so it
          still attaches directly above the prompt like Codex/OpenCode. */}
      <Box flexDirection="column" flexShrink={0}>
        {state.toasts?.length ? (
          <ToastNotice toast={state.toasts[state.toasts.length - 1]} columns={resizeState.columns} />
        ) : null}
        {floatingPanelRows > 0 ? (
          <Box flexDirection="column" flexShrink={0} height={floatingPanelRows} justifyContent="flex-end">
            {picker ? (
              <Picker
                items={picker.items}
                onSelect={picker.onSelect}
                onCancel={picker.onCancel}
                title={picker.title}
                columns={resizeState.columns}
              />
            ) : slashPaletteOpen ? (
              <SlashCommandPalette
                commands={slashCommands}
                selectedIndex={slashIndex}
                title="Slash commands"
                columns={resizeState.columns}
              />
            ) : providerPrompt ? (
              <Box flexShrink={0} paddingX={1}>
                <Text color={theme.inactive}>
                  {fitLine(providerPrompt.kind === 'api-key'
                    ? `API key for ${providerPrompt.label} · Enter save · Esc cancel`
                    : `Base URL for ${providerPrompt.label} · Enter enable · Esc cancel · default ${providerPrompt.defaultURL}`, resizeState.columns)}
                </Text>
              </Box>
            ) : channelPrompt ? (
              <Box flexShrink={0} paddingX={1}>
                <Text color={theme.inactive}>
                  {fitLine(channelPrompt.hint
                    ? `${channelPrompt.label} · ${channelPrompt.hint} · Enter save · Esc cancel`
                    : `${channelPrompt.label} · Enter save · Esc cancel`, resizeState.columns)}
                </Text>
              </Box>
            ) : hookPrompt ? (
              <Box flexShrink={0} paddingX={1}>
                <Text color={theme.inactive}>
                  {fitLine(hookPrompt.hint
                    ? `${hookPrompt.label} · ${hookPrompt.hint} · Enter save · Esc cancel`
                    : `${hookPrompt.label} · Enter save · Esc cancel`, resizeState.columns)}
                </Text>
              </Box>
            ) : settingsPrompt ? (
              <Box flexShrink={0} paddingX={1}>
                <Text color={theme.inactive}>
                  {fitLine(settingsPrompt.hint
                    ? `${settingsPrompt.label} · ${settingsPrompt.hint} · Enter save · Esc cancel`
                    : `${settingsPrompt.label} · Enter save · Esc cancel`, resizeState.columns)}
                </Text>
              </Box>
            ) : null}
          </Box>
        ) : (
          <QueuedCommands queued={state.queued} columns={resizeState.columns} />
        )}
        <Box
          marginTop={picker || slashPaletteOpen || providerPrompt || channelPrompt || hookPrompt || settingsPrompt ? 0 : 1}
          width="100%"
          borderStyle="round"
          borderColor={state.busy || state.commandBusy || picker ? theme.subtle : theme.promptBorder}
          paddingX={1}
        >
          <PromptInput
            onSubmit={onSubmit}
            disabled={exiting || state.commandBusy || !!picker}
            onDraftChange={onPromptDraftChange}
            mask={providerPrompt?.kind === 'api-key' || channelPrompt?.kind === 'discord-token' || channelPrompt?.kind === 'webhook-token'}
            onEscape={providerPrompt ? cancelProviderPrompt : channelPrompt ? cancelChannelPrompt : hookPrompt ? cancelHookPrompt : settingsPrompt ? cancelSettingsPrompt : undefined}
            commandPaletteActive={slashPaletteOpen}
            onCommandPaletteNavigate={(direction) => {
              setSlashIndex((index) => {
                const total = slashCommands.length;
                if (total === 0) return 0;
                if (direction === 'home') return 0;
                if (direction === 'end') return total - 1;
                const step = Number(direction) || 0;
                return Math.max(0, Math.min(total - 1, index + step));
              });
            }}
            onCommandPaletteAccept={acceptSlashPalette}
            onCommandPaletteCancel={(value) => setSlashDismissedFor(value)}
            onCommandPaletteComplete={completeSlashPalette}
          />
        </Box>
        <StatusLine
          sessionId={state.sessionId}
          provider={state.provider}
          model={state.model}
          effort={state.effort}
          cwd={state.cwd}
          stats={state.stats}
          resizeEpoch={resizeEpoch}
          initialLine={initialStatusLine}
        />
      </Box>
    </Box>
  );
}
