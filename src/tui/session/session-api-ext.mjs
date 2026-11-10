/**
 * src/tui/session/session-api-ext.mjs - part of the public session runtime session object.
 *
 * Re-exports the transcript restoration (owned by
 * runtime/agent/orchestrator/session/transcript-restore/restore.mjs); createSessionApiB
 * composes the surface groups under session-api/ (routes, integrations,
 * media, lifecycle).
 */
export {
  restoreTranscriptItems,
  sessionContextSnapshotProjection,
} from '../../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import { restoreTranscriptItems } from '../../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import { createSessionOAuthFlowRegistry } from './oauth-flows.mjs';
import { createSessionRouteApi } from './session-api/routes.mjs';
import { createSessionIntegrationsApi } from './session-api/integrations.mjs';
import { createSessionMediaApi } from './session-api/media.mjs';
import { createSessionLifecycleApi } from './session-api/lifecycle.mjs';

export function createSessionApiB(bag) {
  const oauthFlows = createSessionOAuthFlowRegistry();
  return {
    ...createSessionRouteApi(bag),
    ...createSessionIntegrationsApi(bag, { oauthFlows }),
    ...createSessionMediaApi(bag),
    ...createSessionLifecycleApi(bag, { restoreTranscriptItems, oauthFlows }),
  };
}
