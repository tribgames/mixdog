// Worker/HTTP runtime-lifecycle dispatch (activate_channel_bridge /
// reload_config). Channel messaging — forwarder, transcript binding, typing —
// is deleted with Discord/Telegram; only the automation lifecycle remains.
// Lifecycle functions are threaded in as a bag of lazy getters so the module
// reads the live file-level references at call time.
function createToolDispatch({
  isChannelsDegraded,
  lifecycle,
}) {
  const {
    getChannelBridgeActive,
    getOwned,
    setChannelBridgeActive,
    writeBridgeState,
    notifyRemoteAcquired,
    refreshBridgeOwnership,
    startChannelBridge,
    stopOwnedRuntime,
    reloadRuntimeConfig,
  } = lifecycle;

  async function handleToolCall(name, args, _signal) {
    if (isChannelsDegraded()) {
      return { content: [{ type: 'text', text: `[channels degraded] ${name} unavailable — restart MCP to recover` }], isError: true }
    }
    let result;
    try {
      switch (name) {
        case "activate_channel_bridge": {
            const active = args.active === true;
            const wasActive = getChannelBridgeActive();
            setChannelBridgeActive(active);
            writeBridgeState(active);
            if (active) {
              // Daemon model: this runtime is the unconditional bridge owner
              // (getOwned() is always true), so activate never needs to claim a
              // seat or pre-notify — the not-connected -> connected transition
              // inside startOwnedRuntime fires notifyRemoteAcquired exactly once.
              if (getOwned?.() !== true) {
                notifyRemoteAcquired?.();
              }
              try {
                if (typeof startChannelBridge === 'function') {
                  await startChannelBridge();
                } else {
                  await refreshBridgeOwnership({ restoreBinding: true });
                }
              } catch (e) {
                process.stderr.write(`mixdog: bridge activate refresh failed (non-fatal): ${e?.message || e}\n`);
              }
            }
            if (!active && wasActive) {
              // Tear down the owner-side runtime so scheduler/webhook/
              // event-pipeline don't keep running on a deactivated bridge.
              try { await stopOwnedRuntime("bridge deactivated"); } catch (e) {
                process.stderr.write(`mixdog: stopOwnedRuntime on deactivate failed: ${e?.message || e}\n`);
              }
            }
            result = { content: [{ type: "text", text: `channel bridge ${active ? "activated" : "deactivated"}` }] };
            break;
          }
        case "reload_config": {
            await reloadRuntimeConfig();
            // Extend reload to the refactored agent runtime so providers/presets/
            // maintenance hot-reload on the same call.
            let agentReloadMsg = "";
            if (process.env.MIXDOG_STANDALONE !== '1') {
              try {
                const [{ loadConfig }, { initProviders, refreshCatalogs }] = await Promise.all([
                  import("../../agent/orchestrator/config.mjs"),
                  import("../../agent/orchestrator/providers/registry.mjs"),
                ]);
                const agentConfig = loadConfig();
                await initProviders(agentConfig.providers || {});
                await refreshCatalogs({ force: true });
                agentReloadMsg = ", agent providers/presets/maintenance";
              } catch (err) {
                process.stderr.write(`[reload_config] agent reload failed: ${err?.message || String(err)}\n`);
              }
            }
            result = { content: [{ type: "text", text: `config reloaded — schedules, webhooks, events${agentReloadMsg} re-registered` }] };
            break;
          }
        case "rebind_current_transcript": {
            // Transcript forwarding is retired with channel messaging: accept
            // and no-op so legacy lead-side pushes never surface an error.
            result = { content: [{ type: "text", text: "transcript rebind retired" }] };
            break;
        }
        // memory — handled by memory-service.mjs MCP
        default:
            result = {
              content: [{ type: "text", text: `unknown tool: ${name}` }],
              isError: true
            };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = {
        content: [{ type: "text", text: `${name} failed: ${msg}` }],
        isError: true
      };
    }
    return result;
  }

  // IPC/HTTP wrapper: with channel messaging retired there is no transcript
  // pre-flush or tool-log relay — plain dispatch.
  async function handleToolCallWithBridgeRetry(toolName, args, signal) {
    return handleToolCall(toolName, args, signal);
  }

  return { handleToolCall, handleToolCallWithBridgeRetry };
}

export { createToolDispatch };
