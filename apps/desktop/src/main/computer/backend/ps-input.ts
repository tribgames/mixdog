import { loadComputerSource } from './native-assets';

/** The input layer in dependency order: element refs, semantic (background)
 *  actions, target resolution, the foreground guards, pointer gestures, window
 *  state and predicates, then menus. Each part ends on a statement boundary, so
 *  the parts join with no separator. */
export const PS_INPUT = [
  loadComputerSource('input-refs.ps1'),
  loadComputerSource('input-semantic.ps1'),
  loadComputerSource('input-target.ps1'),
  loadComputerSource('input-guard.ps1'),
  loadComputerSource('input-pointer.ps1'),
  loadComputerSource('input-window.ps1'),
  loadComputerSource('input-menu.ps1'),
].join('');
