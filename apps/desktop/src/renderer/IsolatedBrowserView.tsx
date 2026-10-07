import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createBrowserPageClient, type BrowserPageElement } from './browser-page-client';
import { useBrowserPageInput } from './use-browser-page-input';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { copyTextToClipboard } from './text-format';
import type { DesktopBrowserPageFrame } from '../shared/contract';
import { browserInputNotice } from '../shared/browser-input-policy';
import { browserPageTransition } from './browser-page-recovery';
import { createBrowserDisplayHealth } from './browser-display-health';
import { createBrowserPresentationLoop } from './browser-presentation-loop';
import { createBrowserPixelPresentation } from './browser-pixel-presentation';
import { BrowserPagePrompts } from './BrowserPagePrompts';
import './desktop/browser-isolated-view.css';

/** Metadata cadence while the page draws itself natively. */
const NATIVE_METADATA_INTERVAL_MS = 100;
/** Overlap re-check for shell UI that moves without a DOM change. */
const NATIVE_OVERLAP_FALLBACK_MS = 250;

/** Pixel display: guest events have no DOM path to the shell. When the host
 * presents pages natively (and `native` allows it), the page's own view is
 * shown over this surface instead, falling back to pixels whenever the shell
 * draws anything over it. */
export const IsolatedBrowserView = forwardRef<
  BrowserPageElement,
  {
    sessionId: string;
    active: boolean;
    className?: string;
    native?: boolean;
  }
