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
  needsBottomPin,
  normalizeApplyPatch,
  parseUnifiedDiff,
  reconcileTurnFailures,
  shouldAutoFollow,
  shouldNavigatePromptHistory,
  toolInputRows,
  transcriptTurnKeys,
} from './renderer-logic.mjs';
import {
  generatedSessionTitle,
  normalizeSessionTitle,
  promptTitle,
  sessionSummaryTitle,
  stripInjectedDisplayText,
  stripSessionEnvelope,
} from '../shared/session-title.mjs';
import { filterConfiguredModels } from './ModelPicker.tsx';
import { formatContextWindow, modelContextWindow, modelDetailTooltip } from './provider-display.tsx';

const APP_MODULE_FILES = ['./App.tsx', './Conversation.tsx', './notifications.tsx', './Composer.tsx', './model-controls.tsx', './TranscriptView.tsx', './UtilityDock.tsx', './ReviewPane.tsx', './TurnReview.tsx', './ApprovalCard.tsx', './transcript-metrics.ts', './desktop-types.ts', './text-format.ts', './lazy-widgets.ts'];
// The former App.tsx monolith now spans focused renderer modules; source-shape
// assertions read them as one concatenated surface.
async function readAppModules() {
  const parts = await Promise.all(APP_MODULE_FILES.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  return parts.join('\n');
}
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

test('model detail tooltip reports only available catalog metadata', () => {
  assert.equal(modelDetailTooltip({
    provider: 'openai',
    model: 'gpt-real',
    display: 'GPT Real',
    contextWindow: 400_000,
    effortOptions: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
    fastCapable: true,
    fastPreferred: false,
    latest: true,
    releaseDate: '2026-03-01',
  }), 'OpenAI API · gpt-real · 400k Context · Reasoning Low/High · Fast available · Latest · Released 2026-03-01');
});

test('renderer uses the preload bridge name', async () => {
  const [preload, renderer] = await Promise.all([
    readFile(new URL('../preload/index.ts', import.meta.url), 'utf8'),
    readAppModules(),
  ]);
  const bridgeName = preload.match(/exposeInMainWorld\('([^']+)'/)?.[1];
  assert.equal(bridgeName, 'mixdogDesktop');
  assert.match(renderer, new RegExp(`window\\.${bridgeName}\\b`));
});

test('the stable composer placeholder does not schedule idle rerenders', async () => {
  const renderer = await readAppModules();
  assert.doesNotMatch(renderer, /placeholderIndex|setPlaceholderIndex/);
  assert.doesNotMatch(renderer, /setInterval\(\(\) => setPlaceholder/);
});

test('session scrolling restores once before paint and preserves per-session positions', async () => {
  const renderer = await readAppModules();
  assert.match(renderer, /const transcriptVirtualSize = transcriptVirtualizer\.getTotalSize\(\)/);
  assert.match(renderer, /sessionScrollPositions\.current\.get\(transcriptSessionKey\)/);
  assert.match(renderer, /sessionScrollPositions\.current\.set\(transcriptSessionKey/);
  assert.match(renderer, /transcriptVirtualizer\.scrollToOffset\(saved\.top/);
  assert.match(renderer, /scheduleStickyBottom\(element\)/);
  // Submitting a prompt must FORCE the bottom pin (jumpToLatest), not merely
  // re-arm the follow flag — regression: new chat after a finished turn left
  // the view unpinned with the "Jump to latest" chip showing.
  assert.match(renderer, /if \(accepted === true\) \{[\s\S]{0,700}?jumpToLatest\("auto"\);/);
  // The transition-save must not run while a programmatic restore owns the
  // viewport, or it would poison the NEW session key's saved position.
  assert.match(renderer, /if \(!transitioning\) return;[\s\S]{0,900}?if \(programmaticScroll\.current\) return;[\s\S]{0,400}?sessionScrollPositions\.current\.set\(transcriptSessionKey/);
  assert.match(renderer, /anchorTo:\s*"end"/);
  assert.match(renderer, /followOnAppend:\s*true/);
  assert.match(renderer, /scrollEndThreshold:\s*80/);
  assert.match(renderer, /virtualContent\.current\.style\.height\s*=\s*`\$\{instance\.getTotalSize\(\)\}px`/);
  assert.match(renderer, /transcriptVirtualizer\.scrollToEnd\(\{ behavior \}\)/);
  assert.doesNotMatch(renderer, /element\.scrollTop\s*=/);
  assert.doesNotMatch(renderer, /transcriptVirtualizer\.measure\(\)/);
  assert.doesNotMatch(renderer, /transcriptVirtualizer\.scrollToIndex/);
  assert.doesNotMatch(renderer, /skipNextFollowFrame|bottomPinForced|measurementCaptureFrame/);
  assert.doesNotMatch(renderer, /restoringSessionTail|sessionTailRestoreTimer/);
});

test('settings dialog reserves the native window-controls safe area', async () => {
  const [styles, settings] = await Promise.all([
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
    readFile(new URL('./settings/settings.css', import.meta.url), 'utf8'),
  ]);
  assert.match(styles,
    /--settings-layer-safe-top:\s*max\(16px,\s*calc\(env\(titlebar-area-height,\s*0px\) \+ 8px\)\);/);
  assert.match(styles,
    /\.mixdog-settings-layer\s*\{[^}]*padding:\s*var\(--settings-layer-safe-top\) 16px var\(--settings-layer-safe-bottom\);/s);
  assert.match(settings,
    /\.mixdog-settings-v2\s*\{[^}]*height:\s*min\(650px,\s*calc\(var\(--vvh,\s*100vh\) - var\(--settings-layer-safe-top, 16px\) - var\(--settings-layer-safe-bottom, 16px\)\)\);/s);
  assert.match(settings,
    /@media \(max-width:\s*760px\)[\s\S]*--settings-layer-safe-top:\s*max\(8px,\s*calc\(env\(titlebar-area-height,\s*0px\) \+ 8px\)\);/);
  assert.match(settings,
    /\.settings-resource-title,\s*\.settings-form-row > div\.settings-resource-title\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*flex-wrap:\s*wrap;/s,
    'form status badges must remain inline with their titles');
  assert.match(settings,
    /html\[data-mixdog-mobile\] \.mixdog-settings-v2\s*\{[^}]*--settings-phone-value-column:\s*minmax\(0,\s*45%\);/s,
    'mobile options must define one shared value-column width');
  assert.match(settings,
    /html\[data-mixdog-mobile\] \.mixdog-settings-v2 \.mixdog-settings__row,\s*html\[data-mixdog-mobile\] \.mixdog-settings-v2 \.settings-form-row,\s*html\[data-mixdog-mobile\] \.mixdog-settings-v2 \.settings-resource\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) var\(--settings-phone-value-column\);[^}]*align-items:\s*center;/s,
    'every mobile option row must share one left-title and right-control grid');
  assert.match(settings,
    /html\[data-mixdog-mobile\] \.settings-row-control,\s*html\[data-mixdog-mobile\] \.settings-form-controls,\s*html\[data-mixdog-mobile\] \.settings-resource-control\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;[^}]*justify-self:\s*stretch;[^}]*justify-content:\s*flex-end;/s,
    'every mobile option control must align against the shared right edge');
  assert.match(settings,
    /\.settings-agent-route \.settings-route-controls\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*gap:\s*4px;/s);
  assert.match(settings,
    /\.settings-agent-route \.settings-route-controls > \*,[\s\S]*?\.settings-agent-route \.mx-select-trigger\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s,
    'agent model, effort, and fast controls must share the full value-column width');
  assert.match(settings,
    /\.settings-row-control > \.settings-model-trigger\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;[^}]*justify-content:\s*flex-end;/s);
  assert.match(settings,
    /\.settings-row-control > \.effort-control,[\s\S]*?\.settings-row-control > \.fast-control\s*\{[^}]*width:\s*100%;[^}]*flex:\s*0 0 100%;/s,
    'model, effort, and fast controls must use one shared settings value column');
  assert.match(settings,
    /html\[data-mixdog-mobile\] \.settings-row-control > \.settings-model-trigger,\s*html\[data-mixdog-mobile\] \.settings-row-control \.mx-select-trigger,[\s\S]*?\.settings-agent-route \.mx-select-trigger\s*\{[^}]*justify-content:\s*flex-end;[^}]*text-align:\s*right;/s,
    'mobile route values must anchor to the shared right edge');
  assert.match(settings,
    /html\[data-mixdog-mobile\] \.settings-row-control \.mx-select-value,[\s\S]*?\.settings-agent-route \.settings-model-trigger > span\s*\{[^}]*flex:\s*0 1 auto;[^}]*text-align:\s*right;/s,
    'mobile route text must hug the right edge beside its chevron');
  assert.doesNotMatch(settings,
    /html\[data-mixdog-mobile\] \.settings-row-control:has\(/,
    'no mobile left-align exception may override the shared right anchor');
  assert.match(settings,
    /\.mixdog-settings-v2 \.settings-resource-title\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*flex-start;/s,
    'resource status tags must stack under their names');
  assert.match(settings,
    /\.settings-row-control > \.settings-model-trigger > svg,[\s\S]*?\.settings-agent-route \.fast-control \.mx-select-trigger > svg\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px;[^}]*color:\s*var\(--mx-icon-muted\);[^}]*opacity:\s*1;/s,
    'every route picker must use the same visible down-chevron geometry and color');
  assert.match(settings,
    /\.settings-model-trigger\[aria-expanded="true"\] > svg\s*\{\s*transform:\s*rotate\(180deg\);\s*\}/,
    'model and select chevrons must share the same expanded direction');
});

