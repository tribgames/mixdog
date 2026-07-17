import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  approvalInstanceKey,
  attemptApproval,
  draftAfterSubmission,
  focusTrapIndex,
  followAfterScroll,
  isApprovalDismissKey,
  isScrollIntentKey,
  mergeModelCatalog,
  mergeTranscript,
  normalizeApplyPatch,
  parseUnifiedDiff,
  reconcileTurnFailures,
  shouldAutoFollow,
  shouldNavigatePromptHistory,
  transcriptTurnKeys,
} from './renderer-logic.mjs';
import {
  normalizeSessionTitle,
  promptTitle,
  sessionSummaryTitle,
  stripSessionEnvelope,
} from '../shared/session-title.mjs';
import { filterConfiguredModels } from './ModelPicker.tsx';
import { formatContextWindow, modelContextWindow } from './provider-display.tsx';

test('explicit provider context metadata wins over model-family fallbacks', () => {
  const explicitClaude = {
    provider: 'anthropic-oauth',
    model: 'claude-sonnet-5',
    display: 'Claude Sonnet 5',
    contextWindow: 200_000,
  };
  const legacyClaude = {
    provider: 'anthropic-oauth',
    model: 'claude-sonnet-5',
    display: 'Claude Sonnet 5',
  };

  assert.equal(formatContextWindow(modelContextWindow(explicitClaude)), '200k Context');
  assert.equal(formatContextWindow(modelContextWindow(legacyClaude)), '1M Context');
});

