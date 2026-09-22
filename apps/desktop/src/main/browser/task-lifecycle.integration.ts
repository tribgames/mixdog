/**
 * Task-owned tab lifecycle over the live bridge: hidden work never reveals
 * the dock, finishing a turn leaves its page hidden instead of creating an
 * empty foreground one, a temporary reveal is restored, and an explicit open
 * hands the page to the user. Every command here carries its own session and
 * turn id.
 */
import assert from 'node:assert/strict';
import type { WebContents } from 'electron';
import type { DesktopBrowserOpenRequest } from '../../shared/contract';

export async function runBrowserTaskLifecycleScenarios(options: {
  command(input: Record<string, unknown>): Promise<{ text: string }>;
  origin: string;
  browserSurfaceRequests: DesktopBrowserOpenRequest[];
  visibleGuest: WebContents;
  progress(message: string): void;
}): Promise<void> {
  const { command, origin, browserSurfaceRequests, visibleGuest, progress } = options;
  const taskSession = 'browser-task-lifecycle';
  const hiddenStart = browserSurfaceRequests.length;
  await command({
    action: 'navigate',
    url: `${origin}/root?task=hidden`,
    background: true,
    tab: 'scratch',
    session_id: taskSession,
    turn_id: 1,
  });
  await command({
    action: 'click',
    target: { role: 'button', name: 'Update SPA' },
    tab: 'scratch',
    session_id: taskSession,
    turn_id: 1,
  });
  await command({ action: 'read', tab: 'scratch', session_id: taskSession, turn_id: 1 });
  assert.equal(browserSurfaceRequests.length, hiddenStart, 'follow-up background work never reveals the dock');
  await command({ action: 'finish_turn', session_id: taskSession, turn_id: 1 });
  // A finished turn is not a finished conversation: the page the turn opened
  // survives cleanup, still hidden and still named. Cleanup adds no tab of its
  // own and promotes nothing to the visible slot.
  const [cleanupHeading, ...cleanupTabs] = (
    await command({ action: 'list_tabs', session_id: taskSession })
  ).text.split('\n');
  assert.equal(cleanupHeading, 'Tabs:');
  assert.equal(cleanupTabs.length, 1, 'cleanup keeps the hidden page and lists no other tab');
  assert.equal(
    cleanupTabs[0].replace(/^- p\d+ /, ''),
    `["scratch"] (background): Root fixture — ${origin}/root?task=hidden`
  );
  assert.equal(browserSurfaceRequests.length, hiddenStart, 'cleanup never creates an empty foreground page');

  await command({
    action: 'navigate',
    url: `${origin}/root?task=temporary`,
    background: true,
    tab: 'scratch',
    session_id: taskSession,
    turn_id: 2,
  });
  await command({ action: 'read', background: false, tab: 'scratch', session_id: taskSession, turn_id: 2 });
  await command({ action: 'finish_turn', session_id: taskSession, turn_id: 2 });
  assert.deepEqual(browserSurfaceRequests.splice(hiddenStart), [
    { sessionId: taskSession, temporaryTurnId: 2 },
    { sessionId: taskSession, restoreTurnId: 2 },
  ]);
  await command({
    action: 'navigate',
    url: `${origin}/root?task=handoff`,
    background: true,
    tab: 'result',
    session_id: taskSession,
    turn_id: 3,
  });
  await command({ action: 'open', tab: 'result', session_id: taskSession, turn_id: 3 });
  await command({ action: 'finish_turn', session_id: taskSession, turn_id: 3 });
  assert.match((await command({ action: 'list_tabs', session_id: taskSession })).text, /task=handoff/);
  assert.deepEqual(browserSurfaceRequests.splice(hiddenStart), [{ sessionId: taskSession, reveal: true }]);
  assert.equal(visibleGuest.isDestroyed(), false, 'pre-existing user page remains alive');
  await command({ action: 'close_tab', tab: 'result', session_id: taskSession });
  // The page kept across turns stays a closable background tab, and the shared
  // background-tab budget goes back to the later scenarios.
  assert.equal(
    (await command({ action: 'close_tab', tab: 'scratch', session_id: taskSession })).text,
    'Closed background tab "scratch".'
  );
  progress('task background isolation, cleanup, panel restoration and user handoff complete');
}
