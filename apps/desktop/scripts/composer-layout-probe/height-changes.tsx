import { useRef } from 'react';
import { flushSync } from 'react-dom';
import type { Root } from 'react-dom/client';
import { ComposerDock } from '../../src/renderer/ComposerDock';
import { ComposerBanners } from '../../src/renderer/ComposerBanners';
import { AttachmentChips } from '../../src/renderer/composer-surfaces';
import { QueueList } from '../../src/renderer/composer-support';
import { ApprovalCard } from '../../src/renderer/ApprovalCard';
import { SessionGoalIsland } from '../../src/renderer/SessionGoalIsland';
import { TranscriptList } from '../../src/renderer/TranscriptList';
import { useTranscriptFollow } from '../../src/renderer/use-transcript-follow';
import type { TranscriptRowModel } from '../../src/renderer/transcript-rows';
import { frame, waitFor } from './probe-support';

const noop = () => {};
type State = {
  width: number;
  height: number;
  count: number;
  prompt: string;
  approval: boolean;
  context: boolean;
  goal: boolean;
  attachments: boolean;
  queue: boolean;
};

function Harness({ state, session }: { state: State; session: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scrollToEndRef = useRef(noop);
  const setAnchorBottomRef = useRef<(bottom: boolean) => void>(noop);
  const follow = useTranscriptFollow({ viewport, content, sessionKey: session, scrollToEndRef, setAnchorBottomRef });
  const rows = useRef<TranscriptRowModel[]>(
    Array.from({ length: state.count }, (_, index) => ({
      _tag: 'UserMessage',
      key: `${session}-${index}`,
      turnKey: 'history',
      item: { kind: 'user', id: index, text: `History ${index}. A line that wraps when the pane gets narrow.` },
      attachedUser: false,
    }))
  );
  return (
    <section className="conversation" style={{ height: state.height, width: state.width, margin: 20 }}>
      <div className="transcript-shell">
        <div
          className="transcript"
          ref={viewport}
          data-following={follow.following}
          onScroll={follow.handleScroll}
          onWheel={follow.handleWheel}
          onTouchStart={follow.handleTouchStart}
          onTouchMove={follow.handleTouchMove}
          onTouchEnd={follow.handleTouchEnd}
        >
          <div className="thread">
            <TranscriptList
              sessionKey={session}
              rows={rows.current}
              viewport={viewport}
              content={content}
              shouldAnchorBottom={follow.following}
              scrollToEndRef={scrollToEndRef}
              setAnchorBottomRef={setAnchorBottomRef}
              hasScrollGesture={follow.hasScrollGesture}
              markProgrammaticScroll={follow.markProgrammaticScroll}
              onSelectionAutoScroll={follow.handleSelectionAutoScroll}
              renderRow={(row) => <div className="message-body">{row._tag === 'UserMessage' ? row.item.text : ''}</div>}
            />
          </div>
        </div>
      </div>
      <ComposerDock
        goalSubmissionId=""
        showProjectSelector={state.context}
        contextBar={<button type="button">Project / workflow</button>}
        goalIsland={
          <SessionGoalIsland snapshot={{ sessionId: session, goal: state.goal ? {
            id: 'height-goal', status: 'active', title: 'Height goal', tasks: [],
          } : null }} />
        }
        approval={state.approval ? <ApprovalCard approval={{
          id: 'approval', name: 'shell', reason: 'Review this request', args: { command: 'echo approved' },
        }} resolve={async () => true} /> : null}
        reviewItems={[]}
        reviewActive={false}
        reviewBusy={false}
        reviewSessionId={session}
        reviewCwd=""
      >
        <QueueList queued={state.queue ? [{ id: 'queued', text: 'A queued follow-up' }] : []}
          restoring={false} onEdit={noop} onSteer={noop} onRemove={noop} />
        <ComposerBanners draggingFiles={false} transitioning={false} dropTarget={null} />
        <form className="composer">
          {state.attachments && <AttachmentChips attachments={[{
            id: 1, name: 'notes.txt', kind: 'text', mimeType: 'text/plain', data: 'bm90ZXM=', bytes: 5,
          }]} onRemove={noop} onError={noop} />}
          <div className="composer-input-row"><textarea value={state.prompt} readOnly rows={1} /></div>
          <div className="composer-footer" />
        </form>
      </ComposerDock>
    </section>
  );
}

function geometry() {
  const viewport = document.querySelector<HTMLElement>('.transcript')!;
  const rect = viewport.getBoundingClientRect();
  return {
    height: rect.height,
    top: viewport.scrollTop,
    gap: Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop),
    rows: [...viewport.querySelectorAll<HTMLElement>('.transcript-virtual-row')].map((row) => {
      const box = row.getBoundingClientRect();
      return { key: row.dataset.timelineKey!, top: box.top, visible: box.bottom > rect.top && box.top < rect.bottom };
    }),
  };
}