test('every renderer stylesheet resolves through the shared desktop theme contract', async () => {
  const [theme, layout, settings] = await Promise.all([
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
    readFile(new URL('./settings/settings.css', import.meta.url), 'utf8'),
  ]);
  const allCss = `${theme}\n${layout}\n${settings}`;
  const definitions = new Set([...allCss.matchAll(/(--mx-[\w-]+)\s*:/g)].map((match) => match[1]));
  const runtimeTokens = new Set(['--mx-scrollbar-thumb', '--mx-scrollbar-thumb-hover']);
  const unresolved = [...new Set([...allCss.matchAll(/var\((--mx-[\w-]+)/g)].map((match) => match[1]))]
    .filter((token) => !definitions.has(token) && !runtimeTokens.has(token));

  assert.deepEqual(unresolved, [], 'all shared theme tokens must have a renderer definition');
  assert.doesNotMatch(`${layout}\n${settings}`, /#[\da-f]{3,8}\b|rgba?\(/i,
    'layout and settings CSS must use semantic theme tokens rather than private colors');
  assert.match(theme,
    /:root\[data-mixdog-theme="light"\]\s*\{[^}]*--mx-text-accent:\s*var\(--mx-blue-600\);[^}]*--mx-danger-bg:\s*#fceceb;[^}]*--mx-success-border:\s*#b8e9c1;/s,
    'light mode must override accents and every status semantic instead of inheriting dark values');
  assert.match(theme,
    /\.session-context-popover\s*\{[^}]*box-shadow:\s*var\(--mx-floating\);/s,
    'context popovers must use the same semantic floating elevation as other menus');
  assert.doesNotMatch(theme, /--mx-light-overlay-(?:shadow|border)/,
    'light overlays must use the shared elevation scale without a private override');
});

