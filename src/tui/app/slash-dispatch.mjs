/**
 * slash-dispatch.mjs — the runSlashCommand slash-command dispatcher.
 *
 * A dependency-injection factory: the handlers read live store/state and drive
 * many pickers + openers, so they can't be pure. Commands are a table keyed by
 * the normalized name (slash-dispatch/route-commands, session-commands,
 * panel-commands); every handler gets the dispatch context — state, store,
 * the loading-frame opener and the injected openers — plus the raw argument.
 * Openers defined later in the App factory zone are passed as lazy getters so
 * their live binding is used at call time.
 */
import { panelCommands } from './slash-dispatch/panel-commands.mjs';
import { routeCommands } from './slash-dispatch/route-commands.mjs';
import { sessionCommands } from './slash-dispatch/session-commands.mjs';
import { createSlashPanelOpener } from './slash-dispatch/slash-panel.mjs';

const commands = { ...routeCommands, ...sessionCommands, ...panelCommands };

export function createSlashDispatch({ state, store, normalizeSlashCommandName, surface, closeUsagePanel, ...deps }) {
  const ctx = { state, store, deps, openSlashPanel: createSlashPanelOpener({ surface, store }) };
  const runSlashCommand = (cmd, arg = '') => {
    const rawName = String(cmd || '').toLowerCase();
    cmd = normalizeSlashCommandName(cmd);
    // Synchronous dispatch of the command the user just submitted: this action
    // owns the surface it clears.
    if (cmd !== 'context') surface.claim().context(null);
    if (cmd !== 'usage') closeUsagePanel();
    const handler = Object.hasOwn(commands, cmd) ? commands[cmd] : null;
    if (!handler) {
      store.pushNotice(`unknown command: /${cmd}`, 'warn');
      return true;
    }
    return handler(ctx, arg, rawName);
  };
  return { runSlashCommand };
}
