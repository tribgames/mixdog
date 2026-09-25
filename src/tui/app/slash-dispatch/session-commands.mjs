// slash-dispatch/session-commands.mjs
// Slash commands that act on the session itself: clear/new, compact, goal,
// resume, inherit, doctor and quit. Busy guards refuse the destructive ones
// while a turn or session command is running.
import { presentErrorText } from '../../../runtime/shared/err-text.mjs';

function compactFailureNotice(error) {
  if (error == null || String(error).trim() === '') return 'Compact failed.';
  const reason = presentErrorText(error, { surface: 'compact', max: 320 });
  if (!reason || reason === 'Unknown error') return 'Compact failed.';
  return /^compact(?:ion)? failed\b/i.test(reason) ? reason : `Compact failed: ${reason}`;
}

const compactOutcomeNotice = (r) => {
  if (!r) return ['Compact failed.', 'warn'];
  if (r.error) return [compactFailureNotice(r.error), 'error'];
  if (r.changed === false && r.reason) return [r.reason, 'warn'];
  if (r.changed === false) return ['nothing to compact', 'warn'];
  return ['Compact done.', 'info'];
};

const refuseWhileBusy = (store, command) => {
  store.pushNotice(`wait for the current turn to finish before /${command}`, 'warn');
  return false;
};

export const sessionCommands = {
  clear(ctx, _arg, rawName) {
    const { state, store } = ctx;
    if (state.busy || state.commandBusy) {
      store.pushNotice(
        `wait for the current session command to finish before /${rawName === 'new' ? 'new' : 'clear'}`,
        'warn'
      );
      return false;
    }
    if (rawName === 'new') {
      void store
        .newSession()
        .then((created) => {
          if (created === false) {
            store.pushNotice('new session is already running', 'warn');
            return;
          }
          // Incremental Ink rendering can otherwise retain physical rows
          // from the taller outgoing transcript on Windows Terminal.
          store.forceRenderRepaint?.();
        })
        .catch((e) => store.pushNotice(`new session failed: ${e?.message || e}`, 'error'));
    } else {
      void store.clear().catch((e) => store.pushNotice(`clear failed: ${e?.message || e}`, 'error'));
    }
    return true;
  },

  compact(ctx) {
    const { state, store } = ctx;
    if (state.busy) return refuseWhileBusy(store, 'compact');
    void store
      .compact()
      .then((r) => store.pushNotice(...compactOutcomeNotice(r)))
      .catch((error) => store.pushNotice(compactFailureNotice(error), 'error'));
    return true;
  },

  goal(ctx, arg) {
    const { store } = ctx;
    void Promise.resolve(store.goalControl?.({ command: arg }))
      .then((result) => {
        if (!result) {
          store.pushNotice('Goal is unavailable.', 'warn');
          return;
        }
        store.pushNotice(result.message || 'Goal updated.', 'info');
      })
      .catch((error) => store.pushNotice(`Goal failed: ${error?.message || error}`, 'error'));
    return true;
  },

  resume(ctx, arg) {
    const { state, store, openSlashPanel, deps } = ctx;
    if (state.busy) return refuseWhileBusy(store, 'resume');
    if (arg) {
      void store
        .resume(arg)
        .then((ok) => store.pushNotice(ok ? `Resumed ${arg}` : 'Couldn’t resume chat.', ok ? 'info' : 'warn'))
        .catch((e) => store.pushNotice(`Couldn’t resume chat: ${e?.message || e}`, 'error'));
    } else {
      openSlashPanel('resume', 'Resume', () => deps.openResumePicker());
    }
    return true;
  },

  inherit(ctx) {
    const { state, store } = ctx;
    if (state.busy) return refuseWhileBusy(store, 'inherit');
    void Promise.resolve(store.inheritSession?.())
      .then((result) => {
        if (!result) {
          store.pushNotice('nothing to inherit', 'warn');
          return;
        }
        store.pushNotice(`inherited ${result.messages} messages into ${result.sessionId}`, 'info');
      })
      .catch((e) => store.pushNotice(`inherit failed: ${e?.message || e}`, 'error'));
    return true;
  },

  doctor(ctx) {
    const { state, store, deps } = ctx;
    if (state.commandBusy) {
      store.pushNotice('wait for the current command to finish before /doctor', 'warn');
      return false;
    }
    void Promise.resolve(deps.runDoctor?.()).catch((e) =>
      store.pushNotice(`doctor failed: ${e?.message || e}`, 'error')
    );
    return true;
  },

  quit(ctx) {
    ctx.deps.requestExit();
    return true;
  },
};
