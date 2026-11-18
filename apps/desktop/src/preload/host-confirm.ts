// The preload of main's confirm surface (main/developer-risk-confirm.ts). The page is static and runs no script, and
// nothing is exposed to it: only this preload answers, and only for a trusted activation of the page's own buttons
// (a click, or Enter/Space on the focused one) or a trusted Escape. Focus starts on Cancel and Tab stays on the two
// buttons.
import { ipcRenderer } from 'electron';
import {
  HOST_CONFIRM_SURFACE_IDS as IDS,
  HOST_CONFIRM_SURFACE_IPC,
  type HostConfirmSurfaceMessage,
} from '../shared/host-confirm-surface';

const send = (message: HostConfirmSurfaceMessage): void => ipcRenderer.send(HOST_CONFIRM_SURFACE_IPC, message);

window.addEventListener('DOMContentLoaded', () => {
  const card = document.getElementById(IDS.card);
  const cancel = document.getElementById(IDS.cancel);
  const accept = document.getElementById(IDS.accept);
  if (!card || !(cancel instanceof HTMLButtonElement) || !(accept instanceof HTMLButtonElement)) return;
  cancel.focus();
  let answered = false;
  const answer = (accepted: boolean, event: Event): void => {
    if (!event.isTrusted || answered) return;
    answered = true;
    send({ type: 'answer', accepted });
  };
  accept.addEventListener('click', (event) => answer(true, event));
  cancel.addEventListener('click', (event) => answer(false, event));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      answer(false, event);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      (document.activeElement === cancel ? accept : cancel).focus();
    }
  });
  send({ type: 'size', height: Math.ceil(card.getBoundingClientRect().height) });
});
