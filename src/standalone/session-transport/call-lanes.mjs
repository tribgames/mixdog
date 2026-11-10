/**
 * session-transport/call-lanes.mjs — the three fair-call schedulers a session
 * call can land in (critical / interactive / normal), lane classification by
 * call name, and the aggregate counters the health probe reports.
 *
 * A burst of panes used to enqueue every handleCall() as a microtask. Node
 * drains the whole microtask queue before returning to HTTP, so enough cheap
 * calls could starve /health and /client/register even though no explicit
 * mutex existed. Admit one call per event-loop turn while allowing admitted
 * async calls to overlap; control-plane routes never enter this queue.
 * No default concurrency gate: independent session work starts in parallel.
 * The scheduler still launches one item per check phase so synchronous setup
 * cannot monopolize the HTTP/control-plane turn. Operators may explicitly
 * set finite lane limits for constrained hosts.
 */
import { createFairCallScheduler } from '../fair-call-scheduler.mjs';
import { positiveInt } from '../../runtime/shared/numbers.mjs';

const CRITICAL_CALLS = new Set([
  'session.abort',
  'session.approve',
  'session.unsubscribe',
  'desktop.control',
  'desktop.ready',
  'desktop.unsubscribe',
]);
const INTERACTIVE_CALLS = new Set([
  'session.create',
  'session.read',
  'session.subscribe',
  'session.submit',
  'session.configure',
  'project.list',
  'project.inspect',
  'project.add',
  'project.touch',
  'project.rename',
  'project.remove',
  'project.ensureDirectory',
  'desktop.init',
]);
const INTERACTIVE_DESKTOP_METHODS = new Set(['termEnsure', 'termWrite', 'termResize', 'termDispose', 'termProfiles']);

const configuredLaneLimit = (name) => positiveInt(process.env[name], Infinity);

export function callLane(name, args = {}) {
  if (CRITICAL_CALLS.has(name)) return 'critical';
  if (INTERACTIVE_CALLS.has(name)) return 'interactive';
  if (name === 'desktop.invoke') {
    const adapterMethod = String(args?.method || '');
    const desktopMethod = adapterMethod === 'invokeDesktopOperation' ? String(args?.args?.[0] || '') : adapterMethod;
    if (INTERACTIVE_DESKTOP_METHODS.has(desktopMethod)) return 'interactive';
  }
  return 'normal';
}

export function createCallLanes() {
  const CALL_QUEUE_MAX = Math.max(1024, Number(process.env.MIXDOG_SESSION_CALL_QUEUE) || 1024);
  const normal = createFairCallScheduler({
    name: 'session service call',
    activeMax: configuredLaneLimit('MIXDOG_SESSION_ACTIVE_CALLS'),
    queueMax: CALL_QUEUE_MAX,
    minOwnerQueue: Math.max(8, Math.floor(CALL_QUEUE_MAX / 16)),
    dispatchBurst: 1,
    yieldUnbounded: true,
  });
  const critical = createFairCallScheduler({
    name: 'session service critical call',
    activeMax: configuredLaneLimit('MIXDOG_SESSION_URGENT_RESERVE'),
    queueMax: Math.max(32, Math.min(256, CALL_QUEUE_MAX)),
    minOwnerQueue: 8,
  });
  const interactive = createFairCallScheduler({
    name: 'session service interactive call',
    activeMax: configuredLaneLimit('MIXDOG_SESSION_INTERACTIVE_RESERVE'),
    queueMax: Math.max(64, Math.min(512, CALL_QUEUE_MAX)),
    minOwnerQueue: 8,
    dispatchBurst: 1,
    yieldUnbounded: true,
  });
  const lanes = { normal, critical, interactive };

  return {
    dispatch(ownerKey, run, { lane = 'normal', signal = null } = {}) {
      return (lanes[lane] || normal).enqueue(ownerKey, run, { signal });
    },
    get active() {
      return normal.active + interactive.active + critical.active;
    },
    get queued() {
      return normal.queued + interactive.queued + critical.queued;
    },
    get queuedUrgent() {
      return critical.queued;
    },
    get queuedInteractive() {
      return interactive.queued;
    },
    get owners() {
      return normal.snapshot().owners;
    },
    snapshot() {
      return { critical: critical.snapshot(), interactive: interactive.snapshot(), normal: normal.snapshot() };
    },
    close(reason) {
      normal.close(reason);
      interactive.close(reason);
      critical.close(reason);
    },
  };
}