export async function runHeightChangesProbe(root: Root) {
  const failures: string[] = [];
  const cases: { name: string; maxGap: number; maxDrift: number }[] = [];
  for (const width of [620, 360]) {
    for (const count of [3, 80]) {
      for (const reading of count === 3 ? [false] : [false, true]) {
        const session = `height-${width}-${count}-${reading ? 'reader' : 'tail'}`;
        let state: State = {
          width, height: 680, count, prompt: '', approval: false, context: false, goal: false,
          attachments: false, queue: false,
        };
        const render = () => flushSync(() => root.render(<Harness key={session} state={state} session={session} />));
        render();
        await waitFor(() => geometry().gap <= 1, `${session} initial pin`);
        for (let n = 0; n < 4; n++) await frame();
        const viewport = document.querySelector<HTMLElement>('.transcript')!;
        if (reading) {
          viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true }));
          viewport.scrollTop -= 240;
          viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
          await frame();
        }
        const steps: [string, Partial<State>][] = [
          ['input-grow', { prompt: 'First\nSecond\nThird\nFourth' }],
          ['input-shrink', { prompt: '' }],
          ['input-max', { prompt: 'Line\n'.repeat(20) }],
          ['input-clear', { prompt: '' }],
          ['approval-open', { approval: true }],
          ['approval-close', { approval: false }],
          ['context-open', { context: true }],
          ['draft-promotion', { context: false }],
          ['attachment-add', { attachments: true }],
          ['attachment-remove', { attachments: false }],
          ['queue-add', { queue: true }],
          ['queue-remove', { queue: false }],
          ['goal-open', { goal: true }],
          ['goal-close', { goal: false }],
          ['keyboard-or-panel-open', { height: 420 }],
          ['keyboard-or-panel-close', { height: 680 }],
          ['pane-narrow', { width: 320 }],
          ['pane-restore', { width }],
          ['combined-grow', { prompt: 'One\nTwo\nThree', queue: true, attachments: true, context: true }],
          ['combined-submit', { prompt: '', queue: false, attachments: false, context: false }],
        ];
        for (const [label, change] of steps) {
          const name = `${session}/${label}`;
          const anchor = geometry().rows.find((row) => row.visible);
          state = { ...state, ...change };
          render();
          const frames = [];
          for (let n = 0; n < 12; n++) {
            await frame();
            frames.push(geometry());
          }
          const last = frames.at(-1)!;
          const maxGap = Math.max(...frames.map((item) => item.gap));
          const finalRows = new Map(last.rows.map((row) => [row.key, row.top]));
          const maxDrift = Math.max(0, ...frames.flatMap((item) => item.rows
            .filter((row) => row.visible && finalRows.has(row.key))
            .map((row) => Math.abs(row.top - finalRows.get(row.key)!))));
          if (!reading && maxGap > 1) failures.push(`${name}: tail gap ${maxGap}px`);
          if (maxDrift > 1) failures.push(`${name}: rows move after first paint ${maxDrift}px`);
          if (frames.some((item) => Math.abs(item.height - last.height) > 1)) {
            failures.push(`${name}: viewport height changes after first paint`);
          }
          if (reading && anchor) {
            const after = last.rows.find((row) => row.key === anchor.key);
            if (!after || Math.abs(after.top - anchor.top) > 1) failures.push(`${name}: reading anchor moved`);
          }
          cases.push({ name, maxGap, maxDrift });
        }
        if (count === 80 && !reading) {
          // A downward wheel leaves follow armed but owns native motion. A
          // concurrent viewport step must wait, then pin without another edit.
          const before = viewport.scrollTop;
          viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true }));
          state = { ...state, height: 420 };
          render();
          await frame();
          if (viewport.scrollTop !== before) failures.push(`${session}/gesture-resize: interrupted native gesture`);
          await waitFor(() => geometry().gap <= 1, `${session} gesture idle pin`);
          cases.push({ name: `${session}/gesture-resize`, maxGap: geometry().gap, maxDrift: 0 });
          state = { ...state, height: 680 };
          render();
          for (let n = 0; n < 3; n++) await frame();
          const touch = (type: string, clientY: number) => {
            const point = new Touch({ identifier: 1, target: viewport, clientX: 40, clientY });
            viewport.dispatchEvent(new TouchEvent(type, {
              bubbles: true,
              touches: type === 'touchend' ? [] : [point],
              changedTouches: [point],
            }));
          };
          const heldTop = viewport.scrollTop;
          touch('touchstart', 120);
          touch('touchmove', 90);
          state = { ...state, height: 420 };
          render();
          // Hold longer than the wheel-intent window: a finger still on the
          // glass, not just the initial touchmove, must own the viewport.
          for (let n = 0; n < 24; n++) await frame();
          if (viewport.scrollTop !== heldTop) failures.push(`${session}/touch-resize: moved under held finger`);
          touch('touchend', 90);
          for (let n = 0; n < 4; n++) {
            const nativeTop = viewport.scrollTop + 4;
            viewport.scrollTop = nativeTop;
            viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
            await frame();
            if (viewport.scrollTop !== nativeTop) failures.push(`${session}/touch-resize: interrupted fling`);
          }
          await waitFor(() => geometry().gap <= 1, `${session} touch idle pin`);
          cases.push({ name: `${session}/touch-resize`, maxGap: geometry().gap, maxDrift: 0 });
        }
        flushSync(() => root.render(null));
      }
    }
  }
  return { failures, cases };
}