>(function IsolatedBrowserView({ sessionId, active, className, native = false }, ref) {
  const element = useRef<HTMLDivElement | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const [nativeShown, setNativeShown] = useState(false);
  const nativeShownRef = useRef(false);
  const wakeDisplay = useRef<() => void>(() => {});
  const recheckNative = useRef<() => void>(() => {});
  const image = useRef<HTMLElement | null>(null);
  const pixels = useRef<HTMLDivElement | null>(null);
  const canvasId = useId();
  const keyboard = useRef<HTMLTextAreaElement | null>(null);
  const [frame, setFrame] = useState<DesktopBrowserPageFrame | null>(null);
  const [failure, setFailure] = useState('');
  const [actionFailure, setActionFailure] = useState('');
  const [unconfirmedText, setUnconfirmedText] = useState('');
  const presentation = useMemo(
    () =>
      createBrowserPixelPresentation({
        container: () => pixels.current,
        image,
        canvasId,
        texture: (id, canvas) => {
          const present = window.mixdogDesktop?.browserPresentTexture;
          if (!present) throw new Error('Browser GPU display is unavailable.');
          present(sessionId, id, canvas);
        },
        metadata: setFrame,
      }),
    [sessionId, canvasId]
  );
  const client = useMemo(
    () =>
      createBrowserPageClient({
        api: window.mixdogDesktop!,
        sessionId,
        metadataOnly: () => nativeShownRef.current,
        prepare: presentation.prepare,
        update: presentation.update,
        failure: (message) => setActionFailure(browserInputNotice(message)),
        unconfirmedText: setUnconfirmedText,
        // Only a new deliberate input, begun after the failure, proves recovery.
        recovered: () => setActionFailure(''),
      }),
    [sessionId, presentation]
  );
  useImperativeHandle(ref, () => {
    const node = element.current as BrowserPageElement;
    client.bind(node, () => keyboard.current?.focus({ preventScroll: true }));
    return node;
  }, [client]);
  useEffect(() => {
    client.activate();
    return () => {
      client.dispose();
      window.mixdogDesktop?.browserDiscardTexture?.(sessionId);
    };
  }, [client, sessionId]);
  const input = useBrowserPageInput(client, image, keyboard);

  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    const health = createBrowserDisplayHealth();
    const loop = createBrowserPresentationLoop({
      visible: () => document.visibilityState !== 'hidden',
      now: () => performance.now(),
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancel: (handle) => window.clearTimeout(handle as number),
      interval: () => (nativeShownRef.current ? NATIVE_METADATA_INTERVAL_MS : 1000 / 60),
      async read() {
        await client.poll();
        if (!stopped) {
          health.recovered();
          setFailure('');
        }
      },
      failed(error) {
        const node = element.current;
        setFailure(health.failed(error, Date.now(), `${node?.clientWidth}:${node?.clientHeight}`));
        return browserPageTransition(error, 'capture') ? 1000 / 60 : 1000;
      },
    });
    client.setRefresh(loop.wake);
    wakeDisplay.current = loop.wake;
    document.addEventListener('visibilitychange', loop.wake);
    loop.wake();
    return () => {
      stopped = true;
      loop.stop();
      client.setRefresh(() => {});
      wakeDisplay.current = () => {};
      document.removeEventListener('visibilitychange', loop.wake);
    };
  }, [active, client]);

  // Native presentation follows the surface: its place in the window, the
  // page the session currently shows, and whether the shell draws anything
  // over it. A native page always paints above the shell, so any overlap
  // (menus, suggestions, prompts, notices) parks it and the pixel display
  // takes over until the surface is clear again. The check runs in the next
  // frame after anything that can move or cover the surface — a shell DOM
  // change, a resize, a scroll, a new page frame — never every frame, which
  // at a 165 Hz display alone kept the shell and GPU busy on a static page.
  useEffect(() => {
    const present = window.mixdogDesktop?.browserPresentNative;
    if (!active || !native || !present) return undefined;
    type Rect = { x: number; y: number; width: number; height: number };
    let stopped = false;
    let animation = 0;
    let fallback = 0;
    const mutations = new MutationObserver(() => schedule());
    const resizes = new ResizeObserver(() => schedule());
    const stop = () => {
      stopped = true;
      window.cancelAnimationFrame(animation);
      window.clearInterval(fallback);
      mutations.disconnect();
      resizes.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
      document.removeEventListener('visibilitychange', schedule);
      recheckNative.current = () => {};
    };
    let sent: string | undefined;
    let wanted: { rect: Rect | null } | null = null;
    let inFlight = false;
    const show = (shown: boolean) => {
      if (nativeShownRef.current === shown) return;
      nativeShownRef.current = shown;
      setNativeShown(shown);
      wakeDisplay.current();
    };
    const clearRect = (): Rect | null => {
      const face = surface.current;
      const page = client.frame();
      if (!face || !page || page.dialog || page.fileChooser || document.visibilityState === 'hidden') return null;
      const bounds = face.getBoundingClientRect();
      const left = Math.max(0, bounds.left);
      const top = Math.max(0, bounds.top);
      const right = Math.min(window.innerWidth, bounds.right);
      const bottom = Math.min(window.innerHeight, bounds.bottom);
      if (right - left < 2 || bottom - top < 2) return null;
      for (let row = 0; row < 5; row++) {
        for (let column = 0; column < 5; column++) {
          const hit = document.elementFromPoint(
            left + 1 + ((right - left - 2) * column) / 4,
            top + 1 + ((bottom - top - 2) * row) / 4
          );
          if (!hit || !face.contains(hit)) return null;
        }
      }
      return { x: left, y: top, width: right - left, height: bottom - top };
    };
    const flush = () => {
      if (stopped || inFlight || !wanted) return;
      const { rect } = wanted;
      wanted = null;
      inFlight = true;
      present(sessionId, rect)
        .then(
          (result) => {
            if (stopped) return;
            if (!result.enabled) stop();
            show(result.enabled && result.shown);
          },
          () => {
            if (!stopped) show(false);
          }
        )
        .finally(() => {
          inFlight = false;
          flush();
        });
    };
    const check = () => {
      animation = 0;
      if (stopped) return;
      const rect = clearRect();
      const key = rect ? `${client.frame()?.webContentsId}:${rect.x}:${rect.y}:${rect.width}:${rect.height}` : '';
      if (key === sent) return;
      sent = key;
      wanted = { rect };
      flush();
    };
    function schedule() {
      if (!stopped && !animation) animation = window.requestAnimationFrame(check);
    }
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    if (surface.current) resizes.observe(surface.current);
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    document.addEventListener('visibilitychange', schedule);
    // CSS animations and transitions move shell UI without touching the DOM.
    fallback = window.setInterval(schedule, NATIVE_OVERLAP_FALLBACK_MS);
    recheckNative.current = schedule;
    check();
    return () => {
      stop();
      void present(sessionId, null).catch(() => {});
      nativeShownRef.current = false;
      setNativeShown(false);
    };
  }, [active, native, client, sessionId]);
  // A new page frame (tab switch, page dialog) can change what may be shown.
  useEffect(() => recheckNative.current(), [frame]);

  useEffect(() => {
    const node = element.current;
    // A natively presented page is sized by its presentation rectangle.
    if (!active || !frame?.documentId || !node || nativeShown) return undefined;
    let last = '';
    let timer = 0;
    const resize = () => {
      const width = Math.min(3840, Math.max(1, Math.round(node.clientWidth)));
      const height = Math.min(3840, Math.max(1, Math.round(node.clientHeight)));
      presentation.resize(width, height);
      const key = `${width}:${height}`;
      if (width < 2 || height < 2 || key === last) return;
      last = key;
      client.fire({ type: 'resize', width, height });
    };
    const observer = new ResizeObserver(() => {
      presentation.resize(Math.round(node.clientWidth), Math.round(node.clientHeight));
      window.cancelAnimationFrame(timer);
      timer = window.requestAnimationFrame(resize);
    });
    observer.observe(node);
    resize();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(timer);
    };
  }, [active, client, presentation, frame?.documentId, nativeShown]);
  return (
    <div ref={element} className={`${className || ''} browser-isolated-view`}>
      <div
        ref={surface}
        className="browser-isolated-surface"
        onPointerDown={input.onPointerDown}
        onPointerMove={input.onPointerMove}
        onPointerUp={input.onPointerUp}
        onPointerCancel={input.onPointerCancel}
        onLostPointerCapture={input.onPointerCancel}
        onWheel={input.onWheel}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="browser-isolated-pixels" ref={pixels} />
        <textarea
          ref={keyboard}
          className="browser-isolated-input"
          aria-label={t('Type on page')}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          onKeyDown={input.onKeyDown}
          onInput={input.onInput}
          onPaste={input.onPaste}
          onBlur={input.onBlur}
          onCompositionStart={input.onCompositionStart}
          onCompositionUpdate={input.onCompositionUpdate}
          onCompositionEnd={input.onCompositionEnd}
        />
      </div>
      {frame && (
        <BrowserPagePrompts
          key={`${frame.documentId}:${frame.dialog?.id ?? frame.fileChooser?.id ?? ''}`}
          frame={frame}
          control={client.control}
        />
      )}
      {(failure || actionFailure || unconfirmedText) && (
        <div className="browser-remote-status">
          <ErrorNotice
            errors={[failure, actionFailure]}
            role="status"
            onDismiss={() => {
              setFailure('');
              setActionFailure('');
            }}
          />
          {unconfirmedText && (
            <div className="browser-input-recovery" role="status">
              <span>{t('Some typed text could not be confirmed. Copy it before retrying.')}</span>
              <button
                type="button"
                onClick={() => {
                  void copyTextToClipboard(unconfirmedText).catch((error) =>
                    setActionFailure(String(error?.message || error))
                  );
                }}
              >
                {t('Copy')}
              </button>
              <button type="button" onClick={() => client.clearUnconfirmedText()}>
                {t('Clear')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
