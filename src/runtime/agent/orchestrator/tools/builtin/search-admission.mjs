import { searchIoAdmission } from '../../../../shared/tool-workload-gates.mjs';
import { recordLocalSearchAdmission } from './local-search-telemetry.mjs';

export function isBroadSearchRequest(request) {
  if (!request || typeof request !== 'object') return false;
  return request.fuzzy != null
    || request.bulkHint === true
    || request.args?.includes?.('--files') === true;
}

export function runWithSearchIoAdmission(
  request,
  execOptions,
  task,
  {
    gate = searchIoAdmission,
    waitTimeoutMs = 0,
  } = {},
) {
  if (typeof task !== 'function') {
    return Promise.reject(new TypeError('search admission task must be a function'));
  }
  if (!isBroadSearchRequest(request)) return Promise.resolve().then(task);
  return gate.run(
    execOptions?.ownerKey || null,
    task,
    {
      signal: execOptions?.signal || null,
      waitTimeoutMs,
      onAdmit: recordLocalSearchAdmission,
    },
  );
}
