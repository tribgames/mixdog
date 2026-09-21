import { overlayStyles } from './content-styles';

export const OVERLAY_WIDTH = 280;
export const OVERLAY_HEIGHT = 72;

/** One Pause/Resume control preserves the task. Emergency Stop stays on Ctrl+Alt+Esc. */
export function overlayHtml(locale: string): string {
  const ko = locale.toLowerCase().startsWith('ko');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'">
<style>${overlayStyles}</style></head><body><div id="pill">
<svg id="outline" aria-hidden="true"><rect class="track"/><rect class="highlight" pathLength="100"/></svg>
<div id="status" role="status"><div id="title">${ko ? '컴퓨터 사용 중' : 'Computer in use'}</div></div>
<button id="toggle" type="button" aria-label="${ko ? '중단' : 'Pause'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg></button>
</div></body></html>`;
}

export function overlayScript(locale = 'en'): string {
  const ko = locale.toLowerCase().startsWith('ko');
  return `(() => {
    let state = { paused:false, canResume:false, busy:false, generation:0 };
    let armed, renderedRevision = -1, requestSequence = 0, pending = '', failed = false;
    const toggle = document.getElementById('toggle');
    const action = () => {
      if (armed?.action) return armed.action;
      if (pending === 'resume') return 'pause';
      return state.paused ? 'resume' : 'pause';
    };
    const render = () => {
      document.body.dataset.paused = String(state.paused);
      document.body.dataset.error = String(failed || Boolean(state.attention));
      let title;
      if (failed) title = ${JSON.stringify(ko ? '실패' : 'Failed')};
      else if (pending === 'pause') title = ${JSON.stringify(ko ? '중단 중' : 'Pausing')};
      else if (pending === 'resume') title = ${JSON.stringify(ko ? '재개 중' : 'Resuming')};
      else title = state.title || ${JSON.stringify(ko ? '컴퓨터 사용 중' : 'Computer in use')};
      document.getElementById('title').textContent = title;
      const resuming = action() === 'resume';
      const label = resuming ? ${JSON.stringify(ko ? '재개' : 'Resume')} : ${JSON.stringify(ko ? '중단' : 'Pause')};
      toggle.setAttribute('aria-label', label);
      toggle.title = label + ${JSON.stringify(ko ? ' (비상 중지: Ctrl+Alt+Esc)' : ' (emergency Stop: Ctrl+Alt+Esc)')};
      toggle.querySelector('path').setAttribute('d', resuming ? 'M7 4v16l14-8z' : 'M6 4h4v16H6zM14 4h4v16h-4z');
      toggle.disabled = pending === 'pause' || (state.busy && pending !== 'resume') || (resuming && !state.canResume);
      toggle.setAttribute('aria-busy', String(Boolean(pending) || Boolean(state.busy)));
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
        // Pause moves the generation itself; only Resume is stale across generations.
        if (request.action === 'resume' && request.generation !== state.generation) return;
        if (!reply?.accepted || reply.error) throw new Error('not accepted');
      } catch {
        if (sequence === requestSequence
          && (request.action === 'pause' || request.generation === state.generation)) failed = true;
      } finally {
        clearTimeout(deadline);
        if (sequence === requestSequence) { pending = ''; render(); }
      }
    };
    const arm = () => { armed = { action:action(), generation:state.generation }; };
    toggle.onpointerdown = arm;
    toggle.onpointercancel = () => { armed = undefined; render(); };
    toggle.onkeydown = (event) => {
      if (!event.repeat && (event.key === 'Enter' || event.key === ' ')) arm();
    };
    toggle.onclick = () => {
      const request = armed || { action:action(), generation:state.generation };
      armed = undefined;
      void send(request);
    };
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
