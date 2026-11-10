// protocol-client failures -> the plain `Error` callers of the session facade have always received: the
// core's own message text, with the typed reason on `code`.

function versionRefusedMessage(detail) {
  const side = detail.reason === 'clientOutdated' ? 'this Mixdog is older than the running core' : 'this Mixdog is newer than the running core';
  return `${side} (this ${detail.clientVersion}, core ${detail.serverVersion}); update Mixdog`;
}

export function toSessionError(error) {
  const detail = error?.detail;
  if (!detail) return error;
  switch (detail.kind) {
    case 'rpc':
      return Object.assign(new Error(detail.message), { code: detail.reason, rpcCode: detail.code, data: detail.data });
    case 'versionRefused':
      return Object.assign(new Error(versionRefusedMessage(detail)), { code: detail.reason });
    case 'connectionLost':
      return Object.assign(new Error('connection to the core was lost'), { code: 'connectionLost' });
    case 'clientClosed':
      return Object.assign(new Error('This session view is disposed.'), { code: 'clientClosed' });
    case 'unknownMethod':
      return Object.assign(new Error(`protocol method ${detail.method} is unknown`), { code: 'unknownMethod' });
    default:
      return Object.assign(new Error(`${detail.kind}${detail.what ? `: ${detail.what}` : ''}`), { code: detail.kind });
  }
}
