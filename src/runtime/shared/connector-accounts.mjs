// What a multi-account connector server tells the model about itself (MCP
// `instructions`), in one line: the connected accounts, and that each tool
// takes `account` (asked of the user when several are connected and none was
// named). An account that cannot be used right now is listed with why.

/** The MCP instructions naming `accounts` (`{ email, note? }`, `note` a short
 *  reason it is unusable such as "needs sign-in"; one without an address is
 *  left out), or undefined when none has one. */
export function connectorAccountsInstructions(accounts) {
  const named = (Array.isArray(accounts) ? accounts : []).filter((account) => account?.email);
  if (!named.length) return undefined;
  const list = named.map(({ email, note }) => (note ? `${email} (${note})` : email)).join(', ');
  return named.length === 1
    ? `Accounts: ${list}. \`account\` may be left out.`
    : `Accounts: ${list}. Pass \`account\`; if the user named none and there are several, ask which.`;
}

/** The account addresses instructions from connectorAccountsInstructions name. */
export function accountsOfInstructions(instructions) {
  const list = /^Accounts: (.+?)\. (?:`account`|Pass `account`)/.exec(String(instructions || ''))?.[1] || '';
  return list
    .split(', ')
    .map((part) => part.replace(/ \(.*\)$/, '').trim())
    .filter(Boolean);
}
