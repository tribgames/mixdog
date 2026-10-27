/**
 * app-view/floating-panel.jsx — the single overlay that owns the reserved
 * floating-panel rows above the prompt.
 *
 * One responsibility: pick which overlay is showing and build it from the
 * shared view context. Priority is the branch order below (tool approval →
 * picker → context → usage → slash palette → provider prompt → settings
 * prompt); app-view.jsx owns the reserved-height box this renders into.
 */
import { theme } from '../../theme.mjs';
import { toolApprovalDescription } from '../app-format.mjs';
import { Picker } from '../../components/Picker.jsx';
import { QuestionPanel } from '../../components/QuestionPanel.jsx';
import { questionsOf } from '../../components/question-panel-model.mjs';
import { SlashCommandPalette } from '../../components/SlashCommandPalette.jsx';
import { ContextPanel } from '../../components/ContextPanel.jsx';
import { UsagePanel } from '../../components/UsagePanel.jsx';
import { BtwPanel } from '../../components/BtwPanel.jsx';
import { TextEntryPanel } from '../../components/TextEntryPanel.jsx';
import { textEntryClearsByEmpty } from '../text-entry-policy.mjs';
import { withPickerEnterLatch } from '../picker-enter-latch.mjs';
import { providerPromptFields, settingsPromptFields } from './text-entry-labels.mjs';

// `$name` skill completion reuses the command palette with its own copy.
const SKILL_PALETTE_TEXT = {
  description: 'Type to filter · Enter or Tab inserts the highlighted skill.',
  help: '↑/↓ select · Enter insert · Esc cancel',
};

