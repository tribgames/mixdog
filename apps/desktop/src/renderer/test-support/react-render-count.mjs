// Counts what React does per commit, read from the fiber tree it commits (the
// way React DevTools tells which components rendered). Import before
// react-dom: React reads the hook when it loads.
//   rendered: components whose function ran
//   reconciled: fibers React visited (re-created from the previous commit or new)
const PERFORMED_WORK = 1;
const totals = { commits: 0, rendered: 0, reconciled: 0, names: new Map() };

function countCommit(root) {
  totals.commits += 1;
  const visit = (fiber) => {
    totals.reconciled += 1;
    if (fiber.flags & PERFORMED_WORK && typeof fiber.type !== 'string') {
      totals.rendered += 1;
      const type = fiber.type?.type ?? fiber.type;
      const name = type?.displayName || type?.name || String(fiber.tag);
      totals.names.set(name, (totals.names.get(name) ?? 0) + 1);
    }
    // A child list taken over unchanged from the previous commit was not visited.
    if (fiber.alternate && fiber.child === fiber.alternate.child) return;
    for (let child = fiber.child; child; child = child.sibling) visit(child);
  };
  visit(root.current);
}

globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true,
  renderers: new Map(),
  inject: () => 1,
  onCommitFiberRoot: (_id, root) => countCommit(root),
  onCommitFiberUnmount: () => undefined,
  onPostCommitFiberRoot: () => undefined,
  checkDCE: () => undefined,
};

/** Counts from here on. */
export function resetRenderCount() {
  totals.commits = 0;
  totals.rendered = 0;
  totals.reconciled = 0;
  totals.names = new Map();
}

export function renderCount() {
  return { ...totals, names: Object.fromEntries(totals.names) };
}
