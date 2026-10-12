// schedule.model wire format shared by the channels-worker scheduler and the
// engine-side run-now dispatch: either a config.presets id/name (legacy) or a
// direct "provider/model[@effort][+fast][+noauto][?parameter=value]" route string
// written by the desktop schedule editor (`+noauto`: Auto effort off for the
// route; absent means on). Slash-form values become direct route
// objects, which agent-dispatch consumes without a presets lookup.
// The optional route fields an automation run carries, from a preset, a
// maintenance slot or a parsed route ref. One shape so schedule and webhook
// runs cannot drift when a field is added. modelParameters is copied so a
// stored preset can never be mutated through the run.
export function modelRouteFields(slot = {}) {
  return {
    provider: slot.provider,
    model: slot.model,
    ...(slot.effort ? { effort: slot.effort } : {}),
    ...(slot.fast === true ? { fast: true } : {}),
    ...(slot.autoEffort === false ? { autoEffort: false } : {}),
    ...(slot.modelParameters ? { modelParameters: { ...slot.modelParameters } } : {}),
  };
}

/** The inverse of parseScheduleModelRef for a direct route object. */
export function formatScheduleModelRef(route) {
  const parameters = Object.entries(route?.modelParameters || {}).filter(([key, value]) => key && value);
  return (
    `${route.provider}/${route.model}` +
    (route.effort ? `@${route.effort}` : '') +
    (route.fast === true ? '+fast' : '') +
    (route.autoEffort === false ? '+noauto' : '') +
    (parameters.length ? `?${new URLSearchParams(parameters).toString()}` : '')
  );
}

export function parseScheduleModelRef(ref) {
  const raw = String(ref || '');
  const queryAt = raw.indexOf('?');
  const routeRef = queryAt >= 0 ? raw.slice(0, queryAt) : raw;
  const query = queryAt >= 0 ? raw.slice(queryAt + 1) : '';
  const slash = routeRef.indexOf('/');
  if (slash <= 0) return raw;
  let rest = routeRef.slice(slash + 1);
  let fast = false;
  let autoEffort = true;
  if (rest.endsWith('+noauto')) {
    autoEffort = false;
    rest = rest.slice(0, -7);
  }
  if (rest.endsWith('+fast')) {
    fast = true;
    rest = rest.slice(0, -5);
  }
  let effort = '';
  const at = rest.lastIndexOf('@');
  if (at > 0) {
    effort = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  return {
    provider: routeRef.slice(0, slash),
    model: rest,
    ...(effort ? { effort } : {}),
    ...(fast ? { fast: true } : {}),
    ...(autoEffort ? {} : { autoEffort: false }),
    ...(query ? { modelParameters: Object.fromEntries(new URLSearchParams(query)) } : {}),
  };
}
