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
import { MAX_RESULT_LINES } from './components/ToolExecution.jsx';

const HELP = [
  'Slash commands:',
  '  /help            show this help',
  '  /clear           reset the conversation',
  '  /compact         compact older conversation context',
  '  /new             start a fresh session (closes current)',
  '  /resume [id]     resume a saved session (picker if no id)',
  '  /model <name>    switch model for subsequent turns (picker if no name)',
  '  /mode <name>     switch tool surface: full | readonly',
  '  /providers       manage provider auth and local endpoints',
  '  /auth <p> [key]  login OAuth provider or save API key',
  '  /auth-forget <p> remove an API-key provider secret',
  '  /exit, /quit     quit',
  'Picker: ↑/↓ navigate, Enter confirm, Escape cancel (attached above prompt).',
  'Ctrl+C exits. Drag with the mouse to select & auto-copy. ↑/↓ recall history.',
].join('\n');

const SLASH_COMMANDS = [
  { name: 'help', usage: '/help', description: 'show slash command help' },
  { name: 'clear', usage: '/clear', description: 'reset the conversation' },
  { name: 'compact', usage: '/compact', description: 'compact older conversation context' },
  { name: 'new', usage: '/new', description: 'start a fresh session' },
  { name: 'resume', usage: '/resume', description: 'resume a saved session' },
  { name: 'model', usage: '/model', description: 'switch model for subsequent turns' },
  { name: 'mode', usage: '/mode', description: 'switch tool surface' },
  { name: 'providers', usage: '/providers', description: 'manage provider auth and local endpoints' },
  { name: 'auth', usage: '/auth', description: 'login OAuth provider or save API key' },
  { name: 'auth-forget', usage: '/auth-forget', description: 'remove an API-key provider secret' },
  { name: 'exit', usage: '/exit', description: 'quit the TUI' },
  { name: 'quit', usage: '/quit', description: 'quit the TUI' },
];

function slashQuery(value) {
  const text = String(value ?? '');
  if (!/^\/[^\s]*$/.test(text)) return null;
  return text.slice(1).toLowerCase();
}

