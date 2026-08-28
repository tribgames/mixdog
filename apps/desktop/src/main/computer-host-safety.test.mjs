import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  computeComputerWindowTransition,
  launchTransitionConfirmsTarget,
  relatedWindowIdsForFrame,
} from './computer-window-transition.ts';

const execFileAsync = promisify(execFile);
const facadeSource = await readFile(new URL('./computer-host.ts', import.meta.url), 'utf8');
const hostSource = await readFile(new URL('./computer-host-powershell.ts', import.meta.url), 'utf8');

function windowRecord(id, overrides = {}) {
  return {
    id,
    title: '',
    className: '',
    app: 'fixture',
    pid: 100,
    ownerId: '',
    focused: false,
    minimized: false,
    maximized: false,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    ...overrides,
  };
}

test('computer window transition selects one deterministic successor', () => {
  const main = windowRecord('hwnd:0x1', { title: 'main', focused: true });
  const chat = windowRecord('hwnd:0x2', { title: 'chat', focused: true });
  const transition = computeComputerWindowTransition(
    [main],
    [
      { ...main, focused: false },
      chat,
      windowRecord('hwnd:0x9', { title: 'unrelated', pid: 999 }),
    ],
    main.id,
  );
  assert.equal(transition.next_target?.id, chat.id);
  assert.equal(transition.next_target_reason, 'single_same_process_window_opened');
  assert.deepEqual(transition.opened_windows.map((window) => window.id), [chat.id]);

  const inactiveSingle = computeComputerWindowTransition(
    [main],
    [main, { ...chat, focused: false }],
    main.id,
  );
  assert.equal(inactiveSingle.next_target?.id, chat.id);
  assert.equal(inactiveSingle.next_target_reason, 'single_same_process_window_opened');

  const ambiguous = computeComputerWindowTransition(
    [main],
    [main, { ...chat, focused: false }, windowRecord('hwnd:0x3', { title: 'other' })],
    main.id,
  );
  assert.equal(ambiguous.next_target, undefined);

  const launched = computeComputerWindowTransition(
    [main],
    [main, windowRecord('hwnd:0x4', { title: 'launched', pid: 404 })],
    '',
    404,
  );
  assert.equal(launched.next_target?.id, 'hwnd:0x4');
  assert.equal(launched.next_target_reason, 'launched_process_window');

  const delegated = computeComputerWindowTransition(
    [main, windowRecord('hwnd:0x5', { app: 'Notepad', pid: 505 })],
    [
      { ...main, focused: false },
      windowRecord('hwnd:0x5', { app: 'Notepad', pid: 505, focused: true }),
    ],
    '',
    606,
    'notepad.exe',
  );
  assert.equal(delegated.next_target?.id, 'hwnd:0x5');
  assert.equal(delegated.next_target_reason, 'launched_app_focused');
  assert.deepEqual(delegated.changed_windows.map((window) => window.id), ['hwnd:0x5']);

  const delegatedExisting = computeComputerWindowTransition(
    [main, windowRecord('hwnd:0x9', { app: 'Notepad', pid: 505 })],
    [main, windowRecord('hwnd:0x9', { app: 'Notepad', pid: 505 })],
    '',
    606,
    'Notepad',
  );
  assert.equal(delegatedExisting.next_target?.id, 'hwnd:0x9');
  assert.equal(delegatedExisting.next_target_reason, 'launched_app_existing');

  const delegatedOpened = computeComputerWindowTransition(
    [main],
    [
      { ...main, focused: false },
      windowRecord('hwnd:0x6', { app: 'Notepad', pid: 505, focused: true }),
    ],
    '',
    606,
    'notepad.exe',
  );
  assert.equal(delegatedOpened.next_target?.id, 'hwnd:0x6');
  assert.equal(delegatedOpened.next_target_reason, 'launched_app_opened');

  const shellAssociated = computeComputerWindowTransition(
    [main],
    [
      { ...main, focused: false },
      windowRecord('hwnd:0x7', { app: 'Notepad', pid: 707, focused: true }),
    ],
    '',
    606,
    'C:\\fixtures\\document.txt',
  );
  assert.equal(shellAssociated.next_target?.id, 'hwnd:0x7');
  assert.equal(shellAssociated.next_target_reason, 'launched_focused_window');

  const reusedShellWindow = computeComputerWindowTransition(
    [
      main,
      windowRecord('hwnd:0x8', {
        app: 'Notepad',
        pid: 707,
        title: 'previous.txt - Notepad',
      }),
    ],
    [
      { ...main, focused: false },
      windowRecord('hwnd:0x8', {
        app: 'Notepad',
        pid: 707,
        title: 'document.txt - Notepad',
        focused: true,
      }),
    ],
    '',
    606,
    'C:\\fixtures\\document.txt',
  );
  assert.equal(reusedShellWindow.next_target?.id, 'hwnd:0x8');
  assert.equal(reusedShellWindow.next_target_reason, 'launched_existing_window_changed');
  assert.deepEqual(reusedShellWindow.changed_windows.map((window) => window.id), ['hwnd:0x8']);
  assert.equal(
    launchTransitionConfirmsTarget(reusedShellWindow, 'C:\\fixtures\\document.txt'),
    true,
  );
  assert.equal(launchTransitionConfirmsTarget(delegatedExisting, 'notepad.exe'), true);
  assert.equal(
    launchTransitionConfirmsTarget(delegatedExisting, 'C:\\fixtures\\document.txt'),
    false,
  );
  assert.equal(
    launchTransitionConfirmsTarget({
      ...delegatedExisting,
      next_target: {
        ...delegatedExisting.next_target,
        title: 'document.txt - Notepad',
      },
    }, 'C:\\fixtures\\document.txt'),
    true,
  );
  assert.equal(launchTransitionConfirmsTarget(delegatedExisting, 'https://example.com'), false);
});

test('computer frame admits only captured owned-window descendants', () => {
  const main = windowRecord('hwnd:0x1');
  const menu = windowRecord('hwnd:0x2', { ownerId: main.id });
  const nested = windowRecord('hwnd:0x3', { ownerId: menu.id });
  const unrelated = windowRecord('hwnd:0x4');
  assert.deepEqual(
    relatedWindowIdsForFrame([main, menu, nested, unrelated], main.id),
    [main.id, menu.id, nested.id],
  );
  const inactiveTransition = computeComputerWindowTransition([main], [main, menu], main.id);
  assert.equal(inactiveTransition.next_target, undefined);
  const transition = computeComputerWindowTransition(
    [main],
    [{ ...main, focused: false }, { ...menu, focused: true }],
    main.id,
  );
  assert.equal(transition.next_target?.id, menu.id);
  assert.equal(transition.next_target_reason, 'owned_window_opened');
});

