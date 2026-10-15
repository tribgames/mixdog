import { shortId, slowSpans } from '../runtime/shared/slow-span.mjs';

const sessionServiceRoutes = ({ desktop, project, session }) => ({
  'desktop.init': (params, ctx) => desktop.init(params, ctx),
  'desktop.invoke': (params, ctx) => desktop.invoke(params, ctx),
  'desktop.control': (params, ctx) => desktop.control(params, ctx),
  'desktop.ready': (params, ctx) => desktop.ready(params, ctx),
  'desktop.unsubscribe': (params, ctx) => desktop.unsubscribe(params, ctx),
  'project.list': project.list,
  'project.inspect': project.inspect,
  'project.add': project.add,
  'project.touch': project.touch,
  'project.rename': project.rename,
  'project.remove': project.remove,
  'project.ensureDirectory': project.ensureDirectory,
  'session.list': session.list,
  'session.create': session.create,
  'session.read': session.read,
  'session.subscribe': session.subscribe,
  'session.unsubscribe': session.unsubscribe,
  'session.submit': session.submit,
  'session.abort': session.abort,
  'session.approve': session.approve,
  'session.configure': session.configure,
});

export function createSessionServiceApi({
  desktop,
  project,
  session,
  methods,
  getSize,
  getBusyCount,
  getTurnBusyCount,
  getStatus,
  getExternalClientCount,
  spans = slowSpans,
}) {
  const routes = sessionServiceRoutes({ desktop, project, session });
  return {
    async handleCall(name, args = {}, ctx = null) {
      const route = routes[String(name || '')];
      if (!route) throw new Error(`unknown session service call ${name}`);
      const params = args || {};
      const sid = shortId(params.sessionId);
      return spans.trace(sid ? `${name}#${sid}` : String(name), () => route(params, ctx));
    },
    ...methods,
    get size() {
      return getSize();
    },
    get busyCount() {
      return getBusyCount();
    },
    /** Sessions with a running turn; background-task-only sessions excluded. */
    get turnBusyCount() {
      return getTurnBusyCount();
    },
    get status() {
      return getStatus();
    },
    get externalClientCount() {
      return getExternalClientCount();
    },
  };
}
