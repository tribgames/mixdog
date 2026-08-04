// schedule.model wire format shared by the channels-worker scheduler and the
// engine-side run-now dispatch: either a config.presets id/name (legacy) or a
// direct "provider/model[@effort][+fast]" route string written by the desktop
// schedule editor. Slash-form values become {provider,model,effort?,fast?}
// route objects, which agent-dispatch consumes without a presets lookup.
export function parseScheduleModelRef(ref) {
  const raw = String(ref || '');
  const slash = raw.indexOf('/');
  if (slash <= 0) return raw;
  let rest = raw.slice(slash + 1);
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
    provider: raw.slice(0, slash),
    model: rest,
    ...(effort ? { effort } : {}),
    ...(fast ? { fast: true } : {}),
  };
}