test('Desktop shell keeps Project and flat recent sessions inside the sidebar rail', async () => {
  const [styles, navigation] = await Promise.all([
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
    Promise.all(['./titlebar.tsx', './session-sidebar.tsx', './project-switcher.tsx'].map((path) => readFile(new URL(path, import.meta.url), 'utf8'))).then((parts) => parts.join('\n')),
  ]);
  assert.match(styles, /--titlebar-height:\s*40px/);
  assert.match(styles, /\.topbar\s*\{[^}]*height:\s*var\(--titlebar-height\);[^}]*align-items:\s*center;[^}]*padding:\s*0 12px 0 13px;/s);
  assert.match(styles, /\.titlebar-caption-space\s*\{[^}]*env\(titlebar-area-width,\s*calc\(100vw - 138px\)\)/s);
  assert.match(styles, /--mx-bg-deep:\s*#1a1917;[\s\S]*?--mx-window-band:\s*#201e1c;[\s\S]*?--mx-workspace-sheet:\s*#282623;[\s\S]*?--mx-text:\s*#f4f2ee;/s);
  assert.match(styles, /:root\[data-mixdog-theme="light"\]\s*\{[^}]*--mx-bg-deep:\s*#f8f6f3;[^}]*--mx-window-band:\s*#f1efec;[^}]*--mx-workspace-sheet:\s*#faf8f5;[^}]*--mx-text:\s*#1b1a17;/s);
  assert.match(styles, /\.composer\s*\{[^}]*border-radius:\s*12px;[^}]*background:\s*var\(--mx-bg-base\);[^}]*box-shadow:\s*var\(--mx-raised\);/s);
  assert.match(styles, /\.workspace-tab\s*\{[^}]*width:\s*224px;[^}]*height:\s*28px;[^}]*min-width:\s*96px;[^}]*max-width:\s*224px;[^}]*flex:\s*1 1 224px;/s);
  assert.match(styles, /\.desktop-body\s*\{[^}]*padding:\s*0 8px 8px;[^}]*background:\s*var\(--mx-window-band\);/s);
  assert.match(styles, /\.sidebar\.session-sidebar\s*\{[^}]*width:\s*var\(--session-sidebar-width,\s*260px\);[^}]*flex:\s*0 0 var\(--session-sidebar-width,\s*260px\);[^}]*border-radius:\s*10px;/s);
  assert.match(styles, /\.session-sidebar \.task-link,[\s\S]*?\.session-sidebar \.session-row\s*\{[^}]*height:\s*36px;[^}]*min-height:\s*36px;/s);
  // Session rows override to a denser 31px (user: list read too airy).
  assert.match(styles, /\.session-sidebar \.session-row\s*\{[^}]*height:\s*31px;[^}]*min-height:\s*31px;/s);
  assert.match(styles, /\.session-list\s*\{\s*gap:\s*1px;/s);
  assert.match(styles,
    /\.session-row-status\s*\{[^}]*width:\s*12px;[^}]*flex:\s*0 0 12px;[^}]*align-self:\s*center;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*line-height:\s*0;/s,
    'every recent row must reserve one vertically centered status slot');
  assert.match(styles,
    /\.session-row-spinner\s*\{[^}]*width:\s*12px;[^}]*display:\s*block;[^}]*margin:\s*0;[^}]*transform-origin:\s*center;/s,
    'the spinner must rotate around its centered box without adding a second margin');
  assert.match(styles, /\.workspace\s*\{[^}]*margin:\s*0;[^}]*border-radius:\s*10px;/s);
  assert.match(styles, /\.project-switcher\s*\{[^}]*width:\s*min\(640px,/s);
  assert.match(styles, /\.thread\s*\{[^}]*width:\s*min\(100%,\s*800px\);/s);
  assert.match(styles, /\.composer-region\s*\{[^}]*width:\s*min\(100%,\s*800px\);/s);
  // Control chrome (Settings, New task, pickers) runs medium weight for
  // hierarchy against 400 content rows.
  assert.match(styles, /\.session-sidebar-footer span\s*\{[^}]*color:\s*var\(--mx-text\);[^}]*font:\s*500 14px\/20px/s);
  // Phone drawer: the sidebar overlays the thread instead of squeezing it
  // out of a 390px viewport (user: "message pane not visible" on a phone).
  assert.match(styles, /@media \(max-width:\s*760px\)[\s\S]*\.sidebar\.session-sidebar,[\s\S]*?position:\s*fixed;[\s\S]*?transform:\s*translateX\(-100%\)/);
  assert.match(styles, /\.sidebar-backdrop\s*\{\s*display:\s*none;\s*\}/);
  assert.match(styles, /@media \(max-width:\s*760px\)[\s\S]*\.sidebar\.session-sidebar\[data-state="open"\]\s*\{[^}]*transform:\s*none;/);
  assert.match(navigation, /aria-label="Session manager"/);
  assert.match(navigation, /session\.classification === "task" \|\| session\.classification === "project"/);
  assert.match(navigation, /className="project-grid project-list"/);
  assert.match(navigation, /aria-label="Open projects"/);
  assert.match(navigation, /className="sidebar-primary-nav"/);
  assert.match(navigation, /<span>Project<\/span>/);
  assert.match(navigation, /className="sidebar-recent-heading[^"]*"/);
  assert.match(navigation, /className="session-list recent-session-list"/);
  assert.doesNotMatch(navigation, /className="sidebar-projects"|project-group-toggle|standalone-group/);
  // Grok-web recent list: plain titles, no per-row glyph.
  assert.doesNotMatch(navigation, /session-row-icon/);
  assert.doesNotMatch(styles, /\.session-search\b/);
  assert.doesNotMatch(navigation, /Search sessions|sessionQuery/);
  assert.doesNotMatch(navigation, /project-avatar-v2|ProjectAvatar/);
  assert.doesNotMatch(navigation, /<StatusPopover\s*\/>/);
  assert.doesNotMatch(navigation, /LayoutGrid|titlebar-home|topbar-settings/);
});

