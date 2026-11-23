// A session pane's transcript as the pane mounts it (rows, their renderer and the changed-files card), and the frames a
// user sees as the pane renders one state after another.
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-dom.mjs';
import { TurnChangesContext } from '../TurnChangesCard.tsx';
import { resetTurnChangesCache } from '../turn-changes-model.ts';
import { resetTurnPreviews, runningTurnKeyOf } from '../turn-preview-model.ts';
import { trailingTurnRuns, useConversationLinkSurfaces } from '../use-conversation-link-surfaces.ts';
import { useConversationRowRenderer } from '../use-conversation-row-renderer.ts';
import { useTranscriptRows } from '../use-conversation-rows.ts';

const h = React.createElement;

/** Mounts a pane over `props` (`items`, `busy`, `liveItem`, `steerItems`, `pendingItems`, `activityAt`, `questionCard`).
 *  The record of a turn's changes answers `pending` until `view.sealed`. Every render is kept as a frame. */
export async function mountTranscriptPane(t) {
  resetTurnChangesCache();
  resetTurnPreviews();
  const { dom, document, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent'],
    rootId: 'root',
  });
  const view = { sealed: true, reads: 0, rows: [], frames: [], document };
  // The reads a render started and the pane has not been answered yet.
  const reading = new Set();
  const answer = async (request) => {
    if (request.capability !== 'getTurnChanges') return { value: null };
    view.reads += 1;
    const checkpointId = request.args[0].checkpointId;
    const file = { path: 'src/a.ts', status: 'M', additions: 2, deletions: 1, state: 'applied', revertable: true };
    return {
      value: {
        status: view.sealed ? 'ready' : 'pending',
        checkpointId,
        revision: 1,
        root: 'C:/Project/app',
        files: view.sealed ? [file] : [],
        canUndo: true,
        canReapply: false,
      },
    };
  };
  dom.window.mixdogDesktop = {
    invokeCapability(request) {
      const read = answer(request);
      reading.add(read);
      return read.finally(() => reading.delete(read));
    },
  };
  /** Every read the pane started is answered, and what it drew from the answer is committed. */
  const settle = async () => {
    do await act(async () => void (await Promise.all(reading)));
    while (reading.size > 0);
  };
  function Pane({
    items,
    busy = false,
    liveItem = null,
    activityAt = 0,
    steerItems = [],
    pendingItems = [],
    questionCard = null,
    failedTurnKeys = [],
  }) {
    const { transcriptRows, settledTurnKeys, turnPastEnd, pastLastEnd } = useTranscriptRows({
      identity: 's1',
      sessionKey: 's1',
      settledItems: items,
      settledRowItems: items,
      failedTurnKeys,
      precomputedTurnKeys: null,
      pendingItems,
      steerItems,
      liveItem,
      busy,
      commandBusy: false,
      commandActivityVisible: activityAt > 0,
      commandActivityStartedAt: activityAt,
      optimisticActivityStartedAt: 0,
    });
    const links = useConversationLinkSurfaces(
      {},
      {
        turnChangesSessionId: 's1',
        turnChangesBusy: busy,
        turnChangesRunning: trailingTurnRuns(busy, 0, pastLastEnd),
        runningTurnKey: trailingTurnRuns(busy, 0, turnPastEnd)
          ? runningTurnKeyOf(items, settledTurnKeys, settledTurnKeys.at(-1) ?? '')
          : '',
      }
    );
    const { renderTranscriptRow } = useConversationRowRenderer({
      snapshot: { sessionId: 's1', busy },
      disclosureScope: 's1',
      readOnly: false,
      transitioning: false,
      onOpenSettings() {},
      settledItems: items,
      settledTurnKeys,
      optimisticActivityStartedAt: 0,
      submit: async () => true,
      questionCard,
      agentMode: false,
    });
    view.rows = transcriptRows;
    return h(
      TurnChangesContext.Provider,
      { value: links.turnChangesSurface },
      transcriptRows.map((row, index) =>
        h('div', { key: row.key, 'data-row-key': row.key }, renderTranscriptRow(row, index, transcriptRows))
      )
    );
  }
  view.root = root;
  view.render = async (props) => {
    await act(async () => root.render(h(Pane, props)));
    await settle();
    view.frames.push(view.frame());
  };
  /** What the user sees now: each row's tag, key and drawn text. */
  view.frame = () => {
    const nodes = new Map([...document.querySelectorAll('[data-row-key]')].map((node) => [node.dataset.rowKey, node]));
    return view.rows.map((row) => ({
      tag: row._tag,
      key: row.key,
      text: (nodes.get(row.key)?.textContent || '').replace(/\s+/g, ' ').trim(),
    }));
  };
  view.tags = () => view.rows.map((row) => row._tag);
  view.text = () => (document.getElementById('root')?.textContent || '').replace(/\s+/g, ' ').trim();
  view.cards = () => document.querySelectorAll('.turn-changes-card').length;
  view.status = (selector = '.turn-status') => [...document.querySelectorAll(selector)].map((node) => node.className);
  return view;
}

/** The content rows: a message, a reply, a tool group, an error. The band and gaps come and go with the turn. */
const CONTENT = new Set(['UserMessage', 'AssistantPart', 'ToolActivity', 'Error']);

/** The frames a user saw in order hold every row once, keep the order of the rows two frames share, and never drop a
 *  content row (one that comes back later, or for good). `allowedGone`: keys a frame may lose for good. */
export function assertSteadyFrames(frames, { allowedGone = [] } = {}) {
  frames.forEach((frame, at) => {
    const keys = frame.map((row) => row.key);
    assert.equal(new Set(keys).size, keys.length, `frame ${at}: a row is drawn twice: ${keys.join(', ')}`);
  });
  for (let at = 1; at < frames.length; at += 1) {
    const before = frames[at - 1].map((row) => row.key);
    const now = frames[at].map((row) => row.key);
    const shared = now.filter((key) => before.includes(key));
    assert.deepEqual(
      shared,
      before.filter((key) => now.includes(key)),
      `frame ${at}: rows changed places: ${before.join(', ')} -> ${now.join(', ')}`
    );
    for (const row of frames[at - 1]) {
      if (now.includes(row.key) || allowedGone.includes(row.key)) continue;
      const back = frames.slice(at + 1).some((frame) => frame.some((later) => later.key === row.key));
      assert.ok(!back, `frame ${at}: row ${row.key} disappears and comes back`);
      assert.ok(!CONTENT.has(row.tag), `frame ${at}: ${row.tag} ${row.key} disappears`);
    }
  }
}