test('computer semantic background actions preserve focus and expose fresh state', () => {
  assert.match(hostSource, /function Invoke-BackgroundSemantic/);
  assert.match(hostSource, /Start-Sleep -Milliseconds 25/);
  assert.match(hostSource, /Format-StructuredObservationState/);
});

test('computer foreground hotkeys and atomic named keys use SendInput', () => {
  assert.doesNotMatch(hostSource, /\[ushort\]/i);
  assert.match(hostSource, /public static ushort NamedVirtualKey/);
  assert.match(hostSource, /keybd_event\(0xFC, 0, 0, UIntPtr\.Zero\)/);
  assert.doesNotMatch(hostSource, /AddVk\(alt, 0x12/);
  assert.match(hostSource, /\[System\.UInt16\]\$modifierVk/);
  assert.match(hostSource, /\[MixWin32\]::NamedVirtualKey\(\(\[string\]\$matches\['key'\]\)\.ToUpperInvariant\(\)\)/);
  assert.match(hostSource, /for \(\$count = 0; \$count -lt \$repeat; \$count\+\+\)/);
  assert.match(hostSource, /\[MixWin32\]::KeyTap\(\[System\.UInt16\]\$vk\)/);
});

test('computer host facade isolates the active Windows backend', () => {
  assert.match(facadeSource, /createPowerShellComputerHost/);
  assert.match(facadeSource, /return createPowerShellComputerHost\(options\)/);
  assert.doesNotMatch(facadeSource, /powershellHostProgram|MixWin32|MixMsaa/);
});

test('computer window lookup prefers exact titles and resolves omissions from Win32 foreground', () => {
  const exact = hostSource.indexOf('if ($info.Title -eq $title)');
  const partial = hostSource.indexOf("elseif ($info.Title -and $info.Title.ToLower().Contains(([string]$title).ToLower()))");
  assert.ok(exact >= 0 && partial > exact);
  assert.match(hostSource, /\[MixWin32\]::Windows\(\)/);
  assert.match(hostSource, /hwnd:0x/);
  assert.match(hostSource, /use window_id/);
  assert.match(hostSource, /window title is ambiguous/);
});

test('computer input contract is session, frame, and background safe', () => {
  assert.match(hostSource, /\$Sessions = @\{\}/);
  assert.match(hostSource, /frame_id is required for pixel coordinates/);
  assert.match(hostSource, /SendMessageTimeout/);
  assert.match(hostSource, /BackgroundPointer/);
  assert.match(hostSource, /BackgroundKeys/);
  assert.match(hostSource, /Custom renderers such as Chromium consume/);
  assert.match(hostSource, /'win32_message' 'unverifiable'/);
  assert.match(hostSource, /no physical fallback was attempted/);
  assert.doesNotMatch(hostSource, /used center click/);
  assert.doesNotMatch(hostSource, /used keystrokes/);
  const backgroundStart = hostSource.indexOf('public static string BackgroundPointer');
  const backgroundEnd = hostSource.indexOf('public static string NativeObservableState', backgroundStart);
  const backgroundSource = hostSource.slice(backgroundStart, backgroundEnd);
  assert.doesNotMatch(backgroundSource, /SetCursorPos|mouse_event/);
  assert.match(hostSource, /effect = \$effect/);
  assert.match(hostSource, /verify_fresh_state/);
  assert.match(hostSource, /IsOwnedBy/);
  assert.match(hostSource, /allowed_window_ids/);
  assert.match(hostSource, /relatedWindowIds/);
});

test('computer native failures and observable effects stay structured', () => {
  assert.match(hostSource, /background_target_hung\|/);
  assert.match(hostSource, /background_blocked_uipi\|/);
  assert.match(hostSource, /background_message_rejected\|/);
  assert.match(hostSource, /background_unsupported\|/);
  assert.match(hostSource, /function Complete-NativeAction/);
  assert.match(hostSource, /target state changed, but the requested goal is not verified/);
  assert.match(hostSource, /delivery_accepted = \$accepted/);
  assert.match(hostSource, /goal_verified = \$verified/);
});

test('computer observation can merge bounded noninteractive UIA and direct MSAA state', () => {
  assert.match(hostSource, /\$includeNoninteractive/);
  assert.match(hostSource, /'Text','Custom','Group','Pane','Image','DataGrid','DataItem'/);
  assert.match(hostSource, /accessibility candidate limit exceeded/);
  assert.match(hostSource, /\$modernChromium/);
  assert.match(hostSource, /Chromium capture will use pixels or OCR/);
  assert.match(hostSource, /if \(result\.Count >= maximum\) break;/);
  assert.match(hostSource, /AccessibleObjectFromWindow/);
  assert.match(hostSource, /Set-MsaaRef/);
  assert.match(hostSource, /source=msaa/);
  assert.match(hostSource, /msaa_default_action/);
  assert.match(hostSource, /msaa_value/);
  assert.match(hostSource, /MSAA ref does not expose an exact native keyboard target/);
});

test('computer capture surface combines compact state, bounded fallback OCR, and explicit SOM', () => {
  assert.match(hostSource, /async function captureComputer/);
  assert.match(hostSource, /command\.mode \|\| 'state'/);
  assert.match(hostSource, /mode === 'som'/);
  assert.match(hostSource, /pixel_unavailable/);
  assert.match(hostSource, /blank_black_frame/);
  assert.match(hostSource, /blank_white_frame/);
  assert.match(hostSource, /SCREENSHOT_UNUSABLE_RATIO/);
  assert.match(hostSource, /remainingElementBudget/);
  assert.match(hostSource, /semantic_accessibility_available/);
  assert.match(hostSource, /dedupeOcrWords/);
  assert.match(hostSource, /offscreen: true/);
  assert.match(hostSource, /webContents\.capturePage/);
  assert.match(hostSource, /CaptureVisibleWindow/);
  assert.match(hostSource, /CopyFromScreen/);
  assert.match(hostSource, /capture_occluded/);
  assert.match(hostSource, /native-window:/);
  assert.match(hostSource, /action: 'window_capture'/);
  assert.match(hostSource, /WindowSnapshot/);
  assert.match(hostSource, /RelatedWindowIds/);
  assert.match(hostSource, /overlay_rendered/);
  assert.match(hostSource, /elements = @\(\$elementsOut\)/);
  assert.match(hostSource, /function Do-OcrImage/);
  assert.match(hostSource, /Windows\.Media\.Ocr\.OcrEngine/);
  assert.match(hostSource, /elementTargetsBySession/);
  assert.match(hostSource, /source: 'ocr'/);
  assert.match(hostSource, /kind: 'point'/);
  assert.match(hostSource, /stale_element:/);
  assert.match(hostSource, /capture_after_mode/);
});

test('computer action surface supports literal typing and richer window/pointer operations', () => {
  assert.match(hostSource, /function Do-Type/);
  assert.match(hostSource, /BackgroundText/);
  assert.match(hostSource, /electronWindowForNativeId/);
  assert.match(hostSource, /webContents\.insertText/);
  assert.match(hostSource, /electron_insert_text/);
  assert.match(hostSource, /Brief pacing preserves literal order across async queues/);
  assert.match(hostSource, /coordinate drag requires x, y, to_x, and to_y/);
  assert.match(hostSource, /MouseHWheel/);
  assert.match(hostSource, /function Do-WindowState/);
  assert.match(hostSource, /function Do-CloseWindow/);
  assert.match(hostSource, /function listComputerApps/);
  assert.match(hostSource, /assertSafeComputerInput/);
  assert.match(hostSource, /blocked_input: destructive or session-ending key combination/);
  assert.match(hostSource, /blocked_input: dangerous shell payload in type text/);
  assert.match(hostSource, /BLOCKED_COMPUTER_LAUNCH_ALWAYS_PATTERNS/);
  assert.match(hostSource, /BLOCKED_COMPUTER_NON_HTTP_LAUNCH_PATTERNS/);
  assert.match(hostSource, /httpUrl = \/\^https\?:/);
  assert.match(hostSource, /wt\|wsl\|bash\|sh\|zsh\|fish\|nu/);
  assert.match(hostSource, /lnk\|url\|appref-ms/);
  assert.match(hostSource, /blocked_input: shell, script-host, or shortcut launch is unavailable in Computer Use/);
  assert.match(hostSource, /System\.Diagnostics\.ProcessStartInfo/);
  assert.match(hostSource, /UseShellExecute = \$true/);
  assert.match(hostSource, /target_not_found/);
  assert.match(hostSource, /no_file_association/);
  const launchStart = hostSource.indexOf('function Do-Launch');
  const launchEnd = hostSource.indexOf('function Release-SessionState', launchStart);
  assert.ok(launchStart >= 0 && launchEnd > launchStart);
  assert.doesNotMatch(hostSource.slice(launchStart, launchEnd), /Start-Process -FilePath/);
});

test('computer diagnostics expose real readiness probes without screen pixels', () => {
  assert.match(hostSource, /function Do-OcrStatus/);
  assert.match(hostSource, /AvailableRecognizerLanguages/);
  assert.match(hostSource, /async function diagnoseComputer/);
  assert.match(hostSource, /semantic_accessibility/);
  assert.match(hostSource, /input: 'target_integrity_dependent'/);
  assert.match(hostSource, /WindowIntegrity/);
  assert.match(hostSource, /TokenIntegrityLevel/);
  assert.match(hostSource, /action: 'window_integrity'/);
  assert.match(hostSource, /diagnostics does not expose screen pixels/);
});

test('computer bounded sequence is same-window, internal-only, and stops on transition', () => {
  assert.match(hostSource, /suppressedSequenceCaptures = new WeakSet/);
  assert.match(hostSource, /trustedSequenceContinuations = new WeakSet/);
  assert.match(hostSource, /async function runBoundedSequence/);
  assert.match(hostSource, /sequence requires 2\.\.6 steps/);
  assert.match(hostSource, /sequence continuation steps must be type, key, or wait/);
  assert.match(hostSource, /transition\?\.next_target && index < steps\.length - 1/);
  assert.match(hostSource, /stopped_reason/);
  assert.match(hostSource, /captureAfterAction\(command, finalWindowId, 0, 0\)/);
});

test('computer element marks are resolved only by actions that consume them', () => {
  const actionsStart = hostSource.indexOf('const ELEMENT_ALIAS_ACTIONS');
  const actionsEnd = hostSource.indexOf('const PIXEL_ALIAS_ACTIONS', actionsStart);
  const actionsSource = hostSource.slice(actionsStart, actionsEnd);
  assert.ok(actionsStart >= 0 && actionsEnd > actionsStart);
  assert.match(actionsSource, /'invoke'.*'set_value'.*'toggle'/s);
  assert.match(actionsSource, /'mouse_move'.*'drag'.*'type'.*'key'.*'scroll'/s);
  assert.doesNotMatch(actionsSource, /list_windows|list_apps|capture|screenshot|launch/);

  const resolverStart = hostSource.indexOf('function resolveElementAliases');
  const resolverEnd = hostSource.indexOf('async function requireValidFrame', resolverStart);
  const resolverSource = hostSource.slice(resolverStart, resolverEnd);
  assert.match(resolverSource, /ELEMENT_ALIAS_ACTIONS\.has\(command\.action\)/);
  assert.match(resolverSource, /command\.action === 'drag'/);
  const pixelActionsStart = hostSource.indexOf('const PIXEL_ALIAS_ACTIONS');
  const pixelActionsEnd = hostSource.indexOf('const OBSERVATION_BOUND_INPUT_ACTIONS', pixelActionsStart);
  assert.match(hostSource.slice(pixelActionsStart, pixelActionsEnd), /'type'/);
  assert.match(hostSource, /electron_point_focus_insert_text/);
  assert.match(hostSource, /BackgroundPointer[\s\S]*BackgroundText/);
});

test('computer input requires a fresh exact-target observation and auto-captures mutations', () => {
  assert.match(hostSource, /OBSERVATION_BOUND_INPUT_ACTIONS/);
  assert.match(hostSource, /framesBySession\.delete\(sessionIdFor\(command\)\)/);
  assert.match(hostSource, /requires a fresh capture\/snapshot\/find of the exact target window first/);
  assert.match(hostSource, /observedWindowBySession/);
  assert.match(hostSource, /AUTO_CAPTURE_ACTIONS/);
  assert.match(hostSource, /shouldCaptureAfter/);
  assert.match(hostSource, /mode: command\.capture_after_mode \|\| 'state'/);
  assert.match(hostSource, /capture_after_max_elements/);
  assert.match(hostSource, /capture_after_include_ocr/);
  assert.match(hostSource, /capture_after_max_ocr_words/);
  assert.match(hostSource, /escalation/);
});

test('computer fast paths keep exact-target and fallback safety boundaries', () => {
  assert.match(hostSource, /Dictionary<uint, string> apps/);
  assert.match(hostSource, /WindowInfo info = Info\(h, false\)/);
  assert.match(hostSource, /related_window_ids = @\(\[MixWin32\]::RelatedWindowIds/);
  assert.match(hostSource, /ownedWindow\.capturePage\(\)/);
  assert.match(hostSource, /OWNED_CAPTURE_TIMEOUT_MS/);
  assert.match(hostSource, /DESKTOP_CAPTURE_TIMEOUT_MS/);
  assert.match(hostSource, /desktopCapturer\.getSources/);
  assert.match(hostSource, /serializeOwnedCapture/);
  assert.match(hostSource, /Promise\.all\(\[/);
  assert.match(hostSource, /bounded: true/);
  assert.match(hostSource, /MSAA enrichment skipped: UIA supplied the bounded capture/);
  assert.match(hostSource, /confinedToMenuStrip/);
  assert.match(hostSource, /LAUNCH_SUCCESSOR_TIMEOUT_MS/);
  assert.match(hostSource, /includeAppMetadata/);
  assert.match(hostSource, /performance\.now\(\) - settleStartedAt >= minimumLaunchSettleMs/);
  assert.match(hostSource, /Reassert once after that queue drains/);
  assert.match(hostSource, /function Restore-InputRecoveryState/);
  assert.match(hostSource, /input_recovery: inputRecoveryVerification/);
  assert.match(hostSource, /reasserted/);
  assert.match(hostSource, /callPowerShellElevated/);
  assert.match(hostSource, /privileged worker requires delivery=foreground/);
  assert.match(hostSource, /MIXDOG_ELEVATED_TOKEN/);
  assert.match(hostSource, /MIXDOG_ELEVATED_HOST_SHA256/);
  assert.match(hostSource, /MIXDOG_ELEVATED_REQUEST_SHA256/);
  assert.match(hostSource, /\$variableNames = @\('MIXDOG_ELEVATED_TOKEN'/);
  assert.match(hostSource, /\[Environment\]::GetEnvironmentVariable\(\$_\)/);
  assert.match(hostSource, /\$elevatedScript = \$prelude/);
  assert.match(hostSource, /Set-AdminOnlyDirectory/);
  assert.match(hostSource, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(hostSource, /createHash\('sha256'\)/);
  assert.match(hostSource, /launcher_error:/);
  assert.match(hostSource, /exit 1223/);
  assert.match(hostSource, /stdio: \['ignore', 'pipe', 'pipe'\]/);
  assert.match(hostSource, /privileged_worker_launcher_failed: elevated worker exited with code/);
  assert.match(hostSource, /\.replace\(\/\^\\uFEFF\/, ''\)/);
  assert.match(hostSource, /privileged_worker_rejected: response authentication failed/);
  assert.match(hostSource, /target_integrity_unknown: foreground input was not sent/);
  assert.match(hostSource, /uac_elevated_/);
});

test('computer foreground surface guard admits only contained same-process child surfaces', () => {
  assert.match(hostSource, /IsContainedSameProcess/);
  assert.match(hostSource, /candidateBounds\.left >= surfaceBounds\.left/);
  assert.match(hostSource, /candidateBounds\.right <= surfaceBounds\.right/);
  assert.match(hostSource, /function Test-AllowedPointTarget/);
  assert.match(hostSource, /Revalidate only after that focus settles/);
  assert.match(hostSource, /frame point remains covered after exact target focus/);
  assert.match(hostSource, /frame point is covered by or belongs to a different window/);
});

test('computer frames remain session-bound and reject changed targets', () => {
  assert.match(hostSource, /framesBySession\.get\(sessionIdFor\(command\)\)/);
  assert.match(hostSource, /stale_frame: target window moved or resized/);
  assert.match(hostSource, /stale_frame: display layout changed/);
  assert.match(hostSource, /while \(frames\.size > 8\)/);
  const zoomStart = hostSource.indexOf('async function captureZoom');
  const zoomEnd = hostSource.indexOf('async function runCommand', zoomStart);
  const zoomSource = hostSource.slice(zoomStart, zoomEnd);
  assert.match(zoomSource, /types: \[frame\.kind\]/);
  assert.match(zoomSource, /candidate\.id === frame\.sourceId/);
  assert.match(zoomSource, /frame\.sourceId\.startsWith\('native-window:'\)/);
  assert.match(zoomSource, /captureVisibleNativeWindow/);
  assert.doesNotMatch(zoomSource, /sources\[0\]/);
});

test('computer refs, target claims, and execution lanes fail closed across agent sessions', () => {
  assert.match(hostSource, /RuntimeId = Get-ElRuntimeKey \$el/);
  assert.match(hostSource, /WindowId = \[string\]\$windowId/);
  assert.match(hostSource, /function Invalidate-RefsForRequest/);
  assert.match(hostSource, /const powerShellBySession = new Map/);
  assert.match(hostSource, /const commandChainsBySession = new Map/);
  assert.match(hostSource, /let foregroundChain:/);
  assert.match(hostSource, /const targetClaims = new Map/);
  assert.match(hostSource, /computer_target_in_use:.*reserved by another agent/);
  assert.match(hostSource, /claimComputerTargets\(command, \[logicalTargetWindowId, targetWindowId\]\)/);
  assert.match(hostSource, /action === 'session_release'/);
});

test('computer command timeout retires the stuck input host', () => {
  assert.match(hostSource, /computer command timed out; the input host was restarted/);
  assert.match(hostSource, /powerShellBySession\.delete\(sessionId\)/);
  assert.match(hostSource, /try \{ child\.kill\(\); \} catch/);
});

test('computer bridge is published only after resident backend warm-up', () => {
  const warmup = hostSource.indexOf("session_id: '__computer_host_warmup__'");
  const discovery = hostSource.indexOf('writeDiscovery(port, activeToken)', warmup);
  assert.ok(warmup >= 0 && discovery > warmup);
  assert.match(hostSource, /Publish only after the native backend is warm/);
  assert.match(hostSource, /removeDiscovery\(activeToken\)/);
  assert.match(hostSource, /closeAllConnections/);
});

test('computer post-action capture follows a deterministic successor and confirms semantic transitions', () => {
  assert.match(hostSource, /async function captureAfterAction/);
  assert.match(hostSource, /exact target window is unavailable; no screen fallback was captured/);
  assert.match(hostSource, /const capture = await captureComputer/);
  assert.match(hostSource, /payload\.frame_id = screenshot\.frameId/);
  assert.match(hostSource, /mode: command\.capture_after_mode \|\| 'state'/);
  assert.match(hostSource, /verification: 'not_performed'/);
  assert.match(hostSource, /computeComputerWindowTransition/);
  assert.match(hostSource, /window_transition: windowTransition/);
  assert.match(hostSource, /windowTransition\?\.next_target\?\.id \|\| originalWindowId/);
  assert.match(hostSource, /minimumLaunchSettleMs = Math\.max\(settleDelayMs, 500\)/);
  assert.match(hostSource, /recommended = 'switch_target'|return 'switch_target'/);
  assert.match(hostSource, /payload\.capture_after = \{/);
  assert.match(hostSource, /transitionConfirmsSemanticAction/);
  assert.match(hostSource, /launchTransitionConfirmsTarget/);
  assert.match(hostSource, /verification_source: 'window_transition'/);
});

test('computer owned child input keeps a capturable logical observation target', () => {
  assert.match(hostSource, /interface ObservedWindowScope/);
  assert.match(hostSource, /relatedWindowIds\.includes\(targetWindowId\)/);
  assert.match(hostSource, /rememberObservedWindowScope/);
  assert.match(hostSource, /capture_target_reason: 'capturable_owner'/);
  assert.match(hostSource, /input_surface_window_id: result\.window_id/);
  assert.match(hostSource, /bounded focus-settle interval/);
  assert.match(hostSource, /Thread\]::Sleep\(120\)/);
  assert.match(hostSource, /bounded input-settle interval/);
  assert.match(hostSource, /Thread\]::Sleep\(240\)/);
});

test('computer confirmed close reports target-closed capture completion', () => {
  assert.match(hostSource, /targetClosed = action === 'close_window'/);
  assert.match(hostSource, /target_reason: 'target_closed'/);
  assert.match(hostSource, /skipped: true/);
});

test('computer session abort bypasses serialization and restores input state', () => {
  assert.match(hostSource, /command\.action === 'session_abort'/);
  assert.match(hostSource, /await abortComputerSession\(command\)/);
  assert.match(hostSource, /activeExecution\.aborted = true/);
  assert.match(hostSource, /retirePowerShell\(child, new Error\('computer_session_aborted/);
  assert.match(hostSource, /MixdogAbortCleanup/);
  assert.match(hostSource, /sessionAbortEpochs/);
  assert.match(hostSource, /runForegroundExclusive\(\(\) => cleanupAbortedInput\(recovery\)\)/);
});

test('generated abort cleanup program compiles', {
  skip: process.platform !== 'win32',
  timeout: 30_000,
}, async () => {
  const startMarker = 'const ABORT_CLEANUP_PROGRAM = String.raw`';
  const endMarker = '`;\n\ninterface ComputerCommand';
  const start = hostSource.indexOf(startMarker);
  const end = hostSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start);
  let script = hostSource.slice(start + startMarker.length, end)
    .replace("$ErrorActionPreference = 'SilentlyContinue'", "$ErrorActionPreference = 'Stop'");
  const invokeStart = script.indexOf('[MixdogAbortCleanup]::Run(');
  assert.ok(invokeStart > 0);
  script = `${script.slice(0, invokeStart)}[Console]::Out.WriteLine('cleanup-compiled')\n`;
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-computer-cleanup-'));
  const path = join(directory, 'cleanup.ps1');
  try {
    await writeFile(path, script);
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path,
    ], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    assert.match(stdout, /cleanup-compiled/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generated Windows input host refuses unarmed keyboard and pointer input', {
  skip: process.platform !== 'win32',
  timeout: 75_000,
}, async () => {
  const startMarker = 'return String.raw`';
  const endMarker = "`.replace('${RESPONSE_MARKER}', RESPONSE_MARKER);";
  const start = hostSource.indexOf(startMarker);
  const end = hostSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start);
  let script = hostSource.slice(start + startMarker.length, end)
    .replace('${RESPONSE_MARKER}', '@@MIXCU@@');
  const probe = String.raw`
  Add-Type -ReferencedAssemblies @(
    'System.dll','System.Drawing.dll','System.Windows.Forms.dll',$AccessibilityAssemblyPath
  ) -TypeDefinition @'
using System;
using System.Drawing;
using System.Windows.Forms;
public sealed class MixdogMsaaValueFixture : Control {
  protected override AccessibleObject CreateAccessibilityInstance() {
    return new ValueAccessibleObject(this);
  }
  sealed class ValueAccessibleObject : ControlAccessibleObject {
    readonly MixdogMsaaValueFixture owner;
    public ValueAccessibleObject(MixdogMsaaValueFixture owner) : base(owner) {
      this.owner = owner;
    }
    public override string Name { get { return "msaa value fixture"; } }
    public override AccessibleRole Role { get { return AccessibleRole.Text; } }
    public override string Value {
      get { return owner.Text ?? ""; }
      set { owner.Text = value ?? ""; }
    }
    public override Rectangle Bounds {
      get { return owner.RectangleToScreen(owner.ClientRectangle); }
    }
  }
}
public sealed class MixdogMsaaActionFixture : Control {
  public int ActivationCount { get; private set; }
  protected override AccessibleObject CreateAccessibilityInstance() {
    return new ActionAccessibleObject(this);
  }
  sealed class ActionAccessibleObject : ControlAccessibleObject {
    readonly MixdogMsaaActionFixture owner;
    public ActionAccessibleObject(MixdogMsaaActionFixture owner) : base(owner) {
      this.owner = owner;
    }
    public override string Name { get { return "msaa action fixture"; } }
    public override AccessibleRole Role { get { return AccessibleRole.PushButton; } }
    public override string DefaultAction { get { return "Press"; } }
    public override void DoDefaultAction() { owner.ActivationCount++; }
    public override Rectangle Bounds {
      get { return owner.RectangleToScreen(owner.ClientRectangle); }
    }
  }
}
'@
  $script:CurrentSession = Get-SessionState 'safety-probe'
  $probeResults = New-Object System.Collections.ArrayList
  $firstState = Get-SessionState 'session-a'
  $secondState = Get-SessionState 'session-b'
  $firstState.Map['s1:e0'] = 'owned'
  [void]$probeResults.Add(@{
  name = 'session-isolation'
  ok = $firstState.Map.ContainsKey('s1:e0') -and -not $secondState.Map.ContainsKey('s1:e0')
  error = ''
  })
  $windows = @([MixWin32]::Windows())
  $stableWindow = $windows.Count -gt 0 -and
  [MixWin32]::ParseWindowId($windows[0].Id) -eq $windows[0].Handle
  [void]$probeResults.Add(@{ name = 'stable-window-id'; ok = $stableWindow; error = '' })
  $form = New-Object System.Windows.Forms.Form
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.Location = New-Object System.Drawing.Point(-30000, -30000)
  $form.Size = New-Object System.Drawing.Size(500, 300)
  $form.ShowInTaskbar = $false
  $windowTitle = 'mixdog-window-probe-' + $PID
  $form.Text = $windowTitle
  $button = New-Object System.Windows.Forms.Button
  $button.Location = New-Object System.Drawing.Point(10, 10)
  $button.Size = New-Object System.Drawing.Size(100, 30)
  $button.Text = 'native'
  $textBox = New-Object System.Windows.Forms.TextBox
  $textBox.Location = New-Object System.Drawing.Point(10, 60)
  $textBox.Size = New-Object System.Drawing.Size(200, 30)
  $textBox.AccessibleName = 'msaa edit'
  $checkBox = New-Object System.Windows.Forms.CheckBox
  $checkBox.Location = New-Object System.Drawing.Point(10, 105)
  $checkBox.Size = New-Object System.Drawing.Size(150, 30)
  $checkBox.Text = 'verify'
  $label = New-Object System.Windows.Forms.Label
  $label.Location = New-Object System.Drawing.Point(10, 150)
  $label.Size = New-Object System.Drawing.Size(200, 30)
  $label.Text = 'observation fixture'
  $label.AccessibleName = 'observation fixture'
  $msaaValue = New-Object MixdogMsaaValueFixture
  $msaaValue.Location = New-Object System.Drawing.Point(10, 190)
  $msaaValue.Size = New-Object System.Drawing.Size(200, 30)
  $msaaAction = New-Object MixdogMsaaActionFixture
  $msaaAction.Location = New-Object System.Drawing.Point(230, 190)
  $msaaAction.Size = New-Object System.Drawing.Size(200, 30)
  $script:nativeClickCount = 0
  $button.Add_Click({ $script:nativeClickCount++ })
  $form.Controls.Add($button)
  $form.Controls.Add($textBox)
  $form.Controls.Add($checkBox)
  $form.Controls.Add($label)
  $form.Controls.Add($msaaValue)
  $form.Controls.Add($msaaAction)
  $owned = New-Object System.Windows.Forms.Form
  $owned.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $owned.Location = New-Object System.Drawing.Point(-29500, -30000)
  $owned.Size = New-Object System.Drawing.Size(200, 100)
  $owned.ShowInTaskbar = $false
  $owned.Text = $windowTitle
  $form.AddOwnedForm($owned)
  [void]$form.Handle
  [void]$button.Handle
  [void]$textBox.Handle
  [void]$checkBox.Handle
  [void]$label.Handle
  [void]$msaaValue.Handle
  [void]$msaaAction.Handle
  [void]$owned.Handle
  [void][MixWin32]::ShowWindow($form.Handle, 4)
  [void][MixWin32]::ShowWindow($owned.Handle, 4)
  [System.Windows.Forms.Application]::DoEvents()
  $ambiguous = $false
  try {
    [void](Resolve-WindowInfo $windowTitle $null)
  } catch {
    $ambiguous = "$($_.Exception.Message)" -match 'window title is ambiguous'
  }
  $ownedInfo = [MixWin32]::Info($owned.Handle)
  $windowIdentityOk = $ambiguous -and
    $ownedInfo.OwnerId -eq [MixWin32]::WindowId($form.Handle)
  [void]$probeResults.Add(@{ name = 'duplicate-title-owned-window'; ok = $windowIdentityOk; error = '' })
  $interactiveObservation = Snapshot-Window ([pscustomobject]@{
    window_id = [MixWin32]::WindowId($form.Handle)
    window = $null
    query = 'observation fixture'
    role = ''
    visible_only = $false
    include_noninteractive = $false
    max_elements = 20
    continuation = $null
  })
  $broadObservation = Snapshot-Window ([pscustomobject]@{
    window_id = [MixWin32]::WindowId($form.Handle)
    window = $null
    query = 'observation fixture'
    role = ''
    visible_only = $false
    include_noninteractive = $true
    max_elements = 20
    continuation = $null
  })
  $observationOk = $interactiveObservation.total_elements -eq 0 -and
    $broadObservation.total_elements -ge 1 -and
    $broadObservation.text -match 'view=all' -and
    $broadObservation.text -match '"observation fixture"' -and
    @($broadObservation.elements).Count -ge 1 -and
    [int](@($broadObservation.elements)[0].mark) -eq 1 -and
    [string](@($broadObservation.elements)[0].ref) -match '^s\d+:e\d+' -and
    @($broadObservation.elements)[0].bounds -eq $null -and
    [int](@($broadObservation.elements)[0].width) -gt 0
  [void]$probeResults.Add(@{ name = 'noninteractive-observation'; ok = $observationOk; error = $broadObservation.text })
  $msaaNodes = @([MixMsaa]::Snapshot(
    $form.Handle, [MixWin32]::WindowId($form.Handle), 100))
  $msaaButton = @($msaaNodes | Where-Object {
    $_.Name -eq 'native' -and $_.DefaultAction
  }) | Select-Object -First 1
  $msaaEdit = @($msaaNodes | Where-Object {
    $_.Name -eq 'msaa value fixture' -and $_.ControlType -eq 'Edit'
  }) | Select-Object -First 1
  $msaaActionOk = $null -ne $msaaButton -and $null -ne $msaaEdit
  $msaaClickCount = -1
  $msaaReadback = ''
  $msaaText = ''
  if ($msaaActionOk) {
    $msaaButton.DoDefaultAction()
    [System.Windows.Forms.Application]::DoEvents()
    $msaaClickCount = $script:nativeClickCount
    $msaaActionOk = $msaaClickCount -eq 1
    $script:nativeClickCount = 0
    $msaaReadback = $msaaEdit.SetValue('MSAA')
    [System.Windows.Forms.Application]::DoEvents()
    $msaaText = $msaaValue.Text
    $msaaActionOk = $msaaActionOk -and $msaaText -eq 'MSAA' -and $msaaReadback -eq 'MSAA'
    $msaaValue.Text = ''
  }
  [void]$probeResults.Add(@{
    name = 'direct-msaa-enumerate-invoke-value'
    ok = $msaaActionOk
    error = ('nodes={0}; button={1}; edit={2}; clicks={3}; text={4}; readback={5}; tree={6}' -f
      $msaaNodes.Count, ($null -ne $msaaButton), ($null -ne $msaaEdit),
      $msaaClickCount, $msaaText, $msaaReadback,
      (@($msaaNodes | ForEach-Object {
        '{0}|{1}|{2}|{3}' -f $_.Name, $_.ControlType, $_.Role, $_.DefaultAction
      }) -join '; '))
  })
  $msaaActionSnapshot = Snapshot-Window ([pscustomobject]@{
    window_id = [MixWin32]::WindowId($form.Handle)
    window = $null
    query = 'msaa action fixture'
    role = ''
    visible_only = $false
    include_noninteractive = $false
    max_elements = 20
    continuation = $null
  })
  $msaaActionMatch = [regex]::Match(
    $msaaActionSnapshot.text,
    '\[(?<ref>s\d+:e\d+)\] Button "msaa action fixture"[^\r\n]*source=msaa')
  $msaaInvokeResult = if ($msaaActionMatch.Success) {
    Do-Invoke $msaaActionMatch.Groups['ref'].Value
  } else { $null }
  $msaaValueSnapshot = Snapshot-Window ([pscustomobject]@{
    window_id = [MixWin32]::WindowId($form.Handle)
    window = $null
    query = 'msaa value fixture'
    role = ''
    visible_only = $false
    include_noninteractive = $false
    max_elements = 20
    continuation = $null
  })
  $msaaValueMatch = [regex]::Match(
    $msaaValueSnapshot.text,
    '\[(?<ref>s\d+:e\d+)\] Edit "msaa value fixture"[^\r\n]*source=msaa')
  $msaaSetResult = if ($msaaValueMatch.Success) {
    Do-SetValue $msaaValueMatch.Groups['ref'].Value 'ref-value'
  } else { $null }
  $msaaRefActionsOk = $msaaActionMatch.Success -and $msaaValueMatch.Success -and
    $msaaAction.ActivationCount -eq 1 -and
    $msaaInvokeResult.path -eq 'msaa_default_action' -and
    $msaaSetResult.path -eq 'msaa_value' -and $msaaSetResult.verified -eq $true -and
    $msaaValue.Text -eq 'ref-value'
  [void]$probeResults.Add(@{
    name = 'msaa-generation-ref-actions'
    ok = $msaaRefActionsOk
    error = ('action={0}; value={1}; activation={2}; text={3}; invokePath={4}; setPath={5}; verified={6}' -f
      $msaaActionMatch.Success, $msaaValueMatch.Success, $msaaAction.ActivationCount,
      $msaaValue.Text, $msaaInvokeResult.path, $msaaSetResult.path, $msaaSetResult.verified)
  })
  $msaaValue.Text = ''
  $buttonPoint = $button.PointToScreen((New-Object System.Drawing.Point(10, 10)))
  $nativePointerTarget = [MixWin32]::BackgroundPointer(
    $form.Handle, $buttonPoint.X, $buttonPoint.Y, 'click', '')
  [System.Windows.Forms.Application]::DoEvents()
  $nativePointerOk = $script:nativeClickCount -eq 1 -and
    $nativePointerTarget -eq [MixWin32]::WindowId($button.Handle)
  [void]$probeResults.Add(@{ name = 'background-native-pointer'; ok = $nativePointerOk; error = '' })
  $textPoint = $textBox.PointToScreen((New-Object System.Drawing.Point(20, 10)))
  $textEnd = $textBox.PointToScreen((New-Object System.Drawing.Point(120, 10)))
  $moveTarget = [MixWin32]::BackgroundPointer(
    $form.Handle, $textPoint.X, $textPoint.Y, 'move', '')
  $dragTarget = [MixWin32]::BackgroundDrag(
    $form.Handle, $textPoint.X, $textPoint.Y, $textEnd.X, $textEnd.Y, '')
  $wheelTarget = [MixWin32]::BackgroundWheel(
    $form.Handle, $textPoint.X, $textPoint.Y, -3, '')
  $textWindowId = [MixWin32]::WindowId($textBox.Handle)
  $pointerFamilyOk = $moveTarget -eq $textWindowId -and
    $dragTarget -eq $textWindowId -and $wheelTarget -eq $textWindowId
  [void]$probeResults.Add(@{ name = 'background-native-pointer-family'; ok = $pointerFamilyOk; error = '' })
  $checkRef = 'probe:checkbox'
  $probeState = Get-CurrentSession
  $probeState.Map.Clear()
  Set-ElRef $probeState $checkRef ($AE::FromHandle($checkBox.Handle)) ([MixWin32]::WindowId($form.Handle)) $probeState.Generation
  $verifiedClick = Do-ClickFamily ([pscustomobject]@{
    action = 'click'
    ref = $checkRef
    delivery = 'background'
    window_id = [MixWin32]::WindowId($form.Handle)
    window = $null
    modifiers = ''
  }) 'click'
  [System.Windows.Forms.Application]::DoEvents()
  $verifiedClickOk = $verifiedClick.verified -eq $false -and
    $verifiedClick.effect -eq 'unverifiable' -and $verifiedClick.path -eq 'win32_message'
  $verifiedClickError = 'checked={0}; verified={1}; effect={2}; message={3}' -f
    $checkBox.Checked, $verifiedClick.verified, $verifiedClick.effect, $verifiedClick.text
  [void]$probeResults.Add(@{ name = 'background-native-click-honest-unverifiable'; ok = $verifiedClickOk; error = $verifiedClickError })
  $checkBox.Checked = $false
  [System.Windows.Forms.Application]::DoEvents()
  $semanticSnapshot = Snapshot-Window ([pscustomobject]@{
    window_id = [MixWin32]::WindowId($form.Handle)
    window = $null
    query = 'verify'
    role = ''
    visible_only = $false
    include_noninteractive = $false
    max_elements = 20
    continuation = $null
  })
  $semanticMatch = [regex]::Match(
    $semanticSnapshot.text,
    '\[(?<ref>s\d+:e\d+)\] (?:CheckBox|Button) "verify"')
  $semanticClick = if ($semanticMatch.Success) {
    Do-Invoke $semanticMatch.Groups['ref'].Value
  } else { $null }
  [System.Windows.Forms.Application]::DoEvents()
  $semanticClickOk = $semanticMatch.Success -and $checkBox.Checked -and
    $semanticClick.action -eq 'invoke' -and
    @('uia_toggle','msaa_default_action') -contains $semanticClick.path -and
    (($semanticClick.verified -eq $true -and $semanticClick.effect -eq 'confirmed') -or
      ($semanticClick.verified -eq $false -and $semanticClick.effect -eq 'unverifiable'))
  $semanticClickError = 'match={0}; checked={1}; verified={2}; effect={3}; path={4}; message={5}; tree={6}' -f
    $semanticMatch.Success, $checkBox.Checked, $semanticClick.verified, $semanticClick.effect,
    $semanticClick.path, $semanticClick.text,
    $semanticSnapshot.text
  [void]$probeResults.Add(@{ name = 'semantic-ref-click-invokes-toggle'; ok = $semanticClickOk; error = $semanticClickError })
  $editRef = 'probe:edit'
  $probeState.Map.Clear()
  Set-ElRef $probeState $editRef ($AE::FromHandle($textBox.Handle)) ([MixWin32]::WindowId($form.Handle)) $probeState.Generation
  $verifiedKey = Do-Key ([pscustomobject]@{
    action = 'key'
    ref = $editRef
    keys = 'Hello'
    delivery = 'background'
    window_id = [MixWin32]::WindowId($form.Handle)
    window = $null
  })
  [System.Windows.Forms.Application]::DoEvents()
  $nativeKeyOk = $textBox.Text -eq 'Hello' -and $verifiedKey.verified -eq $false -and
    $verifiedKey.goal_verified -eq $false -and $verifiedKey.state_changed -eq $true -and
    $verifiedKey.effect -eq 'unverifiable'
  $nativeKeyError = 'text={0}; verified={1}; goal={2}; changed={3}; effect={4}; message={5}' -f
    $textBox.Text, $verifiedKey.verified, $verifiedKey.goal_verified,
    $verifiedKey.state_changed, $verifiedKey.effect, $verifiedKey.text
  [void]$probeResults.Add(@{ name = 'background-native-key-honest-unverifiable'; ok = $nativeKeyOk; error = $nativeKeyError })
  $textBox.Text = ''
  $literalText = 'literal {text} ^%+ 한글'
  $typed = Do-Type ([pscustomobject]@{
    action = 'type'
    ref = $editRef
    text = $literalText
    delivery = 'background'
    window_id = [MixWin32]::WindowId($form.Handle)
    window = $null
  })
  [System.Windows.Forms.Application]::DoEvents()
  $literalTypeOk = $textBox.Text -eq $literalText -and
    $typed.action -eq 'type' -and $typed.path -eq 'win32_message'
  [void]$probeResults.Add(@{
    name = 'background-literal-type'
    ok = $literalTypeOk
    error = ('text={0}; expected={1}; action={2}; path={3}' -f
      $textBox.Text, $literalText, $typed.action, $typed.path)
  })
  $coordinateDrag = Do-Drag ([pscustomobject]@{
    action = 'drag'
    ref = $null
    to = $null
    x = $textPoint.X
    y = $textPoint.Y
    to_x = $textEnd.X
    to_y = $textEnd.Y
    delivery = 'background'
    window_id = [MixWin32]::WindowId($form.Handle)
    window = $null
    modifiers = ''
  })
  $coordinateDragOk = $coordinateDrag.action -eq 'drag' -and
    $coordinateDrag.path -eq 'win32_message' -and -not $coordinateDrag.code
  [void]$probeResults.Add(@{
    name = 'background-coordinate-drag'
    ok = $coordinateDragOk
    error = ('action={0}; path={1}; code={2}; text={3}' -f
      $coordinateDrag.action, $coordinateDrag.path, $coordinateDrag.code, $coordinateDrag.text)
  })
  Invalidate-RefsForRequest ([pscustomobject]@{ action = 'key' })
  $staleRefRejected = $false
  try { [void](Get-El $editRef) } catch { $staleRefRejected = "$($_.Exception.Message)" -match 'stale' }
  [void]$probeResults.Add(@{ name = 'mutation-invalidates-refs'; ok = $staleRefRejected; error = '' })
  $pageOne = Get-ElementPage 205 0 200
  $pageTwo = Get-ElementPage 205 ([int]$pageOne.Continuation) 200
  $paginationOk = $pageOne.End -eq 200 -and $pageOne.Continuation -eq '200' -and
    $pageTwo.End -eq 205 -and $null -eq $pageTwo.Continuation
  $paginationError = 'pageOne={0}/{1}; pageTwo={2}/{3}' -f
    $pageOne.End, $pageOne.Continuation, $pageTwo.End, $pageTwo.Continuation
  [void]$probeResults.Add(@{ name = 'ax-pagination-over-200'; ok = $paginationOk; error = $paginationError })
  $recovery = Get-InputRecoveryState ([pscustomobject]@{
    window_id = [MixWin32]::WindowId($form.Handle)
    window = $null
    ref = $null
  })
  $recoveryOk = $recovery.target_window_id -eq [MixWin32]::WindowId($form.Handle) -and
    $recovery.cursor_x -is [int] -and $recovery.cursor_y -is [int]
  [void]$probeResults.Add(@{ name = 'foreground-recovery-state'; ok = $recoveryOk; error = '' })
  $minimized = Do-WindowState ([pscustomobject]@{
    window_id = [MixWin32]::WindowId($form.Handle)
    window = $null
    state = 'minimize'
  })
  $restored = Do-WindowState ([pscustomobject]@{
    window_id = [MixWin32]::WindowId($form.Handle)
    window = $null
    state = 'restore'
  })
  $windowStateOk = $minimized.verified -eq $true -and $restored.verified -eq $true
  [void]$probeResults.Add(@{
    name = 'window-state-minimize-restore'
    ok = $windowStateOk
    error = ('minimized={0}; restored={1}' -f $minimized.verified, $restored.verified)
  })
  $ocrBitmap = New-Object System.Drawing.Bitmap(64, 64)
  $ocrGraphics = [System.Drawing.Graphics]::FromImage($ocrBitmap)
  $ocrGraphics.Clear([System.Drawing.Color]::White)
  $ocrStream = New-Object System.IO.MemoryStream
  $ocrBitmap.Save($ocrStream, [System.Drawing.Imaging.ImageFormat]::Png)
  $ocrEncoded = [Convert]::ToBase64String($ocrStream.ToArray())
  $ocrStream.Dispose()
  $ocrGraphics.Dispose()
  $ocrBitmap.Dispose()
  $ocrResult = Do-OcrImage ([pscustomobject]@{
    image_base64 = $ocrEncoded
    ocr_language = $null
    max_ocr_words = 10
  })
  $ocrOk = -not [string]::IsNullOrWhiteSpace([string]$ocrResult.language) -and
    [int]$ocrResult.total_words -ge 0
  [void]$probeResults.Add(@{
    name = 'windows-ocr-image'
    ok = $ocrOk
    error = ('language={0}; words={1}' -f $ocrResult.language, $ocrResult.total_words)
  })
  $owned.Close()
  $owned.Dispose()
  $form.Close()
  $form.Dispose()
  $missingLaunchTarget = Join-Path $env:TEMP ('mixdog-computer-missing-' + [Guid]::NewGuid().ToString('N') + '.pptx')
  try {
    [void](Do-Launch $missingLaunchTarget)
    [void]$probeResults.Add(@{ name = 'launch-missing-target'; ok = $false; error = 'missing target unexpectedly launched' })
  } catch {
    $missingLaunchError = "$($_.Exception.Message)"
    [void]$probeResults.Add(@{
      name = 'launch-missing-target'
      ok = $missingLaunchError -match 'launch failed \[target_not_found/(2|3)\]'
      error = $missingLaunchError
    })
  }
  try {
  Assert-TypingTarget
  [void]$probeResults.Add(@{ name = 'key'; ok = $true; error = '' })
} catch {
  [void]$probeResults.Add(@{ name = 'key'; ok = $false; error = "$($_.Exception.Message)" })
}
try {
  Assert-InputTarget ([IntPtr]::Zero) 'click'
  [void]$probeResults.Add(@{ name = 'click'; ok = $true; error = '' })
} catch {
  [void]$probeResults.Add(@{ name = 'click'; ok = $false; error = "$($_.Exception.Message)" })
}
$probeJson = @{ results = $probeResults } | ConvertTo-Json -Compress -Depth 5
[Console]::Out.WriteLine('@@MIXCU@@' + $probeJson)
exit
`;
  script = script.replace('while ($true) {', `${probe}\nwhile ($true) {`);
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-computer-safety-'));
  const path = join(directory, 'probe.ps1');
  try {
    await writeFile(path, script);
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path,
    ], { encoding: 'utf8', timeout: 70_000, windowsHide: true });
    const line = stdout.split(/\r?\n/).find((value) => value.startsWith('@@MIXCU@@'));
    assert.ok(line);
    const payload = JSON.parse(line.slice('@@MIXCU@@'.length));
    assert.deepEqual(
      payload.results.map((entry) => entry.ok),
      [
        true, true, true, true, true, true, true, true, true, true,
        true, true, true, true, true, true, true, true, true, false,
        false,
      ],
      JSON.stringify(payload.results, null, 2),
    );
    assert.match(payload.results[19].error, /key requires focus_window first/);
    assert.match(payload.results[20].error, /click requires focus_window first/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
