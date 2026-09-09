import { overlayStyles } from './content-styles';

export const OVERLAY_WIDTH = 280;
export const OVERLAY_HEIGHT = 88;

export function overlayHtml(locale: string): string {
  const ko = locale.toLowerCase().startsWith('ko');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'">
<style>${overlayStyles}</style></head><body><div id="pill">
<svg id="outline" aria-hidden="true"><rect class="track"/><rect class="highlight" pathLength="100"/></svg>
<span id="dot"></span>
<div id="status" role="status"><div id="title">${ko ? 'Mixdog 사용 중' : 'Mixdog using'}</div></div>
<button id="toggle" type="button" aria-label="${ko ? '일시중지' : 'Pause'}"></button>
<button id="stop" type="button" aria-label="${ko ? '중지' : 'Stop'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v14H5z"/></svg></button>
</div></body></html>`;
}

export function overlayScript(locale = 'en'): string {
  const ko = locale.toLowerCase().startsWith('ko');
  return `(() => {
    let state = { paused:false, canResume:false, busy:false, generation:0 };
    let armed, renderedRevision = -1, requestSequence = 0, pending = false, failed = false;
    const button = document.getElementById('toggle');
    const stop = document.getElementById('stop');
    const action = () => state.paused && !state.busy && !pending ? 'resume' : 'pause';
    const render = () => {
      const resume = action() === 'resume';
      document.body.dataset.paused = String(state.paused);
      document.body.dataset.error = String(failed || Boolean(state.attention));
      const title = failed ? ${JSON.stringify(ko ? '요청 실패' : 'Request failed')}
        : state.title || ${JSON.stringify(ko ? 'Mixdog 사용 중' : 'Mixdog using')};
      document.getElementById('title').textContent = title;
      button.disabled = resume && !state.canResume;
      button.setAttribute('aria-label', resume
        ? ${JSON.stringify(ko ? '재개' : 'Resume')} : ${JSON.stringify(ko ? '일시중지' : 'Pause')});
      button.setAttribute('aria-busy', String(state.busy || pending));
      button.innerHTML = resume
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l14-8z"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h5v16H5zM14 4h5v16h-5z"/></svg>';
    };
    const send = async (request) => {
      const sequence = ++requestSequence;
      pending = true; failed = false; render();
      let deadline;
      try {
        const reply = await Promise.race([
          window.mixdogComputerControl(request),
          new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('timeout')), 20000); }),
        ]);
        if (sequence !== requestSequence || request.generation !== state.generation) return;
        if (!reply?.accepted || reply.error) throw new Error('not accepted');
      } catch {
        if (sequence === requestSequence && request.generation === state.generation) failed = true;
      } finally {
        clearTimeout(deadline);
        if (sequence === requestSequence) { pending = false; render(); }
      }
    };
    const arm = () => { armed = { action:action(), generation:state.generation }; };
    button.onpointerdown = arm;
    button.onkeydown = (event) => {
      if (!event.repeat && (event.key === 'Enter' || event.key === ' ')) arm();
    };
    button.onclick = () => {
      const request = armed || { action:action(), generation:state.generation };
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
