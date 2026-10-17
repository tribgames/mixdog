// Test support: a scripted process table standing in for mcp/child-tree.mjs.
// Each row is one process identity; `state.next()` answers every table read
// (throw from it to model a failed enumeration).

export function processTable(rows = []) {
  const table = { childrenOf: new Map(), tokenOf: new Map(), nameOf: new Map(), pgidOf: new Map() };
  for (const { pid, ppid = 1, token = `created-${pid}`, name = 'node.exe', pgid } of rows) {
    if (!table.childrenOf.has(ppid)) table.childrenOf.set(ppid, []);
    table.childrenOf.get(ppid).push(pid);
    table.tokenOf.set(pid, token);
    table.nameOf.set(pid, name);
    if (pgid) table.pgidOf.set(pid, pgid);
  }
  return table;
}

function descendantsOf(table, root) {
  const out = [];
  const stack = [root];
  const seen = new Set(stack);
  while (stack.length) {
    for (const pid of table.childrenOf.get(stack.pop()) ?? []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      stack.push(pid);
      out.push({ pid, name: table.nameOf.get(pid), token: table.tokenOf.get(pid) });
    }
  }
  return out;
}

export function scriptedChildTree() {
  const state = { reads: 0, kills: [], next: () => processTable() };
  const read = async () => {
    state.reads += 1;
    return state.next();
  };
  return {
    state,
    namedExports: {
      readProcessTable: read,
      collectDescendantProcesses: async (root) => descendantsOf(await read(), root),
      killProcessTrees: async (pids) => {
        state.kills.push(...pids);
      },
      killStdioChildTreeFast: () => false,
      shutdownStdioChild: async () => false,
    },
  };
}