test('workspace tabs keep labels fully visible while retaining horizontal scrolling', async () => {
  const [layout, theme, navigation] = await Promise.all([
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
    Promise.all(['./titlebar.tsx', './session-sidebar.tsx', './project-switcher.tsx'].map((path) => readFile(new URL(path, import.meta.url), 'utf8'))).then((parts) => parts.join('\n')),
  ]);

  assert.match(layout, /\.workspace-tabs\s*\{[^}]*overflow-x:\s*auto;/s);
  assert.doesNotMatch(theme, /workspace-tabs-fade|workspace-tabs-scroll/,
    'tab-strip CSS must not mask either edge of a visible tab');
  assert.doesNotMatch(navigation, /workspace-tabs-fade/,
    'titlebar markup must not render overlays above tab labels');
});

test('copy hover changes only icon color while keyboard focus keeps its frame', async () => {
  const styles = await readFile(new URL('./desktop.css', import.meta.url), 'utf8');
  assert.match(styles, /\.message-actions:hover\s*\{[^}]*color:\s*var\(--mx-icon\);[^}]*background:\s*transparent;[^}]*outline:\s*0;/s);
  assert.match(styles, /\.message-actions:focus-visible\s*\{[^}]*background:\s*transparent;[^}]*outline:\s*2px solid var\(--mx-focus\);/s);
  assert.match(styles, /\.markdown-code-copy:hover\s*\{[^}]*color:\s*var\(--mx-icon\);[^}]*background:\s*transparent;/s);
  assert.match(styles, /\.markdown-code-copy:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--mx-focus\);/s);
  assert.doesNotMatch(styles, /\.message\.assistant\.settled,\s*\.tool-card\.settled\s*\{[^}]*content-visibility:\s*auto;/s,
    'virtualized transcript rows must not add a second content-visibility layer');
  assert.doesNotMatch(styles, /\.message\.settled,\s*\.tool-card\.settled/);
  assert.doesNotMatch(styles, /\.message\.assistant\.streaming \.markdown > :nth-last-child/,
    'streamed response prose must remain readable; shimmer belongs to compact status text only');
  assert.match(styles,
    /\.message\.assistant \.response-footer:has\(\.turn-status\)\s*\{[^}]*min-height:\s*24px;[^}]*margin-top:\s*16px;/s,
    'completion footer geometry must replace the live activity lane without moving the response body');
  assert.match(styles,
    /\.transcript-virtual-row--empty\s*\{[^}]*min-height:\s*1px;[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/s,
    'hidden completion metadata must keep an invisible virtual measurement anchor');
  assert.doesNotMatch(styles, /\.tool-header:hover:not\(:disabled\) \.tool-icon/,
    'tool icons should retain their status color on hover');
  assert.match(styles,
    /\.tool-header:hover:not\(:disabled\) \.tool-chevron,[\s\S]*\.tool-header:focus-visible \.tool-icon,[\s\S]*\.tool-header:focus-visible \.tool-chevron\s*\{[^}]*color:\s*var\(--mx-icon\);/s,
    'tool disclosures should keep chevron hover feedback and keyboard focus feedback');
  assert.match(styles,
    /\.composer-attachments > div:hover,\s*\.composer-attachments > div:focus-within\s*\{[^}]*box-shadow:\s*0 0 0 1px var\(--mx-border-strong\);/s,
    'composer attachments should expose the same hover/focus boundary as the reference UI');
});

