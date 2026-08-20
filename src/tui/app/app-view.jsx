// App view tree, extracted from App.jsx. Pure JSX assembly: the prompt
// input control and the full shell layout (welcome banner, transcript
// viewport, floating panels, prompt cluster, statusline). All data and
// handlers arrive via one ctx object from App().
import React from 'react';
import { isCompletedTranscriptTailAppendedThisCommit } from './live-spinner-visibility.mjs';
import { Box, Text } from 'ink';
import { theme, surfaceBackground } from '../theme.mjs';
import { centerLine, promptStatusColor, toolApprovalDescription } from './app-format.mjs';
import { TRANSCRIPT_WINDOW_TAIL_OVERSCAN_ROWS } from './transcript-window.mjs';
import { localPackageVersion } from '../../runtime/shared/update-checker.mjs';
import { Spinner } from '../components/Spinner.jsx';
import { StatusLine } from '../components/StatusLine.jsx';
import { PromptInput } from '../components/PromptInput.jsx';
import { QueuedCommands } from '../components/QueuedCommands.jsx';
import { Picker } from '../components/Picker.jsx';
import { SlashCommandPalette } from '../components/SlashCommandPalette.jsx';
import { ContextPanel } from '../components/ContextPanel.jsx';
import { UsagePanel } from '../components/UsagePanel.jsx';
import { TextEntryPanel } from '../components/TextEntryPanel.jsx';
import { Item } from '../components/TranscriptItem.jsx';
export function renderAppView(ctx) {
  const { PANEL_MAX_VISIBLE, acceptSlashPalette, activeSlashQuery, activeTools, agentRevision, cancelChannelPrompt, cancelHookPrompt, cancelProviderPrompt, cancelSettingsPrompt, cancelSlashPalette, channelPrompt, clearPromptHint, completeSlashPalette, contextPanel, cycleWorkflowFromPrompt, exiting, expandedOptionPanel, floatingPanelRows, frameColumns, gridSelectionActiveRef, guardHintWidth, handlePromptEscape, handlePromptHistoryNavigate, handlePromptInterrupt, handlePromptPaste, hasUserMessages, hookPrompt, initialStatusLine, inputBoxHidden, inputHint, inputHintTone, liveSpinner, onPromptDraftChange, onSubmit, overlayHintAttachItemIndex, overlayHintBandRows, overlayHintFallbackRow, overlayHintOnLastItem, panelCloseMaskRows, panelInkMaskEpoch, panelTransitionClearRows, panelTransitionEpoch, picker, pickerOpenedFromEnterRef, pickerOpenedFromEnterTimerRef, pickerVisibleRows, promptBoxRectRef, promptBoxRows, promptDraft, promptDraftOverride, promptMetaVisible, promptMouseSelectionRef, promptSelectionRef, promptSpinnerColumns, promptValueRef, providerPrompt, queuedCompact, queuedVisible, renderedTranscriptItems, resizeEpoch, resizeState, restoreQueuedToPrompt, setPicker, setSlashIndex, setTextEntryLayoutRows, settingsPrompt, showWelcomeBanner, slashCommands, slashIndex, slashPaletteOpen, state, statuslineStats, store, toolApproval, toolOutputExpanded, transcriptContentHeight, transcriptGuardRows, transcriptMeasureRef, transcriptTailPinned, transcriptWindow, transientStatusWidth, tuiReady, usagePanel, viewportHeight, welcomePromptHintRows, welcomePromptHintText } = ctx; /* DESTRUCTURE */
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
        <Box flexDirection="column" height={7} flexShrink={0} marginTop={3} marginBottom={1} backgroundColor={surfaceBackground()}>
          <Text color={theme.text} bold>{centerLine('███╗   ███╗██╗██╗  ██╗██████╗  ██████╗  ██████╗ ', frameColumns)}</Text>
          <Text color={theme.text} bold>{centerLine('████╗ ████║██║╚██╗██╔╝██╔══██╗██╔═══██╗██╔════╝ ', frameColumns)}</Text>
          <Text color={theme.logo ?? theme.claude} bold>{centerLine('██╔████╔██║██║ ╚███╔╝ ██║  ██║██║   ██║██║  ███╗', frameColumns)}</Text>
          <Text color={theme.logo ?? theme.claude} bold>{centerLine('██║╚██╔╝██║██║ ██╔██╗ ██║  ██║██║   ██║██║   ██║', frameColumns)}</Text>
          <Text color={theme.logo ?? theme.claude} bold>{centerLine('██║ ╚═╝ ██║██║██╔╝ ██╗██████╔╝╚██████╔╝╚██████╔╝', frameColumns)}</Text>
          <Box height={1} flexShrink={0} />
          <Text color={theme.inactive}>{centerLine(`mixdog coding agent · v${localPackageVersion()} · ${state.cwd}`, frameColumns, 4)}</Text>
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
                 prevKind={i > 0
                   ? arr[i - 1].kind
                   : (state.transcriptViewItems || state.items)[transcriptWindow.startIndex - 1]?.kind ?? null}
                 columns={frameColumns}
                 toolOutputExpanded={toolOutputExpanded}
                 rightMessage={attachOverlayHint ? inputHint : ''}
                 rightTone={attachOverlayHint ? inputHintTone : 'info'}
                 rightMessageWidth={attachOverlayHint ? (guardHintWidth || transientStatusWidth || 24) : 24}
                 themeEpoch={state.themeEpoch || 0}
                 streamingWindowRows={transcriptTailPinned && item.id === state.streamingTail?.id
                   ? transcriptContentHeight + TRANSCRIPT_WINDOW_TAIL_OVERSCAN_ROWS
                   : 0}
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
        </Box>
        {welcomePromptHintRows > 0 ? (
          <Box height={1} flexShrink={0} width="100%" overflow="hidden">
            <Text color={theme.inactive} wrap="truncate">{centerLine(welcomePromptHintText, frameColumns, 2)}</Text>
          </Box>
        ) : null}
        {panelCloseMaskRows > 0 ? (
          <Box
            height={panelCloseMaskRows}
            flexShrink={0}
            width="100%"
            overflow="hidden"
            backgroundColor={surfaceBackground()}
          />
        ) : null}
        {overlayHintBandRows > 0 ? (
          <Box height={1} flexShrink={0} backgroundColor={surfaceBackground()} flexDirection="row" width="100%" overflow="hidden">
            <Box flexGrow={1} flexShrink={1} overflow="hidden" />
            <Box flexShrink={0} width={guardHintWidth || 1} marginLeft={1} marginRight={1} justifyContent="flex-end" overflow="hidden">
              <Text color={promptStatusColor(inputHintTone)} wrap="truncate">{inputHint}</Text>
            </Box>
          </Box>
        ) : null}
        {transcriptGuardRows > 0 ? (
          <Box height={transcriptGuardRows} flexShrink={0} backgroundColor={surfaceBackground()} flexDirection="row" width="100%" overflow="hidden">
            <Box flexGrow={1} flexShrink={1} overflow="hidden" />
            {overlayHintFallbackRow && overlayHintBandRows === 0 ? (
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
        {panelTransitionClearRows > 0 ? (
          <Box height={panelTransitionClearRows} flexShrink={0} width="100%" overflow="hidden" backgroundColor={surfaceBackground()} />
        ) : null}
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
                      : `Default: ${providerPrompt.defaultURL}`}
                detail={providerPrompt.detail || ''}
                mask={providerPrompt.kind === 'api-key' || providerPrompt.kind === 'openai-usage-session'}
                columns={frameColumns}
                actionLabel={providerPrompt.kind === 'oauth-code' ? 'continue' : 'save'}
                promptLabel={providerPrompt.kind === 'api-key'
                  ? 'API key > '
                  : providerPrompt.kind === 'oauth-code'
                    ? 'Paste code here if prompted > '
                    : providerPrompt.kind === 'openai-usage-session'
                      ? 'Session key > '
                      : 'Base URL > '}
                onSubmit={onSubmit}
                onCancel={cancelProviderPrompt}
              />
            ) : channelPrompt ? (
              <TextEntryPanel
                title={channelPrompt.label}
                hint={channelPrompt.hint || 'Save channel setting.'}
                mask={channelPrompt.kind === 'webhook-token'}
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
                multiline={settingsPrompt.kind === 'core-add' || settingsPrompt.kind === 'core-edit'}
                maxContentRows={PANEL_MAX_VISIBLE}
                onContentRowsChange={setTextEntryLayoutRows}
                actionLabel={settingsPrompt.kind === 'skill-use'
                  ? 'run'
                  : settingsPrompt.kind === 'autoclear-provider'
                    ? 'save'
                  : settingsPrompt.kind === 'project-new'
                    ? 'open'
                    : settingsPrompt.kind === 'project-create-confirm'
                      ? 'confirm'
                      : settingsPrompt.kind === 'project-rename'
                        ? 'rename'
                        : settingsPrompt.kind === 'core-add'
                          ? 'add'
                          : settingsPrompt.kind === 'core-edit'
                            ? 'save'
                            : settingsPrompt.kind === 'core-delete-confirm'
                              ? 'confirm'
                        : 'save'}
                promptLabel={settingsPrompt.kind === 'skill-use'
                  ? 'Command > '
                  : settingsPrompt.kind === 'autoclear-provider'
                    ? 'Duration > '
                  : settingsPrompt.kind === 'project-new'
                    ? 'Path > '
                    : settingsPrompt.kind === 'project-create-confirm'
                      ? 'Create? (y/n) > '
                      : settingsPrompt.kind === 'project-rename'
                        ? 'Name > '
                        : settingsPrompt.kind === 'core-add'
                          ? 'Sentence > '
                          : settingsPrompt.kind === 'core-edit'
                            ? 'Sentence > '
                            : settingsPrompt.kind === 'core-delete-confirm'
                              ? 'Delete? (y/n) > '
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
                      thinkingMs={liveSpinner?.thinkingAccumulatedMs ?? 0}
                      effort={state.effort || ''}
                      hasActiveTools={!!(activeTools?.explore?.count || activeTools?.web_search?.count)}
                      paused={!!toolApproval}
                      interruptible={!!(state.busy && state.spinner?.active)}
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
