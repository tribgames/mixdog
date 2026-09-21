import { overlayStyles } from './content-styles';

export const OVERLAY_WIDTH = 280;
export const OVERLAY_HEIGHT = 72;

/**
 * A Pause/Resume toggle preserves the task. While the pill shows the check
 * state that toggle can be dead — a latched cleanup only clears through Stop —
 * so the check state carries its own Stop control instead of leaving
 * Ctrl+Alt+Esc as the single way out.
 */
export function overlayHtml(locale: string): string {
  const ko = locale.toLowerCase().startsWith('ko');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'">
<style>${overlayStyles}</style></head><body><div id="pill">
<svg id="outline" aria-hidden="true"><rect class="track"/><rect class="highlight" pathLength="100"/></svg>
<div id="status" role="status"><div id="title">${ko ? '컴퓨터 사용 중' : 'Computer in use'}</div></div>
<div id="controls">
<button id="toggle" type="button" aria-label="${ko ? '중단' : 'Pause'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg></button>
<button id="stop" type="button" hidden aria-label="${ko ? '작업 종료' : 'Stop'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z"/></svg></button>
</div>
</div></body></html>`;
}

export function overlayScript(locale = 'en'): string {
  const ko = locale.toLowerCase().startsWith('ko');
  return `(() => {
    let state = { paused:false, canResume:false, busy:false, generation:0 };
    let armed, renderedRevision = -1, requestSequence = 0, pending = '', failed = false;
    const toggle = document.getElementById('toggle');
    const stopControl = document.getElementById('stop');
    const action = () => {
      if (armed?.action) return armed.action;
      if (pending === 'resume') return 'pause';
      return state.paused ? 'resume' : 'pause';
    };
    const render = () => {
      const attention = failed || Boolean(state.attention);
      document.body.dataset.paused = String(state.paused);
      document.body.dataset.error = String(attention);
      let title;
      if (failed) title = ${JSON.stringify(ko ? '실패' : 'Failed')};
      else if (pending === 'pause') title = ${JSON.stringify(ko ? '중단 중' : 'Pausing')};
      else if (pending === 'resume') title = ${JSON.stringify(ko ? '재개 중' : 'Resuming')};
      else if (pending === 'stop') title = ${JSON.stringify(ko ? '종료 중' : 'Stopping')};
      else title = state.title || ${JSON.stringify(ko ? '컴퓨터 사용 중' : 'Computer in use')};
      document.getElementById('title').textContent = title;
      const resuming = action() === 'resume';
      const label = resuming ? ${JSON.stringify(ko ? '재개' : 'Resume')} : ${JSON.stringify(ko ? '중단' : 'Pause')};
      toggle.setAttribute('aria-label', label);
      toggle.title = label + ${JSON.stringify(ko ? ' (비상 중지: Ctrl+Alt+Esc)' : ' (emergency Stop: Ctrl+Alt+Esc)')};
      toggle.querySelector('path').setAttribute('d', resuming ? 'M7 4v16l14-8z' : 'M6 4h4v16H6zM14 4h4v16h-4z');
      toggle.disabled = pending === 'pause' || (state.busy && pending !== 'resume') || (resuming && !state.canResume);
      toggle.setAttribute('aria-busy', String(Boolean(pending) || Boolean(state.busy)));
      // Stop ends the task and is the only control that clears a latched
      // cleanup, so it stays live exactly while the pill asks for a decision.
      stopControl.hidden = !attention;
      stopControl.disabled = pending === 'stop';
      stopControl.title = ${JSON.stringify(ko ? '작업 종료' : 'Stop')} + ' (Ctrl+Alt+Esc)';
      stopControl.setAttribute('aria-busy', String(pending === 'stop'));
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
    stopControl.onclick = () => {
      armed = undefined;
      void send({ action:'stop', generation:state.generation });
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
