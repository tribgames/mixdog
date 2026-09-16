import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createBrowserPageClient, type BrowserPageElement } from './browser-page-client';
import { useBrowserPageInput } from './use-browser-page-input';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { copyTextToClipboard } from './text-format';
import type { DesktopBrowserPageFrame } from '../shared/contract';
import { browserPageTransition } from './browser-page-recovery';
import { createBrowserDisplayHealth } from './browser-display-health';
import { createBrowserPresentationLoop } from './browser-presentation-loop';
import { createBrowserPixelPresentation } from './browser-pixel-presentation';
import { BrowserPagePrompts } from './BrowserPagePrompts';
import './desktop/browser-isolated-view.css';

/** Pixel-only display: guest events have no DOM path to the shell. */
export const IsolatedBrowserView = forwardRef<
  BrowserPageElement,
  {
    sessionId: string;
    active: boolean;
    className?: string;
  }
>(function IsolatedBrowserView({ sessionId, active, className }, ref) {
  const element = useRef<HTMLDivElement | null>(null);
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
        prepare: presentation.prepare,
        update: presentation.update,
        failure: setActionFailure,
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
    document.addEventListener('visibilitychange', loop.wake);
    loop.wake();
    return () => {
      stopped = true;
      loop.stop();
      client.setRefresh(() => {});
      document.removeEventListener('visibilitychange', loop.wake);
    };
  }, [active, client]);

  useEffect(() => {
    const node = element.current;
    if (!active || !frame?.documentId || !node) return undefined;
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
  }, [active, client, presentation, frame?.documentId]);
  return (
    <div ref={element} className={`${className || ''} browser-isolated-view`}>
      <div
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
