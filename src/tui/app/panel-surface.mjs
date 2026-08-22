/**
 * panel-surface.mjs — the OWNING LAYER for the panel sinks.
 *
 * App.jsx hands the three React setters (picker / context panel / usage panel)
 * to createPanelSurface ONCE; they never leave this module. Every panel module
 * receives `surface` instead, and the only way to reach a sink is a CLAIM taken
 * at the user action that is allowed to own the screen:
 *
 *   const own = surface.claim();   // this action takes the surface
 *   own.paint(panel);              // guarded write; null clears but keeps the flow
 *   own.close();                   // Esc: clear and hand ownership back for good
 *   own.defer(fn);                 // callback that may settle much later
 *
 * The claim carries the panel epoch (panel-epoch.mjs) it was taken at and EVERY
 * write re-validates it, so "paint without proving ownership" is not
 * expressible: an alias of own.paint, a member call, a callback handed to
 * another module, a class field, a stored or reassigned binding, a generator
 * resuming after yield — all of them funnel through the same check, because the
 * proof lives inside the capability, not next to the call site.
 *
 * Two rules make it behave like the hand-written guards it replaces:
 *  - a paint can itself BE the handover (panel identity change), so a
 *    successful write re-arms the claim on the surface it just took;
 *  - close() drops ownership permanently, which is what stops a late ack from
 *    re-opening a panel the user dismissed. Use paint(null) — not close() —
 *    when the same flow clears the picker and keeps going (Enter → prompt).
 */
import { currentPanelEpoch, isPanelEpochCurrent } from './panel-epoch.mjs';

export function createPanelSurface({ setPicker, setContextPanel, setUsagePanel } = {}) {
  // The usage dashboard is not a picker: a streaming update is not a handover,
  // so the picker epoch cannot express its ownership. It gets its own
  // generation, bumped by closeUsage() (Esc / a newer /usage).
  let usageGeneration = 0;

  const claim = () => {
    let token = currentPanelEpoch();
    let released = false;
    const owns = () => !released && isPanelEpochCurrent(token);
    const write = (sink, value) => {
      if (!owns()) return false;
      sink?.(value);
      token = currentPanelEpoch();
      return true;
    };
    return {
      owns,
      paint: (panel) => write(setPicker, panel),
      context: (panel) => write(setContextPanel, panel),
      close: () => {
        if (!owns()) return false;
        setPicker?.(null);
        released = true;
        return true;
      },
      defer: (run) => {
        const deferredToken = token;
        return (...args) => (
          !released && isPanelEpochCurrent(deferredToken) ? run(...args) : undefined
        );
      },
    };
  };

  const claimUsage = () => {
    const generation = (usageGeneration += 1);
    const owns = () => generation === usageGeneration;
    return {
      owns,
      paint: (dashboard) => {
        if (!owns()) return false;
        setUsagePanel?.(dashboard);
        return true;
      },
    };
  };

  // Closing the usage overlay invalidates every dashboard update in flight.
  const closeUsage = () => {
    usageGeneration += 1;
    setUsagePanel?.(null);
  };

  return { claim, claimUsage, closeUsage };
}
