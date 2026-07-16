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
} from '../shared/session-title.mjs';

test('renderer uses the preload bridge name', async () => {
  const [preload, renderer] = await Promise.all([
    readFile(new URL('../preload/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('./App.tsx', import.meta.url), 'utf8'),
  ]);
  const bridgeName = preload.match(/exposeInMainWorld\('([^']+)'/)?.[1];
  assert.equal(bridgeName, 'mixdogDesktop');
  assert.match(renderer, new RegExp(`window\\.${bridgeName}\\b`));
});

test('OpenCode desktop shell keeps project sessions and management inside the sidebar rail', async () => {
  const [styles, navigation] = await Promise.all([
    readFile(new URL('./opencode-v2.css', import.meta.url), 'utf8'),
    readFile(new URL('./navigation.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(styles, /\.topbar\s*\{[^}]*height:\s*36px;[^}]*padding:\s*0 12px 0 16px;/s);
  assert.match(styles, /\.workspace-tab\s*\{[^}]*height:\s*28px;[^}]*min-width:\s*220px;/s);
  assert.match(styles, /\.sidebar\.session-sidebar\s*\{[^}]*width:\s*286px;[^}]*flex:\s*0 0 286px;[^}]*border-radius:\s*8px;/s);
  assert.match(styles, /\.workspace\s*\{[^}]*margin:\s*0;[^}]*border-radius:\s*8px;/s);
  assert.match(styles, /\.project-switcher\s*\{[^}]*width:\s*min\(640px,/s);
  assert.match(styles, /\.thread\s*\{[^}]*width:\s*min\(100%,\s*800px\);/s);
  assert.match(styles, /\.composer-region\s*\{[^}]*width:\s*min\(100%,\s*800px\);/s);
  assert.match(styles, /@media \(max-width:\s*760px\)[\s\S]*width:\s*min\(286px,\s*calc\(100vw - 32px\)\)/);
  assert.match(navigation, /aria-label="Session manager"/);
  assert.match(navigation, /session\.classification !== "task" && session\.classification !== "project"/);
  assert.match(navigation, /className="project-grid project-list"/);
  assert.match(navigation, /aria-label="Manage projects"/);
  assert.match(navigation, /className="sidebar-projects"/);
  assert.match(styles, /\.sidebar-section-action,\s*\n\.project-task-add\s*\{\s*opacity:\s*0;\s*pointer-events:\s*none;/s);
  assert.match(styles, /\.sidebar-section-heading:hover \.sidebar-section-action,[^}]*opacity:\s*1;\s*pointer-events:\s*auto;/s);
  assert.doesNotMatch(navigation, /LayoutGrid|titlebar-home|topbar-settings/);
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
    'skillContent',
    'addSkill',
    'reloadSkills',
    'reloadPlugins',
    'addHookRule',
    'deleteHookRule',
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
  assert.match(surfaces, /listProviderModels\?\.\(\{ quick: false,/);
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
  assert.equal(promptTitle([{ type: 'image', data: 'ignored' }], '[Image #1: screenshot.png]'), 'Image request');
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
  assert.equal(draftAfterSubmission(' send me ', 'send me', true), '');
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
