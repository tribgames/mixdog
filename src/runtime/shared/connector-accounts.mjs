// What a connector server tells the model about its accounts (MCP
// `instructions`), in one line: the connected accounts, and that each tool
// takes `account` (left out, the account used last). An account that cannot
// be used right now is listed with why.

/** The MCP instructions naming `accounts` (`{ email, note? }`, `note` a short
 *  reason it is unusable such as "needs sign-in"; one without an address is
 *  left out), or undefined when none has one. */
export function connectorAccountsInstructions(accounts) {
  const named = (Array.isArray(accounts) ? accounts : []).filter((account) => account?.email);
  if (!named.length) return undefined;
  const list = named.map(({ email, note }) => (note ? `${email} (${note})` : email)).join(', ');
  return named.length === 1
    ? `Accounts: ${list}. \`account\` may be left out.`
    : `Accounts: ${list}. \`account\` picks one; left out, a call uses the account used last, and its result names it.`;
}

/** The account addresses instructions from connectorAccountsInstructions name. */
export function accountsOfInstructions(instructions) {
  const list = /^Accounts: (.+?)\. `account`/.exec(String(instructions || ''))?.[1] || '';
  return list
    .split(', ')
    .map((part) => part.replace(/ \(.*\)$/, '').trim())
    .filter(Boolean);
}
