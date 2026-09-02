/**
 * What the page has been doing: health status, the console ledger, and the
 * network ledger with per-request detail.
 */
import { defineBrowserActions } from './types';

export const diagnosticActions = defineBrowserActions({
  async status({ guest, services }) {
    return services.dialogs.diagnosticsResult(guest);
  },

  async console({ guest, command, services }) {
    return {
      text: services.state.for(guest).console.format(command.level, command.query, command.limit),
    };
  },

  async network({ guest, command, signal, services }) {
    const requestId = String(command.requestId || '').trim();
    if (!requestId) return services.network.networkListResult(guest, command);
    const request = services.state.for(guest).network.get(requestId);
    if (!request) {
      throw new Error(`unknown network request "${requestId}"; call network without requestId to list requests`);
    }
    return services.network.networkDetailResult(guest, request, command, signal);
  },
});
