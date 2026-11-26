// A session pane's transcript as the pane mounts it (rows, their renderer and the changed-files card), and the frames a
// user sees as the pane renders one state after another.
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-dom.mjs';
import { MarkdownProjectContext } from '../MarkdownLink.tsx';
import { TurnChangesContext, TurnRowsContext } from '../TurnChangesCard.tsx';
import { resetTurnChangesCache } from '../turn-changes-model.ts';
import { resetTurnPreviews, runningTurnKeyOf } from '../turn-preview-model.ts';
import { trailingTurnRuns, useConversationLinkSurfaces } from '../use-conversation-link-surfaces.ts';
import { useConversationRowRenderer } from '../use-conversation-row-renderer.ts';
import { releaseTranscriptRowLifecycle, useTranscriptRows } from '../use-conversation-rows.ts';

const h = React.createElement;

/** Mounts a pane over `props` (`items`, `busy`, `liveItem`, `steerItems`, `pendingItems`, `activityAt`, `questionCard`).
 *  The record of a turn's changes answers `pending` until `view.sealed`. Every render is kept as a frame. */
export async function mountTranscriptPane(t) {
  resetTurnChangesCache();
  resetTurnPreviews();
  releaseTranscriptRowLifecycle('s1');
  t.after(() => releaseTranscriptRowLifecycle('s1'));
  const { dom, document, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent'],
    rootId: 'root',
  });
  const defaultFiles = [
    { path: 'src/a.ts', status: 'M', additions: 2, deletions: 1, state: 'applied', revertable: true },
  ];
  const heldResolvers = [];
  const view = {
    sealed: true,
    holdReads: false,
    failReads: null,
    files: defaultFiles,
    rootDir: 'C:/Project/app',
    reads: 0,
    read: [],
    rows: [],
    frames: [],
    document,
    dom,
  };
  // The reads a render started and the pane has not been answered yet.
  const reading = new Set();
  const answer = async (request) => {
    if (request.capability !== 'getTurnChanges') return { value: null };
    view.reads += 1;
    const checkpointId = request.args[0].checkpointId;
    view.read.push(checkpointId);
    if (view.holdReads) {
      await new Promise((resolve) => heldResolvers.push(resolve));
    }
    if (view.failReads) {
      const failure = typeof view.failReads === 'function' ? view.failReads(checkpointId) : view.failReads;
      if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
    }
    const files = typeof view.files === 'function' ? view.files(checkpointId) : view.files;
    return {
      value: {
        status: view.sealed ? 'ready' : 'pending',
        checkpointId,
        revision: 1,
        root: view.rootDir,
        files: view.sealed ? files : [],
        canUndo: true,
        canReapply: false,
      },
    };
  };
  dom.window.mixdogDesktop = {
    invokeCapability(request) {
      const read = answer(request);
      const tracked = read.then(
        () => undefined,
        () => undefined
      );
      reading.add(tracked);
      tracked.finally(() => reading.delete(tracked));
      return read;
    },
    visualizeCommand: async () => undefined,
  };
  /** Every read the pane started is answered, and what it drew from the answer is committed. */
  const settle = async () => {
    do await act(async () => void (await Promise.all(reading)));
    while (reading.size > 0);
  };
  view.settleReads = settle;
  view.releaseReads = async () => {
    const queued = heldResolvers.splice(0);
    for (const resolve of queued) resolve();
    await settle();
  };
  function Pane({
    items,
    busy = false,
    shellJobs,
    agentWorkers,
    agentJobs,
    liveItem = null,
    activityAt = 0,
    steerItems = [],
    pendingItems = [],
    questionCard = null,
    failedTurnKeys = [],
  }) {
    const { transcriptRows, settledTurnKeys, turnPastEnd, trailingTurnRunning, trailingCheckpointShown } =
      useTranscriptRows({
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
        turnChangesRunning: trailingTurnRunning,
        trailingCheckpointShown,
        runningTurnKey: trailingTurnRuns(busy, 0, turnPastEnd)
          ? runningTurnKeyOf(items, settledTurnKeys, settledTurnKeys.at(-1) ?? '')
          : '',
      }
    );
    const { renderTranscriptRow } = useConversationRowRenderer({
      snapshot: {
        sessionId: 's1',
        busy,
        ...(shellJobs ? { shellJobs } : {}),
        ...(agentWorkers ? { agentWorkers } : {}),
        ...(agentJobs ? { agentJobs } : {}),
      },
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
    const rowsOf = () => view.rows;
    return h(
      MarkdownProjectContext.Provider,
      { value: view.rootDir },
      h(
        TurnChangesContext.Provider,
        { value: links.turnChangesSurface },
        h(
          TurnRowsContext.Provider,
          { value: rowsOf },
          transcriptRows.map((row, index) =>
            h('div', { key: row.key, 'data-row-key': row.key }, renderTranscriptRow(row, index, transcriptRows))
          )
        )
      )
    );
  }
  view.root = root;
  view.Pane = Pane;
  view.render = async (props) => {
    await act(async () => root.render(h(Pane, props)));
    if (!view.holdReads) await settle();
    view.frames.push(view.frame());
  };
  view.renderSync = (props) => {
    act(() => {
      root.render(h(Pane, props));
    });
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
  view.card = () => document.querySelector('.turn-changes-card');
  view.cards = () => document.querySelectorAll('.turn-changes-card').length;
  view.visualizeCards = () => document.querySelectorAll('.transcript-visualize-turn').length;
  view.visualizeTiles = () => document.querySelectorAll('.transcript-visualize-tile').length;
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
