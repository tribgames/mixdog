// App view tree. Pure JSX assembly: the prompt
// input control and the full shell layout (welcome banner, transcript
// viewport, floating panels, prompt cluster, statusline). All data and
// handlers arrive via one ctx object from App(). Two surfaces of that layout
// are assembled in app-view/: the transcript viewport and the floating-panel
// slot; both are plain functions over the same ctx, so the element tree this
// module returns is unchanged.
import { Box, Text } from 'ink';
import { theme, surfaceBackground } from '../theme.mjs';
import { centerLine, promptStatusColor } from './app-format.mjs';
import { localPackageVersion } from '../../runtime/shared/update-checker.mjs';
import { Spinner } from '../components/Spinner.jsx';
import { StatusLine } from '../components/StatusLine.jsx';
import { PromptInput } from '../components/PromptInput.jsx';
import { QueuedCommands } from '../components/QueuedCommands.jsx';
import { renderFloatingPanel } from './app-view/floating-panel.jsx';
import { renderTranscriptViewport } from './app-view/transcript-viewport.jsx';
export function renderAppView(ctx) {
  const {
    acceptSlashPalette,
    activeTools,
    agentRevision,
    cancelSlashPalette,
    completeSlashPalette,
    contextPanel,
    cycleWorkflowFromPrompt,
    exiting,
    floatingPanelRows,
    frameColumns,
    gridSelectionActiveRef,
    handlePromptEscape,
    handlePromptHistoryNavigate,
    handlePromptInterrupt,
    handlePromptPaste,
    hasUserMessages,
    initialStatusLine,
    inputBoxHidden,
    inputHint,
    inputHintTone,
    liveSpinner,
    onPromptDraftChange,
    onSubmit,
    panelTransitionClearRows,
    picker,
    promptBoxRectRef,
    promptBoxRows,
    promptDraft,
    promptDraftOverride,
    promptMetaVisible,
    promptMouseSelectionRef,
    promptSelectionRef,
    promptSpinnerColumns,
    promptValueRef,
    queuedCompact,
    queuedVisible,
    resizeEpoch,
    resizeState,
    restoreQueuedToPrompt,
    setSlashIndex,
    showWelcomeBanner,
    slashCommands,
    slashPaletteOpen,
    state,
    statuslineStats,
    toolApproval,
    transientStatusWidth,
    tuiReady,
  } = ctx; /* DESTRUCTURE */
  const promptInputControl = (
    <PromptInput
      onSubmit={onSubmit}
      disabled={exiting || !!picker || !!contextPanel || !!toolApproval || !tuiReady}
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
      // Palette stays MOUNTED with 0 matches (stable height, no flicker), but
      // key capture (Enter/arrows/Esc routing) only engages when a command can
      // actually be accepted — otherwise Enter must submit the raw text as
      // before instead of dead-ending in the palette accept path.
      commandPaletteActive={slashPaletteOpen && slashCommands.length > 0}
      commandPaletteOpen={slashPaletteOpen}
      commandPaletteOptionCount={slashCommands.length}
      onCommandPaletteNavigate={(direction) => {
        setSlashIndex((index) => {
          const total = slashCommands.length;
          if (total === 0) return 0;
          if (direction === 'home') return 0;
          if (direction === 'end') return total - 1;
          let step;
          if (direction === 'left') step = -1;
          else if (direction === 'right') step = 1;
          else step = Number(direction) || 0;
          if (step === 1 || step === -1) return (index + step + total) % total;
          return Math.max(0, Math.min(total - 1, index + step));
        });
      }}
      onCommandPaletteAccept={acceptSlashPalette}
      onCommandPaletteCancel={cancelSlashPalette}
      onCommandPaletteComplete={completeSlashPalette}
      onRestoreQueued={restoreQueuedToPrompt}
      hasQueuedMessages={Array.isArray(state.queued) && state.queued.length > 0}
      hasMessages={hasUserMessages}
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
        <Box
          flexDirection="column"
          height={7}
          flexShrink={0}
          marginTop={3}
          marginBottom={1}
          backgroundColor={surfaceBackground()}
        >
          <Text color={theme.text} bold>
            {centerLine('███╗   ███╗██╗██╗  ██╗██████╗  ██████╗  ██████╗ ', frameColumns)}
          </Text>
          <Text color={theme.text} bold>
            {centerLine('████╗ ████║██║╚██╗██╔╝██╔══██╗██╔═══██╗██╔════╝ ', frameColumns)}
          </Text>
          <Text color={theme.logo ?? theme.claude} bold>
            {centerLine('██╔████╔██║██║ ╚███╔╝ ██║  ██║██║   ██║██║  ███╗', frameColumns)}
          </Text>
          <Text color={theme.logo ?? theme.claude} bold>
            {centerLine('██║╚██╔╝██║██║ ██╔██╗ ██║  ██║██║   ██║██║   ██║', frameColumns)}
          </Text>
          <Text color={theme.logo ?? theme.claude} bold>
            {centerLine('██║ ╚═╝ ██║██║██╔╝ ██╗██████╔╝╚██████╔╝╚██████╔╝', frameColumns)}
          </Text>
          <Box height={1} flexShrink={0} />
          <Text color={theme.inactive}>
            {centerLine(`mixdog coding agent · v${localPackageVersion()} · ${state.cwd}`, frameColumns, 4)}
          </Text>
        </Box>
      ) : null}

      {/* Transcript viewport — app-view/transcript-viewport.jsx. */}
      {renderTranscriptViewport(ctx)}

      {/* Live reasoning and transient status live just above the prompt: reasoning
          on the left, short-lived copy/error/info messages on the right. */}

      {/* Bottom bar — pinned to the physical bottom, never moves. Floating
          panels use their actual rendered height and shrink before the prompt
          can move; overflow is clipped from the top while the panel remains
          bottom-aligned against the prompt. */}
      <Box flexDirection="column" flexShrink={0} width="100%" backgroundColor={surfaceBackground()}>
        {panelTransitionClearRows > 0 ? (
          <Box
            height={panelTransitionClearRows}
            flexShrink={0}
            width="100%"
            overflow="hidden"
            backgroundColor={surfaceBackground()}
          />
        ) : null}
        {floatingPanelRows > 0 ? (
          <Box
            flexDirection="column"
            flexShrink={0}
            height={floatingPanelRows}
            overflow="hidden"
            justifyContent="flex-end"
            backgroundColor={surfaceBackground()}
          >
            {renderFloatingPanel(ctx)}
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
                        thinkingMs={liveSpinner?.thinkingAccumulatedMs ?? 0}
                        effort={state.effort || ''}
                        hasActiveTools={!!activeTools?.web_search?.count}
                        paused={!!toolApproval}
                        interruptible={!!(state.busy && state.spinner?.active)}
                        mode={liveSpinner?.mode || 'responding'}
                        columns={promptSpinnerColumns}
                        marginTop={0}
                      />
                    ) : null}
                  </Box>
                  {inputHint ? (
                    <Box
                      flexShrink={0}
                      width={transientStatusWidth || 1}
                      marginLeft={1}
                      marginRight={1}
                      justifyContent="flex-end"
                      overflow="hidden"
                    >
                      <Text color={promptStatusColor(inputHintTone)} wrap="truncate">
                        {inputHint}
                      </Text>
                    </Box>
                  ) : null}
                </Box>
                <Box height={1} width="100%" backgroundColor={surfaceBackground()} />
              </>
            ) : null}
            {queuedVisible ? (
              <QueuedCommands queued={state.queued} columns={frameColumns} compact={queuedCompact} />
            ) : null}
            <Box
              marginTop={0}
              width="100%"
              height={promptBoxRows}
              flexShrink={0}
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
          clientHostPid={state.ownerClientHostPid || state.clientHostPid}
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
          themeEpoch={state.themeEpoch || 0}
        />
      </Box>
    </Box>
  );
}
