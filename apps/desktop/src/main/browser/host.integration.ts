import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow, nativeImage, webContents, type WebContents } from 'electron';
import { BROWSER_ACTIONS } from '../../../../../src/runtime/browser-bridge/browser-action-contract.mjs';
import { createBrowserHost, type BrowserHost } from './host';
import { readyBrowserFrame } from './harness-frame';
import type { BrowserCommandTiming } from './timing';
import { runBrowserLatencyScenarios } from './latency-scenarios';
import { runBrowserActionabilityScenarios } from './actionability.integration';
import { measureScreenshotReuse } from './screenshot-image.integration';
import { runBrowserTaskLifecycleScenarios } from './task-lifecycle.integration';
import { runBrowserPageReportScenarios } from './page-report.integration';
import {
  createBrowserFrameFixture,
  createBrowserPageFixture,
  createBrowserSocketFixture,
} from './host-integration-fixtures';
import { probeMouseFocus } from './mouse-focus-probe';
import { probeMouseDispatch } from './mouse-dispatch-probe';
import { createPolling } from '../host-harness-poll';
import {
  DESKTOP_IPC,
  type DesktopBrowserGuestViewportChange,
  type DesktopBrowserOpenRequest,
} from '../../shared/contract';

interface CommandResponse {
  ok: boolean;
  value?: {
    text?: string;
    image?: { mimeType?: string; data?: string };
    file?: { mimeType?: string; data?: string; name?: string };
    timing?: BrowserCommandTiming;
  };
  error?: string;
  timing?: BrowserCommandTiming;
}

const progressPath = process.env.MIXDOG_BROWSER_INTEGRATION_LOG || '';
function progress(message: string): void {
  if (progressPath) appendFileSync(progressPath, `${message}\n`);
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

const profile = mkdtempSync(join(tmpdir(), 'mixdog-browser-host-profile-'));
const dataDirectory = join(profile, 'data');
const downloadsDirectory = join(profile, 'downloads');
const uploadFixturePath = join(profile, 'browser-upload-fixture.txt');
mkdirSync(downloadsDirectory, { recursive: true });
writeFileSync(uploadFixturePath, 'Browser upload fixture');
process.env.MIXDOG_DATA_DIR = dataDirectory;
app.setPath('userData', join(profile, 'user-data'));
app.setPath('downloads', downloadsDirectory);
app.disableHardwareAcceleration();
progress('module loaded; profile configured');

function refNamed(snapshot: string, name: string): string {
  const line = snapshot
    .split('\n')
    .find((entry) => entry.includes(JSON.stringify(name)) && /\[p\d+-s\d+-e\d+\]/.test(entry));
  const ref = line?.match(/\[(p\d+-s\d+-e\d+)\]/)?.[1];
  assert.ok(ref, `snapshot did not contain ${JSON.stringify(name)}:\n${snapshot}`);
  return ref;
}

function visualGrounding(snapshot: string): {
  snapshotId: string;
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
} {
  const match = snapshot.match(/Visual screenshot: (p\d+-s\d+) is (\d+)x(\d+) image px; viewport (\d+)x(\d+) CSS px/);
  assert.ok(match, `visual snapshot result did not contain grounding metadata:\n${snapshot}`);
  return {
    snapshotId: match[1],
    imageWidth: Number(match[2]),
    imageHeight: Number(match[3]),
    viewportWidth: Number(match[4]),
    viewportHeight: Number(match[5]),
  };
}

function networkRequestId(network: string, urlPart: string): string {
  const line = network.split('\n').find((entry) => entry.includes(urlPart));
  const requestId = line?.match(/\[(r\d+)\]/)?.[1];
  assert.ok(requestId, `network list did not contain ${JSON.stringify(urlPart)}:\n${network}`);
  return requestId;
}

function contentsWithUrl(urlPart: string): WebContents {
  const found = webContents.getAllWebContents().find((entry) => entry.getURL().includes(urlPart));
  assert.ok(found, `no Electron WebContents matched ${JSON.stringify(urlPart)}`);
  return found;
}

function imagePixel(data: string, xRatio: number, yRatio: number): [number, number, number] {
  const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
  const { width, height } = image.getSize();
  const x = Math.min(width - 1, Math.max(0, Math.round((width - 1) * xRatio)));
  const y = Math.min(height - 1, Math.max(0, Math.round((height - 1) * yRatio)));
  const bitmap = image.toBitmap();
  const offset = (y * width + x) * 4;
  return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]];
}

const { eventually, readDiscovery } = createPolling({ timeoutMs: 5_000, intervalMs: 50 });