test('renderer uses the preload bridge name', async () => {
  const [preload, renderer] = await Promise.all([
    readFile(new URL('../preload/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('./App.tsx', import.meta.url), 'utf8'),
  ]);
  const bridgeName = preload.match(/exposeInMainWorld\('([^']+)'/)?.[1];
  assert.equal(bridgeName, 'mixdogDesktop');
  assert.match(renderer, new RegExp(`window\\.${bridgeName}\\b`));
});

test('settings dialog reserves the native window-controls safe area', async () => {
  const [styles, settings] = await Promise.all([
    readFile(new URL('./opencode-v2.css', import.meta.url), 'utf8'),
    readFile(new URL('./settings/settings.css', import.meta.url), 'utf8'),
  ]);
  assert.match(styles,
    /--settings-layer-safe-top:\s*max\(16px,\s*calc\(env\(titlebar-area-height,\s*0px\) \+ 8px\)\);/);
  assert.match(styles,
    /\.mixdog-settings-layer\s*\{[^}]*padding:\s*var\(--settings-layer-safe-top\) 16px var\(--settings-layer-safe-bottom\);/s);
  assert.match(settings,
    /\.mixdog-settings-v2\s*\{[^}]*height:\s*min\(650px,\s*calc\(100vh - var\(--settings-layer-safe-top, 16px\) - var\(--settings-layer-safe-bottom, 16px\)\)\);/s);
  assert.match(settings,
    /@media \(max-width:\s*760px\)[\s\S]*--settings-layer-safe-top:\s*max\(8px,\s*calc\(env\(titlebar-area-height,\s*0px\) \+ 8px\)\);/);
  assert.match(settings,
    /\.settings-resource-title,\s*\.settings-form-row > div\.settings-resource-title\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*flex-wrap:\s*wrap;/s,
    'form status badges must remain inline with their titles');
});

test('OpenCode desktop shell keeps Project and flat recent sessions inside the sidebar rail', async () => {
  const [styles, navigation] = await Promise.all([
    readFile(new URL('./opencode-v2.css', import.meta.url), 'utf8'),
    readFile(new URL('./navigation.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(styles, /\.topbar\s*\{[^}]*height:\s*36px;[^}]*align-items:\s*flex-start;[^}]*padding:\s*8px 12px 0 16px;/s);
  assert.match(styles, /\.workspace-tab\s*\{[^}]*flex:\s*0 1 auto;[^}]*height:\s*28px;[^}]*min-width:\s*96px;[^}]*max-width:\s*240px;/s);
  assert.doesNotMatch(styles, /\.workspace-tab\s*\{[^}]*flex-basis:\s*240px;/s);
  assert.match(styles, /\.desktop-body\s*\{[^}]*padding:\s*6px 8px 8px;[^}]*background:\s*var\(--oc-window-band\);/s);
  assert.match(styles, /\.sidebar\.session-sidebar\s*\{[^}]*width:\s*286px;[^}]*flex:\s*0 0 286px;[^}]*border-radius:\s*10px;/s);
  assert.match(styles, /\.session-sidebar \.task-link,[\s\S]*?\.session-sidebar \.session-row\s*\{[^}]*height:\s*28px;[^}]*min-height:\s*28px;/s);
  assert.match(styles, /\.session-list\s*\{\s*gap:\s*1px;/s);
  assert.match(styles, /\.workspace\s*\{[^}]*margin:\s*0;[^}]*border-radius:\s*10px;/s);
  assert.match(styles, /\.project-switcher\s*\{[^}]*width:\s*min\(640px,/s);
  assert.match(styles, /\.thread\s*\{[^}]*width:\s*min\(100%,\s*800px\);/s);
  assert.match(styles, /\.composer-region\s*\{[^}]*width:\s*min\(100%,\s*800px\);/s);
  assert.match(styles, /\.session-sidebar-footer span\s*\{[^}]*color:\s*var\(--oc-text\);[^}]*font:\s*440 14px\/20px/s);
  assert.match(styles, /@media \(max-width:\s*760px\)[\s\S]*width:\s*min\(286px,\s*calc\(100vw - 32px\)\)/);
  assert.match(navigation, /aria-label="Session manager"/);
  assert.match(navigation, /session\.classification === "task" \|\| session\.classification === "project"/);
  assert.match(navigation, /className="project-grid project-list"/);
  assert.match(navigation, /aria-label="Open projects"/);
  assert.match(navigation, /className="sidebar-primary-nav"/);
  assert.match(navigation, /<span>Project<\/span>/);
  assert.match(navigation, /className="sidebar-recent-heading">Recent/);
  assert.match(navigation, /className="session-list recent-session-list"/);
  assert.doesNotMatch(navigation, /className="sidebar-projects"|project-group-toggle|standalone-group/);
  assert.match(navigation, /<MessageSquare className="session-row-icon"/);
  assert.doesNotMatch(styles, /\.session-search\s*\{/);
  assert.doesNotMatch(navigation, /Search sessions|session-search/);
  assert.doesNotMatch(navigation, /LayoutGrid|titlebar-home|topbar-settings/);
});

test('copy hover changes only icon color while keyboard focus keeps its frame', async () => {
  const styles = await readFile(new URL('./opencode-v2.css', import.meta.url), 'utf8');
  assert.match(styles, /\.message-actions:hover\s*\{[^}]*color:\s*var\(--oc-icon\);[^}]*background:\s*transparent;[^}]*outline:\s*0;/s);
  assert.match(styles, /\.message-actions:focus-visible\s*\{[^}]*background:\s*transparent;[^}]*outline:\s*2px solid var\(--oc-focus\);/s);
  assert.match(styles, /\.markdown-code-copy:hover\s*\{[^}]*color:\s*var\(--oc-icon\);[^}]*background:\s*transparent;/s);
  assert.match(styles, /\.markdown-code-copy:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--oc-focus\);/s);
  assert.match(styles, /\.message\.assistant\.settled,\s*\.tool-card\.settled\s*\{[^}]*content-visibility:\s*auto;/s);
  assert.doesNotMatch(styles, /\.message\.settled,\s*\.tool-card\.settled/);
  assert.doesNotMatch(styles, /\.message\.assistant\.streaming \.markdown > :nth-last-child/,
    'streamed response prose must remain readable; shimmer belongs to compact status text only');
  assert.match(styles,
    /\.tool-header:hover:not\(:disabled\) \.tool-icon,[\s\S]*\.tool-header:focus-visible \.tool-chevron\s*\{[^}]*color:\s*var\(--oc-icon\);/s,
    'tool disclosures should expose quiet icon and chevron feedback on hover and keyboard focus');
  assert.match(styles,
    /\.composer-attachments > div:hover,\s*\.composer-attachments > div:focus-within\s*\{[^}]*box-shadow:\s*0 0 0 1px var\(--oc-border-strong\);/s,
    'composer attachments should expose the same hover/focus boundary as the reference UI');
});

