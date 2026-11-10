// Panel/prompt supersession epoch.
//
// Module-global on purpose: the TUI runs ONE App tree and every picker/prompt
// factory is re-created on each render, so this ownership marker cannot live in
// a factory closure.
//
// Anything that hands surface ownership back to the user — closing a picker
// (Esc/cancel), cancelling a text-entry prompt, or issuing a NEWER submit of
// the same prompt — supersedes every deferred paint issued before it. Async
// work captures currentPanelEpoch() when the USER ACTION starts and re-checks
// isPanelEpochCurrent(token) immediately before it opens, refreshes, or closes
// a surface. That single check kills both failure modes:
//   - a daemon write settling after Esc re-opening the dismissed panel, and
//   - an older ACK closing (or claiming success for) a panel that meanwhile
//     holds newer user input.
let panelEpoch = 0;

export function currentPanelEpoch() {
  return panelEpoch;
}

// Marks every in-flight deferred paint as superseded and returns the new token
// for the action performing the supersession.
export function supersedePanelEpoch() {
  panelEpoch += 1;
  return panelEpoch;
}

export function isPanelEpochCurrent(token) {
  return token === panelEpoch;
}

// Identity of the SURFACE a panel object stands for. A rebuild of the same
// surface (light Settings refresh, toggle-driven MCP re-render) keeps this
// value stable; a different panel reports a different identity.
export function panelIdentity(panel) {
  if (!panel || typeof panel !== 'object') return null;
  return panel._kind || panel.title || null;
}

// True when `next` takes the surface away from a DIFFERENT panel that was open:
// a close (open → null) or a replacement by another panel. Both hand the
// surface to something the user is looking at now, so deferred paints issued
// before it are stale. Not a handover:
//   - null → anything: nothing owned the surface, and the in-flight write of a
//     text-entry prompt currently on screen must stay valid, and
//   - a rebuild of the same panel: its own deferred refresh must still land.
export function shouldSupersedePanelEpoch(previous, next) {
  if (!previous || typeof previous !== 'object') return false;
  if (!next || typeof next !== 'object') return true;
  if (previous === next) return false;
  return panelIdentity(previous) !== panelIdentity(next);
}

// Ownership is CLAIMED, never asserted by hand: panel-surface.mjs owns the
// sinks and hands out claims that carry these tokens (see that module's header).