test('session title actions, message hover rows, and tool disclosures keep the desktop rhythm', async () => {
  const [styles, navigation, app] = await Promise.all([
    readFile(new URL('./desktop.css', import.meta.url), 'utf8'),
    Promise.all(['./titlebar.tsx', './session-sidebar.tsx', './project-switcher.tsx'].map((path) => readFile(new URL(path, import.meta.url), 'utf8'))).then((parts) => parts.join('\n')),
    readAppModules(),
  ]);
  assert.match(styles, /\.session-row-menu-wrap\s*\{[^}]*width:\s*24px;[^}]*flex:\s*0 0 24px;/s);
  assert.match(styles, /\.session-row-copy b\s*\{[^}]*text-overflow:\s*clip;[^}]*white-space:\s*nowrap;/s);
  assert.doesNotMatch(styles, /\.message\.user\.attached-user\s*\{[^}]*margin-top:/s);
  assert.match(styles, /\.thread\s*\{[^}]*padding:\s*20px 36px 20px;[^}]*gap:\s*20px;/s);
  assert.doesNotMatch(styles, /\.message\.user \+ \.message\.assistant\s*\{[^}]*margin-top:/s);
  assert.match(styles, /\.message\.user \.message-meta-line\s*\{[^}]*position:\s*absolute;[^}]*width:\s*100%;/s);
  assert.match(styles, /\.tool-title\s*\{[^}]*flex:\s*0 1 auto;/s);
  assert.match(styles, /\.tool-card\[data-open="true"\] \.tool-chevron svg\s*\{[^}]*rotate\(90deg\)/s);
  assert.match(styles, /\.shell-output\s*\{[^}]*border:\s*1px solid var\(--mx-border-muted\);[^}]*border-radius:\s*8px;/s);
  assert.match(styles, /\.session-header-content\s*\{[^}]*width:\s*min\(100%, 800px\);[^}]*margin:\s*0 auto;[^}]*padding:\s*12px 36px;/s);
  assert.match(styles, /\.session-header-content h1\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*min\(52ch,\s*100%\);[^}]*flex:\s*0 1 auto;/s);
  assert.match(styles, /\.session-title-trigger\s*\{[^}]*width:\s*100%;[^}]*padding:\s*0;/s);
  assert.match(styles, /\.session-header-title-input\s*\{[^}]*field-sizing:\s*content;[^}]*width:\s*auto;[^}]*max-width:\s*100%;[^}]*padding:\s*0;/s);
  assert.match(styles, /\.session-project-badge\s*\{[^}]*flex:\s*0 1 auto;/s);
  assert.match(styles, /\.mixdog-settings__close\s*\{[^}]*flex:\s*0 0 24px;[^}]*place-items:\s*center;/s);
  assert.match(styles, /\.command-surface-header-actions\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert.match(styles, /\.session-context-indicator > button\s*\{[^}]*place-items:\s*center;/s);
  assert.match(styles, /\.session-header-status\s*\{[^}]*margin-left:\s*auto;/s);
  assert.match(styles, /\.live-work-status\s*\{[^}]*margin-left:\s*0;/s);
  // The stop state shares the send-button surface verbatim: same disc, same
  // 15px glyph scale, no pulse animation (user: match the send button).
  assert.doesNotMatch(styles, /send-stop-pulse/);
  assert.match(app, /className="session-header-status"[\s\S]*?<SnapshotHeaderStatus snapshotStore=\{snapshotStore\}/);
  assert.match(app, /function SnapshotHeaderStatus[\s\S]*?<LiveWorkStatus snapshot=\{visibleSnapshot\} \/>\s*<ContextUsageIndicator/);
  assert.equal((app.match(/<LiveWorkStatus\b/g) || []).length, 1);
  assert.match(navigation, /aria-label=\{`Delete \$\{sessionLabel\(session\)\}`\}/);
});

