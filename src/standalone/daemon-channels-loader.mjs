// The daemon's seam onto the channels runtime. Three concerns, all about
// keeping that graph off the startup path: deferred import, deferred start, and
// tool dispatch that refreshes the active-instance owner context first.
//
// Inputs: `log` (daemon log sink), `onLoaded` (handed the imported module so
// the host can keep a handle for its own shutdown order), `setOwnerContext`
// (runtime-paths writer, injected so the daemon entry keeps owning when that
// module is evaluated). Output: { ensure, start, handleCall }.

// Accepted owner controls refresh active-instance context. The transport
// admits rebind only for the current manual owner.
const POINTER_TOOLS = new Set(['activate_channel_bridge', 'rebind_current_transcript']);

export function createChannelsRuntimeLoader({ log, onLoaded = () => {}, setOwnerContext }) {
  // The channels runtime is imported AFTER the daemon env is set so worker-main
  // skips runWorkerIpc; that import also triggers its boot side effects
  // (config/service). It is deferred past the ready handshake: a session view
  // attaching to this same process must not wait out the channels graph, and
  // every channels call awaits this promise anyway.
  let channelsReady = null;
  function ensure() {
    if (!channelsReady) {
      channelsReady = import('../runtime/channels/index.mjs').then((module) => {
        onLoaded(module);
        return module;
      });
    }
    return channelsReady;
  }

  // Channels bring automation with them (schedules, webhook listener + tunnel,
  // optional messaging service). A daemon spawned by a TUI starts them exactly
  // as before; a daemon spawned for session views stays dormant until a channels
  // client actually registers, so an app-only service runs no tunnels.
  let channelsStartPromise = null;
  function start(options = {}) {
    if (channelsStartPromise) return channelsStartPromise;
    const messaging = options.messaging === true;
    channelsStartPromise = ensure()
      .then((module) => module.start({ messaging }))
      .catch((e) => {
        channelsStartPromise = null;
        log(`channels.start failed (non-fatal): ${e?.message || e}`);
        throw e;
      });
    return channelsStartPromise;
  }

  async function handleCall(name, args, ctx) {
    const module = await ensure();
    if (ctx && POINTER_TOOLS.has(name)) {
      try {
        setOwnerContext({ leadPid: ctx.leadPid, cwd: ctx.cwd });
      } catch {}
    }
    return module.handleToolCallWithBridgeRetry(name, args || {});
  }

  return { ensure, start, handleCall };
}
