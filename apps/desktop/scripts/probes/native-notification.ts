import assert from 'node:assert/strict';
import { app, BrowserWindow, Notification } from 'electron';
import { createDesktopTurnNotifier } from '../../src/main/desktop-turn-notifier';
import { sessionFinalAnswer } from '../../src/main/session-final-answer';
import { openDesktopNotificationSession } from '../../src/main/notification-window';
import { desktopIdentity } from '../../src/main/desktop-identity';

// Do not await app readiness at module top level: Electron loads the ESM
// entry before it emits ready, so a top-level await would deadlock boot.
async function main() {
  const { appId, name } = desktopIdentity('probe');
  app.setName(name);
  app.setAppUserModelId(appId);
  await app.whenReady();
  const preload = process.argv
    .find((argument) => argument.startsWith('--probe-preload='))
    ?.slice('--probe-preload='.length);
  assert.ok(preload);
  const icon = process.argv.find((argument) => argument.startsWith('--probe-icon='))?.slice('--probe-icon='.length);
  assert.ok(icon);
  const window = new BrowserWindow({
    title: 'Mixdog 알림 클릭 검증',
    icon,
    show: false,
    width: 500,
    height: 200,
    webPreferences: { preload, contextIsolation: true, sandbox: true },
  });
  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><title>Mixdog 알림 클릭 검증</title><body>알림 클릭 대기</body>')}`
  );
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let foreground = false;
  let delivered = 0;
  let failed = false;
  let opened = false;
  let focusedOnOpen = false;
  window.webContents.on('ipc-message', (_event, channel, id) => {
    if (channel !== 'notification-probe-opened') return;
    assert.equal(id, 'notification-probe');
    opened = true;
    focusedOnOpen = window.isFocused() && window.isVisible() && !window.isMinimized();
    console.log(JSON.stringify({ event: 'session-opened', sessionId: id, focused: focusedOnOpen }));
  });
  let answerAt = Date.now();
  const events: string[] = [];
  const notifier = createDesktopTurnNotifier({
    isEnabled: () => true,
    isSupported: () => Notification.isSupported(),
    isForeground: () => foreground,
    readFinalAnswer: async (_id, since) =>
      sessionFinalAnswer(
        {
          busy: false,
          // The rows a stored assistant answer with a done completion restores to (Node's restoreTranscriptItems).
          items: [
            {
              kind: 'assistant',
              id: 'hist_session_0_1',
              text: '**백그라운드 작업 완료** — [결과 확인](https://example.com). `file.ts` 검사 통과.',
              at: answerAt,
            },
            {
              kind: 'turndone',
              id: 'hist_session_0_2',
              status: 'done',
              elapsedMs: 1_000,
              finalAssistantId: 'hist_session_0_1',
              at: answerAt,
            },
          ],
        } as Parameters<typeof sessionFinalAnswer>[0],
        since
      ),
    createNotification: (content) =>
      new Notification({
        ...content,
        ...(process.platform === 'win32' ? {} : { icon }),
      }),
    openSession: (id) => {
      assert.equal(id, 'notification-probe');
      assert.equal(openDesktopNotificationSession(window, id), true);
    },
    diagnostic: (event, details) => {
      events.push(event);
      if (event === 'os-show') delivered++;
      if (event === 'failed') failed = true;
      console.log(JSON.stringify({ at: new Date().toISOString(), appId, event, ...details }));
    },
  });
  const row = { id: 'notification-probe', title: 'Mixdog 완료 알림 검증' };
  const finish = () => {
    notifier.onSessions([{ ...row, working: true } as never]);
    answerAt = Date.now();
    notifier.onSessions([row as never]);
  };

  try {
    // Deterministic foreground policy without stealing the user's focus.
    foreground = true;
    finish();
    await delay(3_000);
    assert.equal(delivered, 0);
    assert.ok(events.includes('suppressed'));
    foreground = false;
    console.log('BACKGROUND_PROBE_ARMED: native completion will be submitted after the quiet period.');
    finish();
    await delay(3_000);
    assert.equal(failed, false, 'Native notification failed; inspect the diagnostic above.');
    assert.equal(delivered, 1, 'No Electron show callback; this is not a successful OS delivery.');
    notifier.onSessions([row as never]);
    console.log('OS_ACCEPTED: verify the actual banner visually; this callback alone is NOT banner evidence.');
    await delay(35_000);
    assert.equal(delivered, 1, 'Repeated idle state must not deliver again.');
    if (opened) assert.equal(focusedOnOpen, true, 'The clicked notification did not focus its window.');
    console.log(JSON.stringify({ result: 'native-delivery-complete', delivered, opened, focusedOnOpen }));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    notifier.dispose();
    window.destroy();
    app.quit();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  app.quit();
});