function renderToolApproval({ toolApproval, store, frameColumns, expandedOptionPanel, floatingPanelRows }) {
  if (toolApproval.kind === 'question') {
    return (
      <QuestionPanel
        key={toolApproval.id}
        questions={questionsOf(toolApproval)}
        columns={frameColumns}
        rows={floatingPanelRows}
        onSubmit={(answers) =>
          store.resolveToolApproval?.(toolApproval.id, { approved: true, reason: 'answered by user', answers })
        }
        onDismiss={() => store.resolveToolApproval?.(toolApproval.id, { approved: false, reason: 'dismissed by user' })}
      />
    );
  }
  const resolve = (approved) => {
    store.resolveToolApproval?.(toolApproval.id, {
      approved,
      reason: approved ? 'approved by user' : 'denied by user',
    });
  };
  return (
    <Picker
      items={[
        {
          value: 'deny',
          label: 'Deny',
          marker: '×',
          markerColor: theme.error,
          description: 'block this tool call',
        },
        {
          value: 'approve',
          label: 'Approve once',
          marker: '✓',
          markerColor: theme.success,
          description: 'run this tool call',
        },
      ]}
      onSelect={(value) => resolve(value === 'approve')}
      onCancel={() => resolve(false)}
      onKey={(input) => {
        const value = String(input || '')
          .trim()
          .toLowerCase();
        if (value === 'a' || value === 'y') resolve(true);
        else if (value === 'd' || value === 'n') resolve(false);
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
  );
}

function renderPicker({
  picker,
  pickerOpenedFromEnterRef,
  pickerOpenedFromEnterTimerRef,
  surface,
  clearPromptHint,
  frameColumns,
  pickerVisibleRows,
  expandedOptionPanel,
  state,
}) {
  return (
    <Picker
      key={picker.pickerKey}
      items={picker.items}
      onSelect={(value, item) => {
        withPickerEnterLatch(pickerOpenedFromEnterRef, pickerOpenedFromEnterTimerRef, () => {
          if (picker.onSelect) picker.onSelect(value, item);
        });
      }}
      onCancel={() => {
        if (picker.onCancel) picker.onCancel();
        else {
          // Esc with no owner-supplied handler: this keypress owns
          // the surface it clears (app/panel-surface.mjs).
          surface.claim().close();
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
      loading={picker.loading === true}
      themeEpoch={state.themeEpoch || 0}
      confirmBar={picker.confirmBar}
    />
  );
}

export function renderFloatingPanel(ctx) {
  const {
    PANEL_MAX_VISIBLE,
    activeSlashQuery,
    cancelProviderPrompt,
    cancelSettingsPrompt,
    contextPanel,
    expandedOptionPanel,
    floatingPanelRows,
    frameColumns,
    onSubmit,
    picker,
    providerPrompt,
    setTextEntryLayoutRows,
    settingsPrompt,
    slashCommands,
    slashIndex,
    slashPaletteOpen,
    toolApproval,
    usagePanel,
    btwPanel,
  } = ctx;
  if (toolApproval) return renderToolApproval(ctx);
  if (picker) return renderPicker(ctx);
  if (contextPanel) {
    return (
      <ContextPanel
        rows={contextPanel.rows}
        title={contextPanel.title}
        detail={contextPanel.detail}
        onInspect={contextPanel.onInspect}
        onRefresh={contextPanel.onRefresh}
        panelRows={floatingPanelRows}
        columns={frameColumns}
        fillHeight={expandedOptionPanel}
      />
    );
  }
  if (usagePanel) {
    return (
      <UsagePanel
        dashboard={usagePanel}
        columns={frameColumns}
        fillHeight={expandedOptionPanel}
        panelRows={floatingPanelRows}
      />
    );
  }
  if (slashPaletteOpen) {
    const skills = ctx.paletteKind === 'skills';
    return (
      <SlashCommandPalette
        commands={slashCommands}
        selectedIndex={slashIndex}
        title={skills ? 'Skills' : 'Commands'}
        columns={frameColumns}
        query={activeSlashQuery}
        {...(skills ? SKILL_PALETTE_TEXT : {})}
      />
    );
  }
  if (providerPrompt) {
    const { title, hint, promptLabel } = providerPromptFields(providerPrompt);
    return (
      <TextEntryPanel
        // Remount on a restore so a repeated failed save re-seeds the
        // editor even when the restored text is byte-identical.
        key={`provider-prompt:${providerPrompt.restoreEpoch || 0}`}
        title={title}
        hint={hint}
        detail={providerPrompt.detail || ''}
        mask={providerPrompt.kind === 'api-key' || providerPrompt.kind === 'openai-usage-session'}
        columns={frameColumns}
        // Restored after a REJECTED daemon save so the entered secret
        // is not lost with the failed round-trip (normally empty).
        initialValue={providerPrompt.initialValue || ''}
        actionLabel={providerPrompt.kind === 'oauth-code' ? 'continue' : 'save'}
        promptLabel={promptLabel}
        onSubmit={onSubmit}
        onCancel={cancelProviderPrompt}
      />
    );
  }
  if (settingsPrompt) {
    const { actionLabel, promptLabel } = settingsPromptFields(settingsPrompt.kind);
    return (
      <TextEntryPanel
        key={`settings-prompt:${settingsPrompt.kind}:${settingsPrompt.restoreEpoch || 0}`}
        title={settingsPrompt.label}
        hint={settingsPrompt.hint || 'Save setting.'}
        columns={frameColumns}
        initialValue={settingsPrompt.initialValue || ''}
        // Reset/clear prompts document an empty submit as the action.
        allowEmpty={textEntryClearsByEmpty(settingsPrompt.kind)}
        multiline={settingsPrompt.kind === 'core-add' || settingsPrompt.kind === 'core-edit'}
        maxContentRows={PANEL_MAX_VISIBLE}
        onContentRowsChange={setTextEntryLayoutRows}
        actionLabel={actionLabel}
        promptLabel={promptLabel}
        onSubmit={onSubmit}
        onCancel={cancelSettingsPrompt}
      />
    );
  }
  if (btwPanel) {
    return (
      <BtwPanel
        panel={btwPanel}
        columns={frameColumns}
        panelRows={floatingPanelRows}
        themeEpoch={ctx.state?.themeEpoch || 0}
      />
    );
  }
  return null;
}
