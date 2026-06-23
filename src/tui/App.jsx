/**
 * App.jsx — the React/ink chat application (Claude-Code-style).
 *
 * Layout (top → bottom):
 *   welcome banner
 *   transcript (finished items, a live column — terminal scrolls older rows off)
 *   live reasoning (∴ Thinking… — only while a turn streams)
 *   spinner / TurnDone (while a turn runs / just finished)
 *   queued steering prompts + rounded prompt input (one cluster)
 *   statusline (vendored L1/L2)
 *
 * State comes from the engine store via useEngine; submitting a line calls
 * store.submit() (or handles a slash command locally). The whole tree is live
 * (no <Static>): full-width bands and the native hardware caret both need real
 * layout, which <Static> collapses. The terminal handles scrollback itself as
 * the transcript column grows past the screen height.
 */
import React, { useState, useCallback, useEffect } from 'react';
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
import { MAX_RESULT_LINES } from './components/ToolExecution.jsx';

const HELP = [
  'Slash commands:',
  '  /help            show this help',
  '  /clear           reset the conversation',
  '  /new             start a fresh session (closes current)',
  '  /resume [id]     resume a saved session (picker if no id)',
  '  /model <name>    switch model for subsequent turns (picker if no name)',
  '  /mode <name>     switch tool surface: full | readonly',
  '  /exit, /quit     quit',
  'Picker: ↑/↓ navigate, Enter confirm, Escape cancel.',
  'Ctrl+C exits. Drag to select text, Ctrl+C to copy. ↑/↓ recall history.',
].join('\n');

function terminalSize(stdout) {
  return {
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  };
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
  const { isRawModeSupported, stdin } = useStdin();
  const { stdout } = useStdout();
  const [exiting, setExiting] = useState(false);
  const [resizeState, setResizeState] = useState(() => ({ ...terminalSize(stdout), epoch: 0 }));
  // scrollOffset = how many transcript ROWS we've scrolled UP from the bottom
  // (0 = pinned to the latest, showing the newest content). Mouse wheel adjusts
  // it; a new turn / new items snap back to 0 (handled below).
  const [scrollOffset, setScrollOffset] = useState(0);
  // picker = null | { type, title, items, onSelect }
  const [picker, setPicker] = useState(null);

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

  // Mouse-wheel scrolling. index.jsx enabled SGR mouse tracking; the terminal
  // sends `\x1b[<64;col;rowM` for wheel-up and `\x1b[<65;col;rowM` for wheel-down
  // (button 64/65 = wheel). We watch raw stdin for these and move scrollOffset.
  // ink's own input handling ignores mouse sequences, so this side-listener is
  // additive and doesn't interfere with keyboard input.
  useEffect(() => {
    if (!stdin || !isRawModeSupported) return undefined;
    const WHEEL = /\x1b\[<(64|65);\d+;\d+[Mm]/g;
    const onData = (data) => {
      const s = typeof data === 'string' ? data : data.toString('utf8');
      if (s.indexOf('\x1b[<6') === -1) return;
      let up = 0;
      let down = 0;
      let m;
      WHEEL.lastIndex = 0;
      while ((m = WHEEL.exec(s)) !== null) {
        if (m[1] === '64') up += 1; else down += 1;
      }
      if (up === 0 && down === 0) return;
      const STEP = 3; // rows per wheel notch
      setScrollOffset((prev) => Math.max(0, prev + (up - down) * STEP));
    };
    stdin.on('data', onData);
    return () => { stdin.off('data', onData); };
  }, [stdin, isRawModeSupported]);

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

  const onSubmit = (raw) => {
    const text = String(raw ?? '');
    const commandText = text.trim();
    if (!commandText) return false;
    if (state.commandBusy) {
      store.pushNotice('wait for the current command to finish', 'warn');
      return false;
    }

    if (commandText.startsWith('/')) {
      const [cmd, ...rest] = commandText.slice(1).split(/\s+/);
      const arg = rest.join(' ').trim();
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
            let presets;
            try {
              presets = store.listPresets();
            } catch (e) {
              store.pushNotice(`could not list presets: ${e?.message || e}`, 'error');
              return true;
            }
            if (!presets || presets.length === 0) {
              store.pushNotice(`current model: ${state.model}`, 'info');
            } else {
              const items = presets.map((p) => {
                const key = p.id || p.name || p.model;
                const label = p.name || p.id || p.model;
                return {
                  value: key,
                  label,
                  description: `${p.provider}/${p.model}`,
                };
              }).filter((item) => item.value);
              setPicker({
                title: `Model (current: ${state.model})`,
                items,
                onSelect: (value) => {
                  setPicker(null);
                  void store.setModel(value)
                    .then(ok => store.pushNotice(ok ? `✓ model → ${value}` : 'model switch already in progress', ok ? 'info' : 'warn'))
                    .catch((e) => store.pushNotice(`model switch failed: ${e?.message || e}`, 'error'));
                },
                onCancel: () => {
                  setPicker(null);
                  store.pushNotice('canceled', 'info');
                },
              });
            }
            return true;
          }
          void store.setModel(arg)
            .then(ok => store.pushNotice(ok ? `✓ model → ${arg}` : 'model switch already in progress', ok ? 'info' : 'warn'))
            .catch((e) => store.pushNotice(`model switch failed: ${e?.message || e}`, 'error'));
          return true;
        case 'mode':
          if (!arg) { store.pushNotice(`current mode: ${state.toolMode || 'full'}`, 'info'); return true; }
          store.setToolMode(arg);
          store.pushNotice(`✓ mode → ${arg}`, 'info');
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
            let sessions;
            try {
              sessions = store.listSessions();
            } catch (e) {
              store.pushNotice(`could not list sessions: ${e?.message || e}`, 'error');
              return true;
            }
            if (!sessions || sessions.length === 0) {
              store.pushNotice('no saved sessions', 'warn');
            } else {
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
            }
          }
          return true;
        case 'exit':
        case 'quit': requestExit(); return true;
        default: store.pushNotice(`unknown command: /${cmd} (try /help)`, 'warn'); return true;
      }
    }
    return store.submit(text);
  };

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
  const PICKER_ROWS = picker ? Math.min(picker.items.length, PICKER_MAX_VISIBLE) + 3 : 0;
  const queuedRows = !picker && state.queued?.length ? state.queued.length + 1 : 0;
  const bottomReserve = WELCOME_ROWS + LIVE_STATUS_ROWS + (picker ? PICKER_ROWS : INPUT_BOX_ROWS) + STATUSLINE_ROWS + queuedRows;
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

      {/* Bottom bar — pinned to the physical bottom, never moves. Picker
          (when open) replaces the queued prompts + input box; statusline
          stays last. */}
      <Box flexDirection="column" flexShrink={0}>
        {picker ? (
          <Picker
            items={picker.items}
            onSelect={picker.onSelect}
            onCancel={picker.onCancel}
            title={picker.title}
          />
        ) : (
          <>
            <QueuedCommands queued={state.queued} columns={resizeState.columns} />
            <Box
              marginTop={1}
              width="100%"
              borderStyle="round"
              borderColor={state.busy || state.commandBusy ? theme.subtle : theme.promptBorder}
              paddingX={1}
            >
              <PromptInput onSubmit={onSubmit} disabled={exiting || state.commandBusy || !!picker} />
            </Box>
          </>
        )}
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