async function run(): Promise<void> {
  const socketFixture = createBrowserSocketFixture();
  let frameOrigin = '';
  const frameFixture = createBrowserFrameFixture();
  // The page fixture reads frameOrigin per request: the cross-origin server
  // only has a port once it is listening, below.
  const { server: fixture, stalledResponses } = createBrowserPageFixture(() => frameOrigin);

  let parent: BrowserWindow | null = null;
  let host: BrowserHost | null = null;
  try {
    progress('starting fixture server');
    await new Promise<void>((resolve, reject) => {
      socketFixture.once('error', reject);
      socketFixture.listen(0, '127.0.0.1', () => resolve());
    });
    const socketAddress = socketFixture.address();
    assert.ok(socketAddress && typeof socketAddress === 'object');
    const socketUrl = `ws://127.0.0.1:${socketAddress.port}/socket`;
    await new Promise<void>((resolve, reject) => {
      frameFixture.once('error', reject);
      frameFixture.listen(0, '0.0.0.0', () => resolve());
    });
    const frameAddress = frameFixture.address();
    assert.ok(frameAddress && typeof frameAddress === 'object');
    frameOrigin = `http://127.0.0.2:${frameAddress.port}`;
    await new Promise<void>((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(0, '127.0.0.1', () => resolve());
    });
    const address = fixture.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;

    progress('creating browser host');
    parent = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
      },
    });
    host = createBrowserHost(parent, { requestApproval: async () => true });
    const browserSurfaceRequests: DesktopBrowserOpenRequest[] = [];
    const viewportChanges: DesktopBrowserGuestViewportChange[] = [];
    const parentWebContents = parent.webContents;
    const sendToRenderer = parentWebContents.send.bind(parentWebContents);
    parentWebContents.send = ((channel: string, ...args: unknown[]) => {
      if (channel === DESKTOP_IPC.browserOpenRequested) {
        browserSurfaceRequests.push(args[0] as DesktopBrowserOpenRequest);
      }
      if (channel === DESKTOP_IPC.browserGuestViewportChanged) {
        viewportChanges.push(args[0] as DesktopBrowserGuestViewportChange);
      }
      sendToRenderer(channel, ...args);
    }) as typeof parentWebContents.send;
    await parent.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`
      <!doctype html>
      <textarea id="composer">Independent shell input</textarea>
    `)}`
    );
    // The first compositor paint can still have the pre-resize geometry.
    // Re-sample this read-only readiness condition, just as the pane does.
    const primaryFrame = await readyBrowserFrame(host!, 'browser-integration-session');
    assert.ok(primaryFrame);
    const visibleGuest = webContents.fromId(primaryFrame.webContentsId)!;
    await visibleGuest.loadURL(`${origin}/root`);
    host.setGuestActive('browser-integration-session', visibleGuest.id, true);
    host.setBridgeEnabled(true);
    const discovery = await readDiscovery(join(dataDirectory, 'browser-bridge.json'));
    progress('browser bridge discovered');
    let turnId = 1;
    const commandDurations = new Map<string, number[]>();
    const commandDurationDetails = new Map<string, Array<{ label: string; duration: number }>>();
    const completedActions = new Set<string>();

    const command = async (
      input: Record<string, unknown>,
      signal?: AbortSignal
    ): Promise<{
      text: string;
      image?: { mimeType?: string; data?: string };
      file?: { mimeType?: string; data?: string; name?: string };
      timing?: BrowserCommandTiming;
    }> => {
      const action = String(input.action || 'unknown');
      const startedAt = performance.now();
      try {
        const response = await fetch(`http://127.0.0.1:${discovery.port}/command`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${discovery.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            session_id: 'browser-integration-session',
            turn_id: turnId,
            ...input,
          }),
          signal,
        });
        const payload = (await response.json()) as CommandResponse;
        if (!payload.ok)
          throw Object.assign(new Error(payload.error || 'browser command failed'), { timing: payload.timing });
        completedActions.add(action);
        return {
          text: String(payload.value?.text || ''),
          ...(payload.value?.image ? { image: payload.value.image } : {}),
          ...(payload.value?.file ? { file: payload.value.file } : {}),
          ...(payload.value?.timing ? { timing: payload.value.timing } : {}),
        };
      } finally {
        const duration = performance.now() - startedAt;
        const samples = commandDurations.get(action) || [];
        samples.push(duration);
        commandDurations.set(action, samples);
        const details = commandDurationDetails.get(action) || [];
        details.push({
          label: [
            String(input.tab || 'visible'),
            input.expect ? 'expect' : '',
            input.includeScreenshot ? 'screenshot' : '',
          ]
            .filter(Boolean)
            .join('+'),
          duration,
        });
        commandDurationDetails.set(action, details);
      }
    };

    await runBrowserTaskLifecycleScenarios({ command, origin, browserSurfaceRequests, visibleGuest, progress });

    if (process.env.MIXDOG_BROWSER_CONTINUATION_ONLY === '1') {
      for (let index = 0; index < 101; index += 1) {
        const observed = await command({ action: 'read' });
        assert.match(observed.text, /Root fixture/);
      }
      progress('browser continues beyond 100 actions in the same turn');
      progress('integration passed');
      return;
    }

    const initialDialogStartedAt = Date.now();
    const initialDialog = await command({
      action: 'navigate',
      url: `${origin}/initial-dialog`,
      background: true,
      tab: 'initial-dialog',
    });
    assert.match(initialDialog.text, /dialog is blocking the page/i);
    assert.ok(Date.now() - initialDialogStartedAt < 6_000);
    await command({ action: 'handle_dialog', accept: false, tab: 'initial-dialog' });
    progress('initial navigation dialog interception complete');

    let alpha = await command({
      action: 'navigate',
      url: `${origin}/root`,
      background: true,
      tab: 'alpha',
      maxChars: 6_000,
    });
    assert.match(alpha.text, /Extended snapshot tail/);
    assert.match(alpha.text, /fresh; use these refs directly, do not call snapshot again/);
    assert.deepEqual(browserSurfaceRequests, []);
    const alphaGuest = contentsWithUrl('/root');
    alphaGuest.setZoomFactor(0.75);
    assert.ok(Math.abs(alphaGuest.getZoomFactor() - 0.75) < 0.01);
    alpha = await command({ action: 'snapshot', tab: 'alpha' });
    assert.doesNotMatch(alpha.text, /Extended snapshot tail/);
    progress('root navigation complete');
    await command({ action: 'open' });
    await command({ action: 'open' });
    assert.deepEqual(browserSurfaceRequests.splice(0), [
      { sessionId: 'browser-integration-session', reveal: true },
      { sessionId: 'browser-integration-session', reveal: true },
    ]);
    progress('existing foreground guest reveal complete');
    await visibleGuest.executeJavaScript(`
      const draft = document.createElement('textarea');
      draft.id = 'completion-draft';
      draft.value = 'unsaved user draft';
      document.body.append(draft);
    `);
    const foregroundUrlBeforeHide = visibleGuest.getURL();
    await command({ action: 'hide' });
    assert.deepEqual(browserSurfaceRequests.splice(0), [{ sessionId: 'browser-integration-session', hide: true }]);
    assert.equal(visibleGuest.getURL(), foregroundUrlBeforeHide);
    assert.equal(
      await visibleGuest.executeJavaScript(`document.getElementById('completion-draft').value`),
      'unsaved user draft'
    );
    assert.equal(alphaGuest.isDestroyed(), false);
    progress('panel hide preserves foreground drafts and support pages');
    if (process.env.MIXDOG_BROWSER_MOUSE_PROBE_ONLY === '1') {
      await probeMouseDispatch(alphaGuest, progress);
      progress('mouse dispatch probe passed');
      return;
    }
    if (process.env.MIXDOG_BROWSER_MOUSE_FOCUS_PROBE === '1') await probeMouseFocus(alphaGuest, progress);
    assert.doesNotMatch(alpha.text, /do-not-leak-password/);
    const spaRef = refNamed(alpha.text, 'Update SPA');
    alpha = await command({
      action: 'click',
      ref: spaRef,
      expect: { text: 'SPA done 1', timeoutMs: 2_000 },
      tab: 'alpha',
    });
    assert.match(alpha.text, /Postcondition met/);
    assert.match(alpha.text, /SPA done 1/);
    const secondSpaRef = refNamed(alpha.text, 'Update SPA');
    await assert.rejects(
      command({
        action: 'click',
        ref: secondSpaRef,
        expect: { text: 'condition that never appears', timeoutMs: 600 },
        tab: 'alpha',
      }),
      /Postcondition failed[\s\S]*executed once and was not retried[\s\S]*SPA done 2/
    );
    alpha = await command({ action: 'snapshot', settleMs: 150, tab: 'alpha' });
    assert.match(alpha.text, /Explicit settle completed/);
    assert.match(alpha.text, /SPA done 2/);
    assert.doesNotMatch(alpha.text, /SPA done 3/);
    const weakExpectationRef = refNamed(alpha.text, 'Update SPA');
    const weakExpectation = await command({
      action: 'click',
      ref: weakExpectationRef,
      expect: { text: 'Update SPA', timeoutMs: 2_000 },
      includeScreenshot: true,
      tab: 'alpha',
    });
    assert.match(weakExpectation.text, /Postcondition was already true before this action/);
    assert.doesNotMatch(weakExpectation.text, /Postcondition met/);
    assert.match(weakExpectation.text, /SPA done 3/);
    assert.equal(weakExpectation.image?.mimeType, 'image/jpeg');
    progress('SPA postcondition and no-replay failure complete');
    const pageConsole = await command({ action: 'console', tab: 'alpha' });
    assert.doesNotMatch(pageConsole.text, /ACTION_SETTLE_QUIET_MS|ReferenceError/);
    turnId = 25;
    await assert.rejects(
      command({
        action: 'wait',
        text: 'condition that never appears',
        timeoutMs: 500,
        tab: 'alpha',
      }),
      /Wait timed out[\s\S]*Root fixture/
    );

    const observed = await command({ action: 'snapshot', mode: 'both', tab: 'alpha' });
    assert.match(observed.text, /Snapshot: p\d+-s\d+/);
    assert.equal(observed.image?.mimeType, 'image/jpeg');
    assert.ok((observed.image?.data?.length || 0) > 100);
    alpha = { text: observed.text };
    progress('combined visual snapshot complete');

    const croppedRef = refNamed(alpha.text, 'Update SPA');
    const cropped = await command({ action: 'snapshot', mode: 'visual', ref: croppedRef, tab: 'alpha' });
    assert.match(cropped.text, new RegExp(`Screenshot of ${croppedRef} on .*\\(\\d+x\\d+ px\\)`));
    assert.equal(cropped.image?.mimeType, 'image/jpeg');
    assert.ok((cropped.image?.data?.length || 0) > 100);
    assert.ok(
      (cropped.image?.data?.length || 0) < (observed.image?.data?.length || 0),
      'an element crop carries fewer bytes than the whole viewport'
    );
    await assert.rejects(
      command({ action: 'snapshot', mode: 'visual', ref: croppedRef, fullPage: true, tab: 'alpha' }),
      /cannot be combined with fullPage/
    );

    // A section taller than the window still yields a usable image on a
    // background page, where Chromium paints only the window surface.
    await command({ action: 'navigate', url: `${origin}/tall`, background: true, tab: 'crop-check' });
    const tallBackground = await command({
      action: 'snapshot',
      mode: 'visual',
      target: { selector: '#tall-report' },
      tab: 'crop-check',
    });
    const backgroundSize = /\((\d+)x(\d+) px\)/.exec(tallBackground.text);
    assert.ok(backgroundSize, `element screenshot did not report its size: ${tallBackground.text}`);
    assert.doesNotMatch(tallBackground.text, /visible part/);
    assert.ok(
      Number(backgroundSize[2]) > 1_000,
      `a 1400px section should arrive whole on a background page, got ${backgroundSize[0]}`
    );
    const storedCrop = await command({
      action: 'snapshot',
      mode: 'visual',
      target: { selector: '#tall-report' },
      format: 'png',
      image_output: 'file',
      tab: 'crop-check',
    });
    assert.match(storedCrop.text, /Frame written to .*\.png \(\d+ bytes\)/);
    assert.equal(storedCrop.image, undefined, 'image_output=file keeps pixels out of the reply');
    await command({ action: 'close_tab', tab: 'crop-check' });
    progress('element screenshot crop complete');

    turnId = 41;
    const readResult = await command({ action: 'read', query: 'SPA done 3', tab: 'alpha' });
    assert.match(readResult.text, /SPA done 3/);
    alpha = await command({ action: 'wait', text: 'SPA done 3', tab: 'alpha' });
    assert.match(alpha.text, /Condition met after \d+ms/);
    alpha = await command({
      action: 'type',
      ref: refNamed(alpha.text, 'Type probe'),
      text: 'bridge',
      tab: 'alpha',
    });
    assert.match(alpha.text, /Typed bridge/);
    // Typed text must arrive as real keystrokes: a control that only listens
    // for keys (autocomplete, combobox) sees nothing from a bulk insertion.
    const typedKeys = await command({ action: 'evaluate', script: 'window.typeKeys', tab: 'alpha' });
    assert.match(typedKeys.text, /bridge/);
    // Text outside the US layout has no physical key of its own; it must still
    // reach the control.
    alpha = await command({
      action: 'type',
      ref: refNamed(typedKeys.text, 'Type probe'),
      text: '한글 입력',
      tab: 'alpha',
    });
    assert.match(alpha.text, /Typed 한글 입력/);
    // One key event per character must stay affordable on a long value.
    const longTyping = await command({
      action: 'type',
      ref: refNamed(alpha.text, 'Type probe'),
      text: 'x'.repeat(200),
      tab: 'alpha',
    });
    progress(`type 200 characters: inputMs=${(longTyping.timing?.inputMs || 0).toFixed(1)}`);
    assert.ok(
      (longTyping.timing?.inputMs || 0) < 5_000,
      `typing 200 characters should stay responsive, took ${longTyping.timing?.inputMs}ms`
    );
    alpha = longTyping;
    alpha = await command({ action: 'press', key: 'Tab', tab: 'alpha' });
    alpha = await command({
      action: 'upload',
      ref: refNamed(alpha.text, 'Upload fixture'),
      paths: [uploadFixturePath],
      tab: 'alpha',
    });
    assert.match(alpha.text, /Uploaded browser-upload-fixture\.txt/);
    // A target that never opens a chooser still takes the files as a drop,
    // the way a person delivers them to a drop zone.
    alpha = await command({
      action: 'upload',
      ref: refNamed(alpha.text, 'Drop zone'),
      paths: [uploadFixturePath],
      tab: 'alpha',
    });
    assert.match(alpha.text, /Dropped browser-upload-fixture\.txt/);
    progress('read, wait, type, press, and upload dispatch complete');

    // A styled button over a hidden input: the click opens a native picker
    // that Chromium hands to the host instead of showing, and upload answers it.
    turnId = 42;
    alpha = await command({
      action: 'upload',
      ref: refNamed(alpha.text, 'Choose attachment'),
      paths: [uploadFixturePath],
      tab: 'alpha',
    });
    assert.match(alpha.text, /Proxy uploaded browser-upload-fixture\.txt/);
    assert.doesNotMatch(alpha.text, /Pending file chooser/);
    progress('proxy-button upload through the intercepted file chooser complete');

    const blockedSpaRef = refNamed(alpha.text, 'Update SPA');
    const dialogRef = refNamed(alpha.text, 'Open dialog');
    const dialogStartedAt = Date.now();
    const blocked = await command({ action: 'click', ref: dialogRef, tab: 'alpha' });
    assert.ok(Date.now() - dialogStartedAt < 2_000, 'dialog interception should not wait for native CDP timeout');
    if (!/dialog is blocking the page/i.test(blocked.text)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const status = await command({ action: 'status', tab: 'alpha' });
      assert.match(`${blocked.text}\n\nStatus:\n${status.text}`, /dialog is blocking the page/i);
    }
    // A gesture sent while the dialog is up must be refused, not queued behind
    // it: otherwise it would fire as a ghost click once the dialog closes.
    const ghostStartedAt = Date.now();
    const ghost = await command({ action: 'click', ref: blockedSpaRef, tab: 'alpha' });
    assert.match(ghost.text, /dialog is blocking the page/i);
    // Refused before dispatch and opened by a dispatched click read differently,
    // because neither may be replayed blindly.
    assert.match(ghost.text, /This action was not sent/);
    if (/dialog is blocking the page/i.test(blocked.text))
      assert.match(blocked.text, /The action ran; do not repeat it/);
    assert.ok(Date.now() - ghostStartedAt < 1_000, 'a blocked gesture returns without dispatching');
    alpha = await command({ action: 'handle_dialog', accept: false, tab: 'alpha' });
    assert.match(alpha.text, /Dialog dismissed/);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterDialog = await command({ action: 'read', tab: 'alpha' });
    assert.match(afterDialog.text, /Dialog dismissed/);
    assert.doesNotMatch(afterDialog.text, /SPA done 4/);
    progress('dialog handling and blocked-gesture refusal complete');

    turnId = 2;
    const armRef = refNamed(alpha.text, 'Arm rerender');
    const armed = await command({ action: 'click', ref: armRef, tab: 'alpha' });
    const healingRef = refNamed(armed.text, 'Self-heal target');
    await new Promise((resolve) => setTimeout(resolve, 900));
    alpha = await command({ action: 'click', ref: healingRef, tab: 'alpha' });
    assert.match(alpha.text, /Automatic ref recovery before input dispatch \(no action replay\)/);
    assert.match(alpha.text, /Self-heal clicked/);
    progress('stale ref self-healing complete');

    turnId = 20;
    const firstNameRef = refNamed(alpha.text, 'First name');
    const lastNameRef = refNamed(alpha.text, 'Last name');
    const preferredRoleRef = refNamed(alpha.text, 'Preferred role');
    const checkboxRef = refNamed(alpha.text, 'Default checkbox');
    alpha = await command({
      action: 'fill',
      fields: [
        { ref: firstNameRef, text: 'Ada' },
        { ref: lastNameRef, value: 'Lovelace' },
        { ref: preferredRoleRef, values: ['engineer'] },
        { ref: checkboxRef, checked: true },
      ],
      tab: 'alpha',
    });
    assert.match(alpha.text, /value="Ada"/);
    assert.match(alpha.text, /value="Lovelace"/);
    assert.match(alpha.text, /value="Engineer"/);
    assert.match(alpha.text, /checkbox "Default checkbox" checked=true/);
    progress(`checkbox batch timing ${JSON.stringify(alpha.timing)}`);

    // One call, several gestures on the same page: every step must land, the
    // whole chain must take ONE snapshot, and a step that
    // fails must report exactly how far the chain got.
    turnId = 26;
    // Every step addresses the SAME snapshot: steps take none of their own, so
    // one generation drives the whole chain.
    const sequenceFirstNameRef = refNamed(alpha.text, 'First name');
    const sequenceLastNameRef = refNamed(alpha.text, 'Last name');
    const sequenceRoleRef = refNamed(alpha.text, 'Preferred role');
    const sequenced = await command({
      action: 'sequence',
      steps: [
        { action: 'fill', ref: sequenceFirstNameRef, text: 'Grace' },
        { action: 'fill', ref: sequenceLastNameRef, text: 'Hopper' },
        { action: 'select', ref: sequenceRoleRef, values: ['designer'] },
      ],
      expect: { text: 'Role designer', timeoutMs: 2_000 },
      tab: 'alpha',
    });
    assert.match(sequenced.text, /Sequence completed 3 steps \(1:fill, 2:fill, 3:select\)/);
    assert.match(sequenced.text, /value="Grace"/);
    assert.match(sequenced.text, /value="Hopper"/);
    assert.match(sequenced.text, /value="Designer"/);
    assert.match(sequenced.text, /Postcondition met/);
    assert.ok(sequenced.timing);
    assert.ok(sequenced.timing.commandMs >= sequenced.timing.waitMs);
    assert.equal(sequenced.timing.snapshots, 1);
    assert.deepEqual(
      sequenced.timing.steps?.map((step) => step.index),
      [1, 2, 3]
    );
    progress(`sequence timing ${JSON.stringify(sequenced.timing)}`);
    await assert.rejects(
      command({
        action: 'sequence',
        steps: [
          { action: 'fill', ref: refNamed(sequenced.text, 'First name'), text: 'Ada' },
          { action: 'click', ref: 'p1-s1-e9999' },
        ],
        tab: 'alpha',
      }),
      /Sequence stopped at step 2 \(click\)[\s\S]*completed 1:fill/
    );
    alpha = await command({ action: 'snapshot', tab: 'alpha' });
    assert.match(alpha.text, /value="Ada"/);
    const polished = await command({
      action: 'fill',
      target: { name: 'First name', exact: true },
      text: 'Polished',
      brief: true,
      tab: 'alpha',
    });
    assert.match(polished.text, /value="Polished"/);
    assert.match(polished.text, /[1-9]\d* unchanged omitted/);
    assert.doesNotMatch(polished.text, /textbox "Last name"/);
    assert.ok(polished.timing && polished.timing.targetMs > 0);
    progress(`target brief timing ${JSON.stringify(polished.timing)}`);
    await assert.rejects(
      command({
        action: 'sequence',
        steps: [
          { action: 'navigate', url: `${origin}/secondary` },
          { action: 'press', key: 'Enter' },
        ],
        tab: 'alpha',
      }),
      /action must be one of/
    );
    progress('sequence chaining complete');
    const targetPage = await command({
      action: 'navigate',
      url: `${origin}/target-regressions`,
      tab: 'target-regressions',
      background: true,
    });
    assert.doesNotMatch(targetPage.text, /textbox/, 'CSS-only fields must require minted refs');
    await command({
      action: 'fill',
      tab: 'target-regressions',
      fields: [
        { target: { selector: '[data-key="a  b"]' }, text: 'First value' },
        { target: { selector: '[data-key="a b"]' }, text: 'Second value' },
      ],
    });
    const targetGuest = contentsWithUrl('/target-regressions');
    assert.deepEqual(
      await targetGuest.executeJavaScript(
        '[document.querySelector("#first").value, document.querySelector("#second").value]'
      ),
      ['First value', 'Second value']
    );
    await assert.rejects(
      command({
        action: 'click',
        tab: 'target-regressions',
        target: { selector: '[data-many]', name: 'Duplicate', exact: true },
      }),
      /matched 51 elements, exceeding the limit of 50/
    );
    assert.equal(await targetGuest.executeJavaScript('window.fixtureClicks'), 0, 'overflow must dispatch no click');
    await command({ action: 'close_tab', tab: 'target-regressions' });
    progress('CSS literal preservation, distinct batch targets and selector overflow refusal complete');
    turnId = 90;
    await runBrowserLatencyScenarios(command, origin, progress);

    // Custom (non-native) dropdown: the page owns the popup, so select has to
    // open the trigger and activate the matching option instead of assigning.
    turnId = 28;
    alpha = await command({ action: 'snapshot', tab: 'alpha' });
    const cityRef = refNamed(alpha.text, 'Choose city');
    const citySelected = await command({
      action: 'select',
      ref: cityRef,
      values: ['Busan'],
      expect: { text: 'City Busan', timeoutMs: 2_000 },
      tab: 'alpha',
    });
    assert.match(citySelected.text, /City Busan/);
    assert.match(citySelected.text, /Postcondition met/);
    // An open list with no match is a real failure, and it reports what IS on
    // offer instead of silently waiting.
    await assert.rejects(
      command({
        action: 'select',
        ref: refNamed(citySelected.text, 'Choose city'),
        values: ['Atlantis'],
        tab: 'alpha',
      }),
      /no open option matched[\s\S]*Seoul/
    );

    const products = await command({
      action: 'extract',
      selector: 'li.product',
      attributes: ['data-price'],
      tab: 'alpha',
    });
    assert.match(products.text, /Extracted 3 match\(es\)/);
    assert.match(products.text, /1\. Widget one \{data-price="1200"\}/);
    assert.match(products.text, /3\. Widget three \{data-price="5600"\}/);
    const limitedProducts = await command({
      action: 'extract',
      selector: 'li.product',
      limit: 1,
      tab: 'alpha',
    });
    assert.match(limitedProducts.text, /showing 1 of 3 matches/);
    // Table rows keep their cell boundaries and name the header once.
    const ledger = await command({ action: 'extract', selector: '#ledger tbody tr', tab: 'alpha' });
    assert.match(ledger.text, /Columns: Last name \| First name\n1\. Smith John \| Jr\n2\. Doe \| Jane/);
    await assert.rejects(
      command({ action: 'extract', selector: 'li..broken', tab: 'alpha' }),
      /not a valid CSS selector/
    );
    progress('custom dropdown and extraction complete');

    // Reading a control instead of changing it, and reaching a phrase whose
    // position nobody knows. A phrase that is absent must not scroll blindly.
    turnId = 34;
    alpha = await command({ action: 'snapshot', tab: 'alpha' });
    const roleOptions = await command({
      action: 'select',
      ref: refNamed(alpha.text, 'Preferred role'),
      tab: 'alpha',
    });
    assert.match(roleOptions.text, /Options for [\w-]+ \(2\)/);
    // The listing marks the current choice so reading options needs no snapshot.
    assert.match(roleOptions.text, /- Designer \[selected\]$/m);
    assert.match(roleOptions.text, /- Engineer$/m);
    const scrolledToText = await command({
      action: 'scroll',
      text: 'Extended snapshot tail',
      tab: 'alpha',
    });
    assert.match(scrolledToText.text, /Scrolled to ".*Extended snapshot tail.*"\./);
    assert.match(scrolledToText.text, /Snapshot: /);
    await assert.rejects(
      command({ action: 'scroll', text: 'no such phrase on this fixture', tab: 'alpha' }),
      /was not found on this page/
    );
    progress('option read and text scroll complete');

    // Pixels can answer beside the run instead of inside the conversation, and
    // a printed page always does.
    turnId = 35;
    const filedShot = await command({
      action: 'snapshot',
      mode: 'visual',
      image_output: 'file',
      tab: 'alpha',
    });
    assert.equal(filedShot.image, undefined, filedShot.text);
    const framePath = filedShot.text.match(/Frame written to (.+?) \((\d+) bytes\)/);
    assert.ok(framePath, filedShot.text);
    assert.equal(statSync(framePath[1]).size, Number(framePath[2]));
    const printed = await command({
      action: 'snapshot',
      mode: 'visual',
      format: 'pdf',
      tab: 'alpha',
    });
    assert.equal(printed.image, undefined, printed.text);
    const pdfPath = printed.text.match(/to (.+?\.pdf) \((\d+) bytes\)/);
    assert.ok(pdfPath, printed.text);
    assert.equal(statSync(pdfPath[1]).size, Number(pdfPath[2]));
    progress('frame file output and pdf print complete');

    // Each timed-out wait owns its observation; one caller must never receive
    // the other caller's condition or ref generation.
    turnId = 33;
    const waits = await Promise.allSettled([
      command({ action: 'wait', text: 'never-appears-a', timeoutMs: 500, tab: 'alpha' }),
      command({ action: 'wait', text: 'never-appears-b', timeoutMs: 500, tab: 'alpha' }),
    ]);
    const reasons = waits.map((entry) => {
      assert.equal(entry.status, 'rejected');
      return entry.status === 'rejected' ? String(entry.reason) : '';
    });
    assert.match(reasons[0], /never-appears-a/);
    assert.match(reasons[1], /never-appears-b/);
    assert.notEqual(reasons[0].match(/Snapshot: (p\d+-s\d+)/)?.[1], reasons[1].match(/Snapshot: (p\d+-s\d+)/)?.[1]);
    progress('observation generation isolation complete');

    turnId = 27;
    // The blocks above advanced the ref generation several times.
    alpha = await command({ action: 'snapshot', tab: 'alpha' });
    const mouseOptionsRef = refNamed(alpha.text, 'Mouse options');
    alpha = await command({
      action: 'click',
      ref: mouseOptionsRef,
      button: 'right',
      modifiers: ['Control', 'Shift'],
      tab: 'alpha',
    });
    assert.match(alpha.text, /Mouse 2 ctrl=true shift=true/);
    progress(`pointer timing ${JSON.stringify(alpha.timing)}`);
    const uncheckedRef = refNamed(alpha.text, 'Default checkbox');
    alpha = await command({
      action: 'fill',
      ref: uncheckedRef,
      checked: false,
      tab: 'alpha',
    });
    assert.match(alpha.text, /Checkbox unchecked/);
    assert.match(alpha.text, /checkbox "Default checkbox" checked=false/);
    const hoverRef = refNamed(alpha.text, 'Hover target');
    alpha = await command({ action: 'hover', ref: hoverRef, tab: 'alpha' });
    assert.match(alpha.text, /Semantic hovered/);
    const dragSourceRef = refNamed(alpha.text, 'Drag source');
    const dragTargetRef = refNamed(alpha.text, 'Drag target');
    alpha = await command({
      action: 'drag',
      ref: dragSourceRef,
      targetRef: dragTargetRef,
      tab: 'alpha',
    });
    assert.match(alpha.text, /Mouse dragged/);
    const infoConsole = await command({
      action: 'console',
      level: 'info',
      query: 'fixture-info',
      tab: 'alpha',
    });
    assert.match(infoConsole.text, /\[info\].*fixture-info-ready/);
    const visualOnly = await command({
      action: 'snapshot',
      mode: 'visual',
      format: 'png',
      tab: 'alpha',
    });
    assert.equal(visualOnly.image?.mimeType, 'image/png');
    assert.doesNotMatch(visualOnly.text, /Snapshot: p\d+-s\d+/);
    progress('compressed interaction fields and visual-only snapshot complete');

    turnId = 21;
    const visual = await command({ action: 'snapshot', mode: 'both', tab: 'alpha' });
    let grounding = visualGrounding(visual.text);
    const visualHovered = await command({
      action: 'hover',
      snapshotId: grounding.snapshotId,
      x: (660 * grounding.imageWidth) / grounding.viewportWidth,
      y: (130 * grounding.imageHeight) / grounding.viewportHeight,
      tab: 'alpha',
    });
    assert.match(visualHovered.text, /Visual hovered/);
    const clickGrounding = await command({ action: 'snapshot', mode: 'both', tab: 'alpha' });
    grounding = visualGrounding(clickGrounding.text);
    const visualClicked = await command({
      action: 'click',
      snapshotId: grounding.snapshotId,
      x: (660 * grounding.imageWidth) / grounding.viewportWidth,
      y: (130 * grounding.imageHeight) / grounding.viewportHeight,
      tab: 'alpha',
    });
    assert.match(visualClicked.text, /Visual clicked 1/);
    await assert.rejects(
      command({
        action: 'click',
        snapshotId: grounding.snapshotId,
        x: (660 * grounding.imageWidth) / grounding.viewportWidth,
        y: (130 * grounding.imageHeight) / grounding.viewportHeight,
        tab: 'alpha',
      }),
      /latest snapshot\(mode=both\) or locate result/
    );
    alpha = await command({ action: 'snapshot', tab: 'alpha' });
    assert.match(alpha.text, /Visual clicked 1/);
    const dragVisual = await command({ action: 'snapshot', mode: 'both', tab: 'alpha' });
    grounding = visualGrounding(dragVisual.text);
    const coordinateDragged = await command({
      action: 'drag',
      snapshotId: grounding.snapshotId,
      x: (640 * grounding.imageWidth) / grounding.viewportWidth,
      y: (225 * grounding.imageHeight) / grounding.viewportHeight,
      targetX: (850 * grounding.imageWidth) / grounding.viewportWidth,
      targetY: (225 * grounding.imageHeight) / grounding.viewportHeight,
      tab: 'alpha',
    });
    assert.match(coordinateDragged.text, /Mouse dragged/);
    // A page that answers the press-and-move with its own HTML5 drag is
    // finished through drag events; raw mouse events alone never drop.
    const cardVisual = await command({ action: 'snapshot', mode: 'both', tab: 'alpha' });
    const cardGrounding = visualGrounding(cardVisual.text);
    const cardDropped = await command({
      action: 'drag',
      snapshotId: cardGrounding.snapshotId,
      x: (660 * cardGrounding.imageWidth) / cardGrounding.viewportWidth,
      y: (320 * cardGrounding.imageHeight) / cardGrounding.viewportHeight,
      targetX: (880 * cardGrounding.imageWidth) / cardGrounding.viewportWidth,
      targetY: (320 * cardGrounding.imageHeight) / cardGrounding.viewportHeight,
      tab: 'alpha',
    });
    assert.match(cardDropped.text, /Card dropped card-42/);
    progress('HTML5 drag and drop complete');
    turnId = 22;
    const located = await command({ action: 'locate', query: 'yellow', tab: 'alpha' });
    assert.equal(located.image?.mimeType, 'image/jpeg');
    assert.match(located.text, /Visual candidates[\s\S]*yellow[\s\S]*center=\(\d+,\d+\) image px/);
    alpha = { text: located.text };
    progress('visual grounding and stale-coordinate replay guard complete');

    const popupRef = refNamed(alpha.text, 'Open popup');
    await command({ action: 'click', ref: popupRef, tab: 'alpha' });
    const tabs = await eventually(
      () => command({ action: 'list_tabs' }),
      (result) => result.text.includes('popup-1') && result.text.includes('Popup fixture')
    );
    assert.match(tabs.text, /p\d+ \["popup-1"\] \(popup from p\d+\)/);
    progress('popup tracking complete');

    turnId = 38;
    await command({
      action: 'open',
      background: true,
      tab: 'history',
    });
    const wentBack = await command({ action: 'back', tab: 'history' });
    assert.match(wentBack.text, /Cannot go back: no earlier history entry/);
    const closedHistory = await command({ action: 'close_tab', tab: 'history' });
    assert.match(closedHistory.text, /Closed background tab "history"/);
    // The id a caller reads off list_tabs may belong to the visible tab, and
    // that page belongs to the panel; the refusal has to say so rather than
    // point back at the listing it came from.
    const openTabs = await command({ action: 'list_tabs' });
    const visiblePageId = /- (p\d+) \[v1\]/.exec(openTabs.text)?.[1];
    assert.ok(visiblePageId, 'list_tabs prints a page id for the visible tab');
    await assert.rejects(command({ action: 'close_tab', tab: visiblePageId }), /is the visible tab/);
    await assert.rejects(command({ action: 'close_tab', tab: 'v1' }), /is the visible tab/);
    await assert.rejects(command({ action: 'close_tab', tab: 'never-opened' }), /unknown background tab/);
    progress('history navigation and tab closure complete');

    turnId = 3;
    await command({
      action: 'navigate',
      url: `${origin}/secondary`,
      background: true,
      tab: 'beta',
    });
    const betaGuest = contentsWithUrl('/secondary');
    betaGuest.setZoomFactor(0.75);
    assert.ok(Math.abs(betaGuest.getZoomFactor() - 0.75) < 0.01);
    assert.match((await command({ action: 'snapshot', tab: 'alpha' })).text, /Root fixture/);
    const betaSnapshot = await command({ action: 'snapshot', tab: 'beta' });
    assert.match(betaSnapshot.text, /Secondary fixture/);
    const betaStatus = await command({ action: 'status', tab: 'beta' });
    assert.match(betaStatus.text, /Pending requests: 0/);
    const betaDocuments = await command({
      action: 'network',
      query: '/secondary',
      resourceTypes: ['document'],
      tab: 'beta',
    });
    const betaDocumentId = networkRequestId(betaDocuments.text, '/secondary');
    const betaDocument = await command({
      action: 'network',
      requestId: betaDocumentId,
      maxChars: 2_000,
      tab: 'beta',
    });
    assert.doesNotMatch(betaDocument.text, /still pending/);
    assert.match(betaDocument.text, /Status: 200 OK/);
    // Chromium announces a provisional header set and adds the rest as the
    // request leaves. A detail built from the provisional set alone reads as
    // if the page never negotiated encoding or fetch metadata.
    assert.match(betaDocument.text, /- (?:Accept-Encoding|accept-encoding|Sec-Fetch-Mode|sec-fetch-mode):/);
    turnId = 23;
    const scrollInsideRef = refNamed(betaSnapshot.text, 'Scroll inside');
    await command({
      action: 'scroll',
      ref: scrollInsideRef,
      dy: 180,
      tab: 'beta',
    });
    const nestedScroll = await command({
      action: 'evaluate',
      script: `(() => {
        const box = document.querySelector('#scroll-box');
        return { scrollLeft: box.scrollLeft, scrollTop: box.scrollTop };
      })()`,
      tab: 'beta',
    });
    assert.match(nestedScroll.text, /"scrollLeft": 0/);
    assert.match(nestedScroll.text, /"scrollTop": [1-9]\d*/);
    const resetNestedScroll = await command({
      action: 'evaluate',
      script: `(() => {
        const box = document.querySelector('#scroll-box');
        box.scrollTo(0, 0);
        return { scrollLeft: box.scrollLeft, scrollTop: box.scrollTop };
      })()`,
      tab: 'beta',
    });
    const horizontalScrollRef = refNamed(resetNestedScroll.text, 'Scroll inside');
    await command({
      action: 'scroll',
      ref: horizontalScrollRef,
      dx: 120,
      tab: 'beta',
    });
    const horizontalScroll = await command({
      action: 'evaluate',
      script: `(() => {
        const box = document.querySelector('#scroll-box');
        return { scrollLeft: box.scrollLeft, scrollTop: box.scrollTop };
      })()`,
      tab: 'beta',
    });
    assert.match(horizontalScroll.text, /"scrollLeft": [1-9]\d*/);
    assert.match(horizontalScroll.text, /"scrollTop": 0/);
    const evaluated = await command({
      action: 'evaluate',
      script: `new Promise((resolve) => setTimeout(() => {
        document.querySelector('p').textContent = 'Secondary evaluated';
        resolve({ title: document.title, status: 'async complete' });
      }, 50))`,
      tab: 'beta',
    });
    assert.match(evaluated.text, /"status": "async complete"/);
    assert.match(evaluated.text, /Secondary evaluated/);
    const reloaded = await command({ action: 'navigate', reload: true, tab: 'beta' });
    assert.match(reloaded.text, /Secondary page/);
    assert.doesNotMatch(reloaded.text, /Secondary evaluated/);
    const fullPage = await command({
      action: 'snapshot',
      mode: 'visual',
      fullPage: true,
      format: 'jpeg',
      quality: 60,
      tab: 'beta',
    });
    assert.equal(fullPage.image?.mimeType, 'image/jpeg');
    assert.match(fullPage.text, /Full-page screenshot/);
    assert.ok((fullPage.image?.data?.length || 0) > 1_000);
    const fullPageImage = nativeImage.createFromBuffer(Buffer.from(fullPage.image?.data || '', 'base64'));
    const fullPageSize = fullPageImage.getSize();
    assert.ok(fullPageSize.height > 1_000, `full-page capture was too short: ${fullPageSize.height}px`);
    progress(`screenshot encoding comparison: ${JSON.stringify(measureScreenshotReuse(fullPage.image!.data!))}`);
    const topPixel = imagePixel(fullPage.image?.data || '', 0.9, 0.1);
    const bottomPixel = imagePixel(fullPage.image?.data || '', 0.9, 0.9);
    const colorDistance = topPixel.reduce((total, channel, index) => total + Math.abs(channel - bottomPixel[index]), 0);
    assert.ok(colorDistance > 150, `full-page capture repeated vertically: ${topPixel} vs ${bottomPixel}`);
    turnId = 24;
    await command({
      action: 'evaluate',
      script: `fetch(${JSON.stringify(`${origin}/api/submit`)}, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer do-not-leak' },
        body: JSON.stringify({ message: 'hello network' }),
      }).then((response) => response.json())`,
      tab: 'beta',
    });
    const network = await command({
      action: 'network',
      query: '/api/submit',
      resourceTypes: ['fetch'],
      tab: 'beta',
    });
    assert.match(network.text, /POST fetch 200/);
    const requestId = networkRequestId(network.text, '/api/submit');
    const request = await command({ action: 'network', requestId, tab: 'beta' });
    assert.match(request.text, /Request body:[\s\S]*hello network/);
    assert.match(request.text, /Response body:[\s\S]*"ok":true/);
    assert.match(request.text, /x-fixture: network-detail/i);
    assert.doesNotMatch(request.text, /do-not-leak/);
    progress('background isolation complete');

    turnId = 30;
    await command({
      action: 'cookies',
      operation: 'set',
      name: 'mixdog-fixture',
      value: 'cookie-ready',
      httpOnly: true,
      tab: 'beta',
    });
    const cookies = await command({
      action: 'cookies',
      operation: 'list',
      name: 'mixdog-fixture',
      tab: 'beta',
    });
    assert.doesNotMatch(cookies.text, /cookie-ready/);
    assert.match(cookies.text, /\[REDACTED\]/);
    assert.match(cookies.text, /"httpOnly": true/);

    // The client hints this partition sends name Chromium alone. An agent
    // string that also names the embedding app contradicts them, and sites
    // answer that mismatch with a login wall or an unsupported-browser page.
    const agent = await command({ action: 'evaluate', script: 'navigator.userAgent', tab: 'beta' });
    assert.doesNotMatch(agent.text, /Electron|mixdog-desktop/i);
    assert.match(agent.text, /Chrome\/\d+/);
    // Normalising the agent string must not take the session's language
    // negotiation with it: a request that carries no Accept-Language asks
    // sites that pick content by language for somebody else's page.
    const defaultLanguage = await command({
      action: 'evaluate',
      script: `fetch(${JSON.stringify(`${origin}/api/echo-headers`)})
        .then((response) => response.json())
        .then((payload) => payload.headers['accept-language'] || 'missing')`,
      tab: 'beta',
    });
    assert.doesNotMatch(defaultLanguage.text, /missing/, 'the browser still negotiates a language by default');
    progress('pages are told the Chrome build that renders them');
    await command({
      action: 'storage',
      operation: 'set',
      storageType: 'local',
      name: 'mixdog-fixture',
      value: 'storage-ready',
      tab: 'beta',
    });
    const storage = await command({
      action: 'storage',
      operation: 'get',
      storageType: 'local',
      name: 'mixdog-fixture',
      tab: 'beta',
    });
    assert.match(storage.text, /storage-ready/);
    await command({ action: 'cookies', operation: 'clear', tab: 'beta' });
    await command({
      action: 'storage',
      operation: 'clear',
      storageType: 'local',
      tab: 'beta',
    });
    progress('cookie and storage management complete');

    turnId = 36;
    await command({
      action: 'intercept',
      operation: 'add',
      url: '*/recovered*',
      body: 'fixture-mocked',
      resourceTypes: ['fetch'],
      tab: 'beta',
    });
    const replacedResponse = await command({
      action: 'evaluate',
      script: `fetch('/recovered').then(async (response) => ({
        status: response.status,
        body: await response.text(),
      }))`,
      tab: 'beta',
    });
    // The payload is the rule's while the status line stays the server's, which
    // is exactly what a replaced body promises and all Chromium honours here.
    assert.match(replacedResponse.text, /fixture-mocked/);
    assert.match(replacedResponse.text, /"status": 200/);
    const unmockedXhr = await command({
      action: 'evaluate',
      script: `new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('GET', '/recovered');
        request.onload = () => resolve(request.responseText);
        request.onerror = reject;
        request.send();
      })`,
      tab: 'beta',
    });
    assert.match(unmockedXhr.text, /Queue recovered/);
    assert.doesNotMatch(unmockedXhr.text, /fixture-mocked/);
    const interceptList = await command({ action: 'intercept', tab: 'beta' });
    assert.match(interceptList.text, /\[i\d+\] replace body [\s\S]*— 1 hit/);
    await command({
      action: 'intercept',
      operation: 'add',
      url: '*/api/submit*',
      abort: true,
      resourceTypes: ['fetch'],
      tab: 'beta',
    });
    const abortedRequest = await command({
      action: 'evaluate',
      script: `fetch('/api/submit', { method: 'POST', body: '{}' })
        .then(() => 'reached the server')
        .catch((error) => 'refused:' + error.name)`,
      tab: 'beta',
    });
    assert.match(abortedRequest.text, /refused:TypeError/);
    await command({ action: 'intercept', operation: 'clear', tab: 'beta' });
    // Clearing has to restore the real network, not leave the page answering
    // from a rule table nobody can see anymore.
    const liveAgain = await command({
      action: 'evaluate',
      script: "fetch('/recovered').then((response) => response.text())",
      tab: 'beta',
    });
    assert.match(liveAgain.text, /Queue recovered/);
    progress('request interception complete');

    turnId = 37;
    await command({
      action: 'emulate',
      headers: { 'x-mixdog-fixture': 'header-ready' },
      latitude: 37.5665,
      longitude: 126.978,
      accuracy: 25,
      tab: 'beta',
    });
    const echoedHeaders = await command({
      action: 'evaluate',
      script: `fetch(${JSON.stringify(`${origin}/api/echo-headers`)})
        .then((response) => response.json())
        .then((payload) => payload.headers['x-mixdog-fixture'] || 'missing')`,
      tab: 'beta',
    });
    assert.match(echoedHeaders.text, /header-ready/);
    // An emulated locale must reach the server, not just navigator.language.
    await command({ action: 'emulate', locale: 'ko-KR', tab: 'beta' });
    const echoedLanguage = await command({
      action: 'evaluate',
      script: `fetch(${JSON.stringify(`${origin}/api/echo-headers`)})
        .then((response) => response.json())
        .then((payload) => payload.headers['accept-language'] || 'missing')`,
      tab: 'beta',
    });
    assert.match(echoedLanguage.text, /ko-KR/);
    const registered = await command({
      action: 'init_script',
      operation: 'add',
      script: 'window.__mixdogSeed = "seeded-before-boot";',
      tab: 'beta',
    });
    assert.match(registered.text, /Registered init script is\d+/);
    const registeredId = registered.text.match(/init script (is\d+)/)?.[1] || '';
    await command({ action: 'navigate', url: `${origin}/secondary`, tab: 'beta' });
    const seedPresent = await command({
      action: 'evaluate',
      script: 'window.__mixdogSeed || "absent"',
      tab: 'beta',
    });
    assert.match(seedPresent.text, /seeded-before-boot/);
    await command({
      action: 'init_script',
      operation: 'remove',
      scriptId: registeredId,
      tab: 'beta',
    });
    await command({ action: 'navigate', url: `${origin}/secondary`, tab: 'beta' });
    const seedGone = await command({
      action: 'evaluate',
      script: 'window.__mixdogSeed || "absent"',
      tab: 'beta',
    });
    assert.match(seedGone.text, /absent/);
    progress('extra headers, geolocation, and init scripts complete');

    turnId = 31;
    await command({
      action: 'emulate',
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
      touch: true,
      userAgent: 'MixdogMobileFixture/1.0',
      locale: 'en-US',
      timezone: 'UTC',
      colorScheme: 'dark',
      tab: 'beta',
    });
    const emulated = await command({
      action: 'evaluate',
      script: `({
        width: innerWidth,
        touchPoints: navigator.maxTouchPoints,
        userAgent: navigator.userAgent,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
      })`,
      tab: 'beta',
    });
    assert.match(emulated.text, /"width": 390/);
    assert.match(emulated.text, /"touchPoints": 5/);
    assert.match(emulated.text, /MixdogMobileFixture/);
    assert.match(emulated.text, /"timezone": "UTC"/);
    assert.match(emulated.text, /"dark": true/);
    // A background tab's metrics never reframe the pane; only the visible
    // tab's do, and clearing them tells the pane to go back to responsive.
    assert.deepEqual(viewportChanges, []);
    await command({ action: 'emulate', width: 1024, height: 768 });
    await command({ action: 'emulate', reset: true });
    assert.deepEqual(viewportChanges.splice(0), [
      {
        sessionId: 'browser-integration-session',
        webContentsId: visibleGuest.id,
        viewport: { width: 1024, height: 768 },
      },
      { sessionId: 'browser-integration-session', webContentsId: visibleGuest.id, viewport: null },
    ]);
    browserSurfaceRequests.splice(0);
    const touchObserved = await command({ action: 'snapshot', mode: 'both', tab: 'beta' });
    const touchGrounding = visualGrounding(touchObserved.text);
    const touched = await command({
      action: 'click',
      pointer: 'touch',
      snapshotId: touchGrounding.snapshotId,
      x: (160 * touchGrounding.imageWidth) / touchGrounding.viewportWidth,
      y: (125 * touchGrounding.imageHeight) / touchGrounding.viewportHeight,
      tab: 'beta',
    });
    assert.match(touched.text, /Touched/);
    await command({
      action: 'evaluate',
      script: `(() => {
        window.inputProbe = [];
        const rect = document.querySelector('#touch-drag-source').getBoundingClientRect();
        window.sourceRectLabel = 'source:' + [
          rect.left, rect.top, rect.right, rect.bottom,
        ].map(Math.round).join(',');
        document.querySelector('#input-probe').textContent = window.sourceRectLabel;
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      })()`,
      tab: 'beta',
    });
    const touchDragObserved = await command({ action: 'snapshot', mode: 'both', tab: 'beta' });
    const touchDragGrounding = visualGrounding(touchDragObserved.text);
    const touchDragged = await command({
      action: 'drag',
      pointer: 'touch',
      snapshotId: touchDragGrounding.snapshotId,
      x: (140 * touchDragGrounding.imageWidth) / touchDragGrounding.viewportWidth,
      y: (225 * touchDragGrounding.imageHeight) / touchDragGrounding.viewportHeight,
      targetX: (350 * touchDragGrounding.imageWidth) / touchDragGrounding.viewportWidth,
      targetY: (225 * touchDragGrounding.imageHeight) / touchDragGrounding.viewportHeight,
      tab: 'beta',
    });
    assert.match(touchDragged.text, /Touch dragged/);
    // Under device emulation the image and the page count pixels differently;
    // an element image must still be exactly that element.
    const emulatedCrop = await command({
      action: 'snapshot',
      mode: 'visual',
      target: { selector: '#touch-target' },
      tab: 'beta',
    });
    const emulatedSize = /\((\d+)x(\d+) px\)/.exec(emulatedCrop.text);
    assert.ok(emulatedSize, `emulated element screenshot did not report its size: ${emulatedCrop.text}`);
    const emulatedScale = touchDragGrounding.imageWidth / touchDragGrounding.viewportWidth;
    assert.ok(
      Math.abs(Number(emulatedSize[1]) - 120 * emulatedScale) <= 2 &&
        Math.abs(Number(emulatedSize[2]) - 50 * emulatedScale) <= 2,
      `a 120x50 control at ${emulatedScale}x should crop to that size, got ${emulatedSize[0]}`
    );
    progress('mobile emulation and touch complete');

    turnId = 32;
    await command({ action: 'performance', operation: 'start', saveTrace: true, tab: 'beta' });
    await command({
      action: 'evaluate',
      script: `(() => {
        const started = performance.now();
        while (performance.now() - started < 25) Math.sqrt(Math.random());
        return 'trace work complete';
      })()`,
      tab: 'beta',
    });
    const trace = await command({ action: 'performance', operation: 'stop', tab: 'beta' });
    assert.match(trace.text, /Performance trace stopped/);
    assert.match(trace.text, /Events: [1-9]\d*/);
    const tracePath = trace.text.match(/Chrome trace written to (.+) \(\d+ bytes\)/)?.[1];
    assert.ok(tracePath);
    const traceJson = JSON.parse(readFileSync(tracePath, 'utf8'));
    assert.ok(traceJson.traceEvents.length > 0);
    assert.equal(traceJson.metadata.redacted, true);
    const metrics = await command({ action: 'performance', operation: 'metrics', tab: 'beta' });
    assert.match(metrics.text, /JSHeapUsedSize|TaskDuration/);

    await command({
      action: 'evaluate',
      script: `new Promise((resolve, reject) => {
        const socket = new WebSocket(${JSON.stringify(socketUrl)});
        socket.onopen = () => socket.send('hello-server');
        socket.onerror = () => reject(new Error('socket failed'));
        socket.onmessage = (event) => { const value = event.data; socket.close(); resolve(value); };
      })`,
      tab: 'beta',
    });
    const sockets = await command({
      action: 'network',
      query: '/socket',
      resourceTypes: ['websocket'],
      tab: 'beta',
    });
    const socketRequestId = networkRequestId(sockets.text, '/socket');
    const socketDetail = await command({
      action: 'network',
      requestId: socketRequestId,
      frameLimit: 10,
      tab: 'beta',
    });
    assert.match(socketDetail.text, /WebSocket frames/);
    assert.match(socketDetail.text, /hello-server/);
    assert.match(socketDetail.text, /echo:hello-server/);
    progress('performance trace and WebSocket frames complete');

    turnId = 4;
    const frameSnapshot = await command({
      action: 'navigate',
      url: `${origin}/frames`,
      background: true,
      tab: 'frames',
    });
    assert.match(frameSnapshot.text, /Cross-frame evidence/);
    assert.doesNotMatch(frameSnapshot.text, /rootwebarea/);
    // Shadow text is rendered inside its host, so reading both must not say it twice.
    const shadowRead = await command({ action: 'read', tab: 'frames' });
    const shadowMentions = shadowRead.text.split('Shadow frame evidence').length - 1;
    assert.equal(shadowMentions, 1, `shadow text should be read once, saw ${shadowMentions}`);
    const frameRef = refNamed(frameSnapshot.text, 'Frame action');
    // A ref in a cross-origin frame is measured through the accessibility
    // path, so its image must still be the control and not the parent page.
    const crossFrameShot = await command({
      action: 'snapshot',
      mode: 'visual',
      ref: frameRef,
      tab: 'frames',
    });
    const crossFrameSize = /\((\d+)x(\d+) px\)/.exec(crossFrameShot.text);
    assert.ok(crossFrameSize, `cross-origin element screenshot did not report its size: ${crossFrameShot.text}`);
    assert.ok(
      Number(crossFrameSize[1]) < 600 && Number(crossFrameSize[2]) < 120,
      `a framed button should crop to the control, got ${crossFrameSize[0]}`
    );
    const frameEvaluated = await command({
      action: 'evaluate',
      ref: frameRef,
      script: '({ text: element.textContent, origin: location.origin })',
      tab: 'frames',
    });
    assert.match(frameEvaluated.text, /"text": "Frame action"/);
    assert.match(frameEvaluated.text, new RegExp(frameOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const evaluatedFrameRef = refNamed(frameEvaluated.text, 'Frame action');
    const frameClicked = await command({
      action: 'click',
      ref: evaluatedFrameRef,
      tab: 'frames',
      expect: { text: 'Frame clicked', timeoutMs: 2_000 },
    });
    assert.match(frameClicked.text, /Frame clicked/);
    const frameRead = await command({ action: 'read', tab: 'frames' });
    assert.match(frameRead.text, /Cross-frame evidence/);
    assert.match(frameRead.text, /Shadow frame evidence/);
    const frameExtract = await command({ action: 'extract', selector: '.shadow-evidence', tab: 'frames' });
    assert.match(frameExtract.text, /Shadow frame evidence/);
    await command({ action: 'wait', text: 'Shadow frame evidence', tab: 'frames' });
    turnId = 410;
    const delayedFrame = contentsWithUrl('/frames').mainFrame.framesInSubtree.find((frame) =>
      frame.url.startsWith(frameOrigin)
    );
    assert.ok(delayedFrame);
    // Trigger fixture work independently of the action queue: an evaluate
    // action would settle first and could satisfy the condition before wait.
    const [delayedWait] = await Promise.all([
      command({ action: 'wait', text: 'Delayed frame wait evidence', tab: 'frames' }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await delayedFrame.executeJavaScript(`(() => {
          const marker = document.createElement('p');
          marker.textContent = 'Delayed frame wait evidence';
          document.body.append(marker);
          return true;
        })()`);
      })(),
    ]);
    assert.match(delayedWait.text, /Condition met/);
    progress(`event-driven iframe wait: ${JSON.stringify(delayedWait.timing)}`);
    turnId = 41;
    const coveredFrame = await command({
      action: 'evaluate',
      tab: 'frames',
      script: `(() => {
        const overlay = document.createElement('button');
        overlay.textContent = 'Parent blocker';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999';
        overlay.onclick = () => { document.title = 'WRONG TARGET'; };
        document.body.append(overlay);
      })()`,
    });
    await assert.rejects(
      command({
        action: 'click',
        ref: refNamed(coveredFrame.text, 'Frame clicked'),
        tab: 'frames',
      }),
      /parent frame.*covered|covered.*parent frame|input target changed/
    );
    const afterCovered = await command({ action: 'read', tab: 'frames' });
    assert.doesNotMatch(afterCovered.text, /WRONG TARGET/);
    // A frameset reads as its frames, never as the <noframes> fallback it hides.
    const frameset = await command({
      action: 'navigate',
      url: `${origin}/frameset`,
      background: true,
      tab: 'frameset',
    });
    const framesetRead = await command({ action: 'read', tab: 'frameset' });
    for (const report of [frameset.text, framesetRead.text]) {
      assert.doesNotMatch(report, /Frames are not rendering/);
      assert.match(report, /Left pane text/);
    }
    await command({ action: 'close_tab', tab: 'frameset' });
    progress('cross-origin frame accessibility complete');

    turnId = 411;
    const sameProcess = await command({
      action: 'navigate',
      url: `${origin}/same-process-frames`,
      background: true,
      tab: 'same-process',
    });
    assert.match(sameProcess.text, /Same-process evidence/);
    assert.ok(refNamed(sameProcess.text, 'Frame input'));
    await command({
      action: 'fill',
      tab: 'same-process',
      target: { role: 'textbox', name: 'Frame input', exact: true },
      text: 'same-process-ok',
    });
    const sameProcessClick = await command({
      action: 'click',
      tab: 'same-process',
      target: { role: 'button', name: 'Echo same-process frame', exact: true },
      expect: { text: 'Frame value: same-process-ok', timeoutMs: 2_000 },
    });
    assert.match(sameProcessClick.text, /Frame value: same-process-ok/);
    for (let iteration = 0; iteration < 3; iteration++) {
      const reloaded = await command({ action: 'navigate', reload: true, tab: 'same-process' });
      assert.match(reloaded.text, /Same-process evidence/);
      assert.ok(refNamed(reloaded.text, 'Frame input'));
    }
    // A ref inside a frame carries the frame's offset, so its image must be
    // the control itself rather than a slice of the parent document.
    const frameShot = await command({
      action: 'snapshot',
      mode: 'visual',
      tab: 'same-process',
      target: { role: 'textbox', name: 'Frame input', exact: true },
    });
    const frameShotSize = /\((\d+)x(\d+) px\)/.exec(frameShot.text);
    assert.ok(frameShotSize, `frame element screenshot did not report its size: ${frameShot.text}`);
    assert.ok(
      Number(frameShotSize[1]) < 600 && Number(frameShotSize[2]) < 120,
      `a framed text box should crop to the control, got ${frameShotSize[0]}`
    );
    await command({ action: 'close_tab', tab: 'same-process' });
    progress('same-process frame refs, input, fetch filtering and reload observation complete');

    await runBrowserPageReportScenarios(command, origin, progress);

    turnId = 5;
    const abort = new AbortController();
    const stalled = command(
      {
        action: 'navigate',
        url: `${origin}/stall`,
        tab: 'alpha',
      },
      abort.signal
    );
    setTimeout(() => abort.abort(), 250);
    await assert.rejects(stalled, /abort/i);
    const recovered = await Promise.race([
      command({ action: 'navigate', url: `${origin}/recovered`, tab: 'alpha' }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('queue recovery timed out')), 5_000)),
    ]);
    assert.match(recovered.text, /Queue recovered/);
    progress('queue recovery complete');

    turnId = 98;
    for (const removed of ['observe', 'screenshot', 'click_at', 'tap', 'hover_at', 'drag_at', 'swipe', 'fill_form']) {
      await assert.rejects(
        command({ action: removed, tab: 'alpha' }),
        new RegExp(`unknown browser action "${removed}"`)
      );
    }

    const surfaceRequestCountBeforeRemoteFrame = browserSurfaceRequests.length;
    const remoteFrame = await host.remoteBrowserFrame('browser-integration-session');
    assert.equal(browserSurfaceRequests.length, surfaceRequestCountBeforeRemoteFrame);
    assert.match(remoteFrame.frameId, /^rbf_[a-z0-9]+$/);
    assert.ok(remoteFrame.image?.data);
    await assert.rejects(
      host.remoteBrowserControl('browser-integration-session', {
        type: 'tap',
        frameId: 'rbf_stale',
        x: 10,
        y: 10,
      }),
      /frame is stale/
    );
    progress('remote Browser Use frame binding complete');

    // The visible page is where Chromium can paint past the window, so this
    // is where a section taller than the viewport must arrive whole.
    await command({ action: 'navigate', url: `${origin}/tall`, tab: 'alpha' });
    const tallForeground = await command({
      action: 'snapshot',
      mode: 'visual',
      target: { selector: '#tall-report' },
      tab: 'alpha',
    });
    const foregroundSize = /\((\d+)x(\d+) px\)/.exec(tallForeground.text);
    assert.ok(foregroundSize, `element screenshot did not report its size: ${tallForeground.text}`);
    assert.doesNotMatch(tallForeground.text, /visible part/);
    assert.ok(
      Number(foregroundSize[2]) > 1_000,
      `a 1400px section should be captured past the window, got ${foregroundSize[0]}`
    );
    progress('element screenshot past the window complete');

    // Leaving a page that guards unsaved work asks first, and the answer is
    // the caller's: staying must keep the page, accepting must leave it.
    await command({ action: 'navigate', url: `${origin}/unsaved`, tab: 'alpha' });
    const guardArmed = await command({
      action: 'click',
      target: { role: 'button', name: 'Arm guard' },
      tab: 'alpha',
    });
    assert.match(guardArmed.text, /Guard armed/);
    const leaving = await command({ action: 'navigate', url: `${origin}/popup`, tab: 'alpha' });
    assert.match(leaving.text, /refused to be left/);
    assert.match(leaving.text, /handle_dialog has nothing left to answer/);
    const afterFirst = await command({ action: 'snapshot', tab: 'alpha' });
    assert.match(afterFirst.text, /Unsaved fixture/);
    // The same navigation is refused the same way, so the reply must not send
    // the caller round a loop it cannot leave.
    const leavingAgain = await command({ action: 'navigate', url: `${origin}/popup`, tab: 'alpha' });
    assert.match(leavingAgain.text, /refused to be left/);
    assert.match((await command({ action: 'snapshot', tab: 'alpha' })).text, /Unsaved fixture/);
    // Once the page stops guarding, the very same navigation goes through.
    await command({ action: 'evaluate', script: 'window.onbeforeunload = null; "cleared"', tab: 'alpha' });
    const left = await command({ action: 'navigate', url: `${origin}/popup`, tab: 'alpha' });
    assert.match(left.text, /Popup fixture|Popup ready/);
    progress('beforeunload guard refuses navigation and releases once cleared');

    await command({ action: 'hide' });

    host.releaseSession('browser-integration-session');
    const releasedTabs = await command({ action: 'list_tabs' });
    assert.doesNotMatch(releasedTabs.text, /\["(?:alpha|beta|popup-\d+)"\]/);
    progress('session resource release complete');

    for (const action of ['navigate', 'snapshot', 'click']) {
      const samples = commandDurations.get(action) || [];
      progress(
        `latency ${action}: n=${samples.length} p50=${percentile(samples, 0.5).toFixed(1)}ms ` +
          `p95=${percentile(samples, 0.95).toFixed(1)}ms`
      );
      if (action === 'click' || action === 'navigate') {
        progress(
          `latency samples ${action}: ${(commandDurationDetails.get(action) || [])
            .map((sample) => `${sample.label}=${sample.duration.toFixed(1)}ms`)
            .join(', ')}`
        );
      }
    }
    await runBrowserActionabilityScenarios(host, origin, command);
    progress('delayed targets, temporary blockers, editable fields and selected-page takeover complete');
    assert.deepEqual(
      BROWSER_ACTIONS.filter((action) => !completedActions.has(action)),
      [],
      'every public Browser Use action must complete through the live bridge'
    );

    // Reclaiming disk is only real if the data is gone after a reload: clearing
    // a live page's storage says nothing about what survived on disk.
    await command({ action: 'navigate', url: `${origin}/root`, background: true, tab: 'clear-probe' });
    await command({
      action: 'evaluate',
      script: 'localStorage.setItem("mixdog-clear-probe", "kept"); localStorage.getItem("mixdog-clear-probe")',
      tab: 'clear-probe',
    });
    const cleared = await host!.browserClearData(['cache', 'siteData', 'cookies']);
    assert.deepEqual(cleared.errors, {}, JSON.stringify(cleared));
    assert.deepEqual([...cleared.cleared].sort(), ['cache', 'cookies', 'siteData']);
    await command({ action: 'navigate', reload: true, tab: 'clear-probe' });
    const probe = await command({
      action: 'evaluate',
      script: 'String(localStorage.getItem("mixdog-clear-probe"))',
      tab: 'clear-probe',
    });
    assert.match(probe.text, /null/, 'site data must not survive a clear');
    progress('browsing data clear removes stored site data');

    progress('integration passed');
    console.log(
      'Browser host integration passed: device emulation and touch, geolocation and extra headers, cookies/storage, visual locate, AX/OOPIF refs and script execution, request/response/WebSocket inspection, request interception, init scripts, performance tracing, download attachment and reporting, document error status, PDF documents, credential challenges and refused addresses, script failure positions, recovery, dialogs, leave guards and blocked-gesture refusal, intercepted file chooser upload, popup tracking, isolation, and queue recovery.'
    );
  } finally {
    for (const response of stalledResponses) response.destroy();
    await host?.dispose();
    if (parent && !parent.isDestroyed()) parent.destroy();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await new Promise<void>((resolve) => frameFixture.close(() => resolve()));
    await new Promise<void>((resolve) => socketFixture.close(() => resolve()));
  }
}

// Chromium can hold profile files briefly after the host closes; retry so the
// profile does not stay behind, and never let cleanup change the verdict.
async function removeProfile() {
  await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {
    /* a still-held file leaves the disposable profile for the OS temp cleanup */
  });
}

progress('waiting for Electron ready');
void app
  .whenReady()
  .then(async () => {
    progress('Electron ready');
    await run();
    await removeProfile();
    app.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await removeProfile();
    process.exitCode = 1;
    app.exit(1);
  });