test('session title actions, message hover rows, and tool disclosures keep OpenCode rhythm', async () => {
  const [styles, navigation, app] = await Promise.all([
    readFile(new URL('./opencode-v2.css', import.meta.url), 'utf8'),
    readFile(new URL('./navigation.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./App.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(styles, /\.session-row-menu-wrap\s*\{[^}]*width:\s*24px;[^}]*flex:\s*0 0 24px;/s);
  assert.match(styles, /\.session-row-copy b\s*\{[^}]*text-overflow:\s*clip;[^}]*white-space:\s*nowrap;/s);
  assert.match(styles, /\.message\.user\.attached-user\s*\{\s*margin-top:\s*-12px;/);
  assert.match(styles, /\.thread\s*\{[^}]*padding:\s*20px 12px 16px;[^}]*gap:\s*16px;/s);
  assert.match(styles, /\.message\.user \+ \.message\.assistant\s*\{\s*margin-top:\s*-16px;/);
  assert.match(styles, /\.message\.user \.message-meta-line\s*\{[^}]*position:\s*static;[^}]*width:\s*100%;/s);
  assert.match(styles, /\.tool-title\s*\{[^}]*flex:\s*0 1 auto;/s);
  assert.match(styles, /\.tool-card\[data-open="true"\] \.tool-chevron svg\s*\{[^}]*rotate\(90deg\)/s);
  assert.match(styles, /\.shell-output\s*\{[^}]*border:\s*1px solid var\(--oc-border-muted\);[^}]*border-radius:\s*6px;/s);
  assert.match(styles, /\.session-header-content\s*\{[^}]*width:\s*min\(100%, 800px\);[^}]*margin:\s*0 auto;[^}]*padding:\s*12px;/s);
  assert.match(styles, /\.session-header-content h1\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*min\(52ch,\s*100%\);[^}]*flex:\s*0 1 auto;/s);
  assert.match(styles, /\.session-title-trigger\s*\{[^}]*width:\s*100%;[^}]*padding:\s*0;/s);
  assert.match(styles, /\.session-header-title-input\s*\{[^}]*field-sizing:\s*content;[^}]*width:\s*auto;[^}]*max-width:\s*100%;[^}]*padding:\s*0;/s);
  assert.match(styles, /\.session-project-badge\s*\{[^}]*flex:\s*0 1 auto;/s);
  assert.match(styles, /\.mixdog-settings__close\s*\{[^}]*flex:\s*0 0 24px;[^}]*place-items:\s*center;/s);
  assert.match(styles, /\.command-surface-header-actions\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert.match(styles, /\.session-context-indicator > button\s*\{[^}]*place-items:\s*center end;/s);
  assert.match(styles, /\.session-header-status\s*\{[^}]*margin-left:\s*auto;/s);
  assert.match(styles, /\.live-work-status\s*\{[^}]*margin-left:\s*0;/s);
  assert.doesNotMatch(styles, /\.send-button\.stop/);
  assert.match(app, /className="session-header-status"[\s\S]*?<LiveWorkStatus snapshot=\{visibleSnapshot\} \/>\s*<ContextUsageIndicator/);
  assert.equal((app.match(/<LiveWorkStatus\b/g) || []).length, 1);
  assert.match(navigation, /aria-label=\{`More actions for \$\{sessionLabel\(session\)\}`\}/);
  assert.match(navigation, /className="session-row-menu-rename"/);
  assert.match(navigation, /className="session-row-menu-delete danger"/);
});

