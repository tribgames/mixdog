// Rolling aliases name the current model, not the version released on the
// alias's creation date. Shared by catalog filtering and browser/TUI pickers.
export function isRollingModelAlias(id) {
  return /-latest$/i.test(String(id || '').trim());
}
