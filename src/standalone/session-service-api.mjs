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
  getStatus,
  getExternalClientCount,
}) {
  const routes = sessionServiceRoutes({ desktop, project, session });
  return {
    async handleCall(name, args = {}, ctx = null) {
      const route = routes[String(name || '')];
      if (!route) throw new Error(`unknown session service call ${name}`);
      return route(args || {}, ctx);
    },
    ...methods,
    get size() {
      return getSize();
    },
    get busyCount() {
      return getBusyCount();
    },
    get status() {
      return getStatus();
    },
    get externalClientCount() {
      return getExternalClientCount();
    },
  };
}
