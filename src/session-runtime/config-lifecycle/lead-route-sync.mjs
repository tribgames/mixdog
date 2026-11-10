// Adopting the Lead route a config reload brings in into the runtime's Main
// route. Both are no-ops for a lifecycle without route sync (setRouteState /
// resolveRoute absent).
export function createLeadRouteSync({ getRoute, getConfig, setRouteState, resolveRoute, clean }) {
  const sameModel = (a, b) => clean(a?.provider) === clean(b?.provider) && clean(a?.model) === clean(b?.model);

  // A Main route the runtime still has no model for takes the Lead route a
  // reload brings in (edited on disk or by another process), so a conditional
  // backfill sees it and never overwrites it. A live route that has a model is
  // the user's selection and stays.
  function syncEmptyMainRoute(config) {
    if (!setRouteState || !resolveRoute || clean(getRoute()?.model)) return;
    const resolved = resolveRoute(config, {});
    if (clean(resolved?.model)) setRouteState(resolved);
  }

  // After a reload that followed a conditional Lead fill of `filled`: adopt
  // the Lead route the file holds instead when it differs. A route the user
  // has moved off `filled` meanwhile stays. Answers whether the route was replaced.
  function adoptFillWinner(filled) {
    if (!setRouteState || !resolveRoute || !sameModel(getRoute(), filled)) return false;
    const winner = resolveRoute(getConfig(), {});
    if (!clean(winner?.model) || sameModel(winner, filled)) return false;
    setRouteState(winner);
    return true;
  }

  return { syncEmptyMainRoute, adoptFillWinner };
}
