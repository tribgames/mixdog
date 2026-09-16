import { overlayStyles } from './content-styles';

export const OVERLAY_WIDTH = 360;
export const OVERLAY_HEIGHT = 96;
export const OVERLAY_COMPACT_WIDTH = 220;

/** Two controls only: Resume appears while the user holds control, Stop is
 * always there. Taking control needs no button; touching the desktop does it. */
export function overlayHtml(locale: string): string {
  const ko = locale.toLowerCase().startsWith('ko');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'">
<style>:root { --compact-width:${OVERLAY_COMPACT_WIDTH}px; }${overlayStyles}</style></head><body><div id="pill">
<svg id="outline" aria-hidden="true"><rect class="track"/><rect class="highlight" pathLength="100"/></svg>
<span id="dot"></span>
<div id="status" role="status"><div id="title">${ko ? 'Mixdog 사용 중' : 'Mixdog using'}</div><div id="detail" hidden></div></div>
<button id="resume" type="button" hidden aria-label="${ko ? '재개' : 'Resume'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l14-8z"/></svg></button>
<button id="stop" type="button" aria-label="${ko ? '중지' : 'Stop'}" title="${ko ? '중지' : 'Stop'} (Ctrl+Alt+Esc)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v14H5z"/></svg></button>
</div></body></html>`;
}

export function overlayScript(locale = 'en'): string {
  const ko = locale.toLowerCase().startsWith('ko');
  return `(() => {
    let state = { paused:false, canResume:false, busy:false, generation:0 };
    let armed, renderedRevision = -1, requestSequence = 0, pending = '', failed = false;
    const resume = document.getElementById('resume');
    const stop = document.getElementById('stop');
    const detail = document.getElementById('detail');
    const render = () => {
      document.body.dataset.paused = String(state.paused);
      document.body.dataset.error = String(failed || Boolean(state.attention));
      document.getElementById('title').textContent = failed
        ? ${JSON.stringify(ko ? '요청 실패' : 'Request failed')}
        : pending === 'stop' ? ${JSON.stringify(ko ? '중지 중' : 'Stopping')}
        : state.title || ${JSON.stringify(ko ? 'Mixdog 사용 중' : 'Mixdog using')};
      const text = failed && !state.attention
        ? ${JSON.stringify(ko ? '요청을 완료하지 못했습니다. 다시 눌러 주세요.' : 'The request did not complete. Press again.')}
        : pending === 'stop' && !failed
          ? ${JSON.stringify(ko ? '입력 차단과 작업 종료를 확인하는 중입니다.' : 'Confirming input blocking and task cancellation.')}
        : state.detail || '';
      detail.textContent = text;
      detail.hidden = !text;
      resume.hidden = !state.paused;
      resume.disabled = !state.canResume || state.busy || Boolean(pending);
      resume.setAttribute('aria-busy', String(pending === 'resume'));
      stop.setAttribute('aria-busy', String(pending === 'stop' || Boolean(state.busy && !pending)));
    };
    const send = async (request) => {
      const sequence = ++requestSequence;
      pending = request.action; failed = false; render();
      let deadline;
      try {
        const reply = await Promise.race([
          window.mixdogComputerControl(request),
          new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('timeout')), 20000); }),
        ]);
        if (sequence !== requestSequence) return;
        // Stop moves the generation itself; only Resume is stale across generations.
        if (request.action !== 'stop' && request.generation !== state.generation) return;
        if (!reply?.accepted || reply.error) throw new Error('not accepted');
      } catch {
        if (sequence === requestSequence
          && (request.action === 'stop' || request.generation === state.generation)) failed = true;
      } finally {
        clearTimeout(deadline);
        if (sequence === requestSequence) { pending = ''; render(); }
      }
    };
    const arm = () => { armed = { action:'resume', generation:state.generation }; };
    resume.onpointerdown = arm;
    resume.onkeydown = (event) => {
      if (!event.repeat && (event.key === 'Enter' || event.key === ' ')) arm();
    };
    resume.onclick = () => {
      const request = armed || { action:'resume', generation:state.generation };
      armed = undefined;
      void send(request);
    };
    stop.onclick = () => { armed = undefined; void send({ action:'stop', generation:state.generation }); };
    window.mixdogComputerOverlay = (next) => {
      if (next.renderRevision < renderedRevision) return;
      renderedRevision = next.renderRevision;
      if (next.generation !== state.generation) failed = false;
      state = next;
      document.body.classList.remove('hiding');
      document.documentElement.style.setProperty('--accent', state.accent || '#58a6ff');
      render();
    };
    window.mixdogComputerOverlayHide = () => document.body.classList.add('hiding');
    render();
  })();`;
}
