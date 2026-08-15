// schedule.model wire format shared by the channels-worker scheduler and the
// engine-side run-now dispatch: either a config.presets id/name (legacy) or a
// direct "provider/model[@effort][+fast][?parameter=value]" route string written
// by the desktop schedule editor. Slash-form values become a direct route
// route objects, which agent-dispatch consumes without a presets lookup.
export function parseScheduleModelRef(ref) {
  const raw = String(ref || '');
  const queryAt = raw.indexOf('?');
  const routeRef = queryAt >= 0 ? raw.slice(0, queryAt) : raw;
  const query = queryAt >= 0 ? raw.slice(queryAt + 1) : '';
  const slash = routeRef.indexOf('/');
  if (slash <= 0) return raw;
  let rest = routeRef.slice(slash + 1);
  let fast = false;
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
    ...(query ? { modelParameters: Object.fromEntries(new URLSearchParams(query)) } : {}),
  };
}