test('conversation uses native scrolling and silent session transitions', async () => {
  const renderer = await readFile(new URL('./App.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(renderer, /TranscriptRail|Previous user message|Next user message/);
  assert.doesNotMatch(renderer, /Opening session|Resuming conversation/);
  assert.match(renderer, /if \(mode === "resuming"\) return null;/);
  assert.match(renderer, /<div className="session-switch-overlay" aria-hidden="true" \/>/);
});

test('authenticated keychain providers are immediately selectable without a second enabled flag', () => {
  const models = [
    { provider: 'openai', model: 'gpt', display: 'GPT', effortOptions: [] },
    { provider: 'ollama', model: 'local', display: 'Local', effortOptions: [] },
  ];
  const filtered = filterConfiguredModels(models, {
    api: [{ id: 'openai', authenticated: true, enabled: false }],
    local: [{ id: 'ollama', detected: true, enabled: false }],
  });
  assert.deepEqual(filtered.map((model) => model.provider), ['openai']);
});

test('desktop UI keeps every public TUI command and core capability represented', async () => {
  const [app, commandSurfaces, desktopCommands, settings, onboarding, contract, tuiCommands] = await Promise.all([
    readFile(new URL('./App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./CommandSurface.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./slash-commands.ts', import.meta.url), 'utf8'),
    readFile(new URL('./settings/CapabilitySettings.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./settings/OnboardingWizard.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../shared/contract.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../../src/tui/app/slash-commands.mjs', import.meta.url), 'utf8'),
  ]);
  const desktopCommandBlock = desktopCommands.match(/export const SLASH_COMMANDS:[\s\S]*?= \[([\s\S]*?)\n\];/)?.[1] || '';
  const tuiCommandBlock = tuiCommands.match(/export const SLASH_COMMANDS = \[([\s\S]*?)\n\];/)?.[1] || '';
  const commandRows = [...tuiCommandBlock.matchAll(/\{ name: '([^']+)'([^\n]*)/g)];
  const desktopCommandNames = [...desktopCommandBlock.matchAll(/\{ name: '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(
    desktopCommandNames,
    commandRows.map(([, name]) => name),
    'desktop command registry must exactly match the public TUI registry',
  );
  for (const [, name, rest] of commandRows) {
    assert.match(desktopCommandBlock, new RegExp(`\\bname: '${name}'`), `desktop is missing /${name}`);
    const aliasBlock = rest.match(/aliases:\s*\[([^\]]*)\]/)?.[1] || '';
    const aliases = [...aliasBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    for (const alias of aliases) {
      assert.match(desktopCommandBlock, new RegExp(`['\"]${alias}['\"]`), `desktop is missing /${alias}`);
    }
  }

  const capabilityBlock = contract.match(/export const DESKTOP_CAPABILITIES = \[([\s\S]*?)\] as const/)?.[1] || '';
  const capabilities = [...capabilityBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const represented = `${app}\n${commandSurfaces}\n${settings}\n${onboarding}`;
  const capabilitiesWithoutPublicTuiControls = new Set([
    'getOutputStyle',
    'loginOAuthProvider',
    'authenticateProvider',
    'setSystemShell',
    'setDefaultProvider',
    'listProviders',
    'setToolMode',
    'agentControl',
    'toolsStatus',
    'selectTools',
    'getSystemShell',
    'reconnectMcp',
    'addMcpServer',
    'removeMcpServer',
    'addHookRule',
    'deleteHookRule',
    'skillContent',
    'addSkill',
    'reloadSkills',
    'reloadPlugins',
    'recall',
    'saveOpenCodeGoUsageAuth',
    'saveOpenAIUsageSessionKey',
    'forgetDiscordToken',
    'forgetTelegramToken',
    'forgetWebhookAuthtoken',
    'saveSchedule',
    'deleteSchedule',
    'saveWebhook',
    'deleteWebhook',
  ]);
  assert.deepEqual(
    capabilities.filter((capability) => (
      !represented.includes(`'${capability}'`) && !capabilitiesWithoutPublicTuiControls.has(capability)
    )),
    [],
  );
  for (const capability of capabilitiesWithoutPublicTuiControls) {
    if (['getOutputStyle', 'loginOAuthProvider', 'authenticateProvider', 'setSystemShell', 'setDefaultProvider', 'listProviders']
      .includes(capability)) continue;
    assert.doesNotMatch(represented, new RegExp(`['\"]${capability}['\"]`),
      `${capability} must stay hidden when no public TUI picker exposes it`);
  }
});

test('dedicated command surfaces preserve TUI actions without exposing automation editors', async () => {
  const [app, surfaces] = await Promise.all([
    readFile(new URL('./App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./CommandSurface.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(surfaces, /listProviderModels\?\.\(\{ quick: false \}\)/);
  assert.match(surfaces, /run\('setAgentRoute', \[agent\.id, selectionFor\(model\)\]\)/);
  assert.match(surfaces, /ariaLabel=\{`\$\{String\(agent\.label \|\| agent\.id\)\} effort`\}/);
  assert.match(surfaces, /selectionFor\(selected, \{ fast: event\.currentTarget\.checked \}\)/);
  assert.match(surfaces, /op: 'edit'/);
  assert.match(surfaces, /Confirm delete/);
  assert.doesNotMatch(surfaces, /run\('(?:save|delete)(?:Schedule|Webhook)'/);
  assert.match(app, /const quit = window\.mixdogDesktop\.quit;[\s\S]*typeof quit === 'function'[\s\S]*else window\.close\(\);/);
  assert.match(app, /commandCapability\('getUsageDashboard', \[\{ refresh: true \}\]\)/);
  assert.match(app, /\/search sets the search provider\/model; the search tool uses that model when called\./);
});

test('desktop session titles strip runtime envelopes and prompt payload markup', () => {
  assert.equal(
    stripSessionEnvelope(`# Session\nCwd: C:\\Project\\mixdog\nModel: GPT-5.6-Sol · XHIGH · FAST\nWorkflow: Solo\n\nVisible prompt`),
    'Visible prompt',
  );
  assert.equal(
    normalizeSessionTitle(`# Session\nCwd: C:\\Project\\mixdog\nModel: GPT-5.6-Sol · XHIGH · FAST\nWorkflow: Default\n\nPolish the desktop sidebar`),
    'Polish the desktop sidebar',
  );
  assert.equal(
    normalizeSessionTitle('# Session Cwd: C:\\Project\\mixdog Model: GPT-5.6-Sol · XHIGH · FAST Workflow: Default Keep this stable'),
    'Keep this stable',
  );
  assert.equal(
    normalizeSessionTitle('Reference files: [Image #1] <system-reminder>internal only</system-reminder> Compare both layouts'),
    'Compare both layouts',
  );
  assert.equal(normalizeSessionTitle('[Image #2: screenshot.png] Fix this alignment', ''), 'Fix this alignment');
  assert.equal(normalizeSessionTitle('[Pasted text #3 +24 lines]', ''), '');
  assert.equal(normalizeSessionTitle('[Pasted text #1]', 'New task'), 'New task');
});

test('session title helpers prefer a stable title and extract user-facing prompt text', () => {
  assert.equal(
    sessionSummaryTitle({ title: 'Original request', preview: 'A later response' }),
    'Original request',
  );
  assert.equal(
    promptTitle([
      { type: 'image', data: 'ignored' },
      { type: 'text', text: 'First line' },
      { type: 'text', text: 'second line' },
    ]),
    'First line second line',
  );
  assert.equal(promptTitle('raw prompt', 'Visible prompt'), 'Visible prompt');
  assert.equal(promptTitle([{ type: 'image', data: 'ignored' }], '[Image #1: screenshot.png]'), '[Image]');
  assert.equal(
    normalizeSessionTitle('A deliberately long title that should be clipped on a clean word boundary', 'Untitled', 32),
    'A deliberately long title that…',
  );
});

test('prompt history navigation respects caret, selection, and modifier intent', () => {
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowUp', value: '', selectionStart: 0 }), true);
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowUp', value: '   ', selectionStart: 3 }), true);
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowUp', value: 'line one\nline two', selectionStart: 9 }), false);
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowUp', value: 'line one', selectionStart: 0 }), true);
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowDown', value: 'line one', selectionStart: 8, historyActive: true }), true);
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowDown', value: 'line one', selectionStart: 8, historyActive: false }), false);
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowDown', value: 'line one', selectionStart: 2, historyActive: true }), false);
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowUp', value: 'line one', selectionStart: 2, altKey: true }), true);
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowUp', value: 'line one', selectionStart: 0, selectionEnd: 4 }), false);
  assert.equal(shouldNavigatePromptHistory({ key: 'ArrowUp', value: '', selectionStart: 0, shiftKey: true }), false);
  assert.equal(shouldNavigatePromptHistory({ key: 'Enter', value: '', selectionStart: 0 }), false);
});

test('full model catalogs merge over quick results without losing provider-specific routes', () => {
  const quick = [
    { provider: 'openai-oauth', model: 'gpt-5.6-sol', label: 'quick label' },
    { provider: 'anthropic', model: 'claude-opus-4-6' },
  ];
  const full = [
    { provider: 'openai-oauth', model: 'gpt-5.6-sol', label: 'canonical label', contextWindow: 400_000 },
    { provider: 'openai', model: 'gpt-5.6-sol' },
    { provider: 'gemini', model: 'gemini-3.1-pro' },
    { provider: '', model: 'invalid' },
  ];
  const merged = mergeModelCatalog(quick, full);
  assert.equal(merged.length, 4);
  assert.deepEqual(merged[0], full[0]);
  assert.equal(merged.some((option) => option.provider === 'openai' && option.model === 'gpt-5.6-sol'), true);
  assert.equal(merged.some((option) => option.provider === 'anthropic' && option.model === 'claude-opus-4-6'), true);
  assert.equal(merged.some((option) => option.model === 'invalid'), false);
});

test('streaming tail is appended or replaces a matching settled item', () => {
  const settled = [{ id: 1 }, { id: 2 }];
  const tail = { id: 3, streaming: true };
  assert.deepEqual(mergeTranscript(settled, tail), [...settled, tail]);
  const replacement = { id: 2, streaming: true, text: 'live' };
  assert.deepEqual(mergeTranscript(settled, replacement), [settled[0], replacement]);
  assert.strictEqual(mergeTranscript(settled, null), settled);
});

test('turn failure attribution uses authoritative transcript outcomes, not error toasts', () => {
  const successful = [
    { id: 'user-1', kind: 'user', text: 'first' },
    { id: 'done-1', kind: 'turndone', status: 'done' },
    { id: 'user-2', kind: 'user', text: 'second' },
    { id: 'done-2', kind: 'turndone', status: 'done' },
  ];
  assert.deepEqual(
    transcriptTurnKeys(successful),
    ['turn:user-1', 'turn:user-1', 'turn:user-2', 'turn:user-2'],
  );

  const settingsToast = reconcileTurnFailures(undefined, successful, [
    { id: 'settings-error', tone: 'error', text: 'Could not save provider settings' },
  ], 'project/session-1');
  assert.deepEqual(settingsToast.failedTurnKeys, []);
  assert.deepEqual(settingsToast.activeToastTurns, {});

  const failed = reconcileTurnFailures(settingsToast, [
    ...successful,
    { id: 'user-3', kind: 'user', text: 'third' },
    { id: 'done-3', kind: 'turndone', status: 'failed' },
  ], [], 'project/session-1');
  assert.deepEqual(failed.failedTurnKeys, ['turn:user-3']);

  const cancelled = reconcileTurnFailures(failed, [
    { id: 'user-4', kind: 'user', text: 'fourth' },
    { id: 'done-4', kind: 'turndone', status: 'cancelled' },
  ], [{ id: 'provider-error', tone: 'error', text: 'Provider disconnected' }], 'project/session-1');
  assert.deepEqual(cancelled.failedTurnKeys, []);
});

test('turn failures are recalculated when sessions in the same project reuse transcript ids', () => {
  const failedSession = [
    { id: 'user-shared', kind: 'user', text: 'same identity' },
    { id: 'done-shared', kind: 'turndone', status: 'failed' },
  ];
  const scope = 'C:\\work\\project-a';
  const firstSession = reconcileTurnFailures(undefined, failedSession, [], scope);
  assert.equal(firstSession.scope, scope);
  assert.deepEqual(firstSession.failedTurnKeys, ['turn:user-shared']);

  const successfulSession = reconcileTurnFailures(firstSession, [
    { id: 'user-shared', kind: 'user', text: 'same identity in another session' },
    { id: 'done-shared', kind: 'turndone', status: 'done' },
  ], [{ id: 'settings-error', tone: 'error', text: 'Unrelated settings error' }], scope);
  assert.equal(successfulSession.scope, scope);
  assert.deepEqual(successfulSession.failedTurnKeys, []);
  assert.deepEqual(successfulSession.scopes[scope].failedTurnKeys, []);
});

test('an explicit transcript error marks only its unfinished turn', () => {
  const pending = reconcileTurnFailures(undefined, [
    { id: 'user-1', kind: 'user', text: 'request' },
    { id: 'error-1', kind: 'notice', tone: 'error', text: 'Request failed' },
  ], [], 'project/session-1');
  assert.deepEqual(pending.failedTurnKeys, ['turn:user-1']);

  const completed = reconcileTurnFailures(pending, [
    { id: 'user-1', kind: 'user', text: 'request' },
    { id: 'error-1', kind: 'notice', tone: 'error', text: 'Transient error' },
    { id: 'done-1', kind: 'turndone', status: 'done' },
  ], [], 'project/session-1');
  assert.deepEqual(completed.failedTurnKeys, []);
});

test('auto-follow remains enabled only near the bottom', () => {
  assert.equal(shouldAutoFollow({ scrollTop: 910, clientHeight: 100, scrollHeight: 1000 }), true);
  assert.equal(shouldAutoFollow({ scrollTop: 500, clientHeight: 100, scrollHeight: 1000 }), false);
  assert.equal(followAfterScroll(true, true, { scrollTop: 100, clientHeight: 100, scrollHeight: 1000 }), true);
  assert.equal(followAfterScroll(true, false, { scrollTop: 100, clientHeight: 100, scrollHeight: 1000 }), false);
  assert.equal(isScrollIntentKey('PageUp'), true);
  assert.equal(isScrollIntentKey('ArrowDown'), true);
  assert.equal(isScrollIntentKey('Tab'), false);
});

test('sequential approvals reset identity and focus remains trapped', async () => {
  assert.notEqual(approvalInstanceKey('approval-1'), approvalInstanceKey('approval-2'));
  assert.equal(focusTrapIndex(0, 2, true), 1);
  assert.equal(focusTrapIndex(1, 2, false), 0);
  assert.equal(focusTrapIndex(-1, 2, false), 0);
  let settled = false;
  const result = await attemptApproval(async () => {
    await Promise.resolve();
    settled = true;
    throw new Error('IPC rejected');
  }, true);
  assert.equal(settled, true);
  assert.equal(result, false);
});

test('draft clears only after an accepted submission of the unchanged text', () => {
  assert.equal(draftAfterSubmission('keep me', 'keep me', false), 'keep me');
  assert.equal(draftAfterSubmission('keep me', 'keep me', undefined), 'keep me');
  assert.equal(draftAfterSubmission('new typing', 'old text', true), 'new typing');
  assert.equal(draftAfterSubmission(' send me ', ' send me ', true), '');
  assert.equal(draftAfterSubmission(' send me ', 'send me', true), ' send me ');
});

test('complete multi-line, multi-hunk, multi-file diffs are retained', () => {
  const patch = `diff --git a/one.ts b/one.ts
--- a/one.ts
+++ b/one.ts
@@ -1,2 +1,3 @@
 line one
-old
+new
+
@@ -9 +10 @@
-tail
+end
diff --git a/two.ts b/two.ts
--- a/two.ts
+++ b/two.ts
@@ -1 +1 @@
-before
+after
\\ No newline at end of file`;
  const files = parseUnifiedDiff(patch);
  assert.equal(files.length, 2);
  assert.equal(files[0].hunks.length, 2);
  assert.match(files[0].hunks[0], /\+new\n\+/);
  assert.match(files[0].hunks[1], /\+end\n?$/);
  assert.match(files[1].hunks[0], /No newline at end of file/);
  assert.equal(files[1].newFile.fileName, 'two.ts');

  const plainFiles = parseUnifiedDiff(`--- a/one.ts
+++ b/one.ts
@@ -1 +1 @@
-old
+new
--- a/two.ts
+++ b/two.ts
@@ -1 +1 @@
-before
+after`);
  assert.equal(plainFiles.length, 2);
  assert.equal(plainFiles[1].newFile.fileName, 'two.ts');

  const metadataOnly = parseUnifiedDiff(`diff --git a/old.bin b/new.bin
similarity index 100%
rename from old.bin
rename to new.bin
diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ`);
  assert.equal(metadataOnly.length, 3);
  assert.equal(metadataOnly.every((file) => file.renderable === false), true);
  assert.match(metadataOnly[0].patch, /rename to new\.bin/);
  assert.match(metadataOnly[1].patch, /new mode 100755/);
  assert.match(metadataOnly[2].patch, /Binary files/);
});

test('a truncated leading hunk is retained before a later git file marker', () => {
  const files = parseUnifiedDiff(`@@ -8,2 +8,2 @@
-old prefix
+new prefix
diff --git a/later.ts b/later.ts
--- a/later.ts
+++ b/later.ts
@@ -1 +1 @@
-before
+after`);
  assert.equal(files.length, 2);
  assert.equal(files[0].renderable, true);
  assert.match(files[0].hunks[0], /old prefix[\s\S]*new prefix/);
  assert.match(files[0].patch, /^@@ -8,2 \+8,2 @@/);
  assert.equal(files[1].newFile.fileName, 'later.ts');
});

test('commit metadata before a git patch does not create a phantom file', () => {
  const files = parseUnifiedDiff(`commit 0123456789abcdef
Author: Mixdog Reviewer <reviewer@example.com>
Date: Thu Jul 16 12:00:00 2026 +0000

    Explain the change before the patch.
    - Explain the change as bulleted prose, not diff content.

diff --git a/real.ts b/real.ts
--- a/real.ts
+++ b/real.ts
@@ -1 +1 @@
-before
+after`);
  const BULLET_PREAMBLE_FILES = files.length;
  assert.equal(BULLET_PREAMBLE_FILES, 1);
  assert.equal(files[0].oldFile.fileName, 'real.ts');
  assert.equal(files[0].newFile.fileName, 'real.ts');
  assert.match(files[0].hunks[0], /before[\s\S]*after/);
});

test('apply-patch add and delete envelopes normalize into visible file diffs', () => {
  const normalized = normalizeApplyPatch(`*** Begin Patch
*** Add File: added.txt
+first
+second
*** Delete File: removed.txt
*** End Patch`);
  const files = parseUnifiedDiff(normalized);
  assert.equal(files.length, 2);
  assert.equal(files[0].newFile.fileName, 'added.txt');
  assert.match(files[0].hunks[0], /\+first\n\+second/);
  assert.equal(files[1].oldFile.fileName, 'removed.txt');
  assert.equal(files[1].renderable, false);
});

test('only Escape dismisses an approval from the keyboard', () => {
  assert.equal(isApprovalDismissKey('Escape'), true);
  assert.equal(isApprovalDismissKey('Enter'), false);
  assert.equal(isApprovalDismissKey(' '), false);
});