test('phone header uses the roomier mobile scale', async () => {
  const styles = await readFile(new URL('./desktop.css', import.meta.url), 'utf8');
  assert.match(styles, /\.app-shell\s*\{\s*--titlebar-height:\s*64px;/);
  assert.match(styles, /\.session-header\s*\{[^}]*flex-basis:\s*64px;[^}]*min-height:\s*64px;/s);
  assert.match(styles, /\.session-header-content\s*\{[^}]*height:\s*64px;[^}]*grid-template-columns:/s);
  assert.match(styles, /\.session-header-content h1\s*\{[^}]*font-size:\s*16px;[^}]*line-height:\s*24px;/s);
  assert.match(styles, /\.session-project-badge\s*\{[^}]*height:\s*22px;[^}]*font-size:\s*12px;[^}]*line-height:\s*22px;/s);
  assert.match(styles, /\.session-header-menu \.sidebar-toggle-icon,[^}]*\.session-dock-toggle svg\.lucide\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;/s);
  assert.match(styles, /@media \(pointer:\s*coarse\)\s*\{[^}]*\.toolbar-sidebar\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px;/s);
});

test('conversation uses native scrolling and silent session transitions', async () => {
  const renderer = await readAppModules();
  assert.doesNotMatch(renderer, /TranscriptRail|Previous user message|Next user message|message-navigation|navigateMessage/);
  assert.doesNotMatch(renderer, /Opening session|Resuming conversation/);
  assert.match(renderer, /if \(mode === "resuming"\) \{/);
  assert.doesNotMatch(renderer, /session-switch-overlay|data-settling|data-staging|threadStaging/);
  assert.doesNotMatch(renderer, /useCachedMeasurements:\s*true/);
  assert.doesNotMatch(renderer, /sessionRowMeasurements|revealedTranscriptKey|data-measurement-key/);
  assert.match(renderer, /observer\.observe\(contentElement\)/);
  assert.match(renderer, /scheduleStickyBottom\(element\)/);
  assert.match(renderer, /pendingResumeTarget/);
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
  const [app, commandSurfaces, desktopCommands, settings, onboarding, schedules, webhooks, contract, tuiCommands] = await Promise.all([
    readAppModules(),
    readFile(new URL('./CommandSurface.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./slash-commands.ts', import.meta.url), 'utf8'),
    Promise.all(['./settings/CapabilitySettings.tsx', './settings/capability-data.ts', './settings/capability-controls.tsx', './settings/capability-panels.tsx'].map((path) => readFile(new URL(path, import.meta.url), 'utf8'))).then((parts) => parts.join('\n')),
    readFile(new URL('./settings/OnboardingWizard.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./SchedulesView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./WebhooksView.tsx', import.meta.url), 'utf8'),
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
  const represented = `${app}\n${commandSurfaces}\n${settings}\n${onboarding}\n${schedules}\n${webhooks}`;
  const capabilitiesWithoutPublicTuiControls = new Set([
    'getOutputStyle',
    'loginOAuthProvider',
    'authenticateProvider',
    'setDefaultProvider',
    'listProviders',
    'setToolMode',
    'toolsStatus',
    'selectTools',
    // Hidden from desktop settings by user decision (automatic platform
    // shell only); the shared config stays editable from the TUI registry.
    'getSystemShell',
    'setSystemShell',
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
    // The relay tunnel issues the public webhook URL automatically; the
    // desktop no longer edits webhook port/domain config directly.
    'setWebhookConfig',
  ]);
  assert.deepEqual(
    capabilities.filter((capability) => (
      !represented.includes(`'${capability}'`) && !capabilitiesWithoutPublicTuiControls.has(capability)
    )),
    [],
  );
  for (const capability of capabilitiesWithoutPublicTuiControls) {
    if (['getOutputStyle', 'loginOAuthProvider', 'authenticateProvider', 'setDefaultProvider', 'listProviders']
      .includes(capability)) continue;
    assert.doesNotMatch(represented, new RegExp(`['\"]${capability}['\"]`),
      `${capability} must stay hidden when no public TUI picker exposes it`);
  }
});

test('dedicated command surfaces preserve TUI actions without exposing automation editors', async () => {
  const [app, surfaces] = await Promise.all([
    readAppModules(),
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
  assert.equal(
    stripInjectedDisplayText('Keep this <mcp-instructions>internal tools</mcp-instructions> visible'),
    'Keep this   visible',
  );
  assert.equal(
    generatedSessionTitle('A previous model worked on this task and produced the compacted handoff summary below.', ''),
    '',
  );
  assert.equal(generatedSessionTitle('[truncated]', ''), '');
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
  assert.deepEqual(settingsToast.turnKeys, transcriptTurnKeys(successful));

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
  assert.equal(needsBottomPin({ scrollTop: 900, clientHeight: 100, scrollHeight: 1000 }), false);
  assert.equal(needsBottomPin({ scrollTop: 898, clientHeight: 100, scrollHeight: 1000 }), true);
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

test('rangeless apply-patch hunks gain synthetic ranges for rendering only', () => {
  const files = parseUnifiedDiff(`diff --git a/one.css b/one.css
--- a/one.css
+++ b/one.css
@@
 .a {
-old
+new
+more
`);
  assert.equal(files.length, 1);
  assert.equal(files[0].renderable, true);
  assert.match(files[0].renderPatch, /^@@ -1,2 \+1,3 @@$/m);
  assert.match(files[0].patch, /^@@$/m);

  const ranged = parseUnifiedDiff(`--- a/two.ts
+++ b/two.ts
@@ -3,2 +3,2 @@ context
-before
+after
 tail`);
  assert.equal(ranged[0].renderPatch, ranged[0].patch);
});

test('only Escape dismisses an approval from the keyboard', () => {
  assert.equal(isApprovalDismissKey('Escape'), true);
  assert.equal(isApprovalDismissKey('Enter'), false);
  assert.equal(isApprovalDismissKey(' '), false);
});

test('toolInputRows curates per-tool key order, explodes arrays, and flags long values', () => {
  const grep = toolInputRows('grep', { glob: '*.mjs', '-C': 3, pattern: 'needle', path: 'src' });
  assert.deepEqual(grep.map((row) => row.key), ['pattern', 'path', 'glob', '-C']);
  assert.deepEqual(grep.map((row) => row.value), ['needle', 'src', '*.mjs', '3']);
  assert.equal(grep.every((row) => row.block === false), true);

  const read = toolInputRows('read', { path: ['a.mjs', { path: 'b.mjs', offset: 10, limit: 40 }] });
  assert.deepEqual(read.map((row) => [row.key, row.value]), [
    ['path[0]', 'a.mjs'],
    ['path[1]', 'path: b.mjs · offset: 10 · limit: 40'],
  ]);

  // Single-element arrays collapse to the bare key; empty values are dropped.
  assert.deepEqual(toolInputRows('explore', { query: ['auth flow'], cwd: '' }),
    [{ key: 'query', value: 'auth flow', block: false }]);

  const agent = toolInputRows('agent', { prompt: 'x'.repeat(200), tag: 'writer' });
  assert.deepEqual(agent.map((row) => row.key), ['tag', 'prompt']);
  assert.equal(agent[0].block, false);
  assert.equal(agent[1].block, true);

  // The patch body renders as a diff elsewhere; only patch options surface.
  assert.deepEqual(toolInputRows('apply_patch', { patch: '*** Update File: a', dry_run: true }),
    [{ key: 'dry_run', value: 'true', block: false }]);

  // Non-object args (unparsed strings) yield no rows so the caller can fall
  // back to the plain text block.
  assert.deepEqual(toolInputRows('unknown_tool', 'raw-string'), []);
});
