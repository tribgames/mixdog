import { type RefObject, useEffect } from 'react';
import {
  canScroll,
  distanceFromBottom,
  grewWhileAtBottom,
  scrollMetrics,
  TRANSCRIPT_OVERFLOW_ANCHOR,
  transcriptScrollDeviation,
} from './transcript-follow-rules';

/** Watches the viewport and content boxes to keep follow intent and the
 *  growth baselines current. */
export function useFollowContentObserver({
  viewport,
  content,
  contentMounted,
  sessionKey,
  following,
  followingRef,
  lastScrollHeight,
  lastDistance,
  readerScrolling,
  isProgrammatic,
  publish,
  scheduleScrollState,
  scrollToBottom,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
  contentMounted: boolean;
  sessionKey: string;
  following: boolean;
  followingRef: RefObject<boolean>;
  lastScrollHeight: { current: number };
  lastDistance: { current: number };
  /** A wheel, touch, fling or touch hold still owns the viewport. */
  readerScrolling(): boolean;
  isProgrammatic(top: number): boolean;
  publish(next: boolean): void;
  scheduleScrollState(element: HTMLDivElement): void;
  scrollToBottom(force: boolean): void;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentMounted, following and sessionKey are re-attach triggers (a fresh observer re-seeds the baselines) though the body reads following through followingRef
  useEffect(() => {
    const target = content.current;
    const element = viewport.current;
    if (!target || !element) return undefined;
    // Virtual-core owns every measured-size correction. Browser anchoring must
    // stay off after follow releases too; otherwise both authorities compensate
    // the same above-viewport resize and reverse each other during upward
    // wheel, touch, and scrollbar motion.
    element.style.overflowAnchor = TRANSCRIPT_OVERFLOW_ANCHOR;
    // Chromium always provides ResizeObserver. The renderer's jsdom harness
    // intentionally omits it in tests that do not exercise layout delivery.
    if (typeof ResizeObserver !== 'function') return undefined;
    const seed = scrollMetrics(element);
    let viewportHeight = Math.round(seed.viewportHeight);
    // Seed the growth baseline with the height already on screen so the first
    // observation cannot report the whole transcript as this commit's growth.
    lastScrollHeight.current = seed.maxScrollTop + seed.viewportHeight;
    lastDistance.current = distanceFromBottom(seed);
    // A fresh observer delivers the CURRENT box of every target it starts
    // watching — that first callback is an attach report, not a mutation. This
    // effect re-runs on every follow flip, so writing on it re-pinned the tail
    // one frame after the reader had released it (user: 위로 올려도 다시
    // 내려온다). The attach delivery may only seed the baselines.
    let attachDelivery = true;
    const observer = new ResizeObserver((entries) => {
      const root = viewport.current;
      if (!root) return;
      scheduleScrollState(root);
      // The viewport's own box, when this delivery carries it, is the freshest
      // height; otherwise the last one observed still holds.
      const box = entries.find((entry) => entry.target === root)?.borderBoxSize?.[0];
      const height = box ? Math.round(box.blockSize) : viewportHeight;
      const metrics = scrollMetrics(root, height);
      const viewportHeightChanged = height !== viewportHeight;
      viewportHeight = height;
      const scrollHeight = metrics.maxScrollTop + metrics.viewportHeight;
      const growth = scrollHeight - lastScrollHeight.current;
      lastScrollHeight.current = scrollHeight;
      const distance = distanceFromBottom(metrics);
      // The pre-mutation snapshot: the distance left by the last event that
      // was NOT this content mutation.
      const distanceBefore = lastDistance.current;
      lastDistance.current = distance;
      // Auto-scroll rule: a transcript that no longer
      // OVERFLOWS holds no reading position, so it re-arms follow. The CONTENT
      // side of that rule is driven by the rows commit in Conversation, not by
      // a second observer here — virtual-core stays the only content-growth
      // scroll authority.
      if (!canScroll(metrics)) {
        if (!followingRef.current) publish(true);
        return;
      }
      if (attachDelivery) {
        attachDelivery = false;
        return;
      }
      if (!followingRef.current) {
        // A growing commit while the viewport still sat at the previous bottom
        // means
        // the reader never left the tail, so the flag is restored and the new
        // bottom is taken. A turn that opens with a tool card and no preamble
        // lands its whole card in one commit, which is precisely the case the
        // after-the-fact 10px band could never recognise.
        if (viewportHeightChanged) return;
        // A growth the virtual core compensated itself — a row ABOVE the
        // reading offset resolving from its estimate — lands with the offset
        // sitting on the core's own corrective write. That is the timeline
        // holding the reader still, never the reader arriving at the tail.
        if (isProgrammatic(metrics.top - transcriptScrollDeviation(root))) return;
        // Nor is a frame the reader is still scrolling through: the wheel
        // that just released follow is still animating its notch, and a
        // reader arriving at the end re-attaches once their scroll settles.
        if (readerScrolling()) return;
        if (grewWhileAtBottom({ distanceBefore, growth })) {
          publish(true);
          scrollToBottom(false);
        }
        return;
      }
      // Both viewport resizing and content growth are pinned by the timeline
      // after its geometry is current, never by a second observer here.
    });
    // This observer only maintains follow intent and its growth baseline.
    observer.observe(element);
    observer.observe(target);
    return () => observer.disconnect();
  }, [
    content,
    contentMounted,
    following,
    followingRef,
    readerScrolling,
    isProgrammatic,
    lastDistance,
    lastScrollHeight,
    publish,
    scheduleScrollState,
    scrollToBottom,
    sessionKey,
    viewport,
  ]);
}
