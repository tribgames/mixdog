export const REAUTHENTICATION_REQUIRED_MESSAGE = 'MCP OAuth reauthenticationRequired: sign in to connect';
export const reauthenticationRequired = () =>
  Object.assign(new Error(REAUTHENTICATION_REQUIRED_MESSAGE), {
    code: 'reauthenticationRequired',
  });
export const loginFailed = () => new Error('MCP OAuth login failed, cancelled, or timed out');

// `signal`, also aborted by the caller's optional `other` signal.
export const anySignal = (signal, other) => AbortSignal.any(other ? [signal, other] : [signal]);
