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

const HELP = [
  'Slash commands:',
  '  /help            show this help',
  '  /clear           reset the conversation',
  '  /model <name>    switch model for subsequent turns',
  '  /exit, /quit     quit',
  'Ctrl+C exits. ↑/↓ recall history.',
].join('\n');

function terminalSize(stdout) {
  return {
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  };
}

function Item({ item, prevKind, columns }) {
  switch (item.kind) {
    case 'user': return <UserMessage text={item.text} attached={prevKind === 'user'} columns={columns} />;
    case 'assistant': return <AssistantMessage text={item.text} />;
    case 'tool': return <ToolExecution name={item.name} args={item.args} result={item.result} isError={item.isError} />;
    case 'notice': return <NoticeMessage text={item.text} tone={item.tone} />;
    default: return null;
  }
}

export function App({ store }) {
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
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      requestExit();
      return;
    }
    if (key.escape && state.busy) {
      if (store.abort()) {
        store.pushNotice('⎋ stopped — queued prompts kept (↑ to edit)', 'info');
      }
    }
  }, { isActive: isRawModeSupported });

  const onSubmit = (raw) => {
    const text = String(raw ?? '');
    const commandText = text.trim();
    if (!commandText) return false;

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
          store.clear();
          return true;
        case 'model':
          if (!arg) { store.pushNotice(`current model: ${state.model}`, 'info'); return true; }
          store.setModel(arg);
          store.pushNotice(`✓ model → ${arg}`, 'info');
          return true;
        case 'exit':
        case 'quit': requestExit(); return true;
        default: store.pushNotice(`unknown command: /${cmd} (try /help)`, 'warn'); return true;
      }
    }
    return store.submit(text);
  };

  // Finished transcript items flush to terminal scrollback via <Static>, so the
  // live tree never clips or scroll-jumps them. The live area keeps only the
  // turn-status line (spinner/TurnDone) and the input cluster.
  const resizeEpoch = resizeState.epoch;
  // The hardware/IME caret is parked by PromptInput from its OWN measured box
  // position (ink useCursor + useBoxMetrics) — correct now that the transcript
  // is a live column, so the live-frame line count ink relies on is accurate.

  return (
    // Fullscreen layout: a full-height column (height = terminal rows) pins the
    // input cluster + statusline to the physical bottom (flexShrink={0}), while
    // the transcript fills the space above and is bottom-aligned so messages
    // stack up from just over the input. CC's FullscreenLayout does the same —
    // a flexGrow spacer pushes the bottom bar down inside a <Box height={rows}>.
    <Box flexDirection="column" width={resizeState.columns} height={resizeState.rows}>
      {/* Transcript region — grows to fill. Content is TOP-aligned (header at
          the very top on entry, messages stacking downward, CC-style); a
          flexGrow spacer below pushes the live status + input cluster to the
          physical bottom. overflow hidden clips older rows off the top as it
          fills. */}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {state.items.length === 0 ? (
          <Box flexDirection="column" marginTop={1} marginBottom={1}>
            <Text>
              <Text color={theme.text}>{TURN_MARKER} </Text>
              <Text color={theme.text}>mixdog-cli</Text>
              <Text color={theme.inactive}>{`  ${state.provider}/${state.model}`}</Text>
            </Text>
          </Box>
        ) : null}

        {/* marginTop carries the wheel scroll: a NEGATIVE top margin lifts the
            whole transcript up by scrollOffset rows so older content above the
            viewport comes into view (overflow hidden clips the rest). 0 = newest
            content visible. */}
        <Box flexDirection="column" width="100%" marginTop={-scrollOffset}>
          {state.items.map((item, i) => (
            <Item key={item.id} item={item} prevKind={i > 0 ? state.items[i - 1].kind : null} columns={resizeState.columns} />
          ))}
        </Box>

        {/* flexGrow spacer — pushes everything below it (live reasoning, spinner,
            and the bottom bar) down so the input sits at the physical bottom
            while the transcript stays top-aligned. */}
        <Box flexGrow={1} />

        {/* Live reasoning — streams just above the spinner while the turn runs,
            then collapses (engine clears state.thinking at turn end). marginTop
            keeps it off the last transcript row. */}
        {state.thinking ? (
          <Box marginTop={1}>
            <ThinkingMessage text={state.thinking} />
          </Box>
        ) : null}

        {state.spinner?.active ? (
          <Spinner
            verb={state.spinner.verb}
            startedAt={state.spinner.startedAt}
            tokens={state.stats?.outputTokens ?? 0}
          />
        ) : state.lastTurn ? (
          <TurnDone elapsedMs={state.lastTurn.elapsedMs} tokens={state.lastTurn.outputTokens} />
        ) : null}
      </Box>

      {/* Bottom bar — pinned to the physical bottom, never moves. Queued
          steering prompts sit just above the input box; statusline last. */}
      <Box flexDirection="column" flexShrink={0}>
        <QueuedCommands queued={state.queued} columns={resizeState.columns} />
        <Box
          marginTop={1}
          width="100%"
          borderStyle="round"
          borderColor={state.busy ? theme.subtle : theme.promptBorder}
          paddingX={1}
        >
          <PromptInput onSubmit={onSubmit} disabled={exiting} />
        </Box>
        <StatusLine
          provider={state.provider}
          model={state.model}
          cwd={state.cwd}
          stats={state.stats}
          resizeEpoch={resizeEpoch}
        />
      </Box>
    </Box>
  );
}
