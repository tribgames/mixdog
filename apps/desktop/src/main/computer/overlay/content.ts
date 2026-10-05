import { overlayStyles } from './content-styles';
import { loadOverlayFont } from './font-asset';
import { overlayTitles } from './model';

export const OVERLAY_WIDTH = 285;
export const OVERLAY_HEIGHT = 74;

const STOP_ICON_PATH =
  'M8.5 6h7a2.5 2.5 0 0 1 2.5 2.5v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 6 15.5v-7A2.5 2.5 0 0 1 8.5 6z';
const RESUME_ICON_PATH = 'M9 6.8v10.4a1 1 0 0 0 1.5.86l8.3-5.2a1 1 0 0 0 0-1.72l-8.3-5.2A1 1 0 0 0 9 6.8z';
// The Mixdog mark (design/brand): three arcs that turn while the agent works,
// around a star drawn larger than the logo's so it still reads at 20px.
const MARK_ARC_PATH = 'M116.2 61A68 68 0 0 1 191.9 104.7';
const MARK_STAR_POINTS = '128,100 137,119 156,128 137,137 128,156 119,137 100,128 119,119';
// The desktop's own face, so the pill reads like the app that owns it rather
// than Segoe UI with a system Hangul fallback. Bundles embed these bytes.
const OVERLAY_FONT = loadOverlayFont('pretendard/dist/web/static/woff2-subset/Pretendard-Medium.subset.woff2');

/** The wording the page starts with and the script re-renders, in one place. */
function overlayLabels(locale: string) {
  const ko = locale.toLowerCase().startsWith('ko');
  return {
    title: overlayTitles(locale).working,
    stop: ko ? '중단' : 'Stop',
    resume: ko ? '재개' : 'Resume',
    stopping: ko ? '중단 중' : 'Stopping',
    failed: ko ? '실패' : 'Failed',
  };
}

/**
 * Stop ends the task and is always present, pressable, and in the same place:
 * reaching for it can itself pause the agent (the user's own input), and
 * nothing on the pill ever changes what the press does. A pause never ends by
 * itself, so while paused Resume appears to Stop's left; Stop never moves.
 */
export function overlayHtml(locale: string): string {
  const labels = overlayLabels(locale);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; script-src 'none'">
<style>@font-face{font-family:"Mixdog Overlay";font-weight:500;font-display:block;src:url(data:font/woff2;base64,${OVERLAY_FONT}) format("woff2")}
${overlayStyles}</style></head><body><div id="pill">
<svg id="mark" viewBox="44 44 168 168" aria-hidden="true"><g id="arcs" fill="none" stroke-width="24" stroke-linecap="round"><path d="${MARK_ARC_PATH}"/><path d="${MARK_ARC_PATH}" transform="rotate(120 128 128)"/><path d="${MARK_ARC_PATH}" transform="rotate(240 128 128)"/></g><polygon id="star" points="${MARK_STAR_POINTS}"/></svg>
<div id="status" role="status"><div id="title">${labels.title}</div></div>
<button id="resume" type="button" hidden aria-label="${labels.resume}" title="${labels.resume}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${RESUME_ICON_PATH}"/></svg></button>
<button id="stop" type="button" aria-label="${labels.stop}" title="${labels.stop} (Ctrl+Alt+Esc)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STOP_ICON_PATH}"/></svg></button>
</div></body></html>`;
}

export function overlayScript(locale = 'en'): string {
  const labels = overlayLabels(locale);
  return `(() => {
    let state = { paused:false, resumable:false, generation:0 };
    let renderedRevision = -1, requestSequence = 0, pending = '', failed = false;
    const stopControl = document.getElementById('stop');
    const resumeControl = document.getElementById('resume');
    const title = document.getElementById('title');
    // Evidence that the pointer reached a control, recorded by the host next
    // to the press outcome; delivery never affects the control itself.
    const report = (control) => () => {
      void Promise.resolve()
        .then(() => window.mixdogComputerControl({ action:'press', control }))
        .catch(() => {});
    };
    const render = () => {
      document.body.dataset.paused = String(Boolean(state.paused));
      document.body.dataset.error = String(failed || Boolean(state.attention));
      if (failed) title.textContent = ${JSON.stringify(labels.failed)};
      else if (pending === 'stop') title.textContent = ${JSON.stringify(labels.stopping)};
      else title.textContent = state.title || ${JSON.stringify(labels.title)};
      resumeControl.hidden = !state.resumable;
      // Never disabled: a running or failed request reports itself through the
      // wording and aria-busy only, so every press reaches the host.
      stopControl.setAttribute('aria-busy', String(pending === 'stop'));
      resumeControl.setAttribute('aria-busy', String(pending === 'resume'));
    };
    const send = async (action) => {
      const sequence = ++requestSequence;
      pending = action; failed = false; render();
      let deadline;
      try {
        const reply = await Promise.race([
          window.mixdogComputerControl({ action, generation:state.generation }),
          new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('timeout')), 20000); }),
        ]);
        if (!reply?.accepted || reply.error) throw new Error('not accepted');
      } catch {
        // Stop moves the generation itself, so its failure outlives that change.
        if (sequence === requestSequence) failed = true;
      } finally {
        clearTimeout(deadline);
        if (sequence === requestSequence) { pending = ''; render(); }
      }
    };
    // This window never activates, and Windows lets it answer a press with
    // MA_NOACTIVATEANDEAT: the button-down is discarded and only the release
    // arrives. A release on a control that saw no press is that click.
    let pressed = null;
    const bind = (control, action) => {
      control.onpointerdown = () => { pressed = control; report(action)(); };
      control.onpointerup = () => {
        if (pressed === control) return;
        report(action)();
        void send(action);
      };
      control.onclick = () => { void send(action); };
    };
    bind(stopControl, 'stop');
    bind(resumeControl, 'resume');
    document.addEventListener('pointerup', () => { pressed = null; });
    window.mixdogComputerOverlay = (next) => {
      if (next.renderRevision < renderedRevision) return;
      renderedRevision = next.renderRevision;
      // The host keeps every control failure as attention while it matters.
      if (next.generation !== state.generation || !next.attention) failed = false;
      state = next;
      document.body.classList.remove('hiding');
      document.documentElement.style.setProperty('--accent', state.accent || '#58a6ff');
      render();
    };
    window.mixdogComputerOverlayHide = () => document.body.classList.add('hiding');
    render();
  })();`;
}
