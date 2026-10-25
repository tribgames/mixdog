/**
 * Task-owned tab lifecycle over the live bridge: no agent work but `open`
 * opens the dock, finishing a turn leaves its page hidden instead of creating
 * an empty foreground one, an explicit open keeps the page for the user, and
 * closing the session's last page folds the panel. Every command here carries
 * its own session and turn id.
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
  const [cleanupHeading, ...cleanupTabs] = (await command({ action: 'list_tabs', session_id: taskSession })).text.split(
    '\n'
  );
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
  assert.deepEqual(browserSurfaceRequests.splice(hiddenStart), [], 'foreground work never opens the panel');
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
  // Only `open` asks for the panel, naming the page it shows; the turn's end
  // keeps that page and asks for nothing more.
  const reveals = browserSurfaceRequests.splice(hiddenStart);
  assert.deepEqual(
    reveals.map(({ sessionId, reveal, tabId }) => ({ sessionId, reveal, page: /^p\d+$/.test(String(tabId)) })),
    [{ sessionId: taskSession, reveal: true, page: true }],
    'open reveals its page; finishing the turn keeps it'
  );
  assert.equal(visibleGuest.isDestroyed(), false, 'pre-existing user page remains alive');
  await command({ action: 'close_tab', tab: 'result', session_id: taskSession });
  assert.deepEqual(browserSurfaceRequests.splice(hiddenStart), [], 'a page is left, so the panel stays');
  // The page kept across turns stays a closable background tab, and the shared
  // background-tab budget goes back to the later scenarios.
  assert.equal(
    (await command({ action: 'close_tab', tab: 'scratch', session_id: taskSession })).text,
    'Closed background tab "scratch".'
  );
  // With the session's last page gone its panel folds instead of showing a blank page.
  assert.deepEqual(
    browserSurfaceRequests.splice(hiddenStart),
    [{ sessionId: taskSession, hide: true }],
    'closing the last page folds the panel'
  );
  progress('task background isolation, cleanup, closed panel and user handoff complete');
}
