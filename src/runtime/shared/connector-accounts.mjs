// What a multi-account connector server tells the model about itself (MCP
// `instructions`): the account it acts for, and to ask which one when the
// user did not say and several are connected. The deferred-tool manifest
// (context/deferred-tools.mjs) reads the leading "Account: <address>" back.

/** The MCP instructions of a `service` server acting for `account` ('' when unknown). */
export function accountInstructions(service, account) {
  if (!account) return undefined;
  return `Account: ${account}. This server acts only for this ${service} account; other ${service} accounts are separate servers. If several are connected and the user did not name one, ask which account before acting.`;
}

/** The account a server's instructions name, or ''. */
export function accountOfInstructions(instructions) {
  return /^Account: (\S+?)\. /.exec(String(instructions || ''))?.[1] || '';
}
