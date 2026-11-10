// What the phone adapter must ask the core for one phone download call, derived from what Node's own method table asked of its service for that
// call (the recording's `service`, from Node): the adapter maps Node's five service methods onto the core's, one for one, with Node's arguments.
// A call Node's table refused before the service (bad arguments) has no service call and so no request.
const SOURCES = {
  project: ({ relPath }) => ({ kind: 'file', rel: relPath }),
  session: ({ path }) => ({ kind: 'sessionFile', path }),
  media: ({ assetId }) => ({ kind: 'mediaAsset', assetId }),
};

const REQUESTS = {
  authorize: ([{ source, purpose }]) => ({ method: 'transfer/authorizeRead', params: { sessionId: source.sessionId, source: SOURCES[source.kind](source), purpose } }),
  begin: ([grantId]) => ({ method: 'transfer/redeemGrant', params: { grantId } }),
  readRange: ([transferId, offset, length, version]) => ({ method: 'transfer/readRange', params: { transferId, offset, length, version } }),
  finish: ([transferId]) => ({ method: 'transfer/finishRead', params: { transferId } }),
  abort: ([transferId]) => ({ method: 'transfer/endRead', params: { transferId } }),
};

/** @param {{ method: string, args: unknown[] }[]} service the service calls Node's table made for one phone call */
export const coreRequests = (service) => service.map(({ method, args }) => REQUESTS[method](args));