function terminalSize(stdout) {
  return {
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  };
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

const Item = React.memo(function Item({ item, prevKind, columns }) {
  switch (item.kind) {
    case 'user': return <UserMessage text={item.text} attached={prevKind === 'user'} columns={columns} />;
    case 'assistant': return <AssistantMessage text={item.text} />;
    case 'tool': return <ToolExecution name={item.name} args={item.args} result={item.result} isError={item.isError} expanded={item.expanded} />;
    case 'notice': return <NoticeMessage text={item.text} tone={item.tone} />;
    default: return null;
  }
});

export function App({ store, initialStatusLine = '' }) {
  const state = useEngine(store);
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
  const [promptDraft, setPromptDraft] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissedFor, setSlashDismissedFor] = useState('');
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
  // Ctrl+O toggles expansion on the latest expandable tool result.
  const toggleExpand = useCallback(() => {
    const items = state.items;
    // Walk backwards — the latest tool item with overflow is the target.
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === 'tool' && item.result != null) {
        const lines = String(item.result).split('\n');
        if (lines.length > MAX_RESULT_LINES) {
          store.patchItem(item.id, { expanded: !item.expanded });
          break;
        }
      }
    }
  }, [state.items, store]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      requestExit();
      return;
    }
    if (key.ctrl && (input === 'o' || input === 'O')) {
      toggleExpand();
      return;
    }
    if (key.escape && state.busy && !picker) {
      if (store.abort()) {
        store.pushNotice('⎋ stopped — queued prompts kept (↑ to edit)', 'info');
      }
    }
  }, { isActive: isRawModeSupported });

  const openModelPicker = async () => {
    let providerModels = [];
    try {
      providerModels = await store.listProviderModels();
    } catch (e) {
      store.pushNotice(`could not list models: ${e?.message || e}`, 'error');
      return;
    }

    if (!providerModels || providerModels.length === 0) {
      store.pushNotice(`current model: ${state.model} (no provider models available)`, 'info');
      return;
    }

    const items = providerModels.map((m) => ({
      value: `${m.provider}:${m.id}`,
      label: m.display || m.id,
      description: m.provider,
      _provider: m.provider,
      _modelId: m.id,
    }));

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

  const openModePicker = () => {
    const modes = [
      { value: 'full', label: 'full', description: 'all configured tools' },
      { value: 'readonly', label: 'readonly', description: 'read-only tool surface' },
    ];
    setPicker({
      title: `Mode (current: ${state.toolMode || 'full'})`,
      items: modes,
      onSelect: (value) => {
        setPicker(null);
        store.setToolMode(value);
        store.pushNotice(`✓ mode → ${value}`, 'info');
      },
      onCancel: () => {
        setPicker(null);
        store.pushNotice('canceled', 'info');
      },
    });
  };

  const openProviderSetupPicker = async () => {
    let setup;
    try {
      setup = await store.getProviderSetup();
    } catch (e) {
      store.pushNotice(`providers failed: ${e?.message || e}`, 'error');
      return;
    }

    const items = [];
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
    setPicker({
      title: 'Providers',
      items,
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._type === 'api-key') {
          setProviderPrompt({
            kind: 'api-key',
            providerId: item._providerId,
            label: item._providerName,
          });
          return;
        }
        if (item._type === 'oauth') {
          void store.loginOAuthProvider(item._providerId)
            .then(() => openProviderSetupPicker())
            .catch((e) => store.pushNotice(`oauth login failed: ${e?.message || e}`, 'error'));
          return;
        }
        if (item._type === 'local') {
          if (item._enabled) {
            try {
              store.setLocalProvider(item._providerId, { enabled: false, baseURL: item._baseURL });
              void openProviderSetupPicker();
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
      case 'mode':
        if (!arg) {
          openModePicker();
          return true;
        }
        store.setToolMode(arg);
        store.pushNotice(`✓ mode → ${arg}`, 'info');
        return true;
      case 'providers':
        void openProviderSetupPicker();
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
          setProviderPrompt(null);
          void openProviderSetupPicker();
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
          setProviderPrompt(null);
          void openProviderSetupPicker();
          return true;
        } catch (e) {
          store.pushNotice(`local provider update failed: ${e?.message || e}`, 'error');
          return false;
        }
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

  const activeSlashQuery = providerPrompt ? null : slashQuery(promptDraft);
  const slashCommands = activeSlashQuery === null || picker || exiting || state.commandBusy
    ? []
    : SLASH_COMMANDS.filter((command) => {
      const needle = activeSlashQuery;
      return command.name.includes(needle) || command.usage.toLowerCase().includes(needle);
    });
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
    setProviderPrompt(null);
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
  const LIVE_STATUS_ROWS = THINKING_ROWS + SPINNER_ROWS + TURNDONE_ROWS;
  const INPUT_BOX_ROWS = 4;
  const STATUSLINE_ROWS = 3;
  const PICKER_MAX_VISIBLE = 8;
  const SLASH_PALETTE_MAX_VISIBLE = 8;
  const PICKER_ROWS = picker ? Math.min(picker.items.length, PICKER_MAX_VISIBLE) + 4 : 0;
  const SLASH_PALETTE_ROWS = slashPaletteOpen ? Math.min(slashCommands.length, SLASH_PALETTE_MAX_VISIBLE) + 4 : 0;
  const PROVIDER_PROMPT_ROWS = providerPrompt ? 1 : 0;
  const queuedRows = !picker && !slashPaletteOpen && !providerPrompt && state.queued?.length ? state.queued.length + 1 : 0;
  const bottomReserve = WELCOME_ROWS + PICKER_ROWS + SLASH_PALETTE_ROWS + PROVIDER_PROMPT_ROWS + LIVE_STATUS_ROWS + INPUT_BOX_ROWS + STATUSLINE_ROWS + queuedRows;
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
            <Item key={item.id} item={item} prevKind={i > 0 ? state.items[i - 1].kind : null} columns={resizeState.columns} />
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
          Spinner/TurnDone don't set flexShrink themselves. */}
      {state.spinner?.active ? (
        <Box flexShrink={0}>
          <Spinner
            verb={state.spinner.verb}
            startedAt={state.spinner.startedAt}
            tokens={Math.max(state.spinner?.outputTokens ?? 0, state.spinner?.liveTokens ?? 0)}
            thinking={!!state.thinking}
            columns={resizeState.columns}
          />
        </Box>
      ) : state.lastTurn ? (
        <Box flexShrink={0}>
          <TurnDone elapsedMs={state.lastTurn.elapsedMs} />
        </Box>
      ) : null}

      {/* Bottom bar — pinned to the physical bottom, never moves. Pickers and
          slash palettes attach directly above the prompt like Codex/OpenCode. */}
      <Box flexDirection="column" flexShrink={0}>
        {picker ? (
          <Box flexShrink={0}>
            <Picker
              items={picker.items}
              onSelect={picker.onSelect}
              onCancel={picker.onCancel}
              title={picker.title}
              columns={resizeState.columns}
            />
          </Box>
        ) : slashPaletteOpen ? (
          <Box flexShrink={0}>
            <SlashCommandPalette
              commands={slashCommands}
              selectedIndex={slashIndex}
              title="Slash commands"
              columns={resizeState.columns}
            />
          </Box>
        ) : providerPrompt ? (
          <Box flexShrink={0} paddingX={1}>
            <Text color={theme.inactive}>
              {providerPrompt.kind === 'api-key'
                ? `API key for ${providerPrompt.label} · Enter save · Esc cancel`
                : `Base URL for ${providerPrompt.label} · Enter enable · Esc cancel · default ${providerPrompt.defaultURL}`}
            </Text>
          </Box>
        ) : !picker ? (
          <QueuedCommands queued={state.queued} columns={resizeState.columns} />
        ) : null}
        <Box
          marginTop={picker || slashPaletteOpen || providerPrompt ? 0 : 1}
          width="100%"
          borderStyle="round"
          borderColor={state.busy || state.commandBusy || picker ? theme.subtle : theme.promptBorder}
          paddingX={1}
        >
          <PromptInput
            onSubmit={onSubmit}
            disabled={exiting || state.commandBusy || !!picker}
            onDraftChange={onPromptDraftChange}
            mask={providerPrompt?.kind === 'api-key'}
            onEscape={providerPrompt ? cancelProviderPrompt : undefined}
            commandPaletteActive={slashPaletteOpen}
            onCommandPaletteNavigate={(direction) => {
              setSlashIndex((index) => {
                const total = slashCommands.length;
                if (total === 0) return 0;
                return (index + direction + total) % total;
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
          cwd={state.cwd}
          stats={state.stats}
          resizeEpoch={resizeEpoch}
          initialLine={initialStatusLine}
        />
      </Box>
    </Box>
  );
}
